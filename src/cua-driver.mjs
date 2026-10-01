import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { lstat, realpath, stat } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, sep } from 'node:path';
import { isProxy } from 'node:util/types';
import { JOURNAL_SCHEMA, createEntry, journalDirectory, readEntry, removeEntry, updateEntry, writeEntry } from './journal.mjs';

const MAX_TIMEOUT_MS = 2 ** 31 - 1;
const MAX_BUFFER = 4 * 1024 * 1024;
const DAEMON_PID = /^\s*pid:\s*(\d+)\s*$/gm;
const JOURNAL_HINT = 'The session journal could not be updated, so no native request was dispatched. Check the journal directory.';
const JOURNALED_HINT = 'This session label is already journaled. Use resume() to continue your own orphan or recoverSessions() to end it; do not start() it again.';
const RESUME_HINT = 'resume() needs an explicit, journaled session label that get_session reports active. A failed resume closes this instance; use session recovery, not start(), for that label.';
// call() refuses tools that need lifecycle, exact-session, or scoped-window checks, and
// operator-owned tools this plugin never dispatches.
const METHOD_HINTS = new Map([
  ['install_extension', 'Extension installation is operator-only: an operator inspects and installs a reviewed, signed catalog with cua-driver extension inspect/install --catalog. Never install from a task or chooser.'],
  ['start_session', 'Use start() or resume() for this instance\'s owned session lifecycle.'],
  ['end_session', 'Use end() to close this instance\'s owned session.'],
  ['get_session', 'Use getSession() to read this instance\'s session; it grants no authority.'],
  ['list_windows', 'Use listWindows(pid) for exact-PID window discovery or listOnScreenWindows() for read-only occlusion evidence; this tool has no session argument.'],
  ['bring_to_front', 'Use bringToFront({ pid, window_id }) for explicitly authorized exact-window focus; this tool has no session argument.'],
  ['get_screen_size', 'Use screenSize() for the validated main-display size; this tool has no session argument.'],
]);

// Closed local allowlist, not every code in the native protocol's open refusal envelope.
// Pinned to trycua/cua@83f142c4290a0f7d9ed545ae8532858c6e4f8145:
// libs/cua-driver/rust/crates/cua-driver-core/src/browser/refusal.rs (BrowserRefusalCode)
// src/session_tools.rs (end_session cleanup codes) and src/tool.rs
// (protected_resource_scope_invalid) in the same crate, plus
// platform-macos/src/tools/bring_to_front.rs (exact-window verification).
// Native capture, window, element, delivery, permission, and session codes were added from the
// Cua Driver 0.30.2-nightly.20260927.36294544935 binary and its observed refusal receipts
// (root {code, effect:'refused'}, usually exit 1).
// Cua Driver 0.31.0 element tokens: trycua/cua@5272e492d61b96caf08e3bf434d91126c1f3dccc
// (tag cua-driver-rs-v0.31.0) cua-driver-core/src/{tool.rs,snapshot_store.rs} emit
// stale_element_token and invalid_arguments (element_index/snapshot_id rejected, so their
// former *_required codes are gone). Perception codes are pinned to cua-perception 0.2.1:
// trycua/cua@6aa37d0751d094bfe8fdc2df331ed9eae934c832 (tag cua-perception-v0.2.1)
// libs/cua-driver/rust/crates/cua-driver-contract/src/visual.rs (VisualParseErrorCode).
// Observed on the installed 0.31.0 binary with cua-perception 0.2.1: root {code, message, detail?,
// retryable} parse failures (exit 1, no effect) and element actions accepting only element_token.
const REFUSAL_CODES = new Set([
  'protected_resource_scope_invalid',
  'bring_to_front_exact_window_unverified',
  'browser_route_unavailable',
  'browser_requires_setup',
  'browser_binding_ambiguous',
  'browser_binding_stale',
  'browser_wrong_target_refused',
  'browser_tab_required',
  'browser_tab_not_found',
  'browser_ref_stale',
  'browser_input_trust_unavailable',
  'browser_endpoint_owner_mismatch',
  'browser_consent_required',
  'browser_consent_revoked',
  'browser_reconnect_exhausted',
  'browser_input_incomplete',
  'browser_action_unavailable',
  'browser_origin_outside_scope',
  'session_cleanup_pending',
  'session_cleanup_partial',
  'capture_not_found',
  'capture_expired',
  'capture_stale',
  'capture_generation_mismatch',
  'capture_target_mismatch',
  'capture_coordinate_invalid',
  'capture_binding_failed',
  'capture_failed',
  'capture_id_invalid',
  'capture_frame_mismatch',
  'capture_disabled',
  'capture_publication_failed',
  'desktop_scope_disabled',
  'screenshot_context_missing',
  'zoom_context_missing',
  'window_id_not_found',
  'window_owner_pid_mismatch',
  'window_not_found',
  'ax_window_unresolved',
  'element_not_found',
  'element_not_found_on_click',
  'element_outside_target_window',
  'stale_element_token',
  'same_pid_keyboard_ambiguity',
  'background_unavailable',
  'foreground_unavailable',
  'permissions_pending',
  'permission_required',
  'session_not_started',
  'invalid_arguments',
  // cua-perception parse_visual_regions refusals (capture_* codes above also apply).
  'not_installed',
  'unsupported_target',
  'unsupported_platform',
  'incompatible_protocol',
  'invalid_frame',
  'worker_launch_failed',
  'worker_crashed',
  'worker_cancelled',
  'timeout',
  'resource_limit_exceeded',
  'artifact_invalid',
  'inference_failed',
]);

