import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { isProxy } from 'node:util/types';
import { createCuaDriver } from './cua-driver.mjs';

const positiveInteger = value => Number.isSafeInteger(value) && value > 0;
const own = (value, key) => Object.hasOwn(value, key);
const ELEMENT_FIELDS = ['element_index', 'role', 'label', 'value', 'value_description',
  'min', 'max', 'enabled', 'selected', 'actions', 'in_web_content', 'parent_index', 'depth'];
const LOCAL_ELEMENT_FIELDS = [...ELEMENT_FIELDS, 'element_token', 'frame'];
const OBSERVE_FIELDS = new Set(['screenshot', 'webContentOnly', 'include_accessibility_tree',
  'query', 'max_elements', 'max_depth', 'max_dimension']);
const ACTION_FIELDS = {
  click: new Set(['element_token', 'element_index', 'snapshot_id', 'x', 'y', 'button', 'count']),
  set_value: new Set(['element_token', 'element_index', 'snapshot_id', 'value']),
  type_text: new Set(['text', 'element_token', 'element_index', 'snapshot_id']),
  press_key: new Set(['key', 'element_token', 'element_index', 'snapshot_id']),
};
function requireThat(condition, message, unknownOutcome = false) {
  if (!condition) throw Object.assign(new Error(`Native target: ${message}`), {
    code: 'NATIVE_TARGET_ERROR', unknownOutcome,
  });
}
async function ownedFile(operation) {
  try { return await operation(); }
  catch { requireThat(false, 'Owned capture file operation failed.'); }
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
    max_elements = 2000, max_depth = 25, max_dimension, query } = options;
  requireThat([screenshot, webContentOnly, include_accessibility_tree].every(value => typeof value === 'boolean') &&
    (screenshot || include_accessibility_tree), 'Invalid observation mode.');
  requireThat(positiveInteger(max_elements) && max_elements <= 2000 && positiveInteger(max_depth) && max_depth <= 25 &&
    (max_dimension === undefined || positiveInteger(max_dimension)) &&
    (query === undefined || typeof query === 'string'), 'Invalid bounded AX options.');
  return { screenshot, webContentOnly, args: { include_accessibility_tree, include_screenshot: false,
    max_elements, max_depth, ...pick(options, ['max_dimension', 'query']) } };
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
 * binary/session/timeoutMs pass to createCuaDriver. Start once, always end in
 * finally even after uncertain start. End removes only this helper's captures,
 * never closes the existing app. Driver errors pass through unchanged.
 *
 * observe({screenshot=false,webContentOnly=true,include_accessibility_tree=true,
 * max_elements=2000,max_depth=25,query?,max_dimension?}) returns frozen plain JSON
 * {id,observedAt,state,local}. state holds compact AX fields and coverage, with
 * unknown completeness/truncation as null. local retains exact pid/window_id,
 * snapshot_id when present, elements with element_token/frame, and screenshot
 * {file_path,width,height,scale,window_bounds,frame_valid,byte_length,sha256}.
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
 * IDs and settling are local evidence, not native capture binding. Serialize
 * all work for this window, including calls through other driver instances.
 *
 * execute({action:{tool,args}}, observation) supports native click, set_value,
 * type_text, press_key. It supplies exact pid/window_id; mismatched scope is
 * rejected. AX targets require a current token or exact snapshot_id/index pair.
 * Pixel x/y use returned PNG pixels unchanged, never multiplied by scale.
 * delivery_mode defaults background; foreground requires explicit opt-in here
 * AND in the candidate. set_value has no delivery_mode argument. AX clicks are
 * single left AXPress only. Pixel clicks may specify button/count. type_text
 * takes text; press_key takes key; both may carry a current AX identity. Other
 * native arguments are intentionally unsupported. Native pixel hit-testing and
 * typing can themselves choose AX or event delivery. The helper never retries
 * or chooses another tool/route. Confirmed receipts require native evidence;
 * event typing requires a full Unicode scalar count. Atomic AX typing may omit
 * the count, but any supplied count must be full. Typing inserts, not replaces.
 * Delivery is not completion: runBounded callers must independently verify the
 * exact application postcondition, including field value after either typing
 * route. Foreground receipts do not prove focus; use focus before observing.
 */
