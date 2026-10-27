import assert from 'node:assert/strict';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import { chooseAction, runBounded } from '../src/jev-loop.mjs';

const answer = () => ({
  action: {
    type: 'choice', choice: 'enter', confidence: 0.99,
    probabilities: { enter: 0.99, abstain: 0.01, reobserve: 0 },
  },
});

function clock(t) {
  let wall = 1000;
  let monotonic = 0;
  t.mock.method(Date, 'now', () => wall);
  t.mock.method(globalThis.performance, 'now', () => monotonic);
  return {
    advance(ms) {
      wall += ms;
      monotonic += ms;
    },
  };
}

function deferred() {
  let resolve;
  const promise = new Promise(fulfill => { resolve = fulfill; });
  return { promise, resolve };
}

function readinessWithQueuedMutation(readiness, replacement) {
  return {
    then(resolve) {
      resolve(readiness);
      // Run after readinessOf validates the result, but before its caller resumes.
      queueMicrotask(() => queueMicrotask(() => Object.assign(readiness, replacement)));
    },
  };
}

function fixture() {
  return {
    app: { owned: '', other: '', writes: 0, closed: false },
    candidates: [{
      id: 'enter',
      description: 'Enter the receipt in the owned field',
      action: {
        tool: 'set_value',
        args: { target: 'owned', payload: { text: 'original receipt' } },
      },
    }],
  };
}

function observation(app, id = 'owned:1') {
  return { id, observedAt: Date.now(), state: { ...app } };
}

test('plain JSON from another OMP realm is usable without accepting class instances', async t => {
  clock(t);
  const data = runInNewContext(`({
    observation: { id: 'owned:1', observedAt: 1000, state: { fields: ['Receipt'] } },
    candidates: [{
      id: 'enter', description: 'Enter the receipt',
      action: { tool: 'type', args: { text: 'local value' } }
    }],
    answer: {
      action: {
        type: 'choice', choice: 'enter', confidence: 0.99,
        probabilities: { enter: 0.99, abstain: 0.01, reobserve: 0 }
      }
    }
  })`);
  const choice = await chooseAction({
    judge: async () => data.answer,
    goal: 'Enter the receipt',
    observation: data.observation,
    candidates: data.candidates,
    maxAgeMs: 50,
  });
  assert.equal(choice.kind, 'action');
  assert.equal(choice.candidate.id, 'enter');
  assert.equal(choice.candidate.action.args.text, 'local value');

  class MutableAction { tool = 'type'; }
  await assert.rejects(chooseAction({
    judge: async () => answer(),
    goal: 'Enter the receipt',
    observation: observation({ field: 'Receipt' }),
    candidates: [{ id: 'enter', description: 'Enter the receipt', action: new MutableAction() }],
  }), TypeError);
});

test('a proxy cannot synthesize unfrozen executable arguments', async t => {
  clock(t);
  const candidate = new Proxy({ id: 'enter', description: 'Enter the receipt' }, {
    get(target, key) {
      return key === 'action'
        ? { tool: 'type', args: { text: 'mutable' } }
        : Reflect.get(target, key);
    },
  });
  await assert.rejects(chooseAction({
    judge: async () => answer(),
    goal: 'Enter the receipt',
    observation: observation({ field: 'Receipt' }),
    candidates: [candidate],
  }), TypeError);
});

test('stale evidence at judge completion requests reobservation before authorization', async t => {
  const time = clock(t);
  const { app, candidates } = fixture();
  const judging = deferred();
  const decision = deferred();
  let authorizations = 0;
  let actions = 0;
  const pending = runBounded({
    goal: 'Enter the owned receipt', maxSteps: 1, maxMs: 1000, maxAgeMs: 50,
    observe: () => observation(app),
    getCandidates: () => candidates,
    isDone: current => current.state.closed,
    judge: () => { judging.resolve(); return decision.promise; },
    authorize: () => { authorizations++; return true; },
    execute: candidate => {
      actions++;
      const { target, payload } = candidate.action.args;
      app[target] = payload.text;
      app.writes++;
      app.closed = true;
    },
    verify: (_candidate, _before, after) => after.state.owned === 'original receipt' && after.state.other === '',
  });
  await judging.promise;
  time.advance(51);
  decision.resolve(answer());
  const result = await pending;

  assert.equal(result.status, 'limit');
  assert.equal(authorizations, 0);
  assert.equal(actions, 0);
  assert.deepEqual(app, { owned: '', other: '', writes: 0, closed: false });
});

test('evidence becoming stale during asynchronous authorization is not executed', async t => {
  const time = clock(t);
  const { app, candidates } = fixture();
  const authorizing = deferred();
  const authorization = deferred();
  let authorizations = 0;
  let actions = 0;
  const pending = runBounded({
    goal: 'Enter the owned receipt', maxSteps: 1, maxMs: 1000, maxAgeMs: 50,
    observe: () => observation(app),
    getCandidates: () => candidates,
    isDone: current => current.state.closed,
    judge: async () => answer(),
    authorize: () => {
      authorizations++;
      authorizing.resolve();
      return authorization.promise;
    },
    execute: candidate => {
      actions++;
      const { target, payload } = candidate.action.args;
      app[target] = payload.text;
      app.writes++;
      app.closed = true;
    },
    verify: (_candidate, _before, after) => after.state.owned === 'original receipt' && after.state.other === '',
  });
  await authorizing.promise;
  time.advance(51);
  authorization.resolve(true);
  const result = await pending;

  assert.equal(result.status, 'limit');
  assert.equal(authorizations, 1);
  assert.equal(actions, 0);
  assert.deepEqual(app, { owned: '', other: '', writes: 0, closed: false });
});

