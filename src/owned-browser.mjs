import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { basename, dirname, isAbsolute, normalize } from 'node:path';
import { performance } from 'node:perf_hooks';
import { setTimeout as sleep } from 'node:timers/promises';

const MARKER = '.cua-driver-owned-profile.json';
const SCHEMA = 'cua-driver-browser-profile-v1';
const ISOLATED_FLAGS = ['--no-first-run', '--no-default-browser-check', '--disable-background-networking',
  '--disable-component-update', '--disable-default-apps', '--disable-extensions'];
const MAX_MAC_ARGV_BYTES = 262_144;
const IO_TIMEOUT_MS = 750;
const POLL_MS = 200;
const VERIFY_MS = 5_000;
const SOURCE = {
  commit: '83f142c4290a0f7d9ed545ae8532858c6e4f8145',
  file: 'libs/cua-driver/rust/crates/cua-driver-core/src/browser/prepare.rs',
  markerLines: '27-28,213-219,305-322',
  commandLines: '330-385',
  profileLines: '425-520',
  cleanupLines: '237-263',
  macArgumentsFile: 'libs/cua-driver/rust/crates/platform-macos/src/browser/platform.rs',
  macArgumentsLines: '428-494',
};
const SCOPE = { process: 'prepared_pid', profile: 'exact_marker_validated_argv_path', descendants: false };
const LIMITS = [
  'Only the returned prepared_pid and its exact marker-validated profile path are observed; descendant exit is not checked.',
  'Observations are point-in-time evidence, not proof of who performed cleanup or a guarantee against later recreation.',
  'The source marker has no PID, session, signature or provenance field; it is not independent proof of Driver session ownership.',
  'The marker and launch layout are scoped to the recorded source commit; an inactive end_session receipt does not prove physical cleanup.',
];

function failure(code) {
  return Object.assign(new Error(code), { code });
}

function errorCode(error) {
  return ['ENOENT', 'EACCES', 'EPERM', 'ENOTDIR', 'ELOOP', 'EAGAIN', 'ESRCH',
    'OBSERVATION_TIMEOUT', 'OBSERVATION_TOO_LARGE', 'OBSERVATION_NOT_FILE',
    'OBSERVATION_CHANGED', 'OBSERVATION_INVALID_UTF8'].includes(error?.code)
    ? error.code : 'OBSERVATION_FAILED';
}

