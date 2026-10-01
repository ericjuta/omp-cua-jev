/**
 * Offline OCR accuracy eval for the bundled canvas seat map. It starts no Driver session,
 * opens no visible window, installs nothing, and executes no action.
 *
 * runOcrCanvasEval({binary = 'cua-driver', chrome = SYSTEM_CHROME, onProgress, variants} = {})
 * serves the loopback canvas fixture, renders it with owned headless system Chrome, and
 * parses each PNG with `<binary> perception parse --image --capture --json`. That local
 * parse has no action authority (local_input.action_eligible:false). Variants: dpr1, dpr2,
 * and dpr2-1568 (dpr2 downscaled by `sips -Z 1568`, mirroring the Driver's default capture).
 *
 * Ground truth is fixture geometry located in each PNG: the six discs are found by their
 * exact paint and ordered left to right; each label is drawn (radius + 16) CSS px below its
 * disc centre, scaled by the measured disc spacing. Per variant: labelRecall (exact seat text
 * anywhere), positionedRecall (at its own label position), wrongLabels (A<n> text at another
 * seat's label position), associationAccuracy (labelRegions on ground-truth disc boxes,
 * direction below, default gap), Selected: none / Clear selection via findText, parse
 * durationMs and wall ms, region counts. OCR text is untrusted evidence; reported OCR strings
 * are trimmed and truncated, never interpreted.
 *
 * Result {status:'ok'|'failed'|'blocked', code?, window, parser, variants, summary, cleanup, ms}.
 * Blocked codes: CHROME_UNAVAILABLE, DRIVER_UNAVAILABLE, not_installed. A failed variant keeps
 * its code (a perception code, RENDER_FAILED, DOWNSCALE_FAILED, GROUND_TRUTH_UNAVAILABLE,
 * PARSE_FAILED, PARSE_TIMEOUT, INVALID_PARSE or IMAGE_MISMATCH). Chrome 154 headless writes
 * its screenshot and then keeps running, so each render waits for a complete PNG, terminates
 * its own browser, awaits that exit, and checks that no process still names its owned profile.
 * Cleanup also closes the fixture (recording that it saw no clicks) and removes the temp root.
 */

import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createCanvasFixture } from '../canvas-fixture.mjs';
import { decodePng, findRegions } from '../pixels.mjs';
import { findText, labelRegions, projectParse } from '../visual.mjs';

export const SYSTEM_CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const WINDOW = Object.freeze({ width: 960, height: 540 });
const VARIANTS = Object.freeze({
  dpr1: Object.freeze({ dpr: 1, maxEdge: null }),
  dpr2: Object.freeze({ dpr: 2, maxEdge: null }),
  'dpr2-1568': Object.freeze({ dpr: 2, maxEdge: 1568 }),
});
export const VARIANT_NAMES = Object.freeze(Object.keys(VARIANTS));
// canvas-fixture.mjs draws each label centred at (x, y + radius + 16) CSS px.
const LABEL_OFFSET = 16;
// A label position spans ±30 CSS px across (seats are 80 apart) and ±14 down from its centre.
const LABEL_WINDOW = Object.freeze({ x: 30, y: 14 });
const SEAT_TEXT = /^A\d+$/;
const DISC_PAINT = Object.freeze({ available: [0, 85, 255], taken: [140, 140, 140] });
const PAINT_TOLERANCE = 8;
const DISC_MIN_AREA = 200;
const ROW_TOLERANCE = 2;
const RENDER_TIMEOUT_MS = 30_000;
const EXIT_TIMEOUT_MS = 10_000;
const POLL_MS = 100;
// The Driver budgets 15 s for worker start and 30 s for inference.
const PARSE_TIMEOUT_MS = 90_000;
const SIPS = '/usr/bin/sips';
const PGREP = '/usr/bin/pgrep';
const SYNTHETIC_SOURCE = Object.freeze({ kind: 'window', pid: 99999, window_id: 99999 });
const PARSE_CODES = new Set(['not_installed', 'capture_not_found', 'capture_expired', 'capture_stale',
  'capture_generation_mismatch', 'unsupported_target', 'unsupported_platform', 'incompatible_protocol',
  'invalid_frame', 'worker_launch_failed', 'worker_crashed', 'worker_cancelled', 'timeout',
  'resource_limit_exceeded', 'artifact_invalid', 'inference_failed']);