test('denied authorization stops without changing application state', async t => {
  clock(t);
  const { app, candidates } = fixture();
  let actions = 0;
  const result = await runBounded({
    goal: 'Enter the owned receipt', maxSteps: 3, maxMs: 1000, maxAgeMs: 50,
    observe: () => observation(app),
    getCandidates: () => candidates,
    isDone: current => current.state.closed,
    judge: async () => answer(),
    authorize: () => false,
    execute: candidate => {
      actions++;
      const { target, payload } = candidate.action.args;
      app[target] = payload.text;
      app.writes++;
      app.closed = true;
    },
    verify: (_candidate, _before, after) => after.state.owned === 'original receipt' && after.state.other === '',
  });

  assert.equal(result.status, 'denied');
  assert.equal(actions, 0);
  assert.deepEqual(app, { owned: '', other: '', writes: 0, closed: false });
});

test('a side effect followed by a delivery error stops unknown without replay', async t => {
  clock(t);
  const { app, candidates } = fixture();
  let actions = 0;
  let observations = 0;
  let verifications = 0;
  const result = await runBounded({
    goal: 'Enter the owned receipt', maxSteps: 3, maxMs: 1000, maxAgeMs: 50,
    observe: () => observation(app, `owned:${++observations}`),
    getCandidates: () => candidates,
    isDone: current => current.state.closed,
    judge: async () => answer(),
    authorize: () => true,
    execute: candidate => {
      actions++;
      const { target, payload } = candidate.action.args;
      app[target] = payload.text;
      app.writes++;
      app.closed = true;
      throw new Error('Acknowledgement lost after applying the action');
    },
    verify: (_candidate, _before, after) => {
      verifications++;
      return after.state.owned === 'original receipt' && after.state.other === '';
    },
  });

  assert.equal(result.status, 'unknown');
  assert.equal(actions, 1);
  assert.equal(observations, 1);
  assert.equal(verifications, 0);
  assert.deepEqual(app, { owned: 'original receipt', other: '', writes: 1, closed: true });
});

test('failed independent verification overrides accepted delivery and broader completion', async t => {
  clock(t);
  const { app, candidates } = fixture();
  let actions = 0;
  let observations = 0;
  let verifications = 0;
  let completionChecks = 0;
  const result = await runBounded({
    goal: 'Enter the owned receipt', maxSteps: 3, maxMs: 1000, maxAgeMs: 50,
    observe: () => observation(app, `owned:${++observations}`),
    getCandidates: () => candidates,
    isDone: current => { completionChecks++; return current.state.closed; },
    judge: async () => answer(),
    authorize: () => true,
    execute: candidate => {
      actions++;
      const { target, payload } = candidate.action.args;
      app[target] = payload.text.slice(0, 8);
      app.writes++;
      app.closed = true;
      return { accepted: true };
    },
    verify: (_candidate, _before, after) => {
      verifications++;
      return after.state.owned === 'original receipt' && after.state.other === '';
    },
  });

  assert.equal(result.status, 'unverified');
  assert.equal(actions, 1);
  assert.equal(observations, 2);
  assert.equal(verifications, 1);
  assert.equal(completionChecks, 1);
  assert.deepEqual(app, { owned: 'original', other: '', writes: 1, closed: true });
});

test('pending-judge mutation attempts execute only the original target and payload', async t => {
  clock(t);
  const { app, candidates } = fixture();
  const judging = deferred();
  const decision = deferred();
  let actions = 0;
  let observations = 0;
  const pending = runBounded({
    goal: 'Enter the owned receipt', maxSteps: 3, maxMs: 1000, maxAgeMs: 50,
    observe: () => observation(app, `owned:${++observations}`),
    getCandidates: () => candidates,
    isDone: current => current.state.closed,
    judge: () => { judging.resolve(); return decision.promise; },
    authorize: () => true,
    execute: candidate => {
      actions++;
      const { target, payload } = candidate.action.args;
      app[target] = payload.text;
      app.writes++;
      app.closed = true;
      return { accepted: true };
    },
    verify: (_candidate, _before, after) => after.state.owned === 'original receipt' && after.state.other === '',
  });
  await judging.promise;
  Reflect.set(candidates[0].action.args, 'target', 'other');
  Reflect.set(candidates[0].action.args.payload, 'text', 'altered receipt');
  Reflect.set(candidates, 0, {
    id: 'enter', description: 'Replace the entry while the judge waits',
    action: { tool: 'set_value', args: { target: 'other', payload: { text: 'replacement receipt' } } },
  });
  decision.resolve(answer());
  const result = await pending;

  assert.deepEqual(app, { owned: 'original receipt', other: '', writes: 1, closed: true });
  assert.equal(actions, 1);
  assert.equal(observations, 2);
  assert.equal(result.status, 'complete');
});