const CAPTURE_HINT = 'Take get_window_state with a screenshot in THIS session immediately before the pixel action; captures are single-use and session-scoped.';
const WINDOW_HINT = 'Re-discover the exact window before acting; do not reuse a stale window ID or owner PID.';
// cua-perception parse refusals. The extension is optional and installed only by an operator.
const NOT_INSTALLED_HINT = 'The optional cua-perception extension is not installed. Only an operator installs it explicitly with cua-driver extension inspect/install --catalog; tasks never install it.';
const UNSUPPORTED_HINT = 'Visual regions are unavailable for this target or platform. Use AX evidence, the typed-browser route, or caller-owned regions only where already authorized; this refusal authorizes nothing new.';
const EXTENSION_PROVENANCE_HINT = 'Stop using the extension for this task. An operator inspects its installed version and provenance; do not install or update it from here.';
const FRAME_HINT = 'Use a supported capture size or narrow the request; never rescale regions or coordinates yourself.';
const PARTIAL_HINT = 'Do not act from a partial result; observe again before any bounded retry.';
// Exit 75 is the Driver's OS permission gate even when no receipt parses.
const PERMISSION_EXIT_CODE = 75;
const PERMISSION_HINT = 'The macOS permission gate did not admit this call. Run skill cua-driver-tcc-gate-fix; do not bypass the gate.';
const REFUSAL_HINTS = new Map([
  ['protected_resource_scope_invalid', 'Check the exact protected resource path. Screenshot output needs an existing canonical parent and a non-symlink file leaf. Native policy still applies; do not retry automatically.'],
  ['bring_to_front_exact_window_unverified', 'Exact window focus was not confirmed. Inspect the scoped window state before considering another action; do not replay automatically.'],
  ['browser_route_unavailable', 'The typed-browser route is unavailable for this target. This refusal does not test native AX or pixel control and does not authorize switching routes.'],
  ['screenshot_context_missing', CAPTURE_HINT],
  ['capture_not_found', CAPTURE_HINT],
  ['capture_expired', CAPTURE_HINT],
  ['capture_stale', CAPTURE_HINT],
  ['capture_generation_mismatch', CAPTURE_HINT],
  ['capture_target_mismatch', CAPTURE_HINT],
  ['capture_id_invalid', CAPTURE_HINT],
  ['capture_frame_mismatch', CAPTURE_HINT],
  ['capture_coordinate_invalid', 'The pixel coordinate is outside the capture bounds; use screenshot pixels within that capture.'],
  ['window_id_not_found', WINDOW_HINT],
  ['window_owner_pid_mismatch', WINDOW_HINT],
  ['window_not_found', WINDOW_HINT],
  ['same_pid_keyboard_ambiguity', 'Keyboard input is ambiguous for this process; use set_value or an element token instead.'],
  ['permissions_pending', PERMISSION_HINT],
  ['permission_required', PERMISSION_HINT],
  ['stale_element_token', 'The element token belongs to an older snapshot or runtime. Read get_window_state in THIS session and use a new element_token from it; do not replay automatically.'],
  ['invalid_arguments', 'The tool rejected the argument shape. Check the request against cua-driver describe for this tool (Driver 0.31.0+ element actions accept only element_token); do not resend the same arguments.'],
  ['not_installed', NOT_INSTALLED_HINT],
  ['unsupported_target', UNSUPPORTED_HINT],
  ['unsupported_platform', UNSUPPORTED_HINT],
  ['incompatible_protocol', EXTENSION_PROVENANCE_HINT],
  ['artifact_invalid', EXTENSION_PROVENANCE_HINT],
  ['invalid_frame', FRAME_HINT],
  ['resource_limit_exceeded', FRAME_HINT],
  ['worker_launch_failed', PARTIAL_HINT],
  ['worker_crashed', PARTIAL_HINT],
  ['worker_cancelled', PARTIAL_HINT],
  ['inference_failed', PARTIAL_HINT],
  ['timeout', `The request timed out and its outcome is unknown. ${PARTIAL_HINT} Never replay a mutation blindly.`],
]);