const BLOCKED = new Set(['DRIVER_UNAVAILABLE', 'not_installed']);
const OCR_TEXT_LIMIT = 32;

function fail(code) {
  throw Object.assign(new Error(`OCR canvas eval: ${code}`), { code });
}

function requireThat(condition, code) {
  if (!condition) fail(code);
}

const ratio = (count, total) => Math.round((count / total) * 1000) / 1000;
const mean = values => (values.length === 0 ? null : Math.round(values.reduce((sum, value) => sum + value, 0) / values.length));
const ocrText = text => (typeof text === 'string' && text.trim() ? text.trim().slice(0, OCR_TEXT_LIMIT) : null);
const escapeRegExp = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function run(file, args, timeout) {
  return new Promise(resolve => {
    execFile(file, args, { timeout, killSignal: 'SIGKILL', maxBuffer: 64 << 20, encoding: 'utf8' },
      (error, stdout) => resolve({ error, stdout }));
  });
}

// Resolves null after ms without keeping the event loop alive once the promise settles.
function within(promise, ms) {
  let timer;
  return Promise.race([promise, new Promise(resolve => { timer = setTimeout(resolve, ms, null); })])
    .finally(() => clearTimeout(timer));
}

// Process IDs whose command line names the owned path; pgrep exits 1 when none match.
async function ownedProcesses(path) {
  const { error, stdout } = await run(PGREP, ['-f', escapeRegExp(path)], 10_000);
  if (error) return error.code === 1 ? [] : null;
  return stdout.split('\n').filter(Boolean).map(Number).filter(Number.isSafeInteger);
}

