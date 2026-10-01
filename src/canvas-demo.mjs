import { execFile } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { createCanvasFixture } from './canvas-fixture.mjs';
import { createCuaDriver } from './cua-driver.mjs';
import { runBounded } from './jev-loop.mjs';
import { createNativeTarget } from './native-target.mjs';
import { observePreparedBrowser } from './owned-browser.mjs';
import { labelRegions } from './visual.mjs';

const READ_WAIT_MS = 8_000;
const SIDE_EFFECTS = ['launched_browser', 'restarted_browser', 'created_profile', 'reused_driver_profile',
  'copied_profile_data', 'changed_preferences', 'displayed_consent_prompt', 'opened_setup_page',
  'closed_setup_page', 'enabled_remote_debugging', 'used_bounded_pixel_fallback',
  'focused_setup_address_field', 'foregrounded_window', 'injected_global_input'];
const OMISSIONS = ['css_hidden', 'offscreen', 'page_occluded', 'no_layout', 'unknown', 'budget', 'unprovable_frame'];
const ACTIONS = new Set(['click', 'type', 'upload', 'pointer', 'scroll']);
// Synthetic fixture contract: window title, semantic status text and the exact available-seat paint.
const PAGE_TITLE = 'omp-cua-jev canvas demo';
const CLEAR_NAME = 'Clear selection';
const STATUS_PREFIX = 'Selected: ';
const NO_SELECTION = `${STATUS_PREFIX}none`;
const SEAT_RGB = [0, 85, 255];
const SEAT_RGB_TOLERANCE = 8;
const SEAT_PATTERN = /^[A-Z][0-9]{1,2}$/;
const CLEAR_ID = 'clear_selection';
// Only these pre-dispatch geometry-guard reasons mean the seat click was refused without delivery.
const REFUSALS = new Set(['target_occluded', 'target_moved', 'target_missing', 'target_offscreen', 'guard_unavailable']);
const REASONS = new Set([...REFUSALS, 'target_moved_during_dispatch', 'guard_unavailable_after_dispatch',
  'pixel_routed_to_accessibility']);
// Visual mode: missing prerequisites stop before any click and report status:"blocked".
const BLOCKED = new Set(['JUDGE_REQUIRED', 'PERCEPTION_NOT_INSTALLED']);
// OCR text is untrusted; only short label-shaped text reaches the judge or the report.
const OCR_LABEL = /^[A-Za-z0-9]{1,8}$/;
const REFUSAL_CODE = /^[a-z][a-z0-9_]{0,63}$/;
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = value => typeof value === 'string' && value.length > 0;
const natural = value => Number.isSafeInteger(value) && value >= 0;
const positive = value => Number.isSafeInteger(value) && value > 0;
const seatID = seat => `select_${seat.toLowerCase()}`;
const ocrLabel = value => typeof value === 'string' && OCR_LABEL.test(value.trim()) ? value.trim() : null;
const seatColour = (r, g, b, a) => Math.abs(r - SEAT_RGB[0]) <= SEAT_RGB_TOLERANCE
  && Math.abs(g - SEAT_RGB[1]) <= SEAT_RGB_TOLERANCE && Math.abs(b - SEAT_RGB[2]) <= SEAT_RGB_TOLERANCE
  && (a === undefined || a === 255);
// Only a native pre-dispatch rejection proves that no input was delivered.
const dispatchUnknown = error => !(error?.code === 'NATIVE_TARGET_ERROR' && error.unknownOutcome === false);

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
  const reason = error?.code === 'NATIVE_TARGET_ERROR' && REASONS.has(error.reason) ? error.reason : null;
  return {
    phase,
    session,
    code: typeof error?.code === 'string' && /^[A-Z0-9_]{1,64}$/.test(error.code)
      ? error.code : 'DEMO_OPERATION_FAILED',
    unknownOutcome: unknownOutcome || error?.unknownOutcome === true,
    exitCode: natural(error?.exitCode) ? error.exitCode : null,
    refusalCode: (error?.code === 'CUA_DRIVER_ERROR' || error instanceof DemoFailure) && typeof error.refusalCode === 'string'
      ? error.refusalCode : null,
    reason,
    advice: phase === 'end_session' || phase === 'native_end'
      ? 'Only retry end for this same owned session; do not kill processes or delete profiles.'
      : REFUSALS.has(reason) && error.unknownOutcome === false
        ? 'The native geometry guard refused before dispatch. Keep the owned window unobstructed and stationary, '
          + 'then rerun the whole demo; never replay into another window.'
        : error?.code === 'PERCEPTION_NOT_INSTALLED'
          ? 'The optional cua-perception extension is not installed. Installing it is an operator decision; never install it automatically.'
          : 'Inspect this phase and its scoped evidence. Do not replay a mutation, widen scope, or change daemon permissions automatically.',
  };
}

// Only read-only CLI operations use this path. Mutations use the session helpers.
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

const exactObject = (value, expected) => record(value) && Object.keys(value).length === Object.keys(expected).length
  && Object.keys(expected).every(key => Object.hasOwn(value, key) && value[key] === expected[key]);

// Available seats in fixture order, which is strictly left to right in canvas CSS pixels.
function seatLayout(fixture) {
  const { availableSeats, seats } = fixture;
  requireThat(Array.isArray(availableSeats) && Array.isArray(seats) && availableSeats.length >= 2
    && availableSeats.length <= 24 && new Set(availableSeats).size === availableSeats.length, 'FIXTURE_CONTRACT_MISMATCH');
  const layout = availableSeats.map(seat => {
    const matches = seats.filter(item => record(item) && item.seat === seat);
    const item = matches[0];
    requireThat(typeof seat === 'string' && SEAT_PATTERN.test(seat) && matches.length === 1 && item.available === true
      && Number.isFinite(item.x) && Number.isFinite(item.y) && Number.isFinite(item.radius) && item.radius > 0,
    'FIXTURE_CONTRACT_MISMATCH');
    return { seat, x: item.x, y: item.y, radius: item.radius };
  });
  requireThat(layout.every((item, index) => index === 0 || item.x > layout[index - 1].x), 'FIXTURE_CONTRACT_MISMATCH');
  return layout;
}

