/** Version 2 declarative authoring contract; independent of DOM and React. */
export type NumericValue = number | number[];
export type Expression = string | NumericValue;
export interface Diagnostic { code: string; path: string; message: string; recovery?: string }
export class DocumentError extends Error {
  constructor(public diagnostics: Diagnostic[]) { super(diagnostics.map(d => `${d.path}: ${d.message}`).join('; ')); this.name = 'DocumentError'; }
}
export interface ParameterSpec { label: string; value: number; min: number; max: number; step?: number; integer?: boolean; unit?: string; dimension?: string }
export interface QuantitySpec { expression: Expression; label?: string; unit?: string; dimension?: string; description?: string }
export interface DatasetSpec { columns: { id: string; label: string; unit?: string }[]; rows: (number | null)[][]; description: string }
export interface SeriesSpec { label: string; x?: string; y?: string; variable?: string; domain?: [number, number]; samples?: number; dataset?: string; xColumn?: string; yColumn?: string; kind?: 'model' | 'observed'; }
export interface MarkStyle { stroke?: string; fill?: string; strokeWidth?: number; dash?: 'solid' | 'dashed' | 'dotted'; opacity?: number; hidden?: boolean }
export interface MarkSpec {
  id: string; type: 'point' | 'segment' | 'path' | 'polygon' | 'circle' | 'ellipse' | 'arrow' | 'angle' | 'label' | 'line' | 'scatter' | 'bar' | 'region' | 'group';
  label: string; description?: string; bindings?: Record<string, string>; series?: string;
  text?: string; style?: MarkStyle; offset?: [number, number]; children?: MarkSpec[];
  drag?: { x: string; y: string }; semanticId?: string;
}
export interface ViewSpec { id: string; type: 'scene' | 'plot' | 'values' | 'equation' | 'table'; title: string; description?: string; marks?: MarkSpec[]; quantities?: string[]; equation?: string; dataset?: string; bounds?: [number, number, number, number]; equalAspect?: boolean; xLabel?: string; yLabel?: string; scale?: 'linear' | 'log'; }
export interface VisualizationDocument {
  schemaVersion: '2.0'; id: string; title: string; description: string;
  capabilities?: { id: string; version: string }[];
  parameters: Record<string, ParameterSpec>;
  quantities: Record<string, QuantitySpec>;
  datasets?: Record<string, DatasetSpec>; series?: Record<string, SeriesSpec>; views: ViewSpec[];
  time?: { end: Expression; step?: number };
  presentation?: { columns?: 1 | 2; controls?: boolean; precision?: number; locale?: string };
  assumptions: string[]; limitations: string[]; sources?: string[];
  provenance?: { authoredBy?: string; review: 'unreviewed'; checks?: 'author' | 'none' };
}
export interface ValueResult { value: NumericValue | null; status: 'valid' | 'undefined'; reason?: string }
export interface SeriesPoint { x: number | null; y: number | null; reason?: string }
export interface DocumentFrame {
  time: number; quantities: Record<string, ValueResult>; series: Record<string, SeriesPoint[]>;
  datasets: Record<string, DatasetSpec>; terminal: boolean; endTime: number | null;
}
export interface DocumentIdentity { documentRevision: string; modelRevision: string; presentationRevision: string }
export interface DocumentRun { id: string; version: number; params: Record<string, number>; time: number; modelRevision: string; restoredFrom?: string }
export interface SessionState {
  sessionId: string; status: 'empty' | 'ready' | 'disposed'; document: VisualizationDocument | null;
  identity: DocumentIdentity | null; version: number; run: DocumentRun | null; frame: DocumentFrame | null;
  playing: boolean; selection: string | null; preview: Record<string, number> | null; error: Diagnostic[] | null;
}
export interface MutationGuard { sessionId: string; expectedVersion: number; expectedRunId?: string; operationId: string; origin?: 'human' | 'agent' | 'host' }
export interface Candidate { id: string; document: VisualizationDocument; identity: DocumentIdentity; baseVersion: number; frame: DocumentFrame; status: 'validated'; }
export type SemanticEdit =
  | { op: 'set'; collection: 'parameters' | 'quantities' | 'datasets' | 'series'; id: string; value: unknown }
  | { op: 'remove'; collection: 'parameters' | 'quantities' | 'datasets' | 'series'; id: string }
  | { op: 'setView'; view: ViewSpec }
  | { op: 'removeView'; id: string }
  | { op: 'setMark'; viewId: string; mark: MarkSpec }
  | { op: 'removeMark'; viewId: string; id: string }
  | { op: 'presentation'; value: NonNullable<VisualizationDocument['presentation']> }
  | { op: 'metadata'; title?: string; description?: string };
export interface DocumentArtifact { format: 'experiment-kit-document'; version: '2.0'; runtimeVersion: string; document: VisualizationDocument; identity: DocumentIdentity; run: DocumentRun; selection: string | null; comparisons: { document: VisualizationDocument; identity: DocumentIdentity; run: DocumentRun }[] }
export interface EvaluationRequest { document: VisualizationDocument; params: Record<string, number>; time: number }
export interface DocumentEvaluator { evaluate(request: EvaluationRequest, signal?: AbortSignal): Promise<DocumentFrame>; dispose(): void }
export interface SessionOptions { workerFactory?: () => Worker; evaluator?: DocumentEvaluator; maxRuns?: number; maxCandidates?: number; }
export interface SessionEvent { type: 'ready' | 'change' | 'selection' | 'candidate' | 'error' | 'disposed'; state: SessionState; operationId?: string; origin?: string }
export interface VisualizationSession {
  readonly id: string;
  getState(): SessionState;
  subscribe(listener: (event: SessionEvent) => void): () => void;
  createCandidate(document: unknown, guard: MutationGuard, signal?: AbortSignal): Promise<Candidate>;
  reviseCandidate(edits: SemanticEdit[], guard: MutationGuard, signal?: AbortSignal): Promise<Candidate>;
  commitCandidate(candidateId: string, guard: MutationGuard, signal?: AbortSignal): Promise<SessionState>;
  discardCandidate(candidateId: string, guard: MutationGuard): void;
  setParameters(params: Record<string, number>, guard: MutationGuard, signal?: AbortSignal): Promise<SessionState>;
  previewParameters(params: Record<string, number>, guard: MutationGuard): void;
  cancelPreview(guard: MutationGuard): void;
  seek(time: number, guard: MutationGuard, signal?: AbortSignal): Promise<SessionState>;
  play(guard: MutationGuard): void;
  pause(guard: MutationGuard): void;
  select(id: string | null, guard: MutationGuard): void;
  exportDocument(): DocumentArtifact;
  restoreDocument(artifact: unknown, guard: MutationGuard, signal?: AbortSignal): Promise<SessionState>;
  dispose(): void;
}
