/**
 * Model contract 1.0: installed models, identified frames and guarded model state.
 * Independent of DOM and React. Requests select installed kernels by ID/version and never carry source.
 */
import type { Diagnostic, VisualizationDocument } from '../declarative/types.js';

export const MODEL_CONTRACT = 'experiment-kit.model-manifest' as const;
export const MODEL_SCHEMA_VERSION = '1.0' as const;

/** Units supported for the bundled activities only; this is not a universal unit engine. */
export type UnitId = 'dimensionless' | 'iteration' | 'm' | 'cm' | 'mm' | 's' | 'ms' | 'kg' | 'g' | 'm/s^2' | 'N' | 'rad' | 'deg';
export type DimensionId = 'dimensionless' | 'iteration' | 'length' | 'time' | 'mass' | 'acceleration' | 'force' | 'angle';

export interface ModelRef { modelId: string; version: string; digest: string }
export interface CapabilityRef { id: string; version: string }

export interface ParameterStep {
  /** UI increment only. */
  ui: number;
  /** Scientific admissibility. `continuous` means intermediate exact values are valid experiments. */
  admissible: 'continuous' | 'integer' | { multipleOf: number };
}
export interface ModelParameterDefinition {
  /**
   * Learner-visible name. Its wording (`labelWording`) is part of the scientific identity; only its exact spelling —
   * spacing, quotation-mark style, Unicode composition, compound hyphenation — is presentation (report §8.3). The same
   * holds for every quantity, geometry, dataset and column label and for the title.
   */
  label: string;
  /**
   * Short TeX-safe symbol such as `\\eta`. Part of the scientific identity, like the description and the wording of the
   * label (see `labelWording` in ./identity.ts): it names the parameter in learner equations and comparisons.
   */
  symbol?: string;
  description: string;
  dimension: DimensionId;
  /** Canonical unit used for evaluation, storage and events. */
  unit: UnitId;
  min: number;
  max: number;
  default: number;
  step: ParameterStep;
  role: 'model-input';
}

export type QuantityShape =
  | { kind: 'scalar' }
  | { kind: 'vector'; length: number }
  | { kind: 'matrix'; rows: number; columns: number }
  | { kind: 'category'; values: string[] };

export interface ModelQuantityDefinition {
  /** The learner's readout name; its wording is scientific identity, its exact spelling presentation (`labelWording`). */
  label: string;
  symbol?: string;
  shape: QuantityShape;
  dimension: DimensionId;
  unit: UnitId;
  /** Scientific meaning; part of interpretation identity. */
  meaning: string;
  coordinateFrame?: string;
  signConvention?: string;
}

/**
 * Geometry kinds. `observations2` is observed data (report §8.5): the rows of a manifest observation dataset, attached
 * to every frame by the runtime from the manifest (never computed by a kernel or document, never joined, interpolated
 * or fitted). Every other kind is model output.
 */
export type GeometryKind = 'polyline2' | 'points2' | 'segments2' | 'polygon2' | 'polyline3' | 'points3' | 'segments3' | 'surface-grid' | 'vector-field2' | 'vector-field3' | 'observations2';
export interface ModelGeometryDefinition {
  kind: GeometryKind;
  label: string;
  description: string;
  dimension: DimensionId;
  unit: UnitId;
  coordinateFrame: string;
  /** Maximum points/vertices/samples for this geometry; enforced on every frame. */
  maxElements: number;
  /**
   * Required for `observations2` and absent otherwise (additive in 1.0): the observation dataset (`observations` key)
   * and its two columns this geometry plots, horizontal `x` then vertical `y`. `dimension` and `unit` are the `y`
   * column's; the `x` column declares its own.
   */
  observations?: { dataset: string; x: string; y: string };
  /**
   * Canonical unit of each coordinate of the geometry's points (additive in 1.0; report §8.3, A10, A34): `x` and `y`,
   * and `z` for the 3D kinds and `surface-grid`. Absent, every coordinate is in `unit` (an `observations2` geometry
   * takes its x and y columns' units). `dimension`/`unit` are always those of the dependent coordinate — `y` of a 2D
   * kind, `z` of a 3D kind or surface grid — so a geometry whose horizontal coordinate has another unit (an iteration
   * index, a time) declares it here. Template axes that draw this geometry must name exactly these units: coordinates
   * are drawn in canonical units and never converted. Part of the scientific identity.
   */
  coordinates?: GeometryCoordinates;
}
/** Canonical units of a geometry's coordinates (see {@link ModelGeometryDefinition.coordinates}). */
export interface GeometryCoordinates { x: UnitId; y: UnitId; z?: UnitId }

