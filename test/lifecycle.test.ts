import { describe, expect, it } from 'vitest';
import { checkTransition, PUBLIC_STATUSES, TRANSITIONS, type Status } from '../src/modules/campaigns/lifecycle';

const base = { ownerId: 'owner', raisedAmountCents: 10_000, adSetupConfirmed: true };
const admin = { id: 'admin', role: 'admin' as const };
const owner = { id: 'owner', role: 'user' as const };
const system = { id: null, role: 'system' as const };
const statuses = Object.keys(TRANSITIONS) as Status[];

describe('lifecycle table', () => {
  it('has a way forward and a way out of every non-terminal state', () => {
    const terminal: Status[] = ['completed', 'rejected', 'cancelled'];
    for (const s of statuses) {
      if (terminal.includes(s)) expect(TRANSITIONS[s]).toEqual([]);
      else expect(TRANSITIONS[s].length).toBeGreaterThan(0);
    }
  });

  it('never lets funding completion jump straight to promoting', () => {
    expect(TRANSITIONS.goal_reached).not.toContain('promoting');
    expect(TRANSITIONS.funding).not.toContain('promoting');
    expect(TRANSITIONS.distribution_prep).toContain('promoting');
  });

  it('only exposes campaigns that were approved and opened', () => {
    expect(PUBLIC_STATUSES).not.toContain('draft');
    expect(PUBLIC_STATUSES).not.toContain('under_review');
    expect(PUBLIC_STATUSES).not.toContain('rejected');
  });

  it('rejects every move that is not in the table', () => {
    for (const from of statuses) {
      for (const to of statuses) {
        if (TRANSITIONS[from].includes(to)) continue;
        expect(() => checkTransition({ ...base, status: from }, to, admin)).toThrowError(/cannot move/);
      }
    }
  });
});

describe('who may change status', () => {
  it('lets an owner submit and cancel, but not approve', () => {
    expect(() => checkTransition({ ...base, status: 'draft' }, 'under_review', owner)).not.toThrow();
    expect(() => checkTransition({ ...base, status: 'draft' }, 'cancelled', owner)).not.toThrow();
    expect(() => checkTransition({ ...base, status: 'under_review' }, 'approved', owner)).toThrowError(/not allowed/);
  });

  it('stops a different user acting on someone else’s campaign', () => {
    expect(() => checkTransition({ ...base, status: 'draft' }, 'under_review', { id: 'other', role: 'user' })).toThrowError(/not allowed/);
  });

  it('keeps goal_reached for the payment system', () => {
    expect(() => checkTransition({ ...base, status: 'funding' }, 'goal_reached', admin)).toThrowError(/automatically/);
    expect(() => checkTransition({ ...base, status: 'funding' }, 'goal_reached', system)).not.toThrow();
  });

  it('needs confirmed payments and ad setup before ads run', () => {
    expect(() => checkTransition({ ...base, status: 'goal_reached', raisedAmountCents: 0 }, 'distribution_prep', admin)).toThrowError(/no confirmed payments/);
    expect(() => checkTransition({ ...base, status: 'distribution_prep', adSetupConfirmed: false }, 'promoting', admin)).toThrowError(/ad setup/);
    expect(() => checkTransition({ ...base, status: 'distribution_prep' }, 'promoting', admin)).not.toThrow();
  });
});
