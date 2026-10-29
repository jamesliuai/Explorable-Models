/** Installed activity templates (deep-frozen data). New activity packages append their template here. */
import type { ActivityTemplate } from '@experiment-kit/activity';
import { deepFreeze } from '@experiment-kit/core';
import { functionDerivativeTemplate } from './function-derivative.js';
import { linearTransformationTemplate } from './linear-transformation.js';
import { quadraticGradientDescentTemplate } from './quadratic-gradient-descent.js';
import { quadraticSurfaceGradientTemplate } from './quadratic-surface-gradient.js';
import { vectorOrientationTemplate } from './vector-orientation-3d.js';

export { functionDerivativeTemplate } from './function-derivative.js';
export { linearTransformationTemplate } from './linear-transformation.js';
export { quadraticGradientDescentTemplate } from './quadratic-gradient-descent.js';
export { quadraticSurfaceGradientTemplate } from './quadratic-surface-gradient.js';
export { vectorOrientationTemplate } from './vector-orientation-3d.js';
export const INSTALLED_TEMPLATES: readonly ActivityTemplate[] = deepFreeze([
  quadraticGradientDescentTemplate, functionDerivativeTemplate, linearTransformationTemplate, vectorOrientationTemplate, quadraticSurfaceGradientTemplate,
]);