/** One column of an observed dataset: its canonical unit, dimension and scientific meaning. */
export interface ObservationColumn { id: string; label: string; dimension: DimensionId; unit: UnitId; meaning: string }
/** Where observed rows come from (report §8.5). */
export interface ObservationProvenance {
  /** ID of the manifest `sources` entry (kind `dataset`) that cites the data. */
  sourceId: string;
  /** How the rows were obtained: instrument or procedure, selection, and any transcription, rounding or cleaning. */
  description: string;
  /** Licence or terms of use of the data, when known. */
  license?: string;
}
/** Reason for one missing cell: zero-based row index and column ID. */
export interface MissingCell { row: number; column: string; reason: string }
/**
 * Bounded, immutable observed dataset (report §8.5; additive in manifest 1.0). Rows are data, not model output: a
 * `null` cell is missing and is shown as missing with its reason, never as 0, and is never interpolated, smoothed or
 * fitted. Every cell, unit, meaning, reason and the provenance belong to the model's scientific identity.
 */
export interface ObservationDataset {
  label: string;
  description: string;
  columns: ObservationColumn[];
  /** One cell per column in column order; `null` marks a missing cell. */
  rows: (number | null)[][];
  /** Reasons for individual missing cells (each entry names a `null` cell, at most once). */
  missing?: MissingCell[];
  /** Reason for every missing cell without an entry in `missing`; required when such a cell exists. */
  missingReason?: string;
  provenance: ObservationProvenance;
}

/** Coupled parameter rule evaluated with the bounded expression interpreter (data, not code). */
export interface ModelConstraint {
  id: string;
  /** Bounded expression over parameter IDs (schema 2.0 expression grammar). */
  expression: string;
  min?: number;
  max?: number;
  minInclusive?: boolean;
  maxInclusive?: boolean;
  /** Learner-safe message; never reveals hidden outputs. */
  message: string;
  recovery: string;
}

export type ModelExecution =
  | { kind: 'kernel'; kernelId: string; kernelVersion: string; mode: 'discrete'; maxIndex: number }
  | { kind: 'kernel'; kernelId: string; kernelVersion: string; mode: 'static' }
  | { kind: 'document'; document: VisualizationDocument };

export interface ModelInterpretation {
  coordinateConvention: string;
  angleConvention?: string;
  handedness?: 'right' | 'left';
  assumptions: string[];
  limitations: string[];
}

export interface ModelSource { id: string; kind: 'derivation' | 'textbook' | 'specification' | 'dataset'; citation: string }

export interface ModelManifest {
  contract: typeof MODEL_CONTRACT;
  schemaVersion: typeof MODEL_SCHEMA_VERSION;
  modelId: string;
  version: string;
  title: string;
  summary: string;
  execution: ModelExecution;
  capabilities: CapabilityRef[];
  parameters: Record<string, ModelParameterDefinition>;
  quantities: Record<string, ModelQuantityDefinition>;
  geometry: Record<string, ModelGeometryDefinition>;
  constraints: ModelConstraint[];
  interpretation: ModelInterpretation;
  limits: { maxIndex?: number; maxGeometryElements: number; maxOperations: number };
  sources: ModelSource[];
  referenceSuite: { suiteId: string; digest: string } | null;
  /** Observed datasets keyed by ID (additive in 1.0; report §8.5). Plotted only through `observations2` geometry. */
  observations?: Record<string, ObservationDataset>;
  /** Declared evaluation behaviour (additive in 1.0; report §8.1). Installed catalogue manifests always declare it. */
  evaluation?: ModelEvaluationBehavior;
}

/**
 * How a model evaluates (report §8.1: "checkpoint requirements and deterministic evaluation behavior"). Part of the
 * scientific identity.
 *
 * - `determinism: 'bitwise'`: every output value is determined by operations whose results ECMAScript specifies
 *   exactly (Number +, −, ×, ÷ and comparisons with IEEE-754 round-to-nearest, the correctly rounded Math.sqrt,
 *   BigInt arithmetic, Math.abs, floor, ceil, sign, min, max, clz32, bit-level DataView reads), so identical inputs give
 *   identical bits on every conforming engine. `'within-engine'`: some outputs use functions ECMAScript lets each engine
 *   approximate (Math.sin, Math.cos, Math.atan2, Math.hypot, Math.log2, Number `**`, …), so identical inputs give identical bits within one engine
 *   build and may differ in the last bits between engines. A function used only to steer a search whose result is then
 *   verified exactly does not make the outputs engine-dependent.
 * - `checkpoint: 'none'`: the model keeps no state between evaluations; a frame is a pure function of the parameters
 *   and the position (a discrete position is recomputed from index 0 within the declared work bound), so restore
 *   re-evaluates the saved position and no evaluation state is ever checkpointed.
 */
export interface ModelEvaluationBehavior { determinism: 'bitwise' | 'within-engine'; checkpoint: 'none' }

