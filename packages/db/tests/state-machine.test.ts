import { describe, it, expect } from 'vitest';
import { isValidTransition, assertValidTransition } from '../src/state-machine.js';
import type { JobStatus } from '@mini-ci/types';

describe('Job State Machine', () => {
  it('allows legal initial and forward transitions', () => {
    expect(isValidTransition('created', 'queued')).toBe(true);
    expect(isValidTransition('queued', 'assigned')).toBe(true);
    expect(isValidTransition('assigned', 'running')).toBe(true);
    expect(isValidTransition('running', 'succeeded')).toBe(true);
  });

  it('allows failure and cancellation paths', () => {
    expect(isValidTransition('created', 'cancelled')).toBe(true);
    expect(isValidTransition('queued', 'cancelled')).toBe(true);
    expect(isValidTransition('assigned', 'cancelled')).toBe(true);
    expect(isValidTransition('running', 'cancelled')).toBe(true);
    expect(isValidTransition('running', 'failed')).toBe(true);
    expect(isValidTransition('running', 'timed_out')).toBe(true);
  });

  it('allows retrying from failed or timed_out', () => {
    expect(isValidTransition('failed', 'retrying')).toBe(true);
    expect(isValidTransition('timed_out', 'retrying')).toBe(true);
    expect(isValidTransition('retrying', 'queued')).toBe(true);
  });

  it('allows idempotent transitions to the same status', () => {
    const statuses: JobStatus[] = [
      'created',
      'queued',
      'assigned',
      'running',
      'succeeded',
      'failed',
      'cancelled',
      'timed_out',
      'retrying',
    ];

    for (const status of statuses) {
      expect(isValidTransition(status, status)).toBe(true);
    }
  });

  it('rejects illegal transitions from terminal states', () => {
    expect(isValidTransition('succeeded', 'running')).toBe(false);
    expect(isValidTransition('succeeded', 'queued')).toBe(false);
    expect(isValidTransition('cancelled', 'running')).toBe(false);
  });

  it('rejects skipped stages in the lifecycle', () => {
    expect(isValidTransition('created', 'running')).toBe(false);
    expect(isValidTransition('created', 'succeeded')).toBe(false);
    expect(isValidTransition('queued', 'succeeded')).toBe(false);
  });

  it('assertValidTransition throws on illegal transitions', () => {
    expect(() => assertValidTransition('succeeded', 'running')).toThrow(
      'Invalid job state transition: cannot transition from succeeded to running',
    );
  });
});
