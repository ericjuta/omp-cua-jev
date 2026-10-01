import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { isProxy } from 'node:util/types';
import { createCuaDriver } from './cua-driver.mjs';
import { journalDirectory, ownedCaptureDirectory, readEntry } from './journal.mjs';
import { decodePng, findRegions } from './pixels.mjs';
import { projectParse } from './visual.mjs';

const positiveInteger = value => Number.isSafeInteger(value) && value > 0;
const own = (value, key) => Object.hasOwn(value, key);
const ELEMENT_FIELDS = ['element_index', 'role', 'label', 'value', 'value_description',
  'min', 'max', 'enabled', 'selected', 'actions', 'in_web_content', 'parent_index', 'depth'];
const LOCAL_ELEMENT_FIELDS = [...ELEMENT_FIELDS, 'element_token', 'frame'];
const OBSERVE_FIELDS = new Set(['screenshot', 'webContentOnly', 'include_accessibility_tree',
  'query', 'max_elements', 'max_depth', 'max_dimension', 'max_image_dimension']);
// Driver 0.31 element actions accept only element_token; element_index is display-only.
const ACTION_FIELDS = {
  click: new Set(['element_token', 'x', 'y', 'button', 'count', 'capture_id']),
  set_value: new Set(['element_token', 'value']),
  type_text: new Set(['text', 'element_token']),
  press_key: new Set(['key', 'element_token']),
};
const VISUAL_FIELDS = new Set(['kinds', 'maxRegions', 'minConfidence']);
const VISUAL_KINDS = new Set(['text', 'icon']);
// visualRegions() result: projectParse output without its source binding.
const VISUAL_RESULT_FIELDS = ['capture_id', 'width', 'height', 'sha256', 'actionCoordinateSpace',
  'parser', 'regions', 'warnings', 'durationMs'];
