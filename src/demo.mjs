import { execFile } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { createCuaDriver } from './cua-driver.mjs';
import { createFixture } from './fixture.mjs';
import { runBounded } from './jev-loop.mjs';
import { observePreparedBrowser } from './owned-browser.mjs';

const READ_WAIT_MS = 8_000;
const OMISSIONS = ['css_hidden', 'offscreen', 'page_occluded', 'no_layout', 'unknown', 'budget', 'unprovable_frame'];
const SIDE_EFFECTS = ['launched_browser', 'restarted_browser', 'created_profile', 'reused_driver_profile',
  'copied_profile_data', 'changed_preferences', 'displayed_consent_prompt', 'opened_setup_page',
  'closed_setup_page', 'enabled_remote_debugging', 'used_bounded_pixel_fallback',
  'focused_setup_address_field', 'foregrounded_window', 'injected_global_input'];
const ACTIONS = new Set(['click', 'type', 'upload', 'pointer', 'scroll']);
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = value => typeof value === 'string' && value.length > 0;
const natural = value => Number.isSafeInteger(value) && value >= 0;

class DemoFailure extends Error {
  constructor(code, unknownOutcome = false) {
    super(code);
    this.code = code;
    this.unknownOutcome = unknownOutcome;
  }
}

function requireThat(condition, code, unknownOutcome = false) {
  if (!condition) throw new DemoFailure(code, unknownOutcome);
}

function unavailableJudge() {
  throw new DemoFailure('UNEXPECTED_JUDGE_CALL');
}

function sanitizedFailure(error, phase, session, unknownOutcome = false) {
  return {
    phase,
    session,
    code: typeof error?.code === 'string' && /^[A-Z0-9_]{1,64}$/.test(error.code)
      ? error.code : 'DEMO_OPERATION_FAILED',
    unknownOutcome: unknownOutcome || error?.unknownOutcome === true,
    exitCode: natural(error?.exitCode) ? error.exitCode : null,
    refusalCode: error?.code === 'CUA_DRIVER_ERROR' && typeof error.refusalCode === 'string'
      ? error.refusalCode : null,
    advice: phase === 'end_session'
      ? 'Only retry end_session for this same owned session; do not kill processes or delete profiles.'
      : 'Inspect this phase and its scoped evidence. Do not replay a mutation, widen scope, or change daemon permissions automatically.',
  };
}

// Only read-only CLI operations use this path. Mutations use the session helper.
function readCLI(binary, args) {
  return new Promise((resolve, reject) => {
    execFile(binary, args, { shell: false, encoding: 'utf8', timeout: 20_000,
      maxBuffer: 4 * 1024 * 1024, killSignal: 'SIGKILL' }, (error, stdout) => {
      if (!error) return resolve(stdout);
      const failure = new DemoFailure('CUA_READ_FAILED');
      if (natural(error.code)) failure.exitCode = error.code;
      reject(failure);
    });
  });
}

function positiveReply(value) {
  return record(value) && !Object.hasOwn(value, 'error') && !Object.hasOwn(value, 'refusal')
    && !Object.hasOwn(value, 'code') && value.success !== false
    && (!Object.hasOwn(value, 'isError') || value.isError === false)
    && value.status !== 'error' && value.status !== 'refused';
}

async function ownedWindow(driver, pid, recordWindows) {
  const deadline = performance.now() + READ_WAIT_MS;
  for (;;) {
    const result = await driver.listWindows(pid);
    requireThat(positiveReply(result) && Array.isArray(result.windows), 'INVALID_WINDOW_RECEIPT');
    requireThat(result.windows.every(window => record(window) && window.pid === pid
      && window.is_on_screen === true && natural(window.window_id)), 'WINDOW_SCOPE_MISMATCH');
    recordWindows(result.windows);
    requireThat(result.windows.length <= 1, 'OWNED_WINDOW_AMBIGUOUS');
    if (result.windows.length === 1) return { pid, window_id: result.windows[0].window_id };
    requireThat(performance.now() < deadline, 'OWNED_WINDOW_NOT_FOUND');
    await delay(150);
  }
}

