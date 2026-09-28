/**
 * Strict PNG decoding and connected pixel-region search; every error has code PIXELS_ERROR.
 *
 * decodePng(bytes) accepts only 8-bit non-interlaced RGB/RGBA PNGs and returns a frozen
 * {width, height, channels, data}; data stays a mutable Uint8Array.
 * findRegions(image, {match, minArea = 1, maxRegions = 256, connectivity = 4}) keeps pixels whose
 * match(r, g, b, a) returns literal true (a is 255 for RGB) and returns frozen {regions, truncated}
 * ordered by bounding-box top-left (y, x). center is the rounded centroid; anchor is the region
 * pixel nearest center, so it equals center whenever center is a member (ties: lower y, then x).
 */

import { isProxy, isUint8Array } from 'node:util/types';
// Namespace import: a missing zlib.crc32 (older Bun) reads as undefined instead of failing to link.
import * as zlib from 'node:zlib';

const PNG_SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];
// Caps bound decoded memory and keep coordinate sums exact doubles.
const MAX_DIMENSION = 32768;
const MAX_PIXELS = 64_000_000;
const PIXELS_ERROR = 'PIXELS_ERROR';
const IMAGE_KEYS = ['width', 'height', 'channels', 'data'];
const OPTION_KEYS = ['match', 'minArea', 'maxRegions', 'connectivity'];
const NEIGHBORS = {
  4: [[1, 0], [-1, 0], [0, 1], [0, -1]],
  8: [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]],
};

const HAS_NATIVE_CRC32 = typeof zlib.crc32 === 'function';
const CRC_TABLE = HAS_NATIVE_CRC32 ? null : new Uint32Array(256);
if (CRC_TABLE) {
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    CRC_TABLE[n] = c;
  }
}

function fail(message) {
  throw Object.assign(new Error(`Pixels: ${message}`), { code: PIXELS_ERROR });
}

// Reads own enumerable data properties only, so getters and proxy traps never run.
function fields(value, allowed, message) {
  if (value === null || typeof value !== 'object' || isProxy(value)) fail(message);
  const result = {};
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!allowed.includes(key) || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) fail(message);
    result[key] = descriptor.value;
  }
  return result;
}

// End of bytes[offset, offset + length), which must lie inside the input.
function range(bytes, offset, length) {
  const end = offset + length;
  if (end > bytes.length) fail('Truncated PNG.');
  return end;
}

function u32(bytes, offset) {
  range(bytes, offset, 4);
  return ((bytes[offset] << 24) | (bytes[offset + 1] << 16) | (bytes[offset + 2] << 8) | bytes[offset + 3]) >>> 0;
}