async function render(chrome, url, png, profile, dpr) {
  const started = performance.now();
  const child = spawn(chrome, ['--headless=new', `--screenshot=${png}`, `--window-size=${WINDOW.width},${WINDOW.height}`,
    `--force-device-scale-factor=${dpr}`, `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check',
    '--use-mock-keychain', '--password-store=basic', '--disable-background-networking', '--disable-component-update',
    '--hide-scrollbars', url], { stdio: 'ignore' });
  let exit = null;
  const exited = new Promise(resolve => {
    child.once('exit', (code, signal) => resolve({ code, signal }));
    child.once('error', () => resolve({ code: null, signal: null, spawnFailed: true }));
  }).then(value => (exit = value));
  let image = null;
  const readPng = async () => {
    try {
      image = decodePng(await readFile(png));
    } catch {}
  };
  while (image === null && exit === null && performance.now() - started < RENDER_TIMEOUT_MS) {
    await delay(POLL_MS);
    await readPng();
  }
  if (image === null && exit !== null) await readPng();
  const renderMs = Math.round(performance.now() - started);
  const terminated = exit === null;
  if (terminated) child.kill('SIGTERM');
  let killed = false;
  if (await within(exited, EXIT_TIMEOUT_MS) === null) {
    killed = true;
    child.kill('SIGKILL');
    await exited;
  }
  const lingering = await ownedProcesses(profile);
  let remaining = lingering;
  if (lingering?.length) {
    for (const pid of lingering) {
      try { process.kill(pid, 'SIGTERM'); } catch {}
    }
    await delay(1000);
    remaining = await ownedProcesses(profile);
  }
  return {
    image, renderMs,
    chrome: { dpr, exitCode: exit.code, signal: exit.signal, spawnFailed: exit.spawnFailed === true,
      terminated, killed, lingering: lingering?.length ?? null, lingeringRemaining: remaining?.length ?? null },
  };
}

function groundTruth(image, seats) {
  const discs = [];
  for (const [paint, [red, green, blue]] of Object.entries(DISC_PAINT)) {
    const { regions } = findRegions(image, {
      match: (r, g, b) => Math.abs(r - red) <= PAINT_TOLERANCE && Math.abs(g - green) <= PAINT_TOLERANCE
        && Math.abs(b - blue) <= PAINT_TOLERANCE,
      minArea: DISC_MIN_AREA, connectivity: 8,
    });
    // Discs are solid near-square blobs; glyph antialiasing and button borders are not.
    for (const region of regions) {
      if (Math.abs(region.width - region.height) <= 2) discs.push({ available: paint === 'available', region });
    }
  }
  discs.sort((a, b) => a.region.x - b.region.x);
  requireThat(discs.length === seats.length && discs.every((disc, index) => disc.available === seats[index].available),
    'GROUND_TRUTH_UNAVAILABLE');
  const centres = discs.map(({ region }) => ({ x: region.x + region.width / 2, y: region.y + region.height / 2 }));
  const scale = (centres.at(-1).x - centres[0].x) / (seats.at(-1).x - seats[0].x);
  requireThat(Number.isFinite(scale) && scale > 0 && centres.every((centre, index) =>
    Math.abs(centre.y - centres[0].y) <= ROW_TOLERANCE
    && Math.abs(centre.x - centres[0].x - (seats[index].x - seats[0].x) * scale) <= ROW_TOLERANCE),
  'GROUND_TRUTH_UNAVAILABLE');
  return {
    scale,
    seats: seats.map((seat, index) => {
      const { x, y, width, height } = discs[index].region;
      const centre = centres[index];
      return {
        seat: seat.seat, available: seat.available,
        label: { x: centre.x, y: centre.y + (seat.radius + LABEL_OFFSET) * scale },
        target: { bounds: { x, y, width, height }, anchor: { x: x + Math.floor(width / 2), y: y + Math.floor(height / 2) } },
      };
    }),
  };
}

function textEvidence(visual, match) {
  const { matches, unique } = findText(visual, match);
  return { found: matches.length > 0, unique,
    confidence: matches.length === 0 ? null : Math.max(...matches.map(({ confidence }) => confidence)) };
}

function score(visual, truth) {
  const windowX = LABEL_WINDOW.x * truth.scale;
  const windowY = LABEL_WINDOW.y * truth.scale;
  const seatAt = ({ anchor }) => truth.seats.find(({ label }) =>
    Math.abs(anchor.x - label.x) <= windowX && Math.abs(anchor.y - label.y) <= windowY) ?? null;
  const texts = visual.regions.filter(({ kind }) => kind === 'text');
  let wrongLabels = 0;
  let strayLabels = 0;
  const misreads = [];
  for (const region of texts) {
    const text = region.text.trim();
    const seat = seatAt(region);
    if (SEAT_TEXT.test(text)) {
      if (seat === null) strayLabels += 1;
      else if (seat.seat !== text) wrongLabels += 1;
    }
    if (seat !== null && seat.seat !== text) misreads.push({ seat: seat.seat, text: ocrText(text) });
  }
  const association = labelRegions(truth.seats.map(({ target }) => target), visual, { direction: 'below' });
  const seats = truth.seats.map((seat, index) => {
    const exact = texts.filter(region => region.text.trim() === seat.seat);
    const { text, confidence, ambiguous } = association[index];
    return {
      seat: seat.seat, available: seat.available, found: exact.length > 0,
      positioned: exact.some(region => seatAt(region) === seat),
      label: ocrText(text), confidence, ambiguous, correct: text?.trim() === seat.seat,
    };
  });
  const count = key => seats.filter(seat => seat[key]).length;
  return {
    labelRecall: ratio(count('found'), seats.length),
    positionedRecall: ratio(count('positioned'), seats.length),
    wrongLabels, strayLabels,
    associationAccuracy: ratio(count('correct'), seats.length),
    associationAmbiguous: count('ambiguous'),
    selectedNone: textEvidence(visual, 'Selected: none'),
    clearSelection: textEvidence(visual, 'Clear selection'),
    regions: { total: visual.regions.length, text: texts.length, icon: visual.regions.length - texts.length },
    seats, misreads,
    labels: Object.fromEntries(seats.map(({ seat, label }) => [seat, label])),
  };
}

async function parseImage(binary, png, capture) {
  const started = performance.now();
  const { error, stdout } = await run(binary, ['perception', 'parse', '--image', png, '--capture', capture, '--json'],
    PARSE_TIMEOUT_MS);
  const wallMs = Math.round(performance.now() - started);
  if (error?.code === 'ENOENT') fail('DRIVER_UNAVAILABLE');
  if (error?.killed) fail('PARSE_TIMEOUT');
  let reply;
  try {
    reply = JSON.parse(stdout);
  } catch {
    fail('PARSE_FAILED');
  }
  if (error) {
    const code = reply?.error?.code ?? reply?.code;
    fail(PARSE_CODES.has(code) ? code : 'PARSE_FAILED');
  }
  return { reply, wallMs };
}

function summarize(variants) {
  const ok = variants.filter(({ status }) => status === 'ok');
  const average = key => (ok.length === 0 ? null : ratio(ok.reduce((sum, variant) => sum + variant[key], 0), ok.length));
  return {
    byVariant: Object.fromEntries(variants.map(variant => [variant.name, variant.status !== 'ok'
      ? { status: variant.status, code: variant.code }
      : {
        labelRecall: variant.labelRecall, positionedRecall: variant.positionedRecall, wrongLabels: variant.wrongLabels,
        associationAccuracy: variant.associationAccuracy, associationAmbiguous: variant.associationAmbiguous,
        selectedNone: variant.selectedNone.found, clearSelection: variant.clearSelection.found,
        parseMs: variant.parseMs, wallMs: variant.wallMs, regions: variant.regions.total,
        missedSeats: variant.seats.filter(({ found }) => !found).map(({ seat }) => seat),
      }])),
    overall: {
      variants: variants.length, ok: ok.length,
      meanLabelRecall: average('labelRecall'), meanAssociationAccuracy: average('associationAccuracy'),
      totalWrongLabels: ok.reduce((sum, { wrongLabels }) => sum + wrongLabels, 0),
      meanParseMs: mean(ok.map(({ parseMs }) => parseMs).filter(Number.isFinite)),
      meanWallMs: mean(ok.map(({ wallMs }) => wallMs)),
    },
  };
}

/** Renders, parses and scores the synthetic canvas offline; see the module header. */
export async function runOcrCanvasEval({ binary = 'cua-driver', chrome = SYSTEM_CHROME, onProgress, variants = VARIANT_NAMES } = {}) {
  if (typeof binary !== 'string' || binary.length === 0 || typeof chrome !== 'string' || !isAbsolute(chrome)
    || (onProgress !== undefined && typeof onProgress !== 'function') || !Array.isArray(variants)
    || variants.length === 0 || new Set(variants).size !== variants.length
    || variants.some(name => typeof name !== 'string' || !Object.hasOwn(VARIANTS, name))) {
    throw new TypeError('Invalid OCR canvas eval options');
  }
  const startedAt = performance.now();
  const results = [];
  const cleanup = { fixtureClosed: null, fixtureClicks: null, chrome: [], tempRemoved: null };
  let parser = null;
  const finish = (status, code) => Object.freeze({
    status, ...(code ? { code } : {}), window: WINDOW, parser, variants: results,
    summary: summarize(results), cleanup, ms: Math.round(performance.now() - startedAt),
  });
  try {
    await access(chrome, constants.X_OK);
  } catch {
    return finish('blocked', 'CHROME_UNAVAILABLE');
  }
  const progress = async (phase, variant) => {
    if (onProgress) await onProgress(Object.freeze({ phase, variant }));
  };
  const root = await mkdtemp(join(tmpdir(), 'omp-cua-jev-ocr-'));
  let fixture = null;
  let blocked = null;
  try {
    fixture = await createCanvasFixture();
    const capture = join(root, 'capture.json');
    await writeFile(capture, JSON.stringify({ source: SYNTHETIC_SOURCE }));
    const renders = new Map();
    for (const name of variants) {
      const { dpr, maxEdge } = VARIANTS[name];
      const variant = { name, dpr, maxEdge };
      try {
        if (!renders.has(dpr)) {
          await progress('render', name);
          const png = join(root, `dpr${dpr}.png`);
          const rendered = await render(chrome, fixture.url, png, join(root, `profile-dpr${dpr}`), dpr);
          cleanup.chrome.push(rendered.chrome);
          renders.set(dpr, rendered.image ? { png, renderMs: rendered.renderMs } : null);
        }
        const source = renders.get(dpr);
        requireThat(source !== null, 'RENDER_FAILED');
        let png = source.png;
        variant.renderMs = source.renderMs;
        if (maxEdge !== null) {
          await progress('downscale', name);
          png = join(root, `${name}.png`);
          const { error } = await run(SIPS, ['-Z', String(maxEdge), source.png, '--out', png], 30_000);
          requireThat(!error, 'DOWNSCALE_FAILED');
        }
        const bytes = await readFile(png);
        const sha256 = createHash('sha256').update(bytes).digest('hex');
        let image;
        let truth;
        try {
          image = decodePng(bytes);
          truth = groundTruth(image, fixture.seats);
        } catch {
          fail('GROUND_TRUTH_UNAVAILABLE');
        }
        variant.image = { width: image.width, height: image.height, sha256 };
        variant.scale = Math.round(truth.scale * 10_000) / 10_000;
        await progress('parse', name);
        const { reply, wallMs } = await parseImage(binary, png, capture);
        let visual;
        try {
          visual = projectParse(reply);
        } catch {
          fail('INVALID_PARSE');
        }
        requireThat(visual.width === image.width && visual.height === image.height && visual.sha256 === sha256
          && visual.source.kind === 'window' && visual.source.pid === SYNTHETIC_SOURCE.pid
          && visual.source.window_id === SYNTHETIC_SOURCE.window_id, 'IMAGE_MISMATCH');
        parser ??= visual.parser;
        Object.assign(variant, {
          status: 'ok', actionCoordinateSpace: visual.actionCoordinateSpace.kind,
          actionEligible: reply.local_input?.action_eligible ?? null,
          parseMs: visual.durationMs, wallMs, warnings: visual.warnings.map(({ code }) => code),
          ...score(visual, truth),
        });
        results.push(variant);
        await progress('scored', name);
      } catch (error) {
        if (typeof error?.code !== 'string' || error.message !== `OCR canvas eval: ${error.code}`) throw error;
        if (BLOCKED.has(error.code)) {
          blocked = error.code;
          break;
        }
        results.push({ ...variant, status: 'failed', code: error.code });
      }
    }
  } finally {
    if (fixture) {
      cleanup.fixtureClicks = fixture.state().clicks.length;
      await fixture.close();
      cleanup.fixtureClosed = true;
    }
    await rm(root, { recursive: true, force: true });
    cleanup.tempRemoved = await access(root).then(() => false, () => true);
  }
  if (blocked) return finish('blocked', blocked);
  const failed = results.find(({ status }) => status !== 'ok');
  return finish(failed ? 'failed' : 'ok', failed?.code);
}

if (import.meta.main) {
  const result = await runOcrCanvasEval({
    onProgress: ({ phase, variant }) => { process.stderr.write(`${JSON.stringify({ phase, variant })}\n`); },
  });
  console.log(JSON.stringify(result, null, 2));
  process.exitCode = result.status === 'ok' ? 0 : 1;
}
