import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import test from 'node:test';
import { createCanvasFixture } from '../src/canvas-fixture.mjs';

function send(url, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = httpRequest(url, { method, headers }, response => {
      let text = '';
      response.setEncoding('utf8');
      response.on('data', chunk => { text += chunk; });
      response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, text }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

async function open(t) {
  const fixture = await createCanvasFixture();
  t.after(() => fixture.close());
  const { origin, host } = new URL(fixture.url);
  const post = (path, body, headers = {}) => send(new URL(path, fixture.url), {
    method: 'POST',
    headers: { host, origin, 'content-type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
  return { fixture, origin, host, post };
}

test('page is served on a loopback nonce path with the fixed seat row', async t => {
  const { fixture } = await open(t);
  const url = new URL(fixture.url);
  assert.equal(url.hostname, '127.0.0.1');
  assert.match(url.pathname, /^\/[0-9a-f-]{36}\/$/);
  assert.deepEqual(fixture.availableSeats, ['A1', 'A3', 'A5']);
  assert.deepEqual(fixture.seats.map(({ seat, x, y, available }) => [seat, x, y, available]), [
    ['A1', 50, 60, true], ['A2', 130, 60, false], ['A3', 210, 60, true],
    ['A4', 290, 60, false], ['A5', 370, 60, true], ['A6', 450, 60, false],
  ]);
  assert.deepEqual(fixture.state(), { clicks: [], selected: null });

  const page = await send(fixture.url);
  assert.equal(page.status, 200);
  assert.match(page.headers['content-type'], /^text\/html/);
  const nonce = url.pathname.slice(1, -1);
  assert.match(page.headers['content-security-policy'], new RegExp(`script-src 'nonce-${nonce}'`));
  assert.match(page.text, /<output id="status" role="status"[^>]*>Selected: none<\/output>/);
  assert.match(page.text, /<button id="clear" type="button">Clear selection<\/button>/);
  assert.match(page.text, /aria-label="Seat map"/);
  assert.match(page.text, /rgb\(0,85,255\)/);
});

test('host, nonce and origin are enforced without recording anything', async t => {
  const { fixture, origin, host, post } = await open(t);
  const url = new URL(fixture.url);

  assert.equal((await send(fixture.url, { headers: { host: 'localhost' } })).status, 403);
  assert.equal((await send(fixture.url, { headers: { host: `evil.test:${url.port}` } })).status, 403);
  assert.equal((await send(new URL('/00000000-0000-4000-8000-000000000000/', url))).status, 404);
  assert.equal((await send(new URL('/', url))).status, 404);
  assert.equal((await send(new URL('selection', fixture.url))).status, 404);

  const valid = { seat: 'A1', trusted: true };
  assert.equal((await post('selection', valid, { host: 'localhost' })).status, 403);
  assert.equal((await post('selection', valid, { origin: 'http://evil.test' })).status, 403);
  assert.equal((await post('selection', valid, { origin: `http://localhost:${url.port}` })).status, 403);
  assert.equal((await send(new URL('selection', fixture.url), {
    method: 'POST', headers: { host, 'content-type': 'application/json' }, body: JSON.stringify(valid),
  })).status, 403);
  assert.equal((await post('selection', valid, { 'content-type': 'text/plain' })).status, 403);
  assert.equal((await post('/00000000-0000-4000-8000-000000000000/selection', valid)).status, 404);
  assert.equal((await post('clear', {}, { origin: 'null' })).status, 403);
  assert.equal(origin, `http://127.0.0.1:${url.port}`);
  assert.deepEqual(fixture.state(), { clicks: [], selected: null });
});

test('GET with an unfinished request body is answered without waiting for the body', async t => {
  const { fixture } = await open(t);
  const result = await new Promise((resolve, reject) => {
    const req = httpRequest(fixture.url, { method: 'GET', headers: { 'content-length': '1000' } }, response => {
      response.resume();
      resolve(response.statusCode);
      req.destroy();
    });
    req.on('error', error => { if (error.code !== 'ECONNRESET') reject(error); });
    req.write('x'.repeat(10));
    setTimeout(() => reject(new Error('GET waited for its request body')), 1000).unref();
  });
  assert.equal(result, 200);
});

test('seat selections are logged in order and clear resets only the selection', async t => {
  const { fixture, post } = await open(t);

  const first = await post('selection', { seat: 'A3', trusted: true });
  assert.equal(first.status, 201);
  assert.deepEqual(JSON.parse(first.text), { clicks: [{ seat: 'A3', trusted: true }], selected: 'A3' });

  const second = await post('selection', { seat: 'A1', trusted: false });
  assert.equal(second.status, 201);
  const logged = { clicks: [{ seat: 'A3', trusted: true }, { seat: 'A1', trusted: false }], selected: 'A1' };
  assert.deepEqual(JSON.parse(second.text), logged);
  assert.deepEqual(fixture.state(), logged);

  const leaked = fixture.state();
  leaked.clicks.push({ seat: 'A5', trusted: true });
  leaked.clicks[0].trusted = false;
  leaked.selected = 'A5';
  assert.deepEqual(fixture.state(), logged);

  const cleared = await post('clear', {});
  assert.equal(cleared.status, 200);
  const afterClear = { clicks: [{ seat: 'A3', trusted: true }, { seat: 'A1', trusted: false }], selected: null };
  assert.deepEqual(JSON.parse(cleared.text), afterClear);
  assert.deepEqual(fixture.state(), afterClear);

  assert.equal((await post('selection', { seat: 'A5', trusted: true })).status, 201);
  assert.deepEqual(fixture.state(), {
    clicks: [{ seat: 'A3', trusted: true }, { seat: 'A1', trusted: false }, { seat: 'A5', trusted: true }],
    selected: 'A5',
  });
});

test('malformed, unavailable and oversized posts are rejected without state change', async t => {
  const { fixture, post } = await open(t);
  assert.equal((await post('selection', { seat: 'A5', trusted: true })).status, 201);
  const before = { clicks: [{ seat: 'A5', trusted: true }], selected: 'A5' };

  const selections = [
    '', '{', 'null', '[]', '"A1"', '[{"seat":"A1","trusted":true}]',
    { seat: 'A2', trusted: true }, { seat: 'A4', trusted: true }, { seat: 'A6', trusted: true },
    { seat: 'A7', trusted: true }, { seat: 'a1', trusted: true }, { seat: ' A1', trusted: true },
    { seat: 1, trusted: true }, { seat: ['A1'], trusted: true },
    { seat: 'A1' }, { trusted: true }, { seat: 'A1', trusted: 'true' }, { seat: 'A1', trusted: 1 },
    { seat: 'A1', trusted: null }, { seat: 'A1', trusted: true, extra: 1 },
    '{"seat":"A1","trusted":true,"__proto__":{"x":1}}',
  ];
  for (const body of selections) {
    const response = await post('selection', body);
    assert.equal(response.status, 400, `selection ${JSON.stringify(body)}`);
  }
  for (const body of ['', 'null', '[]', '{"seat":"A1"}', '{"selected":null}']) {
    assert.equal((await post('clear', body)).status, 400, `clear ${body}`);
  }
  const oversized = await post('selection', JSON.stringify({ seat: 'A1', trusted: true, pad: 'x'.repeat(2048) }));
  assert.equal(oversized.status, 413);
  assert.deepEqual(fixture.state(), before);
});
