import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { access, stat } from 'node:fs/promises';
import { isAbsolute } from 'node:path';

const MINIMUM_BUN = '1.3.14';
const MINIMUM_OMP = '18.2.7';
const TIMEOUT_MS = 5_000;
const MAX_BUFFER = 64 * 1024;
const RESOURCE_NAMES = ['loop', 'driver', 'demo', 'probe', 'skill'];
const DIRECT_CAPTURE_STATES = new Set([
  'ready', 'unavailable', 'timed_out', 'probe_failed', 'blocked_by_screen_recording', 'not_checked',
]);

function version(value) {
  if (typeof value !== 'string' || value.length > 120) return null;
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(value.trim());
  if (!match || !match.slice(1, 4).every(part => Number.isSafeInteger(Number(part)))) return null;
  return match[0];
}

function meetsMinimum(actual, minimum) {
  if (!actual) return null;
  const actualParts = actual.split(/[.+-]/, 3).map(Number);
  const minimumParts = minimum.split('.').map(Number);
  for (let index = 0; index < 3; index++) {
    if (actualParts[index] !== minimumParts[index]) return actualParts[index] > minimumParts[index];
  }
  return !actual.split('+', 1)[0].includes('-');
}

function run(binary, args) {
  return new Promise(resolve => {
    try {
      execFile(binary, args, {
        shell: false,
        encoding: 'utf8',
        timeout: TIMEOUT_MS,
        maxBuffer: MAX_BUFFER,
        killSignal: 'SIGKILL',
      }, (error, stdout, stderr) => {
        let state = 'ok';
        if (error?.code === 'ENOENT') state = 'missing';
        else if (error?.code === 'EACCES' || error?.code === 'EPERM') state = 'not_executable';
        else if (error?.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') state = 'output_limit';
        else if (error?.killed || error?.signal) state = 'terminated';
        else if (error?.code === 75) state = 'permissions_pending';
        else if (error) state = 'failed';
        resolve({
          state,
          exitCode: error ? (Number.isInteger(error.code) ? error.code : null) : 0,
          stdout: typeof stdout === 'string' ? stdout : '',
          stderr: typeof stderr === 'string' ? stderr : '',
        });
      });
    } catch {
      resolve({ state: 'failed', exitCode: null, stdout: '', stderr: '' });
    }
  });
}

function commandResult(result) {
  // Never return child output, error objects, command paths, or environment values.
  return { state: result.state, exitCode: result.exitCode };
}

function daemonStatus(result) {
  const lines = result.stdout.trim().split(/\r?\n/);
  const listening = result.state === 'ok' && lines[0] === 'Cua Driver daemon is running';
  const notRunning = result.exitCode === 1 && result.stderr.trim() === 'Cua Driver daemon is not running';
  const modeLines = lines.filter(line => /^\s*permission mode:/.test(line));
  // The inspected CLI prints text even with --json. Missing/ambiguous mode is not standard.
  const mode = listening && modeLines.length === 1
    ? /^  permission mode: (standard|bounded|unrestricted) \((trusted_startup_configuration|built_in_default)\)$/.exec(modeLines[0])
    : null;
  return {
    state: listening ? 'listening' : notRunning ? 'not_running' : 'unknown',
    permissionMode: mode?.[1] ?? 'unknown',
    permissionModeSource: mode?.[2] ?? null,
  };
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function grant(payload, name, trusted) {
  if (!trusted) return 'unknown';
  if (!Object.hasOwn(payload, name)) return 'missing';
  if (payload[name] === true) return 'granted';
  if (payload[name] === false) return 'denied';
  return 'unknown';
}

function permissionStatus(result) {
  let payload = null;
  if (result.state === 'ok') {
    try { payload = JSON.parse(result.stdout); } catch { /* Unrecognized output stays unknown. */ }
  }
  const object = isObject(payload);
  const source = object && isObject(payload.source) ? payload.source : null;
  const ownIdentity = source?.attribution === 'driver-daemon' && source?.bundle_id === 'com.trycua.driver';
  const unattributed = object && !Object.hasOwn(payload, 'source') && process.platform !== 'darwin';
  const trusted = object && (ownIdentity || unattributed)
    && (payload.status === undefined || payload.status === 'ok')
    && payload.isError !== true && payload.success !== false
    && payload.error == null && payload.refusal == null;
  // status:unknown omits grants and may say daemon_running:false even for a listening daemon.
  // Do not use that field as a process-liveness check or turn its missing booleans into denials.
  return {
    state: trusted ? 'reported' : 'unknown',
    identity: ownIdentity ? 'driver-daemon' : unattributed ? 'not_supplied_non_macos' : 'unverified',
    accessibility: grant(payload, 'accessibility', trusted),
    screenRecording: grant(payload, 'screen_recording', trusted),
    deniedMeaning: 'A reported false grant, not evidence that a person denied a prompt.',
    directCapture: {
      checkedByDoctor: false,
      reportedStatus: trusted && DIRECT_CAPTURE_STATES.has(payload.direct_capture_status)
        ? payload.direct_capture_status : 'unknown',
      historicalGrantEvidenceReported: trusted && isObject(payload.direct_capture_verification),
    },
  };
}

async function resourceStatus(paths) {
  if (paths === undefined) return { state: 'not_checked' };
  const files = {};
  await Promise.all(RESOURCE_NAMES.map(async name => {
    const path = paths?.[name];
    if (typeof path !== 'string' || !isAbsolute(path)) {
      files[name] = 'missing_or_not_absolute';
      return;
    }
    try {
      if (!(await stat(path)).isFile()) files[name] = 'not_file';
      else {
        await access(path, constants.R_OK);
        files[name] = 'readable';
      }
    } catch (error) {
      files[name] = error?.code === 'ENOENT' ? 'missing' : 'unreadable';
    }
  }));
  return { state: 'checked', files };
}

/**
 * Read-only prerequisite report, usable without OMP. Host metadata is supplied by
 * the extension, not inferred from another omp process or a second model client.
 * No sessions, capture, prompts, configuration changes, or judge calls occur.
 */
export async function doctor({ host, paths, binary = 'cua-driver' } = {}) {
  const blocking = [];
  const warnings = [];
  const nextSteps = new Set();
  const issue = (list, code, message, next) => {
    list.push({ code, message });
    if (next) nextSteps.add(next);
  };
  const bunVersion = version(process.versions.bun);
  const bun = { version: bunVersion, minimum: MINIMUM_BUN, supported: meetsMinimum(bunVersion, MINIMUM_BUN) };
  if (bun.supported !== true) issue(blocking, 'BUN_REQUIRED', 'Bun >=1.3.14 is required.',
    'Install a supported Bun release and run bun src/doctor.mjs from the package directory.');

  let hostReport = { state: 'not_checked', reason: 'No OMP host metadata supplied.', minimum: MINIMUM_OMP };
  if (host !== undefined) {
    const hostVersion = version(host?.version);
    const supported = meetsMinimum(hostVersion, MINIMUM_OMP);
    const evalActive = typeof host?.evalActive === 'boolean' ? host.evalActive : null;
    const nativeJs = host?.nativeJs === true && Array.isArray(host?.evalLanguages) && host.evalLanguages.includes('js');
    hostReport = { state: 'reported', version: hostVersion, minimum: MINIMUM_OMP, supported, evalActive, nativeJs };
    if (supported !== true) issue(blocking, 'OMP_VERSION_UNSUPPORTED_OR_UNKNOWN',
      'This host must report OMP >=18.2.7 for the awaited judge answer-map contract.',
      'Use stock OMP >=18.2.7. The documented minimum is not enforced by an engines.omp package field.');
    if (evalActive !== true || !nativeJs) issue(blocking, 'STOCK_JS_EVAL_UNAVAILABLE',
      'Active stock JavaScript eval is not advertised by this host.',
      'Enable eval.js and the eval tool in the intended OMP session. Do not replace another eval extension automatically.');
  }

  const resources = await resourceStatus(paths);
  if (resources.files && Object.values(resources.files).some(state => state !== 'readable')) {
    issue(blocking, 'PACKAGE_RESOURCES_UNAVAILABLE', 'One or more installed helper or skill files are missing or unreadable.',
      'Inspect jev_resources with action paths and relink the complete package directory using omp plugin link /path/to/omp-jev.');
  }

  const validBinary = typeof binary === 'string' && binary.trim().length > 0 && !binary.includes('\0');
  const skipped = { state: 'invalid_binary', exitCode: null, stdout: '', stderr: '' };
  const [versionResult, statusResult, permissionsResult] = validBinary
    ? await Promise.all([
      run(binary, ['--version']),
      run(binary, ['status']),
      run(binary, ['permissions', 'status', '--json']),
    ]) : [skipped, skipped, skipped];
  const driverVersion = versionResult.state === 'ok' && versionResult.stdout.startsWith('cua-driver ')
    ? version(versionResult.stdout.slice('cua-driver '.length)) : null;
  const daemon = daemonStatus(statusResult);
  const permissions = permissionStatus(permissionsResult);
  if (versionResult.state !== 'ok') issue(blocking, 'CUA_CLI_UNAVAILABLE',
    'The Cua Driver version command did not complete successfully.',
    'Install or repair Cua Driver using the official setup instructions linked in README, then rerun doctor.');
  else if (!driverVersion) issue(warnings, 'CUA_VERSION_UNKNOWN', 'The Cua Driver version output was not recognized.');
  if (daemon.state !== 'listening') issue(blocking, 'CUA_DAEMON_UNAVAILABLE',
    'A listening Cua Driver daemon was not established by status.',
    'Have the operator complete standard Cua onboarding. On macOS use the installed CuaDriver app through LaunchServices; preserve any existing launch flags during authorized recovery.');
  if (daemon.permissionMode === 'unknown') issue(blocking, 'PERMISSION_MODE_UNKNOWN',
    'The daemon permission mode could not be read reliably. No default was assumed.',
    'Inspect cua-driver status with the operator. Do not change or restart a shared daemon to work around an unknown mode.');
  else if (daemon.permissionMode === 'unrestricted') issue(warnings, 'UNRESTRICTED_MODE',
    'WARNING: The existing daemon bypasses Cua approval checks. Unrestricted is not the recommended default and proves no standard-mode run.',
    'Arrange a separate operator-authorized standard-mode acceptance run. Do not silently replace existing launch flags or widen approval scope.');
  else if (daemon.permissionMode === 'bounded') issue(warnings, 'BOUNDED_SCOPE_NOT_CHECKED',
    'The daemon reports bounded mode. Doctor has not verified that its reviewed manifest allows the intended task.');
  for (const [name, state] of [['accessibility', permissions.accessibility], ['screenRecording', permissions.screenRecording]]) {
    if (state !== 'granted') issue(blocking, `OS_GRANT_${name === 'accessibility' ? 'ACCESSIBILITY' : 'SCREEN_RECORDING'}_${state.toUpperCase()}`,
      `${name === 'accessibility' ? 'Accessibility' : 'Screen Recording'} grant is ${state}.`,
      'Have a human review cua-driver permissions grant and approve the requested OS grants. On macOS grants must belong to the CuaDriver app identity, not the calling terminal. Do not reset TCC or bypass its gate.');
  }

  if (blocking.length === 0) {
    nextSteps.add(host === undefined
      ? 'Run /jev doctor in the intended stock OMP session to check its version and advertised JavaScript eval.'
      : 'Run /jev probe to make a separate synthetic call through the configured host judge; inspect its actual result.');
    nextSteps.add('For separately authorized native proof, use /jev demo in OMP or bun src/demo.mjs for the deterministic CLI demo. Check fixture completion and owned cleanup independently.');
  }

  return {
    schemaVersion: 1,
    ok: blocking.length === 0,
    status: blocking.length ? 'blocked' : 'checks_passed',
    readOnly: true,
    blocking,
    warnings,
    nextSteps: [...nextSteps],
    runtime: { bun },
    host: hostReport,
    resources,
    native: {
      version: driverVersion,
      commandTimeoutMs: TIMEOUT_MS,
      commands: {
        version: commandResult(versionResult),
        status: commandResult(statusResult),
        permissions: commandResult(permissionsResult),
      },
      daemon,
      permissions,
    },
    evidence: {
      nativeTransport: permissions.state === 'reported' ? 'permission_status_query_only' : 'unverified',
      nativeSession: 'not_tested',
      browserDelivery: 'not_tested',
      taskCompletion: 'not_tested',
      cleanup: 'not_tested',
      standardModeRun: 'not_tested',
      directCapture: 'not_tested',
      judge: 'not_called',
      liveJudgeCredentials: 'not_verified',
    },
    limits: [
      'Checks passed means read-only prerequisites only, not authorization or an end-to-end result.',
      'Permission status may include historical grant evidence. Doctor neither captures the screen nor revalidates that evidence.',
      'OMP host version and eval checks use supplied metadata; judge credentials and execution require /jev probe inside stock eval.',
      'Browser delivery, application completion, and owned-resource cleanup require a separately authorized native fixture run.',
      'Publishing remains blocked until an actual clean-machine standard-mode run. A fresh HOME on a configured machine is insufficient.',
    ],
  };
}

if (import.meta.main) {
  try {
    const result = await doctor();
    console.log(JSON.stringify(result, null, 2));
    process.exitCode = result.ok ? 0 : 1;
  } catch {
    console.log(JSON.stringify({ ok: false, status: 'blocked', readOnly: true,
      blocking: [{ code: 'DOCTOR_FAILED', message: 'Doctor could not complete; no raw diagnostic output is included.' }] }, null, 2));
    process.exitCode = 1;
  }
}
