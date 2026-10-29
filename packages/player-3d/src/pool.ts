/**
 * Bounded reuse of WebGL renderers across mounts (report §13, §18, A47).
 *
 * Every mounted 3D view needs a WebGL context, and engines bound how many one page (WebKit: one web process) may hold:
 * past 16, Chromium and WebKit lose the oldest context to create a new one. Forcing the loss of a disposed renderer's
 * context releases it at once in Chromium and Firefox, but WebKit keeps a lost context in that count until the context
 * object is garbage-collected, so repeated mount/dispose cycles there made the engine lose the context of a view that
 * was still shown (lifecycle.md §5). A disposed view therefore hands its renderer back to a small per-document pool
 * instead of discarding it: the controller has already disposed every geometry and material it drew (so the renderer's
 * own counters and program cache are back to zero), the pool resets the GL state, drops the render lists and shrinks
 * the drawing buffer to 1 × 1, and the next mount in that document takes the renderer, canvas and context as they are.
 * Repeated mount/dispose cycles then create no new context at all.
 *
 * Bounds: at most {@link IDLE_RENDERER_LIMIT} idle renderers per document. A renderer is discarded — `dispose()`, then
 * `forceContextLoss()` unless its context is already lost — when the pool is full, when its context is lost (also
 * when a lost idle one is found at the next acquisition), or through {@link RendererPool.clear}
 * (`releaseIdleRenderers()` in the package API). The pool holds no timers, listeners or observers.
 *
 * DOM-free and Three.js-free at runtime: it works on the structural {@link PoolableRenderer}, so it is unit-tested in
 * Node with fakes.
 */

/** Idle renderers kept per document (a view remounting while another one does needs two). */
export const IDLE_RENDERER_LIMIT = 2;

/** The part of Three.js' `WebGLRenderer` the pool uses. */
export interface PoolableRenderer {
  readonly domElement: { remove(): void };
  getContext(): { isContextLost(): boolean };
  readonly renderLists: { dispose(): void };
  resetState(): void;
  setPixelRatio(ratio: number): void;
  setSize(width: number, height: number, updateStyle?: boolean): void;
  dispose(): void;
  forceContextLoss(): void;
}

const isLost = (renderer: PoolableRenderer): boolean => {
  try { return renderer.getContext().isContextLost(); } catch { return true; }
};

export class RendererPool<R extends PoolableRenderer> {
  private readonly idle: R[] = [];
  private discardedCount = 0;

  constructor(private readonly limit: number = IDLE_RENDERER_LIMIT) {}

  /** Idle renderers held now. */
  get size(): number { return this.idle.length; }
  /** Renderers discarded so far (pool full, lost context, or cleared). */
  get discarded(): number { return this.discardedCount; }

  /**
   * The most recently parked live renderer, or a new one from `create`. Idle renderers whose context was lost while
   * parked are discarded on the way. `reused` tells the caller whether a context was created.
   */
  acquire(create: () => R): { renderer: R; reused: boolean } {
    for (let renderer = this.idle.pop(); renderer; renderer = this.idle.pop()) {
      if (!isLost(renderer)) return { renderer, reused: true };
      this.discard(renderer);
    }
    return { renderer: create(), reused: false };
  }

  /**
   * Takes back a renderer whose owner has disposed everything it drew. It is parked for the next mount when its context
   * is live and the pool has room; otherwise it is discarded. Its canvas leaves the page either way.
   */
  release(renderer: R, contextLost = false): 'idle' | 'discarded' {
    if (this.idle.includes(renderer)) return 'idle';
    try { renderer.domElement.remove(); } catch { /* a canvas outside any tree has nothing to leave */ }
    if (contextLost || this.idle.length >= this.limit || isLost(renderer)) { this.discard(renderer, contextLost); return 'discarded'; }
    try {
      renderer.renderLists.dispose();
      renderer.resetState();
      renderer.setPixelRatio(1);
      renderer.setSize(1, 1, false);
    } catch {
      this.discard(renderer);
      return 'discarded';
    }
    this.idle.push(renderer);
    return 'idle';
  }

  /** Disposes a renderer and releases its context now, unless the context is already lost (or its owner says so). */
  discard(renderer: R, contextLost = false): void {
    const lost = contextLost || isLost(renderer);
    this.discardedCount++;
    try { renderer.domElement.remove(); } catch { /* already detached */ }
    try { renderer.dispose(); } finally {
      if (!lost) { try { renderer.forceContextLoss(); } catch { /* the extension is unavailable: collection releases it */ } }
    }
  }

  /** Discards every idle renderer; returns how many were released. */
  clear(): number {
    const idle = this.idle.splice(0);
    for (const renderer of idle) this.discard(renderer);
    return idle.length;
  }
}
