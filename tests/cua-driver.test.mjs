import assert from 'node:assert/strict';
import test from 'node:test';
import { lstat, mkdir, mkdtemp, readdir, readFile, realpath, symlink, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inspect } from 'node:util';
import { runInNewContext } from 'node:vm';
import { createCuaDriver } from '../src/cua-driver.mjs';
import { JOURNAL_SCHEMA, readEntry, updateEntry, writeEntry } from '../src/journal.mjs';

const journalModule = new URL('../src/journal.mjs', import.meta.url).href;

// Every fixture journals into its own temporary directory, never the user's state directory.
// A step's delayMs sleeps after its dispatch is logged; childEvents() then reports that child's
// pid, any catchable signal it received, and whether its sleep finished.
async function createFixture(t, session, steps, statuses = []) {
  const directory = await mkdtemp(join(tmpdir(), 'omp-cua-jev-driver-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const executable = join(directory, 'driver.mjs');
  const log = join(directory, 'dispatch.json');
  const statusLog = join(directory, 'status.json');
  const childLog = join(directory, 'child.json');
  const journalDir = join(directory, 'journal');
  await writeFile(log, '[]', { mode: 0o600 });
  await writeFile(statusLog, '0', { mode: 0o600 });
  await writeFile(childLog, '[]', { mode: 0o600 });
  await writeFile(executable, `#!${process.execPath}
import { readFileSync, writeFileSync } from 'node:fs';
const log = ${JSON.stringify(log)};
const steps = ${JSON.stringify(steps)};
const [command, tool, json] = process.argv.slice(2);
if (command === 'status') {
// Ownership probes consume their own scripted responses, never call steps.
const statusLog = ${JSON.stringify(statusLog)};
const statuses = ${JSON.stringify(statuses)};
const probes = JSON.parse(readFileSync(statusLog, 'utf8'));
writeFileSync(statusLog, JSON.stringify(probes + 1));
const status = statuses[probes];
if (status === undefined) {
  process.exitCode = 97;
} else {
  process.stdout.write(status.stdout);
  if (status.stderr !== undefined) process.stderr.write(status.stderr);
  process.exitCode = status.exitCode ?? 0;
}
} else {
const dispatches = JSON.parse(readFileSync(log, 'utf8'));
const step = steps[dispatches.length];
const dispatch = { command, tool, args: JSON.parse(json) };
if (step?.journal) {
  // Observe the owned journal entry at the moment the native request arrives.
  const { readEntry } = await import(${JSON.stringify(journalModule)});
  dispatch.journaled = (await readEntry(${JSON.stringify(journalDir)}, ${JSON.stringify(session)})) !== null;
}
dispatches.push(dispatch);
writeFileSync(log, JSON.stringify(dispatches));
if (command !== 'call' || !step || tool !== step.tool) throw new Error('Unexpected fixture dispatch.');
if (step.delayMs !== undefined) {
  // After the dispatch log write, so a killed child still counts as dispatched. Catchable kill
  // signals are recorded and ignored, so only SIGKILL can end this bounded sleep early.
  const childLog = ${JSON.stringify(childLog)};
  const record = event => writeFileSync(childLog, JSON.stringify([...JSON.parse(readFileSync(childLog, 'utf8')), event]));
  const handlers = ['SIGTERM', 'SIGINT', 'SIGHUP'].map(signal => [signal, () => record({ signal })]);
  for (const [signal, handler] of handlers) process.on(signal, handler);
  record({ pid: process.pid });
  await new Promise(resolve => setTimeout(resolve, step.delayMs));
  for (const [signal, handler] of handlers) process.off(signal, handler);
  record({ slept: step.delayMs });
}
process.stdout.write(step.stdout ?? JSON.stringify(step.receipt));
if (step.stderr !== undefined) process.stderr.write(step.stderr);
process.exitCode = step.exitCode ?? 0;
}
`, { mode: 0o700 });
  return {
    directory,
    binary: executable,
    journalDir,
    driver: createCuaDriver({ binary: executable, session, journalDir }),
    dispatches: async () => JSON.parse(await readFile(log, 'utf8')),
    statusProbes: async () => JSON.parse(await readFile(statusLog, 'utf8')),
    childEvents: async () => JSON.parse(await readFile(childLog, 'utf8')),
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
    // A failed process still reports a recognized code from its success-shaped receipt.
    {
      receipt: { status: 'ok', code: 'browser_route_unavailable', message: secret },
      refusalCode: 'browser_route_unavailable', exitCode: 37,
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
  for (const [operation, tool] of [
    [driver.listWindows(65120), 'list_windows'],
    [driver.call('set_value', { value: 'blocked-while-focusing' }), 'set_value'],
    [driver.end(), 'end_session'],
    [driver.call('private-sentinel invalid', {}), undefined],
  ]) {
    await assert.rejects(operation, error => {
      assert.equal(error.message, tool === undefined
        ? 'Cua Driver request failed.' : `Cua Driver ${tool} request failed.`);
      assert.equal(error.tool, tool);
      assert.equal(error.code, 'CUA_DRIVER_ERROR');
      assert.equal(error.unknownOutcome, false);
      for (const field of ['exitCode', 'refusalCode', 'hint', 'cause']) {
        assert.equal(Object.hasOwn(error, field), false);
      }
      assert.doesNotMatch(inspect(error, { showHidden: true, depth: null }), /private-sentinel/);
      return true;
    });
  }
  assert.deepEqual(await focusing, verifiedFocus);
  assert.deepEqual(await dispatches(), [
    { command: 'call', tool: 'start_session', args: { session } },
    { command: 'call', tool: 'bring_to_front', args: target },
  ]);
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
    ['list_windows', 'listOnScreenWindows', { on_screen_only: true }],
    ['bring_to_front', 'bringToFront', target],
    ['get_screen_size', 'screenSize', {}],
    ['get_session', 'getSession', {}],
    ['start_session', 'resume', {}],
    ['end_session', 'end', {}],
  ]) {
    await assert.rejects(driver.call(tool, args), error => {
      assert.equal(error.code, 'CUA_DRIVER_ERROR');
      assert.equal(error.unknownOutcome, false);
      assert.equal(error.tool, tool);
      assert.equal(error.message, `Cua Driver ${tool} request failed.`);
      assert.equal(typeof error.hint, 'string');
      assert.ok(error.hint.includes(`${method}(`));
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
  // Driver 0.30.2 adds a root summary string; it is the only extra field the closed shapes allow.
  const summary = 'typed 4 char(s)';
  const cases = [
    { tool: 'browser_type', args: typeArgs, receipt: typed, accepted: true },
    { tool: 'browser_type', args: typeArgs, receipt: { ...typed, summary }, accepted: true },
    ...[
      { ...typed, effect: 'partial' }, // Full count is not full delivery after cleanup failure.
      { ...typed, delivery: { mode: 'background', delivered_count: 5 } },
      { ...typed, route: 'dom' },
      { ...typed, status: 'ok' },
      { ...typed, summary: 4 },
      { ...typed, summary, status: 'ok' },
      { ...typed, delivery: { ...typed.delivery, page: { status: 'ok' } } },
      { status: 'ok', ...target, mode: 'insert_text', requested_chars: 4, delivered_chars: 4 },
    ].map(receipt => ({ tool: 'browser_type', args: typeArgs, receipt })),
    { tool: 'browser_click', args: { ...target, input_route: 'dom_event' }, receipt: domClick, accepted: true },
    {
      tool: 'browser_click', args: { ...target, input_route: 'dom_event' },
      receipt: { ...domClick, summary: 'clicked' }, accepted: true,
    },
    { tool: 'browser_click', args: target, receipt: trustedClick, accepted: true },
    { tool: 'browser_click', args: target, receipt: { ...trustedClick, summary: 'clicked' }, accepted: true },
    { tool: 'browser_click', args: target, receipt: { ...trustedClick, summary: null } },
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

// Mutation targets: drop a native code or hint, lose codes on nonzero exits, or accept effect:refused.
test('native refusal envelopes name the tool and expose only allowlisted codes with static hints', async t => {
  const session = 'owned-native-refusals';
  const secret = 'private-sentinel Bearer token https://private.invalid';
  const cases = [
    {
      name: 'consumed capture',
      receipt: { code: 'capture_not_found', effect: 'refused', message: secret }, exitCode: 1,
      refusalCode: 'capture_not_found', hint: /get_window_state.*THIS session/,
    },
    {
      name: 'zero-exit refused effect',
      receipt: { code: 'capture_coordinate_invalid', effect: 'refused', summary: secret },
      refusalCode: 'capture_coordinate_invalid', hint: /capture bounds/,
    },
    {
      name: 'moved window',
      receipt: { code: 'window_owner_pid_mismatch', effect: 'refused', detail: secret }, exitCode: 1,
      refusalCode: 'window_owner_pid_mismatch', hint: /re-discover/i,
    },
    {
      name: 'ambiguous keyboard target',
      receipt: { code: 'same_pid_keyboard_ambiguity', effect: 'refused' }, exitCode: 1,
      refusalCode: 'same_pid_keyboard_ambiguity', hint: /set_value/,
    },
    {
      name: 'permission gate code',
      receipt: { code: 'permissions_pending', effect: 'refused', message: secret }, exitCode: 75,
      refusalCode: 'permissions_pending', hint: /cua-driver-tcc-gate-fix.*do not bypass/,
    },
    { name: 'permission gate exit without receipt', stdout: '', exitCode: 75, hint: /cua-driver-tcc-gate-fix/ },
    {
      name: 'unknown native code',
      receipt: { code: 'private-sentinel-native-code', effect: 'refused', message: secret }, exitCode: 1,
    },
    { name: 'unrecognized zero-exit refusal', receipt: { code: 'capture_unrecognized', effect: 'refused' } },
  ];
  const { driver, dispatches } = await createFixture(t, session, [
    { tool: 'start_session', receipt: { session, active: true } },
    ...cases.map(({ receipt, stdout, exitCode }) => ({ tool: 'click', receipt, stdout, exitCode, stderr: secret })),
    { tool: 'end_session', receipt: { session, active: false } },
  ]);
  await driver.start();
  const request = { pid: 65120, window_id: 15216, x: 40, y: 60, capture_id: 'capture_owned_0000000000000005' };
  for (const { name, refusalCode, exitCode, hint } of cases) {
    await assert.rejects(driver.call('click', request), error => {
      assertPrivateFailure(error, { refusalCode, exitCode, hint: hint !== undefined });
      assert.equal(error.tool, 'click');
      assert.equal(error.message, refusalCode === undefined
        ? 'Cua Driver click request failed.'
        : `Cua Driver click request refused: ${refusalCode}.`);
      if (hint !== undefined) assert.match(error.hint, hint);
      return true;
    }, name);
  }
  // Caller-supplied names that fail validation are never echoed.
  await assert.rejects(driver.call('private-sentinel-tool'), error => {
    assertPrivateFailure(error, { unknownOutcome: false });
    assert.equal(error.tool, undefined);
    assert.equal(error.message, 'Cua Driver request failed.');
    return true;
  });
  await driver.end();
  assert.deepEqual(await dispatches(), [
    { command: 'call', tool: 'start_session', args: { session } },
    ...cases.map(() => ({ command: 'call', tool: 'click', args: { ...request, session } })),
    { command: 'call', tool: 'end_session', args: { session } },
  ]);
});

// Mutation targets: drop a perception or Driver 0.31.0 code or hint, take hints from native text, or relax a safe hint.
test('perception and Driver 0.31.0 refusal codes expose static, conservative hints from root or nested envelopes', async t => {
  const session = 'owned-perception-refusals';
  const secret = 'private-sentinel Bearer token https://private.invalid';
  const parse = {
    capture_id: 'capture_owned_0000000000000007',
    options: { kinds: ['text'], max_regions: 32, min_confidence: 0.5 },
  };
  const element = { pid: 65120, window_id: 15216, element_token: 'element_token_owned_0001' };
  // Safety anchors only where the code settles the next step; every hint must also be static.
  const fresh = /get_window_state.*THIS session/;
  const operator = /operator/;
  const stop = /Stop using the extension/;
  const partial = /Do not act from a partial result; observe again before any bounded retry/;
  const noRescale = /never rescale/;
  const alreadyAuthorized = /only where already authorized/;
  const cases = [
    ...[
      ['not_installed', operator, /tasks never install/],
      ['capture_not_found', fresh],
      ['capture_expired', fresh],
      ['capture_stale', fresh],
      ['capture_generation_mismatch', fresh],
      ['unsupported_target', alreadyAuthorized],
      ['unsupported_platform', alreadyAuthorized],
      ['incompatible_protocol', operator, stop],
      ['artifact_invalid', operator, stop],
      ['invalid_frame', noRescale],
      ['resource_limit_exceeded', noRescale],
      ['worker_launch_failed', partial],
      ['worker_crashed', partial],
      ['worker_cancelled', partial],
      ['timeout', /outcome is unknown/, partial, /Never replay a mutation/],
      ['inference_failed', partial],
    ].map(([code, ...hints]) => ({ code, hints, tool: 'parse_visual_regions', args: parse })),
    ...[
      ['invalid_arguments', /do not resend/],
      ['stale_element_token', fresh, /do not replay/],
    ].map(([code, ...hints]) => ({ code, hints, tool: 'click', args: element })),
  ];
  // Each code arrives twice with different native text: in cua-perception's root
  // {code, message, retryable} envelope and in the nested {refusal:{code, message}} shape
  // that Driver 0.31.0 uses for element-token codes.
  const { driver, dispatches } = await createFixture(t, session, [
    { tool: 'start_session', receipt: { session, active: true } },
    ...cases.flatMap(({ code, tool }) => [
      { tool, receipt: { code, message: secret, retryable: false }, exitCode: 1, stderr: secret },
      {
        tool, exitCode: 1,
        receipt: { refusal: { code, message: 'private-sentinel other', hint: 'private-sentinel native hint' }, retryable: true },
      },
    ]),
    { tool: 'end_session', receipt: { session, active: false } },
  ]);
  await driver.start();
  for (const { code, hints, tool, args } of cases) {
    const received = [];
    for (const envelope of ['root', 'nested']) {
      await assert.rejects(driver.call(tool, args), error => {
        assertPrivateFailure(error, { refusalCode: code, exitCode: 1, hint: true });
        assert.equal(error.tool, tool);
        assert.equal(error.message, `Cua Driver ${tool} request refused: ${code}.`);
        received.push(error.hint);
        return true;
      }, `${code} ${envelope}`);
    }
    // Static: the code alone selects the hint, whatever the envelope or native text.
    assert.equal(received[1], received[0], code);
    for (const pattern of hints) assert.match(received[0], pattern, code);
  }
  await driver.end();
  assert.deepEqual(await dispatches(), [
    { command: 'call', tool: 'start_session', args: { session } },
    ...cases.flatMap(({ tool, args }) => [
      { command: 'call', tool, args: { ...args, session } },
      { command: 'call', tool, args: { ...args, session } },
    ]),
    { command: 'call', tool: 'end_session', args: { session } },
  ]);
});

// Mutation targets: expose unknown or removed codes, read a code from stderr or partial JSON, or accept non-record output.
test('unknown, removed, and malformed refusal output stays private without a code or hint', async t => {
  const session = 'owned-private-envelopes';
  const secret = 'private-sentinel Bearer token https://private.invalid';
  const parse = { capture_id: 'capture_owned_0000000000000008' };
  const element = { pid: 65120, window_id: 15216, element_token: 'element_token_owned_0002' };
  const cases = [
    {
      name: 'unknown root code', tool: 'parse_visual_regions', exitCode: 1,
      receipt: { code: 'private-sentinel-perception', message: secret, retryable: false },
    },
    // Driver 0.31.0 rejects element_index/snapshot_id outright, so their former codes are not allowlisted.
    {
      name: 'removed snapshot code', tool: 'click', exitCode: 1,
      receipt: { code: 'snapshot_id_required', effect: 'refused', message: secret },
    },
    {
      name: 'removed element index code', tool: 'click', exitCode: 1,
      receipt: { refusal: { code: 'element_index_required', message: secret } },
    },
    { name: 'non-string code', tool: 'parse_visual_regions', receipt: { code: ['not_installed'], message: secret }, exitCode: 1 },
    { name: 'array envelope', tool: 'parse_visual_regions', stdout: '[{"code":"not_installed"}]', exitCode: 1 },
    { name: 'truncated envelope', tool: 'parse_visual_regions', stdout: `{"code":"not_installed","message":"${secret}`, exitCode: 1 },
    { name: 'trailing output', tool: 'parse_visual_regions', stdout: `{"code":"not_installed"} ${secret}`, exitCode: 1 },
    { name: 'empty output', tool: 'parse_visual_regions', stdout: '', exitCode: 1 },
    { name: 'zero-exit non-record', tool: 'parse_visual_regions', stdout: 'null' },
  ];
  const { driver, dispatches } = await createFixture(t, session, [
    { tool: 'start_session', receipt: { session, active: true } },
    // stderr always names an allowlisted code; only a fully parsed stdout envelope may.
    ...cases.map(({ tool, receipt, stdout, exitCode }) => ({
      tool, receipt, stdout, exitCode, stderr: JSON.stringify({ code: 'not_installed', message: secret }),
    })),
    { tool: 'end_session', receipt: { session, active: false } },
  ]);
  await driver.start();
  for (const { name, tool, exitCode } of cases) {
    await assert.rejects(driver.call(tool, tool === 'click' ? element : parse), error => {
      assertPrivateFailure(error, { exitCode });
      assert.equal(error.tool, tool);
      assert.equal(error.message, `Cua Driver ${tool} request failed.`);
      return true;
    }, name);
  }
  await driver.end();
  assert.deepEqual(await dispatches(), [
    { command: 'call', tool: 'start_session', args: { session } },
    ...cases.map(({ tool }) => ({ command: 'call', tool, args: { ...(tool === 'click' ? element : parse), session } })),
    { command: 'call', tool: 'end_session', args: { session } },
  ]);
});

// Mutation targets: dispatch install_extension, let arguments or options bypass the reservation, or spend the session.
test('install_extension is refused locally for the operator while the active session stays usable', async t => {
  const session = 'owned-install-reserved';
  const { driver, dispatches } = await createFixture(t, session, [
    { tool: 'start_session', receipt: { session, active: true } },
    { tool: 'set_value', receipt: { status: 'ok' } },
    { tool: 'end_session', receipt: { session, active: false } },
  ]);
  await driver.start();
  const started = [{ command: 'call', tool: 'start_session', args: { session } }];
  for (const operation of [
    () => driver.call('install_extension', { name: 'perception' }),
    () => driver.call('install_extension', { name: 'perception', catalog: '/tmp/private-sentinel.catalog.json' }),
    () => driver.call('install_extension', { name: 'perception' }, { timeoutMs: 1_000 }),
    () => driver.call('install_extension'),
  ]) {
    await assert.rejects(operation(), error => {
      assertPrivateFailure(error, { hint: true, unknownOutcome: false });
      assert.equal(error.tool, 'install_extension');
      assert.equal(error.message, 'Cua Driver install_extension request failed.');
      assert.match(error.hint, /operator-only/);
      assert.match(error.hint, /Never install from a task or chooser/);
      return true;
    });
    assert.deepEqual(await dispatches(), started);
  }
  assert.deepEqual(await driver.call('set_value', { value: 'after-install-refusal' }), { status: 'ok' });
  await driver.end();
  assert.deepEqual(await dispatches(), [
    ...started,
    { command: 'call', tool: 'set_value', args: { value: 'after-install-refusal', session } },
    { command: 'call', tool: 'end_session', args: { session } },
  ]);
});

// Mutation targets: accept widened, inherited, accessor, proxy, or non-plain options, run a getter, or refuse explicit undefined.
test('call options are exactly an own plain timeoutMs record and fail locally otherwise', async t => {
  const session = 'owned-call-options';
  const ok = { status: 'ok' };
  // Explicit undefined is omission; null-prototype and cross-realm records are plain; the bound is inclusive.
  const accepted = [
    undefined,
    { timeoutMs: 2 ** 31 - 1 },
    Object.assign(Object.create(null), { timeoutMs: 20_000 }),
    runInNewContext('({ timeoutMs: 20000 })'),
  ];
  const { driver, dispatches } = await createFixture(t, session, [
    { tool: 'start_session', receipt: { session, active: true } },
    ...accepted.map(() => ({ tool: 'set_value', receipt: ok })),
    { tool: 'end_session', receipt: { session, active: false } },
  ]);
  await driver.start();
  const started = [{ command: 'call', tool: 'start_session', args: { session } }];
  let reads = 0;
  for (const options of [
    null, [], 1_000, '1000', true,
    {}, { timeout: 1_000 },
    { timeoutMs: 1_000, extra: true }, { timeoutMs: 1_000, session },
    { timeoutMs: 1_000, [Symbol('extra')]: true },
    Object.defineProperty({ timeoutMs: 1_000 }, 'extra', { value: true }),
    Object.defineProperty({}, 'timeoutMs', { value: 1_000 }),
    { get timeoutMs() { reads += 1; return 1_000; } },
    new Proxy({ timeoutMs: 1_000 }, {}),
    Object.create({ timeoutMs: 1_000 }),
    new (class Options { constructor() { this.timeoutMs = 1_000; } })(),
    Object.assign([], { timeoutMs: 1_000 }),
    ...[undefined, null, '1000', true, 1_000n, 0, -1, 1.5, 2 ** 31, Number.NaN, Infinity].map(timeoutMs => ({ timeoutMs })),
  ]) {
    await rejectsWithoutDispatch(driver.call('set_value', { value: 'blocked' }, options), dispatches, started);
  }
  // Validation reads descriptors only; the getter never runs.
  assert.equal(reads, 0);
  for (const [index, options] of accepted.entries()) {
    assert.deepEqual(await driver.call('set_value', { value: `accepted-${index}` }, options), ok);
  }
  await driver.end();
  assert.deepEqual(await dispatches(), [
    ...started,
    ...accepted.map((_, index) => ({ command: 'call', tool: 'set_value', args: { value: `accepted-${index}`, session } })),
    { command: 'call', tool: 'end_session', args: { session } },
  ]);
});

// Mutation targets: ignore or keep the per-call timeout, kill with a catchable signal, or leave the child running.
test('a call-local timeout SIGKILLs only its sleeping child and the next call keeps the instance default', { timeout: 30_000 }, async t => {
  const session = 'owned-call-timeout';
  const request = { capture_id: 'capture_owned_0000000000000009', options: { kinds: ['text'] } };
  const visual = { schema: 'cua.visual_regions_v1', regions: [] };
  const { binary, journalDir, dispatches, childEvents } = await createFixture(t, session, [
    { tool: 'start_session', receipt: { session, active: true } },
    // Margins, not thresholds: the 1.5 s override leaves room for child startup and logging; this
    // child would answer after 5 s, inside the 10 s default, if the override were ignored; the next
    // one outlives that override by 1.5 s yet ends 7 s inside the default.
    { tool: 'parse_visual_regions', receipt: visual, delayMs: 5_000 },
    { tool: 'parse_visual_regions', receipt: visual, delayMs: 3_000 },
    { tool: 'end_session', receipt: { session, active: false } },
  ]);
  const driver = createCuaDriver({ binary, session, journalDir, timeoutMs: 10_000 });
  await driver.start();
  await assert.rejects(driver.call('parse_visual_regions', request, { timeoutMs: 1_500 }), error => {
    // A killed child leaves no exit code, receipt, or refusal; its native outcome stays unknown.
    assertPrivateFailure(error);
    assert.equal(error.tool, 'parse_visual_regions');
    return true;
  });
  const [started, ...afterStart] = await childEvents();
  // The child logged its dispatch and began sleeping. No catchable signal arrived, the sleep never
  // finished, and the process is gone: only SIGKILL ends a child that way.
  assert.deepEqual(afterStart, []);
  assert.throws(() => process.kill(started.pid, 0), { code: 'ESRCH' });
  assert.deepEqual(await driver.call('parse_visual_regions', request), visual);
  assert.deepEqual((await childEvents()).slice(2), [{ slept: 3_000 }]);
  await driver.end();
  assert.deepEqual(await dispatches(), [
    { command: 'call', tool: 'start_session', args: { session } },
    { command: 'call', tool: 'parse_visual_regions', args: { ...request, session } },
    { command: 'call', tool: 'parse_visual_regions', args: { ...request, session } },
    { command: 'call', tool: 'end_session', args: { session } },
  ]);
});

// Mutation targets: journal after dispatch, drop uncertain entries, or keep entries after confirmed cleanup.
test('start journals before dispatch, keeps uncertain sessions recoverable, and removes the entry after confirmed end', async t => {
  const session = 'owned-journal-lifecycle';
  const { driver, dispatches, journalDir } = await createFixture(t, session, [
    { tool: 'start_session', stdout: '', exitCode: 1, journal: true },
    { tool: 'end_session', receipt: { session: 'foreign-session', active: false }, journal: true },
    { tool: 'end_session', receipt: { session, active: false }, journal: true },
  ]);
  assert.equal(await readEntry(journalDir, session), null);
  await assert.rejects(driver.start(), error => assertPrivateFailure(error, { exitCode: 1 }));
  const entry = await readEntry(journalDir, session);
  assert.equal(entry.schema, 'omp-cua-jev-session-v1');
  assert.equal(entry.session, session);
  assert.deepEqual(entry.owner, { pid: process.pid });
  await assert.rejects(driver.end(), { code: 'CUA_DRIVER_ERROR', unknownOutcome: true });
  assert.deepEqual(await readEntry(journalDir, session), entry);
  await driver.end();
  assert.equal(await readEntry(journalDir, session), null);
  assert.deepEqual(await dispatches(), [
    { command: 'call', tool: 'start_session', args: { session }, journaled: true },
    { command: 'call', tool: 'end_session', args: { session }, journaled: true },
    { command: 'call', tool: 'end_session', args: { session }, journaled: true },
  ]);
});

test('a start whose journal entry cannot be written is never dispatched', async t => {
  const session = 'owned-journal-blocked';
  const { binary, directory, dispatches } = await createFixture(t, session, [
    { tool: 'start_session', receipt: { session, active: true } },
    { tool: 'end_session', receipt: { session, active: false } },
  ]);
  const blocker = join(directory, 'private-sentinel-journal-parent');
  await writeFile(blocker, 'not a directory');
  const journalDir = join(blocker, 'journal');
  const driver = createCuaDriver({ binary, session, journalDir });
  await assert.rejects(driver.start(), error => {
    assertPrivateFailure(error, { hint: true, unknownOutcome: false });
    assert.equal(error.tool, 'start_session');
    return true;
  });
  assert.deepEqual(await dispatches(), []);
  // Nothing reached the Driver, so the single start attempt remains once the journal is writable.
  await rm(blocker);
  await mkdir(blocker);
  await driver.start();
  assert.equal((await readEntry(journalDir, session))?.session, session);
  await driver.end();
  assert.deepEqual(await dispatches(), [
    { command: 'call', tool: 'start_session', args: { session } },
    { command: 'call', tool: 'end_session', args: { session } },
  ]);
});

// Mutation targets: replace an existing entry, dispatch anyway, spend the attempt, or leave temp files.
test('start never replaces an existing journal entry and leaves the instance unspent', async t => {
  const session = 'owned-journaled';
  const { driver, binary, journalDir, dispatches } = await createFixture(t, session, [
    { tool: 'start_session', receipt: { session: 'owned-fresh', active: true } },
    { tool: 'end_session', receipt: { session: 'owned-fresh', active: false } },
    { tool: 'start_session', receipt: { session: 'owned-race', active: true } },
  ]);
  const hint = 'This session label is already journaled. Use resume() to continue your own orphan or recoverSessions() to end it; do not start() it again.';
  const createdAt = '2026-09-27T10:00:00.000Z';
  await writeEntry(journalDir, {
    schema: JOURNAL_SCHEMA, session, createdAt, updatedAt: createdAt, owner: { pid: 99999 },
  });
  // Even an unreadable file at the final name is never replaced.
  const malformed = join(journalDir, 'owned-malformed.json');
  await writeFile(malformed, 'private-sentinel not an entry', { mode: 0o600 });
  const entryPath = join(journalDir, `${session}.json`);
  const bytes = await readFile(entryPath, 'utf8');
  const journaled = error => {
    assertPrivateFailure(error, { hint: true, unknownOutcome: false });
    assert.equal(error.tool, 'start_session');
    assert.equal(error.hint, hint);
    return true;
  };
  // A second start still sees the journaled hint: the first attempt did not spend the instance.
  for (let attempt = 0; attempt < 2; attempt += 1) await assert.rejects(driver.start(), journaled);
  await assert.rejects(createCuaDriver({ binary, session: 'owned-malformed', journalDir }).start(), journaled);
  assert.equal(await readFile(entryPath, 'utf8'), bytes);
  assert.equal(await readFile(malformed, 'utf8'), 'private-sentinel not an entry');
  assert.deepEqual(await dispatches(), []);

  const fresh = createCuaDriver({ binary, session: 'owned-fresh', journalDir });
  await fresh.start();
  assert.deepEqual((await readEntry(journalDir, 'owned-fresh'))?.owner, { pid: process.pid });
  await fresh.end();
  // Concurrent starts of one label: exactly one journals and dispatches.
  const outcomes = await Promise.allSettled([
    createCuaDriver({ binary, session: 'owned-race', journalDir }).start(),
    createCuaDriver({ binary, session: 'owned-race', journalDir }).start(),
  ]);
  assert.deepEqual(outcomes.map(({ status }) => status).sort(), ['fulfilled', 'rejected']);
  assert.ok(journaled(outcomes.find(({ status }) => status === 'rejected').reason));
  assert.deepEqual(await dispatches(), [
    { command: 'call', tool: 'start_session', args: { session: 'owned-fresh' } },
    { command: 'call', tool: 'end_session', args: { session: 'owned-fresh' } },
    { command: 'call', tool: 'start_session', args: { session: 'owned-race' } },
  ]);
  // No temporary file survives; only complete entries are visible.
  assert.deepEqual((await readdir(journalDir)).sort(), [`${session}.json`, 'owned-malformed.json', 'owned-race.json']);
});

// Mutation targets: dispatch ownership, accept caller-forged owners, or recreate an ended entry.
test('ownership records are closed-shape local journal updates for an active instance only', async t => {
  const session = 'owned-ownership';
  const { driver, dispatches, journalDir, directory } = await createFixture(t, session, [
    { tool: 'start_session', receipt: { session, active: true } },
    { tool: 'end_session', receipt: { session, active: false } },
  ]);
  const target = { pid: 65120, windowId: 15216 };
  const captureDirectory = join(directory, 'omp-cua-jev-native-capture');
  await rejectsWithoutDispatch(driver.recordOwnership({ target }), dispatches, []);
  await driver.start();
  const started = [{ command: 'call', tool: 'start_session', args: { session } }];
  const { createdAt } = await readEntry(journalDir, session);
  for (const args of [
    {},
    null,
    { target: { pid: 65120 } },
    { target: { ...target, windowId: 0 } },
    { target: { ...target, window_id: 15216 } },
    { captureDirectory: 'relative-capture' },
    { captureDirectory: 7 },
    { target, owner: { pid: 1 } },
    { target, session },
  ]) {
    await rejectsWithoutDispatch(driver.recordOwnership(args), dispatches, started);
  }
  await rejectsWithoutDispatch(driver.recordOwnership({ target }, { captureDirectory }), dispatches, started);
  await driver.recordOwnership({ target });
  await driver.recordOwnership({ captureDirectory });
  const entry = await readEntry(journalDir, session);
  assert.deepEqual(entry.target, target);
  assert.equal(entry.captureDirectory, captureDirectory);
  assert.deepEqual(entry.owner, { pid: process.pid });
  assert.equal(entry.createdAt, createdAt);
  await driver.end();
  await rejectsWithoutDispatch(driver.recordOwnership({ target }), dispatches, [
    ...started,
    { command: 'call', tool: 'end_session', args: { session } },
  ]);
  assert.equal(await readEntry(journalDir, session), null);
});

test('journal:false keeps explicit-label lifecycles but writes no state', async t => {
  const session = 'owned-unjournaled';
  const { binary, directory, dispatches } = await createFixture(t, session, [
    { tool: 'get_session', receipt: { session, state: 'active', idle_seconds: 4 } },
    { tool: 'end_session', receipt: { session, active: false } },
  ]);
  const journalDir = join(directory, 'unused-journal');
  for (const options of [{ journal: 'false' }, { journalDir: 'relative-journal' }, { journalDir: 7 }]) {
    assert.throws(() => createCuaDriver({ binary, session, ...options }), { code: 'CUA_DRIVER_ERROR' });
  }
  const driver = createCuaDriver({ binary, session, journal: false, journalDir });
  await driver.resume();
  await driver.recordOwnership({ target: { pid: 65120, windowId: 15216 } });
  await driver.end();
  await assert.rejects(lstat(journalDir), { code: 'ENOENT' });
  assert.deepEqual(await dispatches(), [
    { command: 'call', tool: 'get_session', args: { session } },
    { command: 'call', tool: 'end_session', args: { session } },
  ]);
});

// Mutation targets: resume without the journal, accept a reused lifecycle, or keep a dead owner.
test('resume adopts only a journaled active session and records this process as owner', async t => {
  const session = 'owned-resume';
  const active = {
    session, state: 'active', idle_seconds: 12, expires_in_seconds: 288, client_kind: 'cli', implicit: false,
  };
  const { driver, dispatches, journalDir, directory } = await createFixture(t, session, [
    { tool: 'get_session', receipt: active },
    { tool: 'set_value', receipt: { status: 'ok' } },
    { tool: 'end_session', receipt: { session, active: false } },
  ]);
  const createdAt = '2026-09-27T00:00:00.000Z';
  const target = { pid: 65120, windowId: 15216 };
  const captureDirectory = join(directory, 'omp-cua-jev-native-resumed');
  await writeEntry(journalDir, {
    schema: 'omp-cua-jev-session-v1', session, createdAt, updatedAt: createdAt,
    owner: { pid: 99999 }, target, captureDirectory,
  });
  await rejectsWithoutDispatch(driver.call('set_value', { value: 'before-resume' }), dispatches, []);
  await rejectsWithoutDispatch(driver.getSession(), dispatches, []);
  await rejectsWithoutDispatch(driver.resume({ session: 'foreign-session' }), dispatches, []);
  assert.deepEqual(await driver.resume(), active);
  const entry = await readEntry(journalDir, session);
  assert.deepEqual(entry.owner, { pid: process.pid });
  assert.equal(entry.createdAt, createdAt);
  assert.deepEqual(entry.target, target);
  assert.equal(entry.captureDirectory, captureDirectory);
  const resumed = [{ command: 'call', tool: 'get_session', args: { session } }];
  await rejectsWithoutDispatch(driver.resume(), dispatches, resumed);
  await rejectsWithoutDispatch(driver.start(), dispatches, resumed);
  await driver.call('set_value', { value: 'after-resume' });
  await driver.end();
  assert.equal(await readEntry(journalDir, session), null);
  assert.deepEqual(await dispatches(), [
    ...resumed,
    { command: 'call', tool: 'set_value', args: { value: 'after-resume', session } },
    { command: 'call', tool: 'end_session', args: { session } },
  ]);
});

// Mutation targets: fall back to start, retry get_session, accept inactive/foreign receipts, or drop the entry.
test('failed resumes close the instance and leave journaled sessions to recovery', async t => {
  const secret = 'private-sentinel Bearer token https://private.invalid';
  const cases = [
    {
      name: 'unknown label', session: 'resume-not-started',
      receipt: { code: 'session_not_started', message: secret }, exitCode: 1, refusalCode: 'session_not_started',
    },
    { name: 'ended label', session: 'resume-ended', stdout: '', exitCode: 1 },
    { name: 'inactive state', session: 'resume-inactive', receipt: { session: 'resume-inactive', state: 'inactive' } },
    { name: 'foreign session', session: 'resume-foreign', receipt: { session: 'foreign-session', state: 'active' } },
    {
      name: 'refused effect', session: 'resume-refused',
      receipt: { session: 'resume-refused', state: 'active', effect: 'refused' },
    },
  ];
  const { binary, journalDir, dispatches } = await createFixture(t, undefined, cases.map(({ receipt, stdout, exitCode }) => ({
    tool: 'get_session', receipt, stdout, exitCode, stderr: secret,
  })));
  const expected = [];
  for (const driver of [
    createCuaDriver({ binary, session: 'resume-unjournaled', journalDir }),
    createCuaDriver({ binary, journalDir }),
  ]) {
    await assert.rejects(driver.resume(), error => {
      assertPrivateFailure(error, { hint: true, unknownOutcome: false });
      assert.equal(error.tool, 'get_session');
      return true;
    });
    // A failed resume never falls back to starting the same label.
    await rejectsWithoutDispatch(driver.start(), dispatches, expected);
  }
  assert.equal(await readEntry(journalDir, 'resume-unjournaled'), null);

  const createdAt = new Date().toISOString();
  for (const { name, session, refusalCode, exitCode } of cases) {
    await writeEntry(journalDir, {
      schema: 'omp-cua-jev-session-v1', session, createdAt, updatedAt: createdAt, owner: { pid: 99999 },
    });
    const driver = createCuaDriver({ binary, session, journalDir });
    await assert.rejects(driver.resume(), error => {
      assertPrivateFailure(error, { refusalCode, exitCode, hint: true });
      assert.equal(error.tool, 'get_session');
      return true;
    }, name);
    expected.push({ command: 'call', tool: 'get_session', args: { session } });
    for (const operation of [
      () => driver.resume(),
      () => driver.start(),
      () => driver.getSession(),
      () => driver.call('set_value', { value: 'blocked' }),
      () => driver.recordOwnership({ target: { pid: 65120, windowId: 15216 } }),
      () => driver.end(),
    ]) {
      await rejectsWithoutDispatch(operation(), dispatches, expected);
    }
    // The previous owner's entry stays intact for recovery.
    assert.deepEqual((await readEntry(journalDir, session))?.owner, { pid: 99999 });
  }
});

// Mutation targets: let reads grant authority, accept another label, or read before start.
test('getSession reads only this label while active or uncertain and grants no authority', async t => {
  const session = 'owned-session-read';
  const active = { session, state: 'active', idle_seconds: 2, expires_in_seconds: 298 };
  const { driver, dispatches } = await createFixture(t, session, [
    { tool: 'start_session', receipt: { session: 'foreign-session', active: true } },
    { tool: 'get_session', receipt: active },
    { tool: 'get_session', receipt: { ...active, session: 'foreign-session' } },
    { tool: 'end_session', receipt: { session, active: false } },
  ]);
  await rejectsWithoutDispatch(driver.getSession(), dispatches, []);
  await assert.rejects(driver.start(), { code: 'CUA_DRIVER_ERROR', unknownOutcome: true });
  assert.deepEqual(await driver.getSession(), active);
  await assert.rejects(driver.getSession(), error => {
    assertPrivateFailure(error);
    assert.equal(error.tool, 'get_session');
    return true;
  });
  const uncertain = [
    { command: 'call', tool: 'start_session', args: { session } },
    { command: 'call', tool: 'get_session', args: { session } },
    { command: 'call', tool: 'get_session', args: { session } },
  ];
  // An active read after an uncertain start is evidence, not session authority.
  await rejectsWithoutDispatch(driver.call('set_value', { value: 'blocked' }), dispatches, uncertain);
  await rejectsWithoutDispatch(driver.getSession({ session: 'foreign-session' }), dispatches, uncertain);
  await driver.end();
  await rejectsWithoutDispatch(driver.getSession(), dispatches, [
    ...uncertain,
    { command: 'call', tool: 'end_session', args: { session } },
  ]);
});

// Mutation targets: return raw records, keep titles, accept malformed geometry, or run while inactive.
test('on-screen windows are frozen occlusion projections without titles or app names', async t => {
  const session = 'owned-occlusion';
  const record = {
    app_name: 'private-sentinel App', bounds: { x: -1440, y: 25, width: 1440, height: 875 },
    current_space_id: 3, is_on_screen: true, layer: 0, on_current_space: true,
    pid: 65120, space_ids: [3], title: 'private-sentinel Title', window_id: 15216, z_index: 7,
  };
  // Unknown z-order, whether null or omitted, projects to null.
  const nullOrder = { ...record, pid: 70001, window_id: 15217, z_index: null, bounds: { x: 0, y: 0, width: 800.5, height: 600 } };
  const absentOrder = { ...record, pid: 70002, window_id: 15218 };
  delete absentOrder.z_index;
  const cases = [
    { name: 'missing bounds', windows: [{ ...record, bounds: undefined }] },
    { name: 'fractional z order', windows: [{ ...record, z_index: 1.5 }] },
    { name: 'string z order', windows: [{ ...record, z_index: '7' }] },
    { name: 'negative width', windows: [{ ...record, bounds: { ...record.bounds, width: -1 } }] },
    { name: 'invalid owner PID', windows: [{ ...record, pid: 0 }] },
    { name: 'off-screen record', windows: [{ ...record, is_on_screen: false }] },
    { name: 'duplicate window', windows: [record, { ...record }] },
    { name: 'non-array windows', windows: record },
  ];
  const { driver, dispatches } = await createFixture(t, session, [
    { tool: 'start_session', receipt: { session, active: true } },
    ...cases.map(({ windows }) => ({ tool: 'list_windows', receipt: { windows } })),
    { tool: 'list_windows', receipt: { windows: [record, nullOrder, absentOrder] } },
    { tool: 'end_session', receipt: { session, active: false } },
  ]);
  await rejectsWithoutDispatch(driver.listOnScreenWindows(), dispatches, []);
  await driver.start();
  const started = [{ command: 'call', tool: 'start_session', args: { session } }];
  await rejectsWithoutDispatch(driver.listOnScreenWindows({ on_screen_only: false }), dispatches, started);
  for (const { name } of cases) {
    await assert.rejects(driver.listOnScreenWindows(), error => {
      assertPrivateFailure(error);
      assert.equal(error.tool, 'list_windows');
      return true;
    }, name);
  }
  const listing = driver.listOnScreenWindows();
  await Promise.all([
    driver.listOnScreenWindows(),
    driver.call('set_value', { value: 'blocked-while-listing' }),
  ].map(operation => assert.rejects(operation, { code: 'CUA_DRIVER_ERROR', unknownOutcome: false })));
  const windows = await listing;
  assert.deepEqual(windows, [
    { window_id: 15216, pid: 65120, driver_owned: false, bounds: { x: -1440, y: 25, width: 1440, height: 875 }, z_index: 7 },
    { window_id: 15217, pid: 70001, driver_owned: false, bounds: { x: 0, y: 0, width: 800.5, height: 600 }, z_index: null },
    { window_id: 15218, pid: 70002, driver_owned: false, bounds: { x: -1440, y: 25, width: 1440, height: 875 }, z_index: null },
  ]);
  assert.ok(Object.isFrozen(windows));
  assert.ok(windows.every(window => Object.isFrozen(window) && Object.isFrozen(window.bounds)));
  assert.doesNotMatch(inspect(windows, { showHidden: true, depth: null }), /private-sentinel/);
  await driver.end();
  const onScreen = { command: 'call', tool: 'list_windows', args: { on_screen_only: true } };
  assert.deepEqual(await dispatches(), [
    ...started,
    ...cases.map(() => onScreen),
    onScreen,
    { command: 'call', tool: 'end_session', args: { session } },
  ]);
});

// Mutation targets: inject the session, return the raw receipt, accept non-positive sizes, or run while inactive.
test('screen size is a sessionless, frozen main-display projection of positive finite fields', async t => {
  const session = 'owned-screen-size';
  const size = { height: 1080, scale_factor: 2.0, width: 1920 };
  const cases = [
    { name: 'zero width', receipt: { ...size, width: 0 } },
    { name: 'negative height', receipt: { ...size, height: -1080 } },
    { name: 'zero scale', receipt: { ...size, scale_factor: 0 } },
    { name: 'infinite width', stdout: '{"height":1080,"scale_factor":2,"width":1e400}' },
    { name: 'string height', receipt: { ...size, height: '1080' } },
    { name: 'null scale', receipt: { ...size, scale_factor: null } },
    { name: 'missing width', receipt: { height: 1080, scale_factor: 2 } },
    { name: 'error receipt', receipt: { ...size, error: 'private-sentinel' } },
    { name: 'refusal', receipt: { code: 'permission_required', effect: 'refused' }, exitCode: 1, refusalCode: 'permission_required', exitCodeSeen: 1 },
    { name: 'failed exit', receipt: size, exitCode: 2, exitCodeSeen: 2 },
  ];
  const { driver, dispatches } = await createFixture(t, session, [
    { tool: 'start_session', receipt: { session, active: true } },
    ...cases.map(({ receipt, stdout, exitCode }) => ({ tool: 'get_screen_size', receipt, stdout, exitCode, stderr: 'private-sentinel' })),
    { tool: 'get_screen_size', receipt: { ...size, summary: 'private-sentinel display' } },
    { tool: 'end_session', receipt: { session, active: false } },
  ]);
  await rejectsWithoutDispatch(driver.screenSize(), dispatches, []);
  await driver.start();
  const started = [{ command: 'call', tool: 'start_session', args: { session } }];
  await rejectsWithoutDispatch(driver.screenSize({}), dispatches, started);
  for (const { name, refusalCode, exitCodeSeen } of cases) {
    await assert.rejects(driver.screenSize(), error => {
      assertPrivateFailure(error, { refusalCode, exitCode: exitCodeSeen, hint: refusalCode !== undefined });
      assert.equal(error.tool, 'get_screen_size');
      return true;
    }, name);
  }
  const reading = driver.screenSize();
  await Promise.all([
    driver.screenSize(),
    driver.listOnScreenWindows(),
  ].map(operation => assert.rejects(operation, { code: 'CUA_DRIVER_ERROR', unknownOutcome: false })));
  const measured = await reading;
  assert.deepEqual(measured, size);
  assert.ok(Object.isFrozen(measured));
  assert.doesNotMatch(inspect(measured, { showHidden: true, depth: null }), /private-sentinel/);
  await driver.end();
  await rejectsWithoutDispatch(driver.screenSize(), dispatches, [
    ...started,
    ...cases.map(() => ({ command: 'call', tool: 'get_screen_size', args: {} })),
    { command: 'call', tool: 'get_screen_size', args: {} },
    { command: 'call', tool: 'end_session', args: { session } },
  ]);
});

// Mutation targets: mark by app name, trust a failed or ambiguous status, skip the cache, or probe outside listOnScreenWindows.
test('on-screen windows mark only daemon-pid records as driver-owned and cache only a successful status read', async t => {
  const session = 'owned-driver-overlay';
  const running = 'Cua Driver daemon is running\n';
  const visible = { current_space_id: 3, is_on_screen: true, layer: 0, on_current_space: true, space_ids: [3], title: 'private-sentinel Title' };
  const overlay = { ...visible, app_name: 'Cua Driver', pid: 47412, window_id: 6306, z_index: 4, bounds: { x: 0, y: -360, width: 5120, height: 1440 } };
  const target = { ...visible, app_name: 'private-sentinel App', pid: 65120, window_id: 15216, z_index: 3, bounds: { x: 100, y: 80, width: 800, height: 600 } };
  // Same app name, different pid: ownership comes from the daemon pid alone.
  const decoy = { ...visible, app_name: 'Cua Driver', pid: 47413, window_id: 6307, z_index: 5, bounds: { x: 0, y: 0, width: 400, height: 300 } };
  const screen = { tool: 'list_windows', receipt: { windows: [overlay, target, decoy] } };
  const { driver, dispatches, statusProbes } = await createFixture(t, session, [
    { tool: 'start_session', receipt: { session, active: true } },
    { tool: 'list_windows', receipt: { windows: [{ pid: 65120, window_id: 15216, is_on_screen: true }] } },
    { tool: 'set_value', receipt: { status: 'ok' } },
    screen, screen, screen, screen, screen,
    { tool: 'end_session', receipt: { session, active: false } },
  ], [
    // A failed status proves nothing, even with a pid line.
    { stdout: `${running}  pid: 47412\n`, exitCode: 1 },
    { stdout: `${running}  pid: 47412\n  pid: 65120\n` },
    { stdout: running },
    { stdout: `${running}  pid: 47412\n`, stderr: 'private-sentinel' },
  ]);
  const projections = owned => [
    { window_id: 6306, pid: 47412, bounds: { x: 0, y: -360, width: 5120, height: 1440 }, z_index: 4, driver_owned: owned },
    { window_id: 15216, pid: 65120, bounds: { x: 100, y: 80, width: 800, height: 600 }, z_index: 3, driver_owned: false },
    { window_id: 6307, pid: 47413, bounds: { x: 0, y: 0, width: 400, height: 300 }, z_index: 5, driver_owned: false },
  ];
  await rejectsWithoutDispatch(driver.listOnScreenWindows(), dispatches, []);
  assert.equal(await statusProbes(), 0);
  await driver.start();
  await driver.listWindows(65120);
  await driver.call('set_value', { value: 'x' });
  assert.equal(await statusProbes(), 0);
  // Failed, ambiguous, and absent status reads leave ownership unknown and are retried.
  for (const probes of [1, 2, 3]) {
    const windows = await driver.listOnScreenWindows();
    assert.deepEqual(windows, projections(false));
    assert.ok(Object.isFrozen(windows) && windows.every(window => Object.isFrozen(window) && Object.isFrozen(window.bounds)));
    assert.equal(await statusProbes(), probes);
  }
  // A fifth probe would exit 97 and leave the overlay unowned.
  for (let list = 0; list < 2; list += 1) {
    const windows = await driver.listOnScreenWindows();
    assert.deepEqual(windows, projections(true));
    assert.ok(Object.isFrozen(windows) && windows.every(window => Object.isFrozen(window) && Object.isFrozen(window.bounds)));
    assert.doesNotMatch(inspect(windows, { showHidden: true, depth: null }), /private-sentinel/);
    assert.equal(await statusProbes(), 4);
  }
  await driver.end();
  const onScreen = { command: 'call', tool: 'list_windows', args: { on_screen_only: true } };
  assert.deepEqual(await dispatches(), [
    { command: 'call', tool: 'start_session', args: { session } },
    { command: 'call', tool: 'list_windows', args: { pid: 65120, on_screen_only: true } },
    { command: 'call', tool: 'set_value', args: { value: 'x', session } },
    onScreen, onScreen, onScreen, onScreen, onScreen,
    { command: 'call', tool: 'end_session', args: { session } },
  ]);
  assert.equal(await statusProbes(), 4);
});

// OMP eval kernels give module object literals and module globals different realms, so the
// driver's own journal records arrive with a foreign Object.prototype.
// Mutation targets: compare prototypes by identity, or accept any object shape.
test('journal records from another realm are accepted while non-plain records still fail', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'omp-cua-jev-driver-realm-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const journalDir = join(directory, 'journal');
  const session = 'foreign-realm';
  const createdAt = '2026-09-27T10:00:00.000Z';
  const fields = `schema: ${JSON.stringify(JOURNAL_SCHEMA)}, session: '${session}', createdAt: '${createdAt}',
    updatedAt: '${createdAt}', owner: { pid: ${process.pid} }`;
  await writeEntry(journalDir, runInNewContext(`({ ${fields} })`));
  await updateEntry(journalDir, session, runInNewContext('({ target: { pid: 4107, windowId: 71 } })'));
  const stored = await readEntry(journalDir, session);
  assert.equal(stored.createdAt, createdAt);
  assert.deepEqual(stored.owner, { pid: process.pid });
  assert.deepEqual(stored.target, { pid: 4107, windowId: 71 });
  for (const source of [
    `new (class Entry { constructor() { Object.assign(this, { ${fields} }); } })()`,
    `new Proxy({ ${fields} }, {})`,
  ]) {
    await assert.rejects(writeEntry(journalDir, runInNewContext(source)), { code: 'JOURNAL_ERROR' });
  }
  await assert.rejects(
    updateEntry(journalDir, session, { target: runInNewContext('new (class Target { constructor() { this.pid = 1; this.windowId = 2; } })()') }),
    { code: 'JOURNAL_ERROR' },
  );
  assert.deepEqual((await readEntry(journalDir, session)).target, { pid: 4107, windowId: 71 });
});
