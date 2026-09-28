import { execFile } from 'node:child_process';
import { rm } from 'node:fs/promises';
import { isProxy } from 'node:util/types';
import { createCuaDriver } from './cua-driver.mjs';
import { journalDirectory, ownedCaptureDirectory, readEntry, readJournal, removeEntry } from './journal.mjs';

const TIMEOUT_MS = 20_000;
const MAX_BUFFER = 1024 * 1024;
const LIST_OPTIONS = new Set(['binary', 'journalDir']);
const RECOVER_OPTIONS = new Set(['binary', 'journalDir', 'sessions', 'ownerDead', 'minIdleSeconds', 'dryRun']);
const PLANNED = Object.freeze({ active: 'ended', inactive: 'removed', unknown: 'kept' });

function failure() {
  const error = new Error('Cua Driver session journal request failed.');
  error.code = 'SESSIONS_ERROR';
  return error;
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) && !isProxy(value);
}

// Closed options: a mistyped key such as `dryrun` must never widen a recovery.
function closedOptions(options, allowed) {
  if (!isRecord(options) || !Object.keys(options).every(key => allowed.has(key))) throw failure();
  const { binary = 'cua-driver', journalDir } = options;
  if (typeof binary !== 'string' || !binary.trim() || binary.includes('\0')) throw failure();
  return { binary, directory: journalDirectory(journalDir) };
}

function validLabel(value) {
  return typeof value === 'string' && /^[a-z][a-z0-9_-]{0,63}$/.test(value) && value !== 'default';
}

function ownerAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM proves a process exists under another user; only ESRCH proves the owner is gone.
    return error?.code !== 'ESRCH';
  }
}

// Read-only classification needs the exit/stdout distinction that driver errors keep private.
function getSession(binary, session) {
  return new Promise(resolve => {
    try {
      execFile(binary, ['call', 'get_session', JSON.stringify({ session })], {
        shell: false,
        encoding: 'utf8',
        timeout: TIMEOUT_MS,
        maxBuffer: MAX_BUFFER,
        killSignal: 'SIGKILL',
      }, (error, stdout) => {
        resolve({ stdout: typeof stdout === 'string' ? stdout : '', failed: Boolean(error), exitCode: error?.code });
      });
    } catch {
      resolve({ stdout: '', failed: true });
    }
  });
}

function rejected(receipt) {
  return Object.hasOwn(receipt, 'error') || Object.hasOwn(receipt, 'refusal') ||
    (Object.hasOwn(receipt, 'isError') && receipt.isError !== false) || receipt.success === false ||
    receipt.status === 'error' || receipt.status === 'refused' || receipt.effect === 'refused';
}

// Only a successful exact-label active receipt is live. Only the observed 0.30.2 exit-1 shapes
// prove absence: session_not_started for an unknown label, empty stdout for an ended one.
function classify(session, { stdout, failed, exitCode }) {
  let receipt;
  try {
    receipt = JSON.parse(stdout);
  } catch {
    receipt = undefined;
  }
  const record = isRecord(receipt);
  if (!failed) {
    if (!record || rejected(receipt) || receipt.session !== session || receipt.state !== 'active') {
      return { status: 'unknown' };
    }
    const idle = receipt.idle_seconds;
    return Number.isFinite(idle) && idle >= 0 ? { status: 'active', idleSeconds: idle } : { status: 'active' };
  }
  if (exitCode !== 1) return { status: 'unknown' };
  if (stdout.trim() === '') return { status: 'inactive' };
  if (!record || (Object.hasOwn(receipt, 'session') && receipt.session !== session)) return { status: 'unknown' };
  const refusal = receipt.refusal;
  const code = isRecord(refusal) && Object.hasOwn(refusal, 'code') ? refusal.code : receipt.code;
  return { status: code === 'session_not_started' ? 'inactive' : 'unknown' };
}

// `snapshots`, when given, receives each listed label's journal entry for later re-checks.
async function observe(binary, directory, snapshots) {
  const listed = [];
  for (const entry of await readJournal(directory)) {
    snapshots?.set(entry.session, entry);
    const record = { session: entry.session, createdAt: entry.createdAt };
    if (entry.target !== undefined) {
      record.target = Object.freeze({ pid: entry.target.pid, windowId: entry.target.windowId });
    }
    if (entry.captureDirectory !== undefined) record.captureDirectory = entry.captureDirectory;
    record.ownerAlive = ownerAlive(entry.owner.pid);
    const { status, idleSeconds } = classify(entry.session, await getSession(binary, entry.session));
    record.status = status;
    if (idleSeconds !== undefined) record.idleSeconds = idleSeconds;
    listed.push(Object.freeze(record));
  }
  return Object.freeze(listed);
}

function report(session, before, action, error) {
  return Object.freeze(error === undefined
    ? { session, before, action }
    : { session, before, action, error: Object.freeze(error) });
}

function driverError(error) {
  const refusalCode = error?.refusalCode;
  return typeof refusalCode === 'string'
    ? { code: 'CUA_DRIVER_ERROR', refusalCode }
    : { code: 'CUA_DRIVER_ERROR' };
}

// resume() re-checks the exact label immediately before ending; a label that stopped since
// classification is handled as inactive.
async function resumed(driver) {
  try {
    await driver.resume();
    return true;
  } catch (error) {
    if (error?.refusalCode === 'session_not_started') return false;
    throw error;
  }
}