function projectRef(ref, snapshotID, source) {
  requireThat(record(ref) && text(ref.ref) && ref.ref.startsWith(`${snapshotID}:`)
    && text(ref.role) && (ref.name === null || typeof ref.name === 'string')
    && (ref.value === null || typeof ref.value === 'string') && record(ref.states)
    && Array.isArray(ref.actions) && ref.actions.every(action => ACTIONS.has(action))
    && typeof ref.visibility === 'string' && typeof ref.frame === 'string', 'INVALID_SEMANTIC_REF');
  const states = {};
  for (const key of ['disabled', 'editable', 'focusable', 'focused', 'required']) {
    if (!Object.hasOwn(ref.states, key)) continue;
    const value = ref.states[key];
    requireThat(value === null || typeof value === 'boolean' || typeof value === 'string', 'INVALID_CONTROL_STATE');
    states[key] = value;
  }
  return { ref: ref.ref, role: ref.role, name: ref.name, value: ref.value, states,
    actions: [...ref.actions], frame: ref.frame, visibility: ref.visibility, source };
}

function snapshotEvidence(reply, targetID, tabID, fixtureURL) {
  requireThat(positiveReply(reply) && reply.status === 'ok' && reply.mode === 'snapshot'
    && reply.target_id === targetID && reply.tab_id === tabID
    && record(reply.page) && typeof reply.page.url === 'string', 'SNAPSHOT_SCOPE_MISMATCH');
  const snapshot = reply.snapshot;
  requireThat(record(snapshot) && text(snapshot.id) && snapshot.format === 'semantic_v2'
    && snapshot.scope === 'query' && typeof snapshot.complete === 'boolean'
    && natural(snapshot.selected_nodes) && natural(snapshot.total_nodes)
    && record(snapshot.omitted) && OMISSIONS.every(key => natural(snapshot.omitted[key]))
    && (snapshot.continuation === null || text(snapshot.continuation))
    && Array.isArray(reply.refs) && Array.isArray(reply.content_refs), 'INVALID_SEMANTIC_SNAPSHOT');
  const omitted = Object.fromEntries(OMISSIONS.map(key => [key, snapshot.omitted[key]]));
  // Visibility counters cover the whole document, including roots outside this query.
  // Require full identity coverage and visible main-frame evidence for every query match.
  const visibleMatch = ref => record(ref) && ref.frame === 'main' && ref.visibility === 'in_viewport';
  const complete = snapshot.complete && snapshot.continuation === null
    && snapshot.selected_nodes === snapshot.total_nodes
    && snapshot.selected_nodes === reply.refs.length + reply.content_refs.length
    && reply.refs.every(visibleMatch) && reply.content_refs.every(visibleMatch)
    && ['css_hidden', 'page_occluded', 'budget', 'unprovable_frame'].every(key => omitted[key] === 0);
  const scope = { targetID, tabID, pageURL: reply.page.url, snapshot: {
    id: snapshot.id, format: snapshot.format, scope: snapshot.scope, complete, collectionComplete: snapshot.complete,
    selectedNodes: snapshot.selected_nodes, totalNodes: snapshot.total_nodes, omitted,
  } };
  // A navigating blank tab and an incomplete observation are never action evidence.
  if (reply.page.url !== fixtureURL || !complete) return { ...scope, field: null, button: null, confirmation: [] };
  const fields = [];
  const buttons = [];
  const confirmation = [];
  const seen = new Set();
  for (const [source, refs] of [['refs', reply.refs], ['content_refs', reply.content_refs]]) {
    for (const ref of refs) {
      requireThat(record(ref) && text(ref.ref) && !seen.has(ref.ref), 'DUPLICATE_OR_INVALID_REF');
      seen.add(ref.ref);
      if (ref.role === 'textbox' && ref.name === 'Receipt code') fields.push(projectRef(ref, snapshot.id, source));
      if (ref.role === 'button' && ref.name === 'Save receipt') buttons.push(projectRef(ref, snapshot.id, source));
      if (source === 'content_refs' && ['status', 'statictext', 'text'].includes(ref.role)
        && (ref.name === 'Receipt saved' || ref.value === 'Receipt saved')
        && ref.frame === 'main' && ref.visibility === 'in_viewport') {
        const item = projectRef(ref, snapshot.id, source);
        requireThat(item.actions.length === 0, 'INVALID_CONFIRMATION_REF');
        confirmation.push(item);
      }
    }
  }
  requireThat(fields.length <= 1 && buttons.length <= 1, 'FIXTURE_CONTROL_AMBIGUOUS');
  return { ...scope, field: fields[0] ?? null, button: buttons[0] ?? null, confirmation };
}

