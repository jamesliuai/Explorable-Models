/**
 * Declared maximum work, checkpoint and determinism behaviour of every installed kernel (report §8.1, A14; G36). Each
 * kernel runs, metered (tests/catalog/support/work-meter.ts), over its worst cases — every authored scenario, every
 * corner of its parameter domain, the most extreme admissible values (zero, the smallest subnormal, ±bounds) combined
 * with the defaults, a seeded sample of the domain, and for a discrete kernel the largest index — and its counted
 * operations must stay within the manifest's `limits.maxOperations`; the slowest of those evaluations must also finish
 * well inside the interactive budget. The checker itself is shown to fail when a declared budget is one below the
 * measured worst case. Every catalogue manifest declares its evaluation behaviour.
 */
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { checkParameters, modelIdentity, MODEL_WORKER_TIMEOUT_MS, validateManifest, type KernelInput, type ModelManifest } from '@experiment-kit/core/model';
import { INSTALLED_KERNELS, INSTALLED_MODELS, INSTALLED_TEMPLATES } from '@experiment-kit/catalog';
import { meteredKernel } from './support/work-meter';

const KERNEL_SOURCE = (id: string) => fileURLToPath(new URL(`../../packages/catalog/src/kernels/${id}.ts`, import.meta.url));
const EXPORTS: Record<string, string> = {
  'quadratic-gradient-descent': 'quadraticGradientDescentKernel', 'function-derivative': 'functionDerivativeKernel', 'linear-transformation': 'linearTransformationKernel',
  'vector-orientation-3d': 'vectorOrientationKernel', 'quadratic-surface-gradient': 'quadraticSurfaceGradientKernel',
};
/** Wall-time ceiling for one worst-case evaluation: a tenth of the 100 ms commit-to-frame target (report §18). */
const WORST_CASE_MS = 10;

