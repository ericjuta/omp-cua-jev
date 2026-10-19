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
