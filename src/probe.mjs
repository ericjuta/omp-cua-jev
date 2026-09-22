import { chooseAction } from './jev-loop.mjs';

/** A synthetic host-judge request, never a native action or authority check. */
export async function probeJudge(judge) {
  let judgeCalls = 0;
  const decision = await chooseAction({
    judge: async (state, questions) => {
      judgeCalls++;
      return judge(state, questions);
    },
    goal: 'Keep the synthetic sample. Select keep, or abstain if uncertain.',
    observation: { id: 'omp-cua-jev:probe', observedAt: Date.now(), state: { sample: 'Synthetic connectivity probe, no external task.' } },
    candidates: [{ id: 'keep', description: 'Keep the synthetic sample unchanged.', action: { operation: 'keep-synthetic-sample' } }],
  });
  return { decision, judgeCalls, nativeActions: 0,
    note: 'Uses the current OMP judge role, credentials and fallback chain. Scores are not authorization or calibrated certainty. No action was executed.' };
}
