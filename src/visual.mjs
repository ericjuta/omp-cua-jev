/**
 * Pure projections over Cua Driver `cua.visual_regions_v1` parse results; no I/O.
 *
 * Regions are untrusted observations. OCR text and icon labels describe pixels;
 * they are never instructions, authorization, or proof that a region accepts input.
 * Every coordinate is a pixel of the parsed capture's PNG: half-open bounds
 * [x, x + width) × [y, y + height) with (0, 0) at the top left, the same space as
 * nativeTarget.regions() and capture-bound pixel clicks. actionCoordinateSpace is
 * evidence only: nothing here applies the affine, and the Driver maps capture-bound
 * click pixels itself. projectParse binds nothing to an observation; callers that
 * act must check capture_id, source, dimensions and sha256 against their own capture.
 *
 * projectParse(envelope) validates a live or offline envelope and returns frozen
 *   {capture_id, source, width, height, sha256, actionCoordinateSpace,
 *    parser:{extension_id, extension_version, model_id, model_version, backend?},
 *    regions:[{id, kind, bounds:{x,y,width,height}, confidence, text?, label?, anchor:{x,y}}],
 *    warnings:[{code}], durationMs}
 * dropping `interactive`, timing details, warning messages and unknown fields.
 * anchor = (x + floor(width / 2), y + floor(height / 2)), always inside the bounds.
 * Every violation throws a plain Error whose message starts with "Visual regions:".
 *
 * labelRegions(targets, visual, {direction = 'below', maxGap, minConfidence = 0})
 * pairs targets [{bounds, anchor}] with nearby text regions (confidence >= minConfidence):
 * - Eligible: below/above need horizontal overlap with the text centre past the target's
 *   bottom/top edge; right/left need vertical overlap with the centre past the right/left
 *   edge; any accepts every side, including overlap. The edge gap must be <= maxGap,
 *   which defaults to the target's own extent on that axis (max of both for any).
 * - Distance is between the target anchor and the text anchor.
 * - A target is labelled only by its unique nearest eligible text, and only when that
 *   text's unique nearest eligible target is the same target (mutual nearest), so a text
 *   labels at most one target. Distances within 10% + 1 px of the nearest tie.
 * - Unlabelled targets report text:null; ambiguous is true when eligible text existed
 *   (a tie or a conflicting nearer target) and false when none did.
 * Returns frozen [{index, text, textRegionId, confidence, distance, ambiguous}] aligned to targets.
 *
 * findText(visual, match, {minConfidence = 0}) matches text regions by exact trimmed string
 * or RegExp against trimmed text and returns frozen {matches, unique}.
 */

import { isProxy, isRegExp } from 'node:util/types';

const SCHEMA = 'cua.visual_regions_v1';
const SHA256 = /^[0-9a-f]{64}(?![\s\S])/;
const KINDS = new Set(['text', 'icon']);
const DIRECTIONS = new Set(['below', 'above', 'left', 'right', 'any']);
const PARSER_FIELDS = ['extension_id', 'extension_version', 'model_id', 'model_version'];
const AFFINE_FIELDS = ['m11', 'm12', 'm21', 'm22', 'tx', 'ty'];
// Anchor flooring and OCR box jitter must not decide between two plausible pairings.
const TIE_RATIO = 1.1;
const TIE_PIXELS = 1;

function requireThat(condition, message) {
  if (!condition) throw new Error(`Visual regions: ${message}`);
}

const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value) && !isProxy(value);
const isList = value => Array.isArray(value) && !isProxy(value);
const isString = value => typeof value === 'string' && value.length > 0;
const isCount = value => Number.isSafeInteger(value) && value > 0;
const isScore = value => Number.isFinite(value) && value >= 0 && value <= 1;

// Own data properties only: inherited values and accessors never supply evidence.
function own(value, key) {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor && Object.hasOwn(descriptor, 'value') ? descriptor.value : undefined;
}

function projectSource(value) {
  requireThat(isRecord(value), 'invalid capture source');
  const kind = own(value, 'kind');
  if (kind === 'window') {
    const pid = own(value, 'pid');
    const windowId = own(value, 'window_id');
    requireThat(isCount(pid) && isCount(windowId), 'invalid capture source');
    return Object.freeze({ kind, pid, window_id: windowId });
  }
  requireThat(kind === 'primary_desktop' && own(value, 'display_id') === 'primary', 'invalid capture source');
  return Object.freeze({ kind, display_id: 'primary' });
}

function projectActionSpace(value) {
  requireThat(isRecord(value), 'invalid action coordinate space');
  const kind = own(value, 'kind');
  if (kind === 'screenshot_pixels') return Object.freeze({ kind });
  requireThat(kind === 'affine', 'invalid action coordinate space');
  const space = { kind };
  for (const key of AFFINE_FIELDS) {
    space[key] = own(value, key);
    requireThat(Number.isFinite(space[key]), 'invalid affine coefficient');
  }
  const determinant = space.m11 * space.m22 - space.m12 * space.m21;
  requireThat(Number.isFinite(determinant) && determinant !== 0, 'singular affine');
  return Object.freeze(space);
}