function serverState(fixture) {
  const state = fixture.state();
  requireThat(record(state) && Array.isArray(state.clicks) && state.clicks.every(click => record(click)
    && text(click.seat) && typeof click.trusted === 'boolean')
    && (state.selected === null || text(state.selected)), 'INVALID_FIXTURE_STATE');
  return { clicks: state.clicks.map(({ seat, trusted }) => ({ seat, trusted })), selected: state.selected };
}

const untouched = server => server.clicks.length === 0 && server.selected === null;
const oneTrustedClick = (server, seat) => server.clicks.length === 1 && server.clicks[0].seat === seat
  && server.clicks[0].trusted === true;
const selectedState = (server, seat) => oneTrustedClick(server, seat) && server.selected === seat;
const clearedState = (server, seat) => oneTrustedClick(server, seat) && server.selected === null;

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

// Typed-browser semantic evidence. The tested isolated Chrome exposes no web-content AX,
// so native labels are never readiness or verification evidence. Capture regions prove paint;
// query "select" is not expected to include the canvas image.
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
  if (reply.page.url !== fixtureURL || !complete) return { ...scope, clear: null, status: null };
  const buttons = [];
  const statuses = new Set();
  const seen = new Set();
  for (const [source, refs] of [['refs', reply.refs], ['content_refs', reply.content_refs]]) {
    for (const ref of refs) {
      requireThat(record(ref) && text(ref.ref) && !seen.has(ref.ref), 'DUPLICATE_OR_INVALID_REF');
      seen.add(ref.ref);
      if (ref.role === 'button' && ref.name === CLEAR_NAME) buttons.push(projectRef(ref, snapshot.id, source));
      if (source === 'content_refs' && ['status', 'statictext', 'text'].includes(ref.role)
        && ((typeof ref.name === 'string' && ref.name.startsWith(STATUS_PREFIX))
          || (typeof ref.value === 'string' && ref.value.startsWith(STATUS_PREFIX)))
        && ref.frame === 'main' && ref.visibility === 'in_viewport') {
        const item = projectRef(ref, snapshot.id, source);
        requireThat(item.actions.length === 0, 'INVALID_STATUS_REF');
        for (const itemText of [item.name, item.value]) if (itemText?.startsWith(STATUS_PREFIX)) statuses.add(itemText);
      }
    }
  }
  requireThat(buttons.length <= 1, 'FIXTURE_CONTROL_AMBIGUOUS');
  return { ...scope, clear: buttons[0] ?? null, status: statuses.size === 1 ? [...statuses][0] : null };
}

function actionable(ref, action) {
  return ref !== null && ref.source === 'refs' && ref.frame === 'main'
    && ref.visibility === 'in_viewport' && ref.actions.includes(action)
    && (!Object.hasOwn(ref.states, 'disabled') || ref.states.disabled === false)
    && (!Object.hasOwn(ref.states, 'focusable') || ref.states.focusable === true);
}

const semanticReady = (evidence, server) => evidence.snapshot.complete && evidence.status === NO_SELECTION
  && actionable(evidence.clear, 'click') && untouched(server);

const regionShape = (region, image) => record(region) && natural(region.x) && natural(region.y)
  && positive(region.width) && positive(region.height) && positive(region.area)
  && region.x + region.width <= image.width && region.y + region.height <= image.height
  && record(region.center) && Number.isFinite(region.center.x) && Number.isFinite(region.center.y)
  && record(region.anchor) && natural(region.anchor.x) && natural(region.anchor.y)
  && region.anchor.x >= region.x && region.anchor.x < region.x + region.width
  && region.anchor.y >= region.y && region.anchor.y < region.y + region.height;

// Maps capture-bound colour regions to seats only when they form the fixture's layout at one
// uniform CSS-to-PNG scale: same row, proportional spacing and whole seat-sized discs.
function seatRegions(result, screenshot, layout) {
  requireThat(record(result) && text(result.capture_id) && result.capture_id === screenshot.capture_id
    && positive(result.width) && positive(result.height) && result.width === screenshot.width
    && result.height === screenshot.height && typeof result.truncated === 'boolean'
    && Array.isArray(result.regions), 'SEAT_CAPTURE_MISMATCH');
  requireThat(result.truncated === false && result.regions.length === layout.length
    && result.regions.every(region => regionShape(region, result)), 'SEAT_REGIONS_MISMATCH');
  // findRegions orders by (y, x); seats are mapped strictly left to right.
  const regions = [...result.regions].sort((left, right) => left.center.x - right.center.x);
  const first = regions[0];
  const scale = (regions[regions.length - 1].center.x - first.center.x) / (layout[layout.length - 1].x - layout[0].x);
  const tolerance = Math.max(2, 2 * scale);
  requireThat(Number.isFinite(scale) && scale > 0 && regions.every((region, index) => {
    const seat = layout[index];
    const diameter = 2 * seat.radius * scale;
    return Math.abs(region.center.x - (first.center.x + scale * (seat.x - layout[0].x))) <= tolerance
      && Math.abs(region.center.y - (first.center.y + scale * (seat.y - layout[0].y))) <= tolerance
      && [region.width, region.height].every(size => size >= 0.8 * diameter && size <= diameter + tolerance)
      && region.area >= 0.6 * Math.PI * (seat.radius * scale) ** 2;
  }), 'SEAT_REGIONS_MISMATCH');
  const seats = regions.map((region, index) => ({ seat: layout[index].seat,
    anchor: { x: region.anchor.x, y: region.anchor.y }, center: { x: region.center.x, y: region.center.y },
    bounds: { x: region.x, y: region.y, width: region.width, height: region.height }, area: region.area }));
  return { seats, scale };
}

