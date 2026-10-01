import assert from 'node:assert/strict';
import test from 'node:test';
import { findText, labelRegions, projectParse } from '../src/visual.mjs';

const SHA = 'ab'.repeat(32);

function envelope() {
  return {
    schema: 'cua.visual_regions_v1',
    capture: {
      capture_id: 'capture-1',
      source: { kind: 'window', pid: 7, window_id: 9 },
      screenshot: { width: 200, height: 100, mime_type: 'image/png', reference: `png-sha256:${SHA}`, sha256: SHA },
      action_coordinate_space: { kind: 'affine', m11: 1.632, m12: 0, m21: 0, m22: 1.63, tx: 0, ty: 0 },
    },
    parser: {
      extension_id: 'cua-perception', extension_version: '0.2.1',
      model_id: 'ppocr', model_version: '5', backend: 'onnxruntime-cpu', runtime: 'worker',
    },
    regions: [
      { id: 'text-1', kind: 'text', text: 'A3', bounds: { x: 124, y: 36, width: 21, height: 20 }, confidence: 0.852, interactive: false },
      { id: 'icon-1', kind: 'icon', label: 'icon-class-0', bounds: { x: 0, y: 0, width: 1, height: 1 }, confidence: 0.4, interactive: false },
    ],
    timing: { duration_ms: 4100, inference_ms: 3900 },
    warnings: [{ code: 'low_contrast', message: 'native detail' }],
    request_id: 'request-1',
  };
}

function edited(edit) {
  const value = envelope();
  edit(value);
  return value;
}

const accepts = edit => assert.doesNotThrow(() => projectParse(edited(edit)));
const rejects = edit => assert.throws(() => projectParse(edited(edit)), Error);

function deepFrozen(value) {
  return value === null || typeof value !== 'object'
    || (Object.isFrozen(value) && Object.values(value).every(deepFrozen));
}

test('projection keeps capture PNG pixels, never applies the affine, and detaches from its input', () => {
  const raw = envelope();
  const visual = projectParse(raw);
  const [text, icon] = visual.regions;
  assert.deepEqual(text.bounds, { x: 124, y: 36, width: 21, height: 20 });
  assert.deepEqual(text.anchor, { x: 134, y: 46 });
  assert.deepEqual(icon.anchor, { x: 0, y: 0 });
  assert.deepEqual(visual.actionCoordinateSpace, raw.capture.action_coordinate_space);
  assert.equal(Object.hasOwn(text, 'interactive'), false);
  assert.deepEqual(visual.warnings, [{ code: 'low_contrast' }]);
  assert.equal(visual.durationMs, 4100);
  assert.ok(deepFrozen(visual));

  raw.regions[0].bounds.x = 0;
  raw.regions[0].text = 'A5';
  raw.capture.source.pid = 8;
  assert.equal(text.bounds.x, 124);
  assert.equal(text.text, 'A3');
  assert.equal(visual.source.pid, 7);
});

test('region bounds are half-open integers fully inside the capture', () => {
  accepts(value => { value.regions[0].bounds = { x: 179, y: 80, width: 21, height: 20 }; });
  accepts(value => { value.regions[0].bounds = { x: 0, y: 0, width: 200, height: 100 }; });
  rejects(value => { value.regions[0].bounds = { x: 180, y: 0, width: 21, height: 20 }; });
  rejects(value => { value.regions[0].bounds = { x: 0, y: 81, width: 10, height: 20 }; });
  rejects(value => { value.regions[0].bounds.x = -1; });
  rejects(value => { value.regions[0].bounds.width = 0; });
  rejects(value => { value.regions[0].bounds.x = 1.5; });
  rejects(value => { delete value.regions[0].bounds.height; });
});

test('region identity, kind, text and confidence fail closed', () => {
  rejects(value => { value.regions[1].id = 'text-1'; });
  rejects(value => { value.regions[0].id = ''; });
  rejects(value => { delete value.regions[0].text; });
  rejects(value => { value.regions[0].text = ''; });
  rejects(value => { value.regions[0].text = null; });
  rejects(value => { value.regions[0].kind = 'button'; });
  rejects(value => { value.regions[0].confidence = 1.0001; });
  rejects(value => { value.regions[0].confidence = -0.0001; });
  rejects(value => { value.regions[1].label = 7; });
  accepts(value => { value.regions[0].confidence = 1; value.regions[1].confidence = 0; });
  const unlabelled = projectParse(edited(value => { value.regions[1].label = null; }));
  assert.equal(Object.hasOwn(unlabelled.regions[1], 'label'), false);
});

test('capture evidence, parser and timing fail closed', () => {
  rejects(value => { value.schema = 'cua.visual_regions_v2'; });
  rejects(value => { delete value.schema; });
  rejects(value => { value.capture.capture_id = ''; });
  rejects(value => { Object.assign(value.capture.action_coordinate_space, { m11: 1, m12: 2, m21: 2, m22: 4 }); });
  rejects(value => { value.capture.action_coordinate_space.m11 = Infinity; });
  rejects(value => { delete value.capture.action_coordinate_space.ty; });
  rejects(value => { value.capture.action_coordinate_space = { kind: 'scaled' }; });
  accepts(value => { value.capture.action_coordinate_space = { kind: 'screenshot_pixels' }; });
  rejects(value => { value.capture.screenshot.sha256 = SHA.toUpperCase(); });
  rejects(value => { value.capture.screenshot.sha256 = SHA.slice(1); });
  rejects(value => { delete value.capture.screenshot.sha256; });
  rejects(value => { value.capture.screenshot.mime_type = 'image/jpeg'; });
  rejects(value => { value.capture.screenshot.width = 0; });
  rejects(value => { value.capture.screenshot.height = 99.5; });
  rejects(value => { value.capture.source.pid = 0; });
  rejects(value => { value.capture.source = { kind: 'display', display_id: 'primary' }; });
  rejects(value => { delete value.parser.model_version; });
  rejects(value => { value.timing.duration_ms = -1; });
  rejects(value => { value.warnings = [{ message: 'no code' }]; });

  const desktop = projectParse(edited(value => {
    value.capture.source = { kind: 'primary_desktop', display_id: 'primary' };
    delete value.timing;
  }));
  assert.deepEqual(desktop.source, { kind: 'primary_desktop', display_id: 'primary' });
  assert.equal(desktop.durationMs, null);
});

