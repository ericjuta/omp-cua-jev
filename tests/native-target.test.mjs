import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash, randomUUID } from 'node:crypto';
import { chmod, lstat, mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { JOURNAL_SCHEMA, journalDirectory, readEntry, writeEntry } from '../src/journal.mjs';
import { createNativeTarget } from '../src/native-target.mjs';
import { runBounded } from '../src/jev-loop.mjs';

// Cua Driver's daemon status text: the on-screen window view marks this pid's windows driver_owned.
const daemonStatus = { stdout: 'Cua Driver daemon is running\n  pid: 999\n', exitCode: 0 };

async function createFixture(t, steps, options = {}, status = daemonStatus) {
  // Not the owned-capture prefix: a journaled path to this directory must never look adoptable.
  const directory = await mkdtemp(join(tmpdir(), 'omp-cua-jev-fixture-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  // Every journal entry stays inside this fixture, never in the user's state directory.
  const previousState = process.env.OMP_CUA_JEV_STATE_DIR;
  const stateDirectory = join(directory, 'state');
  await mkdir(stateDirectory, { mode: 0o700 });
  process.env.OMP_CUA_JEV_STATE_DIR = stateDirectory;
  t.after(() => {
    if (previousState === undefined) delete process.env.OMP_CUA_JEV_STATE_DIR;
    else process.env.OMP_CUA_JEV_STATE_DIR = previousState;
  });
  const executable = join(directory, 'driver.mjs');
  const log = join(directory, 'dispatch.json');
  await writeFile(log, '[]', { mode: 0o600 });
  await writeFile(executable, `#!${process.execPath}
import { readFileSync, writeFileSync } from 'node:fs';
const log = ${JSON.stringify(log)};
const steps = ${JSON.stringify(steps)};
const status = ${JSON.stringify(status)};
const [command, tool, json] = process.argv.slice(2);
if (command === 'status') {
// The Driver's daemon-pid probe for window ownership is not a call dispatch step.
process.stdout.write(status.stdout);
process.exitCode = status.exitCode;
} else {
const dispatches = JSON.parse(readFileSync(log, 'utf8'));
// Settlement may consume only a prefix of finite capture receipts before cleanup.
const step = tool === 'end_session'
  ? steps.filter(value => value.tool === 'end_session')[dispatches.filter(value => value.tool === 'end_session').length]
  : steps[dispatches.length];
const entry = { command, tool, args: JSON.parse(json), startedAt: Date.now() };
dispatches.push(entry);
writeFileSync(log, JSON.stringify(dispatches));
if (command !== 'call' || !step || tool !== step.tool) throw new Error('Unexpected fixture dispatch.');
if (step.delayMs) await new Promise(resolve => setTimeout(resolve, step.delayMs));
if (step.screenshotBytes !== undefined) {
  if (typeof entry.args.screenshot_out_file !== 'string') throw new Error('Missing owned screenshot path.');
  writeFileSync(entry.args.screenshot_out_file, Buffer.from(step.screenshotBytes, 'base64'));
  step.receipt.screenshot_file_path ??= entry.args.screenshot_out_file;
}
entry.finishedAt = Date.now();
writeFileSync(log, JSON.stringify(dispatches));
process.stdout.write(step.stdout ?? JSON.stringify(step.receipt));
if (step.stderr !== undefined) process.stderr.write(step.stderr);
process.exitCode = step.exitCode ?? 0;
}
`, { mode: 0o700 });
  const createTarget = () => createNativeTarget({ pid: 4107, windowId: 71, session: 'owned-native', ...options, binary: executable });
  return {
    directory,
    executable,
    target: createTarget(),
    createTarget,
    invocations: async () => JSON.parse(await readFile(log, 'utf8')),
    dispatches: async () => JSON.parse(await readFile(log, 'utf8')).map(({ command, tool, args }) => ({ command, tool, args })),
  };
}

async function rejectsWithoutDispatch(fixture, operation, code = 'NATIVE_TARGET_ERROR') {
  const before = await fixture.dispatches();
  await assert.rejects(operation, { code, unknownOutcome: false });
  assert.deepEqual(await fixture.dispatches(), before);
}

// Guard refusals may read windows first; they must never dispatch a click.
async function refusesWithoutClick(fixture, operation, reason) {
  const clicks = async () => (await fixture.dispatches()).filter(call => call.tool === 'click').length;
  const before = await clicks();
  await assert.rejects(operation, { code: 'NATIVE_TARGET_ERROR', unknownOutcome: false, reason });
  assert.equal(await clicks(), before);
}

async function settleNow(target) {
  const result = await target.settle({ ready: () => true, stableForMs: 1, intervalMs: 2, maxMs: 10000 });
  assert.equal(result.status, 'settled');
  assert.equal(result.samples, 2);
  return result.observation;
}

const start = { tool: 'start_session', receipt: { session: 'owned-native', active: true } };
const end = { tool: 'end_session', receipt: { session: 'owned-native', active: false } };
const axDelivered = { effect: 'unverifiable', route: 'accessibility', delivery: { mode: 'background' } };
const save = { id: 'save', description: 'Save one receipt', action: { tool: 'click', args: { element_token: 'save-token' } } };
const pixel = { id: 'pixel', description: 'Click captured pixel', action: { tool: 'click', args: { x: 5, y: 3 } } };
const pixelDelivered = { effect: 'unverifiable', route: 'synthetic_events', delivery: { mode: 'background' } };
const foregroundPixel = { action: { tool: 'click', args: { x: 5, y: 3, delivery_mode: 'foreground' } } };
const foregroundDelivered = { effect: 'unverifiable', route: 'global_input', delivery: { mode: 'foreground' } };
const targetBounds = { x: 100, y: 200, width: 3, height: 2 };
const sessionReceipt = {
  session: 'owned-native', state: 'active', idle_seconds: 4, expires_in_seconds: 295, client_kind: 'cli', implicit: false,
};
const getSession = { tool: 'get_session', receipt: sessionReceipt };
// Independent six-by-four RGB PNGs. No production encoder or dimensions are imported.
const frameA = 'iVBORw0KGgoAAAANSUhEUgAAAAYAAAAECAIAAAAiZtkUAAAAEklEQVR4nGP4z8CAhtD5RAsBAKTRF+lZezHiAAAAAElFTkSuQmCC';
const frameB = 'iVBORw0KGgoAAAANSUhEUgAAAAYAAAAECAIAAAAiZtkUAAAAEElEQVR4nGNgYPiPgcgUAgB1ARfpnAW9rgAAAABJRU5ErkJggg==';
// Six-by-four RGB PNG: red, with a blue 3x1 bar at x=2..4,y=1 and one blue pixel at (0, 3).
const frameSeats = 'iVBORw0KGgoAAAANSUhEUgAAAAYAAAAECAIAAAAiZtkUAAAAGElEQVR42mP4z8CAhmAUTAQhhKIKIoOMAJzZF+luYFEKAAAAAElFTkSuQmCC';
// Same byte length and size as frameSeats, but its lone blue pixel is at (5, 2).
const frameSeatsMoved = 'iVBORw0KGgoAAAANSUhEUgAAAAYAAAAECAIAAAAiZtkUAAAAGElEQVR42mP4z8CAhmAUTAQh9B9ZDlMjAJzZF+lNxamkAAAAAElFTkSuQmCC';

function windowState(overrides = {}) {
  return {
    pid: 4107, window_id: 71, snapshot_id: 'native-1',
    app_name: 'Synthetic app', window_title: 'Receipt form',
    elements_complete: false, element_count: 1,
    elements: [{
      element_index: 1, element_token: 'save-token', role: 'AXButton', label: 'Save receipt',
      enabled: true, actions: ['AXPress'], in_web_content: true,
      frame: { x: 100, y: 200, w: 3, h: 2 },
    }],
    ...overrides,
  };
}

let captureCount = 0;
// Each native capture has its own single-use ID; pass { capture_id: undefined } to omit it.
function captureStep(bytes = frameA, overrides = {}, delayMs = 0) {
  captureCount += 1;
  return {
    tool: 'get_window_state', delayMs, screenshotBytes: bytes,
    receipt: windowState({
      capture_id: `capture-${captureCount}`, screenshot_width: 6, screenshot_height: 4, screenshot_scale: 2,
      screenshot_frame_valid: true, window_bounds: { ...targetBounds },
      ...overrides,
    }),
  };
}

const sha256 = base64 => createHash('sha256').update(Buffer.from(base64, 'base64')).digest('hex');

// A Driver 0.31 + cua-perception 0.2.1 cua.visual_regions_v1 receipt for one 6x4 frameSeats capture.
// The default 1568 px downscale reports an affine; edit(receipt) varies one field.
function visualStep(capture_id, edit = () => {}) {
  const hash = sha256(frameSeats);
  const receipt = {
    schema: 'cua.visual_regions_v1',
    capture: {
      capture_id, source: { kind: 'window', pid: 4107, window_id: 71 },
      screenshot: { width: 6, height: 4, mime_type: 'image/png', reference: `png-sha256:${hash}`, sha256: hash },
      action_coordinate_space: { kind: 'affine', m11: 1.632, m12: 0, m21: 0, m22: 1.63, tx: 0, ty: 0 },
    },
    parser: {
      extension_id: 'cua-perception', extension_version: '0.2.1', model_id: 'pp-ocrv5-mobile-en', model_version: '5.0',
      backend: 'onnxruntime-cpu',
    },
    regions: [
      { id: 'text-0', kind: 'text', text: 'A3', bounds: { x: 2, y: 1, width: 3, height: 1 }, confidence: 0.852, interactive: false },
      { id: 'icon-0', kind: 'icon', label: 'icon-class-0', bounds: { x: 0, y: 3, width: 1, height: 1 }, confidence: 0.41, interactive: false },
    ],
    timing: { duration_ms: 4100 },
    warnings: [{ code: 'low_resolution', message: 'Native warning text is never returned.' }],
  };
  edit(receipt);
  return { tool: 'parse_visual_regions', receipt };
}

function windowsStep(...windows) {
  return { tool: 'list_windows', receipt: { windows } };
}

// Exact-PID discovery record.
function targetWindow(overrides = {}) {
  return {
    pid: 4107, window_id: 71, is_on_screen: true, bounds: targetBounds,
    app_name: 'Synthetic app', title: 'Receipt form', ...overrides,
  };
}

// Sessionless on-screen record, shaped like Driver 0.30.2 list_windows {on_screen_only:true}.
function screenWindow(overrides = {}) {
  return {
    app_name: 'Synthetic app', bounds: targetBounds, current_space_id: 1, is_on_screen: true, layer: 0,
    on_current_space: true, pid: 4107, space_ids: [1], title: 'Receipt form', window_id: 71, z_index: 5, ...overrides,
  };
}

function otherWindow(overrides = {}) {
  return screenWindow({ app_name: 'Other app', title: 'Popover', pid: 5120, window_id: 90, ...overrides });
}

const inPlace = windowsStep(targetWindow());

// Foreground geometry: this 6x4 capture spans 3.75x2.5 points at screenshot scale 2, i.e. 1.6 capture pixels
// per point. Capture pixel (5, 3) is screen point (103.125, 201.875); dividing by the scale gives (102.5, 201.5).
const scaledBounds = { x: 100, y: 200, width: 3.75, height: 2.5 };
const scaledCapture = (bounds = scaledBounds) => captureStep(frameA, { window_bounds: { ...bounds } });
const scaledInPlace = (bounds = scaledBounds) => windowsStep(targetWindow({ bounds }));
const mainDisplay = { tool: 'get_screen_size', receipt: { width: 1920, height: 1080, scale_factor: 2 } };

const focused = {
  status: 'activated', code: 'bring_to_front_exact_window_verified', pid: 4107, window_id: 71,
  activated: true, process_activated: true, request_accepted: true,
  exact_window_effect: { verified: true, focused: true, frontmost_ordinary: true, target_visible_ordinary: true },
  observed: {
    front_process_matches_target: true, frontmost_pid: 4107, workspace_frontmost_pid: 4107,
    focused_window_id: 71, frontmost_ordinary_window_id: 71,
  },
};

test('one retained session rejects foreign native identities and never widens its target', async t => {
  const fixture = await createFixture(t, [
    start,
    { tool: 'get_window_state', receipt: windowState({ pid: 4108 }) },
    { tool: 'get_window_state', receipt: windowState({ window_id: 72 }) },
    { tool: 'get_window_state', receipt: windowState() },
    { tool: 'get_window_state', receipt: windowState() },
    { tool: 'set_value', receipt: axDelivered },
    end,
  ]);
  const { target } = fixture;
  try {
    await target.start();
    await rejectsWithoutDispatch(fixture, () => target.start(), 'CUA_DRIVER_ERROR');
    await assert.rejects(target.observe(), { code: 'NATIVE_TARGET_ERROR', unknownOutcome: false });
    await assert.rejects(target.observe(), { code: 'NATIVE_TARGET_ERROR', unknownOutcome: false });
    const observed = await target.observe();
    await rejectsWithoutDispatch(fixture, () => target.execute({
      action: { tool: 'click', args: { element_token: 'save-token', pid: 4108, window_id: 71 } },
    }, observed));
    const fresh = await target.observe();
    await target.execute({ action: { tool: 'set_value', args: { element_token: 'save-token', value: 'receipt-17' } } }, fresh);
  } finally {
    await target.end();
  }
  await rejectsWithoutDispatch(fixture, () => target.observe());
  await rejectsWithoutDispatch(fixture, () => target.start(), 'CUA_DRIVER_ERROR');
  const calls = await fixture.dispatches();
  assert.deepEqual(calls.map(call => call.tool), [
    'start_session', 'get_window_state', 'get_window_state', 'get_window_state', 'get_window_state', 'set_value', 'end_session',
  ]);
  assert.deepEqual(calls[0], { command: 'call', tool: 'start_session', args: { session: 'owned-native' } });
  for (const call of calls.slice(1, 5)) {
    assert.deepEqual(call.args, {
      include_accessibility_tree: true, include_screenshot: false, max_elements: 2000, max_depth: 25,
      pid: 4107, window_id: 71, session: 'owned-native',
    });
  }
  assert.deepEqual(calls[5].args, {
    element_token: 'save-token', value: 'receipt-17', pid: 4107, window_id: 71, session: 'owned-native',
  });
  assert.deepEqual(calls[6], { command: 'call', tool: 'end_session', args: { session: 'owned-native' } });
});

test('uncertain start still cleans up the original owned session without authorizing observation', async t => {
  const fixture = await createFixture(t, [
    { tool: 'start_session', receipt: { session: 'foreign-session', active: true } },
    end,
  ]);
  try {
    await assert.rejects(fixture.target.start(), { code: 'CUA_DRIVER_ERROR', unknownOutcome: true });
    await rejectsWithoutDispatch(fixture, () => fixture.target.observe());
    await rejectsWithoutDispatch(fixture, () => fixture.target.start(), 'CUA_DRIVER_ERROR');
  } finally {
    await fixture.target.end();
  }
  assert.deepEqual(await fixture.dispatches(), [
    { command: 'call', tool: 'start_session', args: { session: 'owned-native' } },
    { command: 'call', tool: 'end_session', args: { session: 'owned-native' } },
  ]);
});

test('foreground focus and delivery require opt-in and a rejected action consumes its evidence', async t => {
  const fixture = await createFixture(t, [start, { tool: 'get_window_state', receipt: windowState() }, end]);
  try {
    await fixture.target.start();
    await rejectsWithoutDispatch(fixture, () => fixture.target.focus());
    const observed = await fixture.target.observe();
    await rejectsWithoutDispatch(fixture, () => fixture.target.execute({
      action: { tool: 'press_key', args: { key: 'RETURN', delivery_mode: 'foreground' } },
    }, observed));
    await rejectsWithoutDispatch(fixture, () => fixture.target.execute(save, observed));
  } finally {
    await fixture.target.end();
  }
  assert.deepEqual((await fixture.dispatches()).map(call => call.tool), ['start_session', 'get_window_state', 'end_session']);
});

test('focus, a newer observation, and one dispatch each invalidate the original evidence', async t => {
  const fixture = await createFixture(t, [
    start,
    { tool: 'get_window_state', receipt: windowState() },
    { tool: 'bring_to_front', receipt: focused },
    { tool: 'get_window_state', receipt: windowState() },
    { tool: 'get_window_state', receipt: windowState() },
    { tool: 'get_window_state', receipt: windowState() },
    { tool: 'press_key', receipt: { effect: 'unverifiable', route: 'global_input', delivery: { mode: 'foreground' } } },
    end,
  ], { foreground: true });
  const { target } = fixture;
  try {
    await target.start();
    const beforeFocus = await target.observe();
    await target.focus();
    await rejectsWithoutDispatch(fixture, () => target.execute(save, beforeFocus));
    const superseded = await target.observe();
    await target.observe();
    await rejectsWithoutDispatch(fixture, () => target.execute(save, superseded));
    const fresh = await target.observe();
    const enter = { action: { tool: 'press_key', args: { key: 'RETURN', delivery_mode: 'foreground' } } };
    await target.execute(enter, fresh);
    await rejectsWithoutDispatch(fixture, () => target.execute(enter, fresh));
  } finally {
    await target.end();
  }
  const calls = await fixture.dispatches();
  assert.deepEqual(calls.map(call => call.tool), [
    'start_session', 'get_window_state', 'bring_to_front', 'get_window_state', 'get_window_state', 'get_window_state', 'press_key', 'end_session',
  ]);
  assert.deepEqual(calls[2].args, { pid: 4107, window_id: 71 });
  assert.deepEqual(calls[6].args, { key: 'RETURN', delivery_mode: 'foreground', pid: 4107, window_id: 71, session: 'owned-native' });
});

test('compact web-only evidence retains incomplete coverage and unknown element state', async t => {
  const fixture = await createFixture(t, [start, {
    tool: 'get_window_state', receipt: windowState({
      elements_complete: false, element_count: 3, total_element_count: 20, returned_element_count: 3, filtered_element_count: 2,
      elements: [
        { element_index: 0, element_token: 'toolbar-token', role: 'AXButton', label: 'Back', in_web_content: false },
        { element_index: 1, element_token: 'unknown-token', role: 'AXButton', label: 'Unknown control', in_web_content: true,
          frame: { x: 103, y: 204, w: 10, h: 12 } },
        { element_index: 2, element_token: 'disabled-token', role: 'AXButton', label: 'Disabled control', in_web_content: true,
          enabled: false, selected: false, actions: [] },
      ],
    }),
  }, { tool: 'get_window_state', receipt: { pid: 4107, window_id: 71, elements: [] } }, end]);
  try {
    await fixture.target.start();
    const observed = await fixture.target.observe({ webContentOnly: true, max_elements: 12, max_depth: 4, query: 'control' });
    assert.deepEqual(observed.state.elements, [
      { element_index: 1, role: 'AXButton', label: 'Unknown control', in_web_content: true },
      { element_index: 2, role: 'AXButton', label: 'Disabled control', in_web_content: true, enabled: false, selected: false, actions: [] },
    ]);
    assert.deepEqual(observed.state.coverage, {
      elements_complete: false, truncated: null, element_count: 3, total_element_count: 20,
      returned_element_count: 3, filtered_element_count: 2, projected_element_count: 2, omitted_element_count: 1,
    });
    assert.deepEqual(observed.local.elements[0], {
      element_index: 1, element_token: 'unknown-token', role: 'AXButton', label: 'Unknown control', in_web_content: true,
      frame: { x: 103, y: 204, w: 10, h: 12 },
    });
    const unknown = await fixture.target.observe();
    assert.deepEqual(unknown.state.coverage, {
      elements_complete: null, truncated: null, projected_element_count: 0, omitted_element_count: 0,
    });
  } finally {
    await fixture.target.end();
  }
});

test('Driver 0.31 AX actions address only the current element_token, never the index/snapshot pair', async t => {
  const legacy = [
    { tool: 'click', args: { element_index: 1, snapshot_id: 'native-1' } },
    { tool: 'click', args: { element_token: 'save-token', element_index: 1 } },
    { tool: 'set_value', args: { element_token: 'save-token', snapshot_id: 'native-1', value: 'receipt-17' } },
    { tool: 'type_text', args: { text: 'receipt-17', element_index: 1, snapshot_id: 'native-1' } },
    { tool: 'press_key', args: { key: 'RETURN', element_index: 1, snapshot_id: 'native-1' } },
  ];
  const fixture = await createFixture(t, [
    start, ...legacy.map(() => ({ tool: 'get_window_state', receipt: windowState() })),
    { tool: 'get_window_state', receipt: windowState() }, { tool: 'click', receipt: axDelivered }, end,
  ]);
  const { target } = fixture;
  try {
    await target.start();
    for (const action of legacy) {
      const observed = await target.observe();
      await rejectsWithoutDispatch(fixture, () => target.execute({ action }, observed));
    }
    assert.deepEqual(await target.execute(save, await target.observe()), axDelivered);
  } finally {
    await target.end();
  }
  assert.deepEqual((await fixture.dispatches()).filter(call => call.tool === 'click').map(call => call.args), [
    { element_token: 'save-token', pid: 4107, window_id: 71, delivery_mode: 'background', session: 'owned-native' },
  ]);
});

test('max_image_dimension admits 0 for native resolution and rejects other non-natural values', async t => {
  const fixture = await createFixture(t, [start, captureStep(), end]);
  try {
    await fixture.target.start();
    for (const max_image_dimension of [-1, 1.5, '0', null]) {
      await rejectsWithoutDispatch(fixture, () => fixture.target.observe({ screenshot: true, max_image_dimension }));
    }
    await fixture.target.observe({ screenshot: true, max_image_dimension: 0 });
  } finally {
    await fixture.target.end();
  }
  const captures = (await fixture.dispatches()).filter(call => call.tool === 'get_window_state');
  assert.deepEqual(captures.map(call => call.args.max_image_dimension), [0]);
});

test('animated A/B/B captures settle only after a measured consecutive quiet span', async t => {
  const fixture = await createFixture(t, [
    start, captureStep(frameA), captureStep(frameB), captureStep(frameB), captureStep(frameB, {}, 100), end,
  ]);
  const observed = [];
  try {
    await fixture.target.start();
    const result = await fixture.target.settle({
      stableForMs: 80, intervalMs: 2, maxMs: 10000,
      ready: observation => { observed.push(observation); return true; },
    });
    assert.equal(result.status, 'settled');
    assert.ok(result.samples >= 3 && result.samples <= 4);
    assert.equal(result.observation, observed.at(-1));
    assert.notEqual(observed[0].local.screenshot.sha256, observed[1].local.screenshot.sha256);
    assert.equal(result.observation.local.screenshot.sha256, observed[1].local.screenshot.sha256);
    assert.equal(observed.at(-2).local.screenshot.sha256, observed.at(-1).local.screenshot.sha256);
    // observedAt is the capture time, not the completion time of ready().
    assert.ok(result.observation.observedAt - observed[1].observedAt >= 78);
    assert.deepEqual(await readFile(result.observation.local.screenshot.file_path), Buffer.from(frameB, 'base64'));
    const captures = (await fixture.invocations()).filter(call => call.tool === 'get_window_state');
    assert.equal(captures.length, result.samples);
    for (let index = 1; index < captures.length; index++) {
      assert.ok(captures[index].startedAt >= captures[index - 1].finishedAt);
      assert.notEqual(captures[index].args.screenshot_out_file, captures[index - 1].args.screenshot_out_file);
    }
  } finally {
    await fixture.target.end();
  }
});

test('slow readiness does not turn an early equal capture into a full quiet interval', async t => {
  const fixture = await createFixture(t, [start, captureStep(), captureStep(), captureStep(), end]);
  const observed = [];
  try {
    await fixture.target.start();
    const result = await fixture.target.settle({
      stableForMs: 80, intervalMs: 2, maxMs: 10000,
      ready: async observation => {
        observed.push(observation);
        if (observed.length === 2) await new Promise(resolve => setTimeout(resolve, 100));
        return true;
      },
    });
    assert.equal(result.status, 'settled');
    assert.ok(result.samples >= 2 && result.samples <= 3);
    assert.equal(result.observation, observed.at(-1));
    assert.ok(result.observation.observedAt - observed[0].observedAt >= 78);
    assert.equal((await fixture.dispatches()).filter(call => call.tool === 'get_window_state').length, result.samples);
  } finally {
    await fixture.target.end();
  }
});

test('a late capture stops at the deadline and retains no pixel authority', async t => {
  const fixture = await createFixture(t, [start, captureStep(frameA, {}, 80), captureStep(), end]);
  let readyCalls = 0;
  try {
    await fixture.target.start();
    const result = await fixture.target.settle({
      stableForMs: 10, intervalMs: 2, maxMs: 20,
      ready: () => { readyCalls += 1; return true; },
    });
    assert.equal(result.status, 'timeout');
    assert.equal(result.samples, 1);
    assert.equal(readyCalls, 0);
    assert.deepEqual(await readFile(result.observation.local.screenshot.file_path), Buffer.from(frameA, 'base64'));
    await rejectsWithoutDispatch(fixture, () => fixture.target.execute(pixel, result.observation));
    assert.equal((await fixture.dispatches()).filter(call => call.tool === 'get_window_state').length, 1);
  } finally {
    await fixture.target.end();
  }
});

test('deadline and cancellation are checked again after async readiness', async t => {
  for (const stop of ['timeout', 'cancelled']) {
    await t.test(stop, async t => {
      const fixture = await createFixture(t, [start, captureStep(), captureStep(), end]);
      const controller = new AbortController();
      let readyCalls = 0;
      try {
        await fixture.target.start();
        const result = await fixture.target.settle({
          stableForMs: 10, intervalMs: 2, maxMs: 2000, signal: controller.signal,
          ready: async () => {
            readyCalls += 1;
            if (stop === 'timeout') await new Promise(resolve => setTimeout(resolve, 2100));
            else { await Promise.resolve(); controller.abort(); }
            return true;
          },
        });
        assert.equal(readyCalls, 1);
        assert.equal(result.status, stop);
        assert.equal(result.samples, 1);
        assert.equal(result.observation.local.pid, 4107);
        await rejectsWithoutDispatch(fixture, () => fixture.target.execute(pixel, result.observation));
        assert.equal((await fixture.dispatches()).filter(call => call.tool === 'get_window_state').length, 1);
      } finally {
        await fixture.target.end();
      }
    });
  }
});

test('expired or cancelled admission captures nothing and truthy readiness cannot settle', async t => {
  const fixture = await createFixture(t, [start, captureStep(), captureStep(), captureStep(), end]);
  try {
    await fixture.target.start();
    const cancelled = new AbortController();
    cancelled.abort();
    assert.deepEqual(await fixture.target.settle({ ready: () => true, maxMs: 0 }), {
      status: 'timeout', observation: null, samples: 0,
    });
    assert.deepEqual(await fixture.target.settle({ ready: () => true, signal: cancelled.signal }), {
      status: 'cancelled', observation: null, samples: 0,
    });
    assert.equal((await fixture.dispatches()).filter(call => call.tool === 'get_window_state').length, 0);
    const controller = new AbortController();
    let seen = 0;
    const result = await fixture.target.settle({
      stableForMs: 1, intervalMs: 2, maxMs: 10000, signal: controller.signal,
      ready: () => { if (++seen === 3) controller.abort(); return 'ready'; },
    });
    assert.equal(result.status, 'cancelled');
    assert.equal(result.samples, 3);
    await rejectsWithoutDispatch(fixture, () => fixture.target.execute(pixel, result.observation));
  } finally {
    await fixture.target.end();
  }
});

test('pixels require settlement, obey actual image bounds, and are dispatched without scaling', async t => {
  const captures = Array.from({ length: 7 }, () => captureStep());
  const capture_id = captures.at(-1).receipt.capture_id;
  const fixture = await createFixture(t, [
    start, ...captures, inPlace, { tool: 'click', receipt: { ...pixelDelivered, summary: 'clicked (5, 3)' } }, inPlace, end,
  ]);
  try {
    await fixture.target.start();
    const raw = await fixture.target.observe({ screenshot: true });
    await rejectsWithoutDispatch(fixture, () => fixture.target.execute(pixel, raw));
    for (const args of [{ x: 6, y: 0 }, { x: 0, y: 4 }]) {
      const settled = await fixture.target.settle({ ready: () => true, stableForMs: 1, intervalMs: 2, maxMs: 10000 });
      assert.equal(settled.status, 'settled');
      assert.equal(settled.samples, 2);
      await rejectsWithoutDispatch(fixture, () => fixture.target.execute({ action: { tool: 'click', args } }, settled.observation));
    }
    const settled = await fixture.target.settle({ ready: () => true, stableForMs: 1, intervalMs: 2, maxMs: 10000 });
    assert.equal(settled.status, 'settled');
    assert.equal(settled.samples, 2);
    assert.deepEqual({
      width: settled.observation.local.screenshot.width,
      height: settled.observation.local.screenshot.height,
      scale: settled.observation.local.screenshot.scale,
    }, { width: 6, height: 4, scale: 2 });
    // The final settled capture binds the click, not any earlier identical capture.
    assert.equal(settled.observation.local.screenshot.capture_id, capture_id);
    assert.deepEqual(await fixture.target.execute(pixel, settled.observation), pixelDelivered);
    await rejectsWithoutDispatch(fixture, () => fixture.target.execute(pixel, settled.observation));
  } finally {
    await fixture.target.end();
  }
  const guard = { command: 'call', tool: 'list_windows', args: { pid: 4107, on_screen_only: true } };
  assert.deepEqual((await fixture.dispatches()).filter(call => call.tool !== 'get_window_state'), [
    { command: 'call', tool: 'start_session', args: { session: 'owned-native' } },
    guard,
    { command: 'call', tool: 'click', args: {
      x: 5, y: 3, pid: 4107, window_id: 71, delivery_mode: 'background', session: 'owned-native', capture_id,
    } },
    guard,
    { command: 'call', tool: 'end_session', args: { session: 'owned-native' } },
  ]);
});

test('pixel clicks require the native capture_id of the settled capture', async t => {
  const fixture = await createFixture(t, [
    start, captureStep(frameA, { capture_id: undefined }), captureStep(frameA, { capture_id: undefined }),
    captureStep(), captureStep(), end,
  ]);
  try {
    await fixture.target.start();
    const unbound = await settleNow(fixture.target);
    assert.equal(unbound.local.screenshot.capture_id, null);
    await rejectsWithoutDispatch(fixture, () => fixture.target.execute(pixel, unbound));
    const bound = await settleNow(fixture.target);
    assert.equal(typeof bound.local.screenshot.capture_id, 'string');
    await rejectsWithoutDispatch(fixture, () => fixture.target.execute({
      action: { tool: 'click', args: { x: 5, y: 3, capture_id: 'capture-foreign' } },
    }, bound));
  } finally {
    await fixture.target.end();
  }
  assert.deepEqual((await fixture.dispatches()).map(call => call.tool), [
    'start_session', 'get_window_state', 'get_window_state', 'get_window_state', 'get_window_state', 'end_session',
  ]);
});

test('pixel geometry guard refuses a missing or moved target before any click', async t => {
  const refusals = [
    ['target_missing', []],
    ['target_missing', [targetWindow({ window_id: 72 })]],
    ['target_moved', [targetWindow({ bounds: { ...targetBounds, x: 102 } })]],
    ['target_moved', [targetWindow({ bounds: { ...targetBounds, height: 4 } })]],
  ];
  // Every bounds field within one point of the capture still matches.
  const nudged = windowsStep(targetWindow({ bounds: { x: 101, y: 199, width: 4, height: 1 } }));
  const fixture = await createFixture(t, [
    start,
    ...refusals.flatMap(([, windows]) => [captureStep(), captureStep(), windowsStep(...windows)]),
    captureStep(), captureStep(), nudged, { tool: 'click', receipt: pixelDelivered }, nudged,
    end,
  ]);
  const { target } = fixture;
  try {
    await target.start();
    for (const [reason] of refusals) {
      const observation = await settleNow(target);
      await refusesWithoutClick(fixture, () => target.execute(pixel, observation), reason);
      await rejectsWithoutDispatch(fixture, () => target.execute(pixel, observation));
    }
    assert.deepEqual(await target.execute(pixel, await settleNow(target)), pixelDelivered);
  } finally {
    await target.end();
  }
  const calls = (await fixture.dispatches()).filter(call => call.tool === 'list_windows' || call.tool === 'click');
  assert.deepEqual(calls.map(call => call.tool), [
    'list_windows', 'list_windows', 'list_windows', 'list_windows', 'list_windows', 'click', 'list_windows',
  ]);
  for (const call of calls.filter(call => call.tool === 'list_windows')) {
    assert.deepEqual(call.args, { pid: 4107, on_screen_only: true });
  }
});

test('foreground pixels refuse a window over the target point but not one elsewhere or behind', async t => {
  // Contains the clicked screen point (103.125, 201.875), not the scale-derived (102.5, 201.5).
  const overPoint = { x: 103, y: 201.5, width: 1, height: 1 };
  const onTop = screenWindow({ bounds: scaledBounds });
  const refusals = [
    ['target_occluded', [onTop, otherWindow({ bounds: overPoint, z_index: 6 })]],
    ['target_occluded', [onTop, otherWindow({ bounds: overPoint, z_index: 5 })]],
    ['target_occluded', [onTop, otherWindow({ bounds: overPoint, z_index: null })]],
    ['target_missing', [otherWindow({ bounds: { x: 0, y: 0, width: 10, height: 10 } })]],
  ];
  const clear = [
    onTop,
    // Above the target and over the scale-derived point only, not the clicked point.
    otherWindow({ bounds: { x: 102, y: 201, width: 1, height: 0.75 }, z_index: 9 }),
    // Over the clicked point but behind the target.
    otherWindow({ window_id: 91, bounds: { x: 90, y: 190, width: 50, height: 50 }, z_index: 4 }),
  ];
  const clicked = scaledCapture();
  const fixture = await createFixture(t, [
    start,
    ...refusals.flatMap(([, windows]) => [scaledCapture(), scaledCapture(), scaledInPlace(), mainDisplay, windowsStep(...windows)]),
    scaledCapture(), clicked, scaledInPlace(), mainDisplay, windowsStep(...clear),
    { tool: 'click', receipt: foregroundDelivered }, scaledInPlace(),
    end,
  ], { foreground: true });
  const { target } = fixture;
  try {
    await target.start();
    for (const [reason] of refusals) {
      const observation = await settleNow(target);
      await refusesWithoutClick(fixture, () => target.execute(foregroundPixel, observation), reason);
      await rejectsWithoutDispatch(fixture, () => target.execute(foregroundPixel, observation));
    }
    await target.execute(foregroundPixel, await settleNow(target));
  } finally {
    await target.end();
  }
  const exact = { command: 'call', tool: 'list_windows', args: { pid: 4107, on_screen_only: true } };
  const size = { command: 'call', tool: 'get_screen_size', args: {} };
  const onScreen = { command: 'call', tool: 'list_windows', args: { on_screen_only: true } };
  assert.deepEqual((await fixture.dispatches()).filter(call => !['get_window_state', 'start_session', 'end_session'].includes(call.tool)), [
    ...refusals.flatMap(() => [exact, size, onScreen]),
    exact, size, onScreen,
    { command: 'call', tool: 'click', args: {
      x: 5, y: 3, delivery_mode: 'foreground', pid: 4107, window_id: 71, session: 'owned-native',
      capture_id: clicked.receipt.capture_id,
    } },
    exact,
  ]);
});

test('foreground pixels ignore only a Driver-owned overlay covering the whole main display', async t => {
  // Every record is above the target and over its clicked screen point (103.125, 201.875).
  const driverWindow = bounds => otherWindow({ pid: 999, window_id: 95, bounds, z_index: 20 });
  // Live Cua Driver overlay geometry over a 1920x1080 main display: its bottom edge meets the display's.
  const overlay = driverWindow({ x: 0, y: -360, width: 5120, height: 1440 });
  // A click landing on a Driver approval card could approve something, even a card containing the whole target.
  const card = driverWindow({ x: 103, y: 201.5, width: 40, height: 20 });
  const largeCard = driverWindow({ x: 50, y: 150, width: 400, height: 300 });
  // Each covers the point and the target but misses one display edge: the top row, or the right column.
  const belowTop = driverWindow({ x: 0, y: 1, width: 5120, height: 1439 });
  const shortOfRight = driverWindow({ x: 0, y: -360, width: 1919.5, height: 1440 });
  for (const [name, status, window, reason] of [
    ['driver-owned overlay', daemonStatus, overlay, null],
    ['overlay of another daemon', { stdout: 'Cua Driver daemon is running\n  pid: 998\n', exitCode: 0 }, overlay, 'target_occluded'],
    ['overlay of unknown ownership', { stdout: '', exitCode: 1 }, overlay, 'target_occluded'],
    ['driver-owned card over the point', daemonStatus, card, 'target_occluded'],
    ['driver-owned card containing the whole target', daemonStatus, largeCard, 'target_occluded'],
    ['driver-owned window short of the display top', daemonStatus, belowTop, 'target_occluded'],
    ['driver-owned window short of the display right', daemonStatus, shortOfRight, 'target_occluded'],
  ]) {
    await t.test(name, async t => {
      const fixture = await createFixture(t, [
        start, scaledCapture(), scaledCapture(), scaledInPlace(), mainDisplay,
        windowsStep(screenWindow({ bounds: scaledBounds }), window),
        ...(reason === null ? [{ tool: 'click', receipt: foregroundDelivered }, scaledInPlace()] : []),
        end,
      ], { foreground: true }, status);
      try {
        await fixture.target.start();
        const observation = await settleNow(fixture.target);
        if (reason === null) assert.deepEqual(await fixture.target.execute(foregroundPixel, observation), foregroundDelivered);
        else await refusesWithoutClick(fixture, () => fixture.target.execute(foregroundPixel, observation), reason);
      } finally {
        await fixture.target.end();
      }
      assert.deepEqual((await fixture.dispatches()).map(call => call.tool), [
        'start_session', 'get_window_state', 'get_window_state', 'list_windows', 'get_screen_size', 'list_windows',
        ...(reason === null ? ['click', 'list_windows'] : []), 'end_session',
      ]);
    });
  }
});

test('foreground pixels refuse a click point off the main display before reading the window stack', async t => {
  // Capture pixel (5, 3) is 3.125 points right of and 1.875 points below the window origin.
  const offscreen = [
    // OmniWM parks hidden windows far right of the display.
    { ...scaledBounds, x: 5119 },
    // x = 1920.125, just past the last display column; the scale-derived x = 1919.5 is on the display.
    { ...scaledBounds, x: 1917 },
    // y = 1080 exactly: the display's bottom edge is outside it.
    { ...scaledBounds, y: 1078.125 },
    { ...scaledBounds, y: -10 },
  ];
  // Partly off the left edge, but the clicked point (0.125, 201.875) is on the display.
  const partlyOff = { ...scaledBounds, x: -3 };
  const fixture = await createFixture(t, [
    start,
    ...offscreen.flatMap(bounds => [scaledCapture(bounds), scaledCapture(bounds), scaledInPlace(bounds), mainDisplay]),
    scaledCapture(partlyOff), scaledCapture(partlyOff), scaledInPlace(partlyOff), mainDisplay,
    windowsStep(screenWindow({ bounds: partlyOff })), { tool: 'click', receipt: foregroundDelivered }, scaledInPlace(partlyOff),
    end,
  ], { foreground: true });
  const { target } = fixture;
  try {
    await target.start();
    for (let index = 0; index < offscreen.length; index++) {
      const observation = await settleNow(target);
      await refusesWithoutClick(fixture, () => target.execute(foregroundPixel, observation), 'target_offscreen');
    }
    assert.deepEqual(await target.execute(foregroundPixel, await settleNow(target)), foregroundDelivered);
  } finally {
    await target.end();
  }
  assert.deepEqual((await fixture.dispatches()).map(call => call.tool).filter(tool => tool !== 'get_window_state'), [
    'start_session',
    ...offscreen.flatMap(() => ['list_windows', 'get_screen_size']),
    'list_windows', 'get_screen_size', 'list_windows', 'click', 'list_windows',
    'end_session',
  ]);
});

test('unreadable pixel guards refuse before the click and are an unknown outcome after it', async t => {
  const refused = tool => ({ tool, stdout: JSON.stringify({ code: 'permissions_pending', effect: 'refused' }), exitCode: 1 });
  const fixture = await createFixture(t, [
    start,
    scaledCapture(), scaledCapture(), refused('list_windows'),
    scaledCapture(), scaledCapture(), scaledInPlace(), { tool: 'get_screen_size', stdout: '', exitCode: 1 },
    scaledCapture(), scaledCapture(), scaledInPlace(), mainDisplay, refused('list_windows'),
    scaledCapture(), scaledCapture(), scaledInPlace(), mainDisplay, windowsStep(screenWindow({ bounds: scaledBounds })),
    { tool: 'click', receipt: foregroundDelivered }, refused('list_windows'),
    end,
  ], { foreground: true });
  const { target } = fixture;
  const failure = error => ({ code: error.code, unknownOutcome: error.unknownOutcome, reason: error.reason,
    tool: error.tool, refusalCode: error.refusalCode });
  const expected = (reason, tool, refusalCode, unknownOutcome = false) =>
    ({ code: 'NATIVE_TARGET_ERROR', unknownOutcome, reason, tool, refusalCode });
  try {
    await target.start();
    // Exact-PID windows, main-display size, then the on-screen stack: no click was sent, so the outcome is known.
    for (const [tool, refusalCode] of [
      ['list_windows', 'permissions_pending'], ['get_screen_size', undefined], ['list_windows', 'permissions_pending'],
    ]) {
      const observation = await settleNow(target);
      await assert.rejects(target.execute(foregroundPixel, observation), error => {
        assert.deepEqual(failure(error), expected('guard_unavailable', tool, refusalCode));
        return true;
      });
    }
    await assert.rejects(target.execute(foregroundPixel, await settleNow(target)), error => {
      assert.deepEqual(failure(error), expected('guard_unavailable_after_dispatch', 'list_windows', 'permissions_pending', true));
      return true;
    });
  } finally {
    await target.end();
  }
  assert.deepEqual((await fixture.dispatches()).map(call => call.tool).filter(tool => tool !== 'get_window_state'), [
    'start_session',
    'list_windows',
    'list_windows', 'get_screen_size',
    'list_windows', 'get_screen_size', 'list_windows',
    'list_windows', 'get_screen_size', 'list_windows', 'click', 'list_windows',
    'end_session',
  ]);
});

test('pixel outcomes are unknown after movement during dispatch or accessibility routing', async t => {
  const fixture = await createFixture(t, [
    start,
    captureStep(), captureStep(), inPlace, { tool: 'click', receipt: pixelDelivered },
    windowsStep(targetWindow({ bounds: { ...targetBounds, x: 140 } })),
    captureStep(), captureStep(), inPlace, { tool: 'click', receipt: { ...pixelDelivered, route: 'accessibility' } },
    end,
  ]);
  const { target } = fixture;
  try {
    await target.start();
    for (const reason of ['target_moved_during_dispatch', 'pixel_routed_to_accessibility']) {
      const observation = await settleNow(target);
      await assert.rejects(target.execute(pixel, observation), { code: 'NATIVE_TARGET_ERROR', unknownOutcome: true, reason });
      await rejectsWithoutDispatch(fixture, () => target.execute(pixel, observation));
    }
  } finally {
    await target.end();
  }
  // A pixel that the Driver routed through accessibility gets no geometry re-check.
  assert.deepEqual((await fixture.dispatches()).map(call => call.tool), [
    'start_session',
    'get_window_state', 'get_window_state', 'list_windows', 'click', 'list_windows',
    'get_window_state', 'get_window_state', 'list_windows', 'click',
    'end_session',
  ]);
});

test('regions re-hash the owned capture and report capture pixels without consuming it', async t => {
  const blue = (r, g, b) => r === 0 && g === 0 && b === 255;
  const fixture = await createFixture(t, [
    start,
    { tool: 'get_window_state', receipt: windowState() },
    captureStep(frameSeats), captureStep(frameSeats), inPlace, { tool: 'click', receipt: pixelDelivered }, inPlace,
    captureStep(frameSeats), captureStep(frameSeats),
    end,
  ]);
  const { target } = fixture;
  try {
    await target.start();
    const accessibilityOnly = await target.observe();
    await rejectsWithoutDispatch(fixture, () => target.regions(accessibilityOnly, { match: blue }));
    const observation = await settleNow(target);
    const found = await target.regions(observation, { match: blue });
    assert.ok(Object.isFrozen(found));
    // Screenshot scale 2 and 3x2 window bounds do not rescale PNG pixel coordinates.
    assert.deepEqual(found, {
      regions: [
        { x: 2, y: 1, width: 3, height: 1, area: 3, center: { x: 3, y: 1 }, anchor: { x: 3, y: 1 } },
        { x: 0, y: 3, width: 1, height: 1, area: 1, center: { x: 0, y: 3 }, anchor: { x: 0, y: 3 } },
      ],
      truncated: false, capture_id: observation.local.screenshot.capture_id, width: 6, height: 4,
    });
    const { anchor } = found.regions[0];
    await target.execute({ action: { tool: 'click', args: { x: anchor.x, y: anchor.y } } }, observation);
    const tampered = await settleNow(target);
    const substitute = Buffer.from(frameSeatsMoved, 'base64');
    // A same-length valid PNG: only the recorded sha256 can detect the swap.
    assert.equal(substitute.length, tampered.local.screenshot.byte_length);
    await writeFile(tampered.local.screenshot.file_path, substitute);
    await rejectsWithoutDispatch(fixture, () => target.regions(tampered, { match: blue }));
  } finally {
    await target.end();
  }
  const clicks = (await fixture.dispatches()).filter(call => call.tool === 'click');
  assert.deepEqual(clicks.map(call => [call.args.x, call.args.y]), [[3, 1]]);
});

test('visual regions keep capture PNG pixels, return the affine only as evidence, and leave the capture clickable', async t => {
  const captures = [captureStep(frameSeats), captureStep(frameSeats)];
  const capture_id = captures[1].receipt.capture_id;
  const fixture = await createFixture(t, [
    start, { tool: 'get_window_state', receipt: windowState() }, captureStep(frameSeats, { capture_id: undefined }),
    ...captures, visualStep(capture_id), inPlace, { tool: 'click', receipt: pixelDelivered }, inPlace, end,
  ]);
  const { target } = fixture;
  try {
    await target.start();
    const accessibilityOnly = await target.observe();
    await rejectsWithoutDispatch(fixture, () => target.visualRegions(accessibilityOnly));
    const unbound = await target.observe({ screenshot: true });
    await rejectsWithoutDispatch(fixture, () => target.visualRegions(unbound));
    const observation = await settleNow(target);
    await rejectsWithoutDispatch(fixture, () => target.visualRegions(structuredClone(observation)));
    for (const options of [
      { kinds: [] }, { kinds: ['text', 'text'] }, { kinds: ['button'] }, { kinds: 'text' }, { maxRegions: 0 },
      { maxRegions: 1.5 }, { minConfidence: -0.1 }, { minConfidence: 1.1 }, { minConfidence: Number.NaN }, { max_regions: 8 },
    ]) await rejectsWithoutDispatch(fixture, () => target.visualRegions(observation, options));
    const visual = await target.visualRegions(observation, { kinds: ['text', 'icon'], maxRegions: 8, minConfidence: 0.3 });
    const [text] = visual.regions;
    for (const value of [visual, visual.actionCoordinateSpace, visual.parser, visual.regions, text, text.bounds, text.anchor, visual.warnings]) {
      assert.ok(Object.isFrozen(value));
    }
    assert.deepEqual(visual, {
      capture_id, width: 6, height: 4, sha256: sha256(frameSeats),
      actionCoordinateSpace: { kind: 'affine', m11: 1.632, m12: 0, m21: 0, m22: 1.63, tx: 0, ty: 0 },
      parser: {
        extension_id: 'cua-perception', extension_version: '0.2.1', model_id: 'pp-ocrv5-mobile-en', model_version: '5.0',
        backend: 'onnxruntime-cpu',
      },
      regions: [
        { id: 'text-0', kind: 'text', text: 'A3', bounds: { x: 2, y: 1, width: 3, height: 1 }, confidence: 0.852, anchor: { x: 3, y: 1 } },
        { id: 'icon-0', kind: 'icon', label: 'icon-class-0', bounds: { x: 0, y: 3, width: 1, height: 1 }, confidence: 0.41, anchor: { x: 0, y: 3 } },
      ],
      warnings: [{ code: 'low_resolution' }],
      durationMs: 4100,
    });
    // Parsing consumed neither the native capture nor the settled observation.
    assert.deepEqual(await target.execute({ action: { tool: 'click', args: { ...text.anchor } } }, observation), pixelDelivered);
    await rejectsWithoutDispatch(fixture, () => target.visualRegions(observation));
  } finally {
    await target.end();
  }
  assert.deepEqual((await fixture.dispatches()).filter(call => ['parse_visual_regions', 'click'].includes(call.tool)), [
    { command: 'call', tool: 'parse_visual_regions', args: {
      capture_id, options: { kinds: ['text', 'icon'], max_regions: 8, min_confidence: 0.3 }, session: 'owned-native',
    } },
    // The same capture binds the click with unscaled PNG pixels; only the Driver applies its affine.
    { command: 'call', tool: 'click', args: {
      x: 3, y: 1, pid: 4107, window_id: 71, delivery_mode: 'background', session: 'owned-native', capture_id,
    } },
  ]);
});

test('visual regions bind to the owned capture id, window, size, and hash', async t => {
  const captures = [captureStep(frameSeats), captureStep(frameSeats)];
  const capture_id = captures[1].receipt.capture_id;
  const moved = sha256(frameSeatsMoved);
  const mismatches = [
    receipt => { receipt.capture.capture_id = 'capture-foreign'; },
    receipt => { Object.assign(receipt.capture.screenshot, { sha256: moved, reference: `png-sha256:${moved}` }); },
    receipt => { receipt.capture.source.pid = 4108; },
    receipt => { receipt.capture.source.window_id = 72; },
    receipt => { receipt.capture.source = { kind: 'primary_desktop', display_id: 'primary' }; },
    receipt => { receipt.capture.screenshot.width = 7; },
    receipt => { receipt.capture.screenshot.height = 5; },
  ];
  const fixture = await createFixture(t, [
    start, ...captures, ...mismatches.map(edit => visualStep(capture_id, edit)), visualStep(capture_id),
    captureStep(frameSeats), captureStep(frameSeats), end,
  ]);
  const { target } = fixture;
  try {
    await target.start();
    const observation = await settleNow(target);
    for (const index of mismatches.keys()) {
      await assert.rejects(target.visualRegions(observation), { code: 'NATIVE_TARGET_ERROR', unknownOutcome: false },
        `mismatch ${index}`);
    }
    // Refused receipts neither consumed nor invalidated the observation.
    assert.equal((await target.visualRegions(observation)).capture_id, capture_id);
    const tampered = await settleNow(target);
    // A same-length valid PNG: only the recorded sha256 detects the swap, before any parse dispatch.
    await writeFile(tampered.local.screenshot.file_path, Buffer.from(frameSeatsMoved, 'base64'));
    await rejectsWithoutDispatch(fixture, () => target.visualRegions(tampered));
    await rejectsWithoutDispatch(fixture, () => target.visualRegions(observation));
  } finally {
    await target.end();
  }
  assert.equal((await fixture.dispatches()).filter(call => call.tool === 'parse_visual_regions').length, mismatches.length + 1);
});

test('visual parse failures are definite and keep only the tool and an allowlisted refusal code', async t => {
  const captures = [captureStep(frameSeats), captureStep(frameSeats)];
  const parseFailure = code => ({ tool: 'parse_visual_regions', exitCode: 1,
    stdout: JSON.stringify({ code, message: 'Native parse text stays private.', detail: 'worker detail', retryable: false }) });
  const fixture = await createFixture(t, [
    start, ...captures, parseFailure('not_installed'), parseFailure('mystery_failure'),
    visualStep(captures[1].receipt.capture_id, receipt => { receipt.schema = 'cua.visual_regions_v2'; }), end,
  ]);
  const { target } = fixture;
  const failure = error => ({ code: error.code, unknownOutcome: error.unknownOutcome, reason: error.reason,
    tool: error.tool, refusalCode: error.refusalCode });
  try {
    await target.start();
    const observation = await settleNow(target);
    for (const refusalCode of ['not_installed', undefined]) {
      await assert.rejects(target.visualRegions(observation), error => {
        assert.deepEqual(failure(error), { code: 'NATIVE_TARGET_ERROR', unknownOutcome: false,
          reason: 'visual_regions_unavailable', tool: 'parse_visual_regions', refusalCode });
        assert.doesNotMatch(error.message, /private|worker detail/);
        return true;
      });
    }
    await assert.rejects(target.visualRegions(observation), { code: 'NATIVE_TARGET_ERROR', unknownOutcome: false });
  } finally {
    await target.end();
  }
  assert.equal((await fixture.dispatches()).filter(call => call.tool === 'parse_visual_regions').length, 3);
});

test('visual parses get their own 45 s budget beyond a shorter instance timeout', async t => {
  const captures = [captureStep(frameSeats), captureStep(frameSeats)];
  const fixture = await createFixture(t, [
    start, ...captures, { ...visualStep(captures[1].receipt.capture_id), delayMs: 1500 }, end,
  ], { timeoutMs: 1000 });
  try {
    await fixture.target.start();
    const visual = await fixture.target.visualRegions(await settleNow(fixture.target));
    assert.equal(visual.capture_id, captures[1].receipt.capture_id);
  } finally {
    await fixture.target.end();
  }
});

test('verify reports only literal native satisfaction and consumes earlier evidence', async t => {
  const expect = [{ window: { exists: true } }, { window: { bounds: { ...targetBounds, tolerance_px: 1 } } }];
  const allSatisfied = [
    { index: 0, status: 'satisfied', unknown_reason: null, observed_json: '{"exists":true}' },
    { index: 1, status: 'satisfied', unknown_reason: null, observed_json: '{"x":100,"y":200}' },
  ];
  const receipts = [
    { status: 'satisfied', stable: true, samples: 2, elapsed_ms: 31, predicates: allSatisfied },
    { status: 'unknown', stable: false, samples: 3, elapsed_ms: 750, predicates: [
      { index: 0, status: 'satisfied', unknown_reason: null, observed_json: '{"exists":true}' },
      { index: 1, status: 'unknown', unknown_reason: 'untrusted_source', observed_json: null },
    ] },
    // Every predicate satisfied: only the root status literal separates these from success.
    ...['Satisfied', true, 'satisfied '].map(status => ({ status, stable: true, samples: 2, elapsed_ms: 5, predicates: allSatisfied })),
  ];
  const fixture = await createFixture(t, [
    start, { tool: 'get_window_state', receipt: windowState() }, ...receipts.map(receipt => ({ tool: 'verify_state', receipt })), end,
  ]);
  const { target } = fixture;
  try {
    await target.start();
    const observed = await target.observe();
    const satisfied = await target.verify({ expect });
    assert.deepEqual(satisfied, {
      status: 'satisfied', stable: true, samples: 2, elapsedMs: 31,
      predicates: [{ index: 0, status: 'satisfied' }, { index: 1, status: 'satisfied' }],
    });
    assert.ok(Object.isFrozen(satisfied) && Object.isFrozen(satisfied.predicates[0]));
    await rejectsWithoutDispatch(fixture, () => target.execute(save, observed));
    assert.deepEqual(await target.verify({ expect, timeoutMs: 750, stableSamples: 3 }), {
      status: 'unknown', stable: false, samples: 3, elapsedMs: 750,
      predicates: [{ index: 0, status: 'satisfied' }, { index: 1, status: 'unknown', unknownReason: 'untrusted_source' }],
    });
    for (let index = 0; index < 3; index++) {
      const outcome = await target.verify({ expect }).then(result => result.status, error => error.code);
      assert.ok(['NATIVE_TARGET_ERROR', 'unknown', 'unsatisfied'].includes(outcome), String(outcome));
    }
  } finally {
    await target.end();
  }
  const verified = (await fixture.dispatches()).filter(call => call.tool === 'verify_state');
  assert.equal(verified.length, 5);
  assert.deepEqual(verified[0].args, {
    pid: 4107, window_id: 71, expect, timeout_ms: 5000, stable_samples: 2, session: 'owned-native',
  });
  assert.deepEqual(verified[1].args, {
    pid: 4107, window_id: 71, expect, timeout_ms: 750, stable_samples: 3, session: 'owned-native',
  });
});

test('resume adopts the journaled capture directory of an abandoned helper', async t => {
  const fixture = await createFixture(t, [start, captureStep(), getSession, captureStep(), end]);
  let adopted;
  t.after(() => adopted && rm(adopted, { recursive: true, force: true }));
  // The first helper is abandoned without end, like a timed-out eval cell.
  const abandoned = fixture.target;
  await abandoned.start();
  assert.deepEqual((await readEntry(journalDirectory(), 'owned-native')).target, { pid: 4107, windowId: 71 });
  const first = await abandoned.observe({ screenshot: true });
  adopted = dirname(first.local.screenshot.file_path);
  assert.equal((await readEntry(journalDirectory(), 'owned-native')).captureDirectory, adopted);
  const resumed = fixture.createTarget();
  try {
    assert.deepEqual(await resumed.resume(), sessionReceipt);
    const later = await resumed.observe({ screenshot: true });
    assert.equal(dirname(later.local.screenshot.file_path), adopted);
  } finally {
    await resumed.end();
  }
  await assert.rejects(stat(adopted), { code: 'ENOENT' });
  assert.deepEqual((await fixture.dispatches()).map(({ tool, args }) => [tool, args.session ?? null]), [
    ['start_session', 'owned-native'], ['get_window_state', 'owned-native'], ['get_session', 'owned-native'],
    ['get_window_state', 'owned-native'], ['end_session', 'owned-native'],
  ]);
});

test('resume never adopts a journaled directory outside the owned tmpdir prefix', async t => {
  if (process.platform === 'win32') {
    t.skip('Requires POSIX symbolic links.');
    return;
  }
  const root = await realpath(tmpdir());
  const outside = await mkdtemp(join(root, 'omp-cua-jev-outside-'));
  t.after(() => rm(outside, { recursive: true, force: true }));
  const owned = await mkdtemp(join(root, 'omp-cua-jev-native-'));
  t.after(() => rm(owned, { recursive: true, force: true }));
  const nested = join(owned, 'omp-cua-jev-native-nested');
  await mkdir(nested, { mode: 0o700 });
  // Prefixed links directly under tmpdir: one escapes it, one aliases an otherwise valid directory.
  const links = [join(root, `omp-cua-jev-native-link-${randomUUID()}`), join(root, `omp-cua-jev-native-alias-${randomUUID()}`)];
  await symlink(outside, links[0]);
  await symlink(owned, links[1]);
  t.after(() => Promise.all(links.map(link => rm(link, { force: true }))));
  for (const directory of [outside, nested]) await writeFile(join(directory, 'keep.png'), 'sentinel stays intact', { mode: 0o600 });

  for (const [name, captureDirectory] of [
    ['outside prefix', outside], ['nested', nested], ['symlink escape', links[0]], ['symlink alias', links[1]],
  ]) {
    await t.test(name, async t => {
      const fixture = await createFixture(t, [start, getSession, end]);
      await fixture.target.start();
      const journal = join(journalDirectory(), 'owned-native.json');
      const entry = await readEntry(journalDirectory(), 'owned-native');
      await writeFile(journal, JSON.stringify({ ...entry, captureDirectory }), { mode: 0o600 });
      const resumed = fixture.createTarget();
      try {
        assert.deepEqual(await resumed.resume(), sessionReceipt);
      } finally {
        await resumed.end();
      }
      for (const directory of [outside, nested]) {
        assert.equal(await readFile(join(directory, 'keep.png'), 'utf8'), 'sentinel stays intact');
      }
      for (const link of links) assert.equal((await lstat(link)).isSymbolicLink(), true);
    });
  }
});

test('end after a refused resume sends nothing, so the resume error surfaces', async t => {
  for (const [name, journaled, steps, unknownOutcome] of [
    // The label's session already ended; get_session is read-only, so nothing was adopted.
    ['inactive session', true, [{
      tool: 'get_session', stdout: JSON.stringify({ code: 'session_not_started', effect: 'refused' }), exitCode: 1,
    }], true],
    // Without a journal entry the driver refuses before any dispatch.
    ['unjournaled label', false, [], false],
  ]) {
    await t.test(name, async t => {
      const fixture = await createFixture(t, steps);
      if (journaled) {
        const now = new Date().toISOString();
        await writeEntry(journalDirectory(), {
          schema: JOURNAL_SCHEMA, session: 'owned-native', createdAt: now, updatedAt: now, owner: { pid: 999999 },
        });
      }
      const { target } = fixture;
      await assert.rejects(async () => {
        try { await target.resume(); }
        finally { assert.equal(await target.end(), null); }
      }, { code: 'CUA_DRIVER_ERROR', unknownOutcome, tool: 'get_session' });
      assert.deepEqual((await fixture.dispatches()).map(call => call.tool), steps.map(step => step.tool));
    });
  }
});

test('matching pixels cannot supply a missing scale by inference from window bounds', async t => {
  const fixture = await createFixture(t, [
    start, ...Array.from({ length: 3 }, () => captureStep(frameA, { screenshot_scale: undefined })), end,
  ]);
  const controller = new AbortController();
  let seen = 0;
  try {
    await fixture.target.start();
    const result = await fixture.target.settle({
      ready: () => { if (++seen === 3) controller.abort(); return true; },
      stableForMs: 1, intervalMs: 2, maxMs: 10000, signal: controller.signal,
    });
    assert.equal(result.status, 'cancelled');
    assert.equal(result.samples, 3);
    assert.equal(result.observation.local.screenshot.scale, null);
    await rejectsWithoutDispatch(fixture, () => fixture.target.execute(pixel, result.observation));
  } finally {
    await fixture.target.end();
  }
});

test('copied evidence and failed focus, dispatch, or observation cannot authorize a retry', async t => {
  const fixture = await createFixture(t, [
    start,
    { tool: 'get_window_state', receipt: windowState() },
    { tool: 'bring_to_front', receipt: { ...focused, exact_window_effect: { ...focused.exact_window_effect, verified: false } } },
    { tool: 'get_window_state', receipt: windowState() },
    { tool: 'get_window_state', receipt: windowState() },
    { tool: 'click', receipt: axDelivered, exitCode: 1 },
    { tool: 'get_window_state', receipt: windowState() },
    { tool: 'get_window_state', receipt: windowState({ pid: 4108 }) },
    end,
  ], { foreground: true });
  const { target } = fixture;
  try {
    await target.start();
    const beforeFocus = await target.observe();
    await assert.rejects(target.focus(), { code: 'CUA_DRIVER_ERROR', unknownOutcome: true });
    await rejectsWithoutDispatch(fixture, () => target.execute(save, beforeFocus));
    const original = await target.observe();
    await rejectsWithoutDispatch(fixture, () => target.execute(save, structuredClone(original)));
    await rejectsWithoutDispatch(fixture, () => target.execute(save, original));
    const beforeFailure = await target.observe();
    await assert.rejects(target.execute(save, beforeFailure), { code: 'CUA_DRIVER_ERROR', unknownOutcome: true });
    await rejectsWithoutDispatch(fixture, () => target.execute(save, beforeFailure));
    const beforeBadRead = await target.observe();
    await assert.rejects(target.observe(), { code: 'NATIVE_TARGET_ERROR', unknownOutcome: false });
    await rejectsWithoutDispatch(fixture, () => target.execute(save, beforeBadRead));
  } finally {
    await target.end();
  }
  assert.deepEqual((await fixture.dispatches()).map(call => call.tool), [
    'start_session', 'get_window_state', 'bring_to_front', 'get_window_state', 'get_window_state',
    'click', 'get_window_state', 'get_window_state', 'end_session',
  ]);
});

test('expired native evidence is rejected before any dispatch', async t => {
  const fixture = await createFixture(t, [start, { tool: 'get_window_state', receipt: windowState() }, end], { maxAgeMs: 5 });
  try {
    await fixture.target.start();
    const observed = await fixture.target.observe();
    await new Promise(resolve => setTimeout(resolve, 15));
    await rejectsWithoutDispatch(fixture, () => fixture.target.execute(save, observed));
  } finally {
    await fixture.target.end();
  }
  assert.deepEqual((await fixture.dispatches()).map(call => call.tool), ['start_session', 'get_window_state', 'end_session']);
});

test('native typing counts Unicode scalars, rejects partial delivery, and never replays the payload', async t => {
  const fixture = await createFixture(t, [
    start,
    { tool: 'get_window_state', receipt: windowState() },
    { tool: 'type_text', receipt: { effect: 'unverifiable', route: 'synthetic_events', delivery: { mode: 'background', delivered_count: 4 } } },
    { tool: 'get_window_state', receipt: windowState() },
    { tool: 'type_text', receipt: { effect: 'unverifiable', route: 'synthetic_events', delivery: { mode: 'background', delivered_count: 5 } } },
    { tool: 'get_window_state', receipt: windowState() },
    { tool: 'type_text', receipt: { effect: 'partial', route: 'synthetic_events', delivery: { mode: 'background', delivered_count: 2 } } },
    { tool: 'get_window_state', receipt: windowState() },
    { tool: 'type_text', receipt: axDelivered },
    end,
  ]);
  // Four scalars, five UTF-16 code units, three grapheme clusters.
  const type = { action: { tool: 'type_text', args: { text: 'a\u{1F600}e\u0301' } } };
  try {
    await fixture.target.start();
    await fixture.target.execute(type, await fixture.target.observe());
    for (let index = 0; index < 2; index++) {
      const observed = await fixture.target.observe();
      await assert.rejects(fixture.target.execute(type, observed), { code: 'NATIVE_TARGET_ERROR', unknownOutcome: true });
      await rejectsWithoutDispatch(fixture, () => fixture.target.execute(type, observed));
    }
    // Atomic AX insertion may omit a count; event delivery above may not lie about it.
    await fixture.target.execute(type, await fixture.target.observe());
  } finally {
    await fixture.target.end();
  }
  const typed = (await fixture.dispatches()).filter(call => call.tool === 'type_text');
  assert.equal(typed.length, 4);
  for (const call of typed) {
    assert.deepEqual(call.args, {
      text: 'a\u{1F600}e\u0301', pid: 4107, window_id: 71, delivery_mode: 'background', session: 'owned-native',
    });
  }
});

test('runBounded treats an unchanged after-observation as unverified and does not click twice', async t => {
  const pending = windowState();
  pending.elements.push({ element_index: 2, role: 'AXStaticText', label: 'Receipt pending', in_web_content: true });
  pending.element_count = 2;
  const fixture = await createFixture(t, [
    start,
    { tool: 'get_window_state', receipt: pending },
    { tool: 'click', receipt: axDelivered },
    { tool: 'get_window_state', receipt: { ...pending, snapshot_id: 'native-2' } },
    end,
  ]);
  const observed = [];
  let verifications = 0;
  try {
    await fixture.target.start();
    const result = await runBounded({
      goal: 'Save exactly one receipt',
      judge: () => { throw new Error('The local deterministic choice must not call a judge.'); },
      maxSteps: 3, maxMs: 10000,
      observe: async () => {
        const observation = await fixture.target.observe();
        observed.push(observation);
        return observation;
      },
      getCandidates: () => [save],
      deterministicId: () => 'save',
      isDone: observation => observation.state.elements.some(element => element.label === 'Receipt saved'),
      authorize: (candidate, observation) => candidate.id === 'save' && observation.local.pid === 4107 && observation.local.window_id === 71,
      execute: (candidate, observation) => fixture.target.execute(candidate, observation),
      verify: (candidate, before, after) => {
        verifications += 1;
        assert.equal(candidate.id, 'save');
        assert.notEqual(before.id, after.id);
        return after.state.elements.some(element => element.label === 'Receipt saved');
      },
    });
    assert.equal(result.status, 'unverified');
    assert.equal(result.steps, 1);
    assert.equal(verifications, 1);
    assert.equal(observed.length, 2);
    assert.deepEqual(observed[1].state, observed[0].state);
    assert.deepEqual(result.history.map(entry => ({ candidateId: entry.candidateId, status: entry.status })), [
      { candidateId: 'save', status: 'unverified' },
    ]);
  } finally {
    await fixture.target.end();
  }
  assert.deepEqual(await fixture.dispatches(), [
    { command: 'call', tool: 'start_session', args: { session: 'owned-native' } },
    { command: 'call', tool: 'get_window_state', args: {
      include_accessibility_tree: true, include_screenshot: false, max_elements: 2000, max_depth: 25,
      pid: 4107, window_id: 71, session: 'owned-native',
    } },
    { command: 'call', tool: 'click', args: {
      element_token: 'save-token', pid: 4107, window_id: 71, delivery_mode: 'background', session: 'owned-native',
    } },
    { command: 'call', tool: 'get_window_state', args: {
      include_accessibility_tree: true, include_screenshot: false, max_elements: 2000, max_depth: 25,
      pid: 4107, window_id: 71, session: 'owned-native',
    } },
    { command: 'call', tool: 'end_session', args: { session: 'owned-native' } },
  ]);
});

test('end removes only owned captures even after a foreign screenshot path is returned', async t => {
  const outside = await mkdtemp(join(tmpdir(), 'omp-cua-jev-outside-'));
  t.after(() => rm(outside, { recursive: true, force: true }));
  const sentinel = join(outside, 'keep.png');
  await writeFile(sentinel, 'outside sentinel stays intact', { mode: 0o600 });
  const fixture = await createFixture(t, [
    start, captureStep(frameA), captureStep(frameB, { screenshot_file_path: sentinel }), end,
  ]);
  let captures;
  try {
    await fixture.target.start();
    const observed = await fixture.target.observe({ screenshot: true });
    assert.deepEqual(await readFile(observed.local.screenshot.file_path), Buffer.from(frameA, 'base64'));
    assert.notEqual(dirname(observed.local.screenshot.file_path), outside);
    await assert.rejects(fixture.target.observe({ screenshot: true }), { code: 'NATIVE_TARGET_ERROR', unknownOutcome: false });
    captures = (await fixture.dispatches()).filter(call => call.tool === 'get_window_state').map(call => call.args.screenshot_out_file);
    assert.equal(captures.length, 2);
    assert.deepEqual(await readFile(captures[1]), Buffer.from(frameB, 'base64'));
  } finally {
    await fixture.target.end();
  }
  for (const capture of captures) await assert.rejects(readFile(capture), { code: 'ENOENT' });
  await assert.rejects(stat(dirname(captures[0])), { code: 'ENOENT' });
  assert.equal(await readFile(sentinel, 'utf8'), 'outside sentinel stays intact');
  assert.equal((await stat(fixture.executable)).isFile(), true);
});

test('end retries owned capture cleanup without ending the session again', async t => {
  if (process.platform === 'win32' || process.getuid?.() === 0) {
    t.skip('Requires unprivileged POSIX directory permissions.');
    return;
  }
  const fixture = await createFixture(t, [start, captureStep(frameA), end]);
  let captureDirectory;
  try {
    await fixture.target.start();
    const observed = await fixture.target.observe({ screenshot: true });
    const capture = observed.local.screenshot.file_path;
    captureDirectory = dirname(capture);
    const beforeEnd = await fixture.dispatches();
    await chmod(captureDirectory, 0o555);

    await assert.rejects(fixture.target.end(), error => {
      assert.equal(error.code, 'NATIVE_TARGET_ERROR');
      assert.equal(error.unknownOutcome, false);
      assert.equal(error.message.includes(captureDirectory), false);
      assert.equal(error.path, undefined);
      assert.equal(error.cause, undefined);
      assert.equal(error.stack.includes(captureDirectory), false);
      return true;
    });
    assert.deepEqual(await readFile(capture), Buffer.from(frameA, 'base64'));
    const afterEnd = await fixture.dispatches();
    assert.deepEqual(afterEnd, [
      ...beforeEnd,
      { command: 'call', tool: 'end_session', args: { session: 'owned-native' } },
    ]);

    await chmod(captureDirectory, 0o700);
    assert.deepEqual(await fixture.target.end(), end.receipt);
    await assert.rejects(readFile(capture), { code: 'ENOENT' });
    await assert.rejects(stat(captureDirectory), { code: 'ENOENT' });
    assert.deepEqual(await fixture.dispatches(), afterEnd);
  } finally {
    if (captureDirectory) {
      await chmod(captureDirectory, 0o700).catch(error => { if (error.code !== 'ENOENT') throw error; });
      await rm(captureDirectory, { recursive: true, force: true });
    }
  }
});