// Driver budgets: 15 s cold worker startup plus 30 s inference.
const PARSE_TIMEOUT_MS = 45_000;
const VERIFY_FIELDS = new Set(['expect', 'timeoutMs', 'stableSamples']);
const VERIFY_STATUSES = new Set(['satisfied', 'unsatisfied', 'unknown']);
// Native reason codes only; free-form native text is never returned.
const REASON_CODE = /^[a-z][a-z0-9_]{0,63}$/;
const BOUNDS = ['x', 'y', 'width', 'height'];
const CAPTURE_PREFIX = 'omp-cua-jev-native-';
function requireThat(condition, message, unknownOutcome = false, reason) {
  if (!condition) throw Object.assign(new Error(`Native target: ${message}`), {
    code: 'NATIVE_TARGET_ERROR', unknownOutcome, ...(reason === undefined ? {} : { reason }),
  });
}
async function ownedFile(operation) {
  try { return await operation(); }
  catch { requireThat(false, 'Owned capture file operation failed.'); }
}
// Re-read an owned capture; its recorded byte_length and sha256 must still match.
async function ownedBytes(image) {
  requireThat(await ownedFile(() => realpath(image.file_path)) === image.file_path, 'Capture is not the owned file.');
  const bytes = await ownedFile(() => readFile(image.file_path));
  requireThat(bytes.length === image.byte_length &&
    createHash('sha256').update(bytes).digest('hex') === image.sha256, 'Capture changed after observation.');
  return bytes;
}
// Every bound within one point of the capture's window_bounds.
function sameBounds(bounds, expected) {
  return bounds !== null && typeof bounds === 'object' &&
    BOUNDS.every(key => Number.isFinite(bounds[key]) && Math.abs(bounds[key] - expected[key]) <= 1);
}
// Inclusive edges. Unreadable bounds cannot prove that a window misses the point.
function containsPoint(bounds, x, y) {
  if (bounds === null || typeof bounds !== 'object' || !BOUNDS.every(key => Number.isFinite(bounds[key]))) return true;
  return x >= bounds.x && x <= bounds.x + bounds.width && y >= bounds.y && y <= bounds.y + bounds.height;
}
// Inclusive edges: outer spans every edge of inner.
function containsBounds(outer, inner) {
  return [outer, inner].every(bounds => bounds !== null && typeof bounds === 'object' &&
    BOUNDS.every(key => Number.isFinite(bounds[key]))) &&
    outer.x <= inner.x && outer.y <= inner.y &&
    outer.x + outer.width >= inner.x + inner.width && outer.y + outer.height >= inner.y + inner.height;
}
// Guard and parse reads dispatch no action. Keep only the driver's validated tool name and allowlisted refusal code.
async function guardRead(read, unknownOutcome = false, reason = 'guard_unavailable',
  message = 'Pixel guard evidence is unavailable.') {
  try { return await read(); }
  catch (error) {
    const driverError = error?.code === 'CUA_DRIVER_ERROR';
    const safe = key => driverError && typeof error[key] === 'string' && REASON_CODE.test(error[key]) ? { [key]: error[key] } : {};
    throw Object.assign(new Error(`Native target: ${message}`), {
      code: 'NATIVE_TARGET_ERROR', unknownOutcome, reason, ...safe('tool'), ...safe('refusalCode'),
    });
  }
}
// Inspect data properties before reading caller arguments, including cross-realm OMP objects.
function record(value) {
  requireThat(value !== null && typeof value === 'object' && !isProxy(value), 'Expected plain options.');
  const prototype = Object.getPrototypeOf(value);
  requireThat(prototype === null || !isProxy(prototype), 'Expected plain options.');
  const constructor = prototype && Object.getOwnPropertyDescriptor(prototype, 'constructor')?.value;
  requireThat(prototype === null || prototype === Object.prototype ||
    (!isProxy(prototype) && typeof constructor === 'function' && !isProxy(constructor) &&
      Object.getOwnPropertyDescriptor(constructor, 'prototype')?.value === prototype &&
      Function.prototype.toString.call(constructor) === Function.prototype.toString.call(Object)), 'Expected plain options.');
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    requireThat(typeof key === 'string' && descriptor.enumerable && own(descriptor, 'value'), 'Expected data properties.');
  }
  return value;
}
function pick(value, fields) {
  const result = {};
  for (const field of fields) if (own(value, field)) result[field] = value[field];
  return result;
}
function freeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const item of Object.values(value)) freeze(item);
    Object.freeze(value);
  }
  return value;
}
function observationOptions(options) {
  record(options);
  requireThat(Object.keys(options).every(key => OBSERVE_FIELDS.has(key)), 'Unknown observation option.');
  const { screenshot = false, webContentOnly = true, include_accessibility_tree = true,
    max_elements = 2000, max_depth = 25, max_dimension, max_image_dimension, query } = options;
  requireThat([screenshot, webContentOnly, include_accessibility_tree].every(value => typeof value === 'boolean') &&
    (screenshot || include_accessibility_tree), 'Invalid observation mode.');
  requireThat(positiveInteger(max_elements) && max_elements <= 2000 && positiveInteger(max_depth) && max_depth <= 25 &&
    (max_dimension === undefined || positiveInteger(max_dimension)) &&
    (max_image_dimension === undefined || (Number.isSafeInteger(max_image_dimension) && max_image_dimension >= 0)) &&
    (query === undefined || typeof query === 'string'), 'Invalid bounded AX options.');
  return { screenshot, webContentOnly, args: { include_accessibility_tree, include_screenshot: false,
    max_elements, max_depth, ...pick(options, ['max_dimension', 'max_image_dimension', 'query']) } };
}
// Caller visual options map to the native parse options; absent keys stay absent.
function visualOptions(options) {
  record(options);
  requireThat(Object.keys(options).every(key => VISUAL_FIELDS.has(key)), 'Unknown visual regions option.');
  const { kinds, maxRegions, minConfidence } = options;
  // One read of the caller's array; only the validated copy is sent.
  const list = Array.isArray(kinds) && !isProxy(kinds) ? Array.from(kinds) : null;
  requireThat((kinds === undefined || (list !== null && list.length > 0 &&
    list.every(kind => VISUAL_KINDS.has(kind)) && new Set(list).size === list.length)) &&
    (maxRegions === undefined || positiveInteger(maxRegions)) &&
    (minConfidence === undefined || (Number.isFinite(minConfidence) && minConfidence >= 0 && minConfidence <= 1)),
  'Invalid visual regions options.');
  return {
    ...(kinds === undefined ? {} : { kinds: list }),
    ...(maxRegions === undefined ? {} : { max_regions: maxRegions }),
    ...(minConfidence === undefined ? {} : { min_confidence: minConfidence }),
  };
}
function project(reply, webContentOnly) {
  requireThat(Array.isArray(reply.elements), 'Missing native elements.');
  const elements = reply.elements.filter(element => !webContentOnly || element.in_web_content === true);
  const coverage = {
    elements_complete: typeof reply.elements_complete === 'boolean' ? reply.elements_complete : null,
    truncated: typeof reply.truncated === 'boolean' ? reply.truncated : null,
    ...pick(reply, ['element_count', 'total_element_count', 'returned_element_count', 'filtered_element_count']),
    projected_element_count: elements.length, omitted_element_count: reply.elements.length - elements.length,
  };
  return {
    state: { ...pick(reply, ['app_name', 'window_title', 'degraded']), coverage,
      elements: elements.map(element => pick(element, ELEMENT_FIELDS)) },
    local: { ...pick(reply, ['pid', 'window_id', 'snapshot_id']),
      elements: elements.map(element => pick(element, LOCAL_ELEMENT_FIELDS)) },
  };
}
function geometry(screenshot) {
  const bounds = screenshot?.window_bounds;
  if (!screenshot || screenshot.frame_valid !== true || !positiveInteger(screenshot.width) ||
    !positiveInteger(screenshot.height) || !Number.isFinite(screenshot.scale) || screenshot.scale <= 0 ||
    !bounds || !['x', 'y', 'width', 'height'].every(key => Number.isFinite(bounds[key])) ||
    bounds.width <= 0 || bounds.height <= 0) return null;
  return JSON.stringify([screenshot.width, screenshot.height, screenshot.scale,
    bounds.x, bounds.y, bounds.width, bounds.height]);
}

