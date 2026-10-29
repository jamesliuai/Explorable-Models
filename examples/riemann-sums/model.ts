import type { AnalyticModel, ScalarParams } from '@explorable-models/core';

export type RiemannParameters = ScalarParams & { count: number; rule: 'right' | 'midpoint'; integrand: 'square' | 'signed' };
export const defaults: RiemannParameters = { count: 20, rule: 'midpoint', integrand: 'square' };
const valid = (value: number | readonly number[]) => ({ value, status: 'valid' as const });

/** Finite summation evaluates the integrand; fixtures use independent closed forms. */
export const model: AnalyticModel<RiemannParameters> = {
  kind: 'parametric',
  evaluate({ params: { count, rule, integrand } }) {
    const start = integrand === 'square' ? 0 : -1;
    const width = (1 - start) / count;
    const rectangles: number[] = [];
    let estimate = 0;
    let unsignedEstimate = 0;
    for (let index = 0; index < count; index++) {
      const left = start + index * width;
      const sampleX = left + (rule === 'midpoint' ? 0.5 : 1) * width;
      const height = integrand === 'square' ? sampleX * sampleX : sampleX;
      estimate += height * width;
      unsignedEstimate += Math.abs(height) * width;
      rectangles.push(left, 0, left, height, left + width, height, left + width, 0);
    }
    const exact = integrand === 'square' ? 1 / 3 : 0;
    const curve: number[] = [];
    for (let index = 0; index <= 100; index++) {
      const x = start + (1 - start) * index / 100;
      curve.push(x, integrand === 'square' ? x * x : x);
    }
    return {
      quantities: {
        'sum.estimate': valid(estimate), 'sum.exact': valid(exact),
        'sum.error': valid(estimate - exact), 'sum.unsignedEstimate': valid(unsignedEstimate),
        'sum.unsignedExact': valid(integrand === 'square' ? 1 / 3 : 1), 'sum.width': valid(width),
      },
      geometry: { rectangles, curve },
    };
  },
};

export default model;
