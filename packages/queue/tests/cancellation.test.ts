import { describe, it, expect, afterAll } from 'vitest';
import {
  publishJobCancellation,
  isJobCancelled,
  clearJobCancellation,
  subscribeJobCancellation,
  closeRedis,
} from '../src/index.js';

describe('Job Cancellation via Redis Pub/Sub', () => {
  const testJobId = `job-cancel-test-${Date.now()}`;

  afterAll(async () => {
    await clearJobCancellation(testJobId);
    await closeRedis();
  });

  it('publishes cancellation flag and checks cancellation status', async () => {
    expect(await isJobCancelled(testJobId)).toBe(false);

    await publishJobCancellation(testJobId, 'Aborted by operator');

    expect(await isJobCancelled(testJobId)).toBe(true);

    await clearJobCancellation(testJobId);
    expect(await isJobCancelled(testJobId)).toBe(false);
  });

  it('subscribes to cancellation channel and receives broadcast event', async () => {
    const liveJobId = `job-live-cancel-${Date.now()}`;
    let receivedReason = '';

    const unsubscribe = await subscribeJobCancellation(liveJobId, (event) => {
      receivedReason = event.reason;
    });

    // Brief delay to ensure subscription is active
    await new Promise((r) => setTimeout(r, 100));

    await publishJobCancellation(liveJobId, 'User requested immediate cancellation');

    // Wait for event
    await new Promise((r) => setTimeout(r, 200));

    expect(receivedReason).toBe('User requested immediate cancellation');
    expect(await isJobCancelled(liveJobId)).toBe(true);

    await unsubscribe();
    await clearJobCancellation(liveJobId);
  });
});