test('verified progress at the exact age threshold does not imply task completion', async t => {
  const time = clock(t);
  const { app, candidates } = fixture();
  const authorizing = deferred();
  const authorization = deferred();
  let actions = 0;
  let observations = 0;
  let verifications = 0;
  let completionChecks = 0;
  const pending = runBounded({
    goal: 'Enter the receipt and close the task', maxSteps: 1, maxMs: 1000, maxAgeMs: 50,
    observe: () => observation(app, `owned:${++observations}`),
    getCandidates: () => candidates,
    isDone: current => { completionChecks++; return current.state.closed; },
    judge: async () => answer(),
    authorize: () => { authorizing.resolve(); return authorization.promise; },
    execute: candidate => {
      actions++;
      const { target, payload } = candidate.action.args;
      app[target] = payload.text;
      app.writes++;
      return { accepted: true };
    },
    verify: (_candidate, _before, after) => {
      verifications++;
      return after.state.owned === 'original receipt' && after.state.other === '';
    },
  });
  await authorizing.promise;
  time.advance(50);
  authorization.resolve(true);
  const result = await pending;

  assert.equal(result.status, 'limit');
  assert.equal(actions, 1);
  assert.equal(observations, 2);
  assert.equal(verifications, 1);
  assert.equal(completionChecks, 2);
  assert.deepEqual(app, { owned: 'original receipt', other: '', writes: 1, closed: false });
});

const reobserveAnswer = () => ({
  action: {
    type: 'choice', choice: 'reobserve', confidence: 0.99,
    probabilities: { enter: 0, abstain: 0, reobserve: 1 },
  },
});

function writeOwned(app, candidate) {
  const { target, payload } = candidate.action.args;
  app[target] = payload.text;
  app.writes++;
  return { accepted: true };
}

const verifyOwned = (_candidate, _before, after) => after.state.owned === 'original receipt' && after.state.other === '';

test('deterministic choices report null scores and deterministic provenance', async t => {
  clock(t);
  const { app, candidates } = fixture();
  let judgeCalls = 0;
  const choice = await chooseAction({
    judge: async () => { judgeCalls++; return answer(); },
    goal: 'Enter the receipt',
    observation: observation(app),
    candidates,
    deterministicId: 'enter',
  });
  assert.equal(choice.kind, 'action');
  assert.equal(choice.candidate.id, 'enter');
  assert.equal(choice.confidence, null);
  assert.equal(choice.probability, null);
  assert.equal(choice.source, 'deterministic');
  assert.equal(judgeCalls, 0);

  const judged = await chooseAction({
    judge: async () => answer(),
    goal: 'Enter the receipt',
    observation: observation(app),
    candidates,
  });
  assert.equal(judged.confidence, 0.99);
  assert.equal(judged.probability, 0.99);
  assert.equal(judged.source, 'judge');

  // chooseAction keeps the string|null contract; only runBounded's callback may decline.
  await assert.rejects(chooseAction({
    judge: async () => answer(),
    goal: 'Enter the receipt',
    observation: observation(app),
    candidates,
    deterministicId: { id: null, reason: 'No rule matched' },
  }), TypeError);

  let observations = 0;
  const result = await runBounded({
    goal: 'Enter the owned receipt', maxSteps: 3, maxMs: 1000, maxAgeMs: 50,
    observe: () => observation(app, `owned:${++observations}`),
    getCandidates: () => candidates,
    isDone: current => current.state.writes === 1,
    deterministicId: () => 'enter',
    judge: async () => { judgeCalls++; return answer(); },
    authorize: () => true,
    execute: candidate => writeOwned(app, candidate),
    verify: verifyOwned,
  });
  assert.equal(result.status, 'complete');
  assert.equal(judgeCalls, 0);
  assert.equal(result.history.length, 1);
  const [entry] = result.history;
  assert.equal(entry.status, 'verified');
  assert.equal(entry.candidateId, 'enter');
  assert.equal(entry.source, 'deterministic');
  assert.equal(entry.confidence, null);
  assert.equal(entry.probability, null);
});

test('a declined deterministic rule records its reason and consults the judge with unchanged history', async t => {
  clock(t);
  const { app, candidates } = fixture();
  const reason = 'Visual canvas has no rule-selectable seat';
  const judgedHistories = [];
  const ruleArgs = [];
  let observations = 0;
  const result = await runBounded({
    goal: 'Enter the owned receipt twice', maxSteps: 3, maxMs: 1000, maxAgeMs: 50,
    observe: () => observation(app, `owned:${++observations}`),
    getCandidates: () => candidates,
    isDone: current => current.state.writes === 2,
    deterministicId: (current, offered) => {
      ruleArgs.push([current.id, offered]);
      return { id: null, reason };
    },
    judge: async state => { judgedHistories.push(state.history); return answer(); },
    authorize: () => true,
    execute: candidate => writeOwned(app, candidate),
    verify: verifyOwned,
  });

  assert.equal(result.status, 'complete');
  assert.deepEqual(ruleArgs, [['owned:1', candidates], ['owned:2', candidates]]);
  assert.equal(judgedHistories.length, 2);
  assert.deepEqual(judgedHistories[0], []);
  // The judge sees only the projected fields, never provenance, scores or decline reasons.
  assert.deepEqual(judgedHistories[1], [{ observationId: 'owned:1', candidateId: 'enter', status: 'verified' }]);
  assert.equal(result.history.length, 2);
  for (const entry of result.history) {
    assert.equal(entry.deterministicDeclined, reason);
    assert.equal(entry.source, 'judge');
    assert.equal(entry.confidence, 0.99);
    assert.equal(entry.probability, 0.99);
    assert.equal(entry.status, 'verified');
  }
});