/**
 * Visual-mode seat candidates for geometry-mapped seats in left-to-right order (seatRegions).
 * IDs are neutral positions (seat_1..seat_n) that never name a seat. Descriptions and state carry
 * only label-shaped OCR text as untrusted evidence; ambiguous or other text reads as unreadable.
 * seatOf maps each ID to its geometry seat, the only seat identity authorization may use.
 */
export function visualSeatCandidates(seats, labels) {
  requireThat(Array.isArray(seats) && Array.isArray(labels) && seats.length === labels.length
    && seats.length <= 24, 'VISUAL_LABELS_MISMATCH');
  const candidates = [];
  const state = [];
  const seatOf = new Map();
  seats.forEach((item, index) => {
    const id = `seat_${index + 1}`;
    const ambiguous = labels[index]?.ambiguous === true;
    const label = ambiguous ? null : ocrLabel(labels[index]?.ocrText);
    const evidence = label !== null ? `whose on-canvas label reads ${JSON.stringify(label)} (OCR text, untrusted)`
      : ambiguous ? 'whose on-canvas label is ambiguous (OCR, untrusted)' : 'with no readable on-canvas label';
    candidates.push({ id,
      description: `Select the available seat ${evidence} once with one foreground click inside its detected canvas region.`,
      action: { tool: 'click', args: { x: item.anchor.x, y: item.anchor.y, delivery_mode: 'foreground' } } });
    state.push({ id, ocrLabel: label, ambiguous });
    seatOf.set(id, item);
  });
  return { candidates, state, seatOf };
}

/**
 * Real isolated canvas seat-map demo. Inject the current eval's judge function;
 * the requested seat (default: leftmost available) and the clear control use
 * deterministic IDs, so the expected judgeCalls is zero. The browser session owns
 * the isolated browser and all semantic readback and the background DOM clear;
 * a second, foreground-enabled native session owns only the capture-bound,
 * geometry-guarded seat click. A fresh isolated Chrome did not expose web-content
 * accessibility on the tested host, so native elements are never used. No
 * permission changes, no mutation retries. Guard refusals report status:"refused".
 * success requires task proof AND both session ends, fixture closure and
 * returned-PID/profile cleanup.
 *
 * visual:true (requires a judge) is a live vision-assisted judge selection
 * on the same fixture: after the colour-region geometry check, read-only
 * parse_visual_regions (optional cua-perception) reads the settled capture's
 * text and labelRegions associates one label below each disc. Candidates are
 * neutral seat_1..seat_n (left to right) with untrusted OCR label evidence; the
 * judge chooses the seat (no deterministicId) and Clear stays deterministic.
 * authorize admits only the candidate whose geometry seat is the requested seat,
 * so a wrong choice is denied without a click. A warm-up parse on a throwaway,
 * never-settled capture precedes the final settle, keeping the worker warm
 * (idle TTL ~30 s) so only one warm parse plus the judge count against the
 * settled capture's 15 s age gate.
 * One extra decision (maxSteps 3) admits a stale or judge-requested
 * reobservation; authorize still admits one seat click and one clear.
 * Judge failures, abstentions and denials report phase "judge_choice".
 * Results add deterministic:false and visual {parse, labels, recall, judge,
 * warmUp, parses}; ocrText keeps only label-shaped text, otherwise null.
 * not_installed reports status:"blocked" PERCEPTION_NOT_INSTALLED before any
 * click; abstained, denied and limit without a click report the loop status.
 */