async function bounded(operation) {
  let timer;
  try {
    return await Promise.race([
      operation,
      new Promise((_, reject) => { timer = setTimeout(() => reject(failure('OBSERVATION_TIMEOUT')), IO_TIMEOUT_MS); }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

const metadata = (path) => bounded(lstat(path, { bigint: true }));
const identity = (stat) => ({ device: stat.dev.toString(), inode: stat.ino.toString() });
const sameFile = (left, right) => left.device === right.device && left.inode === right.inode;

async function readSmall(path, maximum) {
  // O_NONBLOCK avoids waiting on a substituted FIFO. Never follow a final symlink.
  const operation = (async () => {
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const before = await file.stat({ bigint: true });
      if (!before.isFile()) throw failure('OBSERVATION_NOT_FILE');
      if (before.size > BigInt(maximum)) throw failure('OBSERVATION_TOO_LARGE');
      const bytes = Buffer.alloc(maximum + 1);
      let length = 0;
      while (length < bytes.length) {
        const result = await file.read(bytes, length, bytes.length - length, length);
        if (result.bytesRead === 0) break;
        length += result.bytesRead;
      }
      if (length > maximum) throw failure('OBSERVATION_TOO_LARGE');
      const after = await file.stat({ bigint: true });
      if (before.size !== after.size || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs) {
        throw failure('OBSERVATION_CHANGED');
      }
      let text;
      try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, length)); }
      catch { throw failure('OBSERVATION_INVALID_UTF8'); }
      return { text, identity: identity(before) };
    } finally {
      await file.close();
    }
  })();
  // A timed-out filesystem read may finish later, but cannot mutate the target.
  return bounded(operation);
}

function inspectMacPid(pid) {
  return new Promise((resolve) => {
    try {
      execFile('/bin/ps', ['-p', String(pid), '-o', 'pid=', '-o', 'lstart=', '-o', 'stat='], {
        shell: false, encoding: 'utf8', timeout: IO_TIMEOUT_MS, maxBuffer: 4_096,
        env: { ...process.env, LC_ALL: 'C', TZ: 'UTC' },
      }, (error, stdout, stderr) => {
        // ps exits 1 with no rows for a missing selected PID. Other failures are not absence.
        if (error?.code === 1 && !error.signal && stdout.trim() === '' && stderr.trim() === '') {
          resolve({ status: 'absent', anchored: false, identity: null, code: null });
          return;
        }
        if (error || stderr.trim() !== '') {
          resolve({ status: 'unknown', anchored: false, identity: null, code: error?.killed ? 'OBSERVATION_TIMEOUT' : 'PROCESS_PROBE_FAILED' });
          return;
        }
        const match = /^\s*(\d+)\s+([A-Z][a-z]{2} [A-Z][a-z]{2}\s+\d{1,2} \d{2}:\d{2}:\d{2} \d{4})\s+([A-Za-z+<>]+)\s*$/.exec(stdout);
        if (!match || Number(match[1]) !== pid) {
          resolve({ status: 'unknown', anchored: false, identity: null, code: 'PROCESS_PROBE_INVALID' });
          return;
        }
        resolve({
          status: match[3].startsWith('Z') ? 'zombie' : 'present', anchored: false,
          identity: { method: 'ps_lstart_seconds', startedAtUtc: match[2].replace(/\s+/g, ' ') }, code: null,
        });
      });
    } catch {
      resolve({ status: 'unknown', anchored: false, identity: null, code: 'PROCESS_PROBE_FAILED' });
    }
  });
}

async function inspectLinuxPid(pid) {
  try {
    const { text } = await readSmall(`/proc/${pid}/stat`, 16_384);
    const end = text.lastIndexOf(') ');
    const fields = text.slice(end + 2).trim().split(/\s+/);
    if (!text.startsWith(`${pid} (`) || end < 0 || !/^[A-Za-z]$/.test(fields[0] ?? '') || !/^\d+$/.test(fields[19] ?? '')) {
      return { status: 'unknown', anchored: false, identity: null, code: 'PROCESS_PROBE_INVALID' };
    }
    return {
      status: ['Z', 'X', 'x'].includes(fields[0]) ? 'zombie' : 'present', anchored: true,
      identity: { method: 'proc_pid_stat_start_ticks', startTicks: fields[19] }, code: null,
    };
  } catch (error) {
    if (error?.code === 'ENOENT') {
      try { await metadata(`/proc/${pid}`); }
      catch (missing) {
        if (missing?.code === 'ENOENT') return { status: 'absent', anchored: false, identity: null, code: null };
      }
    }
    return { status: 'unknown', anchored: false, identity: null, code: errorCode(error) };
  }
}

function sameProcess(left, right) {
  return left.identity !== null && right.identity !== null
    && JSON.stringify(left.identity) === JSON.stringify(right.identity);
}

function profileFromArguments(argv, platform) {
  // The source launches this exact sequence. No flattened command-line parsing.
  if (!argv[0] || argv[1] !== '--remote-debugging-port=0' || !argv[2]?.startsWith('--user-data-dir=')
    || !ISOLATED_FLAGS.every((value, index) => argv[index + 3] === value)) throw failure('ARGV_LAYOUT_UNSUPPORTED');
  let cursor = 3 + ISOLATED_FLAGS.length;
  if (platform === 'linux') {
    if (argv[cursor++] !== '--password-store=basic') throw failure('ARGV_LAYOUT_UNSUPPORTED');
    if (argv[cursor] === '--ozone-platform=wayland') cursor++;
    if (argv[cursor] === '--no-sandbox') cursor++;
  }
  if (argv.length !== cursor + 1 || argv[cursor] !== 'about:blank') throw failure('ARGV_LAYOUT_UNSUPPORTED');
  const path = argv[2].slice('--user-data-dir='.length);
  if (!isAbsolute(path) || path !== normalize(path) || path === dirname(path)) throw failure('PROFILE_PATH_UNSUPPORTED');
  return path;
}

async function recoverLinuxProfile(pid) {
  const { text } = await readSmall(`/proc/${pid}/cmdline`, 65_536);
  if (!text.endsWith('\0')) throw failure('ARGV_UNAVAILABLE');
  return profileFromArguments(text.slice(0, -1).split('\0'), 'linux');
}

async function recoverMacProfile(pid) {
  if (!['arm64', 'x64'].includes(process.arch)) throw failure('ARGV_ABI_UNSUPPORTED');
  let ffi;
  try { ffi = await bounded(import('bun:ffi')); }
  catch { throw failure('ARGV_BUN_FFI_UNAVAILABLE'); }
  let library;
  let bytes;
  try {
    // Checked MacOSX.sdk/usr/include/sys/sysctl.h: CTL_KERN=1, KERN_PROCARGS2=49,
    // int sysctl(int *, u_int, void *, size_t *, void *, size_t).
    // SDK arm/_types.h and i386/_types.h: size_t is unsigned long on LP64.
    // Bun 1.3.14 packages/bun-types/ffi.d.ts defines ptr/u32/u64/i32, nullable
    // pointer arguments, ptr(TypedArray), and Library.close(). u64 accepts 0n.
    library = ffi.dlopen('/usr/lib/libSystem.B.dylib', {
      sysctl: { args: ['ptr', 'u32', 'ptr', 'ptr', 'ptr', 'u64'], returns: 'i32' },
    });
    const mib = new Int32Array([1, 49, pid]);
    const length = new BigUint64Array(1); // Eight-byte native size_t storage on both supported macOS ABIs.
    const mibPointer = ffi.ptr(mib);
    const lengthPointer = ffi.ptr(length);
    const sysctl = library.symbols.sysctl;
    // Both queries name only the caller-supplied PID. No sysctlbyname or environment query.
    if (sysctl(mibPointer, mib.length, null, lengthPointer, null, 0n) !== 0) throw failure('ARGV_SIZE_UNAVAILABLE');
    const size = length[0];
    if (size < 4n || size > BigInt(MAX_MAC_ARGV_BYTES)) throw failure('ARGV_SIZE_UNSUPPORTED');
    bytes = Buffer.alloc(Number(size));
    if (sysctl(mibPointer, mib.length, ffi.ptr(bytes), lengthPointer, null, 0n) !== 0) throw failure('ARGV_READ_UNAVAILABLE');
    if (length[0] < 4n || length[0] > size) throw failure('ARGV_READ_INVALID');
    const limit = Number(length[0]);
    // arm64 and x64 macOS are little-endian; argc is a four-byte native C int.
    const argc = bytes.readInt32LE(0);
    if (argc !== ISOLATED_FLAGS.length + 4) throw failure('ARGV_LAYOUT_UNSUPPORTED');
    const executableEnd = bytes.indexOf(0, 4);
    if (executableEnd <= 4 || executableEnd >= limit) throw failure('ARGV_READ_INVALID');
    let cursor = executableEnd + 1;
    while (cursor < limit && bytes[cursor] === 0) cursor++;
    const argv = [];
    const decoder = new TextDecoder('utf-8', { fatal: true });
    for (let index = 0; index < argc; index++) {
      if (cursor >= limit) throw failure('ARGV_READ_INVALID');
      const end = bytes.indexOf(0, cursor);
      if (end < cursor || end >= limit) throw failure('ARGV_READ_INVALID');
      try { argv.push(decoder.decode(bytes.subarray(cursor, end))); }
      catch { throw failure('ARGV_INVALID_UTF8'); }
      cursor = end + 1;
    }
    // Stop at argc. KERN_PROCARGS2 can also return environment bytes: never
    // decode, inspect or retain anything following the final argument.
    return profileFromArguments(argv, 'darwin');
  } catch (error) {
    if (typeof error?.code === 'string' && /^(ARGV_|PROFILE_)/.test(error.code)) throw error;
    throw failure('ARGV_FFI_UNAVAILABLE');
  } finally {
    bytes?.fill(0);
    // No native pointers or functions escape this synchronous pair of sysctl calls.
    library?.close();
  }
}

async function inspectProfile(path) {
  const parent = dirname(path);
  const parentStat = await metadata(parent);
  const directory = await metadata(path);
  if (!parentStat.isDirectory() || parentStat.isSymbolicLink() || !directory.isDirectory() || directory.isSymbolicLink()) {
    throw failure('PROFILE_NOT_REAL_DIRECTORY');
  }
  // Reject aliases, including symlinked ancestors, rather than choosing another path.
  if (await bounded(realpath(path)) !== path) throw failure('PROFILE_PATH_ALIASED');
  const markerPath = `${path}/${MARKER}`;
  const markerStat = await metadata(markerPath);
  if (!markerStat.isFile() || markerStat.isSymbolicLink()) throw failure('PROFILE_MARKER_NOT_REGULAR');
  const contents = await readSmall(markerPath, 4_096);
  if (!sameFile(contents.identity, identity(markerStat))) throw failure('PROFILE_MARKER_CHANGED');
  let marker;
  try { marker = JSON.parse(contents.text); } catch { throw failure('PROFILE_MARKER_INVALID'); }
  const name = marker?.name ?? null;
  if (marker === null || typeof marker !== 'object' || Array.isArray(marker) || marker.schema !== SCHEMA
    || !['isolated_new', 'isolated_named'].includes(marker.mode)) throw failure('PROFILE_MARKER_INVALID');
  if (marker.mode === 'isolated_new') {
    if (name !== null || !/^isolated-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(basename(path))) {
      throw failure('PROFILE_MARKER_MISMATCH');
    }
  } else if (typeof name !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(name) || basename(path) !== name) {
    throw failure('PROFILE_MARKER_MISMATCH');
  }
  const directoryAfter = await metadata(path);
  const parentAfter = await metadata(parent);
  const markerAfter = await metadata(markerPath);
  if (!sameFile(identity(directory), identity(directoryAfter)) || !sameFile(identity(parentStat), identity(parentAfter))
    || !sameFile(identity(markerStat), identity(markerAfter)) || markerStat.mtimeNs !== markerAfter.mtimeNs
    || markerStat.ctimeNs !== markerAfter.ctimeNs) throw failure('PROFILE_CHANGED_DURING_OBSERVATION');
  return {
    path, parent, parentIdentity: identity(parentStat), directoryIdentity: identity(directory),
    marker: { schema: SCHEMA, mode: marker.mode, name }, retainedByDriver: marker.mode === 'isolated_named',
  };
}

async function checkProfileAbsent(proof) {
  if (proof === null) return { status: 'unproven', absent: false, code: 'PROFILE_NOT_ANCHORED' };
  try {
    const parent = await metadata(proof.parent);
    if (!parent.isDirectory() || parent.isSymbolicLink() || !sameFile(identity(parent), proof.parentIdentity)
      || await bounded(realpath(proof.parent)) !== proof.parent) {
      return { status: 'unknown', absent: false, code: 'PROFILE_PARENT_CHANGED' };
    }
    try {
      const current = await metadata(proof.path);
      return { status: sameFile(identity(current), proof.directoryIdentity) ? 'present' : 'replaced', absent: false, code: null };
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      const parentAfter = await metadata(proof.parent);
      if (!parentAfter.isDirectory() || parentAfter.isSymbolicLink() || !sameFile(identity(parentAfter), proof.parentIdentity)
        || await bounded(realpath(proof.parent)) !== proof.parent) {
        return { status: 'unknown', absent: false, code: 'PROFILE_PARENT_CHANGED' };
      }
      return { status: 'absent', absent: true, code: null };
    }
  } catch (error) {
    return { status: 'unknown', absent: false, code: errorCode(error) };
  }
}

/**
 * Read-only physical observations for an already returned prepared_pid.
 * Returns { evidence: JSON, verifyAfterEnd: async () => JSON }.
 * The caller owns end_session. This helper never signals a browser or removes files.
 */
export async function observePreparedBrowser(pid) {
  const validPid = Number.isSafeInteger(pid) && pid > 0 && pid <= 2_147_483_647;
  const platform = process.platform;
  const inspect = platform === 'darwin' ? inspectMacPid : platform === 'linux' ? inspectLinuxPid : null;
  const limits = [...LIMITS];
  let original = { status: 'unknown', anchored: false, identity: null, code: validPid ? 'UNSUPPORTED_PLATFORM' : 'INVALID_PREPARED_PID' };
  let proof = null;
  let profileCode = 'PROFILE_ARGV_UNAVAILABLE';
  let procRoot = null;
  let captureRechecked = false;
  if (validPid && inspect !== null) original = await inspect(pid);
  if (platform === 'darwin') {
    limits.push('macOS ps start identities have one-second resolution. Equal or changed present rows do not prove exit; completion requires observing that the PID is absent.');
    limits.push('macOS exact argv readback requires Bun FFI on arm64 or x64 and the recorded launch layout. Unsupported ABI, permission failures or layout changes leave profile proof unavailable.');
  }
  if (validPid && inspect !== null && original.status === 'present') {
    try {
      if (platform === 'linux') {
        // Anchoring the proc mount prevents an unavailable/replaced procfs from proving exit.
        procRoot = identity(await metadata('/proc'));
      }
      const path = platform === 'darwin' ? await recoverMacProfile(pid) : await recoverLinuxProfile(pid);
      proof = await inspectProfile(path);
      const recheck = await inspect(pid);
      if (!sameProcess(original, recheck) || recheck.status !== 'present') {
        proof = null;
        profileCode = 'PROFILE_PROCESS_CHANGED';
        original = { ...original, anchored: false, code: 'PROCESS_CHANGED_DURING_OBSERVATION' };
      } else {
        captureRechecked = true;
        profileCode = null;
      }
    } catch (error) {
      proof = null;
      profileCode = typeof error?.code === 'string' && /^(ARGV_|PROFILE_)/.test(error.code) ? error.code : errorCode(error);
    }
    if (platform === 'linux' && procRoot === null) original = { ...original, anchored: false, code: 'PROCESS_NAMESPACE_UNANCHORED' };
  } else if (inspect === null) limits.push('This operating system has no supported PID-scoped observer.');
  if (!validPid) limits.push('A positive prepared_pid is required; no process was inspected.');
  if (!original.anchored) limits.push('A unique process-generation identity was not anchored; only confirmed PID absence can prove the observed process exited.');
  if (proof === null) limits.push(`The exact owned profile was not anchored: ${profileCode}.`);
  if (proof?.retainedByDriver) limits.push('The source deliberately retains isolated_named profiles after session cleanup.');
  const evidence = {
    source: { ...SOURCE }, scope: { ...SCOPE }, platform, pid: validPid ? pid : null,
    process: { ...original, captureRechecked, identity: original.identity === null ? null : { ...original.identity } },
    profile: proof === null ? { validated: false, path: null, marker: null, code: profileCode } : {
      validated: true, path: proof.path, directoryIdentity: { ...proof.directoryIdentity },
      marker: { ...proof.marker }, retainedByDriver: proof.retainedByDriver,
      argvMethod: platform === 'darwin' ? 'kern_procargs2' : 'proc_pid_cmdline', code: null,
    },
    limits: [...limits],
  };

  return { evidence, async verifyAfterEnd() {
    const started = performance.now();
    let processAfter = { status: 'unproven', anchored: false, identity: null, code: original.code };
    let profileAfter = { status: 'unproven', absent: false, code: 'PROFILE_NOT_ANCHORED' };
    let pidExited = false;
    let pidReused = false;
    let polls = 0;
    if (validPid && inspect !== null && ['present', 'zombie'].includes(original.status)) {
      do {
        polls++;
        processAfter = await inspect(pid);
        let namespaceStable = platform === 'darwin';
        if (platform === 'linux' && procRoot !== null) {
          try { namespaceStable = sameFile(identity(await metadata('/proc')), procRoot); }
          catch { namespaceStable = false; }
        }
        pidReused = processAfter.identity !== null && original.identity !== null && !sameProcess(original, processAfter);
        // A vacant PID proves the originally observed process is gone without
        // relying on ps's coarse timestamp to distinguish same-second reuse.
        pidExited = namespaceStable && processAfter.status === 'absent';
        profileAfter = await checkProfileAbsent(proof);
        if (pidExited && (proof === null || profileAfter.absent)) break;
        const remaining = VERIFY_MS - (performance.now() - started);
        if (remaining <= 0) break;
        await sleep(Math.min(POLL_MS, remaining));
      } while (performance.now() - started < VERIFY_MS);
    }
    const afterLimits = [...limits];
    if (!pidExited) afterLimits.push('Original prepared PID exit was not proven within the observation window.');
    if (pidReused) afterLimits.push('The PID now has a different start identity. That replacement process was not inspected beyond PID identity.');
    if (!profileAfter.absent) afterLimits.push(`Exact profile absence was not proven: ${profileAfter.code ?? profileAfter.status}.`);
    return {
      complete: captureRechecked && proof !== null && pidExited && profileAfter.absent,
      scope: { ...SCOPE }, pid: validPid ? pid : null, pidExited, pidReused, profileAbsent: profileAfter.absent,
      process: processAfter, profile: { path: proof?.path ?? null, ...profileAfter },
      polls, elapsedMs: Math.round(performance.now() - started), limits: afterLimits,
    };
  } };
}