export function createNativeTarget(options = {}) {
  record(options);
  const { pid, windowId, foreground = false, maxAgeMs = 15000 } = options;
  requireThat(positiveInteger(pid) && positiveInteger(windowId) && typeof foreground === 'boolean' &&
    Number.isFinite(maxAgeMs) && maxAgeMs >= 0, 'Invalid target options.');
  const driver = createCuaDriver(pick(options, ['binary', 'session', 'timeoutMs']));
  const instance = randomUUID();
  let busy = false, active = false, generation = 0, current = null, directory = null, endReceipt = null;
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
        if (!directory) directory = await mkdtemp(join(tmpdir(), 'omp-cua-jev-native-'));
        directory = await realpath(directory);
      });
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
      local.screenshot = { file_path: path, width: reply.screenshot_width ?? null,
        height: reply.screenshot_height ?? null, scale: reply.screenshot_scale ?? null,
        window_bounds: reply.window_bounds ? pick(reply.window_bounds, ['x', 'y', 'width', 'height']) : null,
        frame_valid: reply.screenshot_frame_valid ?? null, byte_length: bytes.length,
        sha256: createHash('sha256').update(bytes).digest('hex') };
    }
    const observation = freeze({ id: `${driver.session}/${pid}/${windowId}/${instance}/${generation}/${reply.snapshot_id ?? 'capture'}`,
      observedAt, state, local });
    current = { observation, capturedAt, generation, settled: false };
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
      const hasElement = ['element_token', 'element_index', 'snapshot_id'].some(key => own(args, key));
      const pixels = own(args, 'x') || own(args, 'y');
      if (hasElement) {
        requireThat(!pixels, 'Mixed AX and pixel addressing.');
        const matches = observation.local.elements.filter(element =>
          (own(args, 'element_token') ? typeof args.element_token === 'string' && element.element_token === args.element_token
            : own(args, 'snapshot_id') && args.snapshot_id === observation.local.snapshot_id &&
              Number.isSafeInteger(args.element_index) && element.element_index === args.element_index));
        requireThat(matches.length === 1 && matches[0].enabled !== false &&
          (!own(args, 'element_index') || args.element_index === matches[0].element_index) &&
          (!own(args, 'snapshot_id') || args.snapshot_id === observation.local.snapshot_id), 'AX identity is not current.');
        if (tool === 'click') requireThat(mode === 'background' && (args.button ?? 'left') === 'left' &&
          (args.count ?? 1) === 1 && Array.isArray(matches[0].actions) &&
          matches[0].actions.includes('AXPress'), 'AX click requires advertised AXPress.');
      } else if (tool === 'click') {
        const image = observation.local.screenshot;
        requireThat(pixels && current.settled && geometry(image) !== null && Number.isFinite(args.x) &&
          Number.isFinite(args.y) && args.x >= 0 && args.y >= 0 && args.x < image.width && args.y < image.height,
        'Pixels require a current settled capture and in-bounds coordinates.');
      } else requireThat(tool !== 'set_value', 'set_value requires a current AX identity.');
      if (tool === 'click') requireThat((!own(args, 'button') || ['left', 'right', 'middle'].includes(args.button)) &&
        (!own(args, 'count') || positiveInteger(args.count)), 'Invalid click arguments.');
      if (tool === 'set_value') requireThat(typeof args.value === 'string', 'set_value requires a string.');
      if (tool === 'type_text') requireThat(typeof args.text === 'string', 'type_text requires text.');
      if (tool === 'press_key') requireThat(typeof args.key === 'string' && args.key.length > 0, 'press_key requires a key.');
      const request = { ...args, pid, window_id: windowId };
      if (tool !== 'set_value') request.delivery_mode = mode;
      const receipt = await driver.call(tool, request);
      const eventRoute = mode === 'foreground' ? 'global_input' : 'synthetic_events';
      const axOnly = tool === 'set_value' || (tool === 'click' && hasElement);
      const routeAccepted = axOnly ? receipt.route === 'accessibility'
        : receipt.route === eventRoute || (tool !== 'press_key' && receipt.route === 'accessibility');
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
      return receipt;
    } finally { invalidate(); }
  }
  return Object.freeze({
    session: driver.session, pid, windowId,
    start() { return operate(async () => { invalidate(); const receipt = await driver.start(); active = true; return receipt; }); },
    end() { return operate(async () => {
      invalidate(); active = false;
      requireThat(endReceipt === null || directory !== null, 'Session is already ended.');
      let receipt = endReceipt, failure;
      try { if (receipt === null) { receipt = await driver.end(); endReceipt = receipt; } }
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
    execute(candidate, observation) { return operate(() => execute(candidate, observation)); },
  });
}