/** Identity split: exact bytes, scientific interpretation, and harmless presentation metadata. */
export interface ModelIdentity { digest: string; scientificRevision: string; presentationRevision: string }

export type QuantityValue = number | number[] | string;
export type QuantityResult =
  | { status: 'valid'; value: QuantityValue; approximation?: { code: 'UNDERFLOW' | 'ROUNDING'; reason: string } }
  | { status: 'undefined'; code: string; reason: string }
  | { status: 'numerical-limit'; code: 'OVERFLOW' | 'UNDERFLOW' | 'ITERATION_LIMIT'; reason: string; lastFiniteIndex?: number };

export type Vec2 = [number, number];
export type Vec3 = [number, number, number];
export type Endpoint = 'open' | 'closed' | 'none';
export interface PolylineSegment<V> { points: V[]; start: Endpoint; end: Endpoint }
/** Missing span between polyline segments: `after`/`before` are the indices of the neighbouring segments (null at an end). */
export interface GeometryGap { after: number | null; before: number | null; reason: string }

export type GeometryResult =
  /** `sampling`: `samples` evenly spaced values of the curve's sampling variable over `domain` (x, or a document series' variable). */
  | { kind: 'polyline2'; segments: PolylineSegment<Vec2>[]; gaps: GeometryGap[]; sampling?: { samples: number; domain: [number, number] } }
  | { kind: 'points2'; points: { id: string; at: Vec2 | null; reason?: string }[] }
  | { kind: 'segments2'; segments: { id: string; from: Vec2; to: Vec2 }[] }
  | { kind: 'polygon2'; vertices: Vec2[]; degenerate: boolean }
  | { kind: 'polyline3'; segments: PolylineSegment<Vec3>[]; gaps: GeometryGap[] }
  | { kind: 'points3'; points: { id: string; at: Vec3 | null; reason?: string }[] }
  | { kind: 'segments3'; segments: { id: string; from: Vec3; to: Vec3 }[] }
  | { kind: 'surface-grid'; xs: number[]; ys: number[]; z: (number | null)[]; sampling: { nx: number; ny: number; domain: [number, number, number, number] } }
  | { kind: 'vector-field2'; samples: { at: Vec2; vector: Vec2 }[]; scale: { factor: number; disclosure: string } }
  | { kind: 'vector-field3'; samples: { at: Vec3; vector: Vec3 }[]; scale: { factor: number; disclosure: string } }
  | ObservationGeometry;

/** One observed row: its zero-based index, the x and y cells (`null` = missing) and, when a cell is missing, why. */
export interface ObservationPoint { row: number; values: [number | null, number | null]; reason?: string }
/**
 * Observed data in a frame (report §8.5): every row of the dataset in order, with its provenance. The runtime builds
 * it from the manifest, and the main thread checks every worker reply against the manifest, so it is identical in
 * every frame of the model.
 */
export interface ObservationGeometry {
  kind: 'observations2';
  dataset: string;
  /** The plotted column IDs, x then y. */
  columns: [string, string];
  provenance: { sourceId: string; citation: string; description: string; license?: string };
  points: ObservationPoint[];
}

export type FramePosition =
  | { kind: 'static' }
  | { kind: 'index'; index: number; maxIndex: number }
  | { kind: 'time'; time: number; endTime: number | null };
export type PositionRequest = { kind: 'static' } | { kind: 'index'; index: number } | { kind: 'time'; time: number };

export type FrameRun =
  | { kind: 'committed'; runId: string }
  | { kind: 'tentative'; previewId: string; baseRunId: string }
  | { kind: 'sample'; sampleId: string };

export interface FrameTerminal { reached: boolean; event?: 'max-index' | 'numerical-limit' | 'end-time'; detail?: string }

/** One identified evaluation. Every visible scientific representation must come from one frame. */
export interface ModelFrame {
  frameId: string;
  model: ModelRef;
  run: FrameRun;
  /** Canonical-unit parameter values used for this evaluation. */
  params: Record<string, number>;
  position: FramePosition;
  terminal: FrameTerminal;
  quantities: Record<string, QuantityResult>;
  geometry: Record<string, GeometryResult>;
}

/** Kernel output before the runtime attaches identity. */
export interface KernelOutput {
  quantities: Record<string, QuantityResult>;
  geometry: Record<string, GeometryResult>;
  terminal?: FrameTerminal;
}
export interface KernelInput { params: Readonly<Record<string, number>>; index: number }
/** Trusted, installed, pure kernel. Executes in a browser worker in production. */
export interface ModelKernel {
  id: string;
  version: string;
  mode: 'discrete' | 'static';
  evaluate(input: KernelInput): KernelOutput;
}