function actionable(ref, action) {
  return ref !== null && ref.source === 'refs' && ref.frame === 'main'
    && ref.visibility === 'in_viewport' && ref.actions.includes(action)
    && (!Object.hasOwn(ref.states, 'disabled') || ref.states.disabled === false)
    && (!Object.hasOwn(ref.states, 'focusable') || ref.states.focusable === true)
    && (action !== 'type' || !Object.hasOwn(ref.states, 'editable') || ref.states.editable === true
      || (typeof ref.states.editable === 'string' && ref.states.editable !== 'false'));
}

async function readReceipt(fixture) {
  const response = await fetch(fixture.receiptURL, { method: 'GET', redirect: 'error', cache: 'no-store',
    signal: AbortSignal.timeout(3_000) });
  requireThat(response.status === 200 && response.url === fixture.receiptURL, 'RECEIPT_READ_FAILED');
  const receipt = await response.json();
  requireThat(record(receipt) && (receipt.token === null || typeof receipt.token === 'string')
    && natural(receipt.count) && natural(receipt.attempts), 'INVALID_SERVER_RECEIPT');
  return { token: receipt.token, count: receipt.count, attempts: receipt.attempts };
}

const emptyReceipt = receipt => receipt.token === null && receipt.count === 0 && receipt.attempts === 0;
const savedReceipt = (receipt, token) => receipt.token === token && receipt.count === 1 && receipt.attempts === 1;
const exactObject = (value, expected) => record(value) && Object.keys(value).length === Object.keys(expected).length
  && Object.keys(expected).every(key => Object.hasOwn(value, key) && value[key] === expected[key]);

/**
 * Real isolated native-browser demo. Inject the current eval's judge function;
 * exact fixture controls use deterministic IDs, so the expected judgeCalls is zero.
 * No dependency on OMP plugins, no permission changes, no mutation retries.
 * success requires task proof AND lifecycle, fixture, returned-PID and profile cleanup.
 */
