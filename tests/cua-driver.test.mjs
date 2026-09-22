import assert from 'node:assert/strict';
import test from 'node:test';
import { lstat, mkdir, mkdtemp, readFile, realpath, symlink, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inspect } from 'node:util';
import { createCuaDriver } from '../src/cua-driver.mjs';

async function createFixture(t, session, steps) {
  const directory = await mkdtemp(join(tmpdir(), 'omp-cua-jev-driver-'));
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
const step = steps[dispatches.length];
dispatches.push({ command, tool, args: JSON.parse(json) });
writeFileSync(log, JSON.stringify(dispatches));
if (command !== 'call' || !step || tool !== step.tool) throw new Error('Unexpected fixture dispatch.');
process.stdout.write(step.stdout ?? JSON.stringify(step.receipt));
if (step.stderr !== undefined) process.stderr.write(step.stderr);
process.exitCode = step.exitCode ?? 0;
`, { mode: 0o700 });
  return {
    directory,
    driver: createCuaDriver({ binary: executable, session }),
    dispatches: async () => JSON.parse(await readFile(log, 'utf8')),
  };
}

async function rejectsWithoutDispatch(operation, dispatches, expected) {
  await assert.rejects(operation, { code: 'CUA_DRIVER_ERROR', unknownOutcome: false });
  assert.deepEqual(await dispatches(), expected);
}

function assertPrivateFailure(error, { refusalCode, exitCode, hint = false, unknownOutcome = true } = {}) {
  assert.ok(error instanceof Error);
  assert.equal(error.code, 'CUA_DRIVER_ERROR');
  assert.equal(error.unknownOutcome, unknownOutcome);
  assert.equal(error.refusalCode, refusalCode);
  assert.equal(error.exitCode, exitCode);
  if (hint) assert.equal(typeof error.hint, 'string');
  else assert.equal(error.hint, undefined);
  assert.equal(error.cause, undefined);
  assert.doesNotMatch(
    inspect(error, { showHidden: true, depth: null, customInspect: false }),
    /private-sentinel|Bearer|private\.invalid/,
  );
  return true;
}

// Mutation targets: drop a safe code/hint, copy native fields, or ignore the child's exit code.
test('scope and typed-browser refusals expose safe hints without request or process secrets', async t => {
  const session = 'owned-safe-hints';
  const secret = 'private-sentinel Bearer token https://private.invalid';
  const cases = [
    {
      receipt: {
        status: 'refused',
        refusal: { code: 'protected_resource_scope_invalid', message: secret, detail: secret },
        hint: secret,
      },
      refusalCode: 'protected_resource_scope_invalid',
    },
    {
      receipt: {
        status: 'refused',
        refusal: { code: 'browser_route_unavailable', message: secret, detail: { token: secret }, hint: secret },
        error: secret, cause: secret, stack: secret,
      },
      refusalCode: 'browser_route_unavailable',
    },
    {
      receipt: { code: 'protected_resource_scope_invalid', message: secret, error: secret, hint: secret },
      refusalCode: 'protected_resource_scope_invalid', exitCode: 17,
    },
  ];
  const { driver, dispatches } = await createFixture(t, session, [
    { tool: 'start_session', receipt: { session, active: true } },
    ...cases.map(({ receipt, exitCode }) => ({ tool: 'set_value', receipt, exitCode, stderr: secret })),
    { tool: 'end_session', receipt: { session, active: false } },
  ]);
  await driver.start();
  for (const { refusalCode, exitCode } of cases) {
    await assert.rejects(
      driver.call('set_value', { value: secret }),
      error => {
        assertPrivateFailure(error, { refusalCode, exitCode, hint: true });
        if (refusalCode === 'browser_route_unavailable') {
          assert.match(error.hint, /typed[- ]browser/i);
          assert.match(error.hint, /(?:not|untested).*native|native.*(?:not|untested)/i);
        } else {
          assert.match(error.hint, /resource.*path/i);
        }
        return true;
      },
    );
  }
  await driver.end();
  assert.deepEqual(await dispatches(), [
    { command: 'call', tool: 'start_session', args: { session } },
    ...cases.map(() => ({ command: 'call', tool: 'set_value', args: { value: secret, session } })),
    { command: 'call', tool: 'end_session', args: { session } },
  ]);
});

test('failed processes keep unknown or malformed codes and raw output private', async t => {
  const session = 'owned-private-failures';
  const secret = 'private-sentinel Bearer token https://private.invalid';
  const cases = [
    {
      receipt: {
        status: 'refused', code: 'browser_route_unavailable',
        refusal: { code: secret, message: secret, detail: secret },
      },
      exitCode: 19,
    },
    {
      receipt: {
        status: 'refused', code: 'protected_resource_scope_invalid',
        refusal: { code: null, message: secret },
      },
      exitCode: 23,
    },
    { stdout: `${secret} {"code":"protected_resource_scope_invalid"`, exitCode: 29 },
    { receipt: { status: 'error', message: secret }, exitCode: 31 },
    // A success-shaped receipt's code is not a refusal, even though its process failed.
    { receipt: { status: 'ok', code: 'browser_route_unavailable', message: secret }, exitCode: 37 },
  ];
  const { driver, dispatches } = await createFixture(t, session, [
    { tool: 'start_session', receipt: { session, active: true } },
    ...cases.map(step => ({
      tool: 'set_value', ...step,
      stderr: JSON.stringify({ code: 'browser_route_unavailable', message: secret }),
    })),
    { tool: 'end_session', receipt: { session, active: false } },
  ]);
  await driver.start();
  for (const { exitCode } of cases) {
    await assert.rejects(
      driver.call('set_value', { value: secret }),
      error => assertPrivateFailure(error, { exitCode }),
    );
  }
  await driver.end();
  assert.deepEqual(await dispatches(), [
    { command: 'call', tool: 'start_session', args: { session } },
    ...cases.map(() => ({ command: 'call', tool: 'set_value', args: { value: secret, session } })),
    { command: 'call', tool: 'end_session', args: { session } },
  ]);
});

test('nonzero success receipts grant neither session authority nor confirmed cleanup', async t => {
  const session = 'owned-failed-success';
  const { driver, dispatches } = await createFixture(t, session, [
    { tool: 'start_session', receipt: { session, active: true }, exitCode: 17 },
    { tool: 'end_session', receipt: { session, active: false }, exitCode: 23 },
    { tool: 'end_session', receipt: { session, active: false } },
  ]);
  await assert.rejects(driver.start(), error => assertPrivateFailure(error, { exitCode: 17 }));
  const uncertain = [{ command: 'call', tool: 'start_session', args: { session } }];
  await rejectsWithoutDispatch(driver.call('set_value', { value: 'blocked' }), dispatches, uncertain);
  await rejectsWithoutDispatch(driver.start(), dispatches, uncertain);
  await assert.rejects(driver.end(), error => assertPrivateFailure(error, { exitCode: 23 }));
  uncertain.push({ command: 'call', tool: 'end_session', args: { session } });
  await rejectsWithoutDispatch(driver.call('set_value', { value: 'still-blocked' }), dispatches, uncertain);
  await driver.end();
  const closed = [...uncertain, { command: 'call', tool: 'end_session', args: { session } }];
  assert.deepEqual(await dispatches(), closed);
  await rejectsWithoutDispatch(driver.end(), dispatches, closed);
});

// Mutation targets: resolve the leaf, skip lstat, create output, or snapshot args after awaiting realpath.
test('explicit image outputs canonicalize a symlinked parent without creating leaves or reading later args', async t => {
  const session = 'owned-canonical-outputs';
  const { driver, dispatches, directory } = await createFixture(t, session, [
    { tool: 'start_session', receipt: { session, active: true } },
    { tool: 'snapshot', receipt: { status: 'ok' } },
    { tool: 'snapshot', receipt: { status: 'error', message: 'private-sentinel-unrelated-native-failure' } },
    { tool: 'end_session', receipt: { session, active: false } },
  ]);
  const parent = join(directory, 'private-tmp');
  const alias = join(directory, 'tmp');
  await mkdir(parent);
  await symlink(parent, alias, 'dir');
  const canonicalParent = await realpath(parent);
  const screenshot = join(canonicalParent, 'screenshot.png');
  const debugImage = join(canonicalParent, 'debug.png');
  const args = {
    screenshot_out_file: join(alias, 'screenshot.png'),
    debug_image_out: join(alias, 'debug.png'),
    target: { pid: 65120, window_id: 15216 },
    text: 'original-text',
  };
  await driver.start();
  const operation = driver.call('snapshot', args);
  args.screenshot_out_file = join(directory, 'missing', 'replaced-screenshot.png');
  args.debug_image_out = join(directory, 'missing', 'replaced-debug.png');
  args.target.pid = 99999;
  args.target.window_id = 999;
  args.text = 'changed-after-call';
  await operation;
  await assert.rejects(lstat(screenshot), { code: 'ENOENT' });
  await assert.rejects(lstat(debugImage), { code: 'ENOENT' });
  await assert.rejects(
    driver.call('snapshot', { screenshot_out_file: join(alias, 'screenshot.png') }),
    error => assertPrivateFailure(error),
  );
  await driver.end();
  assert.deepEqual(await dispatches(), [
    { command: 'call', tool: 'start_session', args: { session } },
    {
      command: 'call', tool: 'snapshot',
      args: {
        screenshot_out_file: screenshot, debug_image_out: debugImage,
        target: { pid: 65120, window_id: 15216 }, text: 'original-text', session,
      },
    },
    { command: 'call', tool: 'snapshot', args: { screenshot_out_file: screenshot, session } },
    { command: 'call', tool: 'end_session', args: { session } },
  ]);
});

test('symlink leaves and missing or non-directory image parents fail locally without changing the filesystem', async t => {
  const session = 'owned-local-outputs';
  const { driver, dispatches, directory } = await createFixture(t, session, [
    { tool: 'start_session', receipt: { session, active: true } },
    { tool: 'snapshot', receipt: { status: 'ok' } },
    { tool: 'end_session', receipt: { session, active: false } },
  ]);
  const target = join(directory, 'private-sentinel-existing.png');
  const linkedLeaf = join(directory, 'private-sentinel-linked.png');
  const missingTarget = join(directory, 'private-sentinel-missing.png');
  const danglingLeaf = join(directory, 'private-sentinel-dangling.png');
  const missingParent = join(directory, 'private-sentinel-missing-parent');
  await writeFile(target, 'existing-image-must-not-change');
  await symlink(target, linkedLeaf);
  await symlink(missingTarget, danglingLeaf);
  await driver.start();
  const started = [{ command: 'call', tool: 'start_session', args: { session } }];
  for (const args of [
    { screenshot_out_file: linkedLeaf },
    { screenshot_out_file: 'private-sentinel-relative.png' },
    { debug_image_out: danglingLeaf },
    { screenshot_out_file: join(missingParent, 'screenshot.png') },
    { debug_image_out: join(target, 'debug.png') },
  ]) {
    await assert.rejects(driver.call('snapshot', args), error => assertPrivateFailure(error, { hint: true, unknownOutcome: false }));
    assert.deepEqual(await dispatches(), started);
  }
  assert.equal((await lstat(linkedLeaf)).isSymbolicLink(), true);
  assert.equal((await lstat(danglingLeaf)).isSymbolicLink(), true);
  assert.equal(await readFile(target, 'utf8'), 'existing-image-must-not-change');
  await assert.rejects(lstat(missingTarget), { code: 'ENOENT' });
  await assert.rejects(lstat(missingParent), { code: 'ENOENT' });
  await driver.call('snapshot');
  await driver.end();
  assert.deepEqual(await dispatches(), [
    ...started,
    { command: 'call', tool: 'snapshot', args: { session } },
    { command: 'call', tool: 'end_session', args: { session } },
  ]);
});

const verifiedFocus = {
  activated: true,
  code: 'bring_to_front_exact_window_verified',
  exact_window_effect: { focused: true, frontmost_ordinary: true, target_visible_ordinary: true, verified: true },
  observed: {
    focused_window_id: 15216, front_process_matches_target: true,
    frontmost_ordinary_window_id: 15216, frontmost_pid: 65120, workspace_frontmost_pid: 65120,
  },
  path: 'skylight_process_exact_cocoa_ax',
  pid: 65120,
  process_activated: true,
  request_accepted: true,
  status: 'activated',
  window_id: 15216,
};

test('scoped native methods share lifecycle and busy gates without acquiring sessionless authority', async t => {
  const session = 'owned-scoped-lifecycle';
  const target = { pid: 65120, window_id: 15216 };
  const { driver, dispatches } = await createFixture(t, session, [
    { tool: 'start_session', receipt: { session, active: true } },
    { tool: 'bring_to_front', receipt: verifiedFocus },
    { tool: 'end_session', receipt: { session: 'foreign-session', active: false } },
    { tool: 'end_session', receipt: { session, active: false } },
  ]);
  await rejectsWithoutDispatch(driver.listWindows(65120), dispatches, []);
  await rejectsWithoutDispatch(driver.bringToFront(target), dispatches, []);
  const starting = driver.start();
  await Promise.all([
    driver.listWindows(65120),
    driver.bringToFront(target),
  ].map(operation => assert.rejects(operation, { code: 'CUA_DRIVER_ERROR', unknownOutcome: false })));
  await starting;
  const mutableTarget = { ...target };
  const focusing = driver.bringToFront(mutableTarget);
  mutableTarget.pid = 99999;
  mutableTarget.window_id = 999;
  await Promise.all([
    driver.listWindows(65120),
    driver.call('set_value', { value: 'blocked-while-focusing' }),
    driver.end(),
  ].map(operation => assert.rejects(operation, { code: 'CUA_DRIVER_ERROR', unknownOutcome: false })));
  assert.deepEqual(await focusing, verifiedFocus);
  await assert.rejects(driver.end(), { code: 'CUA_DRIVER_ERROR', unknownOutcome: true });
  const uncertain = [
    { command: 'call', tool: 'start_session', args: { session } },
    { command: 'call', tool: 'bring_to_front', args: target },
    { command: 'call', tool: 'end_session', args: { session } },
  ];
  await rejectsWithoutDispatch(driver.listWindows(65120), dispatches, uncertain);
  await rejectsWithoutDispatch(driver.bringToFront(target), dispatches, uncertain);
  await driver.end();
  const closed = [...uncertain, { command: 'call', tool: 'end_session', args: { session } }];
  await rejectsWithoutDispatch(driver.listWindows(65120), dispatches, closed);
  await rejectsWithoutDispatch(driver.bringToFront(target), dispatches, closed);
});

// Mutation targets: accept activation alone, trust echoed IDs, or skip exact-window verification.
test('focus requires complete observed PID and exact-window proof rather than activation claims', async t => {
  const session = 'owned-verified-focus';
  const target = { pid: 65120, window_id: 15216 };
  const cases = [
    {
      name: 'partial activation',
      receipt: { ...verifiedFocus, status: 'partial', activated: false,
        code: 'bring_to_front_exact_window_unverified', message: 'private-sentinel',
        exact_window_effect: { ...verifiedFocus.exact_window_effect, verified: false } },
      refusalCode: 'bring_to_front_exact_window_unverified', hint: true,
    },
    { name: 'failed activation', receipt: { ...verifiedFocus, status: 'failed' } },
    { name: 'foreign response target despite matching observations', receipt: { ...verifiedFocus, pid: 99999, window_id: 999 } },
    { name: 'wrong focused window', receipt: { ...verifiedFocus, observed: { ...verifiedFocus.observed, focused_window_id: 999 } } },
    { name: 'wrong frontmost window', receipt: { ...verifiedFocus, observed: { ...verifiedFocus.observed, frontmost_ordinary_window_id: 999 } } },
    { name: 'wrong frontmost process', receipt: { ...verifiedFocus, observed: { ...verifiedFocus.observed, frontmost_pid: 99999 } } },
    {
      name: 'unavailable process match with foreign workspace fallback',
      receipt: {
        ...verifiedFocus,
        observed: { ...verifiedFocus.observed, front_process_matches_target: null, workspace_frontmost_pid: 99999 },
      },
    },
    {
      name: 'absent exact-window verification',
      receipt: {
        ...verifiedFocus,
        exact_window_effect: { focused: true, frontmost_ordinary: true, target_visible_ordinary: true },
      },
    },
    { name: 'absent observed proof', receipt: { ...verifiedFocus, observed: null } },
    {
      name: 'verified flag contradicts the exact-window effect',
      receipt: {
        ...verifiedFocus,
        exact_window_effect: { focused: false, frontmost_ordinary: false, target_visible_ordinary: false, verified: true },
      },
    },
    {
      name: 'matching observed IDs contradict the process match',
      receipt: { ...verifiedFocus, observed: { ...verifiedFocus.observed, front_process_matches_target: false } },
    },
    {
      name: 'failed process with complete success receipt',
      receipt: verifiedFocus, exitCode: 17,
    },
  ];
  const alreadyFocused = {
    ...verifiedFocus, request_accepted: false, path: 'another-native-implementation',
    observed: { ...verifiedFocus.observed, workspace_frontmost_pid: 99999 },
  };
  const workspaceFallback = {
    ...verifiedFocus, request_accepted: false,
    observed: { ...verifiedFocus.observed, front_process_matches_target: null },
  };
  const { driver, dispatches } = await createFixture(t, session, [
    { tool: 'start_session', receipt: { session, active: true } },
    ...cases.map(({ receipt, exitCode }) => ({ tool: 'bring_to_front', receipt, exitCode })),
    { tool: 'bring_to_front', receipt: alreadyFocused },
    { tool: 'bring_to_front', receipt: workspaceFallback },
    { tool: 'end_session', receipt: { session, active: false } },
  ]);
  await driver.start();
  for (const { name, exitCode, refusalCode, hint } of cases) {
    await assert.rejects(
      driver.bringToFront(target),
      error => assertPrivateFailure(error, { exitCode, refusalCode, hint }),
      name,
    );
  }
  // Verified WindowServer evidence outranks a stale workspace PID, even with no new activation request.
  assert.deepEqual(await driver.bringToFront(target), alreadyFocused);
  // No preceding discovery is needed; the matching workspace PID is a fallback only for a null match.
  assert.deepEqual(await driver.bringToFront(target), workspaceFallback);
  await driver.end();
  assert.deepEqual(await dispatches(), [
    { command: 'call', tool: 'start_session', args: { session } },
    ...cases.map(() => ({ command: 'call', tool: 'bring_to_front', args: target })),
    { command: 'call', tool: 'bring_to_front', args: target },
    { command: 'call', tool: 'bring_to_front', args: target },
    { command: 'call', tool: 'end_session', args: { session } },
  ]);
});

test('scoped native methods reject global discovery, overrides, and session injection before dispatch', async t => {
  const session = 'owned-scoped-arguments';
  const target = { pid: 65120, window_id: 15216 };
  const { driver, dispatches } = await createFixture(t, session, [
    { tool: 'start_session', receipt: { session, active: true } },
    { tool: 'list_windows', receipt: { windows: [] } },
    { tool: 'bring_to_front', receipt: verifiedFocus },
    { tool: 'end_session', receipt: { session, active: false } },
  ]);
  await driver.start();
  const started = [{ command: 'call', tool: 'start_session', args: { session } }];
  for (const operation of [
    () => driver.listWindows(),
    () => driver.listWindows(0),
    () => driver.listWindows(0x80000000),
    () => driver.listWindows({ pid: 65120, on_screen_only: false }),
    () => driver.listWindows({ pid: 65120, session }),
    () => driver.listWindows(65120, { session }),
    () => driver.bringToFront({ window_id: 15216 }),
    () => driver.bringToFront({ pid: 65120 }),
    () => driver.bringToFront({ ...target, window_id: 0x100000000 }),
    () => driver.bringToFront({ ...target, session }),
    () => driver.bringToFront({ ...target, on_screen_only: false }),
    () => driver.bringToFront(target, { session }),
  ]) {
    await rejectsWithoutDispatch(operation(), dispatches, started);
  }
  for (const [tool, method, args] of [
    ['list_windows', 'listWindows', { pid: 65120 }],
    ['bring_to_front', 'bringToFront', target],
  ]) {
    await assert.rejects(driver.call(tool, args), error => {
      assert.equal(error.code, 'CUA_DRIVER_ERROR');
      assert.equal(error.unknownOutcome, false);
      assert.equal(typeof error.hint, 'string');
      assert.ok(error.hint.includes(method));
      return true;
    });
    assert.deepEqual(await dispatches(), started);
  }
  assert.deepEqual(await driver.listWindows(65120), { windows: [] });
  assert.deepEqual(await driver.bringToFront(target), verifiedFocus);
  await driver.end();
  assert.deepEqual(await dispatches(), [
    ...started,
    { command: 'call', tool: 'list_windows', args: { pid: 65120, on_screen_only: true } },
    { command: 'call', tool: 'bring_to_front', args: target },
    { command: 'call', tool: 'end_session', args: { session } },
  ]);
});

test('scoped discovery rejects malformed, foreign, off-screen, and duplicate windows without global fallback', async t => {
  const session = 'owned-window-results';
  const window = { pid: 65120, window_id: 15216, is_on_screen: true };
  const cases = [
    { name: 'non-array windows', receipt: { windows: window } },
    { name: 'malformed window entry', receipt: { windows: [null] } },
    { name: 'foreign PID despite matching root', receipt: { pid: 65120, windows: [window, { ...window, pid: 99999, window_id: 15217 }] } },
    { name: 'off-screen window', receipt: { windows: [window, { ...window, window_id: 15217, is_on_screen: false }] } },
    { name: 'duplicate window', receipt: { windows: [window, { ...window }] } },
    { name: 'invalid window ID', receipt: { windows: [{ ...window, window_id: 0 }] } },
  ];
  const success = { windows: [window, { ...window, window_id: 15217 }] };
  const { driver, dispatches } = await createFixture(t, session, [
    { tool: 'start_session', receipt: { session, active: true } },
    ...cases.map(({ receipt }) => ({ tool: 'list_windows', receipt })),
    { tool: 'list_windows', receipt: success },
    { tool: 'end_session', receipt: { session, active: false } },
  ]);
  await driver.start();
  for (const { name } of cases) {
    await assert.rejects(driver.listWindows(65120), { code: 'CUA_DRIVER_ERROR', unknownOutcome: true }, name);
  }
  assert.deepEqual(await driver.listWindows(65120), success);
  await driver.end();
  assert.deepEqual(await dispatches(), [
    { command: 'call', tool: 'start_session', args: { session } },
    ...cases.map(() => ({ command: 'call', tool: 'list_windows', args: { pid: 65120, on_screen_only: true } })),
    { command: 'call', tool: 'list_windows', args: { pid: 65120, on_screen_only: true } },
    { command: 'call', tool: 'end_session', args: { session } },
  ]);
});

test('a native tool refusal is rejected even when its CLI exits zero', async t => {
  const { driver, dispatches } = await createFixture(t, 'owned-status-refusal', [
    { tool: 'start_session', receipt: { session: 'owned-status-refusal', active: true } },
    { tool: 'set_value', receipt: { status: 'refused' } },
    { tool: 'end_session', receipt: { session: 'owned-status-refusal', active: false } },
  ]);
  await driver.start();
  try {
    await assert.rejects(driver.call('set_value', { value: 'test' }), {
      code: 'CUA_DRIVER_ERROR', unknownOutcome: true,
    });
  } finally {
    await driver.end();
  }
  assert.deepEqual(await dispatches(), [
    { command: 'call', tool: 'start_session', args: { session: 'owned-status-refusal' } },
    { command: 'call', tool: 'set_value', args: { value: 'test', session: 'owned-status-refusal' } },
    { command: 'call', tool: 'end_session', args: { session: 'owned-status-refusal' } },
  ]);
});

test('zero-exit refusals retain only recognized codes and require explicit cleanup retry', async t => {
  const refusals = [
    {
      tool: 'set_value', args: { value: 'nested-refusal' },
      receipt: {
        status: 'refused',
        refusal: {
          code: 'browser_input_trust_unavailable',
          message: 'sensitive-native-message',
          detail: { token: 'sensitive-native-detail' },
        },
        error: 'sensitive-root-error',
        message: 'sensitive-root-message',
        cause: 'sensitive-root-cause',
      },
      refusalCode: 'browser_input_trust_unavailable',
    },
    {
      tool: 'set_value', args: { value: 'unknown-refusal' },
      receipt: {
        status: 'refused',
        refusal: {
          code: 'sensitive-code: Bearer private-token; $(curl https://private.invalid/token)',
          message: 'sensitive-unknown-message',
          detail: 'sensitive-unknown-detail',
        },
        error: 'sensitive-unknown-error',
      },
    },
    {
      tool: 'set_value', args: { value: 'malformed-refusal' },
      receipt: {
        status: 'refused',
        refusal: {
          code: ['browser_input_trust_unavailable'],
          message: 'sensitive-malformed-message',
          detail: 'sensitive-malformed-detail',
        },
        error: 'sensitive-malformed-error',
      },
    },
    {
      tool: 'end_session', args: {},
      receipt: {
        session: 'owned-refusal', active: false,
        code: 'session_cleanup_pending', cleanup_complete: false,
        message: 'sensitive-cleanup-message',
        detail: 'sensitive-cleanup-detail',
        error: 'sensitive-cleanup-error',
        cause: 'sensitive-cleanup-cause',
      },
      refusalCode: 'session_cleanup_pending',
    },
  ];
  const { driver, dispatches } = await createFixture(t, 'owned-refusal', [
    { tool: 'start_session', receipt: { session: 'owned-refusal', active: true } },
    ...refusals.map(({ tool, receipt }) => ({ tool, receipt })),
    { tool: 'end_session', receipt: { session: 'owned-refusal', active: false } },
  ]);
  await driver.start();
  const expectedDispatches = [
    { command: 'call', tool: 'start_session', args: { session: 'owned-refusal' } },
  ];
  assert.deepEqual(await dispatches(), expectedDispatches);

  for (const { tool, args, refusalCode } of refusals) {
    await assert.rejects(
      tool === 'end_session' ? driver.end() : driver.call(tool, args),
      error => {
        assert.ok(error instanceof Error);
        assert.doesNotMatch(error.message, /sensitive-|private-token|private\.invalid/);
        assert.equal(error.code, 'CUA_DRIVER_ERROR');
        assert.equal(error.unknownOutcome, true);
        assert.equal(error.refusalCode, refusalCode);
        assert.equal('refusalCode' in error, refusalCode !== undefined);
        assert.equal('exitCode' in error, false);
        assert.equal('cause' in error, false);
        assert.doesNotMatch(JSON.stringify(error), /sensitive-|private-token|private\.invalid/);
        assert.doesNotMatch(String(error.stack), /sensitive-|private-token|private\.invalid/);
        return true;
      },
    );
    expectedDispatches.push({ command: 'call', tool, args: { ...args, session: 'owned-refusal' } });
    assert.deepEqual(await dispatches(), expectedDispatches);
  }

  await rejectsWithoutDispatch(driver.call('set_value', { value: 'blocked' }), dispatches, expectedDispatches);
  await rejectsWithoutDispatch(driver.start(), dispatches, expectedDispatches);
  await driver.end();
  const closed = [
    { command: 'call', tool: 'start_session', args: { session: 'owned-refusal' } },
    { command: 'call', tool: 'set_value', args: { value: 'nested-refusal', session: 'owned-refusal' } },
    { command: 'call', tool: 'set_value', args: { value: 'unknown-refusal', session: 'owned-refusal' } },
    { command: 'call', tool: 'set_value', args: { value: 'malformed-refusal', session: 'owned-refusal' } },
    { command: 'call', tool: 'end_session', args: { session: 'owned-refusal' } },
    { command: 'call', tool: 'end_session', args: { session: 'owned-refusal' } },
  ];
  assert.deepEqual(await dispatches(), closed);
  await rejectsWithoutDispatch(driver.call('set_value', { value: 'blocked' }), dispatches, closed);
  await rejectsWithoutDispatch(driver.start(), dispatches, closed);
  await rejectsWithoutDispatch(driver.end(), dispatches, closed);
});

test('normalized action receipts follow retained Unicode text and the requested click route', async t => {
  const session = 'owned-normalized';
  const target = { target_id: 'owned-target', tab_id: 'owned-tab', ref: 'p1:1' };
  const typeArgs = { ...target, text: 'a\u{1F600}e\u0301' }; // Four scalars, five UTF-16 code units.
  const typed = {
    effect: 'unverifiable', route: 'trusted_input',
    delivery: { mode: 'background', delivered_count: 4 },
  };
  const domClick = {
    effect: 'unverifiable', route: 'dom', delivery: { mode: 'background' },
    escalation: { target: 'page', reason: 'effect_unconfirmed' },
  };
  const trustedClick = { effect: 'unverifiable', route: 'trusted_input', delivery: { mode: 'background' } };
  const cases = [
    { tool: 'browser_type', args: typeArgs, receipt: typed, accepted: true },
    ...[
      { ...typed, effect: 'partial' }, // Full count is not full delivery after cleanup failure.
      { ...typed, delivery: { mode: 'background', delivered_count: 5 } },
      { ...typed, route: 'dom' },
      { ...typed, status: 'ok' },
      { ...typed, delivery: { ...typed.delivery, page: { status: 'ok' } } },
      { status: 'ok', ...target, mode: 'insert_text', requested_chars: 4, delivered_chars: 4 },
    ].map(receipt => ({ tool: 'browser_type', args: typeArgs, receipt })),
    { tool: 'browser_click', args: { ...target, input_route: 'dom_event' }, receipt: domClick, accepted: true },
    { tool: 'browser_click', args: target, receipt: trustedClick, accepted: true },
    { tool: 'browser_click', args: { ...target, input_route: 'trusted' }, receipt: trustedClick, accepted: true },
    { tool: 'browser_click', args: { ...target, input_route: 'dom_event' }, receipt: { ...domClick, route: 'trusted_input' } },
    { tool: 'browser_click', args: target, receipt: { ...trustedClick, route: 'dom' } },
    { tool: 'browser_click', args: { ...target, input_route: 'trusted' }, receipt: domClick },
    {
      tool: 'browser_click', args: { ...target, input_route: 'dom_event' },
      receipt: { ...domClick, escalation: { ...domClick.escalation, message: 'page-supplied' } },
    },
    { tool: 'browser_click', args: target, receipt: { status: 'ok' } },
  ];
  const { driver, dispatches } = await createFixture(t, session, [
    { tool: 'start_session', receipt: { session, active: true } },
    ...cases.map(({ tool, receipt }) => ({ tool, receipt })),
    { tool: 'end_session', receipt: { session, active: false } },
  ]);
  await driver.start();
  for (const { tool, args, receipt, accepted } of cases) {
    const mutableArgs = { ...args };
    const operation = driver.call(tool, mutableArgs);
    if (tool === 'browser_type') mutableArgs.text = 'changed after dispatch';
    else mutableArgs.input_route = args.input_route === 'dom_event' ? 'trusted' : 'dom_event';
    if (accepted) assert.deepEqual(await operation, receipt);
    else await assert.rejects(operation, { code: 'CUA_DRIVER_ERROR', unknownOutcome: true });
  }
  await driver.end();
  assert.deepEqual(await dispatches(), [
    { command: 'call', tool: 'start_session', args: { session } },
    ...cases.map(({ tool, args }) => ({ command: 'call', tool, args: { ...args, session } })),
    { command: 'call', tool: 'end_session', args: { session } },
  ]);
});

test('caller session arguments are rejected without consuming new or active state', async t => {
  const { driver, dispatches } = await createFixture(t, 'owned-validation', [
    { tool: 'start_session', receipt: { session: 'owned-validation', active: true } },
    { tool: 'set_value', receipt: { status: 'ok' } },
    { tool: 'set_value', receipt: { status: 'ok' } },
    { tool: 'end_session', receipt: { session: 'owned-validation', active: false } },
  ]);
  for (const session of ['foreign-session', 'owned-validation']) {
    await rejectsWithoutDispatch(driver.start({ session }), dispatches, []);
  }
  await driver.start();
  const started = [
    { command: 'call', tool: 'start_session', args: { session: 'owned-validation' } },
  ];
  assert.deepEqual(await dispatches(), started);

  for (const session of ['foreign-session', 'owned-validation']) {
    await rejectsWithoutDispatch(driver.call('set_value', { session, value: 'blocked' }), dispatches, started);
  }
  await driver.call('set_value', { value: 'after-call-rejection' });
  const afterCall = [
    ...started,
    { command: 'call', tool: 'set_value', args: { value: 'after-call-rejection', session: 'owned-validation' } },
  ];
  assert.deepEqual(await dispatches(), afterCall);

  for (const session of ['foreign-session', 'owned-validation']) {
    await rejectsWithoutDispatch(driver.end({ session }), dispatches, afterCall);
  }
  await driver.call('set_value', { value: 'after-end-rejection' });
  await driver.end();
  assert.deepEqual(await dispatches(), [
    ...afterCall,
    { command: 'call', tool: 'set_value', args: { value: 'after-end-rejection', session: 'owned-validation' } },
    { command: 'call', tool: 'end_session', args: { session: 'owned-validation' } },
  ]);
});

test('a foreign end receipt blocks work until owned cleanup succeeds and closes permanently', async t => {
  const { driver, dispatches } = await createFixture(t, 'owned-cleanup', [
    { tool: 'start_session', receipt: { session: 'owned-cleanup', active: true } },
    { tool: 'end_session', receipt: { session: 'foreign-session', active: false } },
    { tool: 'end_session', receipt: { session: 'owned-cleanup', active: false } },
  ]);
  await driver.start();
  await assert.rejects(driver.end(), { code: 'CUA_DRIVER_ERROR', unknownOutcome: true });
  const uncertain = [
    { command: 'call', tool: 'start_session', args: { session: 'owned-cleanup' } },
    { command: 'call', tool: 'end_session', args: { session: 'owned-cleanup' } },
  ];
  assert.deepEqual(await dispatches(), uncertain);
  await rejectsWithoutDispatch(driver.call('set_value', { value: 'blocked' }), dispatches, uncertain);
  await rejectsWithoutDispatch(driver.start(), dispatches, uncertain);

  await driver.end();
  const closed = [
    ...uncertain,
    { command: 'call', tool: 'end_session', args: { session: 'owned-cleanup' } },
  ];
  assert.deepEqual(await dispatches(), closed);
  await rejectsWithoutDispatch(driver.call('set_value', { value: 'blocked' }), dispatches, closed);
  await rejectsWithoutDispatch(driver.start(), dispatches, closed);
  await rejectsWithoutDispatch(driver.end(), dispatches, closed);
});

test('a foreign start receipt grants no call authority but permits owned cleanup', async t => {
  const { driver, dispatches } = await createFixture(t, 'owned-start', [
    { tool: 'start_session', receipt: { session: 'foreign-session', active: true } },
    { tool: 'end_session', receipt: { session: 'owned-start', active: false } },
  ]);
  await assert.rejects(driver.start(), { code: 'CUA_DRIVER_ERROR', unknownOutcome: true });
  const uncertain = [
    { command: 'call', tool: 'start_session', args: { session: 'owned-start' } },
  ];
  assert.deepEqual(await dispatches(), uncertain);
  await rejectsWithoutDispatch(driver.call('set_value', { value: 'blocked' }), dispatches, uncertain);
  await rejectsWithoutDispatch(driver.start(), dispatches, uncertain);
  await driver.end();
  assert.deepEqual(await dispatches(), [
    ...uncertain,
    { command: 'call', tool: 'end_session', args: { session: 'owned-start' } },
  ]);
});
