import assert from 'node:assert/strict';
import test from 'node:test';
import { deflateSync } from 'node:zlib';
import { isDeepStrictEqual } from 'node:util';
import { decodePng, findRegions } from '../src/pixels.mjs';

const pngSignature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data, badCrc = false) {
  const name = Buffer.from(type, 'ascii');
  const header = Buffer.alloc(4);
  header.writeUInt32BE(data.length);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE((crc32(Buffer.concat([name, data])) ^ Number(badCrc)) >>> 0);
  return Buffer.concat([header, name, data, checksum]);
}

function png({ width, height, colorType = 2, bitDepth = 8, interlace = 0, filteredRows, palette, badIdatCrc = false }) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = bitDepth;
  ihdr[9] = colorType;
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter method
  ihdr[12] = interlace;
  const compressed = deflateSync(Buffer.from(filteredRows.flat()));
  const middle = Math.floor(compressed.length / 2);
  return Buffer.concat([
    pngSignature,
    chunk('IHDR', ihdr),
    ...(palette === undefined ? [] : [chunk('PLTE', Buffer.from(palette))]),
    chunk('IDAT', compressed.subarray(0, middle), badIdatCrc),
    chunk('IDAT', compressed.subarray(middle)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const rgbFilteredRows = [
  [0, 10, 20, 30, 40, 50, 60],
  [1, 1, 2, 3, 4, 5, 6],
  [2, 7, 8, 9, 10, 11, 12],
  [3, 1, 3, 5, 7, 9, 11],
  [4, 28, 4, 245, 8, 10, 12],
];

const rgbaFilteredRows = [
  [0, 9, 19, 29, 39, 49, 59, 69, 79],
  [1, 2, 4, 6, 8, 1, 3, 5, 7],
  [2, 10, 11, 12, 13, 14, 15, 16, 17],
  [3, 1, 2, 3, 4, 5, 6, 7, 8],
  [4, 3, 5, 7, 9, 11, 13, 15, 17],
];

test('decodePng reconstructs RGB scanlines with all filters across split IDAT chunks', () => {
  const image = decodePng(png({ width: 2, height: 5, filteredRows: rgbFilteredRows }));
  assert.equal(image.width, 2);
  assert.equal(image.height, 5);
  assert.equal(image.channels, 3);
  assert.deepEqual(image.data, new Uint8Array([
    10, 20, 30, 40, 50, 60,
    1, 2, 3, 5, 7, 9,
    8, 10, 12, 15, 18, 21,
    5, 8, 11, 17, 22, 27,
    33, 12, 0, 41, 32, 23,
  ]));
});

test('decodePng reconstructs RGBA scanlines with all filters across split IDAT chunks', () => {
  const image = decodePng(png({ width: 2, height: 5, colorType: 6, filteredRows: rgbaFilteredRows }));
  assert.equal(image.width, 2);
  assert.equal(image.height, 5);
  assert.equal(image.channels, 4);
  assert.deepEqual(image.data, new Uint8Array([
    9, 19, 29, 39, 49, 59, 69, 79,
    2, 4, 6, 8, 3, 7, 11, 15,
    12, 15, 18, 21, 17, 22, 27, 32,
    7, 9, 12, 14, 17, 21, 26, 31,
    10, 14, 19, 23, 28, 34, 41, 48,
  ]));
});

test('decodePng rejects bad CRC, unsupported formats and complete but short image data', () => {
  const invalid = [
    ['wrong IDAT CRC', png({ width: 2, height: 5, filteredRows: rgbFilteredRows, badIdatCrc: true })],
    ['16-bit RGB', png({ width: 1, height: 1, bitDepth: 16, filteredRows: [[0, 0, 10, 0, 20, 0, 30]] })],
    ['indexed colour with PLTE', png({ width: 1, height: 1, colorType: 3, palette: [10, 20, 30], filteredRows: [[0, 0]] })],
    ['Adam7 interlace', png({ width: 1, height: 1, interlace: 1, filteredRows: [[0, 10, 20, 30]] })],
    ['fewer scanlines than IHDR', png({ width: 2, height: 2, filteredRows: [[0, 10, 20, 30, 40, 50, 60]] })],
  ];
  for (const [description, bytes] of invalid) {
    assert.throws(() => decodePng(bytes), { code: 'PIXELS_ERROR' }, description);
  }
});

const foreground = [20, 40, 60, 255];
const matchForeground = (r, g, b, a) => r === 20 && g === 40 && b === 60 && a === 255;

function rgbaImage(width, height, pixels) {
  const data = new Uint8Array(width * height * 4);
  for (const [x, y] of pixels) data.set(foreground, (y * width + x) * 4);
  return { width, height, channels: 4, data };
}

const blobA = [[6, 0], [6, 1], [5, 1], [5, 2], [4, 2], [3, 2], [2, 2], [1, 2]];
const blobB = [[2, 0], [3, 0], [4, 0]];
// B is scanned before A, yet A's box starts left of B; the ring is left of both but lower, so only (y, x) order passes.
const ringPixels = [[0, 4], [1, 4], [2, 4], [0, 5], [2, 5], [0, 6], [1, 6], [2, 6]];
const expectedA = { x: 1, y: 0, width: 6, height: 3, area: 8, center: { x: 4, y: 2 }, anchor: { x: 4, y: 2 } };
const expectedB = { x: 2, y: 0, width: 3, height: 1, area: 3, center: { x: 3, y: 0 }, anchor: { x: 3, y: 0 } };
const expectedRingFields = { x: 0, y: 4, width: 3, height: 3, area: 8, center: { x: 1, y: 5 } };
const ringAnchorTies = [{ x: 1, y: 4 }, { x: 0, y: 5 }, { x: 2, y: 5 }, { x: 1, y: 6 }];

function assertAnchorAmong(anchor, ties, message) {
  assert.ok(ties.some(tie => isDeepStrictEqual(anchor, tie)), message);
}

function assertRing(region) {
  const { anchor, ...fields } = region;
  assert.deepEqual(fields, expectedRingFields);
  assertAnchorAmong(anchor, ringAnchorTies, 'ring anchor is a nearest member, not its central hole');
}

test('findRegions sorts by bounding-box top-left, picks member anchors and reports truncation', () => {
  const image = rgbaImage(13, 8, [...blobA, ...blobB, ...ringPixels]);
  // Defaults, a minArea equal to the smallest area, and a maxRegions equal to the count keep every region.
  for (const bounds of [{}, { minArea: 3 }, { maxRegions: 3 }]) {
    const { regions, truncated } = findRegions(image, { match: matchForeground, connectivity: 4, ...bounds });
    assert.equal(truncated, false, JSON.stringify(bounds));
    assert.equal(regions.length, 3, JSON.stringify(bounds));
    assert.deepEqual(regions[0], expectedA);
    assert.deepEqual(regions[1], expectedB);
    assertRing(regions[2]);
  }

  // B's pixels are scanned before A's, but the limit keeps the first regions in (y, x) bounding-box order.
  assert.deepEqual(findRegions(image, { match: matchForeground, connectivity: 4, maxRegions: 1 }), {
    regions: [expectedA], truncated: true,
  });
  const limited = findRegions(image, { match: matchForeground, connectivity: 4, maxRegions: 2 });
  assert.deepEqual(limited, { regions: [expectedA, expectedB], truncated: true });
  assert.ok(Object.isFrozen(limited));
  assert.ok(Object.isFrozen(limited.regions));
  assert.ok(Object.isFrozen(limited.regions[0]));
  assert.ok(Object.isFrozen(limited.regions[0].center));
  assert.ok(Object.isFrozen(limited.regions[0].anchor));

  const filtered = findRegions(image, { match: matchForeground, connectivity: 4, minArea: 4 });
  assert.equal(filtered.truncated, false);
  assert.equal(filtered.regions.length, 2);
  assert.deepEqual(filtered.regions[0], expectedA);
  assertRing(filtered.regions[1]);
});

const diagonalPixels = [[0, 0], [1, 1], [2, 2]];
const diagonalSingletons = [
  { x: 0, y: 0, width: 1, height: 1, area: 1, center: { x: 0, y: 0 }, anchor: { x: 0, y: 0 } },
  { x: 1, y: 1, width: 1, height: 1, area: 1, center: { x: 1, y: 1 }, anchor: { x: 1, y: 1 } },
  { x: 2, y: 2, width: 1, height: 1, area: 1, center: { x: 2, y: 2 }, anchor: { x: 2, y: 2 } },
];

test('findRegions distinguishes four-neighbor from eight-neighbor diagonal pixels', () => {
  const image = rgbaImage(3, 3, diagonalPixels);
  assert.deepEqual(findRegions(image, { match: matchForeground, connectivity: 4 }), {
    regions: diagonalSingletons,
    truncated: false,
  });
  assert.deepEqual(findRegions(image, { match: matchForeground, connectivity: 8 }), {
    regions: [{ x: 0, y: 0, width: 3, height: 3, area: 3, center: { x: 1, y: 1 }, anchor: { x: 1, y: 1 } }],
    truncated: false,
  });
});

test('findRegions validates options and requires match to return literal true', () => {
  const image = rgbaImage(3, 3, diagonalPixels);
  const invalid = [
    { match: matchForeground, connectivity: 6 },
    { match: matchForeground, connectivity: '4' },
    { match: matchForeground, connectivity: 4, minArea: 0 },
    { match: matchForeground, connectivity: 4, minArea: 1.5 },
    { match: matchForeground, connectivity: 4, maxRegions: 0 },
    { match: matchForeground, connectivity: 4, maxRegions: Number.MAX_SAFE_INTEGER + 1 },
    { match: 1, connectivity: 4 },
    { connectivity: 4 },
  ];
  for (const options of invalid) {
    assert.throws(() => findRegions(image, options), { code: 'PIXELS_ERROR' }, JSON.stringify(options));
  }
  assert.deepEqual(findRegions(image, { match: () => 1, connectivity: 4 }), { regions: [], truncated: false });
  // Truthy background must not seed or extend a region: literal true alone keeps the three singletons.
  const truthyBackground = (...rgba) => matchForeground(...rgba) || 1;
  assert.deepEqual(findRegions(image, { match: truthyBackground, connectivity: 4 }), {
    regions: diagonalSingletons,
    truncated: false,
  });
});