export interface ModelEvaluationRequest { manifest: ModelManifest; params: Record<string, number>; position: PositionRequest }
export interface ModelEvaluator {
  evaluate(request: ModelEvaluationRequest, signal?: AbortSignal): Promise<Omit<ModelFrame, 'frameId' | 'run' | 'model'>>;
  dispose(): void;
  readonly disposed: boolean;
}

export interface ModelGuard { sessionId: string; expectedVersion: number; expectedRunId: string | null; operationId: string }

export interface ModelRunState {
  id: string;
  params: Record<string, number>;
  position: FramePosition;
  restoredFrom?: string;
  /** Operation that created the run (commit, reset, scenario, restore, undo). */
  cause: 'initial' | 'commit' | 'reset' | 'scenario' | 'restore' | 'undo';
}
export interface ModelPreviewState {
  previewId: string;
  epoch: number;
  params: Record<string, number>;
  status: 'evaluating' | 'ready' | 'failed';
  frame: ModelFrame | null;
  error: Diagnostic | null;
}
export interface RetainedComparison { runId: string; label: string; params: Record<string, number>; position: FramePosition; frame: ModelFrame }

export interface ModelSessionState {
  sessionId: string;
  status: 'empty' | 'ready' | 'suspended' | 'disposed';
  model: ModelRef | null;
  identity: ModelIdentity | null;
  /** Scientific mutation version; playback ticks do not advance it. */
  version: number;
  run: ModelRunState | null;
  frame: ModelFrame | null;
  preview: ModelPreviewState | null;
  playing: boolean;
  comparisons: RetainedComparison[];
  /** True when the last operation failed and the shown frame is the last accepted one. */
  stale: boolean;
  error: Diagnostic[] | null;
}

export interface SampleRequest { manifest: ModelManifest; params: Record<string, number>; positions: PositionRequest[] }
export interface SampleResult { sampleId: string; model: ModelRef; identity: ModelIdentity; frames: ModelFrame[] }

export interface ModelSessionEvent {
  type: 'ready' | 'change' | 'preview' | 'error' | 'suspended' | 'resumed' | 'disposed';
  state: ModelSessionState;
  operationId?: string;
}

/**
 * Options of one `play` call. By default playback stops one position before a frame at a numerical limit (the session
 * error is NUMERICAL_LIMIT; the limit frame stays reachable by navigation), and play from a frame at a limit is refused
 * with OUT_OF_DOMAIN. `throughNumericalLimit` is asked about each such frame — the next one a tick reaches, and the shown
 * frame when play starts at one: `true` advances onto it and plays on to the position's own end (the last index or the
 * end time) as for any other frame; `false`, a non-boolean or a throw keeps the default. A caller whose display does not
 * show the limit uses it so that where playback stops does not reveal the limit (activity disclosure, report §6.2).
 */
export interface ModelPlaybackOptions {
  throughNumericalLimit?: (frame: ModelFrame) => boolean;
}

export interface ModelSession {
  readonly id: string;
  getState(): ModelSessionState;
  subscribe(listener: (event: ModelSessionEvent) => void): () => void;
  /** Load a manifest and start the initial run (index/time zero). */
  load(manifest: ModelManifest, params: Record<string, number> | null, guard: ModelGuard, signal?: AbortSignal): Promise<ModelSessionState>;
  /** Commit scientific parameters: new run at index/time zero; previous run retained in history. */
  commitParameters(params: Record<string, number>, guard: ModelGuard, cause?: ModelRunState['cause'], signal?: AbortSignal): Promise<ModelSessionState>;
  /** Tentative evaluation coalesced to one active request plus one newest queued value. */
  previewParameters(previewId: string, params: Record<string, number>, guard: ModelGuard): Promise<ModelPreviewState | null>;
  cancelPreview(guard: ModelGuard): void;
  navigate(position: PositionRequest, guard: ModelGuard, signal?: AbortSignal): Promise<ModelSessionState>;
  /** Starts playback from the shown frame; `options` decide whether it crosses a numerical limit ({@link ModelPlaybackOptions}). */
  play(guard: ModelGuard, options?: ModelPlaybackOptions): void;
  pause(guard: ModelGuard): void;
  retainComparison(label: string, guard: ModelGuard): void;
  removeComparison(runId: string, guard: ModelGuard): void;
  /** Isolated: never mutates run, preview, playback, selection or version. */
  sample(request: Omit<SampleRequest, 'manifest'>, signal?: AbortSignal): Promise<SampleResult>;
  restore(snapshot: { params: Record<string, number>; position: PositionRequest; restoredFrom: string }, guard: ModelGuard, signal?: AbortSignal): Promise<ModelSessionState>;
  suspend(): void;
  resume(): void;
  dispose(): void;
}
