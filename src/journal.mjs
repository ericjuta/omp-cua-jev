import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { chmod, link, lstat, mkdir, open, readdir, realpath, rename, unlink } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join } from 'node:path';
import { isProxy } from 'node:util/types';

// Local ownership journal for Cua Driver sessions. One `<session>.json` per label in a
// private (0700, current-uid) directory; files are 0600 and replaced atomically. Reads never
// create the directory, never follow a symlinked directory or entry, and ignore anything
// that is not a closed, valid entry.

export const JOURNAL_SCHEMA = 'omp-cua-jev-session-v1';

const MAX_ENTRY_BYTES = 64 * 1024;
const MAX_PATH_LENGTH = 4096;
const CAPTURE_PREFIX = 'omp-cua-jev-native-';
const ENTRY_FILE = /^([a-z][a-z0-9_-]{0,63})\.json$/;
const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const ENTRY_KEYS = new Set(['schema', 'session', 'createdAt', 'updatedAt', 'owner', 'target', 'captureDirectory']);
const UPDATE_KEYS = new Set(['target', 'captureDirectory']);
const READ_FLAGS = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
const WRITE_FLAGS = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW;

function journalError(message) {
  const error = new Error(`Cua session journal ${message}.`);
  error.code = 'JOURNAL_ERROR';
  return error;
}

const objectPrototypes = new WeakSet([Object.prototype]);
const objectSource = Function.prototype.toString.call(Object);

// OMP eval kernels give module object literals and globals different realms: accept genuine
// Object prototypes from another realm, not classes or proxies.
function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value) || isProxy(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  if (prototype === null || objectPrototypes.has(prototype)) return true;
  if (isProxy(prototype)) return false;
  const constructor = Object.getOwnPropertyDescriptor(prototype, 'constructor')?.value;
  if (typeof constructor !== 'function' || isProxy(constructor)
    || Object.getOwnPropertyDescriptor(constructor, 'prototype')?.value !== prototype
    || Function.prototype.toString.call(constructor) !== objectSource) return false;
  objectPrototypes.add(prototype);
  return true;
}

// Same label rule as createCuaDriver.
function validSession(value) {
  return typeof value === 'string' && value.length <= 64 && /^[a-z][a-z0-9_-]*$/.test(value) && value !== 'default';
}

function validPid(value) {
  return Number.isInteger(value) && value > 0 && value <= 0x7fffffff;
}

function validWindowId(value) {
  return Number.isInteger(value) && value > 0 && value <= 0xffffffff;
}

function validTimestamp(value) {
  return typeof value === 'string' && ISO_TIMESTAMP.test(value) && new Date(value).toISOString() === value;
}

function validAbsolutePath(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_PATH_LENGTH &&
    !value.includes('\0') && isAbsolute(value);
}

function closedKeys(value, allowed) {
  return Object.keys(value).every(key => allowed.has(key));
}

function normalizeTarget(value) {
  if (!isPlainObject(value) || Object.keys(value).length !== 2 ||
      !validPid(value.pid) || !validWindowId(value.windowId)) return null;
  return Object.freeze({ pid: value.pid, windowId: value.windowId });
}

// Returns a fresh frozen closed entry, or null when anything is off.
function normalizeEntry(value) {
  if (!isPlainObject(value) || !closedKeys(value, ENTRY_KEYS)) return null;
  const { schema, session, createdAt, updatedAt, owner } = value;
  if (schema !== JOURNAL_SCHEMA || !validSession(session) || !validTimestamp(createdAt) ||
      !validTimestamp(updatedAt) || !isPlainObject(owner) || Object.keys(owner).length !== 1 ||
      !validPid(owner.pid)) return null;
  const entry = { schema, session, createdAt, updatedAt, owner: Object.freeze({ pid: owner.pid }) };
  if (Object.hasOwn(value, 'target')) {
    const target = normalizeTarget(value.target);
    if (target === null) return null;
    entry.target = target;
  }
  if (Object.hasOwn(value, 'captureDirectory')) {
    if (!validAbsolutePath(value.captureDirectory)) return null;
    entry.captureDirectory = value.captureDirectory;
  }
  return Object.freeze(entry);
}

function requireDirectoryArgument(dir) {
  if (!validAbsolutePath(dir)) throw journalError('directory must be an absolute path');
}

function requireSession(session) {
  if (!validSession(session)) throw journalError('session label is invalid');
}

function currentUid() {
  return typeof process.getuid === 'function' ? process.getuid() : null;
}

function ownedByCurrentUser(stats) {
  const uid = currentUid();
  return uid === null || stats.uid === uid;
}

