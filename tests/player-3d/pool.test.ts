/**
 * The renderer pool (report §13, §18, A47; lifecycle.md §5): a disposed 3D view hands its renderer back, and the next
 * mount in the document reuses its canvas and WebGL context instead of creating one, so repeated mount/dispose cycles
 * never grow the engine's count of contexts (WebKit counts a lost context until it is collected and then loses the
 * oldest one, which can be a view still shown). Checked here with fake renderers and the real DOM-free controller:
 * reuse, the reset of a parked renderer, the idle bound, lost contexts, `clear` (`releaseIdleRenderers`), and that a
 * borrowed renderer's counters return to zero after every cycle and are never reported by a disposed instance.
 */
import { describe, expect, it } from 'vitest';
import { SpatialController } from '../../packages/player-3d/src/controller';
import { IDLE_RENDERER_LIMIT, RendererPool, type PoolableRenderer } from '../../packages/player-3d/src/pool';
import { LIGHT_THEME } from '../../packages/player-3d/src/theme';
import { FakeRenderer, ManualScheduler, surface, vectors, view } from './support';

class PooledFake extends FakeRenderer implements PoolableRenderer {
  static created = 0;
  readonly id = ++PooledFake.created;
  lost = false;
  attached = true;
  calls: string[] = [];
  readonly domElement = { remove: () => { this.attached = false; this.calls.push('remove'); } };
  readonly renderLists = { dispose: () => { this.calls.push('renderLists.dispose'); } };
  getContext() { return { isContextLost: () => this.lost }; }
  resetState(): void { this.calls.push('resetState'); }
  override setSize(width: number, height: number): void { super.setSize(width, height); this.calls.push(`setSize(${width},${height})`); }
  override setPixelRatio(ratio: number): void { super.setPixelRatio(ratio); this.calls.push(`setPixelRatio(${ratio})`); }
  override dispose(): void { super.dispose(); this.calls.push('dispose'); }
  override forceContextLoss(): void { super.forceContextLoss(); this.lost = true; this.calls.push('forceContextLoss'); }
}
const fresh = () => new PooledFake();
const scene = (n: number) => view([vectors([{ id: 'u', to: [2, 1, n % 3] }, { id: 'v', to: [1, 2, 2] }]), surface(9, 9)]);

