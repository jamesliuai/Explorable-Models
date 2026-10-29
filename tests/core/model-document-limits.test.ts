/**
 * Document executions keep numerical limits distinguishable (architecture D10, report §8.2, §12.3, A11): an overflow is
 * `numerical-limit`/OVERFLOW, a nonzero result that underflows to 0 is `numerical-limit`/UNDERFLOW (never a valid 0),
 * a reduced-precision subnormal is valid with an UNDERFLOW approximation, and mathematical undefinedness keeps its own
 * reason. Schema 2.0 frames themselves keep every status and value (D1); only undefined reasons name their cause.
 */
import { describe, expect, it } from 'vitest';
import { evaluateDocument } from '../../packages/core/src/declarative/evaluation';
import { NUMERICAL_LIMIT_REASONS } from '../../packages/core/src/declarative/expressions';
import type { VisualizationDocument } from '../../packages/core/src/declarative/types';
import {
  createModelSession, enableDocumentExecution, evaluateRequest, MODEL_CONTRACT, MODEL_SCHEMA_VERSION, validateManifest,
  type GeometryResult, type ModelManifest, type ModelQuantityDefinition,
} from '../../packages/core/src/model/index';
import { inlineWorkers } from './support/inline-worker';

enableDocumentExecution();

const EXPRESSIONS: Record<string, string> = {
  grow: 'exp(k)',
  decay: 'exp(-k)',
  power: '10^(k/2)',
  tiny: '10^(-k/2)',
  product: 'exp(-k)*exp(k)',
  scaled: 'exp(-k)*1e300',
  offset: '1 + exp(-k)',
  ratio: '1/exp(-k)',
  logOfTiny: 'log(exp(-k))',
  subnormal: 'exp(-k + 80)',
  root: 'pow(-8, 1/3)',
  pole: 'pow(0, -1)',
  mixed: 'sqrt(0 - k) + exp(k)',
  ordinary: '2*k',
};
const scalar = (label: string): ModelQuantityDefinition => ({ label, shape: { kind: 'scalar' }, dimension: 'dimensionless', unit: 'dimensionless', meaning: `${label} of the test document.` });

function limitsDocument(): VisualizationDocument {
  return {
    schemaVersion: '2.0', id: 'limits', title: 'Numerical limits', description: 'Exponentials at large arguments.',
    parameters: { k: { label: 'k', value: 1, min: 1, max: 1000 } },
    quantities: Object.fromEntries(Object.entries(EXPRESSIONS).map(([id, expression]) => [id, { expression, label: id }])),
    series: { curve: { label: 'exp(k·x)', variable: 'x', domain: [0, 1], samples: 5, y: 'exp(k*x)' } },
    views: [{ id: 'plot', type: 'plot', title: 'Curve', marks: [{ id: 'curve', type: 'line', label: 'Curve', series: 'curve' }] }],
    assumptions: ['Double-precision evaluation.'], limitations: ['Test document.'],
  };
}
function limitsManifest(): ModelManifest {
  return {
    contract: MODEL_CONTRACT, schemaVersion: MODEL_SCHEMA_VERSION, modelId: 'test.limits', version: '1.0.0',
    title: 'Numerical limits (test)', summary: 'A document whose values overflow and underflow at large k.',
    execution: { kind: 'document', document: limitsDocument() },
    capabilities: [],
    parameters: { k: { label: 'k', description: 'Exponent scale.', dimension: 'dimensionless', unit: 'dimensionless', min: 1, max: 1000, default: 1, step: { ui: 1, admissible: 'continuous' }, role: 'model-input' } },
    quantities: Object.fromEntries(Object.keys(EXPRESSIONS).map(id => [id, scalar(id)])),
    geometry: { curve: { kind: 'polyline2', label: 'Curve', description: 'exp(k·x) sampled.', dimension: 'dimensionless', unit: 'dimensionless', coordinateFrame: 'x horizontal, y vertical', maxElements: 5 } },
    constraints: [],
    interpretation: { coordinateConvention: 'Cartesian.', assumptions: ['Double-precision evaluation.'], limitations: ['Test document.'] },
    limits: { maxGeometryElements: 5, maxOperations: 100000 },
    sources: [],
    referenceSuite: null,
  };
}
const evaluate = (k: number) => evaluateRequest({ manifest: validateManifest(limitsManifest()).manifest, params: { k }, position: { kind: 'static' } }, []);