export async function runCanvasDemo({ judge = unavailableJudge, onProgress, binary = 'cua-driver', seat,
  visual = false } = {}) {
  const startedAt = performance.now();
  let phase = 'configuration';
  let driver = null;
  let nativeTarget = null;
  let fixture = null;
  let layout = null;
  let requestedSeat = null;
  let ownership = null;
  let startAttempted = false;
  let nativeStartAttempted = false;
  let prepareAttempted = false;
  let preparedPID = null;
  let targetID = null;
  let tabID = null;
  let stage = 'ready';
  let lastObservation = null;
  let localTable = null;
  let selectionVerified = false;
  let clearVerified = false;
  let refusal = null;
  let taskFailure = null;
  let loopResult = null;
  let finalServer = null;
  let seatChoice = null;
  const visualReport = visual ? { parse: null, labels: [], recall: null, judge: null, warmUp: null, parses: 0 } : null;
  const evidenceOf = new WeakMap();
  const counts = { select: 0, clear: 0, observations: 0, snapshots: 0 };
  let judgeCalls = 0;
  const native = { daemon: null, start: null, preparation: null, windows: null, window: null, binding: null,
    navigation: null, target: null, actions: [] };
  const cleanup = {
    complete: false,
    nativeEnd: { required: false, confirmed: false, attempts: 0, receipt: null, failures: [] },
    sessionEnd: { required: false, confirmed: false, attempts: 0, receipt: null, failures: [] },
    physical: { before: null, after: null },
    fixture: { required: false, closed: false, failure: null },
  };
  const session = () => driver?.session ?? null;
  const nativeSession = () => nativeTarget?.session ?? null;
  let phaseSession = session;
  async function at(name, operation, unknownOutcome = false, owner = session) {
    phase = name;
    phaseSession = owner;
    try { return await operation(); }
    catch (error) {
      taskFailure ??= sanitizedFailure(error, name, owner(),
        typeof unknownOutcome === 'function' ? unknownOutcome(error) : unknownOutcome);
      throw error;
    }
  }
  async function progress(name) {
    if (onProgress) {
      await at(name, () => onProgress(Object.freeze({ phase: name, session: session(), nativeSession: nativeSession() })));
    }
  }
  function wrap(evidence, server, pixels = null) {
    // Pixel evidence is only as fresh as its settled capture.
    const observedAt = pixels === null ? evidence.observedAt
      : Math.min(evidence.observedAt, pixels.nativeObservation.observedAt);
    const observation = { id: `${targetID}/${tabID}/${evidence.snapshot.id}`, observedAt, state: {
      stage, targetID: evidence.targetID, tabID: evidence.tabID, pageURL: evidence.pageURL,
      snapshot: evidence.snapshot, status: evidence.status, clearControl: actionable(evidence.clear, 'click'), server,
      // Visual mode keeps seat names out of judge-visible state; only neutral IDs and OCR evidence.
      seats: pixels === null ? null : pixels.labels === null
        ? pixels.seats.map(item => ({ seat: item.seat, x: item.anchor.x, y: item.anchor.y }))
        : visualSeatCandidates(pixels.seats, pixels.labels).state,
    } };
    evidenceOf.set(observation, { evidence, captureId: pixels?.captureId ?? null,
      nativeObservation: pixels?.nativeObservation ?? null, seats: pixels?.seats ?? null, labels: pixels?.labels ?? null });
    lastObservation = observation;
    return observation;
  }
  // One scoped typed-browser snapshot plus authoritative server state. Contradictions are never waited out.
  async function readSemantic() {
    const reply = await driver.call('get_browser_state', { target_id: targetID, tab_id: tabID,
      snapshot_format: 'semantic_v2', include_screenshot: false, query: 'select' });
    const observedAt = Date.now();
    counts.snapshots++;
    const evidence = { ...snapshotEvidence(reply, targetID, tabID, fixture.url), observedAt };
    // Only the first readiness poll may still see the blank tab before navigation commits.
    requireThat(evidence.pageURL === fixture.url || (stage === 'ready' && evidence.pageURL === 'about:blank'),
      'FIXTURE_URL_MISMATCH', stage !== 'ready');
    const server = serverState(fixture);
    if (stage === 'ready') requireThat(untouched(server), 'UNEXPECTED_FIXTURE_SELECTION');
    requireThat(server.clicks.length <= 1 && server.clicks.every(click => click.seat === requestedSeat
      && click.trusted === true) && (server.selected === null || server.selected === requestedSeat)
      && (stage !== 'clear' || server.clicks.length === 1), 'UNEXPECTED_SERVER_STATE', stage !== 'ready');
    // Before and after one action, only the prior or expected status can be observed.
    const selected = `${STATUS_PREFIX}${requestedSeat}`;
    const allowed = stage === 'ready' ? [NO_SELECTION] : [NO_SELECTION, selected];
    requireThat(evidence.status === null || allowed.includes(evidence.status), 'UNEXPECTED_SEMANTIC_STATUS',
      stage !== 'ready');
    return { evidence, server };
  }
  // Poll only typed-browser snapshots and server state. No click is retried.
  async function awaitSemantic(expectedStatus, accept, pendingCode) {
    const deadline = performance.now() + READ_WAIT_MS;
    for (;;) {
      const { evidence, server } = await readSemantic();
      if (evidence.pageURL === fixture.url && evidence.snapshot.complete && evidence.status === expectedStatus
        && accept(evidence, server)) {
        return { evidence, server };
      }
      requireThat(performance.now() < deadline, pendingCode, stage !== 'ready');
      await delay(150);
    }
  }
  // Native ready callback: title and server only. Never calls the browser session or reads AX elements.
  function captureReady(observation) {
    const server = serverState(fixture);
    requireThat(untouched(server), 'UNEXPECTED_FIXTURE_SELECTION');
    const title = observation?.state?.window_title;
    return typeof title === 'string' && (title === PAGE_TITLE || title.startsWith(`${PAGE_TITLE} - `));
  }
  // Read-only text parse; it neither consumes the capture nor invalidates the observation.
  async function parseText(observation) {
    const started = performance.now();
    let result;
    try { result = await nativeTarget.visualRegions(observation, { kinds: ['text'] }); }
    catch (error) {
      const refusalCode = error?.code === 'NATIVE_TARGET_ERROR' && typeof error.refusalCode === 'string'
        && REFUSAL_CODE.test(error.refusalCode) ? error.refusalCode : null;
      const failure = new DemoFailure(refusalCode === 'not_installed' ? 'PERCEPTION_NOT_INSTALLED'
        : error?.code === 'NATIVE_TARGET_ERROR' && error.reason === 'visual_regions_unavailable'
          ? 'VISUAL_REGIONS_UNAVAILABLE' : 'VISUAL_REGIONS_INVALID');
      if (refusalCode !== null) failure.refusalCode = refusalCode;
      throw failure;
    }
    visualReport.parses++;
    const space = result?.actionCoordinateSpace?.kind;
    const parser = result?.parser;
    return { result, parse: { durationMs: Number.isFinite(result?.durationMs) ? result.durationMs : null,
      wallMs: Math.round(performance.now() - started),
      regionCount: Array.isArray(result?.regions) ? result.regions.length : null,
      actionCoordinateSpaceKind: space === 'screenshot_pixels' || space === 'affine' ? space : null,
      parser: { extension_version: text(parser?.extension_version) ? parser.extension_version : null,
        model_id: text(parser?.model_id) ? parser.model_id : null } } };
  }
  // Visual mode: one OCR label below each geometry-mapped disc of the settled capture. Each label's centre is
  // painted 16 CSS px below its disc's bottom edge, so one disc radius in capture pixels bounds the gap.
  async function seatLabels(settled, mapped) {
    const screenshot = settled.local.screenshot;
    const { result, parse } = await parseText(settled);
    visualReport.parse = parse;
    requireThat(record(result) && result.capture_id === screenshot.capture_id && result.width === screenshot.width
      && result.height === screenshot.height && Array.isArray(result.regions), 'VISUAL_CAPTURE_MISMATCH');
    const maxGap = Math.min(...layout.map(item => item.radius)) * mapped.seatScale;
    let associated;
    try {
      associated = labelRegions(mapped.seats.map(item => ({ bounds: item.bounds, anchor: item.anchor })), result,
        { direction: 'below', maxGap });
    } catch { throw new DemoFailure('VISUAL_LABELS_INVALID'); }
    requireThat(Array.isArray(associated) && associated.length === mapped.seats.length
      && associated.every((item, index) => record(item) && item.index === index && typeof item.ambiguous === 'boolean'),
    'VISUAL_LABELS_INVALID');
    const labels = associated.map(item => ({ ocrText: ocrLabel(item.text),
      confidence: Number.isFinite(item.confidence) ? item.confidence : null, ambiguous: item.ambiguous }));
    visualReport.labels = labels.map((label, index) => ({ seat: mapped.seats[index].seat, ...label,
      agrees: !label.ambiguous && label.ocrText === mapped.seats[index].seat }));
    visualReport.recall = visualReport.labels.filter(label => label.agrees).length / labels.length;
    return labels;
  }
  // Visual report only. The answer is untrusted: read own data properties, never getters.
  function recordJudge(answer) {
    const field = (value, key) => record(value) ? Object.getOwnPropertyDescriptor(value, key)?.value : undefined;
    const action = field(answer, 'action');
    const choice = field(action, 'choice');
    const confidence = field(action, 'confidence');
    const item = typeof choice === 'string' ? localTable?.seats.get(choice) : undefined;
    visualReport.judge = { choice: typeof choice === 'string' && /^[a-z][a-z0-9_-]{0,47}$/.test(choice) ? choice : null,
      correct: item !== undefined && item.seat === requestedSeat, confidence: Number.isFinite(confidence) ? confidence : null };
  }
  async function observeSeats() {
    await at('observe_fixture', () => awaitSemantic(NO_SELECTION, semanticReady, 'FIXTURE_NOT_READY'));
    const settled = await at('settle_window', async () => {
      const result = await nativeTarget.settle({ ready: captureReady, maxMs: READ_WAIT_MS });
      counts.observations += natural(result?.samples) ? result.samples : 0;
      const title = result?.observation?.state?.window_title;
      native.target.settle = { status: typeof result?.status === 'string' ? result.status : null,
        samples: natural(result?.samples) ? result.samples : null, lastSample: {
          titleMatched: typeof title === 'string' && (title === PAGE_TITLE || title.startsWith(`${PAGE_TITLE} - `)),
        } };
      requireThat(result?.status === 'settled' && record(result.observation), 'WINDOW_NOT_SETTLED');
      return result.observation;
    }, false, nativeSession);
    // A fresh semantic snapshot after settle; the candidate table binds this and the settled capture.
    const current = await at('confirm_fixture', async () => {
      const result = await readSemantic();
      requireThat(result.evidence.pageURL === fixture.url && semanticReady(result.evidence, result.server),
        'FIXTURE_NOT_READY');
      return result;
    });
    const mapped = await at('map_seat_regions', async () => {
      const screenshot = settled.local.screenshot;
      requireThat(record(screenshot) && text(screenshot.capture_id), 'CAPTURE_BINDING_MISSING');
      // A noise floor well below one seat disc at the capture's PNG pixels per window point (the
      // native guard's own mapping); screenshot.scale is not relied on. The layout check decides.
      const bounds = screenshot.window_bounds;
      const scale = record(bounds) && Number.isFinite(bounds.width) && bounds.width > 0 && positive(screenshot.width)
        ? screenshot.width / bounds.width : null;
      requireThat(scale !== null && scale > 0, 'CAPTURE_GEOMETRY_INVALID');
      const minArea = Math.max(16, Math.floor(0.1 * Math.PI * (Math.min(...layout.map(item => item.radius)) * scale) ** 2));
      // Does not invalidate the settled observation; it re-hashes the owned capture file.
      const result = await nativeTarget.regions(settled, { match: seatColour, minArea, maxRegions: 8, connectivity: 4 });
      native.target.regions = { captureId: text(result?.capture_id) ? result.capture_id : null,
        width: positive(result?.width) ? result.width : null, height: positive(result?.height) ? result.height : null,
        truncated: typeof result?.truncated === 'boolean' ? result.truncated : null,
        count: Array.isArray(result?.regions) ? result.regions.length : null, minArea, seats: null };
      const { seats, scale: seatScale } = seatRegions(result, screenshot, layout);
      native.target.regions.seats = seats;
      return { captureId: result.capture_id, seats, seatScale };
    }, false, nativeSession);
    const labels = visual ? await at('visual_regions', () => seatLabels(settled, mapped), false, nativeSession) : null;
    return wrap(current.evidence, current.server, { captureId: mapped.captureId, nativeObservation: settled,
      seats: mapped.seats, labels });
  }
  async function observeOutcome() {
    const selecting = stage === 'select';
    const expectedStatus = selecting ? `${STATUS_PREFIX}${requestedSeat}` : NO_SELECTION;
    return at(selecting ? 'verify_selection' : 'verify_clear', async () => {
      const current = await awaitSemantic(expectedStatus, (evidence, server) => selecting
        ? selectedState(server, requestedSeat) : clearedState(server, requestedSeat),
      selecting ? 'SELECTION_NOT_CONFIRMED' : 'CLEAR_NOT_CONFIRMED');
      return wrap(current.evidence, current.server);
    }, true);
  }
  function observe() {
    return stage === 'ready' ? observeSeats() : observeOutcome();
  }
  function done(observation) {
    const state = observation?.state;
    return record(state) && state.stage === 'clear' && state.pageURL === fixture.url && state.snapshot.complete
      && selectionVerified && clearVerified && counts.select === 1 && counts.clear === 1
      && clearedState(state.server, requestedSeat) && state.status === NO_SELECTION;
  }
  function getCandidates(observation) {
    const entry = evidenceOf.get(observation);
    const state = observation.state;
    const candidates = [];
    let seats = new Map();
    if (entry !== undefined && lastObservation === observation) {
      if (stage === 'ready' && state.stage === 'ready' && counts.select === 0 && counts.clear === 0
        && entry.seats !== null && (!visual || entry.labels !== null) && semanticReady(entry.evidence, state.server)) {
        if (visual) {
          const table = visualSeatCandidates(entry.seats, entry.labels);
          candidates.push(...table.candidates);
          seats = table.seatOf;
        } else {
          for (const item of entry.seats) {
            candidates.push({ id: seatID(item.seat),
              description: `Select available seat ${item.seat} once with one foreground click inside its detected canvas region.`,
              action: { tool: 'click', args: { x: item.anchor.x, y: item.anchor.y, delivery_mode: 'foreground' } } });
            seats.set(seatID(item.seat), item);
          }
        }
      } else if (stage === 'select' && state.stage === 'select' && selectionVerified && counts.select === 1
        && counts.clear === 0 && actionable(entry.evidence.clear, 'click')
        && selectedState(state.server, requestedSeat) && state.status === `${STATUS_PREFIX}${requestedSeat}`) {
        candidates.push({ id: CLEAR_ID,
          description: 'Clear the verified seat selection once with one background DOM click on the unique Clear selection button.',
          action: { tool: 'browser_click', args: { target_id: targetID, tab_id: tabID, ref: entry.evidence.clear.ref,
            input_route: 'dom_event' } } });
      }
    }
    // seats maps each seat candidate ID to its geometry seat: the only seat identity authorize uses.
    localTable = { observation, entries: new Map(candidates.map(candidate => [candidate.id, candidate])), seats };
    return candidates;
  }
  function deterministicId(observation, candidates) {
    if (localTable?.observation !== observation) return null;
    // Visual mode leaves the seat choice to the judge; Clear stays deterministic.
    const id = stage === 'ready' ? (visual ? null : seatID(requestedSeat)) : stage === 'select' ? CLEAR_ID : null;
    const candidate = candidates.find(item => item.id === id);
    return candidate !== undefined && localTable.entries.get(id) === candidate ? id : null;
  }
  function authorize(candidate, observation) {
    const expected = localTable?.entries.get(candidate.id);
    const entry = evidenceOf.get(observation);
    const state = observation.state;
    if (expected !== candidate || localTable.observation !== observation || lastObservation !== observation
      || entry === undefined || state.targetID !== targetID || state.tabID !== tabID
      || state.pageURL !== fixture.url || !state.snapshot.complete
      || !exactObject(candidate.action, { tool: expected.action.tool, args: expected.action.args })) return false;
    // Independent of OCR and the judge: the candidate's geometry seat must be the requested seat.
    const item = localTable.seats.get(candidate.id);
    if (item !== undefined) {
      return item.seat === requestedSeat && entry.seats?.includes(item) === true
        && candidate.action.tool === 'click' && stage === 'ready' && state.stage === 'ready'
        && counts.select === 0 && counts.clear === 0 && text(entry.captureId)
        && entry.nativeObservation?.local?.screenshot?.capture_id === entry.captureId
        && semanticReady(entry.evidence, serverState(fixture))
        && exactObject(candidate.action.args, { x: item.anchor.x, y: item.anchor.y, delivery_mode: 'foreground' });
    }
    if (candidate.id === CLEAR_ID) {
      return candidate.action.tool === 'browser_click' && stage === 'select' && state.stage === 'select'
        && selectionVerified && counts.select === 1 && counts.clear === 0
        && actionable(entry.evidence.clear, 'click') && entry.evidence.status === `${STATUS_PREFIX}${requestedSeat}`
        && selectedState(serverState(fixture), requestedSeat)
        && exactObject(candidate.action.args, { target_id: targetID, tab_id: tabID, ref: entry.evidence.clear.ref,
          input_route: 'dom_event' });
    }
    return false;
  }
  async function execute(candidate, observation) {
    requireThat(authorize(candidate, observation), 'ACTION_NOT_AUTHORIZED');
    const entry = evidenceOf.get(observation);
    const seatClick = candidate.id !== CLEAR_ID;
    if (seatClick) seatChoice = candidate.id;
    stage = seatClick ? 'select' : 'clear';
    counts[stage]++;
    const { tool, args } = candidate.action;
    const action = seatClick
      ? { id: candidate.id, tool, seat: requestedSeat, x: args.x, y: args.y, captureId: entry.captureId,
        deliveryMode: 'foreground', accepted: false, refusal: null, receipt: null, verification: null }
      : { id: candidate.id, tool, targetID, tabID, ref: args.ref, deliveryMode: 'background',
        accepted: false, refusal: null, receipt: null, verification: null };
    native.actions.push(action);
    await at(seatClick ? 'seat_click' : 'clear_click', async () => {
      if (seatClick) {
        let receipt;
        try { receipt = await nativeTarget.execute(candidate, entry.nativeObservation); }
        catch (error) {
          // runBounded reports any admitted execute failure as unknown; keep the guard's no-dispatch reason.
          if (error?.code === 'NATIVE_TARGET_ERROR' && error.unknownOutcome === false && REFUSALS.has(error.reason)) {
            refusal = { reason: error.reason, phase: 'seat_click' };
            action.refusal = error.reason;
          }
          throw error;
        }
        requireThat(record(receipt) && receipt.route === 'global_input' && record(receipt.delivery)
          && receipt.delivery.mode === 'foreground' && (receipt.effect === 'unverifiable' || receipt.effect === 'confirmed'),
        'SEAT_CLICK_DELIVERY_NOT_CONFIRMED', true);
        action.receipt = { route: 'global_input', effect: receipt.effect, deliveryMode: 'foreground' };
      } else {
        // Driver 0.30 adds a free-text root summary; it is native prose, not receipt evidence.
        const { summary, ...receipt } = await driver.call(tool, args);
        requireThat((summary === undefined || typeof summary === 'string') && positiveReply(receipt)
          && exactObject(receipt, { effect: 'unverifiable', route: 'dom', delivery: receipt.delivery,
            escalation: receipt.escalation }) && exactObject(receipt.delivery, { mode: 'background' })
          && exactObject(receipt.escalation, { target: 'page', reason: 'effect_unconfirmed' }),
        'CLEAR_DELIVERY_NOT_CONFIRMED', true);
        action.receipt = { route: 'dom', effect: receipt.effect, deliveryMode: 'background' };
      }
      action.accepted = true;
    }, seatClick ? dispatchUnknown : true, seatClick ? nativeSession : session);
  }
  function verify(candidate, before, after) {
    const state = after.state;
    const fresh = before.id !== after.id && evidenceOf.has(after) && lastObservation === after
      && state.targetID === targetID && state.tabID === tabID && state.pageURL === fixture.url
      && state.snapshot.complete;
    let verified = false;
    if (candidate.id !== CLEAR_ID && candidate.id === seatChoice) {
      selectionVerified = fresh && stage === 'select' && state.stage === 'select' && counts.select === 1
        && counts.clear === 0 && selectedState(state.server, requestedSeat)
        && state.status === `${STATUS_PREFIX}${requestedSeat}`;
      verified = selectionVerified;
    } else if (candidate.id === CLEAR_ID) {
      clearVerified = fresh && selectionVerified && stage === 'clear' && state.stage === 'clear'
        && counts.select === 1 && counts.clear === 1 && clearedState(state.server, requestedSeat)
        && state.status === NO_SELECTION;
      verified = clearVerified;
    }
    native.actions[native.actions.length - 1].verification = {
      verified, observationId: after.id, status: state.status, serverState: state.server,
    };
    return verified;
  }

  try {
    requireThat(typeof judge === 'function' && (onProgress === undefined || typeof onProgress === 'function')
      && (seat === undefined || (typeof seat === 'string' && SEAT_PATTERN.test(seat)))
      && typeof visual === 'boolean', 'INVALID_DEMO_OPTIONS');
    requireThat(!visual || judge !== unavailableJudge, 'JUDGE_REQUIRED');
    driver = createCuaDriver({ binary });
    // The loopback fixture is local; seat scope is settled before any daemon side effect.
    fixture = await at('fixture_start', createCanvasFixture);
    cleanup.fixture.required = true;
    await at('validate_fixture', async () => {
      layout = seatLayout(fixture);
      requestedSeat = seat ?? layout[0].seat;
      requireThat(layout.some(item => item.seat === requestedSeat), 'REQUESTED_SEAT_NOT_AVAILABLE');
      requireThat(untouched(serverState(fixture)), 'UNEXPECTED_FIXTURE_SELECTION');
    });
    await at('daemon_status', async () => {
      const status = await readCLI(binary, ['status']);
      requireThat(/^Cua Driver daemon is running\r?$/m.test(status), 'EXISTING_DAEMON_REQUIRED');
      const mode = status.match(/^\s*permission mode: (standard|bounded|unrestricted)\b/m)?.[1] ?? null;
      native.daemon = { running: true, permissionMode: mode };
    });
    await progress('session_owned');
    startAttempted = true;
    cleanup.sessionEnd.required = true;
    const started = await at('start_session', () => driver.start(), true);
    native.start = { session: started.session, active: started.active };
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
    await at('bind_owned_window', async () => {
      const bound = await driver.call('get_browser_state', {
        ...native.window, snapshot_format: 'semantic_v2', include_screenshot: false,
      });
      requireThat(positiveReply(bound) && bound.status === 'ok' && bound.mode === 'bind' && bound.binding_quality === 'exact'
        && bound.endpoint_access_class === 'driver_owned' && bound.mutation_allowed === true
        && text(bound.target_id) && Array.isArray(bound.tabs) && bound.tabs.length === 1
        && text(bound.tabs[0]?.tab_id), 'EXACT_OWNED_TAB_NOT_CONFIRMED');
      targetID = bound.target_id;
      tabID = bound.tabs[0].tab_id;
      native.binding = { targetID, tabID, bindingQuality: bound.binding_quality,
        endpointAccessClass: bound.endpoint_access_class, mutationAllowed: bound.mutation_allowed, returnedTabs: bound.tabs.length };
    });
    await at('navigate_fixture', async () => {
      const navigated = await driver.call('browser_navigate', { target_id: targetID, tab_id: tabID, url: fixture.url });
      requireThat(positiveReply(navigated) && navigated.status === 'ok'
        && navigated.target_id === targetID && navigated.tab_id === tabID && navigated.url === fixture.url
        && navigated.refs_invalidated === true, 'NAVIGATION_RECEIPT_MISMATCH', true);
      native.navigation = { targetID, tabID, url: fixture.url, refsInvalidated: true };
    }, true);
    await progress('browser_ready');
    // The exact window returned for the owned prepared PID, in a second session with explicit foreground opt-in.
    nativeTarget = await at('native_target', () => createNativeTarget({
      pid: preparedPID, windowId: native.window.window_id, foreground: true, binary,
    }));
    native.target = { session: nativeTarget.session, pid: nativeTarget.pid, windowId: nativeTarget.windowId,
      start: null, focus: null, settle: null, regions: null };
    await progress('native_session_owned');
    nativeStartAttempted = true;
    cleanup.nativeEnd.required = true;
    await at('native_start', async () => {
      const receipt = await nativeTarget.start();
      requireThat(positiveReply(receipt) && receipt.session === nativeTarget.session && receipt.active === true,
        'NATIVE_SESSION_NOT_CONFIRMED', true);
      native.target.start = { session: receipt.session, active: receipt.active };
    }, true, nativeSession);
    // Focus precedes settle; its acceptance is not proof of focus. The click guard checks occlusion.
    await at('focus_window', async () => {
      await nativeTarget.focus();
      native.target.focus = { accepted: true };
    }, true, nativeSession);
    await progress('window_focused');
    if (visual) {
      // Warm the perception worker (cold start up to ~15 s, idle TTL ~30 s) on a throwaway capture before the
      // final settle; settle() supersedes it, so it never authorizes a click and the 15 s age gate of the
      // settled capture covers only one warm parse plus the judge.
      await at('perception_warmup', async () => {
        const observation = await nativeTarget.observe({ screenshot: true });
        counts.observations++;
        visualReport.warmUp = (await parseText(observation)).parse;
      }, false, nativeSession);
    }
    loopResult = await runBounded({
      judge: async (...args) => {
        judgeCalls++;
        if (!visual) return judge(...args);
        return at('judge_choice', async () => {
          const answer = await judge(...args);
          recordJudge(answer);
          return answer;
        });
      },
      goal: `Select only ${visual ? 'the seat labelled' : 'seat'} ${requestedSeat} once on this owned localhost canvas `
        + 'fixture, verify server state and typed-browser semantic status, then clear the selection once and verify it cleared.',
      observe, getCandidates, authorize, execute, verify, isDone: done, deterministicId,
      // One seat click and one clear click at most; an unknown outcome is never retried. Visual mode admits
      // one more decision for a stale or judge-requested reobservation; authorize still counts the clicks.
      maxSteps: visual ? 3 : 2,
      // Leave confidence, probability and observation-age gates unchanged.
    });
    if (loopResult.status !== 'complete' || !done(lastObservation)) {
      // Attribute to the session that owned the last loop phase.
      taskFailure ??= sanitizedFailure(new DemoFailure('BOUNDED_TASK_NOT_COMPLETE'), phase, phaseSession(),
        loopResult.status === 'unknown' || loopResult.status === 'unverified');
    }
  } catch (error) {
    taskFailure ??= sanitizedFailure(error, phase, session());
  } finally {
    // Every owned-resource step is attempted independently; no failure skips a later step.
    if (nativeStartAttempted) {
      for (let attempt = 1; attempt <= 3; attempt++) {
        cleanup.nativeEnd.attempts = attempt;
        try {
          const ended = await nativeTarget.end();
          requireThat(positiveReply(ended) && ended.session === nativeTarget.session && ended.active === false
            && ended.cleanup_complete !== false, 'NATIVE_SESSION_END_NOT_CONFIRMED', true);
          cleanup.nativeEnd.confirmed = true;
          cleanup.nativeEnd.receipt = { session: ended.session, active: ended.active };
          break;
        } catch (error) {
          cleanup.nativeEnd.failures.push(sanitizedFailure(error, 'native_end', nativeSession(), true));
        }
        if (attempt < 3) await delay(250);
      }
    }
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
    if (fixture) {
      // Authoritative server state before closure; a lagging POST cannot outlive the fixture.
      try { finalServer = serverState(fixture); } catch { finalServer = null; }
      try { await fixture.close(); cleanup.fixture.closed = true; }
      catch (error) { cleanup.fixture.failure = sanitizedFailure(error, 'fixture_close', session()); }
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
  }
  cleanup.complete = (!cleanup.nativeEnd.required || cleanup.nativeEnd.confirmed)
    && (!cleanup.sessionEnd.required || cleanup.sessionEnd.confirmed)
    && (!cleanup.fixture.required || cleanup.fixture.closed) && cleanup.physical.after?.complete === true;
  const taskComplete = loopResult?.status === 'complete' && fixture !== null && done(lastObservation)
    && finalServer !== null && clearedState(finalServer, requestedSeat);
  // A refusal is reported only when the guard refused before dispatch and the server saw no click.
  const refused = !taskComplete && refusal !== null && loopResult?.status === 'unknown' && counts.select === 1
    && counts.clear === 0 && finalServer !== null && untouched(finalServer);
  // Visual mode only: a stop before any click (server untouched) reports its own status.
  const clickless = counts.select === 0 && (finalServer === null || untouched(finalServer));
  const blocked = visual && !taskComplete && BLOCKED.has(taskFailure?.code) && clickless;
  const stopped = visual && !taskComplete && !refused && !blocked && clickless && finalServer !== null
    && ['abstained', 'denied', 'limit'].includes(loopResult?.status) ? loopResult.status : null;
  const success = taskComplete && cleanup.complete;
  return {
    success, status: success ? 'complete' : taskComplete ? 'cleanup_incomplete' : refused ? 'refused'
      : blocked ? 'blocked' : stopped ?? 'failed',
    reason: refused ? refusal.reason : blocked ? taskFailure.code : null, session: session(), nativeSession: nativeSession(),
    elapsedMs: Math.round(performance.now() - startedAt), judgeCalls, deterministic: !visual, counts, native,
    task: { complete: taskComplete, status: refused ? 'refused' : blocked ? 'blocked' : loopResult?.status ?? 'failed',
      seat: requestedSeat,
      failure: taskFailure, refusal: refused ? refusal : null,
      unknownOutcome: !refused && (taskFailure?.unknownOutcome === true || loopResult?.status === 'unknown'
        || loopResult?.status === 'unverified'),
      fixture: fixture ? { url: fixture.url, availableSeats: [...fixture.availableSeats] } : null,
      selectionVerified, clearVerified, serverState: finalServer, observation: lastObservation,
      loop: loopResult === null ? null : {
        status: loopResult.status, steps: loopResult.steps, history: loopResult.history.map(entry => ({
          step: entry.step, observationId: entry.observationId, candidateId: entry.candidateId ?? null,
          status: entry.status, startedAt: entry.startedAt, finishedAt: entry.finishedAt,
        })),
      } },
    cleanup,
    ...(visual ? { visual: visualReport } : {}),
  };
}

if (import.meta.main) {
  const result = await runCanvasDemo({ judge: unavailableJudge,
    onProgress: ({ phase, session, nativeSession }) => {
      process.stderr.write(`${JSON.stringify({ phase, session, nativeSession })}\n`);
    },
  });
  console.log(JSON.stringify(result, null, 2));
  process.exitCode = result.success ? 0 : 1;
}
