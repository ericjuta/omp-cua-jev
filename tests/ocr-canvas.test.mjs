import assert from 'node:assert/strict';
import test from 'node:test';
import { access, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';
import { runOcrCanvasEval } from '../src/evals/ocr-canvas.mjs';

// The fixture page at device scale 1: discs 80 px apart on y = 116, labels 35 px below each centre.
const DISCS = [58, 138, 218, 298, 378, 458].map((x, index) => ({ x, y: 116, rgb: index % 2 === 0 ? [0, 85, 255] : [140, 140, 140] }));
const label = (text, index, extra = {}) => ({
  id: `text-${text}-${index}`, kind: 'text', text, confidence: 0.9, interactive: false,
  bounds: { x: DISCS[index].x - 9, y: 144, width: 18, height: 14 }, ...extra,
});

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function chunk(type, data) {
  const bytes = Buffer.alloc(12 + data.length);
  bytes.writeUInt32BE(data.length, 0);
  bytes.write(type, 4, 'latin1');
  data.copy(bytes, 8);
  let crc = 0xffffffff;
  for (const byte of bytes.subarray(4, 8 + data.length)) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  bytes.writeUInt32BE((crc ^ 0xffffffff) >>> 0, 8 + data.length);
  return bytes;
}

function seatMap(width = 960, height = 540, radius = 19) {
  const stride = width * 3 + 1;
  const rows = Buffer.alloc(stride * height, 255);
  for (let y = 0; y < height; y++) rows[y * stride] = 0;
  for (const { x: cx, y: cy, rgb } of DISCS) {
    for (let y = cy - radius; y < cy + radius; y++) {
      for (let x = cx - radius; x < cx + radius; x++) {
        if ((x + 0.5 - cx) ** 2 + (y + 0.5 - cy) ** 2 <= radius ** 2) rows.set(rgb, y * stride + 1 + x * 3);
      }
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header),
    chunk('IDAT', deflateSync(rows)), chunk('IEND', Buffer.alloc(0))]);
}

async function binaries(t, { mode = 'ok', regions = [] } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'omp-cua-jev-ocr-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const png = join(directory, 'seat-map.png');
  await writeFile(png, seatMap());
  const chrome = join(directory, 'chrome.mjs');
  // Like Chrome 154 headless: write the screenshot, then keep running until terminated.
  await writeFile(chrome, `#!${process.execPath}
import { copyFileSync } from 'node:fs';
const screenshot = process.argv.find(arg => arg.startsWith('--screenshot=')).slice('--screenshot='.length);
copyFileSync(${JSON.stringify(png)}, screenshot);
setInterval(() => {}, 1000);
`, { mode: 0o700 });
  const binary = join(directory, 'driver.mjs');
  await writeFile(binary, `#!${process.execPath}
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
const args = process.argv.slice(2);
const value = flag => args[args.indexOf(flag) + 1];
if (args[0] !== 'perception' || args[1] !== 'parse' || !args.includes('--json')) process.exit(64);
if (${JSON.stringify(mode)} === 'not_installed') {
  process.stdout.write(JSON.stringify({ ok: false, error: { code: 'not_installed', message: 'missing', retryable: false } }));
  process.exit(1);
}
const image = readFileSync(value('--image'));
const sha256 = ${JSON.stringify(mode)} === 'other_image' ? 'f'.repeat(64) : createHash('sha256').update(image).digest('hex');
const { source } = JSON.parse(readFileSync(value('--capture'), 'utf8'));
process.stdout.write(JSON.stringify({
  schema: 'cua.visual_regions_v1',
  capture: {
    capture_id: 'local_png_' + sha256.slice(0, 24), source, action_coordinate_space: { kind: 'screenshot_pixels' },
    screenshot: { width: image.readUInt32BE(16), height: image.readUInt32BE(20), mime_type: 'image/png',
      reference: 'local-png-sha256:' + sha256, sha256 },
  },
  parser: { extension_id: 'cua-perception', extension_version: '0.2.1', model_id: 'fake', model_version: '1' },
  regions: ${JSON.stringify(regions)},
  timing: { duration_ms: 12 },
  local_input: { kind: 'local_file', sha256, action_eligible: false, action_authority: 'none' },
}));
`, { mode: 0o700 });
  return { chrome, binary };
}

