import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { isProxy } from 'node:util/types';

const MAX_TIMEOUT_MS = 2 ** 31 - 1;
const MAX_BUFFER = 4 * 1024 * 1024;

// Closed local allowlist, not every code in the native protocol's open refusal envelope.
// Pinned to trycua/cua@83f142c4290a0f7d9ed545ae8532858c6e4f8145:
// libs/cua-driver/rust/crates/cua-driver-core/src/browser/refusal.rs (BrowserRefusalCode)
// and src/session_tools.rs (end_session cleanup codes in the same crate).
const REFUSAL_CODES = new Set([
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

function failure(unknownOutcome = false, exitCode, refusalCode) {
  const error = new Error('Cua Driver request failed.');
  error.code = 'CUA_DRIVER_ERROR';
  error.unknownOutcome = unknownOutcome;
  if (Number.isInteger(exitCode) && exitCode >= 0) error.exitCode = exitCode;
  if (REFUSAL_CODES.has(refusalCode)) error.refusalCode = refusalCode;
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
      // Session travels in JSON, not a shell command or a --session flag.
      execFile(binary, ['call', tool, payload], {
        shell: false,
        encoding: 'utf8',
        timeout: timeoutMs,
        maxBuffer: MAX_BUFFER,
        // Bounds the CLI child, not work already admitted by its daemon.
        killSignal: 'SIGKILL',
      }, (error, stdout) => {
        if (error) reject(failure(true, error.code));
        else resolve(stdout);
      });
    } catch {
      reject(failure(true));
    }
  });
}

/**
 * Invokes execFile(binary, ['call', tool, JSON.stringify({ ...args, session })]).
 * Root receipts must lack error/refusal and cannot indicate isError, success:false or status:error.
 * Start requires the exact session and active:true; end requires active:false for that session,
 * no code, and no cleanup_complete:false. Type/click require closed public action receipts:
 * unverifiable effect and background delivery, with typing's trusted_input route and full
 * Unicode scalar count, or clicking's request-selected dom/trusted_input route. DOM clicks
 * require the page/effect_unconfirmed escalation hint. These acknowledge delivery only,
 * not page effect. Other browser receipts require status:'ok'.
 * Correlation uses retained request arguments, not response echoes or nested page data.
 * Other tool-specific success predicates belong to the caller.
 * Rejected receipts may expose only an allowlisted refusalCode from refusal.code or root code;
 * nested codes take precedence. Unknown codes and all native messages/details stay private.
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
      session = `omp-jev-${randomUUID()}`,
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
    let refusalCode;
    try {
      if (typeof tool !== 'string' || !/^[a-z]/.test(tool) || /[^a-z0-9_]/.test(tool)) throw failure();
      if (kind === 'call' && (tool === 'start_session' || tool === 'end_session')) throw failure();
      if ((kind === 'start' && state !== 'new') ||
          (kind === 'call' && state !== 'active') ||
          (kind === 'end' && state !== 'active' && state !== 'uncertain')) {
        throw failure();
      }
      if (!isRecord(args) || Object.hasOwn(args, 'session')) throw failure();
      validateJson(args);
      const requestArgs = tool === 'get_browser_state'
        ? { include_screenshot: false, ...args, session }
        : { ...args, session };
      const payload = JSON.stringify(requestArgs);

      // Record the attempted lifecycle before dispatch, including synchronous spawn failure.
      if (kind !== 'call') state = 'uncertain';
      dispatched = true;
      const receipt = JSON.parse(await invoke(binary, tool, payload, timeoutMs));
      if (!accepts(receipt, tool, session, requestArgs)) {
        refusalCode = receipt?.refusal?.code ?? receipt?.code;
        throw failure(true);
      }
      if (kind === 'start') state = 'active';
      if (kind === 'end') state = 'ended';
      // Acceptance is not authorization or proof of a native application's task outcome.
      return receipt;
    } catch (error) {
      // Retain only a numeric exit code and an allowlisted receipt code, never raw data or causes.
      throw failure(dispatched, error?.exitCode, refusalCode);
    } finally {
      // Serializes local operations only; an uncertain daemon action may still be running.
      busy = false;
    }
  }

  return Object.freeze({
    session,
    start(args = {}) { return operate('start', 'start_session', args); },
    call(tool, args = {}) { return operate('call', tool, args); },
    end(args = {}) { return operate('end', 'end_session', args); },
  });
}