test('invalid deterministic callback results throw before judging or acting', async t => {
  clock(t);
  class Declined { id = null; reason = 'No rule matched'; }
  const invalid = [
    undefined,
    0,
    '',
    'missing',
    { id: 'enter' },
    { id: 'enter', reason: 'Rule matched' },
    { id: null },
    { id: null, reason: '' },
    { id: null, reason: 7 },
    { id: null, reason: 'x'.repeat(201) },
    { id: null, reason: 'No rule matched', extra: true },
    { reason: 'No rule matched' },
    new Declined(),
    new Proxy({ id: null, reason: 'No rule matched' }, {}),
  ];
  for (const value of invalid) {
    const { app, candidates } = fixture();
    let judgeCalls = 0;
    let actions = 0;
    await assert.rejects(runBounded({
      goal: 'Enter the owned receipt', maxSteps: 3, maxMs: 1000, maxAgeMs: 50,
      observe: () => observation(app),
      getCandidates: () => candidates,
      isDone: current => current.state.closed,
      deterministicId: () => value,
      judge: async () => { judgeCalls++; return answer(); },
      authorize: () => true,
      execute: candidate => { actions++; return writeOwned(app, candidate); },
      verify: verifyOwned,
    }), TypeError, `deterministicId result ${String(value?.reason ?? value)}`);
    assert.equal(judgeCalls, 0);
    assert.equal(actions, 0);
  }

  // A 200-character reason is the inclusive bound.
  const { app, candidates } = fixture();
  const reason = 'x'.repeat(200);
  const result = await runBounded({
    goal: 'Enter the owned receipt', maxSteps: 1, maxMs: 1000, maxAgeMs: 50,
    observe: () => observation(app),
    getCandidates: () => candidates,
    isDone: current => current.state.writes === 1,
    deterministicId: () => ({ id: null, reason }),
    judge: async () => answer(),
    authorize: () => true,
    execute: candidate => writeOwned(app, candidate),
    verify: verifyOwned,
  });
  assert.equal(result.status, 'complete');
  assert.equal(result.history[0].deterministicDeclined, reason);
});

test('consecutive judge reobservations stop at maxReobserves before observing again', async t => {
  clock(t);
  for (const [maxReobserves, expected] of [[undefined, 3], [1, 1], [3, 3], [5, 5]]) {
    const { app, candidates } = fixture();
    let observations = 0;
    let judgeCalls = 0;
    const result = await runBounded({
      goal: 'Enter the owned receipt', maxSteps: 10, maxMs: 1000, maxAgeMs: 50,
      ...(maxReobserves === undefined ? {} : { maxReobserves }),
      observe: () => observation(app, `owned:${++observations}`),
      getCandidates: () => candidates,
      isDone: current => current.state.closed,
      judge: async () => { judgeCalls++; return reobserveAnswer(); },
      authorize: () => true,
      execute: candidate => writeOwned(app, candidate),
      verify: verifyOwned,
    });
    // Initial observe plus one after each of the first cap-1 reobservations;
    // the cap-th reobservation finishes no_progress without observing again.
    assert.equal(result.status, 'no_progress', `maxReobserves ${maxReobserves}`);
    assert.equal(observations, expected, `maxReobserves ${maxReobserves}`);
    assert.equal(judgeCalls, expected);
    assert.equal(result.steps, expected);
    const tail = result.history.slice(-Math.min(expected, 4));
    assert.equal(tail.length, Math.min(expected, 4));
    for (const entry of tail) {
      assert.equal(entry.status, 'reobserve');
      assert.equal(entry.source, 'judge');
    }
    assert.deepEqual(app, { owned: '', other: '', writes: 0, closed: false });
  }
});

test('no_progress wins over the step limit on the same iteration', async t => {
  clock(t);
  const { app, candidates } = fixture();
  let observations = 0;
  const result = await runBounded({
    goal: 'Enter the owned receipt', maxSteps: 2, maxReobserves: 2, maxMs: 1000, maxAgeMs: 50,
    observe: () => observation(app, `owned:${++observations}`),
    getCandidates: () => candidates,
    isDone: current => current.state.closed,
    judge: async () => reobserveAnswer(),
    authorize: () => true,
    execute: candidate => writeOwned(app, candidate),
    verify: verifyOwned,
  });
  assert.equal(result.status, 'no_progress');
  assert.equal(result.steps, 2);
  assert.equal(observations, 2);
});

test('a verified action resets the reobservation streak', async t => {
  clock(t);
  const { app, candidates } = fixture();
  const script = ['reobserve', 'reobserve', 'enter', 'reobserve', 'reobserve', 'reobserve', 'reobserve'];
  let observations = 0;
  let judgeCalls = 0;
  let actions = 0;
  const result = await runBounded({
    goal: 'Enter the owned receipt', maxSteps: 10, maxReobserves: 3, maxMs: 1000, maxAgeMs: 50,
    observe: () => observation(app, `owned:${++observations}`),
    getCandidates: () => candidates,
    isDone: current => current.state.closed,
    judge: async () => (script[judgeCalls++] === 'enter' ? answer() : reobserveAnswer()),
    authorize: () => true,
    execute: candidate => { actions++; return writeOwned(app, candidate); },
    verify: verifyOwned,
  });
  // Without a reset the streak would reach 3 at step 4. With it: steps 4-6 reobserve, then cap.
  // Observes: initial, two reobservations, the verified after-snapshot, then two more reobservations.
  assert.equal(result.status, 'no_progress');
  assert.equal(result.steps, 6);
  assert.equal(judgeCalls, 6);
  assert.equal(actions, 1);
  assert.equal(observations, 6);
  assert.deepEqual(result.history.map(entry => [entry.step, entry.status, entry.source]), [
    [3, 'verified', 'judge'],
    [4, 'reobserve', 'judge'],
    [5, 'reobserve', 'judge'],
    [6, 'reobserve', 'judge'],
  ]);
  assert.deepEqual(app, { owned: 'original receipt', other: '', writes: 1, closed: false });
});

