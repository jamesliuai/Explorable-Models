import type { AnalyticModel, ScalarParams } from '@explorable-models/core';

export type LinearMapParameters = ScalarParams & {
  a: number; b: number; c: number; d: number; x: number; y: number;
};

export const defaults: LinearMapParameters = { a: 1, b: 1, c: 0, d: 1, x: 1, y: 1 };
export const presets = {
  identity: { a: 1, b: 0, c: 0, d: 1 },
  scaling: { a: 2, b: 0, c: 0, d: 3 },
  shear: { a: 1, b: 2, c: 0, d: 1 },
  reflection: { a: -1, b: 0, c: 0, d: 1 },
  rotation: { a: 0, b: -1, c: 1, d: 0 },
  singular: { a: 1, b: 2, c: 1.5, d: 3 },
} as const;
const valid = (value: number | readonly number[]) => ({ value, status: 'valid' as const });

/** Column vectors, row-major matrix storage: [a,b,c,d]. No physical clock. */
export const model: AnalyticModel<LinearMapParameters> = {
  kind: 'parametric',
  evaluate({ params: { a, b, c, d, x, y } }) {
    const determinant = a * d - b * c;
    const output = [a * x + b * y, c * x + d * y];
    return {
      quantities: {
        'matrix.entries': valid([a, b, c, d]),
        'matrix.determinant': valid(determinant),
        'matrix.area': valid(Math.abs(determinant)),
        'matrix.orientation': valid(Math.sign(determinant)),
        'basis.i': valid([a, c]),
        'basis.j': valid([b, d]),
        'point.input': valid([x, y]),
        'point.output': valid(output),
        'point.outputX': valid(output[0]),
        'point.outputY': valid(output[1]),
      },
      geometry: {
        referenceSquare: [0, 0, 1, 0, 1, 1, 0, 1, 0, 0],
        transformedSquare: [0, 0, a, c, a + b, c + d, b, d, 0, 0],
      },
    };
  },
};

export default model;
