/** Conformance-only evidence of actual equation viewport eligibility, including earlier layout stages. */
export interface EquationVisibility { observed: boolean; firstVisibleAt: number | null }
interface Observation { token: object; firstVisibleAt: number | null }
const observations = new WeakMap<Element, Observation>();
let firstVisibleAt: number | null = null;
let installed = false;

export const equationVisibility = (element: Element): EquationVisibility => {
  const entry = observations.get(element);
  return { observed: !!entry, firstVisibleAt: entry?.firstVisibleAt ?? null };
};
export const mathVisibilityState = () => ({ installed, firstVisibleAt });

/** Native callbacks are recorded before being delivered to the learner component; rendering is not simulated. */
export function auditedMathObserver(Native: typeof IntersectionObserver): typeof IntersectionObserver {
  return class extends Native {
    private readonly token: object;
    constructor(callback: IntersectionObserverCallback, options?: IntersectionObserverInit) {
      const token = {};
      super((entries, observer) => {
        for (const entry of entries) {
          const observation = observations.get(entry.target);
          if (!observation || !entry.isIntersecting) continue;
          firstVisibleAt = firstVisibleAt === null ? entry.time : Math.min(firstVisibleAt, entry.time);
          if (observation.token === token) observation.firstVisibleAt ??= entry.time;
        }
        callback(entries, observer);
      }, options);
      this.token = token;
    }
    override observe(target: Element): void {
      if (target.classList.contains('ema-equation')) observations.set(target, { token: this.token, firstVisibleAt: null });
      super.observe(target);
    }
  };
}

/** Install before app.start(), including the first mount of a restored card. Never included in a release build. */
export function installMathVisibilityAudit(): void {
  if (installed || typeof window.IntersectionObserver !== 'function') return;
  window.IntersectionObserver = auditedMathObserver(window.IntersectionObserver);
  installed = true;
}

export interface MathResource { name: string; startTime: number }
export function mathResources(resources: readonly MathResource[]): MathResource[] {
  return resources.filter(entry => /\/(?:katex[^/]*\.(?:js|css)|math-font-urls[^/]*\.js|KaTeX_[^/]*\.woff2)(?:[?#]|$)/i.test(entry.name));
}

/** A formula may have entered the viewport before a later stage moves its panel below the fold. */
export function lazyMathEvidence(input: {
  auditInstalled: boolean;
  firstVisibleAt: number | null;
  equations: (EquationVisibility & { rendered: boolean })[];
  resources: readonly MathResource[];
  registeredFaces: number;
}): { ok: boolean; unobservedRenders: number; earlyResources: MathResource[]; fontsBeforeVisibility: boolean } {
  const unobservedRenders = input.equations.filter(equation => equation.rendered && (!equation.observed || equation.firstVisibleAt === null)).length;
  // Resource timing may be absent for custom-protocol requests; the native observer history remains mandatory.
  const earlyResources = input.resources.filter(resource => input.firstVisibleAt === null || resource.startTime < input.firstVisibleAt);
  const fontsBeforeVisibility = input.registeredFaces > 0 && input.firstVisibleAt === null;
  return { ok: input.auditInstalled && !unobservedRenders && !earlyResources.length && !fontsBeforeVisibility, unobservedRenders, earlyResources, fontsBeforeVisibility };
}