async function lstatOrNull(path) {
  try {
    return await lstat(path);
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

// Journal directory usable for reads: real (non-symlink) directory owned by this user.
// Returns its lstat, or null when missing or unusable. Never creates anything.
async function readableDirectory(dir) {
  const stats = await lstatOrNull(dir);
  if (stats === null || stats.isSymbolicLink() || !stats.isDirectory() || !ownedByCurrentUser(stats)) return null;
  return stats;
}

function sameNode(a, b) {
  return a !== null && b !== null && a.dev === b.dev && a.ino === b.ino;
}

// Creates the journal directory (and missing parents) as 0700, then requires a real
// directory owned by this user and tightens it to 0700.
async function writableDirectory(dir) {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const stats = await lstat(dir);
  if (stats.isSymbolicLink() || !stats.isDirectory() || !ownedByCurrentUser(stats)) {
    throw journalError('directory is not a private directory');
  }
  if ((stats.mode & 0o777) !== 0o700) await chmod(dir, 0o700);
  return stats;
}

// O_NOFOLLOW refuses a symlinked entry; O_NONBLOCK keeps a FIFO from hanging the open.
async function readEntryFile(path, session) {
  let handle;
  try {
    handle = await open(path, READ_FLAGS);
  } catch (error) {
    if (['ENOENT', 'ELOOP', 'EMLINK', 'ENOTDIR', 'EISDIR', 'ENXIO'].includes(error?.code)) return null;
    throw error;
  }
  try {
    const stats = await handle.stat();
    if (!stats.isFile() || !ownedByCurrentUser(stats) || stats.size > MAX_ENTRY_BYTES) return null;
    const buffer = Buffer.alloc(MAX_ENTRY_BYTES + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);
      if (bytesRead === 0) break;
      length += bytesRead;
    }
    if (length > MAX_ENTRY_BYTES) return null;
    let parsed;
    try {
      parsed = JSON.parse(buffer.toString('utf8', 0, length));
    } catch {
      return null;
    }
    const entry = normalizeEntry(parsed);
    return entry !== null && entry.session === session ? entry : null;
  } finally {
    await handle.close();
  }
}

async function readValidated(dir, session) {
  const before = await readableDirectory(dir);
  if (before === null) return null;
  const entry = await readEntryFile(join(dir, `${session}.json`), session);
  // The final path component is guarded by O_NOFOLLOW; confirm the directory was not swapped.
  return sameNode(before, await readableDirectory(dir)) ? entry : null;
}

// Serializes mutations per entry file inside this process so read-modify-write updates
// cannot lose fields to a concurrent writer of the same label.
const pending = new Map();

function serialize(key, operation) {
  const previous = pending.get(key) ?? Promise.resolve();
  const run = previous.then(operation, operation);
  const tail = run.catch(() => {});
  pending.set(key, tail);
  tail.then(() => {
    if (pending.get(key) === tail) pending.delete(key);
  });
  return run;
}

// Exclusive persists link the complete temporary file to the final name: link never replaces
// or follows an existing name, so an existing entry (or anything else there) fails with EEXIST.
async function persist(dir, entry, exclusive = false) {
  const stats = await writableDirectory(dir);
  const temporary = join(dir, `.${entry.session}.${randomUUID()}.tmp`);
  const handle = await open(temporary, WRITE_FLAGS, 0o600);
  let renamed = false;
  try {
    try {
      await handle.chmod(0o600);
      await handle.writeFile(`${JSON.stringify(entry)}\n`, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    if (!sameNode(stats, await readableDirectory(dir))) throw journalError('directory changed during write');
    const path = join(dir, `${entry.session}.json`);
    if (exclusive) {
      try {
        await link(temporary, path);
      } catch (error) {
        if (error?.code !== 'EEXIST') throw error;
        const exists = journalError('entry already exists');
        exists.exists = true;
        throw exists;
      }
    } else {
      // rename replaces the destination name itself; a symlink there is replaced, never followed.
      await rename(temporary, path);
      renamed = true;
    }
  } finally {
    if (!renamed) await unlink(temporary).catch(() => {});
  }
  return entry;
}

/**
 * Journal directory. An explicit override is used unchanged and must be absolute.
 * Otherwise `$OMP_CUA_JEV_STATE_DIR/sessions` (must be absolute when non-empty), else
 * `${XDG_STATE_HOME || ~/.local/state}/omp-cua-jev/sessions`, where an empty or relative
 * XDG_STATE_HOME is ignored per the XDG base directory spec. Pure: touches no files.
 */
export function journalDirectory(override) {
  if (override !== undefined) {
    if (!validAbsolutePath(override)) throw journalError('directory override must be an absolute path');
    return override;
  }
  const stateDir = process.env.OMP_CUA_JEV_STATE_DIR;
  if (stateDir !== undefined && stateDir !== '') {
    if (!validAbsolutePath(stateDir)) throw journalError('OMP_CUA_JEV_STATE_DIR must be an absolute path');
    return join(stateDir, 'sessions');
  }
  const xdg = process.env.XDG_STATE_HOME;
  if (validAbsolutePath(xdg)) return join(xdg, 'omp-cua-jev', 'sessions');
  const home = homedir();
  if (!validAbsolutePath(home)) throw journalError('home directory is unavailable');
  return join(home, '.local', 'state', 'omp-cua-jev', 'sessions');
}

/**
 * Atomically writes a complete closed entry (no defaults are filled in) and returns it frozen.
 * Unknown keys, invalid timestamps (strict `toISOString()` UTC), pids, targets or capture
 * directories throw JOURNAL_ERROR. Creates the directory 0700; the file is 0600.
 */
export async function writeEntry(dir, entry) {
  requireDirectoryArgument(dir);
  const normalized = normalizeEntry(entry);
  if (normalized === null) throw journalError('entry is invalid');
  return serialize(join(dir, `${normalized.session}.json`), () => persist(dir, normalized));
}

/**
 * Like writeEntry, but never replaces an existing name: when `<session>.json` already exists
 * (valid or not) it throws JOURNAL_ERROR with `exists: true` and leaves that file untouched.
 * The final name appears only once the complete entry is written.
 */
export async function createEntry(dir, entry) {
  requireDirectoryArgument(dir);
  const normalized = normalizeEntry(entry);
  if (normalized === null) throw journalError('entry is invalid');
  return serialize(join(dir, `${normalized.session}.json`), () => persist(dir, normalized, true));
}

/**
 * Updates only `target` and/or `captureDirectory` of an existing valid entry (`null` clears
 * a field, an omitted key keeps it) and refreshes `updatedAt`. Throws JOURNAL_ERROR for other
 * keys, invalid values, or a missing, malformed or symlinked entry. Returns the frozen entry.
 */
export async function updateEntry(dir, session, fields) {
  requireDirectoryArgument(dir);
  requireSession(session);
  if (!isPlainObject(fields) || !closedKeys(fields, UPDATE_KEYS)) throw journalError('update fields are invalid');
  const changes = {};
  if (Object.hasOwn(fields, 'target') && fields.target !== null) {
    changes.target = normalizeTarget(fields.target);
    if (changes.target === null) throw journalError('update target is invalid');
  }
  if (Object.hasOwn(fields, 'captureDirectory') && fields.captureDirectory !== null &&
      !validAbsolutePath(fields.captureDirectory)) throw journalError('update capture directory is invalid');
  return serialize(join(dir, `${session}.json`), async () => {
    const current = await readValidated(dir, session);
    if (current === null) throw journalError('entry does not exist');
    const next = { ...current, updatedAt: new Date().toISOString() };
    for (const key of UPDATE_KEYS) {
      if (!Object.hasOwn(fields, key)) continue;
      if (fields[key] === null) delete next[key];
      else next[key] = key === 'target' ? changes.target : fields[key];
    }
    return persist(dir, normalizeEntry(next));
  });
}

/**
 * Removes an entry. Resolves false when the directory or entry is absent, true when removed.
 * A symlinked or non-regular entry, or an unusable directory, throws JOURNAL_ERROR.
 */
export async function removeEntry(dir, session) {
  requireDirectoryArgument(dir);
  requireSession(session);
  const path = join(dir, `${session}.json`);
  return serialize(path, async () => {
    const directory = await lstatOrNull(dir);
    if (directory === null) return false;
    if (directory.isSymbolicLink() || !directory.isDirectory() || !ownedByCurrentUser(directory)) {
      throw journalError('directory is not a private directory');
    }
    const stats = await lstatOrNull(path);
    if (stats === null) return false;
    if (!stats.isFile()) throw journalError('entry is not a regular file');
    try {
      await unlink(path);
    } catch (error) {
      if (error?.code === 'ENOENT') return false;
      throw error;
    }
    return true;
  });
}

/** Frozen valid entry, or null for a missing, malformed, foreign or symlinked entry/directory. */
export async function readEntry(dir, session) {
  requireDirectoryArgument(dir);
  requireSession(session);
  return readValidated(dir, session);
}

/**
 * Frozen array of frozen valid entries sorted by session ascending. Missing or symlinked
 * directory → []. Malformed, foreign, oversized, non-regular and symlinked files are skipped.
 */
export async function readJournal(dir) {
  requireDirectoryArgument(dir);
  const before = await readableDirectory(dir);
  if (before === null) return Object.freeze([]);
  let names;
  try {
    names = await readdir(dir);
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return Object.freeze([]);
    throw error;
  }
  const entries = [];
  for (const name of names) {
    const match = ENTRY_FILE.exec(name);
    if (match === null || !validSession(match[1])) continue;
    const entry = await readEntryFile(join(dir, name), match[1]);
    if (entry !== null) entries.push(entry);
  }
  if (!sameNode(before, await readableDirectory(dir))) return Object.freeze([]);
  entries.sort((a, b) => (a.session < b.session ? -1 : a.session > b.session ? 1 : 0));
  return Object.freeze(entries);
}

/**
 * Canonical realpath of a capture directory this package may own, else null: an existing
 * directory owned by this user, directly under realpath(os.tmpdir()), whose basename starts
 * with `omp-cua-jev-native-`. The input may be a non-canonical spelling (macOS /var → /private/var).
 */
export async function ownedCaptureDirectory(path) {
  if (!validAbsolutePath(path)) return null;
  try {
    const [real, root] = await Promise.all([realpath(path), realpath(tmpdir())]);
    if (dirname(real) !== root || !basename(real).startsWith(CAPTURE_PREFIX)) return null;
    const stats = await lstat(real);
    return stats.isDirectory() && ownedByCurrentUser(stats) ? real : null;
  } catch {
    return null;
  }
}
