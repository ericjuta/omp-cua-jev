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