function failure(unknownOutcome = false, exitCode, refusalCode, hint, tool) {
  const named = typeof tool === 'string' && /^[a-z][a-z0-9_]*$/.test(tool);
  const code = REFUSAL_CODES.has(refusalCode) ? refusalCode : undefined;
  const error = new Error(named
    ? `Cua Driver ${tool} request ${code === undefined ? 'failed' : `refused: ${code}`}.`
    : 'Cua Driver request failed.');
  error.code = 'CUA_DRIVER_ERROR';
  error.unknownOutcome = unknownOutcome;
  if (named) error.tool = tool;
  if (Number.isInteger(exitCode) && exitCode >= 0) error.exitCode = exitCode;
  if (code !== undefined) error.refusalCode = code;
  if (REFUSAL_HINTS.has(code)) hint = REFUSAL_HINTS.get(code);
  else if (exitCode === PERMISSION_EXIT_CODE) hint = PERMISSION_HINT;
  if (hint !== undefined) error.hint = hint;
  return error;
}

const objectPrototypes = new WeakSet([Object.prototype]);
const arrayPrototypes = new WeakSet([Array.prototype]);
const objectSource = Function.prototype.toString.call(Object);
const arraySource = Function.prototype.toString.call(Array);

// Accept genuine Object/Array prototypes from another OMP realm, not classes or proxies.
function hasPlainPrototype(value, array = false) {
  const prototype = Object.getPrototypeOf(value);
  if (prototype === null) return !array;
  const known = array ? arrayPrototypes : objectPrototypes;
  if (known.has(prototype)) return true;
  if (isProxy(prototype)) return false;
  const constructor = Object.getOwnPropertyDescriptor(prototype, 'constructor')?.value;
  if (typeof constructor !== 'function' || isProxy(constructor)
    || Object.getOwnPropertyDescriptor(constructor, 'prototype')?.value !== prototype
    || Function.prototype.toString.call(constructor) !== (array ? arraySource : objectSource)) return false;
  known.add(prototype);
  return true;
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !isProxy(value) && hasPlainPrototype(value);
}

function validateJson(value, ancestors = new Set()) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number' && Number.isFinite(value)) return;
  if (typeof value !== 'object' || isProxy(value) || ancestors.has(value)) throw failure();

  const array = Array.isArray(value);
  if (array ? !hasPlainPrototype(value, true) : !isRecord(value)) {
    throw failure();
  }
  const keys = Reflect.ownKeys(value);
  if (array && keys.length !== value.length + 1) throw failure();
  ancestors.add(value);
  for (const key of keys) {
    if (array && key === 'length') continue;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (typeof key !== 'string' || !descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) {
      throw failure();
    }
    if (array) {
      const index = Number(key);
      if (!Number.isInteger(index) || index < 0 || index >= value.length || String(index) !== key) {
        throw failure();
      }
    }
    validateJson(descriptor.value, ancestors);
  }
  ancestors.delete(value);
}