test('stale evidence after authorization is recorded as a guard reobservation', async t => {
  const time = clock(t);
  const { app, candidates } = fixture();
  let observations = 0;
  let actions = 0;
  const result = await runBounded({
    goal: 'Enter the owned receipt', maxSteps: 1, maxMs: 1000, maxAgeMs: 50,
    observe: () => observation(app, `owned:${++observations}`),
    getCandidates: () => candidates,
    isDone: current => current.state.closed,
    judge: async () => answer(),
    authorize: () => { time.advance(51); return true; },
    execute: candidate => { actions++; return writeOwned(app, candidate); },
    verify: verifyOwned,
  });
  assert.equal(result.status, 'limit');
  assert.equal(actions, 0);
  assert.equal(result.history.length, 1);
  assert.equal(result.history[0].status, 'reobserve');
  assert.equal(result.history[0].source, 'guard');
});

test('readiness gates selection and post-action verification', async t => {
  clock(t);
  const { app, candidates } = fixture();
  let observations = 0;
  const seen = [];
  const result = await runBounded({
    goal: 'Enter the owned receipt', maxSteps: 5, maxReobserves: 3, maxMs: 1000, maxAgeMs: 50,
    observe: () => ({ ...observation(app, `owned:${++observations}`), state: {
      ...app, ready: observations === 2 || observations === 4,
    } }),
    ready: current => { seen.push(`ready:${current.id}`); return { status: current.state.ready ? 'ready' : 'wait_for_content' }; },
    isDone: current => { seen.push(`done:${current.id}`); return current.state.writes === 1; },
    getCandidates: current => { seen.push(`candidates:${current.id}`); return candidates; },
    deterministicId: () => 'enter', judge: async () => { throw new Error('unexpected judge'); },
    authorize: () => true, execute: candidate => writeOwned(app, candidate), verify: verifyOwned,
  });
  assert.equal(result.status, 'unverified');
  assert.deepEqual(result.readiness, { status: 'wait_for_content' });
  assert.deepEqual(seen, [
    'ready:owned:1', 'ready:owned:2', 'done:owned:2', 'candidates:owned:2', 'ready:owned:3',
  ]);
  assert.deepEqual(result.history.map(entry => [entry.status, entry.source]), [
    ['reobserve', 'guard'], ['unverified', 'deterministic'],
  ]);
  assert.equal(result.history[1].delivery, 'accepted');
  assert.equal(result.history[1].verification, undefined);
  assert.equal(app.writes, 1);
});

test('unready observations stop at the reobservation cap without checking completion or acting', async t => {
  clock(t);
  const { app } = fixture();
  let observations = 0;
  const forbidden = () => { throw new Error('unready evidence used'); };
  const result = await runBounded({
    goal: 'Enter the owned receipt', maxSteps: 2, maxReobserves: 2, maxMs: 1000,
    observe: () => observation(app, `owned:${++observations}`),
    ready: () => ({ status: 'wait_for_content', reason: 'loading' }), isDone: forbidden, getCandidates: forbidden,
    judge: forbidden, authorize: forbidden, execute: forbidden, verify: forbidden,
  });
  assert.equal(result.status, 'no_progress');
  assert.equal(observations, 2);
  assert.deepEqual(result.history.map(entry => [entry.status, entry.source]), [
    ['reobserve', 'guard'], ['reobserve', 'guard'],
  ]);
  assert.equal(app.writes, 0);
  assert.deepEqual(result.readiness, { status: 'wait_for_content', reason: 'loading' });
  assert.equal(result.history[0].readinessReason, 'loading');
});

test('terminal readiness outcomes stop before completion, selection, and execution', async t => {
  clock(t);
  for (const status of ['foreground_required', 'stop']) {
    const { app } = fixture();
    const forbidden = () => { throw new Error('unready evidence used'); };
    const result = await runBounded({
      goal: 'Enter the owned receipt', observe: () => observation(app),
      ready: () => ({ status, reason: 'needs operator' }),
      isDone: forbidden, getCandidates: forbidden, judge: forbidden,
      authorize: forbidden, execute: forbidden, verify: forbidden,
    });
    assert.equal(result.status, status);
    assert.deepEqual(result.readiness, { status, reason: 'needs operator' });
    assert.equal(result.steps, 0);
    assert.deepEqual(result.history, []);
    assert.equal(app.writes, 0);
  }
});

test('readiness rejects malformed evidence without treating it as ready', async t => {
  clock(t);
  const { app } = fixture();
  for (const value of [undefined, null, true, 1, 'ready', {}, { status: 'unknown' }, { status: 'ready', reason: '' }]) {
    let done = false;
    await assert.rejects(runBounded({
      goal: 'Enter the owned receipt', observe: () => observation(app), ready: () => value,
      isDone: () => { done = true; return true; }, getCandidates: () => [],
      judge: async () => answer(), authorize: () => true, execute: () => {}, verify: () => true,
    }), TypeError);
    assert.equal(done, false);
  }
});