export async function runDemo({ judge = unavailableJudge, onProgress, binary = 'cua-driver' } = {}) {
  const startedAt = performance.now();
  let phase = 'configuration';
  let driver = null;
  let fixture = null;
  let ownership = null;
  let startAttempted = false;
  let prepareAttempted = false;
  let preparedPID = null;
  let targetID = null;
  let tabID = null;
  let stage = 'ready';
  let lastObservation = null;
  let localTable = null;
  let fillVerified = false;
  let taskFailure = null;
  let loopResult = null;
  const counts = { fill: 0, click: 0, snapshots: 0 };
  let judgeCalls = 0;
  const native = { daemon: null, start: null, preparation: null, windows: null, window: null, binding: null, navigation: null, actions: [] };
  const cleanup = {
    complete: false,
    sessionEnd: { required: false, confirmed: false, attempts: 0, receipt: null, failures: [] },
    physical: { before: null, after: null },
    fixture: { required: false, closed: false, failure: null },
  };
  const session = () => driver?.session ?? null;
  async function at(name, operation, unknownOutcome = false) {
    phase = name;
    try { return await operation(); }
    catch (error) {
      taskFailure ??= sanitizedFailure(error, name, session(), unknownOutcome);
      throw error;
    }
  }
  function done(observation) {
    const state = observation?.state;
    return record(state) && state.pageURL === fixture.url && state.snapshot.complete
      && state.field?.value === fixture.token && savedReceipt(state.receipt, fixture.token)
      && state.confirmation.length > 0 && fillVerified && counts.fill === 1 && counts.click === 1;
  }
  async function observe() {
    return at(stage === 'ready' ? 'observe_fixture' : stage === 'fill' ? 'verify_fill' : 'verify_click', async () => {
      const deadline = performance.now() + READ_WAIT_MS;
      let pendingCode = 'FIXTURE_NOT_READY';
      for (;;) {
        const reply = await driver.call('get_browser_state', { target_id: targetID, tab_id: tabID,
          snapshot_format: 'semantic_v2', include_screenshot: false, query: 'receipt' });
        counts.snapshots++;
        const state = snapshotEvidence(reply, targetID, tabID, fixture.url);
        requireThat(state.pageURL === fixture.url || (stage === 'ready' && state.pageURL === 'about:blank'),
          'FIXTURE_URL_MISMATCH', stage !== 'ready');
        state.receipt = await readReceipt(fixture);
        lastObservation = { id: `${targetID}/${tabID}/${state.snapshot.id}`, observedAt: Date.now(), state };
        if (state.pageURL === fixture.url && state.snapshot.complete) {
          if (stage === 'ready' || stage === 'fill') {
            requireThat(emptyReceipt(state.receipt) && state.confirmation.length === 0, 'UNEXPECTED_FIXTURE_SUBMISSION', stage !== 'ready');
            const valueMatches = stage === 'ready'
              ? state.field !== null && (state.field.value === null || state.field.value === '')
              : state.field?.value === fixture.token;
            if (valueMatches && actionable(state.field, 'type') && actionable(state.button, 'click')) return lastObservation;
            pendingCode = stage === 'fill' ? 'EXACT_FIELD_VALUE_NOT_CONFIRMED' : 'FIXTURE_CONTROLS_NOT_ACTIONABLE';
          } else {
            requireThat(state.receipt.count <= 1 && state.receipt.attempts <= 1
              && (state.receipt.token === null || state.receipt.token === fixture.token), 'UNEXPECTED_SERVER_RECEIPT', true);
            if (state.field?.value === fixture.token && savedReceipt(state.receipt, fixture.token)
              && state.confirmation.length > 0) return lastObservation;
            pendingCode = 'SAVE_POSTCONDITIONS_NOT_CONFIRMED';
          }
        } else pendingCode = state.pageURL === fixture.url ? 'SEMANTIC_SNAPSHOT_INCOMPLETE' : 'FIXTURE_NOT_READY';
        requireThat(performance.now() < deadline, pendingCode, stage !== 'ready');
        // Poll only observations. No navigation, type or click is retried.
        await delay(150);
      }
    }, stage !== 'ready');
  }
  function getCandidates(observation) {
    const state = observation.state;
    const candidates = [];
    if (state.pageURL === fixture.url && state.snapshot.complete && emptyReceipt(state.receipt)
      && actionable(state.field, 'type') && actionable(state.button, 'click')) {
      if (counts.fill === 0 && counts.click === 0 && (state.field.value === null || state.field.value === '')) {
        candidates.push({ id: 'fill_receipt', description: 'Replace the unique Receipt code field with the exact synthetic token.',
          action: { tool: 'browser_type', args: { target_id: targetID, tab_id: tabID, ref: state.field.ref,
            text: fixture.token, replace: true, mode: 'insert_text' } } });
      } else if (counts.fill === 1 && fillVerified && counts.click === 0 && state.field.value === fixture.token) {
        candidates.push({ id: 'save_receipt', description: 'Submit the synthetic receipt once using the unique Save receipt button.',
          action: { tool: 'browser_click', args: { target_id: targetID, tab_id: tabID, ref: state.button.ref,
            input_route: 'dom_event' } } });
      }
    }
    localTable = { observation, entries: new Map(candidates.map(candidate => [candidate.id, candidate])) };
    return candidates;
  }
  function authorize(candidate, observation) {
    const expected = localTable?.entries.get(candidate.id);
    const state = observation.state;
    if (expected !== candidate || localTable.observation !== observation || lastObservation !== observation
      || state.targetID !== targetID || state.tabID !== tabID || state.pageURL !== fixture.url
      || !state.snapshot.complete || !emptyReceipt(state.receipt) || state.confirmation.length !== 0
      || !exactObject(candidate.action, { tool: expected.action.tool, args: expected.action.args })) return false;
    if (candidate.id === 'fill_receipt') {
      return candidate.action.tool === 'browser_type' && counts.fill === 0 && counts.click === 0
        && actionable(state.field, 'type') && (state.field.value === null || state.field.value === '')
        && exactObject(candidate.action.args, { target_id: targetID, tab_id: tabID, ref: state.field.ref,
          text: fixture.token, replace: true, mode: 'insert_text' });
    }
    if (candidate.id === 'save_receipt') {
      return candidate.action.tool === 'browser_click' && counts.fill === 1 && fillVerified && counts.click === 0
        && state.field?.value === fixture.token && actionable(state.button, 'click')
        && exactObject(candidate.action.args, { target_id: targetID, tab_id: tabID, ref: state.button.ref,
          input_route: 'dom_event' });
    }
    return false;
  }
  async function execute(candidate, observation) {
    requireThat(authorize(candidate, observation), 'ACTION_NOT_AUTHORIZED');
    const fill = candidate.id === 'fill_receipt';
    stage = fill ? 'fill' : 'click';
    counts[stage]++;
    const { tool, args } = candidate.action;
    const action = { id: candidate.id, tool, targetID, tabID, ref: args.ref,
      accepted: false, receipt: null, verification: null };
    native.actions.push(action);
    await at(tool, async () => {
      const receipt = await driver.call(tool, args);
      requireThat(positiveReply(receipt) && receipt.effect === 'unverifiable'
        && record(receipt.delivery) && receipt.delivery.mode === 'background', 'ACTION_RECEIPT_MISMATCH', true);
      if (fill) {
        requireThat(exactObject(receipt, { effect: 'unverifiable', route: 'trusted_input', delivery: receipt.delivery })
          && exactObject(receipt.delivery, { mode: 'background', delivered_count: fixture.token.length }),
        'FILL_DELIVERY_NOT_CONFIRMED', true);
      } else {
        requireThat(exactObject(receipt, { effect: 'unverifiable', route: 'dom', delivery: receipt.delivery,
          escalation: receipt.escalation }) && exactObject(receipt.delivery, { mode: 'background' })
          && exactObject(receipt.escalation, { target: 'page', reason: 'effect_unconfirmed' }),
        'CLICK_DELIVERY_NOT_CONFIRMED', true);
      }
      action.receipt = receipt;
      action.accepted = true;
    }, true);
  }
  function verify(candidate, before, after) {
    const state = after.state;
    const fresh = before.id !== after.id && state.targetID === targetID && state.tabID === tabID
      && state.pageURL === fixture.url && state.snapshot.complete;
    let verified;
    if (candidate.id === 'fill_receipt') {
      fillVerified = fresh && state.field?.value === fixture.token && emptyReceipt(state.receipt)
        && state.confirmation.length === 0;
      verified = fillVerified;
    } else verified = candidate.id === 'save_receipt' && fresh && done(after);
    native.actions[native.actions.length - 1].verification = {
      verified, observationId: after.id, pageURL: state.pageURL,
      fieldValue: state.field?.value ?? null, serverReceipt: state.receipt,
      renderedConfirmation: state.confirmation.length > 0,
    };
    return verified;
  }

  try {
    requireThat(typeof judge === 'function' && (onProgress === undefined || typeof onProgress === 'function'), 'INVALID_DEMO_OPTIONS');
    driver = createCuaDriver({ binary });
    await at('daemon_status', async () => {
      const status = await readCLI(binary, ['status']);
      requireThat(/^Cua Driver daemon is running\r?$/m.test(status), 'EXISTING_DAEMON_REQUIRED');
      const mode = status.match(/^\s*permission mode: (standard|bounded|unrestricted)\b/m)?.[1] ?? null;
      native.daemon = { running: true, permissionMode: mode };
    });
    if (onProgress) await at('session_owned', () => onProgress({ phase: 'session_owned', session: driver.session }));
    startAttempted = true;
    cleanup.sessionEnd.required = true;
    const started = await at('start_session', () => driver.start(), true);
    native.start = { session: started.session, active: started.active };
    fixture = await at('fixture_start', createFixture);
    cleanup.fixture.required = true;
    prepareAttempted = true;
    const prepared = await at('browser_prepare', () => driver.call('browser_prepare', {
      allow_launch: true, profile: { mode: 'isolated_new' },
    }), true);
    await at('validate_preparation', async () => {
      requireThat(positiveReply(prepared) && prepared.status === 'ok'
        && prepared.prepared === true && prepared.action === 'launched_isolated_browser'
        && natural(prepared.prepared_pid) && prepared.prepared_pid > 0, 'ISOLATED_PREPARATION_NOT_CONFIRMED', true);
      preparedPID = prepared.prepared_pid;
      requireThat(prepared.endpoint_ownership?.method === 'spawned_by_driver'
        && prepared.endpoint_ownership.owner_pid === preparedPID && prepared.attachment === null
        && record(prepared.side_effects) && SIDE_EFFECTS.every(key => prepared.side_effects[key]
          === (key === 'launched_browser' || key === 'created_profile')), 'ISOLATED_OWNERSHIP_NOT_CONFIRMED', true);
      native.preparation = { preparedPID, action: prepared.action,
        ownershipMethod: prepared.endpoint_ownership.method, ownerPID: prepared.endpoint_ownership.owner_pid,
        sideEffects: Object.fromEntries(SIDE_EFFECTS.map(key => [key, prepared.side_effects[key]])) };
      ownership = await observePreparedBrowser(preparedPID);
      cleanup.physical.before = ownership.evidence;
    }, true);
    native.window = await at('list_owned_windows', () => ownedWindow(driver, preparedPID,
      windows => { native.windows = windows; }));
    const bound = await at('bind_owned_window', () => driver.call('get_browser_state', {
      ...native.window, snapshot_format: 'semantic_v2', include_screenshot: false,
    }));
    requireThat(positiveReply(bound) && bound.status === 'ok' && bound.mode === 'bind' && bound.binding_quality === 'exact'
      && bound.endpoint_access_class === 'driver_owned' && bound.mutation_allowed === true
      && text(bound.target_id) && Array.isArray(bound.tabs) && bound.tabs.length === 1
      && text(bound.tabs[0]?.tab_id), 'EXACT_OWNED_TAB_NOT_CONFIRMED');
    targetID = bound.target_id;
    tabID = bound.tabs[0].tab_id;
    native.binding = { targetID, tabID, bindingQuality: bound.binding_quality,
      endpointAccessClass: bound.endpoint_access_class, mutationAllowed: bound.mutation_allowed, returnedTabs: bound.tabs.length };
    await at('navigate_fixture', async () => {
      const navigated = await driver.call('browser_navigate', { target_id: targetID, tab_id: tabID, url: fixture.url });
      requireThat(positiveReply(navigated) && navigated.status === 'ok'
        && navigated.target_id === targetID && navigated.tab_id === tabID && navigated.url === fixture.url
        && navigated.refs_invalidated === true, 'NAVIGATION_RECEIPT_MISMATCH', true);
      native.navigation = { targetID, tabID, url: fixture.url, refsInvalidated: true };
    }, true);
    loopResult = await runBounded({
      judge: async (...args) => { judgeCalls++; return judge(...args); },
      goal: 'Save the exact synthetic receipt once on this owned localhost fixture, then verify server state and rendered confirmation.',
      observe, getCandidates, authorize, execute, verify, isDone: done,
      deterministicId: (observation, candidates) => localTable?.observation === observation && candidates.length === 1
        && localTable.entries.get(candidates[0].id) === candidates[0] ? candidates[0].id : null,
      maxSteps: 2,
      // Leave confidence, probability and observation-age gates unchanged.
    });
    if (loopResult.status !== 'complete' || !done(lastObservation)) {
      taskFailure ??= sanitizedFailure(new DemoFailure('BOUNDED_TASK_NOT_COMPLETE'), phase, session(),
        loopResult.status === 'unknown' || loopResult.status === 'unverified');
    }
  } catch (error) {
    taskFailure ??= sanitizedFailure(error, phase, session());
  } finally {
    try {
      if (startAttempted) {
        for (let attempt = 1; attempt <= 3; attempt++) {
          cleanup.sessionEnd.attempts = attempt;
          try {
            const ended = await driver.end();
            requireThat(positiveReply(ended) && ended.session === driver.session && ended.active === false
              && ended.cleanup_complete !== false, 'SESSION_END_NOT_CONFIRMED', true);
            cleanup.sessionEnd.confirmed = true;
            cleanup.sessionEnd.receipt = { session: ended.session, active: ended.active };
            break;
          } catch (error) {
            cleanup.sessionEnd.failures.push(sanitizedFailure(error, 'end_session', session(), true));
          }
          if (attempt < 3) await delay(250);
        }
      }
      if (ownership) {
        try { cleanup.physical.after = await ownership.verifyAfterEnd(); }
        catch {
          cleanup.physical.after = { complete: false, pidExited: false, profileAbsent: false,
            limits: ['Owned physical cleanup observation failed; inactive end alone is not process/profile proof.'] };
        }
      } else {
        cleanup.physical.after = { complete: !prepareAttempted, pidExited: false, profileAbsent: false,
          preparedPID, required: prepareAttempted, limits: prepareAttempted
            ? ['Preparation was attempted without retained physical ownership proof; resources cannot be enumerated or guessed.'] : [] };
      }
    } finally {
      // Fixture closure must still run after any native cleanup failure.
      if (fixture) {
        try { await fixture.close(); cleanup.fixture.closed = true; }
        catch (error) { cleanup.fixture.failure = sanitizedFailure(error, 'fixture_close', session()); }
      }
    }
  }
  cleanup.complete = (!cleanup.sessionEnd.required || cleanup.sessionEnd.confirmed)
    && (!cleanup.fixture.required || cleanup.fixture.closed) && cleanup.physical.after?.complete === true;
  const taskComplete = loopResult?.status === 'complete' && fixture !== null && done(lastObservation);
  const success = taskComplete && cleanup.complete;
  return {
    success, status: success ? 'complete' : taskComplete ? 'cleanup_incomplete' : 'failed', session: session(),
    elapsedMs: Math.round(performance.now() - startedAt), judgeCalls, deterministic: true, counts, native,
    task: { complete: taskComplete, status: loopResult?.status ?? 'failed', failure: taskFailure,
      unknownOutcome: taskFailure?.unknownOutcome === true || loopResult?.status === 'unknown',
      fixture: fixture ? { url: fixture.url, receiptURL: fixture.receiptURL, expectedToken: fixture.token } : null,
      fillVerified, observation: lastObservation, loop: loopResult === null ? null : {
        status: loopResult.status, steps: loopResult.steps, history: loopResult.history.map(entry => ({
          step: entry.step, observationId: entry.observationId, candidateId: entry.candidateId ?? null,
          status: entry.status, startedAt: entry.startedAt, finishedAt: entry.finishedAt,
        })),
      } },
    cleanup,
  };
}

if (import.meta.main) {
  const result = await runDemo({ judge: unavailableJudge,
    onProgress: ({ phase, session }) => { process.stderr.write(`${JSON.stringify({ phase, session })}\n`); },
  });
  console.log(JSON.stringify(result, null, 2));
  process.exitCode = result.success ? 0 : 1;
}