// Callers check every required field's value as well as this closed field count.
function hasFieldCount(value, expected) {
  if (!isRecord(value)) return false;
  let count = 0;
  for (const key in value) {
    if (Object.hasOwn(value, key)) count += 1;
  }
  return count === expected;
}

// Driver 0.30.2 action receipts add one optional root summary string; nothing else opens up.
function hasActionFieldCount(receipt, required) {
  const hasSummary = Object.hasOwn(receipt, 'summary');
  return hasFieldCount(receipt, required + Number(hasSummary)) &&
    (!hasSummary || typeof receipt.summary === 'string');
}

function validPid(value) {
  return Number.isInteger(value) && value > 0 && value <= 0x7fffffff;
}

function validWindowId(value) {
  return Number.isInteger(value) && value > 0 && value <= 0xffffffff;
}

// Global on-screen records carry titles and app names; only these fields survive projection.
function projectable(window) {
  const { bounds } = window;
  return validPid(window.pid) && isRecord(bounds) &&
    Number.isFinite(bounds.x) && Number.isFinite(bounds.y) &&
    Number.isFinite(bounds.width) && bounds.width >= 0 &&
    Number.isFinite(bounds.height) && bounds.height >= 0 &&
    (!Object.hasOwn(window, 'z_index') || window.z_index === null || Number.isInteger(window.z_index));
}

function projectWindow(window, driverPid) {
  const { x, y, width, height } = window.bounds;
  return Object.freeze({
    window_id: window.window_id,
    pid: window.pid,
    bounds: Object.freeze({ x, y, width, height }),
    z_index: Object.hasOwn(window, 'z_index') ? window.z_index : null,
    driver_owned: driverPid !== undefined && window.pid === driverPid,
  });
}

function accepts(receipt, tool, session, args) {
  // Only root protocol fields matter. Nested page data is not a receipt.
  if (!isRecord(receipt) || Object.hasOwn(receipt, 'error') || Object.hasOwn(receipt, 'refusal')) {
    return false;
  }
  if ((Object.hasOwn(receipt, 'isError') && receipt.isError !== false) ||
      receipt.success === false || receipt.status === 'error' || receipt.status === 'refused' ||
      receipt.effect === 'refused') {
    return false;
  }
  if (tool === 'start_session' || tool === 'end_session') {
    if (!Object.hasOwn(receipt, 'session') || !Object.hasOwn(receipt, 'active') || receipt.session !== session) {
      return false;
    }
    if (tool === 'start_session') return receipt.active === true;
    return receipt.active === false && !Object.hasOwn(receipt, 'code') && receipt.cleanup_complete !== false;
  }
  if (tool === 'get_session') return receipt.session === session;
  if (tool === 'get_screen_size') {
    return [receipt.width, receipt.height, receipt.scale_factor].every(value => Number.isFinite(value) && value > 0);
  }
  if (tool === 'list_windows') {
    if (!Array.isArray(receipt.windows) || (Object.hasOwn(receipt, 'status') && receipt.status !== 'ok')) {
      return false;
    }
    // Exact-PID discovery must match its PID; the global occlusion view must be projectable.
    const scoped = Object.hasOwn(args, 'pid');
    const seen = new Set();
    for (const window of receipt.windows) {
      if (!isRecord(window) || (scoped ? window.pid !== args.pid : !projectable(window)) ||
          window.is_on_screen !== true || !validWindowId(window.window_id) || seen.has(window.window_id)) {
        return false;
      }
      seen.add(window.window_id);
    }
    return true;
  }
  if (tool === 'bring_to_front') {
    // Native WindowServer process evidence outranks Workspace; request acceptance is not focus proof.
    const effect = receipt.exact_window_effect;
    const observed = receipt.observed;
    return receipt.status === 'activated' && receipt.code === 'bring_to_front_exact_window_verified' &&
      receipt.pid === args.pid && receipt.window_id === args.window_id &&
      receipt.activated === true && receipt.process_activated === true &&
      isRecord(effect) && effect.verified === true && effect.focused === true &&
      effect.frontmost_ordinary === true && effect.target_visible_ordinary === true &&
      isRecord(observed) && observed.frontmost_pid === args.pid &&
      (observed.front_process_matches_target === true ||
        (observed.front_process_matches_target === null && observed.workspace_frontmost_pid === args.pid)) &&
      observed.focused_window_id === args.window_id && observed.frontmost_ordinary_window_id === args.window_id;
  }
  if (tool === 'browser_type') {
    if (!hasActionFieldCount(receipt, 3) || receipt.effect !== 'unverifiable' ||
        receipt.route !== 'trusted_input' || !hasFieldCount(receipt.delivery, 2) ||
        receipt.delivery.mode !== 'background' || typeof args.text !== 'string') return false;
    const delivered = receipt.delivery.delivered_count;
    if (!Number.isInteger(delivered) || delivered < 0 || delivered > 0xffffffff) return false;
    let requested = 0;
    for (const character of args.text) requested += 1;
    return delivered === requested;
  }
  if (tool === 'browser_click') {
    const dom = args.input_route === 'dom_event';
    return hasActionFieldCount(receipt, dom ? 4 : 3) &&
      receipt.effect === 'unverifiable' && receipt.route === (dom ? 'dom' : 'trusted_input') &&
      hasFieldCount(receipt.delivery, 1) && receipt.delivery.mode === 'background' &&
      (!dom || (hasFieldCount(receipt.escalation, 2) &&
        receipt.escalation.target === 'page' && receipt.escalation.reason === 'effect_unconfirmed'));
  }
  if (tool.startsWith('browser_') || tool === 'get_browser_state') {
    return Object.hasOwn(receipt, 'status') && receipt.status === 'ok';
  }
  return true;
}