test('readiness snapshots validated fields before a queued mutation can affect the gate', async t => {
  clock(t);
  for (const [status, replacement, expected] of [
    ['wait_for_content', 'ready', 'no_progress'],
    ['foreground_required', 'ready', 'foreground_required'],
    ['stop', 'unexpected', 'stop'],
    ['ready', 'stop', 'complete'],
  ]) {
    const { app } = fixture();
    const readiness = { status, reason: 'original reason' };
    let completionChecks = 0;
    const forbidden = () => { throw new Error('unexpected action'); };
    const result = await runBounded({
      goal: 'Enter the owned receipt', maxSteps: 3, maxReobserves: 1, maxMs: 1000,
      observe: () => observation(app),
      ready: () => readinessWithQueuedMutation(readiness, { status: replacement, reason: 'changed reason' }),
      isDone: () => { completionChecks++; return true; }, getCandidates: forbidden,
      judge: forbidden, authorize: forbidden, execute: forbidden, verify: forbidden,
    });
    assert.deepEqual(readiness, { status: replacement, reason: 'changed reason' });
    assert.equal(result.status, expected, status);
    assert.equal(completionChecks, status === 'ready' ? 1 : 0, status);
    if (status === 'ready') {
      assert.equal(Object.hasOwn(result, 'readiness'), false);
    } else {
      assert.deepEqual(result.readiness, { status, reason: 'original reason' });
      assert.notStrictEqual(result.readiness, readiness);
    }
    if (status === 'wait_for_content') {
      assert.equal(result.history[0].readinessReason, 'original reason');
      assert.equal(result.history[0].source, 'guard');
    }
  }
});

test('post-action readiness uses its validated snapshot even when the callback mutates it', async t => {
  clock(t);
  const { app, candidates } = fixture();
  const readiness = { status: 'wait_for_content', reason: 'loading result' };
  let observations = 0;
  let completionChecks = 0;
  let verifications = 0;
  const result = await runBounded({
    goal: 'Enter the owned receipt', maxSteps: 3, maxMs: 1000, maxAgeMs: 50,
    observe: () => observation(app, `owned:${++observations}`),
    ready: current => current.id === 'owned:1' ? { status: 'ready' }
      : readinessWithQueuedMutation(readiness, { status: 'ready', reason: 'changed reason' }),
    isDone: current => { completionChecks++; return current.state.writes === 1; },
    getCandidates: () => candidates, deterministicId: () => 'enter', judge: async () => answer(),
    authorize: () => true, execute: candidate => writeOwned(app, candidate),
    verify: () => { verifications++; return true; },
  });
  assert.deepEqual(readiness, { status: 'ready', reason: 'changed reason' });
  assert.equal(result.status, 'unverified');
  assert.deepEqual(result.readiness, { status: 'wait_for_content', reason: 'loading result' });
  assert.equal(completionChecks, 1);
  assert.equal(verifications, 0);
  assert.equal(observations, 2);
  assert.equal(app.writes, 1);
  assert.equal(result.history[0].status, 'unverified');
  assert.equal(result.history[0].delivery, 'accepted');
  assert.equal(Object.hasOwn(result.history[0], 'verification'), false);
});

test('readiness rejects accessors and non-own or extra fields without invoking getters', async t => {
  clock(t);
  const { app } = fixture();
  let getterCalls = 0;
  const statusAccessor = { get status() { getterCalls++; return 'ready'; } };
  const reasonAccessor = { status: 'ready', get reason() { getterCalls++; return 'valid'; } };
  const inherited = Object.create({ status: 'ready' });
  const hidden = Object.defineProperty({ status: 'ready' }, 'extra', { value: true });
  const symbol = { status: 'ready', [Symbol('extra')]: true };
  for (const value of [statusAccessor, reasonAccessor, inherited, hidden, symbol, new Proxy({ status: 'ready' }, {})]) {
    let completionChecks = 0;
    await assert.rejects(runBounded({
      goal: 'Enter the owned receipt', observe: () => observation(app), ready: () => value,
      isDone: () => { completionChecks++; return true; }, getCandidates: () => [],
      judge: async () => answer(), authorize: () => true, execute: () => {}, verify: () => true,
    }), TypeError);
    assert.equal(completionChecks, 0);
  }
  assert.equal(getterCalls, 0);
});

test('wait_for_content yields to the event loop before reobserving', async t => {
  clock(t);
  let loaded = false;
  let scheduled = false;
  let observations = 0;
  const forbidden = () => { throw new Error('unexpected action'); };
  const result = await runBounded({
    goal: 'Wait for the content', maxSteps: 4, maxReobserves: 3, maxMs: 1000,
    observe: () => observation({ loaded }, `owned:${++observations}`),
    ready: current => {
      if (current.state.loaded) return { status: 'ready' };
      if (!scheduled) {
        scheduled = true;
        setTimeout(() => { loaded = true; }, 0);
      }
      return { status: 'wait_for_content', reason: 'loading' };
    },
    isDone: current => current.state.loaded, getCandidates: forbidden,
    judge: forbidden, authorize: forbidden, execute: forbidden, verify: forbidden,
  });
  assert.equal(result.status, 'complete');
  assert.equal(observations, 2);
  assert.equal(result.steps, 1);
  assert.deepEqual(result.history.map(entry => [entry.status, entry.source, entry.readinessReason]), [
    ['reobserve', 'guard', 'loading'],
  ]);
});

