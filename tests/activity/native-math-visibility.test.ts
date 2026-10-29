/** Observer TEST DOUBLE and pure timing fixtures; actual viewport/font evidence comes from packaged conformance. */
import { describe, expect, it } from 'vitest';
import { auditedMathObserver, equationVisibility, lazyMathEvidence, mathResources } from '../../examples/study-harness-tauri/src/conformance/math-visibility';

class ObserverDouble {
  constructor(readonly callback: IntersectionObserverCallback) {}
  observe(_element: Element) {}
  emit(target: Element, isIntersecting: boolean, time: number) { this.callback([{ target, isIntersecting, time } as IntersectionObserverEntry], this as unknown as IntersectionObserver); }
}
const equation = () => ({ classList: { contains: (name: string) => name === 'ema-equation' } }) as unknown as Element;
const audit = () => auditedMathObserver(ObserverDouble as unknown as typeof IntersectionObserver);
const base = () => ({ auditInstalled: true, firstVisibleAt: null as number | null,
  equations: [{ observed: true, firstVisibleAt: null as number | null, rendered: false }], resources: [] as { name: string; startTime: number }[], registeredFaces: 0 });

describe('packaged math viewport evidence', () => {
  it('records a native viewport entry before delivering the rendering callback and retains that history after leaving the viewport', () => {
    const node = equation(), seen: (number | null)[] = [];
    const observer = new (audit())(() => seen.push(equationVisibility(node).firstVisibleAt));
    observer.observe(node);
    (observer as unknown as ObserverDouble).emit(node, false, 5);
    (observer as unknown as ObserverDouble).emit(node, true, 10);
    (observer as unknown as ObserverDouble).emit(node, false, 20);
    expect(seen).toEqual([null, 10, 10]);
    expect(equationVisibility(node)).toEqual({ observed: true, firstVisibleAt: 10 });
  });

  it('resets eligibility for a new observation and ignores late callbacks from the old observer', () => {
    const node = equation(), Constructor = audit();
    const first = new Constructor(() => undefined); first.observe(node);
    (first as unknown as ObserverDouble).emit(node, true, 10);
    const next = new Constructor(() => undefined); next.observe(node);
    (first as unknown as ObserverDouble).emit(node, true, 20);
    expect(equationVisibility(node).firstVisibleAt).toBeNull();
    (next as unknown as ObserverDouble).emit(node, true, 30);
    expect(equationVisibility(node).firstVisibleAt).toBe(30);
  });

  it('accepts a cold offscreen equation and a previously eligible equation moved offscreen by a later stage', () => {
    expect(lazyMathEvidence(base()).ok).toBe(true);
    expect(lazyMathEvidence({ ...base(), firstVisibleAt: 10, equations: [{ observed: true, firstVisibleAt: 10, rendered: true }],
      resources: [{ name: 'katex.js', startTime: 11 }], registeredFaces: 20 }).ok).toBe(true);
  });

  it('refuses eager output, unobserved output, early math requests, early font registration and missing audit evidence', () => {
    expect(lazyMathEvidence({ ...base(), equations: [{ observed: true, firstVisibleAt: null, rendered: true }] }).ok).toBe(false);
    expect(lazyMathEvidence({ ...base(), firstVisibleAt: 10, equations: [{ observed: false, firstVisibleAt: 10, rendered: true }] }).ok).toBe(false);
    expect(lazyMathEvidence({ ...base(), firstVisibleAt: 10, resources: [{ name: 'katex.js', startTime: 9 }] }).ok).toBe(false);
    expect(lazyMathEvidence({ ...base(), registeredFaces: 20 }).ok).toBe(false);
    expect(lazyMathEvidence({ ...base(), auditInstalled: false }).ok).toBe(false);
  });

  it('selects only math code, stylesheet and font resource timings', () => {
    const names = ['/assets/katex-123.js', '/assets/katex.min-123.css', '/assets/math-font-urls-123.js', '/assets/KaTeX_Main-Regular-123.woff2'];
    expect(mathResources([...names, '/assets/index.js', '/assets/inter-latin.woff2'].map(name => ({ name, startTime: 1 }))).map(entry => entry.name)).toEqual(names);
  });
});
