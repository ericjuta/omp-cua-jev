import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { lstat, realpath, stat } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, sep } from 'node:path';
import { isProxy } from 'node:util/types';

const MAX_TIMEOUT_MS = 2 ** 31 - 1;
const MAX_BUFFER = 4 * 1024 * 1024;

// Closed local allowlist, not every code in the native protocol's open refusal envelope.
// Pinned to trycua/cua@83f142c4290a0f7d9ed545ae8532858c6e4f8145:
// libs/cua-driver/rust/crates/cua-driver-core/src/browser/refusal.rs (BrowserRefusalCode)
// src/session_tools.rs (end_session cleanup codes) and src/tool.rs
// (protected_resource_scope_invalid) in the same crate, plus
// platform-macos/src/tools/bring_to_front.rs (exact-window verification).
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
]);

function failure(unknownOutcome = false, exitCode, refusalCode, hint) {
  const error = new Error('Cua Driver request failed.');
  error.code = 'CUA_DRIVER_ERROR';
  error.unknownOutcome = unknownOutcome;
  if (Number.isInteger(exitCode) && exitCode >= 0) error.exitCode = exitCode;
  if (REFUSAL_CODES.has(refusalCode)) {
    error.refusalCode = refusalCode;
    if (refusalCode === 'protected_resource_scope_invalid') {
      hint = 'Check the exact protected resource path. Screenshot output needs an existing canonical parent and a non-symlink file leaf. Native policy still applies; do not retry automatically.';
    } else if (refusalCode === 'bring_to_front_exact_window_unverified') {
      hint = 'Exact window focus was not confirmed. Inspect the scoped window state before considering another action; do not replay automatically.';
    } else if (refusalCode === 'browser_route_unavailable') {
      hint = 'The typed-browser route is unavailable for this target. This refusal does not test native AX or pixel control and does not authorize switching routes.';
    }
  }
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

function validPid(value) {
  return Number.isInteger(value) && value > 0 && value <= 0x7fffffff;
}

function validWindowId(value) {
  return Number.isInteger(value) && value > 0 && value <= 0xffffffff;
}

function accepts(receipt, tool, session, args) {
  // Only root protocol fields matter. Nested page data is not a receipt.
  if (!isRecord(receipt) || Object.hasOwn(receipt, 'error') || Object.hasOwn(receipt, 'refusal')) {
    return false;
  }
  if ((Object.hasOwn(receipt, 'isError') && receipt.isError !== false) ||
      receipt.success === false || receipt.status === 'error' || receipt.status === 'refused') {
    return false;
  }
  if (tool === 'start_session' || tool === 'end_session') {
    if (!Object.hasOwn(receipt, 'session') || !Object.hasOwn(receipt, 'active') || receipt.session !== session) {
      return false;
    }
    if (tool === 'start_session') return receipt.active === true;
    return receipt.active === false && !Object.hasOwn(receipt, 'code') && receipt.cleanup_complete !== false;
  }
  if (tool === 'list_windows') {
    if (!Array.isArray(receipt.windows) || (Object.hasOwn(receipt, 'status') && receipt.status !== 'ok')) {
      return false;
    }
    const seen = new Set();
    for (const window of receipt.windows) {
      if (!isRecord(window) || window.pid !== args.pid || window.is_on_screen !== true ||
          !validWindowId(window.window_id) || seen.has(window.window_id)) return false;
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
    if (!hasFieldCount(receipt, 3) || receipt.effect !== 'unverifiable' ||
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
    return hasFieldCount(receipt, dom ? 4 : 3) &&
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

function invoke(binary, tool, payload, timeoutMs) {
  return new Promise((resolve, reject) => {
    try {
      // Session-aware tools carry their label in JSON, never a CLI flag.
      execFile(binary, ['call', tool, payload], {
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
 * Root receipts must lack error/refusal and cannot indicate isError, success:false or status:error.
 * Start requires the exact session and active:true; end requires active:false for that session,
 * no code, and no cleanup_complete:false. Type/click require closed public action receipts:
 * unverifiable effect and background delivery, with typing's trusted_input route and full
 * Unicode scalar count, or clicking's request-selected dom/trusted_input route. DOM clicks
 * require the page/effect_unconfirmed escalation hint. These acknowledge delivery only,
 * not page effect. Other browser receipts require status:'ok'.
 * Browser action correlation uses retained request arguments, not response echoes or nested page data.
 * listWindows(pid) and bringToFront({pid, window_id}) require an active instance and the same
 * busy guard, but send no session. Discovery is exact-PID/on-screen only; focus requires the
 * requested and observed PID/window plus verified exact-window focus. These methods reject
 * overrides, and call() rejects their native tool names with static method guidance.
 * Other tool-specific success predicates belong to the caller.
 * Explicit absolute screenshot_out_file/debug_image_out paths retain their leaf under a
 * canonical existing parent. No directory/file is created; symlink/non-file leaves fail
 * locally. Existing regular leaves still use native policy. This is not atomic no-clobber.
 * Rejected receipts may expose only an allowlisted refusalCode from refusal.code or root code,
 * with static local hints for protected resource scope and typed-browser route refusals.
 * Nested codes take precedence. Unknown codes and all native messages/details stay private.
 * Nonzero exits always reject, even with a positive receipt; recognized rejection codes may
 * survive alongside a numeric exitCode. Every dispatched failure remains unknownOutcome:true.
 * One start attempt per instance. Explicit end retries are allowed until confirmed closed.
 * A successful end is terminal. Labels use 1-64 lowercase ASCII letters, digits, '_' or '-',
 * begin with a letter, and cannot be 'default'. These are conservative local policies.
 */
export function createCuaDriver(options = {}) {
  let binary;
  let session;
  let timeoutMs;
  try {
    if (!isRecord(options)) throw failure();
    ({
      binary = 'cua-driver',
      session = `omp-cua-jev-${randomUUID()}`,
      timeoutMs = 20_000,
    } = options);
    if (typeof binary !== 'string' || !binary.trim() || binary.includes('\0')) throw failure();
    if (typeof session !== 'string' || session.length > 64 || !/^[a-z]/.test(session) ||
        /[^a-z0-9_-]/.test(session) || session === 'default') {
      throw failure();
    }
    if (!Number.isInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > MAX_TIMEOUT_MS) throw failure();
  } catch {
    throw failure();
  }

  // Single-use lifecycle. Only uncertain cleanup may be retried with explicit end().
  let state = 'new';
  let busy = false;

  async function operate(kind, tool, args) {
    if (busy) throw failure();
    busy = true;
    let dispatched = false;
    let exitCode;
    let refusalCode;
    let hint;
    try {
      if (typeof tool !== 'string' || !/^[a-z]/.test(tool) || /[^a-z0-9_]/.test(tool)) throw failure();
      if (kind === 'call' && (tool === 'start_session' || tool === 'end_session')) throw failure();
      if (kind === 'call' && (tool === 'list_windows' || tool === 'bring_to_front')) {
        hint = tool === 'list_windows'
          ? 'Use listWindows(pid) for exact-PID window discovery; this tool has no session argument.'
          : 'Use bringToFront({ pid, window_id }) for explicitly authorized exact-window focus; this tool has no session argument.';
        throw failure();
      }
      const sessionless = kind === 'windows' || kind === 'focus';
      if ((kind === 'start' && state !== 'new') ||
          ((kind === 'call' || sessionless) && state !== 'active') ||
          (kind === 'end' && state !== 'active' && state !== 'uncertain')) {
        throw failure();
      }
      if (!isRecord(args) || Object.hasOwn(args, 'session')) throw failure();
      validateJson(args);
      if (sessionless && (!Object.hasOwn(args, 'pid') || !validPid(args.pid) ||
          !hasFieldCount(args, kind === 'windows' ? 1 : 2))) throw failure();
      if (kind === 'focus' && (!Object.hasOwn(args, 'window_id') || !validWindowId(args.window_id))) {
        throw failure();
      }
      let requestArgs = kind === 'windows' ? { pid: args.pid, on_screen_only: true }
        : sessionless ? { ...args }
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

      // Record the attempted lifecycle before dispatch, including synchronous spawn failure.
      if (kind === 'start' || kind === 'end') state = 'uncertain';
      dispatched = true;
      const output = await invoke(binary, tool, payload, timeoutMs);
      exitCode = output.exitCode;
      const receipt = JSON.parse(output.stdout);
      const accepted = accepts(receipt, tool, session, requestArgs);
      if (!accepted) {
        const refusal = receipt?.refusal;
        refusalCode = isRecord(refusal) && Object.hasOwn(refusal, 'code') ? refusal.code : receipt?.code;
      }
      if (output.failed || !accepted) throw failure(true);
      if (kind === 'start') state = 'active';
      if (kind === 'end') state = 'ended';
      // Acceptance is not authorization or proof of a native application's task outcome.
      return receipt;
    } catch {
      // Never retain raw output, filesystem/native messages, arguments, or causes.
      throw failure(dispatched, exitCode, refusalCode, hint);
    } finally {
      // Serializes local operations only; an uncertain daemon action may still be running.
      busy = false;
    }
  }

  return Object.freeze({
    session,
    start(args = {}) { return operate('start', 'start_session', args); },
    call(tool, args = {}) { return operate('call', tool, args); },
    listWindows(pid) {
      return operate('windows', 'list_windows', arguments.length === 1 ? { pid } : null);
    },
    bringToFront(args) {
      return operate('focus', 'bring_to_front', arguments.length === 1 ? args : null);
    },
    end(args = {}) { return operate('end', 'end_session', args); },
  });
}
