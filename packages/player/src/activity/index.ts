/**
 * `@experiment-kit/player/activity`: the Study Harness learner surface and `createStudyHarnessVisualizer` (the six report
 * operations around the activity adapter). This entry renders authorized
 * `LearnerProjection`s from an `ActivityBinding` only. It does not import Three.js, `@experiment-kit/player-3d`, the
 * studio/gallery, Playwright, CLI or provider SDKs; KaTeX is reached only through the default lazy `mathLoader`, and
 * the spatial renderer only through a host-supplied `spatialLoader`.
 */
export { StudyActivitySurface } from './StudyActivitySurface.js';
export { mountStudyActivity } from './mount.js';
export { mountStudyActivityPlaceholder, StudyActivityPlaceholder } from './Placeholder.js';
export type { MountedStudyActivityPlaceholder, StudyActivityPlaceholderProps } from './Placeholder.js';
export { ArchivalRecord, archivalLabels, mountArchivalRecord } from './archival.js';
export type { ArchivalLabels, ArchivalRecordProps, MountedArchivalRecord } from './archival.js';
export type { MountedStudyActivity, MountStudyActivityOptions } from './mount.js';
export { createStudyHarnessVisualizer, VisualizerError } from './visualizer.js';
export type {
  StudyHarnessSurface, StudyHarnessVisualizer, StudyHarnessVisualizerOptions, SurfaceDefaults, SurfaceErrorEvent, SurfaceErrorState, SurfaceMounter,
  VisualizerSurfaceOptions,
} from './visualizer.js';
export type { NextAction, StudyActivityHandle, StudyActivitySurfaceProps, SurfaceDiagnostic, SurfaceDiagnosticCode } from './types.js';
export { ACTIVITY_STYLESHEET, adoptActivityStyles } from './styles.js';
export {
  BUNDLED_FONT_STACK, COLOR_TOKENS, CONTRAST_RULES, contrastRatio, DARK_TOKENS, DEFAULT_TOKENS, LIGHT_TOKENS, parseColor, resolveTheme, ROLE_TOKENS,
  SYSTEM_FONT_STACK, tokenVariables,
} from './theme.js';
export type { ColorToken, RejectedToken, ResolvedTheme, ThemeMode, ThemePreference, ThemeTokens } from './theme.js';
export { MATH_LIMITS, prepareMath, REJECTED_TEX_COMMANDS, renderMathInto } from './math.js';
export type { KatexModule, KatexRenderOptions, MathCheck, MathRender } from './math.js';
export { CAPTURE_LIMITS, CaptureError, captureRejection, captureSize, companionText } from './capture.js';
export type { CaptureErrorCode, CaptureMetadata, CaptureOptions, CaptureResult } from './capture.js';
export type {
  SpatialMountOptions, SpatialPresentation, SpatialRendererInstance, SpatialRendererModule, SpatialRendererStats, SpatialStatus,
} from './spatial-contract.js';
export { PROJECTION_PLANES, projectView, coordinateRows, coordinateTable, COORDINATE_ROW_LIMIT } from './project3d.js';
export type { ProjectionPlane, CoordinateRow, CoordinateTable } from './project3d.js';
export { formatPosition, formatTick, valueDisplay } from './format.js';
export { niceTicks, CAMERA_LIMITS } from './scale.js';
export { placeLabels } from './labels.js';
export type { LabelDiagnostic, LabelDiagnosticCode, PlacedLabel, LabelRequest } from './labels.js';
export { BAR_WIDTH, barWidthPx, comparisonGlyph, comparisonMarks, mergeCoincidentLabels, planScene, ZERO_VECTOR_LABEL } from './plan.js';
export type { ScenePlan, SceneNote, ClippedMark } from './plan.js';
