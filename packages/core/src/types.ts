/** Public, JSON-compatible Explorable Models 0.1 contract. All physical numbers use SI. */
export const RUNTIME_VERSION = '0.1.0';
export const SCHEMA_VERSION = '1.0';
export const DEFAULT_RATE_HZ = 120;
export type Scalar = number | string | boolean;
export type ScalarParams = Record<string, Scalar>;
export type NumericValue = number | readonly number[];
export type QuantityStatus = 'valid' | 'undefined' | 'out_of_domain';
export interface QuantityValue {
    value: NumericValue | null;
    status: QuantityStatus;
    reason?: string;
}
export interface Evaluation {
    quantities: Record<string, QuantityValue>;
    geometry?: Record<string, readonly number[]>;
    boundary?: {
        reached: boolean;
        reason: string;
    };
}
export interface TimeDomain {
    start: number;
    end: number | null;
    endEventId?: string;
}
export interface AnalyticModel<P extends ScalarParams = ScalarParams> {
    kind: 'analytic' | 'parametric';
    timeDomain?(params: Readonly<P>): TimeDomain;
    evaluate(input: Readonly<{
        params: P;
        time: number;
    }>): Evaluation;
}
export interface ParameterDefinition {
    type: 'number' | 'string' | 'boolean';
    label: string;
    default: Scalar;
    description?: string;
    min?: number;
    max?: number;
    step?: number;
    unit?: string;
    integer?: boolean;
    options?: readonly (string | {
        value: string;
        label: string;
    })[];
    display?: {
        unit: string;
        scale: number;
        decimals?: number;
    };
    advanced?: boolean;
}
export interface QuantityDefinition {
    label: string;
    type: 'scalar' | 'vector';
    unit: string;
    dimension: string;
    description: string;
    vectorLength?: number;
    entityId?: string;
    referenceFrame?: string;
    signConvention?: string;
}
export interface GeometryDefinition {
    shape: 'polyline2' | 'polyline3' | 'points2' | 'points3' | 'triangles3';
    unit: string;
    coordinateFrame: string;
    maxElements: number;
}
export interface EntityDefinition {
    id: string;
    label: string;
    description?: string;
    quantityIds: readonly string[];
}
export interface SourceReference {
    title: string;
    url: string;
}
export interface Manifest {
    schemaVersion: '1.0';
    id: string;
    title: string;
    description: string;
    question: string;
    kind: 'analytic' | 'parametric';
    parameters: Record<string, ParameterDefinition>;
    quantities: Record<string, QuantityDefinition>;
    geometry?: Record<string, GeometryDefinition>;
    entities?: readonly EntityDefinition[];
    assumptions: readonly string[];
    limitations: readonly string[];
    sources: readonly SourceReference[];
    capabilities: readonly string[];
    review?: {
        status: 'unreviewed' | 'reviewed';
        reviewer?: string;
        scope?: string;
        date?: string;
    };
    concept?: string;
    misconception?: string;
    tags?: readonly string[];
}
export type DisplayTransform = {
    kind: 'identity';
} | {
    kind: 'scale';
    factor: number;
    unit?: string;
    disclosure?: string;
} | {
    kind: 'component';
    index: number;
};
export interface ViewBinding {
    id: string;
    property: string;
    quantityId?: string;
    geometryId?: string;
    transform?: DisplayTransform;
}
export interface ViewDefinition {
    id: string;
    type: 'scene2d' | 'scene3d' | 'plot' | 'equation' | 'table' | 'frequency';
    label: string;
    description?: string;
    bindings: readonly ViewBinding[];
    /** Fixed coordinate extents for stable 2D projection, in the geometry's units. */
    bounds?: { x: readonly [number, number]; y: readonly [number, number] };
    template?: string;
    symbols?: Record<string, string>;
}
export interface ExperimentDefinition {
    manifest: Manifest;
    definitionRevision: string;
    model?: AnalyticModel;
    views?: readonly ViewDefinition[];
    modelCard?: string;
}
export type TimePoint = {
    kind: 'grid';
    time: number;
    tick: number;
    rateHz: number;
} | {
    kind: 'event';
    time: number;
    eventId: string;
} | {
    kind: 'sample';
    time: number;
};
export type RunStatus = 'ready' | 'running' | 'paused' | 'boundary' | 'error';
export interface RunFrame extends Evaluation {
    definitionRevision: string;
    runId: string;
    runVersion: number;
    timePoint: TimePoint;
    frameId: string;
    status: RunStatus;
    previewId?: string;
}
export interface ViewState {
    selectedIds: readonly string[];
    layers: Record<string, boolean>;
    camera?: {
        position: readonly [
            number,
            number,
            number
        ];
        target: readonly [
            number,
            number,
            number
        ];
    };
    mode?: string;
    playbackSpeed: number;
}
export interface Run {
    id: string;
    definitionRevision: string;
    version: number;
    parameters: ScalarParams;
    frame: RunFrame;
    restoredFrom?: string;
}
export interface RuntimeState {
    activeRunId: string;
    run: Run;
    frame: RunFrame;
    view: ViewState;
    viewVersion: number;
    preview?: {
        id: string;
        parameters: ScalarParams;
        frame: RunFrame;
    };
    lastError?: SerializedError;
}
export interface Snapshot {
    schemaVersion: '1.0';
    experimentId: string;
    definitionRevision: string;
    runtimeVersion: string;
    runId: string;
    runVersion: number;
    parameters: ScalarParams;
    timePoint: TimePoint;
    view: ViewState;
    viewVersion: number;
    comparisonReferences: readonly string[];
    annotations?: string;
    createdAt: string;
}
export type ErrorCode = 'INVALID_PARAMETER' | 'INVALID_MANIFEST' | 'INVALID_COMMAND' | 'OUT_OF_DOMAIN' | 'UNDEFINED_QUANTITY' | 'CONFLICT' | 'BUSY' | 'INCOMPATIBLE_SNAPSHOT' | 'MODEL_ERROR' | 'RESOURCE_LIMIT' | 'UNSUPPORTED_CAPABILITY' | 'NOT_FOUND' | 'TIMEOUT';
export interface SerializedError {
    code: ErrorCode;
    message: string;
    field?: string;
    recovery: string;
    currentVersion?: number;
    currentActiveRunId?: string;
}
export interface MutationGuard {
    expectedRunVersion: number;
    expectedActiveRunId: string;
}
export type RuntimeCommand = (MutationGuard & {
    type: 'play' | 'pause' | 'reset' | 'step';
}) | (MutationGuard & {
    type: 'seek';
    time: number;
}) | (MutationGuard & {
    type: 'set_parameters';
    parameters: ScalarParams;
}) | (MutationGuard & {
    type: 'restore';
    snapshot: Snapshot;
}) | {
    type: 'set_view';
    expectedViewVersion: number;
    view: Partial<ViewState>;
} | (MutationGuard & {
    type: 'begin_preview';
    parameters: ScalarParams;
}) | (MutationGuard & {
    type: 'update_preview';
    previewId: string;
    parameters: ScalarParams;
}) | (MutationGuard & {
    type: 'commit_preview' | 'cancel_preview';
    previewId: string;
});
export interface CommandResult {
    state: RuntimeState;
    previousRunId?: string;
}
export interface Inspection {
    experimentId: string;
    definitionRevision: string;
    runId: string;
    runVersion: number;
    frameId: string;
    timePoint: TimePoint;
    status: RunStatus;
    parameters: ScalarParams;
    quantities: Record<string, QuantityValue & QuantityDefinition>;
    entities: readonly EntityDefinition[];
    selectedIds: readonly string[];
    viewVersion: number;
    preview?: {
        previewId: string;
        tentative: true;
    };
    assumptions: readonly string[];
}
export interface SampleResult {
    definitionRevision: string;
    parameters: ScalarParams;
    frames: RunFrame[];
}
export interface Comparison {
    alignment: 'time';
    definitionRevision: string;
    runs: {
        runId: string;
        parameters: ScalarParams;
        frames: RunFrame[];
        domain: TimeDomain;
    }[];
    parameterDifferences: Record<string, {
        runId: string;
        value: Scalar;
    }[]>;
}
export interface CheckCase {
    id: string;
    label: string;
    parameters?: ScalarParams;
    time?: number;
    expected: Record<string, NumericValue | null>;
    statuses?: Record<string, QuantityStatus>;
    atol?: number;
    rtol?: number;
}
export interface CheckSuite {
    id: string;
    version: string;
    author: string;
    provenance: 'reference' | 'author';
    cases: readonly CheckCase[];
}
export interface CheckResult {
    id: string;
    label: string;
    passed: boolean;
    parameters: ScalarParams;
    time: number;
    assertions: {
        quantityId: string;
        observed: NumericValue | null;
        expected: NumericValue | null;
        passed: boolean;
        atol: number;
        rtol: number;
    }[];
    error?: SerializedError;
}
export interface CheckReport {
    definitionRevision: string;
    runtimeVersion: string;
    suiteId: string;
    suiteVersion: string;
    author: string;
    provenance: 'reference' | 'author';
    category: 'quantitative';
    createdAt: string;
    passed: boolean;
    results: CheckResult[];
    modelReview: Manifest['review'];
    learnerEvidence: 'not_evaluated';
}
/** Execution interface. Use WorkerExecutor in the player and for authored model checks. */
export interface ModelExecutor {
    evaluate(params: ScalarParams, time: number): Promise<Evaluation>;
    timeDomain(params: ScalarParams): Promise<TimeDomain>;
    dispose?(): void;
}