/**
 * One existing, exact native window. Options: positive integer pid/windowId;
 * foreground=false permits no foreground delivery or focus; maxAgeMs=15000.
 * binary/session/timeoutMs/journal/journalDir pass to createCuaDriver. Single
 * use: call start() or resume() once and always end in finally, even after an
 * uncertain start/resume. End removes only this helper's captures, never closes
 * the existing app. When the driver refuses a first resume(), nothing was
 * adopted (get_session is read-only): end() sends nothing and resolves null, so
 * try/finally surfaces the resume error. If the driver adopted the session but a
 * later local resume step failed, end() closes it like any started session.
 * Driver and pixel decoder errors pass through unchanged, except pixel guard
 * and visual parse reads (below).
 *
 * start() authorizes observation only after the driver session starts and the
 * exact {pid,windowId} target is recorded via driver.recordOwnership. resume()
 * does the same through driver.resume() for a caller-supplied session label;
 * unless journal is false it adopts the journal captureDirectory only when
 * journal.ownedCaptureDirectory returns that exact spelling (a user-owned
 * directory directly under realpath(tmpdir()) named omp-cua-jev-native-*, not a
 * symlink alias); otherwise it ignores it. A new capture directory is recorded
 * with the target before any capture dispatches.
 *
 * observe({screenshot=false,webContentOnly=true,include_accessibility_tree=true,
 * max_elements=2000,max_depth=25,query?,max_dimension?,max_image_dimension?})
 * returns frozen plain JSON
 * {id,observedAt,state,local}. state holds compact AX fields and coverage, with
 * unknown completeness/truncation as null. local retains exact pid/window_id,
 * snapshot_id when present, elements with element_token/frame, and screenshot
 * {file_path,capture_id,width,height,scale,window_bounds,frame_valid,byte_length,
 * sha256}. capture_id is the native single-use capture binding string or null.
 * max_image_dimension (integer >=0; 0 = native resolution) overrides the Driver's
 * configured long-edge downscale; max_dimension stays a tighter cap.
 * The file holds original captured bytes until end. AX frames are desktop
 * coordinates, NOT screenshot pixels. Never derive pixel candidates from them.
 *
 * settle({ready,maxMs=5000,intervalMs=100,stableForMs=600,signal,...observeOptions})
 * requires screenshots, literal ready===true, and consecutive identical full
 * PNG bytes/hash and geometry spanning the quiet interval. This conservative
 * full-frame check can time out on unrelated animation or PNG encoding changes;
 * it cannot guarantee no future animation. The deadline admits reads, it does
 * not abandon in-flight work. Returns {status,observation,samples}, status one
 * of settled/timeout/cancelled. Only the final settled original observation can
 * authorize pixels, and any next observation/focus/execute invalidates it.
 * Observation IDs and settling are local evidence; capture_id is the native
 * binding. Serialize all work for this window, including other driver instances.
 *
 * execute({action:{tool,args}}, observation) supports native click, set_value,
 * type_text, press_key. It supplies exact pid/window_id; mismatched scope is
 * rejected. AX targets require a current element_token (Driver 0.31 rejects
 * element_index/snapshot_id, so they are refused locally); element_index stays
 * display-only state.
 * Pixel x/y use returned PNG pixels unchanged, never multiplied by scale.
 * delivery_mode defaults background; foreground requires explicit opt-in here
 * AND in the candidate. set_value has no delivery_mode argument. AX clicks are
 * single left AXPress only. Pixel clicks may specify button/count. type_text
 * takes text; press_key takes key; both may carry a current AX identity. Other
 * native arguments are intentionally unsupported. Native typing can itself
 * choose AX or event delivery. The helper never retries or chooses another
 * tool/route. Receipts return frozen without native summary text. Pixel clicks
 * also require a string capture_id, always sent (a caller copy must match); the
 * Driver consumes that single-use, session-scoped capture on dispatch, so each
 * pixel action needs its own fresh settle() in this session. Pixel clicks also
 * require a geometry guard: before dispatch the exact-pid window list must show
 * windowId with bounds within 1 point of the capture's window_bounds.
 * Foreground pixels are main-display only. Their screen point (bounds.x +
 * x*bounds.width/width, likewise y; never via screenshot scale), derived from
 * both the capture's and the current bounds, must lie in [0,width) x
 * [0,height) of driver.screenSize(); a window may extend off the display.
 * Then the on-screen list must show the target and no other window whose
 * bounds contain either point (inclusive edges) unless both z_index values are
 * integers and the other's is lower. Only a driver_owned:true record whose
 * bounds cover the whole main display (Cua Driver's own click-through overlay)
 * is ignored; driver-owned cards such as approvals, however large, and unknown
 * ownership still occlude. Guard order: exact list, screenSize, on-screen
 * list, click. Refusals dispatch no click and throw NATIVE_TARGET_ERROR
 * unknownOutcome:false with reason target_missing, target_moved,
 * target_offscreen or target_occluded. A failed guard read does the same with
 * reason guard_unavailable, keeping only the driver's tool and refusalCode.
 * For foreground pixels, call focus() and then settle() so the target is
 * topmost at the point. Pixel clicks accept only the event route: an
 * accessibility route throws unknownOutcome:true reason
 * pixel_routed_to_accessibility. After an accepted receipt the bounds are
 * re-read: a missing or moved window throws unknownOutcome:true reason
 * target_moved_during_dispatch, and a failed re-read reason
 * guard_unavailable_after_dispatch. Confirmed receipts
 * require native evidence; event typing requires a full Unicode scalar count.
 * Atomic AX typing may omit the count, but any supplied count must be full.
 * Typing inserts, not replaces.
 * Delivery is not completion: runBounded callers must independently verify the
 * exact application postcondition, including field value after either typing
 * route. Foreground receipts do not prove focus; use focus before observing.
 *
 * verify({expect,timeoutMs=5000,stableSamples=2}) with 1-8 predicates,
 * timeoutMs 0-10000 and stableSamples 1-5 runs verify_state on the exact
 * pid/window, invalidates current evidence, and returns frozen
 * {status,stable,samples,elapsedMs,predicates:[{index,status,unknownReason?}]}.
 * Only status 'satisfied' means satisfied: the literal native status with every
 * requested predicate satisfied. Unrecognized statuses become 'unknown';
 * unknownReason keeps only native reason codes; observed values are dropped.
 *
 * regions(observation, {match,minArea,maxRegions,connectivity}) re-reads the
 * owned capture of an observation produced here, requires its recorded
 * byte_length and sha256, decodes those same bytes, requires the recorded
 * width/height, and returns frozen pixels.findRegions {regions,truncated} plus
 * {capture_id,width,height}. It neither invalidates evidence nor authorizes an
 * action; anchors are capture pixels for that same observation.
 *
 * visualRegions(observation, {kinds?,maxRegions?,minConfidence?}) requires the
 * current observation with a native capture_id (kinds a non-empty unique subset
 * of text/icon; maxRegions positive integer; minConfidence 0-1). It re-hashes
 * the owned capture like regions(), then sends read-only parse_visual_regions
 * (optional cua-perception extension) with a 45 s client timeout. The receipt
 * must project via visual.projectParse and bind to this capture: capture_id,
 * window pid/window_id, width/height and sha256. Returns frozen {capture_id,
 * width,height,sha256,actionCoordinateSpace,parser,regions,warnings,durationMs};
 * region bounds/anchors are PNG pixels of that capture, the same space as
 * regions() and pixel clicks. actionCoordinateSpace (screenshot_pixels or the
 * Driver's affine for downscaled captures) is evidence only and never applied:
 * the Driver maps capture-bound click pixels itself. Parsing does not consume
 * the capture or invalidate the observation; a settled observation keeps its
 * pixel authority, and OCR text authorizes nothing. Parses take ~4-6 s, which
 * counts against maxAgeMs. Driver failures throw NATIVE_TARGET_ERROR
 * unknownOutcome:false reason visual_regions_unavailable, keeping only the
 * driver's tool and refusalCode; malformed or mismatched receipts throw
 * unknownOutcome:false.
 */