// The entry must still be the one selection saw: same owner pid and updatedAt.
async function unchanged(directory, snapshot) {
  try {
    const current = await readEntry(directory, snapshot.session);
    return current !== null && current.owner.pid === snapshot.owner.pid && current.updatedAt === snapshot.updatedAt;
  } catch {
    return false;
  }
}

async function recover(binary, directory, { session, status, captureDirectory }, snapshot) {
  if (status === 'unknown') return report(session, status, 'kept');
  if (!await unchanged(directory, snapshot)) return report(session, status, 'kept', { code: 'ENTRY_CHANGED' });
  let ended = false;
  if (status === 'active') {
    try {
      const driver = createCuaDriver({ binary, session, journal: false });
      if (await resumed(driver)) {
        // The driver accepts only a matching inactive end_session receipt.
        await driver.end();
        ended = true;
      }
    } catch (error) {
      return report(session, status, 'kept', driverError(error));
    }
  }
  const settled = ended ? 'ended' : 'kept';
  try {
    // Unowned, unsafe, or missing directories are not honoured. Remove only the canonical owned
    // directory; recursive rm unlinks nested symlinks without following them.
    const owned = captureDirectory === undefined ? null : await ownedCaptureDirectory(captureDirectory);
    if (owned !== null) await rm(owned, { recursive: true, force: true });
  } catch {
    return report(session, status, settled, { code: 'CAPTURE_CLEANUP_ERROR' });
  }
  try {
    await removeEntry(directory, session);
  } catch {
    return report(session, status, settled, { code: 'JOURNAL_ERROR' });
  }
  return report(session, status, ended ? 'ended' : 'removed');
}

/**
 * Read-only journal inventory. Each journaled label gets one shell-free, bounded get_session.
 * Only a successful receipt for the exact label with state:'active' is active (idleSeconds when
 * native idle_seconds is a finite non-negative number); exit 1 with session_not_started or empty
 * stdout is inactive; anything else is unknown. ownerAlive uses signal 0: only ESRCH is dead.
 * Returns frozen `{session, createdAt, target?, captureDirectory?, ownerAlive, status,
 * idleSeconds?}` records in journal order. Native fields and output never appear.
 * Invalid options or unreadable journals throw `SESSIONS_ERROR` without causes.
 */
export async function listSessions(options = {}) {
  try {
    const { binary, directory } = closedOptions(options, LIST_OPTIONS);
    return await observe(binary, directory);
  } catch {
    throw failure();
  }
}

/**
 * Recovers journaled sessions only; labels absent from the journal are never contacted.
 * Selects entries whose label is in `sessions`, whose owner is dead (`ownerDead`, default true),
 * or whose active idleSeconds reaches `minIdleSeconds`. Returns one frozen
 * `{session, before, action, error?}` report per journal entry, where before is the listed status:
 * - ended: an active label was resumed and its end_session confirmed in this run;
 * - removed: an inactive entry (or one that stopped before resume) was removed;
 * - kept: nothing was removed (unknown status, failed resume/end, or failed inactive cleanup);
 * - skipped: not selected.
 * An owned captureDirectory (canonical, directly under the canonical tmpdir, named
 * omp-cua-jev-native-*) is removed before its entry; other recorded paths are left untouched.
 * Immediately before acting, each selected entry is re-read; a missing entry or one whose owner
 * pid or updatedAt changed since listing is kept untouched with `{code:'ENTRY_CHANGED'}`.
 * Errors keep the entry: `{code:'CUA_DRIVER_ERROR', refusalCode?}` for resume/end,
 * `{code:'CAPTURE_CLEANUP_ERROR'}` or `{code:'JOURNAL_ERROR'}` for local cleanup.
 * `dryRun` only reads (journal, liveness, get_session): selected entries report the planned
 * action (active ended, inactive removed, unknown kept); nothing is ended, deleted, or written.
 */
export async function recoverSessions(options = {}) {
  let binary;
  let directory;
  let labels;
  let ownerDead;
  let minIdleSeconds;
  let dryRun;
  let listed;
  const snapshots = new Map();
  try {
    ({ binary, directory } = closedOptions(options, RECOVER_OPTIONS));
    let sessions;
    ({ sessions = [], ownerDead = true, minIdleSeconds, dryRun = false } = options);
    if (!Array.isArray(sessions) || isProxy(sessions) || typeof ownerDead !== 'boolean' ||
        typeof dryRun !== 'boolean' ||
        (minIdleSeconds !== undefined && !(Number.isFinite(minIdleSeconds) && minIdleSeconds >= 0))) {
      throw failure();
    }
    labels = new Set();
    for (let index = 0; index < sessions.length; index += 1) {
      const label = sessions[index];
      if (!validLabel(label)) throw failure();
      labels.add(label);
    }
    listed = await observe(binary, directory, snapshots);
  } catch {
    throw failure();
  }
  const reports = [];
  for (const entry of listed) {
    const selected = labels.has(entry.session) || (ownerDead && !entry.ownerAlive) ||
      (minIdleSeconds !== undefined && entry.idleSeconds !== undefined && entry.idleSeconds >= minIdleSeconds);
    if (!selected) reports.push(report(entry.session, entry.status, 'skipped'));
    else if (dryRun) reports.push(report(entry.session, entry.status, PLANNED[entry.status]));
    else reports.push(await recover(binary, directory, entry, snapshots.get(entry.session)));
  }
  return Object.freeze(reports);
}