function invoke(binary, argv, timeoutMs) {
  return new Promise((resolve, reject) => {
    try {
      execFile(binary, argv, {
        shell: false,
        encoding: 'utf8',
        timeout: timeoutMs,
        maxBuffer: MAX_BUFFER,
        // Bounds the CLI child, not work already admitted by its daemon.
        killSignal: 'SIGKILL',
      }, (error, stdout) => {
        // stdout stays private. A failed process may explain rejection, never prove success.
        resolve({ stdout, failed: Boolean(error), exitCode: error?.code });
      });
    } catch {
      reject(failure(true));
    }
  });
}

// The driver's own click-through overlay is an on-screen window owned by its daemon process.
async function daemonPid(binary, timeoutMs) {
  try {
    const output = await invoke(binary, ['status'], timeoutMs);
    if (output.failed || typeof output.stdout !== 'string') return undefined;
    const matches = [...output.stdout.matchAll(DAEMON_PID)];
    if (matches.length !== 1) return undefined;
    const pid = Number(matches[0][1]);
    return validPid(pid) ? pid : undefined;
  } catch {
    return undefined;
  }
}

async function canonicalOutputPath(path) {
  if (typeof path !== 'string' || !isAbsolute(path) || path.includes('\0') || path.endsWith(sep)) {
    throw failure();
  }
  const leaf = basename(path);
  if (leaf === '.' || leaf === '..') throw failure();
  const parent = await realpath(dirname(path));
  if (!(await stat(parent)).isDirectory()) throw failure();
  const output = join(parent, leaf);
  try {
    // Do not resolve the leaf, including dangling symlinks, or create it to pass policy.
    if (!(await lstat(output)).isFile()) throw failure();
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  // This preflight is not atomic no-clobber protection. Use a task-owned directory.
  return output;
}

/**
 * Invokes finite shell-free CLI calls. Session-aware tools receive the owned label in JSON.
 * Root receipts must lack error/refusal and cannot indicate isError, success:false,
 * status:error/refused, or effect:refused.
 * Start requires the exact session and active:true; end requires active:false for that session,
 * no code, and no cleanup_complete:false. Type/click require closed public action receipts:
 * unverifiable effect and background delivery, with typing's trusted_input route and full
 * Unicode scalar count, or clicking's request-selected dom/trusted_input route. DOM clicks
 * require the page/effect_unconfirmed escalation hint. Both allow one extra string summary.
 * These acknowledge delivery only, not page effect. Other browser receipts require status:'ok'.
 * Browser action correlation uses retained request arguments, not response echoes or nested page data.
 * resume() replaces start() for a caller-supplied label. It requires that label's journal entry
 * when journaling and an exact get_session receipt with state:'active', then records this
 * process as the entry's owner. Any resume failure after its lifecycle gate closes the instance.
 * getSession() reads only this label, only while active or uncertain, and grants no authority.
 * listWindows(pid), bringToFront({pid, window_id}), and listOnScreenWindows() require an active
 * instance and the same busy guard, but send no session. Discovery is exact-PID/on-screen only;
 * focus requires the requested and observed PID/window plus verified exact-window focus.
 * screenSize() follows the same rules and sends get_screen_size with an empty payload; it accepts
 * only finite positive width, height, and scale_factor and returns them as a frozen
 * {width, height, scale_factor} (main-display logical points, origin 0,0).
 * listOnScreenWindows() returns frozen {window_id, pid, bounds, z_index, driver_owned} records.
 * driver_owned is true only when the PID equals the daemon PID read lazily from <binary> status
 * (exit 0 with exactly one pid: line); a successful read is cached, otherwise retried.
 * Unknown ownership marks every record false. Titles and app names are dropped:
 * read-only occlusion evidence, never target discovery. These methods
 * reject overrides, and call() rejects session and window tool names with method guidance.
 * call() also refuses install_extension: installation is operator-owned and never dispatched.
 * call(tool, args = {}, options) accepts an optional options object that is exactly
 * {timeoutMs}: a plain object whose only own key is an enumerable data field holding an integer
 * 1..2^31-1. It bounds only this call's CLI child; the instance timeoutMs never changes.
 * An omitted or undefined options value uses the instance timeoutMs. Any other options value fails locally
 * (unknownOutcome:false) after the busy and lifecycle checks, before any filesystem or native work.
 * Journaling is on by default (journalDir overrides the directory). The entry is created before
 * start dispatch, kept while uncertain, and removed best-effort after a confirmed end; recovery
 * reports any stale entry. start() never replaces an existing entry for its label: it fails
 * locally before dispatch (unknownOutcome:false, instance still new) with resume/recovery guidance.
 * recordOwnership({target?, captureDirectory?}) updates an active instance's entry without
 * dispatch and only validates when journal:false.
 * Other tool-specific success predicates belong to the caller.
 * Explicit absolute screenshot_out_file/debug_image_out paths retain their leaf under a
 * canonical existing parent. No directory/file is created; symlink/non-file leaves fail
 * locally. Existing regular leaves still use native policy. This is not atomic no-clobber.
 * Errors name the validated tool. A nonzero exit or rejected receipt may expose only an
 * allowlisted refusalCode from refusal.code or root code, with static hints for actionable
 * codes, including cua-perception extension codes; exit 75 is the OS permission gate.
 * Nested codes take precedence. Unknown codes and
 * all native messages/details stay private. Nonzero exits always reject, even with a positive
 * receipt. Every dispatched failure remains unknownOutcome:true.
 * One start or resume attempt per instance. Explicit end retries are allowed until confirmed
 * closed. A successful end is terminal. Labels use 1-64 lowercase ASCII letters, digits, '_'
 * or '-', begin with a letter, and cannot be 'default'. These are conservative local policies.
 */
export function createCuaDriver(options = {}) {
  let binary;
  let session;
  let timeoutMs;
  let explicitSession;
  let journalDir;
  try {
    if (!isRecord(options)) throw failure();
    let journal;
    let journalOverride;
    ({
      binary = 'cua-driver',
      session,
      timeoutMs = 20_000,
      journal = true,
      journalDir: journalOverride,
    } = options);
    explicitSession = session !== undefined;
    if (!explicitSession) session = `omp-cua-jev-${randomUUID()}`;
    if (typeof binary !== 'string' || !binary.trim() || binary.includes('\0')) throw failure();
    if (typeof session !== 'string' || session.length > 64 || !/^[a-z]/.test(session) ||
        /[^a-z0-9_-]/.test(session) || session === 'default') {
      throw failure();
    }
    if (!Number.isInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > MAX_TIMEOUT_MS) throw failure();
    if (typeof journal !== 'boolean') throw failure();
    // Resolved once; the journal validates an explicit absolute override or the state environment.
    if (journal) journalDir = journalDirectory(journalOverride);
  } catch {
    throw failure();
  }

  // Single-use lifecycle: start() or resume() once. Only uncertain cleanup may be retried with end().
  let state = 'new';
  let busy = false;
  // Daemon pid from status; cached only after a successful read.
  let driverPid;

  async function operate(kind, tool, args, callOptions) {
    // failure() names only a well-formed tool; invalid names stay anonymous.
    if (busy) throw failure(false, undefined, undefined, undefined, tool);
    busy = true;
    let dispatched = false;
    let adopting = false;
    let exitCode;
    let refusalCode;
    let hint;
    try {
      if (typeof tool !== 'string' || !/^[a-z]/.test(tool) || /[^a-z0-9_]/.test(tool)) throw failure();
      if (kind === 'call' && METHOD_HINTS.has(tool)) {
        hint = METHOD_HINTS.get(tool);
        throw failure();
      }
      const scoped = kind === 'windows' || kind === 'focus';
      if (((kind === 'start' || kind === 'resume') && state !== 'new') ||
          ((kind === 'call' || scoped || kind === 'screen' || kind === 'size') && state !== 'active') ||
          ((kind === 'end' || kind === 'session') && state !== 'active' && state !== 'uncertain')) {
        throw failure();
      }
      // Only call() supplies options; they override this request's CLI timeout, never the default.
      let requestTimeoutMs = timeoutMs;
      if (callOptions !== undefined) {
        validateJson(callOptions);
        if (!hasFieldCount(callOptions, 1) || !Object.hasOwn(callOptions, 'timeoutMs')) throw failure();
        requestTimeoutMs = callOptions.timeoutMs;
        if (!Number.isInteger(requestTimeoutMs) || requestTimeoutMs <= 0 || requestTimeoutMs > MAX_TIMEOUT_MS) {
          throw failure();
        }
      }
      if (!isRecord(args) || Object.hasOwn(args, 'session')) throw failure();
      validateJson(args);
      if (scoped && (!Object.hasOwn(args, 'pid') || !validPid(args.pid) ||
          !hasFieldCount(args, kind === 'windows' ? 1 : 2))) throw failure();
      if (kind === 'focus' && (!Object.hasOwn(args, 'window_id') || !validWindowId(args.window_id))) {
        throw failure();
      }
      let requestArgs = kind === 'windows' ? { pid: args.pid, on_screen_only: true }
        : kind === 'screen' ? { on_screen_only: true }
        : kind === 'size' ? {}
        : kind === 'focus' ? { ...args }
        : tool === 'get_browser_state' ? { include_screenshot: false, ...args, session }
        : { ...args, session };
      let payload = JSON.stringify(requestArgs);
      if (Object.hasOwn(requestArgs, 'screenshot_out_file') || Object.hasOwn(requestArgs, 'debug_image_out')) {
        hint = 'Image output requires an absolute path, an existing directory parent, and a non-symlink file leaf. Check directory access; no native request was dispatched.';
        // Snapshot all nested input before the first filesystem await.
        requestArgs = JSON.parse(payload);
        if (Object.hasOwn(requestArgs, 'screenshot_out_file')) {
          requestArgs.screenshot_out_file = await canonicalOutputPath(requestArgs.screenshot_out_file);
        }
        if (Object.hasOwn(requestArgs, 'debug_image_out')) {
          requestArgs.debug_image_out = await canonicalOutputPath(requestArgs.debug_image_out);
        }
        payload = JSON.stringify(requestArgs);
        hint = undefined;
      }

      let entry;
      if (kind === 'resume') {
        // The lifecycle attempt is spent from here: resume never falls back or retries.
        adopting = true;
        hint = RESUME_HINT;
        if (!explicitSession) throw failure();
        if (journalDir !== undefined) {
          entry = await readEntry(journalDir, session);
          if (entry?.session !== session) throw failure();
        }
      } else if (kind === 'start' && journalDir !== undefined) {
        // Journal before dispatch so an uncertain start stays recoverable. Exclusive creation
        // never clobbers another instance's entry; the attempt stays unspent when it exists.
        hint = JOURNAL_HINT;
        const now = new Date().toISOString();
        try {
          await createEntry(journalDir, {
            schema: JOURNAL_SCHEMA, session, createdAt: now, updatedAt: now, owner: { pid: process.pid },
          });
        } catch (error) {
          if (error?.exists === true) hint = JOURNALED_HINT;
          throw error;
        }
        hint = undefined;
      }

      // Record the attempted lifecycle before dispatch, including synchronous spawn failure.
      if (kind === 'start' || kind === 'end') state = 'uncertain';
      if (kind === 'screen' && driverPid === undefined) driverPid = await daemonPid(binary, timeoutMs);
      dispatched = true;
      // Session-aware tools carry their label in JSON, never a CLI flag.
      const output = await invoke(binary, ['call', tool, payload], requestTimeoutMs);
      exitCode = output.exitCode;
      const receipt = JSON.parse(output.stdout);
      if (output.failed || !accepts(receipt, tool, session, requestArgs)) {
        const refusal = receipt?.refusal;
        refusalCode = isRecord(refusal) && Object.hasOwn(refusal, 'code') ? refusal.code : receipt?.code;
        throw failure(true);
      }
      if (kind === 'resume') {
        if (receipt.state !== 'active') throw failure(true);
        // Adopt the entry so owner-dead recovery cannot end the resumed session.
        if (entry !== undefined) {
          await writeEntry(journalDir, { ...entry, owner: { pid: process.pid }, updatedAt: new Date().toISOString() });
        }
      }
      if (kind === 'start' || kind === 'resume') state = 'active';
      if (kind === 'end') {
        state = 'ended';
        try {
          if (journalDir !== undefined) await removeEntry(journalDir, session);
        } catch {
          // Native cleanup is confirmed; recovery reports a stale inactive entry and removes it.
        }
      }
      // Acceptance is not authorization or proof of a native application's task outcome.
      if (kind === 'size') {
        const { width, height, scale_factor } = receipt;
        return Object.freeze({ width, height, scale_factor });
      }
      return kind === 'screen' ? Object.freeze(receipt.windows.map(window => projectWindow(window, driverPid))) : receipt;
    } catch {
      if (adopting) state = 'failed';
      // Never retain raw output, filesystem/native messages, arguments, or causes.
      throw failure(dispatched, exitCode, refusalCode, hint, tool);
    } finally {
      // Serializes local operations only; an uncertain daemon action may still be running.
      busy = false;
    }
  }

  // Local journal bookkeeping for an active instance. It never dispatches or grants authority.
  async function record(args) {
    if (busy) throw failure();
    busy = true;
    let hint;
    try {
      if (state !== 'active' || !isRecord(args)) throw failure();
      validateJson(args);
      const fields = {};
      if (Object.hasOwn(args, 'target')) {
        const { target } = args;
        if (!hasFieldCount(target, 2) || !validPid(target.pid) || !validWindowId(target.windowId)) throw failure();
        fields.target = { pid: target.pid, windowId: target.windowId };
      }
      if (Object.hasOwn(args, 'captureDirectory')) {
        const { captureDirectory } = args;
        if (typeof captureDirectory !== 'string' || !isAbsolute(captureDirectory) || captureDirectory.includes('\0')) {
          throw failure();
        }
        fields.captureDirectory = captureDirectory;
      }
      const count = Object.keys(fields).length;
      if (count === 0 || !hasFieldCount(args, count)) throw failure();
      if (journalDir === undefined) return;
      hint = JOURNAL_HINT;
      await updateEntry(journalDir, session, fields);
    } catch {
      throw failure(false, undefined, undefined, hint);
    } finally {
      busy = false;
    }
  }

  return Object.freeze({
    session,
    start(args = {}) { return operate('start', 'start_session', args); },
    resume() { return operate('resume', 'get_session', arguments.length === 0 ? {} : null); },
    getSession() { return operate('session', 'get_session', arguments.length === 0 ? {} : null); },
    call(tool, args = {}, options) { return operate('call', tool, args, options); },
    listWindows(pid) {
      return operate('windows', 'list_windows', arguments.length === 1 ? { pid } : null);
    },
    listOnScreenWindows() {
      return operate('screen', 'list_windows', arguments.length === 0 ? {} : null);
    },
    screenSize() {
      return operate('size', 'get_screen_size', arguments.length === 0 ? {} : null);
    },
    bringToFront(args) {
      return operate('focus', 'bring_to_front', arguments.length === 1 ? args : null);
    },
    recordOwnership(args) { return record(arguments.length === 1 ? args : null); },
    end(args = {}) { return operate('end', 'end_session', args); },
  });
}