const evaluate = options => runOcrCanvasEval({ variants: ['dpr1'], ...options });

function assertCleanedUp(result) {
  assert.equal(result.cleanup.fixtureClosed, true);
  assert.equal(result.cleanup.fixtureClicks, 0);
  assert.equal(result.cleanup.tempRemoved, true);
  assert.deepEqual(result.cleanup.chrome.map(({ terminated, lingeringRemaining }) => ({ terminated, lingeringRemaining })),
    [{ terminated: true, lingeringRemaining: 0 }]);
}

test('scoring separates found, positioned, misplaced, stray and associated seat labels', async t => {
  const result = await evaluate(await binaries(t, { regions: [
    label('A1', 0), label('A2', 1), label('A4', 2), label('A5', 4),
    { ...label('A6', 5), bounds: { x: 600, y: 300, width: 18, height: 14 } },
    { id: 'status', kind: 'text', text: 'Selected: none', confidence: 0.8, interactive: false,
      bounds: { x: 8, y: 210, width: 110, height: 18 } },
    { id: 'icon', kind: 'icon', label: 'icon-class-0', confidence: 0.5, interactive: false,
      bounds: { x: 40, y: 98, width: 36, height: 36 } },
  ] }));
  assert.equal(result.status, 'ok');
  const [variant] = result.variants;
  assert.equal(variant.scale, 1);
  assert.equal(variant.labelRecall, 0.833);
  assert.equal(variant.positionedRecall, 0.5);
  assert.equal(variant.wrongLabels, 1);
  assert.equal(variant.strayLabels, 1);
  assert.equal(variant.associationAccuracy, 0.5);
  assert.deepEqual(variant.labels, { A1: 'A1', A2: 'A2', A3: 'A4', A4: null, A5: 'A5', A6: null });
  assert.deepEqual(variant.misreads, [{ seat: 'A3', text: 'A4' }]);
  assert.equal(variant.selectedNone.unique, true);
  assert.equal(variant.clearSelection.found, false);
  assert.deepEqual(variant.regions, { total: 7, text: 6, icon: 1 });
  assert.deepEqual(result.summary.byVariant.dpr1.missedSeats, ['A3']);
  assertCleanedUp(result);
});

test('a parse of a different image is not scored', async t => {
  const result = await evaluate(await binaries(t, { mode: 'other_image', regions: [label('A1', 0)] }));
  assert.equal(result.status, 'failed');
  assert.equal(result.code, 'IMAGE_MISMATCH');
  assert.equal(Object.hasOwn(result.variants[0], 'labelRecall'), false);
  assertCleanedUp(result);
});

test('missing prerequisites block without installing or leaving owned resources', async t => {
  const fakes = await binaries(t, { mode: 'not_installed' });
  const notInstalled = await evaluate(fakes);
  assert.equal(notInstalled.status, 'blocked');
  assert.equal(notInstalled.code, 'not_installed');
  assert.deepEqual(notInstalled.variants, []);
  assertCleanedUp(notInstalled);

  const noChrome = await evaluate({ ...fakes, chrome: join(tmpdir(), 'omp-cua-jev-missing-chrome', 'chrome') });
  assert.equal(noChrome.status, 'blocked');
  assert.equal(noChrome.code, 'CHROME_UNAVAILABLE');
  assert.equal(noChrome.cleanup.fixtureClosed, null);
  assert.equal(noChrome.cleanup.tempRemoved, null);
  await assert.rejects(access(join(tmpdir(), 'omp-cua-jev-missing-chrome')), { code: 'ENOENT' });
});
