/** Installed model manifests (deep-frozen data). New activity packages append their manifest here. */
import { deepFreeze } from '@experiment-kit/core';
import type { ModelManifest } from '@experiment-kit/core/model';
import { functionDerivativeManifest } from './function-derivative.js';
import { linearTransformationManifest } from './linear-transformation.js';
import { quadraticGradientDescentManifest } from './quadratic-gradient-descent.js';
import { quadraticSurfaceGradientManifest } from './quadratic-surface-gradient.js';
import { vectorOrientationManifest } from './vector-orientation-3d.js';

export { FUNCTION_DERIVATIVE_REFERENCE_SUITE_DIGEST, functionDerivativeManifest } from './function-derivative.js';
export { LINEAR_REFERENCE_SUITE_DIGEST, linearTransformationManifest } from './linear-transformation.js';
export { QUADRATIC_REFERENCE_SUITE_DIGEST, quadraticGradientDescentManifest } from './quadratic-gradient-descent.js';
export { SURFACE_GRADIENT_REFERENCE_SUITE_DIGEST, quadraticSurfaceGradientManifest } from './quadratic-surface-gradient.js';
export { VECTOR_ORIENTATION_REFERENCE_SUITE_DIGEST, vectorOrientationManifest } from './vector-orientation-3d.js';
export const INSTALLED_MODELS: readonly ModelManifest[] = deepFreeze([
  quadraticGradientDescentManifest, functionDerivativeManifest, linearTransformationManifest, vectorOrientationManifest, quadraticSurfaceGradientManifest,
]);