test('a deadline reached during the readiness yield retains the last wait', async t => {
  const time = clock(t);
  const { app } = fixture();
  let observations = 0;
  const forbidden = () => { throw new Error('unready evidence used'); };
  const result = await runBounded({
    goal: 'Wait for the content', maxSteps: 4, maxReobserves: 3, maxMs: 1000,
    observe: () => observation(app, `owned:${++observations}`),
    ready: () => {
      setTimeout(() => time.advance(1000), 0);
      return { status: 'wait_for_content', reason: 'loading' };
    },
    isDone: forbidden, getCandidates: forbidden, judge: forbidden,
    authorize: forbidden, execute: forbidden, verify: forbidden,
  });
  assert.equal(result.status, 'limit');
  assert.deepEqual(result.readiness, { status: 'wait_for_content', reason: 'loading' });
  assert.equal(observations, 1);
  assert.equal(result.steps, 1);
  assert.deepEqual(result.history.map(entry => [entry.status, entry.source, entry.readinessReason]), [
    ['reobserve', 'guard', 'loading'],
  ]);
});

test('deadline and cancellation during reobservation retain the last validated wait', async t => {
  const time = clock(t);
  for (const interruption of ['deadline', 'cancellation']) {
    const { app } = fixture();
    const controller = new AbortController();
    const observing = deferred();
    const observed = deferred();
    const readiness = { status: 'wait_for_content', reason: 'loading' };
    let observations = 0;
    const forbidden = () => { throw new Error('unready evidence used'); };
    const pending = runBounded({
      goal: 'Wait for the content', maxSteps: 4, maxReobserves: 3, maxMs: 1000, signal: controller.signal,
      observe: () => {
        if (++observations === 2) { observing.resolve(); return observed.promise; }
        return observation(app, `owned:${observations}`);
      },
      ready: () => readiness, isDone: forbidden, getCandidates: forbidden, judge: forbidden,
      authorize: forbidden, execute: forbidden, verify: forbidden,
    });
    await observing.promise;
    readiness.reason = 'changed after validation';
    if (interruption === 'deadline') time.advance(1000);
    else controller.abort();
    observed.resolve(observation(app, 'owned:2'));
    const result = await pending;
    assert.equal(result.status, interruption === 'deadline' ? 'limit' : 'abstained');
    assert.deepEqual(result.readiness, { status: 'wait_for_content', reason: 'loading' });
    assert.equal(observations, 2);
    assert.equal(result.steps, 1);
    assert.deepEqual(result.history.map(entry => [entry.status, entry.source, entry.readinessReason]), [
      ['reobserve', 'guard', 'loading'],
    ]);
  }
});

test('a later validated ready result clears the previous wait at a boundary', async t => {
  const time = clock(t);
  const { app } = fixture();
  let observations = 0;
  const forbidden = () => { throw new Error('unexpected action'); };
  const result = await runBounded({
    goal: 'Wait for the content', maxSteps: 4, maxReobserves: 3, maxMs: 1000,
    observe: () => observation(app, `owned:${++observations}`),
    ready: current => current.id === 'owned:1'
      ? { status: 'wait_for_content', reason: 'loading' } : { status: 'ready' },
    isDone: () => { time.advance(1000); return true; }, getCandidates: forbidden,
    judge: forbidden, authorize: forbidden, execute: forbidden, verify: forbidden,
  });
  assert.equal(result.status, 'limit');
  assert.equal(Object.hasOwn(result, 'readiness'), false);
  assert.equal(observations, 2);
  assert.equal(result.history[0].readinessReason, 'loading');
});

test('post-action readiness cannot admit an after-snapshot that became stale while awaiting it', async t => {
  const time = clock(t);
  for (const elapsed of [50, 51]) {
    const { app, candidates } = fixture();
    const checking = deferred();
    const decision = deferred();
    let observations = 0;
    let afterReadinessCalls = 0;
    let completionChecks = 0;
    let verifications = 0;
    const pending = runBounded({
      goal: 'Enter the owned receipt', maxSteps: 3, maxMs: 1000, maxAgeMs: 50,
      observe: () => observation(app, `owned:${++observations}`),
      ready: current => {
        if (current.id === 'owned:2' && ++afterReadinessCalls === 1) {
          checking.resolve();
          return decision.promise;
        }
        return { status: 'ready' };
      },
      isDone: current => { completionChecks++; return current.state.writes === 1; },
      getCandidates: () => candidates, deterministicId: () => 'enter', judge: async () => answer(),
      authorize: () => true, execute: candidate => writeOwned(app, candidate),
      verify: (...args) => { verifications++; return verifyOwned(...args); },
    });
    await checking.promise;
    time.advance(elapsed);
    decision.resolve({ status: 'ready' });
    const result = await pending;
    assert.equal(result.status, elapsed === 50 ? 'complete' : 'unverified');
    assert.equal(completionChecks, elapsed === 50 ? 2 : 1);
    assert.equal(verifications, elapsed === 50 ? 1 : 0);
    assert.equal(observations, 2);
    assert.equal(app.writes, 1);
    assert.equal(result.history[0].delivery, 'accepted');
    assert.equal(result.history[0].status, elapsed === 50 ? 'verified' : 'unverified');
    if (elapsed === 51) assert.equal(Object.hasOwn(result.history[0], 'verification'), false);
  }
});

