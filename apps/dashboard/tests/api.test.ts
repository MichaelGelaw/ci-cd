import { afterEach, describe, expect, it, vi } from 'vitest';
import { getJob, subscribeJobLogs } from '../src/lib/api';

afterEach(() => { vi.unstubAllGlobals(); });

describe('authenticated dashboard requests', () => {
  it('sends the tab API key in a header', async () => {
    vi.stubGlobal('window', { sessionStorage: { getItem: () => 'test-key' } });
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ job: { id: 'job' } })));
    vi.stubGlobal('fetch', fetchMock);
    await getJob('job');
    expect(fetchMock.mock.calls[0]?.[1].headers.Authorization).toBe('Bearer test-key');
    expect(fetchMock.mock.calls[0]?.[0]).not.toContain('test-key');
  });

  it('authenticates streamed logs and handles frames split across network chunks', async () => {
    vi.stubGlobal('window', { sessionStorage: { getItem: () => 'test-key' } });
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode('data: {"jobId":"job","stream":"stdout","data":"hel'));
        controller.enqueue(encoder.encode('lo","timestamp":"now"}\n\ndata: {"jobId":"job","event":"end"}\n\n'));
        controller.close();
      },
    });
    const fetchMock = vi.fn().mockResolvedValue(new Response(stream));
    vi.stubGlobal('fetch', fetchMock);
    const onChunk = vi.fn();
    const onEnd = vi.fn();
    const onError = vi.fn();
    const stop = subscribeJobLogs('job', onChunk, onEnd, onError);
    await vi.waitFor(() => expect(onEnd).toHaveBeenCalledOnce());
    expect(fetchMock.mock.calls[0]?.[1].headers.Authorization).toBe('Bearer test-key');
    expect(onChunk).toHaveBeenCalledOnce();
    expect(onChunk.mock.calls[0]?.[0].data).toBe('hello');
    expect(onError).not.toHaveBeenCalled();
    stop();
  });
});
