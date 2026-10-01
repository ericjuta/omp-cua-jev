import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { doctor } from '../src/doctor.mjs';

const SECRET = 'private-sentinel Bearer token https://private.invalid';
const json = value => `${JSON.stringify(value)}\n`;

const HEALTHY_STATUS = {
  id: 'cua-perception', installed: true, active_version: '0.2.1', healthy: true,
  trust: 'publisher-verified', evidence_class: 'production-publisher-verified',
};
const extension = overrides => ({
  installed: true, healthy: true, activeVersion: '0.2.1',
  trust: 'publisher-verified', evidenceClass: 'production-publisher-verified', ...overrides,
});
// Driver 0.31.0 prints prose, then an `input_schema:` line followed by the JSON schema.
const describe = (name, properties) => `name: ${name}\n\ndescription:\nprose mentions capture_id and element_token\n\ninput_schema:\n${
  JSON.stringify({ type: 'object', properties, required: [] }, null, 2)}\n`;
const TOKEN_CLICK = { capture_id: { type: 'string' }, element_token: { type: 'string' }, x: { type: 'number' } };

const RESPONSES = {
  version: { stdout: 'cua-driver 0.31.0\n' },
  status: { stdout: 'Cua Driver daemon is running\n  permission mode: standard (built_in_default)\n' },
  permissions: {
    stdout: json({ source: { attribution: 'driver-daemon', bundle_id: 'com.trycua.driver' }, accessibility: true, screen_recording: true }),
  },
  describeClick: { stdout: describe('click', TOKEN_CLICK) },
  extensionStatus: { stdout: json(HEALTHY_STATUS) },
  describeParse: { stdout: describe('parse_visual_regions', { capture_id: { type: 'string', minLength: 1 }, options: { type: 'object' } }) },
};

// Fake cua-driver: records each argv (one file per pid, so concurrent probes never interleave) and replays
// a canned response per known read-only command. Any other command is recorded and exits 64.
async function run(t, overrides = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'omp-cua-jev-doctor-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const calls = join(directory, 'calls');
  await mkdir(calls, { mode: 0o700 });
  const binary = join(directory, 'driver.mjs');
  await writeFile(binary, `#!${process.execPath}
import { writeFileSync } from 'node:fs';
const responses = ${JSON.stringify({ ...RESPONSES, ...overrides })};
const keys = {
  '["--version"]': 'version', '["status"]': 'status', '["permissions","status","--json"]': 'permissions',
  '["describe","click"]': 'describeClick', '["extension","status","cua-perception","--json"]': 'extensionStatus',
  '["describe","parse_visual_regions"]': 'describeParse',
};
const argv = process.argv.slice(2);
writeFileSync(${JSON.stringify(calls)} + '/' + process.pid, JSON.stringify(argv));
const response = responses[keys[JSON.stringify(argv)]];
if (!response) process.exit(64);
if (response.stdout) process.stdout.write(response.stdout);
process.stderr.write(${JSON.stringify(SECRET)});
process.exitCode = response.exitCode ?? 0;
`, { mode: 0o700 });
  const report = await doctor({ binary });
  const invocations = await Promise.all((await readdir(calls)).map(async name => JSON.parse(await readFile(join(calls, name), 'utf8'))));
  return { report, invocations };
}

const codes = (list, pattern = /^(PERCEPTION|VISUAL_REGIONS|ELEMENT_TOKENS)_/) =>
  list.map(entry => entry.code).filter(code => pattern.test(code)).sort();

test('a healthy 0.31.0 driver reports token and visual capabilities from read-only probes only', async t => {
  const { report, invocations } = await run(t);
  assert.deepEqual(invocations.map(argv => JSON.stringify(argv)).sort(), [
    ['--version'], ['describe', 'click'], ['describe', 'parse_visual_regions'],
    ['extension', 'status', 'cua-perception', '--json'], ['permissions', 'status', '--json'], ['status'],
  ].map(argv => JSON.stringify(argv)).sort());
  assert.equal(report.ok, true);
  assert.deepEqual(report.warnings, []);
  assert.equal(report.native.testedDriverMatch, true);
  assert.deepEqual(report.capabilities, {
    captureBoundPixels: true,
    elementTokens: true,
    visualRegions: {
      advertised: true,
      extension: extension(),
    },
  });
  assert.deepEqual(report.native.commands.extensionStatus, { state: 'ok', exitCode: 0 });
  assert.deepEqual(report.native.commands.describeParse, { state: 'ok', exitCode: 0 });
  assert.equal(report.evidence.visualRegions, 'not_tested');
  assert.doesNotMatch(JSON.stringify(report), /private-sentinel|Bearer|private\.invalid/);
});

