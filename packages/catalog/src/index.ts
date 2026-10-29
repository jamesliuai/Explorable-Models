/**
 * Installed, versioned Study Harness catalogue (report §5.2, D3, D16). Discovery exposes only what is bundled here:
 * agent input can never name a path, URL, module or loader. Every reference is computed from content (template and
 * model digests are hashes of the installed data, never hand-written). Lifecycle status is resolved from the
 * installed reference suite and from host-supplied review records, revocations and deprecations only; review claims
 * embedded in any imported data are ignored. No entry here has an independent human review.
 */
export * from './registry.js';
export type { CatalogIdentity, CatalogProblem, InstalledCatalog, InstalledCatalogOptions, LazyInstalledCatalog, KernelIdentity } from './catalog.js';
export type { InstalledContent } from './content/types.js';
export type { IndexedModelEntry, IndexedTemplateEntry, InstalledIndex } from './index-types.js';
/** Eager catalogue: all installed content and kernels in memory (tooling, tests, hosts that need every template at once). */
export { createInstalledCatalog } from './installed.js';
/** On-demand catalogue for learner pages: installed index eagerly, each template's content on `load()`, no kernels in the page. */
export { createLazyCatalog } from './lazy.js';
export { INSTALLED_INDEX } from './installed-index.js';
export { INSTALLED_KERNELS } from './kernels/index.js';
export { INSTALLED_KERNEL_SOURCE } from './kernels/loaders.js';
export {
  FUNCTION_DERIVATIVE_REFERENCE_SUITE_DIGEST, INSTALLED_MODELS, LINEAR_REFERENCE_SUITE_DIGEST, QUADRATIC_REFERENCE_SUITE_DIGEST,
  SURFACE_GRADIENT_REFERENCE_SUITE_DIGEST, VECTOR_ORIENTATION_REFERENCE_SUITE_DIGEST, functionDerivativeManifest, linearTransformationManifest,
  quadraticGradientDescentManifest, quadraticSurfaceGradientManifest, vectorOrientationManifest,
} from './models/index.js';
export {
  INSTALLED_TEMPLATES, functionDerivativeTemplate, linearTransformationTemplate, quadraticGradientDescentTemplate, quadraticSurfaceGradientTemplate,
  vectorOrientationTemplate,
} from './templates/index.js';
export { FUNCTION_DERIVATIVE_COPY } from './copy/function-derivative.js';
export { LINEAR_COPY } from './copy/linear-transformation.js';
export { QUADRATIC_COPY } from './copy/quadratic-gradient-descent.js';
export { SURFACE_GRADIENT_COPY } from './copy/quadratic-surface-gradient.js';
export { VECTOR_ORIENTATION_COPY } from './copy/vector-orientation-3d.js';
export {
  QUADRATIC_DOMAIN, QUADRATIC_KERNEL_ID, QUADRATIC_KERNEL_VERSION, QUADRATIC_MAX_INDEX, QUADRATIC_REGIMES, classifyRegime, evaluateQuadraticGradientDescent,
  quadraticGradientDescentKernel, type QuadraticRegime,
} from './kernels/quadratic-gradient-descent.js';
export {
  FUNCTION_DERIVATIVE_CURVATURES, FUNCTION_DERIVATIVE_CURVE, FUNCTION_DERIVATIVE_DOMAIN, FUNCTION_DERIVATIVE_KERNEL_ID, FUNCTION_DERIVATIVE_KERNEL_VERSION,
  FUNCTION_DERIVATIVE_SLOPE_SIGNS, classifyCurvature, evaluateFunctionDerivative, functionDerivativeKernel, type CurvatureClass, type SlopeSign,
} from './kernels/function-derivative.js';
export {
  LINEAR_DOMAIN, LINEAR_EIGEN_CATEGORIES, LINEAR_EIGEN_LINE_HALF_LENGTH, LINEAR_GRID, LINEAR_KERNEL_ID, LINEAR_KERNEL_VERSION, LINEAR_MATRIX_PARAMETERS,
  LINEAR_ORIENTATIONS, LINEAR_UNDEFINED, LINEAR_VECTOR_PARAMETERS, evaluateLinearTransformation, linearTransformationKernel, orientationOf,
  type LinearEigenCategory, type LinearOrientation,
} from './kernels/linear-transformation.js';
export {
  ANGLE_ARC, RELATIONSHIP_TOLERANCE, VECTOR_ORIENTATION_DOMAIN, VECTOR_ORIENTATION_KERNEL_ID, VECTOR_ORIENTATION_KERNEL_VERSION, VECTOR_ORIENTATION_PARAMETERS,
  VECTOR_RELATIONSHIPS, evaluateVectorOrientation, vectorOrientationKernel, type VectorParameter, type VectorRelationship,
} from './kernels/vector-orientation-3d.js';
export {
  ARROW_MAX_LENGTH, ARROW_SCALES, CONTOUR_LEVELS, CONTOUR_SAMPLES, FIELD_GRID, SECTION_SAMPLES, SURFACE_GRADIENT_DOMAIN, SURFACE_GRADIENT_KERNEL_ID,
  SURFACE_GRADIENT_KERNEL_VERSION, SURFACE_GRADIENT_PARAMETERS, SURFACE_GRID, arrowDisclosure, evaluateQuadraticSurfaceGradient, quadraticSurfaceGradientKernel,
} from './kernels/quadratic-surface-gradient.js';

