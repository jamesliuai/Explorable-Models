/**
 * Ownership registries (report §13, A47). Three.js frees GPU memory only when geometries, materials and textures are
 * disposed explicitly — removing an object from the scene is not enough — so every resource this renderer creates is
 * tracked here and released by group or all at once. Listeners, observers and pending timers are tracked the same way,
 * so `stats()` reports live counts and teardown can prove they return to zero.
 */
export type ResourceKind = 'geometry' | 'material' | 'texture';
export interface Disposable { dispose(): void }

export class ResourceRegistry {
  private readonly live = new Map<Disposable, ResourceKind>();
  private released = 0;

  track<T extends Disposable>(kind: ResourceKind, resource: T): T {
    this.live.set(resource, kind);
    return resource;
  }

  /** Disposes the given resources (those still tracked); unknown or already released entries are ignored. */
  release(resources: Iterable<Disposable>): void {
    for (const resource of resources) {
      if (!this.live.delete(resource)) continue;
      this.released++;
      resource.dispose();
    }
  }

  releaseAll(): void { this.release([...this.live.keys()]); }

  counts(): { geometries: number; materials: number; textures: number; released: number } {
    let geometries = 0, materials = 0, textures = 0;
    for (const kind of this.live.values()) {
      if (kind === 'geometry') geometries++;
      else if (kind === 'material') materials++;
      else textures++;
    }
    return { geometries, materials, textures, released: this.released };
  }
}

/** A group of resources created for one build (content, axes) and released together. */
export class ResourceGroup {
  private readonly items: Disposable[] = [];
  constructor(private readonly registry: ResourceRegistry) {}
  add<T extends Disposable>(kind: ResourceKind, resource: T): T {
    this.items.push(this.registry.track(kind, resource));
    return resource;
  }
  release(): void { this.registry.release(this.items.splice(0)); }
  get size(): number { return this.items.length; }
}

export interface ListenerTarget {
  addEventListener(type: string, listener: (event: Event) => void, options?: boolean | AddEventListenerOptions): void;
  removeEventListener(type: string, listener: (event: Event) => void, options?: boolean | EventListenerOptions): void;
}

/** Event listeners and observers owned by one mounted renderer. */
export class LifecycleRegistry {
  private readonly removers = new Set<() => void>();
  private readonly observers = new Set<{ disconnect(): void }>();

  listen<E>(target: ListenerTarget, type: string, listener: (event: E) => void, options?: AddEventListenerOptions): () => void {
    const handler = listener as unknown as (event: Event) => void;
    target.addEventListener(type, handler, options);
    const remove = () => { if (this.removers.delete(remove)) target.removeEventListener(type, handler, options); };
    this.removers.add(remove);
    return remove;
  }

  observe<T extends { disconnect(): void }>(observer: T): T {
    this.observers.add(observer);
    return observer;
  }

  get listeners(): number { return this.removers.size; }
  get observerCount(): number { return this.observers.size; }

  disposeAll(): void {
    for (const remove of [...this.removers]) remove();
    for (const observer of this.observers) observer.disconnect();
    this.observers.clear();
  }
}