test('stale or future-dated post-action observations cannot be verified without a readiness callback', async t => {
  clock(t);
  for (const offset of [-51, 1]) {
    const { app, candidates } = fixture();
    let observations = 0;
    let verifications = 0;
    const result = await runBounded({
      goal: 'Enter the owned receipt', maxSteps: 3, maxMs: 1000, maxAgeMs: 50,
      observe: () => {
        const current = observation(app, `owned:${++observations}`);
        if (observations === 2) current.observedAt += offset;
        return current;
      },
      isDone: current => current.state.writes === 1, getCandidates: () => candidates,
      deterministicId: () => 'enter', judge: async () => answer(), authorize: () => true,
      execute: candidate => writeOwned(app, candidate), verify: () => { verifications++; return true; },
    });
    assert.equal(result.status, 'unverified');
    assert.equal(verifications, 0);
    assert.equal(observations, 2);
    assert.equal(app.writes, 1);
    assert.equal(result.history[0].delivery, 'accepted');
    assert.equal(Object.hasOwn(result.history[0], 'verification'), false);
  }
});

test('a verified after-snapshot that ages during the next readiness check is not used for completion', async t => {
  const time = clock(t);
  for (const maxSteps of [1, 3]) {
    const { app, candidates } = fixture();
    const checking = deferred();
    const decision = deferred();
    const completionIds = [];
    let observations = 0;
    let afterReadinessCalls = 0;
    let verifications = 0;
    const pending = runBounded({
      goal: 'Enter the owned receipt', maxSteps, maxMs: 1000, maxAgeMs: 50,
      observe: () => observation(app, `owned:${++observations}`),
      ready: current => {
        if (current.id === 'owned:2' && ++afterReadinessCalls === 2) {
          checking.resolve();
          return decision.promise;
        }
        return { status: 'ready' };
      },
      isDone: current => { completionIds.push(current.id); return current.state.writes === 1; },
      getCandidates: () => candidates, deterministicId: () => 'enter', judge: async () => answer(),
      authorize: () => true, execute: candidate => writeOwned(app, candidate),
      verify: (...args) => { verifications++; return verifyOwned(...args); },
    });
    await checking.promise;
    time.advance(51);
    decision.resolve({ status: 'ready' });
    const result = await pending;
    assert.equal(result.status, maxSteps === 1 ? 'limit' : 'complete');
    assert.deepEqual(completionIds, maxSteps === 1 ? ['owned:1'] : ['owned:1', 'owned:3']);
    assert.equal(observations, maxSteps === 1 ? 2 : 3);
    assert.equal(verifications, 1);
    assert.equal(app.writes, 1);
    assert.deepEqual(result.history.map(entry => [entry.status, entry.source]), maxSteps === 1
      ? [['verified', 'deterministic']] : [['verified', 'deterministic'], ['reobserve', 'guard']]);
    assert.equal(result.history[0].verification, 'passed');
  }
});

test('delivery and verification history records only evidence established inside the loop', async t => {
  clock(t);
  for (const outcome of ['failed', 'executeThrows', 'observeThrows', 'verifyThrows']) {
    const { app, candidates } = fixture();
    let observations = 0;
    const result = await runBounded({
      goal: 'Enter the owned receipt', maxSteps: 1, maxMs: 1000,
      observe: () => {
        if (++observations === 2 && outcome === 'observeThrows') throw new Error('observation unavailable');
        return observation(app, `owned:${observations}`);
      },
      isDone: () => false, getCandidates: () => candidates, deterministicId: () => 'enter',
      judge: async () => answer(), authorize: () => true,
      execute: candidate => {
        if (outcome === 'executeThrows') throw new Error('uncertain delivery');
        return writeOwned(app, candidate);
      },
      verify: () => {
        if (outcome === 'verifyThrows') throw new Error('verification unavailable');
        return false;
      },
    });
    assert.equal(result.status, outcome === 'failed' ? 'unverified' : 'unknown');
    const entry = result.history[0];
    assert.equal(entry.delivery, outcome === 'executeThrows' ? undefined : 'accepted');
    assert.equal(entry.verification, outcome === 'failed' ? 'failed' : undefined);
    assert.equal(entry.verificationObservationId, outcome === 'failed' ? 'owned:2' : undefined);
    assert.equal(Object.hasOwn(entry, 'cleanup'), false);
  }
});

test('maxReobserves must be a safe integer of at least one', async t => {
  clock(t);
  for (const maxReobserves of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 53, '3', null, true]) {
    const { app, candidates } = fixture();
    let observations = 0;
    await assert.rejects(runBounded({
      goal: 'Enter the owned receipt', maxSteps: 3, maxReobserves, maxMs: 1000, maxAgeMs: 50,
      observe: () => { observations++; return observation(app); },
      getCandidates: () => candidates,
      isDone: current => current.state.closed,
      judge: async () => answer(),
      authorize: () => true,
      execute: candidate => writeOwned(app, candidate),
      verify: verifyOwned,
    }), TypeError, `maxReobserves ${String(maxReobserves)}`);
    assert.equal(observations, 0);
  }
});
