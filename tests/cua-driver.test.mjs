import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
console.log(JSON.stringify(step.receipt));
`, { mode: 0o700 });
  return {
    driver: createCuaDriver({ binary: executable, session }),
    dispatches: async () => JSON.parse(await readFile(log, 'utf8')),
  };
}

async function rejectsWithoutDispatch(operation, dispatches, expected) {
  await assert.rejects(operation, { code: 'CUA_DRIVER_ERROR', unknownOutcome: false });
  assert.deepEqual(await dispatches(), expected);
}

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
