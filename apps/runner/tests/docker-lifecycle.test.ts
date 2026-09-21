import { afterEach, describe, expect, it, vi } from 'vitest';

const docker = vi.hoisted(() => ({
  getImage: vi.fn(),
  createContainer: vi.fn(),
}));

vi.mock('dockerode', () => ({ default: class { constructor() { return docker; } } }));

import { runStepInDocker } from '../src/docker-runner.js';

afterEach(() => {
  vi.useRealTimers();
  vi.resetAllMocks();
});

describe('Docker lifecycle', () => {
  it('does not create a container when cancelled while checking the image', async () => {
    const controller = new AbortController();
    docker.getImage.mockReturnValue({ inspect: async () => controller.abort() });
    const result = await runStepInDocker('alpine', 'sleep 60', '/tmp', undefined, controller.signal);
    expect(result.error).toBe('Cancelled by user request');
    expect(docker.createContainer).not.toHaveBeenCalled();
  });

  it('kills a container when cancellation occurs during startup', async () => {
    const controller = new AbortController();
    const container = {
      start: async () => controller.abort(),
      kill: vi.fn().mockResolvedValue(undefined),
      wait: vi.fn().mockResolvedValue({ StatusCode: 137 }),
      logs: vi.fn().mockResolvedValue(Buffer.alloc(0)),
      remove: vi.fn().mockResolvedValue(undefined),
    };
    docker.getImage.mockReturnValue({ inspect: async () => {} });
    docker.createContainer.mockResolvedValue(container);
    const result = await runStepInDocker('alpine', 'sleep 60', '/tmp', undefined, controller.signal);
    expect(result.error).toBe('Cancelled by user request');
    expect(container.kill).toHaveBeenCalledOnce();
    expect(container.remove).toHaveBeenCalledWith({ force: true });
  });

  it('clears timeout and cancellation handlers when waiting fails', async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const container = {
      start: vi.fn().mockResolvedValue(undefined),
      kill: vi.fn(),
      stop: vi.fn(),
      wait: vi.fn().mockRejectedValue(new Error('Connection lost')),
      remove: vi.fn().mockResolvedValue(undefined),
    };
    docker.getImage.mockReturnValue({ inspect: async () => {} });
    docker.createContainer.mockResolvedValue(container);
    const result = await runStepInDocker('alpine', 'sleep 60', '/tmp', 1000, controller.signal);
    expect(result.error).toBe('Connection lost');
    controller.abort();
    await vi.runAllTimersAsync();
    expect(container.kill).not.toHaveBeenCalled();
    expect(container.stop).not.toHaveBeenCalled();
    expect(container.remove).toHaveBeenCalledOnce();
  });
});
