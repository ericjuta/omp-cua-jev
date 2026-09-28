import assert from 'node:assert/strict';
import test from 'node:test';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { chmod, lstat, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JOURNAL_SCHEMA, readJournal, writeEntry } from '../src/journal.mjs';
import { listSessions, recoverSessions } from '../src/sessions.mjs';

const journalModule = new URL('../src/journal.mjs', import.meta.url).href;

const secret = 'private-sentinel Bearer token https://private.invalid';
const createdAt = '2026-09-27T10:00:00.000Z';

async function createFixture(t, responses) {
  const directory = await mkdtemp(join(tmpdir(), 'omp-cua-jev-sessions-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const binary = join(directory, 'driver.mjs');
  const log = join(directory, 'dispatch.json');
  const journalDir = join(directory, 'journal');
  await writeFile(log, '[]', { mode: 0o600 });
  // Steps are keyed by tool and label. Unexpected calls exit 97, outside every inactive shape.
  await writeFile(binary, `#!${process.execPath}
import { readFileSync, writeFileSync } from 'node:fs';
const log = ${JSON.stringify(log)};
const responses = ${JSON.stringify(responses)};
let step;
try {
  const [command, tool, json] = process.argv.slice(2);
  const args = JSON.parse(json);
  const dispatches = JSON.parse(readFileSync(log, 'utf8'));
  const key = tool + ' ' + args.session;
  step = responses[key]?.[dispatches.filter(entry => entry.tool + ' ' + entry.args.session === key).length];
  dispatches.push({ command, tool, args });
  writeFileSync(log, JSON.stringify(dispatches));
  if (command !== 'call') step = undefined;
} catch {
  step = undefined;
}
// Another process rewrites (or removes, when null) the entry while this call is in flight.
if (step && Object.hasOwn(step, 'rewrite')) {
  const { removeEntry, writeEntry } = await import(${JSON.stringify(journalModule)});
  const [, , json] = process.argv.slice(2);
  if (step.rewrite === null) await removeEntry(${JSON.stringify(journalDir)}, JSON.parse(json).session);
  else await writeEntry(${JSON.stringify(journalDir)}, step.rewrite);
}
if (!step) process.exit(97);
process.stdout.write(step.stdout ?? JSON.stringify(step.receipt));
if (step.stderr !== undefined) process.stderr.write(step.stderr);
process.exitCode = step.exitCode ?? 0;
`, { mode: 0o700 });
  return {
    directory,
    binary,
    journalDir,
    dispatches: async () => JSON.parse(await readFile(log, 'utf8')),
    journal: (session, pid, fields = {}) => writeEntry(journalDir, {
      schema: JOURNAL_SCHEMA, session, createdAt, updatedAt: createdAt, owner: { pid }, ...fields,
    }),
    labels: async () => (await readJournal(journalDir)).map(entry => entry.session),
  };
}

const active = (session, idle = 1) => ({
  receipt: { session, state: 'active', idle_seconds: idle, expires_in_seconds: 299, client_kind: 'cli', implicit: false },
});
const ended = { stdout: '', exitCode: 1 };
const notStarted = { receipt: { code: 'session_not_started', effect: 'refused' }, exitCode: 1 };
const unreachable = { stdout: '', exitCode: 2 };
const closed = session => ({ receipt: { session, active: false } });

// A reaped child's PID reports ESRCH to signal 0.
async function deadPid() {
  const child = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' });
  await once(child, 'exit');
  assert.throws(() => process.kill(child.pid, 0), { code: 'ESRCH' });
  return child.pid;
}

async function capture(t, prefix = 'omp-cua-jev-native-') {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(join(directory, 'capture.png'), 'capture-bytes');
  return directory;
}

async function exists(path) {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

async function captureBytes(directory) {
  return readFile(join(directory, 'capture.png'), 'utf8');
}

test('listing treats only exact live receipts as active and projects no native data', async t => {
  const dead = await deadPid();
  // Signal 0 to launchd/init is EPERM for ordinary users: that owner still exists.
  if (process.getuid?.() !== 0) assert.throws(() => process.kill(1, 0), { code: 'EPERM' });
  const fixture = await createFixture(t, {
    'get_session active-owned': [{ receipt: { ...active('active-owned', 12.5).receipt, message: secret }, stderr: secret }],
    'get_session empty-exit-two': [unreachable],
    'get_session ended-empty': [{ ...ended, stderr: secret }],
    'get_session failed-active': [{ ...active('failed-active', 900), exitCode: 1 }],
    'get_session foreign-label': [active('other-label', 900)],
    'get_session garbled': [{ stdout: `${secret} {"code":"session_not_started"`, exitCode: 1 }],
    'get_session nested-code': [{
      receipt: { code: 'session_not_started', refusal: { code: 'session_cleanup_pending', message: secret } }, exitCode: 1,
    }],
    'get_session never-started': [{ receipt: { ...notStarted.receipt, message: secret }, exitCode: 1 }],
    'get_session refused-active': [{ receipt: { ...active('refused-active', 900).receipt, effect: 'refused' } }],
  });
  const captureDirectory = join(fixture.directory, 'recorded-capture');
  await fixture.journal('active-owned', process.pid, { target: { pid: 4107, windowId: 71 }, captureDirectory });
  await fixture.journal('ended-empty', dead);
  await fixture.journal('never-started', 1);
  for (const session of ['empty-exit-two', 'failed-active', 'foreign-label', 'garbled', 'nested-code', 'refused-active']) {
    await fixture.journal(session, process.pid);
  }

  const listed = await listSessions({ binary: fixture.binary, journalDir: fixture.journalDir });
  const unknown = session => ({ session, createdAt, ownerAlive: true, status: 'unknown' });
  assert.deepEqual(listed, [
    {
      session: 'active-owned', createdAt, target: { pid: 4107, windowId: 71 }, captureDirectory,
      ownerAlive: true, status: 'active', idleSeconds: 12.5,
    },
    unknown('empty-exit-two'),
    { session: 'ended-empty', createdAt, ownerAlive: false, status: 'inactive' },
    unknown('failed-active'),
    unknown('foreign-label'),
    unknown('garbled'),
    unknown('nested-code'),
    { session: 'never-started', createdAt, ownerAlive: true, status: 'inactive' },
    unknown('refused-active'),
  ]);
  assert.ok(Object.isFrozen(listed) && listed.every(Object.isFrozen) && Object.isFrozen(listed[0].target));
  const sessions = listed.map(entry => entry.session);
  assert.deepEqual(await fixture.dispatches(), sessions.map(session => ({ command: 'call', tool: 'get_session', args: { session } })));
  assert.deepEqual(await fixture.labels(), sessions);
});

test('no-argument listing reads the state-directory journal without creating it', async t => {
  const base = await mkdtemp(join(tmpdir(), 'omp-cua-jev-sessions-state-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const previous = process.env.OMP_CUA_JEV_STATE_DIR;
  t.after(() => {
    if (previous === undefined) delete process.env.OMP_CUA_JEV_STATE_DIR;
    else process.env.OMP_CUA_JEV_STATE_DIR = previous;
  });
  process.env.OMP_CUA_JEV_STATE_DIR = base;
  assert.deepEqual(await listSessions(), []);
  assert.equal(await exists(join(base, 'sessions')), false);
});

test('default recovery ends or removes dead-owner entries and never touches live owners', async t => {
  const dead = await deadPid();
  const fixture = await createFixture(t, {
    'get_session dead-active': [active('dead-active'), active('dead-active')],
    'end_session dead-active': [closed('dead-active')],
    'get_session dead-inactive': [ended],
    'get_session dead-unknown': [unreachable],
    'get_session live-active': [active('live-active', 900)],
    // A live owner's journaled start may not have reached the Driver yet.
    'get_session live-starting': [notStarted],
  });
  const captures = {};
  for (const [session, pid] of [['dead-active', dead], ['dead-inactive', dead], ['dead-unknown', dead], ['live-active', process.pid]]) {
    captures[session] = await capture(t);
    await fixture.journal(session, pid, { captureDirectory: captures[session] });
  }
  await fixture.journal('live-starting', 1);

  const reports = await recoverSessions({ binary: fixture.binary, journalDir: fixture.journalDir });
  assert.deepEqual(reports, [
    { session: 'dead-active', before: 'active', action: 'ended' },
    { session: 'dead-inactive', before: 'inactive', action: 'removed' },
    { session: 'dead-unknown', before: 'unknown', action: 'kept' },
    { session: 'live-active', before: 'active', action: 'skipped' },
    { session: 'live-starting', before: 'inactive', action: 'skipped' },
  ]);
  assert.ok(Object.isFrozen(reports) && reports.every(Object.isFrozen));
  assert.deepEqual((await fixture.dispatches()).filter(({ tool }) => tool !== 'get_session'), [
    { command: 'call', tool: 'end_session', args: { session: 'dead-active' } },
  ]);
  assert.deepEqual(await fixture.labels(), ['dead-unknown', 'live-active', 'live-starting']);
  assert.equal(await exists(captures['dead-active']), false);
  assert.equal(await exists(captures['dead-inactive']), false);
  assert.equal(await captureBytes(captures['dead-unknown']), 'capture-bytes');
  assert.equal(await captureBytes(captures['live-active']), 'capture-bytes');
});

// Mutation targets: act on the listing snapshot, compare only the label, or re-check after acting.
test('entries rewritten or removed after listing are kept untouched', async t => {
  const dead = await deadPid();
  const rewritten = (session, pid, updatedAt, fields = {}) => ({
    schema: JOURNAL_SCHEMA, session, createdAt, updatedAt, owner: { pid }, ...fields,
  });
  const later = '2026-09-27T10:05:00.000Z';
  const captures = { adopted: await capture(t), touched: await capture(t), steady: await capture(t) };
  const fixture = await createFixture(t, {
    // A live process resumed the orphan after listing read the journal.
    'get_session adopted': [{ ...active('adopted'), rewrite: rewritten('adopted', process.pid, later, { captureDirectory: captures.adopted }) }],
    // The same owner pid refreshed its entry.
    'get_session touched': [{ ...ended, rewrite: rewritten('touched', dead, later, { captureDirectory: captures.touched }) }],
    'get_session vanished': [{ ...ended, rewrite: null }],
    'get_session steady': [ended],
  });
  for (const session of ['adopted', 'touched', 'steady']) {
    await fixture.journal(session, dead, { captureDirectory: captures[session] });
  }
  await fixture.journal('vanished', dead);

  const reports = await recoverSessions({ binary: fixture.binary, journalDir: fixture.journalDir });
  const changed = { code: 'ENTRY_CHANGED' };
  assert.deepEqual(reports, [
    { session: 'adopted', before: 'active', action: 'kept', error: changed },
    { session: 'steady', before: 'inactive', action: 'removed' },
    { session: 'touched', before: 'inactive', action: 'kept', error: changed },
    { session: 'vanished', before: 'inactive', action: 'kept', error: changed },
  ]);
  assert.ok(Object.isFrozen(reports) && reports.every(Object.isFrozen) && Object.isFrozen(reports[0].error));
  // Only the listing reads reached the Driver: no resume, no end_session.
  assert.deepEqual((await fixture.dispatches()).map(({ tool, args }) => `${tool} ${args.session}`), [
    'get_session adopted', 'get_session steady', 'get_session touched', 'get_session vanished',
  ]);
  const journal = await readJournal(fixture.journalDir);
  assert.deepEqual(journal.map(({ session, owner, updatedAt }) => [session, owner.pid, updatedAt]), [
    ['adopted', process.pid, later],
    ['touched', dead, later],
  ]);
  assert.equal(await captureBytes(captures.adopted), 'capture-bytes');
  assert.equal(await captureBytes(captures.touched), 'capture-bytes');
  assert.equal(await exists(captures.steady), false);
});

test('an unconfirmed resume or end keeps the entry and capture with only safe codes', async t => {
  const dead = await deadPid();
  const fixture = await createFixture(t, {
    'get_session end-foreign': [active('end-foreign'), active('end-foreign')],
    'end_session end-foreign': [closed('other-label')],
    'get_session end-refused': [active('end-refused'), active('end-refused')],
    'end_session end-refused': [{
      receipt: { code: 'session_cleanup_partial', effect: 'refused', message: secret }, exitCode: 1, stderr: secret,
    }],
    'get_session resume-foreign': [active('resume-foreign'), active('other-label')],
    'get_session resume-stopped': [active('resume-stopped'), notStarted],
  });
  const captures = {};
  for (const session of ['end-foreign', 'end-refused', 'resume-foreign', 'resume-stopped']) {
    captures[session] = await capture(t);
    await fixture.journal(session, dead, { captureDirectory: captures[session] });
  }

  assert.deepEqual(await recoverSessions({ binary: fixture.binary, journalDir: fixture.journalDir }), [
    { session: 'end-foreign', before: 'active', action: 'kept', error: { code: 'CUA_DRIVER_ERROR' } },
    {
      session: 'end-refused', before: 'active', action: 'kept',
      error: { code: 'CUA_DRIVER_ERROR', refusalCode: 'session_cleanup_partial' },
    },
    { session: 'resume-foreign', before: 'active', action: 'kept', error: { code: 'CUA_DRIVER_ERROR' } },
    // Stopped after classification: handled as inactive and never ended.
    { session: 'resume-stopped', before: 'active', action: 'removed' },
  ]);
  const ends = (await fixture.dispatches()).filter(({ tool }) => tool === 'end_session');
  assert.deepEqual(ends.map(({ args }) => args.session), ['end-foreign', 'end-refused']);
  assert.deepEqual(await fixture.labels(), ['end-foreign', 'end-refused', 'resume-foreign']);
  for (const session of ['end-foreign', 'end-refused', 'resume-foreign']) {
    assert.equal(await captureBytes(captures[session]), 'capture-bytes');
  }
  assert.equal(await exists(captures['resume-stopped']), false);
});

test('dry runs and rejected options only read', async t => {
  const dead = await deadPid();
  const fixture = await createFixture(t, {
    'get_session dead-active': [active('dead-active')],
    'get_session dead-inactive': [ended],
    'get_session dead-unknown': [unreachable],
    'get_session live-active': [active('live-active')],
  });
  const captures = [];
  for (const [session, pid] of [['dead-active', dead], ['dead-inactive', dead], ['dead-unknown', dead], ['live-active', process.pid]]) {
    const captureDirectory = await capture(t);
    captures.push(captureDirectory);
    await fixture.journal(session, pid, { captureDirectory });
  }
  const snapshot = async () => {
    const names = (await readdir(fixture.journalDir)).sort();
    return Promise.all(names.map(async name => [name, await readFile(join(fixture.journalDir, name), 'utf8')]));
  };
  const journaled = await snapshot();
  const options = { binary: fixture.binary, journalDir: fixture.journalDir };

  // A mistyped dry-run key or widened selection must fail closed before any read.
  for (const invalid of [{ dryrun: true }, { dryRun: 1 }, { minIdleSeconds: -1 }]) {
    await assert.rejects(recoverSessions({ ...options, ...invalid }), error => {
      assert.equal(error.code, 'SESSIONS_ERROR');
      assert.equal(error.cause, undefined);
      return true;
    });
  }
  assert.deepEqual(await fixture.dispatches(), []);

  assert.deepEqual(await recoverSessions({ ...options, dryRun: true }), [
    { session: 'dead-active', before: 'active', action: 'ended' },
    { session: 'dead-inactive', before: 'inactive', action: 'removed' },
    { session: 'dead-unknown', before: 'unknown', action: 'kept' },
    { session: 'live-active', before: 'active', action: 'skipped' },
  ]);
  assert.deepEqual((await fixture.dispatches()).map(({ tool, args }) => `${tool} ${args.session}`), [
    'get_session dead-active', 'get_session dead-inactive', 'get_session dead-unknown', 'get_session live-active',
  ]);
  assert.deepEqual(await snapshot(), journaled);
  for (const directory of captures) assert.equal(await captureBytes(directory), 'capture-bytes');
});

test('explicit labels and idle thresholds select only journaled entries', async t => {
  const dead = await deadPid();
  const fixture = await createFixture(t, {
    'get_session dead-inactive': [ended],
    'get_session explicit-busy': [active('explicit-busy', 3), active('explicit-busy', 3)],
    'end_session explicit-busy': [closed('explicit-busy')],
    'get_session idle-exact': [active('idle-exact', 300), active('idle-exact', 300)],
    'end_session idle-exact': [closed('idle-exact')],
    'get_session idle-short': [active('idle-short', 299.5)],
  });
  await fixture.journal('dead-inactive', dead);
  for (const session of ['explicit-busy', 'idle-exact', 'idle-short']) await fixture.journal(session, process.pid);

  assert.deepEqual(await recoverSessions({
    binary: fixture.binary, journalDir: fixture.journalDir,
    sessions: ['explicit-busy', 'never-journaled'], ownerDead: false, minIdleSeconds: 300,
  }), [
    { session: 'dead-inactive', before: 'inactive', action: 'skipped' },
    { session: 'explicit-busy', before: 'active', action: 'ended' },
    { session: 'idle-exact', before: 'active', action: 'ended' },
    { session: 'idle-short', before: 'active', action: 'skipped' },
  ]);
  const dispatches = await fixture.dispatches();
  assert.ok(dispatches.every(({ args }) => args.session !== 'never-journaled'));
  assert.deepEqual(dispatches.filter(({ tool }) => tool === 'end_session').map(({ args }) => args.session), [
    'explicit-busy', 'idle-exact',
  ]);
  assert.deepEqual(await fixture.labels(), ['dead-inactive', 'idle-short']);
});

test('an unavailable driver proves nothing and keeps every entry', async t => {
  const dead = await deadPid();
  const fixture = await createFixture(t, {});
  const owned = await capture(t);
  await fixture.journal('dead-owner', dead, { captureDirectory: owned });
  assert.deepEqual(await recoverSessions({ binary: join(fixture.directory, 'missing-driver'), journalDir: fixture.journalDir }), [
    { session: 'dead-owner', before: 'unknown', action: 'kept' },
  ]);
  assert.deepEqual(await fixture.labels(), ['dead-owner']);
  assert.equal(await captureBytes(owned), 'capture-bytes');
});

test('capture cleanup removes only owned tmpdir directories and never follows links', async t => {
  const dead = await deadPid();
  const labels = ['linked-prefix', 'missing-capture', 'nested-prefix', 'owned-links', 'wrong-prefix'];
  const fixture = await createFixture(t, Object.fromEntries(labels.map(session => [`get_session ${session}`, [ended]])));
  // Directly under tmpdir, but without the owned name prefix.
  const outside = await capture(t, 'omp-cua-jev-sessions-outside-');
  const owned = await capture(t);
  await symlink(outside, join(owned, 'outside-directory'), 'dir');
  await symlink(join(outside, 'capture.png'), join(owned, 'outside-file'));
  const nested = join(fixture.directory, 'omp-cua-jev-native-nested');
  await mkdir(nested);
  await writeFile(join(nested, 'capture.png'), 'capture-bytes');
  const linked = join(tmpdir(), `omp-cua-jev-native-link-${randomUUID()}`);
  await symlink(outside, linked, 'dir');
  t.after(() => rm(linked, { force: true }));
  await fixture.journal('linked-prefix', dead, { captureDirectory: linked });
  await fixture.journal('missing-capture', dead, { captureDirectory: join(tmpdir(), `omp-cua-jev-native-missing-${randomUUID()}`) });
  await fixture.journal('nested-prefix', dead, { captureDirectory: nested });
  await fixture.journal('owned-links', dead, { captureDirectory: owned });
  await fixture.journal('wrong-prefix', dead, { captureDirectory: outside });

  // Unowned paths are not honoured, so their entries are still removed.
  assert.deepEqual(
    await recoverSessions({ binary: fixture.binary, journalDir: fixture.journalDir }),
    labels.map(session => ({ session, before: 'inactive', action: 'removed' })),
  );
  assert.deepEqual(await fixture.labels(), []);
  assert.equal(await exists(owned), false);
  assert.equal(await captureBytes(outside), 'capture-bytes');
  assert.equal(await captureBytes(nested), 'capture-bytes');
  assert.ok((await lstat(linked)).isSymbolicLink());
});

test('failed local cleanup keeps entries for a later retry', { skip: process.getuid?.() === 0 }, async t => {
  const dead = await deadPid();
  const fixture = await createFixture(t, {
    'get_session ended-locked': [active('ended-locked'), active('ended-locked'), ended, ended],
    'end_session ended-locked': [closed('ended-locked')],
    'get_session inactive-locked': [ended, ended, ended],
  });
  const captures = [];
  const locks = [];
  for (const session of ['ended-locked', 'inactive-locked']) {
    const captureDirectory = await capture(t);
    const lock = join(captureDirectory, 'locked');
    await mkdir(lock);
    await writeFile(join(lock, 'frame.png'), 'locked-bytes');
    captures.push(captureDirectory);
    locks.push(lock);
    await fixture.journal(session, dead, { captureDirectory });
  }
  const options = { binary: fixture.binary, journalDir: fixture.journalDir };
  try {
    for (const lock of locks) await chmod(lock, 0o500);
    assert.deepEqual(await recoverSessions(options), [
      { session: 'ended-locked', before: 'active', action: 'ended', error: { code: 'CAPTURE_CLEANUP_ERROR' } },
      { session: 'inactive-locked', before: 'inactive', action: 'kept', error: { code: 'CAPTURE_CLEANUP_ERROR' } },
    ]);
    assert.deepEqual(await fixture.labels(), ['ended-locked', 'inactive-locked']);
    for (const lock of locks) await chmod(lock, 0o700);
    await chmod(fixture.journalDir, 0o500);
    assert.deepEqual(await recoverSessions(options), [
      { session: 'ended-locked', before: 'inactive', action: 'kept', error: { code: 'JOURNAL_ERROR' } },
      { session: 'inactive-locked', before: 'inactive', action: 'kept', error: { code: 'JOURNAL_ERROR' } },
    ]);
  } finally {
    for (const lock of locks) await chmod(lock, 0o700).catch(() => {});
    await chmod(fixture.journalDir, 0o700);
  }
  assert.deepEqual(await fixture.labels(), ['ended-locked', 'inactive-locked']);
  assert.deepEqual(await recoverSessions(options), [
    { session: 'ended-locked', before: 'inactive', action: 'removed' },
    { session: 'inactive-locked', before: 'inactive', action: 'removed' },
  ]);
  assert.deepEqual(await fixture.labels(), []);
  for (const directory of captures) assert.equal(await exists(directory), false);
});
