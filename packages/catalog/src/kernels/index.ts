/**
 * Installed pure kernels. This module imports no templates, copy or manifests so the worker entry stays small.
 * New activity packages append their kernel here.
 */
import type { ModelKernel } from '@explorable-models/core/model';
import { functionDerivativeKernel } from './function-derivative.js';
import { linearTransformationKernel } from './linear-transformation.js';
import { quadraticGradientDescentKernel } from './quadratic-gradient-descent.js';
import { quadraticSurfaceGradientKernel } from './quadratic-surface-gradient.js';
import { vectorOrientationKernel } from './vector-orientation-3d.js';

export * from './function-derivative.js';
export * from './linear-transformation.js';
export * from './quadratic-gradient-descent.js';
export * from './quadratic-surface-gradient.js';
export * from './vector-orientation-3d.js';
export const INSTALLED_KERNELS: readonly ModelKernel[] = Object.freeze([
  quadraticGradientDescentKernel, functionDerivativeKernel, linearTransformationKernel, vectorOrientationKernel, quadraticSurfaceGradientKernel,
]);