describe('renderer pool', () => {
  it('parks a released renderer (canvas out of the page, GL state reset, 1 × 1 drawing buffer) and hands it to the next mount', () => {
    const pool = new RendererPool<PooledFake>();
    const first = pool.acquire(fresh);
    expect(first.reused).toBe(false);
    expect(pool.release(first.renderer)).toBe('idle');
    expect(first.renderer.calls).toEqual(['remove', 'renderLists.dispose', 'resetState', 'setPixelRatio(1)', 'setSize(1,1)']);
    expect([first.renderer.attached, first.renderer.disposeCalls, first.renderer.contextLossCalls, pool.size]).toEqual([false, 0, 0, 1]);
    const second = pool.acquire(fresh);
    expect(second).toEqual({ renderer: first.renderer, reused: true });
    expect(pool.size).toBe(0);
    // Releasing the same renderer twice parks it once.
    pool.release(second.renderer);
    expect(pool.release(second.renderer)).toBe('idle');
    expect(pool.size).toBe(1);
  });

  it(`keeps at most ${IDLE_RENDERER_LIMIT} idle renderers per pool; a surplus one is disposed and its context released at once`, () => {
    const pool = new RendererPool<PooledFake>();
    const renderers = [0, 1, 2].map(() => pool.acquire(fresh).renderer);
    expect(renderers.map(renderer => pool.release(renderer))).toEqual(['idle', 'idle', 'discarded']);
    expect(IDLE_RENDERER_LIMIT).toBe(2);
    expect(pool.size).toBe(2);
    expect(renderers.map(renderer => [renderer.disposeCalls, renderer.contextLossCalls])).toEqual([[0, 0], [0, 0], [1, 1]]);
    expect(pool.discarded).toBe(1);
  });

  it('discards a renderer whose context is lost, without forcing a loss it already has, and skips a lost idle one', () => {
    const pool = new RendererPool<PooledFake>();
    const failed = pool.acquire(fresh).renderer;
    expect(pool.release(failed, true)).toBe('discarded');
    expect([failed.disposeCalls, failed.contextLossCalls, failed.attached]).toEqual([1, 0, false]);
    const parked = pool.acquire(fresh).renderer;
    pool.release(parked);
    // The engine evicted the idle context while it was parked: the next mount gets a new renderer.
    parked.lost = true;
    const next = pool.acquire(fresh);
    expect(next.reused).toBe(false);
    expect(next.renderer).not.toBe(parked);
    expect([parked.disposeCalls, parked.contextLossCalls]).toEqual([1, 0]);
    // A context lost by the time it is released (not reported by the owner) is not parked either.
    next.renderer.lost = true;
    expect(pool.release(next.renderer)).toBe('discarded');
    expect(pool.size).toBe(0);
  });

  it('clear() disposes every idle renderer and releases its context (releaseIdleRenderers)', () => {
    const pool = new RendererPool<PooledFake>();
    const [a, b] = [pool.acquire(fresh).renderer, pool.acquire(fresh).renderer];
    pool.release(a);
    pool.release(b);
    expect(pool.clear()).toBe(2);
    expect([a, b].map(renderer => [renderer.disposeCalls, renderer.contextLossCalls])).toEqual([[1, 1], [1, 1]]);
    expect(pool.clear()).toBe(0);
    expect(pool.acquire(fresh).reused).toBe(false);
  });

  it('50 mount/render/dispose cycles of the controller on a pooled renderer create one renderer, and its counters return to zero after every cycle', () => {
    const pool = new RendererPool<PooledFake>();
    const createdBefore = PooledFake.created;
    const after: Record<string, unknown>[] = [];
    let renderer: PooledFake | null = null;
    for (let cycle = 0; cycle < 50; cycle++) {
      const scheduler = new ManualScheduler();
      const acquired = pool.acquire(fresh).renderer;
      renderer ??= acquired;
      expect(acquired, `cycle ${cycle} reuses the renderer`).toBe(renderer);
      const controller = new SpatialController(acquired, scheduler, {
        view: scene(cycle), presentation: { camera: null, selection: null, layers: [] }, reducedMotion: true, theme: LIGHT_THEME,
        releaseRenderer: lost => { pool.release(acquired, lost); }, hooks: { onCamera() {} },
      });
      controller.resize(320, 240, 2);
      scheduler.flush();
      expect(controller.stats().rendererGeometries).toBeGreaterThan(0);
      controller.dispose();
      after.push({ ...controller.stats(), memory: acquired.info.memory.geometries, idle: pool.size, disposed: acquired.disposeCalls, lost: acquired.contextLossCalls });
    }
    expect(PooledFake.created - createdBefore).toBe(1);
    for (const [cycle, entry] of after.entries()) {
      expect(entry, `cycle ${cycle}`).toMatchObject({ status: 'disposed', geometries: 0, materials: 0, textures: 0, rendererGeometries: 0, rendererTextures: 0, programs: 0, pending: 0, memory: 0, idle: 1, disposed: 0, lost: 0 });
    }
  });

  it('a controller whose context could not be restored hands its renderer back as lost: it is discarded without a forced loss', () => {
    const pool = new RendererPool<PooledFake>();
    const renderer = pool.acquire(fresh).renderer;
    const reports: boolean[] = [];
    const scheduler = new ManualScheduler();
    const controller = new SpatialController(renderer, scheduler, {
      view: scene(0), presentation: { camera: null, selection: null, layers: [] }, reducedMotion: true, theme: LIGHT_THEME,
      releaseRenderer: lost => { reports.push(lost); pool.release(renderer, lost); }, hooks: { onCamera() {} },
    });
    controller.contextLostEvent();
    controller.markFailed('Could not restore.');
    controller.dispose();
    controller.dispose();
    expect(reports).toEqual([true]);
    expect([renderer.disposeCalls, renderer.contextLossCalls, pool.size]).toEqual([1, 0, 0]);
  });

  it('a disposed controller never reports the counters of a borrowed renderer that another view now uses', () => {
    const pool = new RendererPool<PooledFake>();
    const make = (renderer: PooledFake, scheduler: ManualScheduler, n: number) => new SpatialController(renderer, scheduler, {
      view: scene(n), presentation: { camera: null, selection: null, layers: [] }, reducedMotion: true, theme: LIGHT_THEME,
      releaseRenderer: lost => { pool.release(renderer, lost); }, hooks: { onCamera() {} },
    });
    const shared = pool.acquire(fresh).renderer;
    const firstScheduler = new ManualScheduler();
    const first = make(shared, firstScheduler, 0);
    first.resize(320, 240, 1);
    firstScheduler.flush();
    first.dispose();
    const secondScheduler = new ManualScheduler();
    const second = make(pool.acquire(fresh).renderer, secondScheduler, 1);
    second.resize(320, 240, 1);
    secondScheduler.flush();
    expect(shared.info.memory.geometries).toBeGreaterThan(0);
    expect(first.stats()).toMatchObject({ status: 'disposed', rendererGeometries: 0, rendererTextures: 0, programs: 0 });
    expect(second.stats().rendererGeometries).toBe(shared.info.memory.geometries);
  });
});