export function createNativeTarget(options = {}) {
  record(options);
  const { pid, windowId, foreground = false, maxAgeMs = 15000, journal, journalDir } = options;
  requireThat(positiveInteger(pid) && positiveInteger(windowId) && typeof foreground === 'boolean' &&
    Number.isFinite(maxAgeMs) && maxAgeMs >= 0, 'Invalid target options.');
  const driver = createCuaDriver(pick(options, ['binary', 'session', 'timeoutMs', 'journal', 'journalDir']));
  // The driver has already validated and resolved these same inputs.
  const journalPath = journal === false ? undefined : journalDirectory(journalDir);
  const instance = randomUUID();
  let busy = false, active = false, generation = 0, current = null, directory = null, recorded = null, endReceipt = null;
  // 'new' until start() or resume() is first attempted; 'unadopted' once the driver refused that first resume().
  let lifecycle = 'new';
  const issued = new WeakSet();
  function invalidate() { generation += 1; current = null; }
  async function operate(callback) {
    requireThat(!busy, 'Concurrent target operation.');
    busy = true;
    try { return await callback(); } finally { busy = false; }
  }
  async function capture(options) {
    invalidate();
    requireThat(active, 'Session is not active.');
    const { screenshot, webContentOnly, args } = observationOptions(options);
    let path;
    if (screenshot) {
      await ownedFile(async () => {
        if (!directory) directory = await realpath(await mkdtemp(join(tmpdir(), CAPTURE_PREFIX)));
        else if (await realpath(directory) !== directory) throw new Error('Owned capture directory moved.');
      });
      // Journal the directory before any capture can land in it; a failed record retries next capture.
      if (recorded !== directory) {
        await driver.recordOwnership({ target: { pid, windowId }, captureDirectory: directory });
        recorded = directory;
      }
      path = join(directory, `${randomUUID()}.png`);
      args.screenshot_out_file = path;
    }
    const reply = await driver.call('get_window_state', { ...args, pid, window_id: windowId });
    const observedAt = Date.now(), capturedAt = performance.now();
    requireThat(reply.pid === pid && reply.window_id === windowId, 'Wrong returned native target.');
    const { state, local } = project(reply, webContentOnly);
    if (path) {
      requireThat(reply.screenshot_file_path === path && await ownedFile(() => realpath(path)) === path, 'Capture is not the owned file.');
      const bytes = await ownedFile(() => readFile(path));
      requireThat(bytes.length > 0, 'Empty capture.');
      local.screenshot = { file_path: path,
        capture_id: typeof reply.capture_id === 'string' && reply.capture_id !== '' ? reply.capture_id : null,
        width: reply.screenshot_width ?? null,
        height: reply.screenshot_height ?? null, scale: reply.screenshot_scale ?? null,
        window_bounds: reply.window_bounds ? pick(reply.window_bounds, ['x', 'y', 'width', 'height']) : null,
        frame_valid: reply.screenshot_frame_valid ?? null, byte_length: bytes.length,
        sha256: createHash('sha256').update(bytes).digest('hex') };
    }
    const observation = freeze({ id: `${driver.session}/${pid}/${windowId}/${instance}/${generation}/${reply.snapshot_id ?? 'capture'}`,
      observedAt, state, local });
    current = { observation, capturedAt, generation, settled: false };
    issued.add(observation);
    return observation;
  }
  async function settle(options = {}) {
    record(options);
    const { ready, maxMs = 5000, intervalMs = 100, stableForMs = 600, signal, ...readOptions } = options;
    invalidate();
    requireThat(typeof ready === 'function' && [maxMs, intervalMs, stableForMs].every(value =>
      Number.isFinite(value) && value >= 0 && value <= 2 ** 31 - 1) && intervalMs > 0 && stableForMs > 0 &&
      (signal === undefined || typeof signal?.aborted === 'boolean') && readOptions.screenshot !== false, 'Invalid settle options.');
    observationOptions({ ...readOptions, screenshot: true });
    const deadline = performance.now() + maxMs;
    let observation = null, samples = 0, previous = null, quietSince = 0;
    const finish = status => ({ status, observation, samples });
    for (;;) {
      if (signal?.aborted) return finish('cancelled');
      if (performance.now() >= deadline) return finish('timeout');
      observation = await capture({ ...readOptions, screenshot: true });
      samples += 1;
      if (signal?.aborted) return finish('cancelled');
      if (performance.now() >= deadline) return finish('timeout');
      const sampleAt = current.capturedAt;
      const readyNow = await ready(observation) === true;
      const now = performance.now();
      if (signal?.aborted) return finish('cancelled');
      if (now >= deadline) return finish('timeout');
      const frame = geometry(observation.local.screenshot);
      const key = readyNow && frame !== null ? JSON.stringify([pid, windowId,
        observation.state.app_name ?? null, observation.state.window_title ?? null,
        frame, observation.local.screenshot.sha256]) : null;
      if (key !== null && key === previous && sampleAt - quietSince >= stableForMs) {
        current.settled = true;
        return finish('settled');
      }
      if (key === null || key !== previous) quietSince = sampleAt;
      previous = key;
      await delay(Math.min(intervalMs, Math.max(0, deadline - performance.now())));
    }
  }
  async function execute(candidate, observation) {
    try {
      requireThat(active && current?.observation === observation && current.generation === generation &&
        performance.now() - current.capturedAt <= maxAgeMs && Date.now() - observation.observedAt >= 0 &&
        Date.now() - observation.observedAt <= maxAgeMs, 'Observation is stale or foreign.');
      const { tool, args } = record(record(candidate).action);
      requireThat(own(ACTION_FIELDS, tool), 'Unsupported native action.');
      record(args);
      requireThat(Object.keys(args).every(key => ACTION_FIELDS[tool].has(key) ||
        key === 'pid' || key === 'window_id' || (key === 'delivery_mode' && tool !== 'set_value')) &&
        (!own(args, 'pid') || args.pid === pid) && (!own(args, 'window_id') || args.window_id === windowId), 'Mismatched action scope or unsupported arguments.');
      const mode = args.delivery_mode ?? 'background';
      requireThat(mode === 'background' || (mode === 'foreground' && foreground), 'Foreground delivery is not enabled.');
      const hasElement = own(args, 'element_token');
      const pixels = own(args, 'x') || own(args, 'y');
      const pixelClick = tool === 'click' && !hasElement;
      const image = observation.local.screenshot;
      if (hasElement) {
        requireThat(!pixels && !own(args, 'capture_id'), 'Mixed AX and pixel addressing.');
        const token = args.element_token;
        const matches = typeof token === 'string'
          ? observation.local.elements.filter(element => element.element_token === token) : [];
        requireThat(matches.length === 1 && matches[0].enabled !== false, 'AX identity is not current.');
        if (tool === 'click') requireThat(mode === 'background' && (args.button ?? 'left') === 'left' &&
          (args.count ?? 1) === 1 && Array.isArray(matches[0].actions) &&
          matches[0].actions.includes('AXPress'), 'AX click requires advertised AXPress.');
      } else if (pixelClick) {
        requireThat(pixels && current.settled && geometry(image) !== null && Number.isFinite(args.x) &&
          Number.isFinite(args.y) && args.x >= 0 && args.y >= 0 && args.x < image.width && args.y < image.height,
        'Pixels require a current settled capture and in-bounds coordinates.');
        requireThat(typeof image.capture_id === 'string' &&
          (!own(args, 'capture_id') || args.capture_id === image.capture_id), 'Pixels require the native capture_id.');
      } else requireThat(tool !== 'set_value', 'set_value requires a current AX identity.');
      if (tool === 'click') requireThat((!own(args, 'button') || ['left', 'right', 'middle'].includes(args.button)) &&
        (!own(args, 'count') || positiveInteger(args.count)), 'Invalid click arguments.');
      if (tool === 'set_value') requireThat(typeof args.value === 'string', 'set_value requires a string.');
      if (tool === 'type_text') requireThat(typeof args.text === 'string', 'type_text requires text.');
      if (tool === 'press_key') requireThat(typeof args.key === 'string' && args.key.length > 0, 'press_key requires a key.');
      const request = { ...args, pid, window_id: windowId };
      if (tool !== 'set_value') request.delivery_mode = mode;
      if (pixelClick) {
        request.capture_id = image.capture_id;
        await guardPixel(image, args.x, args.y, mode);
      }
      const receipt = await driver.call(tool, request);
      requireThat(!pixelClick || receipt.route !== 'accessibility', 'Pixel click was routed to accessibility.',
        true, 'pixel_routed_to_accessibility');
      const eventRoute = mode === 'foreground' ? 'global_input' : 'synthetic_events';
      const axOnly = tool === 'set_value' || (tool === 'click' && hasElement);
      const routeAccepted = axOnly ? receipt.route === 'accessibility'
        : receipt.route === eventRoute || (!pixelClick && tool !== 'press_key' && receipt.route === 'accessibility');
      const evidence = receipt.evidence;
      const validEvidence = Array.isArray(evidence) && evidence.length > 0 && evidence.every(item =>
        item && Object.keys(item).length === 1 && ['value_readback', 'window_change'].includes(item.kind));
      requireThat(routeAccepted && receipt.delivery?.mode === mode &&
        (receipt.effect === 'unverifiable' || (receipt.effect === 'confirmed' && validEvidence)),
      'Native delivery was not confirmed.', true);
      if (tool === 'type_text' && (receipt.route !== 'accessibility' || own(receipt.delivery, 'delivered_count'))) {
        let count = 0;
        for (const character of request.text) count += 1;
        requireThat(receipt.delivery.delivered_count === count, 'Native typing was partial.', true);
      }
      if (pixelClick) {
        const { windows } = await guardRead(() => driver.listWindows(pid), true, 'guard_unavailable_after_dispatch');
        const matches = windows.filter(window => window.window_id === windowId);
        requireThat(matches.length === 1 && sameBounds(matches[0].bounds, image.window_bounds),
          'Target window moved during dispatch.', true, 'target_moved_during_dispatch');
      }
      const projected = { ...receipt };
      delete projected.summary;
      return freeze(projected);
    } finally { invalidate(); }
  }
  // Pre-dispatch pixel guard: exact bounds; foreground adds the main display and z-order at the screen point.
  async function guardPixel(image, x, y, mode) {
    const bounds = image.window_bounds;
    const { windows } = await guardRead(() => driver.listWindows(pid));
    const matches = windows.filter(window => window.window_id === windowId);
    requireThat(matches.length === 1, 'Target window is missing.', false, 'target_missing');
    const now = matches[0].bounds;
    requireThat(sameBounds(now, bounds), 'Target window moved.', false, 'target_moved');
    if (mode !== 'foreground') return;
    // Capture pixels per point come from width/bounds, never screenshot scale. The capture's and the current
    // bounds may differ within tolerance, so both derived points must pass.
    const points = [bounds, now].map(frame =>
      [frame.x + x * frame.width / image.width, frame.y + y * frame.height / image.height]);
    const display = await guardRead(() => driver.screenSize());
    // Global input clamps off-display points onto whatever is there; only the main display is addressable.
    requireThat(points.every(([px, py]) => px >= 0 && px < display.width && py >= 0 && py < display.height),
      'Target point is off the main display.', false, 'target_offscreen');
    const screen = await guardRead(() => driver.listOnScreenWindows());
    const targets = screen.filter(window => window.window_id === windowId);
    requireThat(targets.length === 1 && targets[0].pid === pid, 'Target window is missing.', false, 'target_missing');
    const z = targets[0].z_index;
    // Only the Driver's own click-through overlay is exempt: driver_owned literally true AND covering the whole
    // main display. Driver-owned cards (approvals), however large, and unknown ownership still occlude.
    const mainDisplay = { x: 0, y: 0, width: display.width, height: display.height };
    const overlay = window => window.driver_owned === true && containsBounds(window.bounds, mainDisplay);
    requireThat(screen.every(window => window.window_id === windowId || overlay(window) ||
      points.every(([px, py]) => !containsPoint(window.bounds, px, py)) ||
      (Number.isInteger(window.z_index) && Number.isInteger(z) && window.z_index < z)),
    'Target point is occluded.', false, 'target_occluded');
  }
  async function verify(options) {
    invalidate();
    requireThat(active, 'Session is not active.');
    record(options);
    requireThat(Object.keys(options).every(key => VERIFY_FIELDS.has(key)), 'Unknown verify option.');
    const { expect, timeoutMs = 5000, stableSamples = 2 } = options;
    // Native verify_state limits: 1-8 predicates, timeout_ms 0-10000, stable_samples 1-5.
    requireThat(Array.isArray(expect) && !isProxy(expect) && expect.length > 0 && expect.length <= 8 &&
      Number.isSafeInteger(timeoutMs) && timeoutMs >= 0 && timeoutMs <= 10000 &&
      positiveInteger(stableSamples) && stableSamples <= 5, 'Invalid verify options.');
    const requested = expect.length;
    const reply = await driver.call('verify_state', {
      pid, window_id: windowId, expect, timeout_ms: timeoutMs, stable_samples: stableSamples,
    });
    requireThat(Array.isArray(reply.predicates), 'Malformed verification receipt.');
    const seen = new Set();
    const predicates = reply.predicates.map(item => {
      requireThat(item !== null && typeof item === 'object' && Number.isSafeInteger(item.index) && item.index >= 0 &&
        item.index < requested && !seen.has(item.index), 'Malformed verification receipt.');
      seen.add(item.index);
      const predicate = { index: item.index, status: VERIFY_STATUSES.has(item.status) ? item.status : 'unknown' };
      if (typeof item.unknown_reason === 'string' && REASON_CODE.test(item.unknown_reason)) {
        predicate.unknownReason = item.unknown_reason;
      }
      return predicate;
    });
    // Satisfied only as the literal native status with every requested predicate satisfied.
    const satisfied = reply.status === 'satisfied' && seen.size === requested &&
      predicates.every(predicate => predicate.status === 'satisfied');
    return freeze({
      status: satisfied ? 'satisfied' : reply.status === 'unsatisfied' ? 'unsatisfied' : 'unknown',
      stable: typeof reply.stable === 'boolean' ? reply.stable : null,
      samples: Number.isSafeInteger(reply.samples) && reply.samples >= 0 ? reply.samples : null,
      elapsedMs: Number.isFinite(reply.elapsed_ms) && reply.elapsed_ms >= 0 ? reply.elapsed_ms : null,
      predicates,
    });
  }
  async function regions(observation, options) {
    requireThat(active && issued.has(observation), 'Observation is not owned by this target.');
    const image = observation.local.screenshot;
    requireThat(image !== undefined, 'Observation has no owned capture.');
    record(options);
    // Decode the hashed bytes themselves; the file is never read again.
    const decoded = decodePng(await ownedBytes(image));
    requireThat(decoded.width === image.width && decoded.height === image.height, 'Capture dimensions do not match.');
    return freeze({ ...findRegions(decoded, options), capture_id: image.capture_id,
      width: decoded.width, height: decoded.height });
  }
  async function visualRegions(observation, options = {}) {
    requireThat(active && current !== null && current.observation === observation && current.generation === generation,
      'Observation is stale or foreign.');
    const image = observation.local.screenshot;
    requireThat(image !== undefined && typeof image.capture_id === 'string' &&
      positiveInteger(image.width) && positiveInteger(image.height), 'Observation has no native capture.');
    const parseOptions = visualOptions(options);
    const request = { capture_id: image.capture_id };
    if (Object.keys(parseOptions).length > 0) request.options = parseOptions;
    await ownedBytes(image);
    const reply = await guardRead(() => driver.call('parse_visual_regions', request, { timeoutMs: PARSE_TIMEOUT_MS }),
      false, 'visual_regions_unavailable', 'Visual regions are unavailable.');
    let visual;
    // The receipt is untrusted; projectParse detail is not surfaced.
    try { visual = projectParse(reply); }
    catch { requireThat(false, 'Malformed visual regions receipt.'); }
    requireThat(visual.capture_id === image.capture_id && visual.source?.kind === 'window' &&
      visual.source.pid === pid && visual.source.window_id === windowId &&
      visual.width === image.width && visual.height === image.height && visual.sha256 === image.sha256,
    'Visual regions do not match the capture.');
    // Bounds stay capture PNG pixels; the Driver applies any affine itself at click admission.
    return freeze(pick(visual, VISUAL_RESULT_FIELDS));
  }
  return Object.freeze({
    session: driver.session, pid, windowId,
    start() { return operate(async () => {
      invalidate();
      if (lifecycle === 'new') lifecycle = 'attempted';
      const receipt = await driver.start();
      await driver.recordOwnership({ target: { pid, windowId } });
      active = true;
      return receipt;
    }); },
    resume() { return operate(async () => {
      invalidate();
      const first = lifecycle === 'new';
      if (first) lifecycle = 'attempted';
      let receipt;
      // get_session is read-only: a refused first resume adopted nothing, so end() has no session to close.
      try { receipt = await driver.resume(); }
      catch (error) { if (first) lifecycle = 'unadopted'; throw error; }
      if (journalPath !== undefined) {
        let entry;
        try { entry = await readEntry(journalPath, driver.session); }
        catch { requireThat(false, 'Journal entry is unreadable.'); }
        // Adopt only the shared owned-capture rule's canonical spelling, never a symlink alias.
        // The adopted directory is already journaled; end() removes it with later captures.
        const candidate = entry?.captureDirectory;
        if (candidate !== undefined && await ownedCaptureDirectory(candidate) === candidate) {
          directory = recorded = candidate;
        }
      }
      await driver.recordOwnership({ target: { pid, windowId } });
      active = true;
      return receipt;
    }); },
    end() { return operate(async () => {
      invalidate(); active = false;
      requireThat(endReceipt === null || directory !== null, 'Session is already ended.');
      let receipt = endReceipt, failure;
      try { if (receipt === null && lifecycle !== 'unadopted') { receipt = await driver.end(); endReceipt = receipt; } }
      catch (error) { failure = error; }
      try { if (directory) { await ownedFile(() => rm(directory, { recursive: true, force: true })); directory = null; } }
      catch (error) { failure ??= error; }
      if (failure) throw failure;
      return receipt;
    }); },
    focus() { return operate(async () => {
      invalidate();
      requireThat(active && foreground, 'Explicit foreground focus is not enabled.');
      return driver.bringToFront({ pid, window_id: windowId });
    }); },
    observe(options = {}) { return operate(() => capture(options)); },
    settle(options) { return operate(() => settle(options)); },
    verify(options) { return operate(() => verify(options)); },
    regions(observation, options) { return operate(() => regions(observation, options)); },
    visualRegions(observation, options) { return operate(() => visualRegions(observation, options)); },
    execute(candidate, observation) { return operate(() => execute(candidate, observation)); },
  });
}