function visualOf(regions, width = 300, height = 200) {
  return projectParse(edited(value => {
    value.capture.screenshot.width = width;
    value.capture.screenshot.height = height;
    value.regions = regions.map(([id, text, x, y, w, h, confidence = 0.9]) => ({
      id, kind: 'text', text, bounds: { x, y, width: w, height: h }, confidence, interactive: false,
    }));
  }));
}

const disc = (cx, cy, r = 19) => ({ bounds: { x: cx - r, y: cy - r, width: 2 * r, height: 2 * r }, anchor: { x: cx, y: cy } });
const texts = labels => labels.map(({ text }) => text);

test('a seat row is labelled by the text centred below each disc, not by nearby headings or status', () => {
  const seats = [disc(50, 60), disc(130, 60), disc(210, 60)];
  const visual = visualOf([
    ['heading', 'Seats', 20, 5, 60, 16],
    ['label-2', 'A2', 121, 88, 18, 14],
    ['label-1', 'A1', 41, 88, 18, 14],
    ['label-3', 'A3', 201, 88, 18, 14],
    ['status', 'Selected: none', 20, 150, 120, 18],
  ]);
  const below = labelRegions(seats, visual);
  assert.deepEqual(texts(below), ['A1', 'A2', 'A3']);
  assert.deepEqual(below.map(({ textRegionId }) => textRegionId), ['label-1', 'label-2', 'label-3']);
  assert.ok(below.every(({ ambiguous, distance }) => !ambiguous && distance === 35));

  // A wider gap admits the status line, but each disc's own label stays nearer.
  assert.deepEqual(texts(labelRegions(seats, visual, { maxGap: 100 })), ['A1', 'A2', 'A3']);

  const above = labelRegions(seats, visual, { direction: 'above' });
  assert.deepEqual(texts(above), ['Seats', null, null]);
  assert.deepEqual(above.map(({ ambiguous }) => ambiguous), [false, false, false]);
});

test('text shared by two targets is never guessed and labels at most one target', () => {
  const pair = [
    { bounds: { x: 0, y: 0, width: 40, height: 40 }, anchor: { x: 20, y: 20 } },
    { bounds: { x: 40, y: 0, width: 40, height: 40 }, anchor: { x: 60, y: 20 } },
  ];
  const tied = labelRegions(pair, visualOf([['middle', 'A1', 30, 50, 20, 10]]));
  assert.deepEqual(tied.map(({ text, ambiguous }) => [text, ambiguous]), [[null, true], [null, true]]);

  const conflict = labelRegions(pair, visualOf([['left', 'A1', 10, 45, 32, 10]]));
  assert.deepEqual(conflict.map(({ text, ambiguous }) => [text, ambiguous]), [['A1', false], [null, true]]);
});

test('low-confidence and distant text is ignored; a missing label stays null without ambiguity', () => {
  const seats = [disc(50, 60), disc(130, 60)];
  const visual = visualOf([['faint', 'A1', 41, 88, 18, 14, 0.3], ['far', 'A2', 121, 130, 18, 14]]);
  assert.deepEqual(labelRegions(seats, visual, { minConfidence: 0.5 }).map(({ text, ambiguous }) => [text, ambiguous]),
    [[null, false], [null, false]]);
  const inclusive = labelRegions(seats, visual, { minConfidence: 0.3 });
  assert.equal(inclusive[0].text, 'A1');
  assert.equal(inclusive[0].confidence, 0.3);
  assert.equal(inclusive[1].text, null);
  assert.equal(labelRegions(seats, visual, { maxGap: 51 })[1].text, 'A2');
  assert.throws(() => labelRegions(seats, visual, { direction: 'diagonal' }), Error);
});

test('findText reports exact trimmed matches and uniqueness', () => {
  const visual = visualOf([
    ['submit-a', 'Submit', 10, 10, 50, 20],
    ['submit-b', 'Submit', 100, 10, 50, 20, 0.4],
    ['clear', ' Clear selection ', 10, 50, 120, 20],
    ['clear-word', 'Clear', 10, 90, 40, 20],
  ]);
  const submit = findText(visual, 'Submit');
  assert.equal(submit.unique, false);
  assert.deepEqual(submit.matches.map(({ id }) => id), ['submit-a', 'submit-b']);
  assert.deepEqual(findText(visual, 'Submit', { minConfidence: 0.5 }).matches.map(({ id }) => id), ['submit-a']);
  assert.equal(findText(visual, 'Submit', { minConfidence: 0.5 }).unique, true);
  assert.deepEqual(findText(visual, 'Clear selection').matches.map(({ id }) => id), ['clear']);
  assert.deepEqual(findText(visual, 'Clear').matches.map(({ id }) => id), ['clear-word']);
  assert.equal(findText(visual, 'Selected: none').unique, false);

  const pattern = /^submit$/gi;
  assert.equal(findText(visual, pattern).matches.length, 2);
  assert.equal(findText(visual, pattern).matches.length, 2);
  assert.throws(() => findText(visual, '  '), Error);
});
