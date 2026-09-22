import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';

/** One loopback-only synthetic receipt, owned by this demo invocation. */
export async function createFixture() {
  const nonce = randomUUID();
  const token = `jev-${randomUUID()}`;
  const base = `/${nonce}/`;
  const receipt = { token: null, count: 0, attempts: 0 };
  let origin;
  let host;
  const html = `<!doctype html>
<html lang="en"><meta charset="utf-8"><title>omp-jev native demo</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>body{font:18px system-ui;max-width:42rem;margin:4rem auto;padding:1rem}label,input,button,output{display:block;margin:1rem 0}input{width:100%;font:inherit}button{font:inherit;padding:.6rem}code{overflow-wrap:anywhere}</style>
<h1>omp-jev native demo</h1>
<p>Save this synthetic receipt exactly once: <code>${token}</code></p>
<form id="form"><label for="receipt">Receipt code</label>
<input id="receipt" name="receipt" autocomplete="off" required>
<button id="save" type="submit">Save receipt</button></form>
<output id="result" role="status" aria-live="polite">Not saved</output>
<script nonce="${nonce}">
const form = document.querySelector('#form');
const save = document.querySelector('#save');
const result = document.querySelector('#result');
form.addEventListener('submit', async event => {
  event.preventDefault();
  save.disabled = true;
  try {
    const response = await fetch('${base}receipt', {
      method: 'POST', headers: {'content-type': 'application/json'},
      body: JSON.stringify({token: document.querySelector('#receipt').value})
    });
    if (!response.ok) throw new Error('Save rejected');
    result.textContent = 'Receipt saved';
  } catch {
    result.textContent = 'Save not confirmed. Inspect server state before retrying.';
  }
});
</script></html>`;

  const server = createServer(async (request, response) => {
    const send = (status, content, type = 'application/json') => {
      response.writeHead(status, {
        'content-type': `${type}; charset=utf-8`,
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
        'content-security-policy': `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'`,
      });
      response.end(type === 'application/json' ? JSON.stringify(content) : content);
    };
    if (request.headers.host !== host) return send(403, { error: 'Wrong host' });
    if (request.method === 'GET' && request.url === base) return send(200, html, 'text/html');
    if (request.method === 'GET' && request.url === `${base}receipt`) return send(200, receipt);
    if (request.method !== 'POST' || request.url !== `${base}receipt`) return send(404, { error: 'Not found' });
    if (request.headers.origin !== origin || request.headers['content-type'] !== 'application/json') {
      return send(403, { error: 'Wrong origin or content type' });
    }
    receipt.attempts++;
    try {
      let body = '';
      for await (const chunk of request) {
        body += chunk;
        if (Buffer.byteLength(body) > 1024) return send(413, { error: 'Body too large' });
      }
      const payload = JSON.parse(body);
      if (payload?.token !== token || Object.keys(payload).length !== 1) return send(400, { error: 'Wrong token' });
      if (receipt.count !== 0) return send(409, { error: 'Already saved' });
      receipt.token = token;
      receipt.count = 1;
      return send(201, receipt);
    } catch {
      return send(400, { error: 'Invalid request' });
    }
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject);
      host = `127.0.0.1:${server.address().port}`;
      origin = `http://${host}`;
      resolve();
    });
  });
  return Object.freeze({
    url: `${origin}${base}`,
    receiptURL: `${origin}${base}receipt`,
    token,
    close: () => new Promise((resolve, reject) => {
      server.close(error => error ? reject(error) : resolve());
      server.closeAllConnections();
    }),
  });
}
