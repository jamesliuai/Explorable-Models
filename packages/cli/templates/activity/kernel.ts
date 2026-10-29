/**
 * Authored pure kernel for the scaffold example: y = m·x + b, its value at a probe position and its root.
 *
 * Authoring rules (explorable-models activity check enforces them): import only relative .ts/.json files of this package
 * and types from @explorable-models/core/model; export `kernel`; keep evaluation pure and deterministic. The kernel runs
 * only in a browser module worker, never in the CLI process. Undefined values are statuses with a reason, never 0.
 */
import type { KernelInput, KernelOutput, ModelKernel, QuantityResult } from '@explorable-models/core/model';
import model from './model.json';

const X_RANGE = [-5, 5] as const;
const valid = (value: number): QuantityResult => ({ status: 'valid', value: value === 0 ? 0 : value });

function evaluate({ params }: KernelInput): KernelOutput {
  const m = params.m!, b = params.b!, p = params.p!;
  const at = (x: number): number => m * x + b;
  const root: QuantityResult = m !== 0 ? valid(-b / m)
    : b === 0 ? { status: 'undefined', code: 'EVERY_X_IS_A_ROOT', reason: 'With slope 0 and intercept 0 the line is y = 0, so every x is a root.' }
      : { status: 'undefined', code: 'NO_ROOT', reason: 'With slope 0 and a nonzero intercept the line never crosses y = 0.' };
  return {
    quantities: { 'probe.x': valid(p), 'probe.value': valid(at(p)), slope: valid(m), intercept: valid(b), root },
    geometry: {
      line: { kind: 'polyline2', segments: [{ points: [[X_RANGE[0], at(X_RANGE[0])], [X_RANGE[1], at(X_RANGE[1])]], start: 'none', end: 'none' }], gaps: [] },
      'probe-point': { kind: 'points2', points: [{ id: 'probe', at: [p, at(p)] }] },
      'root-point': { kind: 'points2', points: [root.status === 'valid' ? { id: 'root', at: [root.value as number, 0] } : { id: 'root', at: null, reason: root.reason }] },
    },
  };
}

export const kernel: ModelKernel = Object.freeze({ id: model.execution.kernelId, version: model.execution.kernelVersion, mode: 'static', evaluate });
