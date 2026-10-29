/**
 * Author checks for the scaffold example. They run in the browser checks worker (explorable-models activity check), each
 * with a context whose `evaluate(params, position?)` merges `params` over the defaults and evaluates through the same
 * worker-side validation as the runtime. Return `true` to pass, or a string/false/{ passed: false, detail } to fail.
 * Author checks are the author's own assertions; independent reference fixtures belong in fixtures/reference.json or
 * outside the package.
 */
import type { QuantityResult } from '@explorable-models/core/model';

interface Frame { ok: boolean; quantities?: Record<string, QuantityResult> }
interface CheckContext { defaults(): Record<string, number>; evaluate(params?: Record<string, number>): Frame }
const value = (frame: Frame, id: string): unknown => { const result = frame.quantities?.[id]; return result?.status === 'valid' ? result.value : undefined; };

export const checks = [
  {
    id: 'probe-on-line',
    description: 'At the defaults the probe value equals m·p + b.',
    run(context: CheckContext) {
      const d = context.defaults();
      return value(context.evaluate(), 'probe.value') === d.m! * d.p! + d.b! || 'probe.value differs from m·p + b';
    },
  },
  {
    id: 'root-zeroes-the-line',
    description: 'For m = 2 and b = −3 the root is 1.5 and the line is 0 there.',
    run(context: CheckContext) {
      const frame = context.evaluate({ m: 2, b: -3, p: 1.5 });
      return (value(frame, 'root') === 1.5 && value(frame, 'probe.value') === 0) || 'the reported root does not zero the line';
    },
  },
  {
    id: 'flat-line-root-undefined',
    description: 'With slope 0 the root is an undefined status, never a fabricated 0.',
    run(context: CheckContext) {
      const result = context.evaluate({ m: 0, b: 1 }).quantities?.root;
      return result?.status === 'undefined' || `root is ${result?.status ?? 'missing'}`;
    },
  },
];
