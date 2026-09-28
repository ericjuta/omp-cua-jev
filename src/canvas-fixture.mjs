import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';

const MAX_BODY_BYTES = 1024;
const CANVAS = Object.freeze({ width: 520, height: 140 });
const SEAT_RADIUS = 19;
const AVAILABLE_COLOR = 'rgb(0,85,255)';
const UNAVAILABLE_COLOR = 'rgb(140,140,140)';
const AVAILABLE = new Set(['A1', 'A3', 'A5']);
// Horizontal row, left to right; centres are 80 CSS px apart.
const SEATS = Object.freeze(['A1', 'A2', 'A3', 'A4', 'A5', 'A6'].map((seat, index) => Object.freeze({
  seat, x: 50 + 80 * index, y: 60, radius: SEAT_RADIUS, available: AVAILABLE.has(seat),
})));
const AVAILABLE_SEATS = Object.freeze(SEATS.filter(seat => seat.available).map(seat => seat.seat));

// Only applied to JSON.parse output, which never carries another prototype.
const plainRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const exactKeys = (value, keys) => plainRecord(value) && Object.keys(value).length === keys.length
  && keys.every(key => Object.hasOwn(value, key));

/** Loopback-only synthetic canvas seat map, owned by one canvas demo invocation. */
export async function createCanvasFixture() {
  const nonce = randomUUID();
  const base = `/${nonce}/`;
  const clicks = [];
  let selected = null;
  let origin;
  let host;
  const snapshot = () => ({ clicks: clicks.map(({ seat, trusted }) => ({ seat, trusted })), selected });
  const html = `<!doctype html>
<html lang="en"><meta charset="utf-8"><title>omp-cua-jev canvas demo</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>*{box-sizing:border-box}body{font:16px/1.2 system-ui;margin:0;padding:.5rem;background:#fff;color:#111}h1{font-size:1.1rem;margin:0 0 .25rem}p{margin:0 0 .25rem}canvas{display:block;width:${CANVAS.width}px;height:${CANVAS.height}px;margin:0 0 .25rem}output{display:block;margin:0 0 .25rem}button{font:inherit;padding:.25rem .375rem}</style>
<h1>omp-cua-jev canvas demo</h1>
<p>Blue seats are available; grey seats are taken.</p>
<canvas id="seats" role="img" aria-label="Seat map" width="${CANVAS.width}" height="${CANVAS.height}"></canvas>
<output id="status" role="status" aria-live="polite">Selected: none</output>
<button id="clear" type="button">Clear selection</button>
<script nonce="${nonce}">
const seats = ${JSON.stringify(SEATS)};
const canvas = document.querySelector('#seats');
const status = document.querySelector('#status');
const clear = document.querySelector('#clear');
const scale = window.devicePixelRatio || 1;
canvas.width = Math.round(${CANVAS.width} * scale);
canvas.height = Math.round(${CANVAS.height} * scale);
const context = canvas.getContext('2d');
context.scale(scale, scale);
context.fillStyle = 'rgb(255,255,255)';
context.fillRect(0, 0, ${CANVAS.width}, ${CANVAS.height});
context.font = '14px system-ui';
context.textAlign = 'center';
context.textBaseline = 'middle';
for (const seat of seats) {
  context.fillStyle = seat.available ? '${AVAILABLE_COLOR}' : '${UNAVAILABLE_COLOR}';
  context.beginPath();
  context.arc(seat.x, seat.y, seat.radius, 0, Math.PI * 2);
  context.fill();
  context.fillStyle = 'rgb(17,17,17)';
  context.fillText(seat.seat, seat.x, seat.y + seat.radius + 16);
}
const show = state => {
  status.textContent = state.selected === null ? 'Selected: none' : 'Selected: ' + state.selected;
};
const post = async (path, body) => {
  const response = await fetch('${base}' + path, {
    method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify(body)
  });
  if (!response.ok) throw new Error('Rejected');
  show(await response.json());
};
canvas.addEventListener('click', event => {
  const rect = canvas.getBoundingClientRect();
  const x = (event.clientX - rect.left) * ${CANVAS.width} / rect.width;
  const y = (event.clientY - rect.top) * ${CANVAS.height} / rect.height;
  const seat = seats.find(seat => Math.hypot(x - seat.x, y - seat.y) <= seat.radius);
  if (!seat || !seat.available) return;
  post('selection', {seat: seat.seat, trusted: event.isTrusted}).catch(() => {});
});
clear.addEventListener('click', () => { post('clear', {}).catch(() => {}); });
</script></html>`;

  const server = createServer((request, response) => {
    const send = (status, content, type = 'application/json', extra = {}) => {
      response.writeHead(status, {
        'content-type': `${type}; charset=utf-8`,
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
        'content-security-policy': `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'`,
        ...extra,
      });
      response.end(type === 'application/json' ? JSON.stringify(content) : content);
    };
    if (request.headers.host !== host) return send(403, { error: 'Wrong host' });
    // GET never waits for a request body.
    if (request.method === 'GET' && request.url === base) return send(200, html, 'text/html');
    const route = request.method === 'POST' && (request.url === `${base}selection` ? 'selection'
      : request.url === `${base}clear` ? 'clear' : null);
    if (!route) return send(404, { error: 'Not found' });
    if (request.headers.origin !== origin || request.headers['content-type'] !== 'application/json') {
      return send(403, { error: 'Wrong origin or content type' });
    }
    const tooLarge = () => {
      response.on('finish', () => request.destroy());
      send(413, { error: 'Body too large' }, 'application/json', { connection: 'close' });
    };
    if (Number(request.headers['content-length']) > MAX_BODY_BYTES) return tooLarge();
    const chunks = [];
    let size = 0;
    let done = false;
    request.on('data', chunk => {
      if (done) return;
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        done = true;
        return tooLarge();
      }
      chunks.push(chunk);
    });
    request.on('error', () => { done = true; });
    request.on('end', () => {
      if (done) return;
      done = true;
      let payload;
      try {
        payload = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch {
        return send(400, { error: 'Invalid JSON' });
      }
      if (route === 'clear') {
        if (!exactKeys(payload, [])) return send(400, { error: 'Invalid clear request' });
        selected = null;
        return send(200, snapshot());
      }
      if (!exactKeys(payload, ['seat', 'trusted']) || typeof payload.trusted !== 'boolean'
        || typeof payload.seat !== 'string' || !AVAILABLE.has(payload.seat)) {
        return send(400, { error: 'Invalid seat' });
      }
      clicks.push({ seat: payload.seat, trusted: payload.trusted });
      selected = payload.seat;
      return send(201, snapshot());
    });
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
    availableSeats: AVAILABLE_SEATS,
    seats: SEATS,
    canvas: CANVAS,
    state: snapshot,
    close: () => new Promise((resolve, reject) => {
      server.close(error => error ? reject(error) : resolve());
      server.closeAllConnections();
    }),
  });
}
