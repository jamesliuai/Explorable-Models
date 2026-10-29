/** Asset-loader TEST DOUBLES: cancellation/error behavior only; real captures run in the browser suites. */
import { afterEach, describe, expect, it, vi } from 'vitest';

const rendererPath = '../../packages/player/src/activity/capture-renderer';
afterEach(() => { vi.doUnmock(rendererPath); vi.resetModules(); });

describe('optional capture asset loading', () => {
  it('rejects DISPOSED while a module load is still pending, without waiting for that module', async () => {
    let release!: (module: { captureView: () => void }) => void;
    let started!: () => void;
    const loading = new Promise<void>(resolve => { started = resolve; });
    const held = new Promise<{ captureView: () => void }>(resolve => { release = resolve; });
    vi.doMock(rendererPath, () => { started(); return held; });
    const { loadCaptureView, CaptureError } = await import('../../packages/player/src/activity/capture');
    const life = new AbortController();
    const result = loadCaptureView(life.signal).catch(error => error);
    await loading;
    life.abort();
    const error: unknown = await result;
    expect(error).toBeInstanceOf(CaptureError);
    expect(error).toMatchObject({ code: 'DISPOSED' });
    release({ captureView: () => undefined });
    await held;
  });

  it('reports an unavailable local module as a recoverable capture error', async () => {
    vi.doMock(rendererPath, () => { throw new Error('test asset unavailable'); });
    const { loadCaptureView } = await import('../../packages/player/src/activity/capture');
    await expect(loadCaptureView(new AbortController().signal)).rejects.toMatchObject({
      code: 'CAPTURE_REJECTED', recovery: expect.stringMatching(/reload.*retry/),
    });
  });
});