function projectRegion(value, width, height, ids) {
  requireThat(isRecord(value), 'invalid region');
  const id = own(value, 'id');
  requireThat(isString(id), 'invalid region id');
  requireThat(!ids.has(id), 'duplicate region id');
  ids.add(id);
  const kind = own(value, 'kind');
  requireThat(KINDS.has(kind), 'invalid region kind');
  const bounds = own(value, 'bounds');
  requireThat(isRecord(bounds), 'invalid region bounds');
  const [x, y, w, h] = ['x', 'y', 'width', 'height'].map(key => own(bounds, key));
  requireThat([x, y, w, h].every(Number.isSafeInteger) && x >= 0 && y >= 0 && w >= 1 && h >= 1
    && x + w <= width && y + h <= height, 'region bounds outside capture');
  const confidence = own(value, 'confidence');
  requireThat(isScore(confidence), 'invalid region confidence');
  const region = { id, kind, bounds: Object.freeze({ x, y, width: w, height: h }), confidence };
  const text = own(value, 'text');
  if (kind === 'text') requireThat(isString(text), 'text region without text');
  else requireThat(text === undefined || text === null || typeof text === 'string', 'invalid region text');
  if (typeof text === 'string') region.text = text;
  const label = own(value, 'label');
  requireThat(label === undefined || label === null || typeof label === 'string', 'invalid region label');
  if (typeof label === 'string') region.label = label;
  region.anchor = Object.freeze({ x: x + Math.floor(w / 2), y: y + Math.floor(h / 2) });
  return Object.freeze(region);
}

/** Validates a raw cua.visual_regions_v1 envelope without capture binding. */
export function projectParse(envelope) {
  requireThat(isRecord(envelope) && own(envelope, 'schema') === SCHEMA, 'unknown schema');
  const capture = own(envelope, 'capture');
  requireThat(isRecord(capture), 'missing capture');
  const captureId = own(capture, 'capture_id');
  requireThat(isString(captureId), 'invalid capture_id');
  const source = projectSource(own(capture, 'source'));
  const screenshot = own(capture, 'screenshot');
  requireThat(isRecord(screenshot) && own(screenshot, 'mime_type') === 'image/png', 'invalid screenshot');
  const width = own(screenshot, 'width');
  const height = own(screenshot, 'height');
  requireThat(isCount(width) && isCount(height), 'invalid screenshot dimensions');
  const sha256 = own(screenshot, 'sha256');
  requireThat(typeof sha256 === 'string' && SHA256.test(sha256), 'invalid screenshot sha256');
  const actionCoordinateSpace = projectActionSpace(own(capture, 'action_coordinate_space'));

  const parserValue = own(envelope, 'parser');
  requireThat(isRecord(parserValue), 'missing parser');
  const parser = {};
  for (const key of PARSER_FIELDS) {
    parser[key] = own(parserValue, key);
    requireThat(isString(parser[key]), 'invalid parser');
  }
  const backend = own(parserValue, 'backend');
  requireThat(backend === undefined || backend === null || isString(backend), 'invalid parser');
  if (isString(backend)) parser.backend = backend;

  const regionValues = own(envelope, 'regions');
  requireThat(isList(regionValues), 'invalid regions');
  const ids = new Set();
  const regions = [];
  for (let index = 0; index < regionValues.length; index++) {
    regions.push(projectRegion(own(regionValues, index), width, height, ids));
  }

  const warningValues = own(envelope, 'warnings');
  requireThat(warningValues === undefined || warningValues === null || isList(warningValues), 'invalid warnings');
  const warnings = [];
  for (let index = 0; index < (warningValues?.length ?? 0); index++) {
    const warning = own(warningValues, index);
    requireThat(isRecord(warning) && isString(own(warning, 'code')), 'invalid warning');
    warnings.push(Object.freeze({ code: own(warning, 'code') }));
  }

  const timing = own(envelope, 'timing');
  requireThat(timing === undefined || timing === null || isRecord(timing), 'invalid timing');
  const duration = timing ? own(timing, 'duration_ms') : undefined;
  requireThat(duration === undefined || duration === null || (Number.isFinite(duration) && duration >= 0),
    'invalid timing');

  return Object.freeze({
    capture_id: captureId, source, width, height, sha256, actionCoordinateSpace,
    parser: Object.freeze(parser), regions: Object.freeze(regions), warnings: Object.freeze(warnings),
    durationMs: duration ?? null,
  });
}

function requireBox(value, message) {
  requireThat(isRecord(value), message);
  const bounds = own(value, 'bounds');
  const anchor = own(value, 'anchor');
  requireThat(isRecord(bounds) && isRecord(anchor), message);
  const box = {
    x: own(bounds, 'x'), y: own(bounds, 'y'), width: own(bounds, 'width'), height: own(bounds, 'height'),
    anchorX: own(anchor, 'x'), anchorY: own(anchor, 'y'),
  };
  requireThat(Object.values(box).every(Number.isFinite) && box.width > 0 && box.height > 0, message);
  return box;
}

