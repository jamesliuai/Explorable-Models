/**
 * Test doubles for the spatial renderer's DOM-free controller (tests only): a fake WebGL renderer that mimics
 * `renderer.info.memory` bookkeeping (a geometry counts once it is drawn and is uncounted when disposed), a manual
 * frame/timer scheduler, and small synthetic `scene3d` views.
 */
import type { Camera, Color, Scene } from 'three';
import type { GeometryResult } from '../../packages/core/src/model/index';
import type { RendererPort, SchedulerPort } from '../../packages/player-3d/src/controller';
import type { SpatialMark, SpatialView } from '../../packages/player-3d/src/types';

export class FakeRenderer implements RendererPort {
  renders = 0;
  disposeCalls = 0;
  contextLossCalls = 0;
  size: [number, number] = [0, 0];
  pixelRatio = 1;
  clearColor: string | null = null;
  readonly info = { memory: { geometries: 0, textures: 0 }, programs: [] as unknown[] };
  private readonly uploaded = new Set<object>();

  render(scene: Scene, _camera: Camera): void {
    if (this.disposeCalls) throw new Error('render after dispose');
    this.renders++;
    scene.traverse(object => {
      const geometry = (object as { geometry?: { addEventListener(type: 'dispose', listener: () => void): void } }).geometry;
      if (!geometry || this.uploaded.has(geometry)) return;
      this.uploaded.add(geometry);
      this.info.memory.geometries++;
      geometry.addEventListener('dispose', () => { if (this.uploaded.delete(geometry)) this.info.memory.geometries--; });
    });
  }
  setSize(width: number, height: number): void { this.size = [width, height]; }
  setPixelRatio(ratio: number): void { this.pixelRatio = ratio; }
  setClearColor(color: Color): void { this.clearColor = `#${color.getHexString()}`; }
  dispose(): void { this.disposeCalls++; }
  forceContextLoss(): void { this.contextLossCalls++; }
}

export class ManualScheduler implements SchedulerPort {
  time = 0;
  private next = 1;
  private readonly frames = new Map<number, (time: number) => void>();
  private readonly timers = new Map<number, { callback: () => void; at: number }>();

  frame(callback: (time: number) => void): number { const handle = this.next++; this.frames.set(handle, callback); return handle; }
  cancelFrame(handle: number): void { this.frames.delete(handle); }
  timer(callback: () => void, ms: number): number { const handle = this.next++; this.timers.set(handle, { callback, at: this.time + ms }); return handle; }
  cancelTimer(handle: number): void { this.timers.delete(handle); }
  now(): number { return this.time; }

  get pendingFrames(): number { return this.frames.size; }
  get pendingTimers(): number { return this.timers.size; }
  /** Runs the queued animation frames once (frames requested meanwhile wait for the next call). */
  flush(): number {
    const due = [...this.frames.values()];
    this.frames.clear();
    for (const callback of due) callback(this.time);
    return due.length;
  }
  /** Advances time by `ms` in frame-sized steps, running frames and due timers. */
  advance(ms: number, step = 16): void {
    const end = this.time + ms;
    while (this.time < end) {
      this.time = Math.min(end, this.time + step);
      this.flush();
      for (const [handle, timer] of [...this.timers]) if (timer.at <= this.time) { this.timers.delete(handle); timer.callback(); }
    }
  }
}

export const style = (patch: Partial<SpatialMark['style']> = {}): SpatialMark['style'] => ({ role: 'primary', dash: 'solid', marker: 'none', weight: 'regular', ...patch });

export function view(marks: SpatialMark[], patch: Partial<SpatialView> = {}): SpatialView {
  return {
    viewId: 'space', kind: 'scene3d', title: 'Space', summary: 'Test view.', bounds3: [-6, 6, -6, 6, -6, 6], equalAspect: true,
    axes: { x: { label: 'x', unitLabel: '' }, y: { label: 'y', unitLabel: '' }, z: { label: 'z', unitLabel: '' } },
    marks, ...patch,
  };
}

export const vectors = (segments: { id: string; to: [number, number, number] }[], patch: Partial<SpatialMark> = {}): SpatialMark => ({
  markId: 'vector-segments', kind: 'segments', label: 'Vectors', style: style({ marker: 'triangle', weight: 'bold' }),
  geometry: { kind: 'segments3', segments: segments.map(segment => ({ id: segment.id, from: [0, 0, 0], to: segment.to })) },
  ...patch,
});

export function points(count: number, markId = 'cloud'): SpatialMark {
  const geometry: GeometryResult = { kind: 'points3', points: Array.from({ length: count }, (_, i) => ({ id: `p${i}`, at: [(i % 10) / 2 - 2, Math.floor(i / 10) % 10 / 2 - 2, 0] as [number, number, number] })) };
  return { markId, kind: 'points', label: `Cloud ${markId}`, style: style({ marker: 'circle' }), geometry };
}

export function surface(nx: number, ny: number, height: (x: number, y: number) => number | null = (x, y) => (x * x + y * y) / 2, markId = 'surface-mesh'): SpatialMark {
  const xs = Array.from({ length: nx }, (_, i) => -2 + (4 * i) / (nx - 1));
  const ys = Array.from({ length: ny }, (_, j) => -2 + (4 * j) / (ny - 1));
  const z: (number | null)[] = [];
  for (const y of ys) for (const x of xs) z.push(height(x, y));
  return { markId, kind: 'surface', label: 'Surface', style: style({ role: 'muted', weight: 'thin' }), geometry: { kind: 'surface-grid', xs, ys, z, sampling: { nx, ny, domain: [-2, 2, -2, 2] } } };
}

export function field(count: number, factor = 0.25): SpatialMark {
  return {
    markId: 'field-arrows', kind: 'vector-field', label: 'Field', style: style({ role: 'secondary', marker: 'triangle', weight: 'thin' }),
    geometry: { kind: 'vector-field3', samples: Array.from({ length: count }, (_, i) => ({ at: [(i % 10) - 5, Math.floor(i / 10) % 10 - 5, 0] as [number, number, number], vector: [1, i % 3 === 0 ? 0 : 1, 0] as [number, number, number] })), scale: { factor, disclosure: `Arrow lengths are scaled by ${factor} for legibility; directions are exact.` } },
  };
}