/** Deterministic PRNG (mulberry32) so the sampled cases are reproducible. */
function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => { state = (state + 0x6d2b79f5) >>> 0; let t = state; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
/** Extreme admissible values of one parameter: bounds, default, zero, the smallest subnormals and values next to the bounds. */
function extremes(manifest: ModelManifest, id: string): number[] {
  const { min, max, default: value } = manifest.parameters[id]!;
  const candidates = [min, max, value, 0, Number.MIN_VALUE, -Number.MIN_VALUE, 1e-300, -1e-300, min / 2 + max / 2, min + (max - min) * 1e-9, max - (max - min) * 1e-9];
  return [...new Set(candidates.filter(x => x >= min && x <= max))];
}
/** Worst-case parameter sets: scenarios, corners, one-at-a-time extremes and a seeded sample, all admissible. */
function cases(manifest: ModelManifest): Record<string, number>[] {
  const ids = Object.keys(manifest.parameters);
  const defaults = Object.fromEntries(ids.map(id => [id, manifest.parameters[id]!.default]));
  const out: Record<string, number>[] = [defaults];
  for (const template of INSTALLED_TEMPLATES.filter(item => item.model.modelId === manifest.modelId)) for (const scenario of template.scenarios) out.push({ ...defaults, ...scenario.parameters });
  for (let mask = 0; mask < 2 ** ids.length; mask++) out.push(Object.fromEntries(ids.map((id, bit) => [id, mask & (1 << bit) ? manifest.parameters[id]!.max : manifest.parameters[id]!.min])));
  for (const id of ids) for (const value of extremes(manifest, id)) out.push({ ...defaults, [id]: value });
  const next = random(0x5eed + ids.length);
  const pools = ids.map(id => extremes(manifest, id));
  for (let i = 0; i < 400; i++) out.push(Object.fromEntries(ids.map((id, k) => [id, next() < 0.5 ? pools[k]![Math.floor(next() * pools[k]!.length)]! : manifest.parameters[id]!.min + next() * (manifest.parameters[id]!.max - manifest.parameters[id]!.min)])));
  return out.filter(params => checkParameters(manifest, params).length === 0);
}
const indices = (manifest: ModelManifest): number[] => manifest.execution.kind === 'kernel' && manifest.execution.mode === 'discrete'
  ? [...new Set([0, 1, 2, 64, 500, manifest.execution.maxIndex - 1, manifest.execution.maxIndex])] : [0];

interface WorstCase { operations: number; input: KernelInput }
const worst = new Map<string, WorstCase>();
async function measure(manifest: ModelManifest): Promise<WorstCase> {
  const execution = manifest.execution;
  if (execution.kind !== 'kernel') throw new Error('Installed models are kernel models.');
  const cached = worst.get(manifest.modelId);
  if (cached) return cached;
  const metered = await meteredKernel(KERNEL_SOURCE(execution.kernelId), EXPORTS[execution.kernelId]!);
  let found: WorstCase = { operations: -1, input: { params: {}, index: 0 } };
  for (const params of cases(manifest)) for (const index of indices(manifest)) {
    const input: KernelInput = { params: Object.freeze({ ...params }), index };
    const { operations } = metered.measure(input);
    if (operations > found.operations) found = { operations, input };
  }
  worst.set(manifest.modelId, found);
  return found;
}
/** The check this test applies: the measured worst case is within the declared budget. */
const withinBudget = (manifest: Pick<ModelManifest, 'limits'>, operations: number): boolean => operations <= manifest.limits.maxOperations;

describe('declared evaluation behaviour (report §8.1)', () => {
  it.each(INSTALLED_MODELS.map(manifest => [manifest.modelId, manifest] as const))('%s declares its determinism class and checkpoint requirement', (_id, manifest) => {
    expect(validateManifest(manifest).manifest.evaluation).toEqual({ determinism: expect.stringMatching(/^(bitwise|within-engine)$/), checkpoint: 'none' });
  });
  it('is part of the scientific identity: changing it changes the scientific revision, not the presentation revision', () => {
    for (const manifest of INSTALLED_MODELS) {
      const base = modelIdentity(manifest);
      const flipped = modelIdentity({ ...manifest, evaluation: { determinism: manifest.evaluation!.determinism === 'bitwise' ? 'within-engine' : 'bitwise', checkpoint: 'none' } });
      expect(flipped.scientificRevision, manifest.modelId).not.toBe(base.scientificRevision);
      expect(flipped.presentationRevision, manifest.modelId).toBe(base.presentationRevision);
      const { evaluation: _omitted, ...without } = manifest;
      expect(modelIdentity(without).scientificRevision, manifest.modelId).not.toBe(base.scientificRevision);
    }
  });
  it('declares within-engine determinism exactly where outputs use engine-approximated functions', () => {
    expect(Object.fromEntries(INSTALLED_MODELS.map(manifest => [manifest.modelId, manifest.evaluation?.determinism]))).toEqual({
      'quadratic-gradient-descent': 'bitwise', 'function-derivative': 'bitwise', 'linear-transformation': 'bitwise',
      'vector-orientation-3d': 'within-engine', 'quadratic-surface-gradient': 'within-engine',
    });
  });
});

describe('worst-case work of every installed kernel (report §8.1 maximum work)', () => {
  it.each(INSTALLED_MODELS.map(manifest => [manifest.modelId, manifest] as const))('%s stays within its declared maxOperations', async (_id, manifest) => {
    const found = await measure(manifest);
    expect(found.operations).toBeGreaterThan(0);
    expect(found.operations, `worst case ${JSON.stringify(found.input)}`).toBeLessThanOrEqual(manifest.limits.maxOperations);
    expect(withinBudget(manifest, found.operations)).toBe(true);
  }, 120_000);

  it.each(INSTALLED_MODELS.map(manifest => [manifest.modelId, manifest] as const))('%s evaluates its worst case well inside the interactive budget', async (_id, manifest) => {
    const found = await measure(manifest);
    const kernel = INSTALLED_KERNELS.find(item => manifest.execution.kind === 'kernel' && item.id === manifest.execution.kernelId)!;
    for (let warm = 0; warm < 5; warm++) kernel.evaluate(found.input);
    const times = Array.from({ length: 7 }, () => { const start = performance.now(); kernel.evaluate(found.input); return performance.now() - start; });
    expect(Math.min(...times)).toBeLessThan(WORST_CASE_MS);
    expect(WORST_CASE_MS).toBeLessThan(MODEL_WORKER_TIMEOUT_MS);
  }, 120_000);

  it('fails a kernel whose declared budget is one operation below its measured worst case', async () => {
    for (const manifest of INSTALLED_MODELS) {
      const found = await measure(manifest);
      expect(withinBudget({ limits: { ...manifest.limits, maxOperations: found.operations - 1 } }, found.operations)).toBe(false);
      expect(withinBudget({ limits: { ...manifest.limits, maxOperations: found.operations } }, found.operations)).toBe(true);
    }
  }, 120_000);
});

describe('the operation meter', () => {
  it('counts operators, calls and loop iterations of the kernel’s own code', async () => {
    const quadratic = INSTALLED_MODELS.find(manifest => manifest.modelId === 'quadratic-gradient-descent')!;
    const metered = await meteredKernel(KERNEL_SOURCE('quadratic-gradient-descent'), EXPORTS['quadratic-gradient-descent']!);
    const params = Object.fromEntries(Object.entries(quadratic.parameters).map(([id, definition]) => [id, definition.default]));
    const small = metered.measure({ params, index: 1 }).operations, large = metered.measure({ params, index: 1000 }).operations;
    // The trace grows with the index: more iterates, more work.
    expect(large).toBeGreaterThan(small);
    // The metered copy computes exactly what the installed kernel computes.
    const installed = INSTALLED_KERNELS.find(kernel => kernel.id === 'quadratic-gradient-descent')!;
    expect(metered.measure({ params, index: 1000 }).output).toEqual(installed.evaluate({ params, index: 1000 }));
  });
});
