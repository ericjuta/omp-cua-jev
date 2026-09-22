import assert from 'node:assert/strict';
import test from 'node:test';
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createNativeTarget } from '../src/native-target.mjs';
import { runBounded } from '../src/jev-loop.mjs';

async function createFixture(t, steps, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'omp-cua-jev-native-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const executable = join(directory, 'driver.mjs');
  const log = join(directory, 'dispatch.json');
  await writeFile(log, '[]', { mode: 0o600 });
  await writeFile(executable, `#!${process.execPath}
import { readFileSync, writeFileSync } from 'node:fs';
const log = ${JSON.stringify(log)};
const steps = ${JSON.stringify(steps)};
const [command, tool, json] = process.argv.slice(2);
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
`, { mode: 0o700 });
  return {
    directory,
    executable,
    target: createNativeTarget({ pid: 4107, windowId: 71, session: 'owned-native', ...options, binary: executable }),
    invocations: async () => JSON.parse(await readFile(log, 'utf8')),
    dispatches: async () => JSON.parse(await readFile(log, 'utf8')).map(({ command, tool, args }) => ({ command, tool, args })),
  };
}

async function rejectsWithoutDispatch(fixture, operation, code = 'NATIVE_TARGET_ERROR') {
  const before = await fixture.dispatches();
  await assert.rejects(operation, { code, unknownOutcome: false });
  assert.deepEqual(await fixture.dispatches(), before);
}

const start = { tool: 'start_session', receipt: { session: 'owned-native', active: true } };
const end = { tool: 'end_session', receipt: { session: 'owned-native', active: false } };
const axDelivered = { effect: 'unverifiable', route: 'accessibility', delivery: { mode: 'background' } };
const save = { id: 'save', description: 'Save one receipt', action: { tool: 'click', args: { element_token: 'save-token' } } };
const pixel = { id: 'pixel', description: 'Click captured pixel', action: { tool: 'click', args: { x: 5, y: 3 } } };
// Independent six-by-four RGB PNGs. No production encoder or dimensions are imported.
const frameA = 'iVBORw0KGgoAAAANSUhEUgAAAAYAAAAECAIAAAAiZtkUAAAAEklEQVR4nGP4z8CAhtD5RAsBAKTRF+lZezHiAAAAAElFTkSuQmCC';
const frameB = 'iVBORw0KGgoAAAANSUhEUgAAAAYAAAAECAIAAAAiZtkUAAAAEElEQVR4nGNgYPiPgcgUAgB1ARfpnAW9rgAAAABJRU5ErkJggg==';

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

function captureStep(bytes = frameA, overrides = {}, delayMs = 0) {
  return {
    tool: 'get_window_state', delayMs, screenshotBytes: bytes,
    receipt: windowState({
      screenshot_width: 6, screenshot_height: 4, screenshot_scale: 2,
      screenshot_frame_valid: true, window_bounds: { x: 100, y: 200, width: 3, height: 2 },
      ...overrides,
    }),
  };
}

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
  const fixture = await createFixture(t, [
    start, ...Array.from({ length: 7 }, () => captureStep()),
    { tool: 'click', receipt: { effect: 'unverifiable', route: 'synthetic_events', delivery: { mode: 'background' } } }, end,
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
    await fixture.target.execute(pixel, settled.observation);
    await rejectsWithoutDispatch(fixture, () => fixture.target.execute(pixel, settled.observation));
  } finally {
    await fixture.target.end();
  }
  const clicks = (await fixture.dispatches()).filter(call => call.tool === 'click');
  assert.deepEqual(clicks, [{ command: 'call', tool: 'click', args: {
    x: 5, y: 3, pid: 4107, window_id: 71, delivery_mode: 'background', session: 'owned-native',
  } }]);
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