// Perception problems add only their own warnings: blocking and ok stay as in the healthy report.
const OPTIONAL_CASES = [
  {
    name: 'not installed, reported with a nonzero exit',
    overrides: { extensionStatus: { stdout: json({ id: 'cua-perception', installed: false, healthy: false }), exitCode: 1 } },
    extension: { installed: false, healthy: false, activeVersion: null, trust: null, evidenceClass: null },
    warnings: ['PERCEPTION_NOT_INSTALLED'],
  },
  {
    name: 'installed but unhealthy',
    overrides: { extensionStatus: { stdout: json({ ...HEALTHY_STATUS, healthy: false }) } },
    extension: extension({ healthy: false }),
    warnings: ['PERCEPTION_UNHEALTHY'],
  },
  {
    name: 'healthy with unverified trust; free-form values stay private',
    overrides: { extensionStatus: { stdout: json({ ...HEALTHY_STATUS, trust: 'local-unsigned', evidence_class: SECRET, active_version: SECRET }) } },
    extension: extension({ trust: 'local-unsigned', evidenceClass: null, activeVersion: null }),
    warnings: ['PERCEPTION_TRUST_UNVERIFIED'],
  },
  {
    name: 'unhealthy and unverified at once',
    overrides: { extensionStatus: { stdout: json({ ...HEALTHY_STATUS, healthy: 'yes', trust: undefined }) } },
    extension: extension({ healthy: null, trust: null }),
    warnings: ['PERCEPTION_TRUST_UNVERIFIED', 'PERCEPTION_UNHEALTHY'],
  },
  { name: 'malformed status JSON', overrides: { extensionStatus: { stdout: `{"id":"cua-perception",${SECRET}` } }, extension: null, warnings: ['PERCEPTION_STATUS_UNKNOWN'] },
  { name: 'foreign extension id', overrides: { extensionStatus: { stdout: json({ ...HEALTHY_STATUS, id: 'other' }) } }, extension: null, warnings: ['PERCEPTION_STATUS_UNKNOWN'] },
  { name: 'error envelope', overrides: { extensionStatus: { stdout: json({ ...HEALTHY_STATUS, error: SECRET }) } }, extension: null, warnings: ['PERCEPTION_STATUS_UNKNOWN'] },
  {
    name: 'failed command claiming health',
    overrides: { extensionStatus: { stdout: json(HEALTHY_STATUS), exitCode: 1 } },
    extension: null, warnings: ['PERCEPTION_STATUS_UNKNOWN'],
  },
  { name: 'parse tool not described', overrides: { describeParse: { stdout: SECRET, exitCode: 2 } }, advertised: null, warnings: ['VISUAL_REGIONS_UNADVERTISED'] },
  {
    name: 'parse schema without capture_id',
    overrides: { describeParse: { stdout: describe('parse_visual_regions', { options: { type: 'object' } }) } },
    advertised: false, warnings: ['VISUAL_REGIONS_UNADVERTISED'],
  },
  {
    name: 'a different tool described',
    overrides: { describeParse: { stdout: describe('click', TOKEN_CLICK) } },
    advertised: null, warnings: ['VISUAL_REGIONS_UNADVERTISED'],
  },
];

for (const scenario of OPTIONAL_CASES) {
  test(`optional perception finding never blocks: ${scenario.name}`, async t => {
    const { report } = await run(t, scenario.overrides);
    assert.equal(report.ok, true);
    assert.deepEqual(report.blocking, []);
    assert.deepEqual(codes(report.warnings), scenario.warnings);
    const { visualRegions } = report.capabilities;
    if ('extension' in scenario) assert.deepEqual(visualRegions.extension, scenario.extension);
    if ('advertised' in scenario) assert.equal(visualRegions.advertised, scenario.advertised);
    assert.doesNotMatch(JSON.stringify(report), /private-sentinel|Bearer|private\.invalid/);
  });
}

test('element tokens: missing token blocks, legacy fields are not token-only, unknown schemas stay null', async t => {
  const missing = await run(t, { describeClick: { stdout: describe('click', { capture_id: { type: 'string' }, element_index: { type: 'integer' } }) } });
  assert.equal(missing.report.capabilities.elementTokens, false);
  assert.equal(missing.report.ok, false);
  assert.deepEqual(codes(missing.report.blocking), ['ELEMENT_TOKENS_UNSUPPORTED']);

  const legacy = await run(t, { describeClick: { stdout: describe('click', { ...TOKEN_CLICK, element_index: { type: 'integer' }, snapshot_id: true }) } });
  assert.equal(legacy.report.capabilities.elementTokens, false);
  assert.equal(legacy.report.ok, true);

  const forbidden = await run(t, { describeClick: { stdout: describe('click', { ...TOKEN_CLICK, element_index: false, snapshot_id: false }) } });
  assert.equal(forbidden.report.capabilities.elementTokens, true);

  const unknown = await run(t, { describeClick: { stdout: 'element_token is mentioned only in prose\n' } });
  assert.equal(unknown.report.capabilities.elementTokens, null);
  assert.deepEqual(codes(unknown.report.blocking), []);
});
