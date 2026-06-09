import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  mergePlan,
  firstUnfinished,
  markDone,
  allStepsDone,
  markActive,
} from './agent-planning.js';

describe('agent-planning', () => {
  describe('mergePlan', () => {
    it('array of strings -> ids s1,s2,...', () => {
      const raw = ['First', 'Second'];
      const result = mergePlan(raw, null);
      assert.deepEqual(result, {
        steps: [
          { id: 's1', title: 'First', status: 'pending' },
          { id: 's2', title: 'Second', status: 'pending' },
        ],
      });
    });

    it('array of objects with explicit ids/status', () => {
      const raw = [{ id: 'custom-1', title: 'First', status: 'active' }, { title: 'Second' }];
      const result = mergePlan(raw, null);
      assert.deepEqual(result, {
        steps: [
          { id: 'custom-1', title: 'First', status: 'active' },
          { id: 's2', title: 'Second', status: 'pending' },
        ],
      });
    });

    it('status preservation from prev by title', () => {
      const prev = {
        steps: [
          { id: 's1', title: 'Old First', status: 'done' as const },
          { id: 's2', title: 'Second', status: 'active' as const },
        ],
      };
      const raw = ['New First', 'Second'];
      const result = mergePlan(raw, prev);
      assert.deepEqual(result, {
        steps: [
          { id: 's3', title: 'New First', status: 'pending' },
          { id: 's2', title: 'Second', status: 'active' },
        ],
      });
    });

    it('explicit status overrides prev', () => {
      const prev = {
        steps: [{ id: 's1', title: 'Old', status: 'done' as const }],
      };
      const raw = [{ id: 's1', title: 'New', status: 'pending' }];
      const result = mergePlan(raw, prev);
      assert.deepEqual(result, {
        steps: [{ id: 's1', title: 'New', status: 'pending' }],
      });
    });

    it('whitespace-only titles dropped BUT the id counter still advances', () => {
      const raw = ['  ', 'Second', '\t'];
      const result = mergePlan(raw, null);
      assert.deepEqual(result, {
        steps: [{ id: 's2', title: 'Second', status: 'pending' }],
      });
    });

    it('non-array raw -> empty', () => {
      assert.deepEqual(mergePlan('invalid', null), { steps: [] });
      assert.deepEqual(mergePlan({}, null), { steps: [] });
      assert.deepEqual(mergePlan(null, null), { steps: [] });
    });

    it('prev=null', () => {
      const result = mergePlan(['Step'], null);
      assert.deepEqual(result, {
        steps: [{ id: 's1', title: 'Step', status: 'pending' }],
      });
    });
  });

  describe('firstUnfinished', () => {
    it("prefers 'active' over earlier 'pending'", () => {
      const plan = {
        steps: [
          { id: 's1', title: 'A', status: 'pending' as const },
          { id: 's2', title: 'B', status: 'active' as const },
          { id: 's3', title: 'C', status: 'pending' as const },
        ],
      };
      assert.equal(firstUnfinished(plan)?.id, 's2');
    });

    it('returns first pending if no active', () => {
      const plan = {
        steps: [
          { id: 's1', title: 'A', status: 'done' as const },
          { id: 's2', title: 'B', status: 'pending' as const },
        ],
      };
      assert.equal(firstUnfinished(plan)?.id, 's2');
    });

    it('returns undefined when all done or empty/null', () => {
      const allDone = {
        steps: [{ id: 's1', title: 'A', status: 'done' as const }],
      };
      assert.equal(firstUnfinished(allDone), undefined);
      assert.equal(firstUnfinished({ steps: [] }), undefined);
      assert.equal(firstUnfinished(null), undefined);
    });
  });

  describe('markDone', () => {
    it('by id; returns the completed step; does NOT mutate the input plan', () => {
      const plan = {
        steps: [
          { id: 's1', title: 'A', status: 'pending' as const },
          { id: 's2', title: 'B', status: 'pending' as const },
        ],
      };
      const { plan: newPlan, step } = markDone(plan, 's2');

      assert.equal(step?.id, 's2');
      assert.equal(newPlan.steps[1]!.status, 'done');
      assert.equal(newPlan.steps[0]!.status, 'pending');

      // assert the original object is unchanged
      assert.equal(plan.steps[1]!.status, 'pending');
      assert.notEqual(plan, newPlan);
      assert.notEqual(plan.steps, newPlan.steps);
    });

    it('by current step when id omitted', () => {
      const plan = {
        steps: [
          { id: 's1', title: 'A', status: 'done' as const },
          { id: 's2', title: 'B', status: 'active' as const },
          { id: 's3', title: 'C', status: 'pending' as const },
        ],
      };
      const { plan: newPlan, step } = markDone(plan);

      assert.equal(step?.id, 's2');
      assert.equal(newPlan.steps[1]!.status, 'done');
    });

    it('no-match id -> step undefined', () => {
      const plan = {
        steps: [{ id: 's1', title: 'A', status: 'pending' as const }],
      };
      const { step } = markDone(plan, 'nonexistent');

      assert.equal(step, undefined);
    });
  });

  describe('allStepsDone', () => {
    it('empty plan false', () => {
      assert.equal(allStepsDone({ steps: [] }), false);
    });

    it('null false', () => {
      assert.equal(allStepsDone(null), false);
    });

    it('mixed false', () => {
      const plan = {
        steps: [
          { id: 's1', title: 'A', status: 'done' as const },
          { id: 's2', title: 'B', status: 'pending' as const },
        ],
      };
      assert.equal(allStepsDone(plan), false);
    });

    it('all-done true', () => {
      const plan = {
        steps: [
          { id: 's1', title: 'A', status: 'done' as const },
          { id: 's2', title: 'B', status: 'done' as const },
        ],
      };
      assert.equal(allStepsDone(plan), true);
    });
  });

  describe('markActive', () => {
    it('activates the first not-done step so the run view shows a live cursor', () => {
      const plan = {
        steps: [
          { id: 's1', title: 'A', status: 'done' as const },
          { id: 's2', title: 'B', status: 'pending' as const },
          { id: 's3', title: 'C', status: 'pending' as const },
        ],
      };
      const result = markActive(plan)!;
      assert.equal(result.steps[0]!.status, 'done'); // done step untouched
      assert.equal(result.steps[1]!.status, 'active');
      assert.equal(result.steps[2]!.status, 'pending');
    });

    it('keeps at most one step active (a stale active is reset to pending)', () => {
      // Two active steps must never coexist — the cursor would be ambiguous.
      const plan = {
        steps: [
          { id: 's1', title: 'A', status: 'active' as const },
          { id: 's2', title: 'B', status: 'active' as const },
        ],
      };
      const result = markActive(plan)!;
      assert.equal(result.steps[0]!.status, 'active');
      assert.equal(result.steps[1]!.status, 'pending');
    });

    it('returns the SAME reference when nothing changes, so the loop skips a redundant write', () => {
      const plan = {
        steps: [
          { id: 's1', title: 'A', status: 'done' as const },
          { id: 's2', title: 'B', status: 'active' as const },
          { id: 's3', title: 'C', status: 'pending' as const },
        ],
      };
      assert.equal(markActive(plan), plan); // identity, not just deep-equal
    });

    it('empty/null plan passes through unchanged', () => {
      const empty = { steps: [] };
      assert.equal(markActive(empty), empty);
      assert.equal(markActive(null), null);
    });

    it('does not resurrect a finished plan (all steps done stays done)', () => {
      const plan = {
        steps: [
          { id: 's1', title: 'A', status: 'done' as const },
          { id: 's2', title: 'B', status: 'done' as const },
        ],
      };
      assert.equal(markActive(plan), plan);
    });
  });
});