// PNG CRC-32 (reflected ISO 3309 polynomial, all-ones init and final XOR) over bytes[start, end).
function pngCrc(bytes, start, end) {
  if (HAS_NATIVE_CRC32) return zlib.crc32(bytes.subarray(start, end)) >>> 0;
  let crc = 0xffffffff;
  for (let i = start; i < end; i++) crc = CRC_TABLE[(crc ^ bytes[i]) & 255] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunkName(bytes, offset) {
  let name = '';
  for (let i = 0; i < 4; i++) {
    const byte = bytes[offset + i];
    if (!((byte >= 65 && byte <= 90) || (byte >= 97 && byte <= 122))) fail('Invalid PNG chunk type.');
    name += String.fromCharCode(byte);
  }
  return name;
}

function paeth(left, up, upLeft) {
  const estimate = left + up - upLeft;
  const leftDistance = Math.abs(estimate - left);
  const upDistance = Math.abs(estimate - up);
  const upLeftDistance = Math.abs(estimate - upLeft);
  if (leftDistance <= upDistance && leftDistance <= upLeftDistance) return left;
  if (upDistance <= upLeftDistance) return up;
  return upLeft;
}

// Reverses one scanline filter into dst; prev is the reconstructed row above (zeros for the first row).
function unfilter(filter, src, prev, dst, bpp) {
  const n = dst.length;
  if (filter === 0) {
    dst.set(src);
  } else if (filter === 1) {
    for (let i = 0; i < n; i++) dst[i] = (src[i] + (i >= bpp ? dst[i - bpp] : 0)) & 255;
  } else if (filter === 2) {
    for (let i = 0; i < n; i++) dst[i] = (src[i] + prev[i]) & 255;
  } else if (filter === 3) {
    for (let i = 0; i < n; i++) {
      const left = i >= bpp ? dst[i - bpp] : 0;
      dst[i] = (src[i] + ((left + prev[i]) >> 1)) & 255;
    }
  } else if (filter === 4) {
    for (let i = 0; i < n; i++) {
      const left = i >= bpp ? dst[i - bpp] : 0;
      const upLeft = i >= bpp ? prev[i - bpp] : 0;
      dst[i] = (src[i] + paeth(left, prev[i], upLeft)) & 255;
    }
  } else {
    fail('Unsupported PNG filter.');
  }
}

function concatParts(parts, total) {
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function readIhdr(bytes, offset) {
  const width = u32(bytes, offset);
  const height = u32(bytes, offset + 4);
  const depth = bytes[offset + 8];
  const color = bytes[offset + 9];
  const compression = bytes[offset + 10];
  const filter = bytes[offset + 11];
  const interlace = bytes[offset + 12];
  if (depth !== 8 || (color !== 2 && color !== 6) || compression !== 0 || filter !== 0 || interlace !== 0) {
    fail('Unsupported PNG format.');
  }
  if (width < 1 || height < 1 || width > MAX_DIMENSION || height > MAX_DIMENSION || width * height > MAX_PIXELS) {
    fail('Invalid PNG dimensions.');
  }
  return { width, height, channels: color === 6 ? 4 : 3 };
}

function reconstruct(raw, width, height, channels) {
  const stride = width * channels;
  const rowLength = stride + 1;
  if (raw.length !== height * rowLength) fail('PNG inflated size does not match IHDR.');
  const out = new Uint8Array(height * stride);
  let prev = new Uint8Array(stride);
  for (let y = 0; y < height; y++) {
    const rowStart = y * rowLength;
    const row = out.subarray(y * stride, (y + 1) * stride);
    unfilter(raw[rowStart], raw.subarray(rowStart + 1, rowStart + rowLength), prev, row, channels);
    prev = row;
  }
  return out;
}

export function decodePng(bytes) {
  if (!isUint8Array(bytes)) fail('PNG bytes must be a Uint8Array.');
  if (bytes.length < 8) fail('Truncated PNG.');
  for (let i = 0; i < 8; i++) if (bytes[i] !== PNG_SIGNATURE[i]) fail('Invalid PNG signature.');

  let offset = 8;
  let width = 0;
  let height = 0;
  let channels = 0;
  let seenPlte = false;
  let seenIdat = false;
  let idatClosed = false;
  let sawIend = false;
  const idatParts = [];
  let idatTotal = 0;

  while (offset < bytes.length) {
    range(bytes, offset, 8);
    const length = u32(bytes, offset);
    if (length > 0x7fffffff) fail('PNG chunk is too large.');
    const typeOffset = offset + 4;
    const dataOffset = typeOffset + 4;
    const dataEnd = dataOffset + length;
    const chunkEnd = range(bytes, offset, 12 + length);
    const type = chunkName(bytes, typeOffset);
    // The CRC covers the type and data fields, not the length.
    if (pngCrc(bytes, typeOffset, dataEnd) !== u32(bytes, dataEnd)) fail('Bad PNG chunk CRC.');

    if (type === 'IHDR') {
      if (offset !== 8) fail('Duplicate IHDR chunk.');
      if (length !== 13) fail('Invalid IHDR chunk.');
      const header = readIhdr(bytes, dataOffset);
      width = header.width;
      height = header.height;
      channels = header.channels;
    } else if (channels === 0) {
      fail('IHDR must be the first chunk.');
    } else if (type === 'IEND') {
      if (length !== 0) fail('IEND must be empty.');
      if (!seenIdat) fail('PNG has no IDAT chunk.');
      sawIend = true;
      offset = chunkEnd;
      break;
    } else if (type === 'IDAT') {
      if (idatClosed) fail('IDAT chunks must be consecutive.');
      idatParts.push(bytes.subarray(dataOffset, dataEnd));
      idatTotal += length;
      seenIdat = true;
    } else {
      if (seenIdat) idatClosed = true;
      if (type === 'PLTE') {
        // Optional suggested palette for RGB/RGBA: at most one, before IDAT, 1-256 entries.
        if (seenPlte || seenIdat) fail('Misplaced PLTE chunk.');
        if (length === 0 || length % 3 !== 0 || length > 768) fail('Invalid PLTE chunk.');
        seenPlte = true;
      } else if (type === 'tRNS') {
        // An RGB colour key would change the output's alpha; RGBA forbids tRNS outright.
        fail('Unsupported PNG transparency chunk.');
      } else if ((bytes[typeOffset] & 32) === 0) {
        fail('Unknown critical PNG chunk.');
      }
    }
    offset = chunkEnd;
  }

  if (!sawIend) fail('PNG is missing IEND.');
  if (offset !== bytes.length) fail('PNG has bytes after IEND.');

  const expected = height * (width * channels + 1);
  const compressed = idatParts.length === 1 ? idatParts[0] : concatParts(idatParts, idatTotal);
  let raw;
  try {
    // maxOutputLength bounds inflation; the spare byte tolerates either limit convention because
    // reconstruct rejects every size but expected. Trailing input is rejected where supported.
    raw = zlib.inflateSync(compressed, { maxOutputLength: expected + 1, rejectGarbageAfterEnd: true });
  } catch {
    fail('PNG inflate failed.');
  }
  return Object.freeze({ width, height, channels, data: reconstruct(raw, width, height, channels) });
}

// Region pixel nearest (cx, cy) by exact integer distance; ties go to the lowest row-major index.
function nearestMember(members, length, width, cx, cy) {
  let best = members[0];
  let bestDistance = Infinity;
  for (let k = 0; k < length; k++) {
    const index = members[k];
    const x = index % width;
    const y = (index - x) / width;
    const distance = (x - cx) ** 2 + (y - cy) ** 2;
    if (distance < bestDistance || (distance === bestDistance && index < best)) {
      best = index;
      bestDistance = distance;
    }
  }
  const x = best % width;
  return Object.freeze({ x, y: (best - x) / width });
}

export function findRegions(image, options) {
  const { width, height, channels, data } = fields(image, IMAGE_KEYS, 'Invalid image.');
  if (!Number.isSafeInteger(width) || width < 1 || width > MAX_DIMENSION
    || !Number.isSafeInteger(height) || height < 1 || height > MAX_DIMENSION
    || width * height > MAX_PIXELS) {
    fail('Invalid image dimensions.');
  }
  if (channels !== 3 && channels !== 4) fail('Invalid image channels.');
  const count = width * height;
  if (!isUint8Array(data) || data.length !== count * channels) fail('Invalid image data.');
  const { match, minArea = 1, maxRegions = 256, connectivity = 4 } = fields(options, OPTION_KEYS, 'Invalid region options.');
  if (typeof match !== 'function') fail('match must be a function.');
  if (!Number.isSafeInteger(minArea) || minArea < 1) fail('Invalid minArea.');
  if (!Number.isSafeInteger(maxRegions) || maxRegions < 1) fail('Invalid maxRegions.');
  if (connectivity !== 4 && connectivity !== 8) fail('Invalid connectivity.');
  const neighbors = NEIGHBORS[connectivity];

  // 1 = matched and unvisited, 2 = assigned to a region.
  const mask = new Uint8Array(count);
  let matched = 0;
  for (let i = 0; i < count; i++) {
    const sample = i * channels;
    let result;
    try {
      result = match(data[sample], data[sample + 1], data[sample + 2], channels === 4 ? data[sample + 3] : 255);
    } catch (cause) {
      throw Object.assign(new Error('Pixels: match failed.'), { code: PIXELS_ERROR, cause });
    }
    if (result === true) {
      mask[i] = 1;
      matched += 1;
    }
  }

  // Breadth-first queue reused per region: after a fill, queue[0, tail) holds exactly that region.
  const queue = new Int32Array(matched);
  const regions = [];
  let truncated = false;
  for (let start = 0; start < count; start++) {
    if (mask[start] !== 1) continue;
    mask[start] = 2;
    queue[0] = start;
    let head = 0;
    let tail = 1;
    let minX = width;
    let maxX = 0;
    let minY = height;
    let maxY = 0;
    let sumX = 0;
    let sumY = 0;
    while (head < tail) {
      const index = queue[head++];
      const x = index % width;
      const y = (index - x) / width;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
      sumX += x;
      sumY += y;
      for (let n = 0; n < neighbors.length; n++) {
        const nx = x + neighbors[n][0];
        const ny = y + neighbors[n][1];
        if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
        const next = ny * width + nx;
        if (mask[next] !== 1) continue;
        mask[next] = 2;
        queue[tail++] = next;
      }
    }
    const area = tail;
    if (area < minArea) continue;
    // Row-major discovery starts each region in its top row, so regions arrive in nondecreasing y.
    // With the limit filled, a region below the last kept row sorts after every kept one, as do all later ones.
    if (regions.length >= maxRegions && minY > regions[maxRegions - 1].y) {
      truncated = true;
      break;
    }
    const cx = Math.round(sumX / area);
    const cy = Math.round(sumY / area);
    regions.push(Object.freeze({
      x: minX,
      y: minY,
      width: maxX - minX + 1,
      height: maxY - minY + 1,
      area,
      center: Object.freeze({ x: cx, y: cy }),
      anchor: nearestMember(queue, tail, width, cx, cy),
    }));
  }

  // Stable sort: regions sharing a top-left keep discovery order.
  regions.sort((a, b) => a.y - b.y || a.x - b.x);
  if (regions.length > maxRegions) {
    truncated = true;
    regions.length = maxRegions;
  }
  return Object.freeze({ regions: Object.freeze(regions), truncated });
}