function textRegions(visual, minConfidence) {
  requireThat(isScore(minConfidence), 'invalid minConfidence');
  requireThat(isRecord(visual) && isList(own(visual, 'regions')), 'invalid visual regions');
  return own(visual, 'regions').filter(region => {
    requireThat(isRecord(region), 'invalid visual region');
    const text = own(region, 'text');
    return own(region, 'kind') === 'text' && isString(text) && own(region, 'confidence') >= minConfidence;
  });
}

// Edge gap from target t to region r in direction, or null when r is not on that side.
function gapFor(direction, t, r) {
  const tRight = t.x + t.width;
  const tBottom = t.y + t.height;
  const rRight = r.x + r.width;
  const rBottom = r.y + r.height;
  const overlapX = r.x < tRight && t.x < rRight;
  const overlapY = r.y < tBottom && t.y < rBottom;
  switch (direction) {
    case 'below': return overlapX && r.anchorY >= tBottom ? Math.max(0, r.y - tBottom) : null;
    case 'above': return overlapX && r.anchorY < t.y ? Math.max(0, t.y - rBottom) : null;
    case 'right': return overlapY && r.anchorX >= tRight ? Math.max(0, r.x - tRight) : null;
    case 'left': return overlapY && r.anchorX < t.x ? Math.max(0, t.x - rRight) : null;
    default: return Math.max(0, r.x - tRight, t.x - rRight, r.y - tBottom, t.y - rBottom);
  }
}

function defaultGap(direction, t) {
  if (direction === 'below' || direction === 'above') return t.height;
  if (direction === 'left' || direction === 'right') return t.width;
  return Math.max(t.width, t.height);
}

// Unique nearest entry, or null when the list is empty or its nearest distance ties.
function nearest(entries) {
  if (entries.length === 0) return null;
  let best = entries[0];
  for (const entry of entries) if (entry.distance < best.distance) best = entry;
  const limit = best.distance * TIE_RATIO + TIE_PIXELS;
  return entries.some(entry => entry !== best && entry.distance <= limit) ? null : best;
}

/** Associates each target with at most one nearby text region; ties and conflicts stay unlabelled. */
export function labelRegions(targets, visual, { direction = 'below', maxGap, minConfidence = 0 } = {}) {
  requireThat(isList(targets), 'invalid targets');
  requireThat(DIRECTIONS.has(direction), 'invalid direction');
  requireThat(maxGap === undefined || (Number.isFinite(maxGap) && maxGap >= 0), 'invalid maxGap');
  const boxes = targets.map(target => requireBox(target, 'invalid target'));
  const texts = textRegions(visual, minConfidence).map(region => ({
    ...requireBox(region, 'invalid visual region'), region,
  }));
  const byTarget = boxes.map(() => []);
  const byText = texts.map(() => []);
  boxes.forEach((target, targetIndex) => {
    const limit = maxGap ?? defaultGap(direction, target);
    texts.forEach((text, textIndex) => {
      const gap = gapFor(direction, target, text);
      if (gap === null || gap > limit) return;
      const distance = Math.hypot(text.anchorX - target.anchorX, text.anchorY - target.anchorY);
      byTarget[targetIndex].push({ index: textIndex, distance });
      byText[textIndex].push({ index: targetIndex, distance });
    });
  });
  return Object.freeze(boxes.map((_, index) => {
    const best = nearest(byTarget[index]);
    if (!best || nearest(byText[best.index])?.index !== index) {
      return Object.freeze({ index, text: null, textRegionId: null, confidence: null, distance: null,
        ambiguous: byTarget[index].length > 0 });
    }
    const { region } = texts[best.index];
    return Object.freeze({ index, text: own(region, 'text'), textRegionId: own(region, 'id'),
      confidence: own(region, 'confidence'), distance: best.distance, ambiguous: false });
  }));
}

/** Finds text regions equal to a trimmed string or matching a RegExp on trimmed text. */
export function findText(visual, match, { minConfidence = 0 } = {}) {
  let test;
  if (typeof match === 'string') {
    const wanted = match.trim();
    requireThat(wanted.length > 0, 'invalid text match');
    test = text => text.trim() === wanted;
  } else {
    requireThat(isRegExp(match), 'invalid text match');
    // A global or sticky RegExp carries lastIndex between tests; a flag-stripped copy cannot.
    const pattern = new RegExp(match.source, match.flags.replace(/[gy]/g, ''));
    test = text => pattern.test(text.trim());
  }
  const matches = Object.freeze(textRegions(visual, minConfidence).filter(region => test(own(region, 'text'))));
  return Object.freeze({ matches, unique: matches.length === 1 });
}