describe('document executions: numerical limits stay distinguishable (D10, §8.2, A11)', () => {
  it('reports overflow and underflow as numerical limits, never as undefined or as a valid 0', () => {
    const { quantities } = evaluate(800);
    expect(quantities.grow).toMatchObject({ status: 'numerical-limit', code: 'OVERFLOW' });
    expect(quantities.power).toMatchObject({ status: 'numerical-limit', code: 'OVERFLOW' });
    expect(quantities.decay).toMatchObject({ status: 'numerical-limit', code: 'UNDERFLOW' });
    expect(quantities.tiny).toMatchObject({ status: 'numerical-limit', code: 'UNDERFLOW' });
    // A value computed from an underflowed term has an unknown magnitude (exp(−800)·1e300 is about 1e−48, not 0).
    expect(quantities.scaled).toMatchObject({ status: 'numerical-limit', code: 'UNDERFLOW' });
    // A divisor that underflowed is not a division by zero, and the logarithm of a tiny positive number is defined.
    expect(quantities.ratio).toMatchObject({ status: 'numerical-limit', code: 'UNDERFLOW' });
    expect(quantities.logOfTiny).toMatchObject({ status: 'numerical-limit', code: 'UNDERFLOW' });
    // exp(−800)·exp(800): one factor underflowed and the other overflowed; neither becomes a number.
    expect(quantities.product.status).toBe('numerical-limit');
    for (const id of ['grow', 'decay', 'power', 'tiny', 'scaled', 'ratio', 'logOfTiny', 'product']) {
      expect(quantities[id]!.status, id).not.toBe('valid');
      expect(quantities[id]!.status, id).not.toBe('undefined');
      expect((quantities[id] as { reason: string }).reason, id).not.toMatch(/not defined|nonfinite|Division by zero/);
    }
    expect(quantities.ordinary).toEqual({ status: 'valid', value: 1600 });
  });

  it('marks reduced-precision and dropped-term results as valid approximations', () => {
    const { quantities } = evaluate(800);
    // 1 + exp(−800): the dropped term is below half a unit in the last place of 1.
    expect(quantities.offset).toMatchObject({ status: 'valid', value: 1, approximation: { code: 'UNDERFLOW' } });
    // exp(−720) ≈ 1.9e−313 is subnormal: valid, held with reduced precision, not 0.
    expect(quantities.subnormal).toMatchObject({ status: 'valid', approximation: { code: 'UNDERFLOW' } });
    expect((quantities.subnormal as { value: number }).value).toBeGreaterThan(0);
    expect((quantities.subnormal as { value: number }).value).toBeLessThan(2.2250738585072014e-308);
    // Ordinary arguments carry no marker.
    const small = evaluate(2).quantities;
    for (const id of ['grow', 'decay', 'power', 'tiny', 'offset', 'scaled', 'ratio']) expect(small[id], id).toEqual({ status: 'valid', value: expect.any(Number) });
  });

  it('keeps mathematical undefinedness separate from numerical limits', () => {
    const { quantities } = evaluate(800);
    expect(quantities.root).toEqual({ status: 'undefined', code: 'UNDEFINED', reason: 'A negative base with a non-integer exponent is not a real number.' });
    expect(quantities.pole).toEqual({ status: 'undefined', code: 'UNDEFINED', reason: 'Zero raised to a negative power is undefined.' });
    // sqrt(−k) is undefined whatever the overflow of the other term.
    expect(quantities.mixed).toEqual({ status: 'undefined', code: 'UNDEFINED', reason: 'Square root requires a nonnegative argument.' });
  });

  it('draws no sample whose value is a numerical limit and gives the gap the overflow reason', () => {
    const data = evaluate(1000);
    const curve = data.geometry.curve as Extract<GeometryResult, { kind: 'polyline2' }>;
    // x = 0, 0.25, 0.5 are finite (exp(500) < 1.8e308); x = 0.75 and 1 overflow.
    expect(curve.segments.map(segment => segment.points.length)).toEqual([3]);
    expect(curve.gaps).toEqual([{ after: 0, before: null, reason: 'The result is larger than the largest representable number (numerical overflow).' }]);
  });

  it('leaves schema 2.0 frames unchanged: same statuses and values, no marker fields (D1)', () => {
    const frame = evaluateDocument({ document: limitsDocument(), params: { k: 800 }, time: 0 });
    expect(frame.quantities.grow).toEqual({ value: null, status: 'undefined', reason: 'The result is larger than the largest representable number (numerical overflow).' });
    expect(frame.quantities.decay).toEqual({ value: 0, status: 'valid' });
    expect(frame.quantities.scaled).toEqual({ value: 0, status: 'valid' });
    expect(frame.quantities.offset).toEqual({ value: 1, status: 'valid' });
    for (const result of Object.values(frame.quantities)) expect(Object.keys(result).every(key => ['value', 'status', 'reason'].includes(key))).toBe(true);
    for (const result of Object.values(frame.quantities)) if (result.status === 'valid') expect(result.reason).toBeUndefined();
    // Statuses and values are unchanged; only the reason of an undefined value names its cause (documented in
    // docs/declarative-authoring.md): a divisor or logarithm argument that underflowed to 0 is not reported as an exact 0.
    expect(frame.quantities.ratio).toEqual({ value: null, status: 'undefined', reason: NUMERICAL_LIMIT_REASONS.intermediate });
    expect(frame.quantities.logOfTiny).toEqual({ value: null, status: 'undefined', reason: NUMERICAL_LIMIT_REASONS.intermediate });
    expect(frame.quantities.pole).toEqual({ value: null, status: 'undefined', reason: 'Zero raised to a negative power is undefined.' });
  });

  it('carries the statuses through a worker-backed model session', async () => {
    const session = createModelSession({ workerFactory: inlineWorkers([]).factory });
    try {
      await session.load(limitsManifest(), { k: 800 }, { sessionId: session.id, expectedVersion: 0, expectedRunId: null, operationId: 'load-limits' });
      const quantities = session.getState().frame!.quantities;
      expect(quantities.grow).toMatchObject({ status: 'numerical-limit', code: 'OVERFLOW' });
      expect(quantities.decay).toMatchObject({ status: 'numerical-limit', code: 'UNDERFLOW' });
    } finally { session.dispose(); }
  });
});
