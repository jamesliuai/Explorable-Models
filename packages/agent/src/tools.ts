import { DocumentError, DOCUMENT_RUNTIME_VERSION, SESSION_LIMITS, DOCUMENT_SCHEMA, DOCUMENT_LIMITS, EXPRESSION_FUNCTIONS, EXPRESSION_LIMITS, SUPPORTED_DOCUMENT_CAPABILITIES } from '@explorable-models/core/declarative';
import type { Candidate, Diagnostic, MutationGuard, SemanticEdit, VisualizationSession } from '@explorable-models/core/declarative';

export interface ToolDescriptor { name: string; description: string; inputSchema: Record<string, unknown>; outputSchema: Record<string, unknown> }
export type VisualizationToolResult = { ok: true; data: unknown } | { ok: false; diagnostics: Diagnostic[] };
export interface VisualizationTools {
  readonly descriptors: readonly ToolDescriptor[];
  execute(name: string, input: unknown, options?: { signal?: AbortSignal }): Promise<VisualizationToolResult>;
}
export const TOOL_LIMITS = Object.freeze({ inputBytes: 4_000_000, diagnostics: 20, requestedQuantities: 64, inspectionSeriesPoints: 20 });
const guardSchema = { type: 'object', additionalProperties: false, required: ['sessionId', 'expectedVersion', 'operationId'], properties: {
  sessionId: { type: 'string' }, expectedVersion: { type: 'integer', minimum: 0 }, expectedRunId: { type: 'string' }, operationId: { type: 'string', minLength: 1, maxLength: 128 }, origin: { enum: ['human', 'agent', 'host'] },
} };
const outputSchema = { oneOf: [
  { type: 'object', required: ['ok', 'data'], additionalProperties: false, properties: { ok: { const: true }, data: {} } },
  { type: 'object', required: ['ok', 'diagnostics'], additionalProperties: false, properties: { ok: { const: false }, diagnostics: { type: 'array', maxItems: TOOL_LIMITS.diagnostics, items: { type: 'object', required: ['code', 'path', 'message'], properties: { code: { type: 'string' }, path: { type: 'string' }, message: { type: 'string' }, recovery: { type: 'string' } } } } } },
] };
const objectSchema = (properties: Record<string, unknown>, required: string[] = []) => ({ type: 'object', additionalProperties: false, properties, required });
const descriptor = (name: string, description: string, properties: Record<string, unknown>, required: string[] = []): ToolDescriptor => ({ name, description, inputSchema: objectSchema(properties, required), outputSchema });
const string = { type: 'string' };
const guard = { guard: guardSchema };
const editSchema = { oneOf: [
  objectSchema({ op: { const: 'set' }, collection: { enum: ['parameters', 'quantities', 'datasets', 'series'] }, id: string, value: {} }, ['op', 'collection', 'id', 'value']),
  objectSchema({ op: { const: 'remove' }, collection: { enum: ['parameters', 'quantities', 'datasets', 'series'] }, id: string }, ['op', 'collection', 'id']),
  objectSchema({ op: { const: 'setView' }, view: { type: 'object' } }, ['op', 'view']),
  objectSchema({ op: { const: 'removeView' }, id: string }, ['op', 'id']),
  objectSchema({ op: { const: 'setMark' }, viewId: string, mark: { type: 'object' } }, ['op', 'viewId', 'mark']),
  objectSchema({ op: { const: 'removeMark' }, viewId: string, id: string }, ['op', 'viewId', 'id']),
  objectSchema({ op: { const: 'presentation' }, value: { type: 'object' } }, ['op', 'value']),
  objectSchema({ op: { const: 'metadata' }, title: string, description: string }, ['op']),
] };
export const VISUALIZATION_TOOL_DESCRIPTORS: readonly ToolDescriptor[] = Object.freeze([
  descriptor('visualization_discover', 'Get the v2 scope, limits, mutation guards, optional compact example, and honest capture/review availability.', { includeExample: { type: 'boolean' }, includeSchema: { type: 'boolean' } }),
  descriptor('visualization_create', 'Normalize and evaluate a declarative document as a candidate. Accepted state remains unchanged until commit. Schema/computation checks are author checks, not scientific review.', { document: { type: 'object', description: 'VisualizationDocument 2.0. Call visualization_discover with includeSchema:true for the complete JSON Schema and field limits.' }, ...guard }, ['document', 'guard']),
  descriptor('visualization_revise', 'Prepare an atomic semantic edit batch against the accepted document, using stable IDs. Each set replaces one object; presentation replaces presentation settings.', { edits: { type: 'array', minItems: 1, maxItems: SESSION_LIMITS.maxEdits, items: editSchema }, ...guard }, ['edits', 'guard']),
  descriptor('visualization_inspect', 'Inspect committed state, mutation guards, quantities and bounded series summaries, or a candidate made through this tool set.', { candidateId: string, includeDocument: { type: 'boolean' }, quantityIds: { type: 'array', maxItems: TOOL_LIMITS.requestedQuantities, items: string } }),
  descriptor('visualization_commit', 'Atomically activate a validated candidate only if its base version is still current. A presentation-only change preserves run and time.', { candidateId: string, ...guard }, ['candidateId', 'guard']),
  descriptor('visualization_discard', 'Discard a retained candidate without changing the accepted document.', { candidateId: string, ...guard }, ['candidateId', 'guard']),
  descriptor('visualization_operate', 'Apply a guarded operation. Parameters restart at zero; preview is tentative; seek clamps to the exact end; step advances one declared time step.', { action: { enum: ['parameters', 'preview', 'cancel_preview', 'seek', 'step', 'play', 'pause', 'select'] }, parameters: { type: 'object', additionalProperties: { type: 'number' } }, time: { type: 'number', minimum: 0 }, selection: { type: ['string', 'null'] }, ...guard }, ['action', 'guard']),
  descriptor('visualization_save', 'Return a portable artifact with exact definitions and retained comparison runs. Host storage is explicit; a pending preview blocks saving.', {}),
  descriptor('visualization_restore', 'Validate an exact-runtime v2 artifact and all retained definitions before creating a new run. Invalid imports preserve accepted state.', { artifact: { type: 'object' }, ...guard }, ['artifact', 'guard']),
]);
const example = {
  schemaVersion: '2.0', id: 'sine', title: 'Sine wave', description: 'An editable analytical sine wave.',
  parameters: { amplitude: { label: 'Amplitude', value: 1, min: 0, max: 3, step: 0.1 }, frequency: { label: 'Frequency', value: 1, min: 0.1, max: 3, step: 0.1 } },
  quantities: { origin: { expression: [0, 0] } }, series: { wave: { label: 'Sine', variable: 'x', x: 'x', y: 'amplitude * sin(frequency * x)', domain: [-6.28, 6.28], samples: 101, kind: 'model' } },
  views: [{ id: 'plot', type: 'plot', title: 'Sine wave', bounds: [-6.3, 6.3, -3.2, 3.2], xLabel: 'x (radians)', yLabel: 'y', marks: [{ id: 'curve', type: 'line', label: 'Sine curve', series: 'wave' }] }], assumptions: ['The argument is in radians.'], limitations: ['A sampled analytical curve, with no inferred data fit.'], provenance: { review: 'unreviewed', checks: 'author' },
};
function invalid(path: string, message: string): never { throw new DocumentError([{ code: 'INVALID_TOOL_INPUT', path, message, recovery: 'Inspect the tool input schema and send a repaired request.' }]); }
function inputRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid('$', 'Tool input must be an object.');
  let encoded: string;
  try { encoded = JSON.stringify(value); } catch { invalid('$', 'Tool input must be JSON-compatible.'); }
  if (new TextEncoder().encode(encoded).length > TOOL_LIMITS.inputBytes) invalid('$', `Tool input exceeds ${TOOL_LIMITS.inputBytes} bytes.`);
  const parsed = JSON.parse(encoded) as Record<string, unknown>;
  // Reject values JSON would silently drop or coerce (NaN, functions, undefined).
  const check = (a: unknown, b: unknown, path: string, depth: number): void => {
    if (depth > 64) invalid(path, 'Tool input nesting is too deep.');
    if (typeof a === 'number' && !Number.isFinite(a)) invalid(path, 'Numbers must be finite.');
    if (a === undefined || typeof a === 'function' || typeof a === 'symbol' || typeof a === 'bigint') invalid(path, 'Input is not JSON-compatible.');
    if (a && typeof a === 'object') { if (Object.getPrototypeOf(a) !== Object.prototype && !Array.isArray(a) && Object.getPrototypeOf(a) !== null) invalid(path, 'Input must contain plain JSON objects.'); for (const [key, value] of Object.entries(a)) check(value, (b as Record<string, unknown>)?.[key], `${path}.${key}`, depth + 1); }
  };
  check(value, parsed, '$', 0); return parsed;
}
function checkShape(input: Record<string, unknown>, descriptor: ToolDescriptor): void {
  const schema = descriptor.inputSchema as { properties: Record<string, Record<string, unknown>>; required: string[] };
  for (const key of Object.keys(input)) if (!Object.hasOwn(schema.properties, key)) invalid(`$.${key}`, 'Unknown input field.');
  for (const key of schema.required) if (!Object.hasOwn(input, key)) invalid(`$.${key}`, 'Required field is missing.');
  for (const [key, value] of Object.entries(input)) {
    const rule = schema.properties[key]; const type = rule.type;
    if (type === 'string' && (typeof value !== 'string' || value.length > 128)) invalid(`$.${key}`, 'Expected a string no longer than 128 characters.');
    if (type === 'boolean' && typeof value !== 'boolean') invalid(`$.${key}`, 'Expected a boolean.');
    if (type === 'object' && (!value || typeof value !== 'object' || Array.isArray(value))) invalid(`$.${key}`, 'Expected an object.');
    if (type === 'number' && (typeof value !== 'number' || !Number.isFinite(value) || value < Number(rule.minimum ?? -Infinity))) invalid(`$.${key}`, 'Expected a finite number in the supported range.');
    if (type === 'array' && (!Array.isArray(value) || value.length > Number(rule.maxItems ?? Infinity) || value.length < Number(rule.minItems ?? 0))) invalid(`$.${key}`, 'Expected an array within the tool size limit.');
    if (Array.isArray(rule.enum) && !rule.enum.includes(value)) invalid(`$.${key}`, 'Unsupported value.');
  }
  if (input.quantityIds !== undefined && !(input.quantityIds as unknown[]).every(value => typeof value === 'string' && value.length <= 80)) invalid('$.quantityIds', 'Expected bounded quantity IDs.');
  if (input.selection !== undefined && input.selection !== null && typeof input.selection !== 'string') invalid('$.selection', 'Expected a semantic ID or null.');
}
function inspection(session: VisualizationSession, includeDocument = false, quantityIds?: string[]) {
  const state = session.getState();
  const quantities = quantityIds ? Object.fromEntries(quantityIds.map(id => { const value = state.frame?.quantities[id]; if (!value) invalid('$.quantityIds', `Unknown quantity ${id}.`); return [id, value]; })) : state.frame?.quantities ?? {};
  return { sessionId: session.id, status: state.status, version: state.version, run: state.run, identity: state.identity, playing: state.playing, selection: state.selection, preview: state.preview, error: state.error,
    frame: state.frame && { time: state.frame.time, terminal: state.frame.terminal, endTime: state.frame.endTime, quantities, series: Object.fromEntries(Object.entries(state.frame.series).map(([id, points]) => [id, { count: points.length, samples: points.slice(0, TOOL_LIMITS.inspectionSeriesPoints), truncated: points.length > TOOL_LIMITS.inspectionSeriesPoints }])) },
    ...(includeDocument && { document: state.document }), guard: { sessionId: session.id, expectedVersion: state.version, ...(state.run && { expectedRunId: state.run.id }), operationId: '<new unique operation ID>', origin: 'agent' },
  };
}
export function createVisualizationTools({ session }: { session: VisualizationSession }): VisualizationTools {
  const candidates = new Map<string, Candidate>();
  const execute = async (name: string, rawInput: unknown, { signal }: { signal?: AbortSignal } = {}): Promise<VisualizationToolResult> => {
      try {
        if (signal?.aborted) throw new DocumentError([{ code: 'CANCELLED', path: '$', message: 'Request cancelled before execution.', recovery: 'Retry with a new operation ID.' }]);
        const descriptor = VISUALIZATION_TOOL_DESCRIPTORS.find(item => item.name === name);
        if (!descriptor) invalid('$.name', `Unknown tool ${String(name).slice(0, 128)}.`);
        const input = inputRecord(rawInput); checkShape(input, descriptor);
        const guard = input.guard as unknown as MutationGuard;
        let data: unknown;
        if (name === 'visualization_discover') data = {
          version: DOCUMENT_RUNTIME_VERSION, schemaVersion: '2.0', documentLimits: DOCUMENT_LIMITS, supportedCapabilities: SUPPORTED_DOCUMENT_CAPABILITIES, sessionId: session.id, scope: 'Bounded 2D declarative analytical/parametric visualization',
          capabilities: ['point', 'segment', 'path', 'polygon', 'circle', 'ellipse', 'arrow', 'angle', 'label', 'group', 'line', 'scatter', 'bar', 'region', 'values', 'equation', 'table', 'datasets', 'semantic-edits', 'playback', 'selection'],
          limits: { session: SESSION_LIMITS, tools: TOOL_LIMITS, document: DOCUMENT_LIMITS }, capture: { scene: 'Use the optional player scene export API with a mounted surface.', fullPage: 'Host-supplied capture adapter required; no browser screenshot capability is claimed.' },
          workflow: ['inspect for current guards', 'create or revise candidate', 'inspect candidate', 'commit with current guards', 'operate', 'save into host storage', 'restore'],
          expressions: { functions: EXPRESSION_FUNCTIONS, limits: EXPRESSION_LIMITS, references: 'Declared parameter/quantity IDs, time, pi, e; series variable is scoped to that series.', example: 'amplitude * sin(frequency * x)', execution: 'Allowlisted AST in a browser worker; arbitrary JavaScript and network access are unsupported.' },
          mutationRules: 'All mutations require sessionId, expectedVersion, expectedRunId when a run exists, and unique operationId. Identical retries deduplicate within 64 retained operations; changed arguments must use a new ID. Invalid/cancelled/stale candidates preserve accepted state. Preview blocks saving and conflicting mutations.',
          review: 'unreviewed', checks: 'schema and computation validation only; no independent scientific review', unsupported: ['general 3D authoring', 'numerical solvers', 'stochastic simulation', 'arbitrary JavaScript', 'automatic data fitting', 'built-in model-provider service'],
          ...(input.includeExample === true && { example }), ...(input.includeSchema !== false && { documentSchema: DOCUMENT_SCHEMA }),
        };
        else if (name === 'visualization_create' || name === 'visualization_revise') {
          const candidate = name === 'visualization_create' ? await session.createCandidate(input.document, guard, signal) : await session.reviseCandidate(input.edits as SemanticEdit[], guard, signal);
          candidates.set(candidate.id, candidate);
          while (candidates.size > SESSION_LIMITS.maxCandidates) candidates.delete(candidates.keys().next().value!);
          data = { candidateId: candidate.id, identity: candidate.identity, baseVersion: candidate.baseVersion, status: candidate.status, diagnostics: [], validation: { schema: 'passed', references: 'passed', computation: 'passed', provenance: 'author', scientificReview: 'unreviewed', visualReview: 'not_performed' } };
        } else if (name === 'visualization_inspect') {
          if (input.candidateId) { const candidate = candidates.get(input.candidateId as string); if (!candidate) invalid('$.candidateId', 'Candidate is not retained by this tool set.'); data = { candidateId: candidate.id, status: candidate.status, baseVersion: candidate.baseVersion, identity: candidate.identity, frame: { time: candidate.frame.time, quantities: candidate.frame.quantities }, ...(input.includeDocument === true && { document: candidate.document }) }; }
          else data = inspection(session, input.includeDocument as boolean, input.quantityIds as string[] | undefined);
        } else if (name === 'visualization_commit') { await session.commitCandidate(input.candidateId as string, guard, signal); candidates.delete(input.candidateId as string); data = inspection(session); }
        else if (name === 'visualization_discard') { session.discardCandidate(input.candidateId as string, guard); candidates.delete(input.candidateId as string); data = { discarded: input.candidateId }; }
        else if (name === 'visualization_operate') {
          const action = input.action;
          const allowed = ['action', 'guard', ...(action === 'parameters' || action === 'preview' ? ['parameters'] : action === 'seek' ? ['time'] : action === 'select' ? ['selection'] : [])];
          for (const key of Object.keys(input)) if (!allowed.includes(key)) invalid(`$.${key}`, `Field is not valid for ${String(action)}.`);
          if (action === 'parameters' || action === 'preview') { if (!input.parameters) invalid('$.parameters', 'Parameters are required.'); if (action === 'parameters') await session.setParameters(input.parameters as Record<string, number>, guard, signal); else session.previewParameters(input.parameters as Record<string, number>, guard); }
          else if (action === 'cancel_preview') session.cancelPreview(guard);
          else if (action === 'seek') { if (typeof input.time !== 'number') invalid('$.time', 'Time is required.'); await session.seek(input.time, guard, signal); }
          else if (action === 'step') { const state = session.getState(); if (!state.document?.time) invalid('$.action', 'Step requires an analytical time domain.'); await session.seek((state.run?.time ?? 0) + (state.document.time.step ?? 1 / 30), guard, signal); }
          else if (action === 'play') session.play(guard);
          else if (action === 'pause') session.pause(guard);
          else if (action === 'select') { if (!Object.hasOwn(input, 'selection')) invalid('$.selection', 'Selection is required; use null to clear.'); session.select(input.selection as string | null, guard); }
          data = inspection(session);
        } else if (name === 'visualization_save') data = session.exportDocument();
        else if (name === 'visualization_restore') { await session.restoreDocument(input.artifact, guard, signal); candidates.clear(); data = inspection(session); }
        if (disposed) { candidates.clear(); throw new DocumentError([{ code: 'DISPOSED', path: '$.sessionId', message: 'Session disposed before the operation result was delivered.', recovery: 'Create a new session and tool set.' }]); }
        return { ok: true, data };
      } catch (error) {
        return { ok: false, diagnostics: (error instanceof DocumentError ? error.diagnostics : [{ code: 'EXECUTION_FAILURE', path: '$', message: error instanceof Error ? error.message : 'Tool execution failed.', recovery: 'Inspect current state; the accepted visualization is retained.' }]).slice(0, TOOL_LIMITS.diagnostics).map(diagnostic => ({ ...diagnostic, message: diagnostic.message.slice(0, 1500) })) };
      }
  };
  const receipts = new Map<string, { fingerprint: string; pending: boolean; promise: Promise<VisualizationToolResult> }>();
  let disposed = false;
  session.subscribe(event => { if (event.type === 'disposed') { disposed = true; candidates.clear(); receipts.clear(); } });
  return { descriptors: VISUALIZATION_TOOL_DESCRIPTORS, execute(name, input, options = {}) {
    if (disposed) return Promise.resolve({ ok: false, diagnostics: [{ code: 'DISPOSED', path: '$.sessionId', message: 'The tool session has been disposed.', recovery: 'Create a new session and tool set.' }] });
    // Tool-level receipts also preserve the original result of relative operations such as step.
    let snapshot: Record<string, unknown>;
    try { snapshot = inputRecord(input); } catch { return execute(name, input, options); }
    const operationId = (snapshot.guard as MutationGuard | undefined)?.operationId;
    if (typeof operationId !== 'string') return execute(name, snapshot, options);
    const fingerprint = JSON.stringify({ name, input: snapshot });
    const previous = receipts.get(operationId);
    if (previous) {
      if (previous.fingerprint === fingerprint) return previous.promise;
      return Promise.resolve({ ok: false, diagnostics: [{ code: 'OPERATION_CONFLICT', path: '$.guard.operationId', message: 'Operation ID was reused with different tool arguments.', recovery: 'Use a new operation ID.' }] });
    }
    if (receipts.size >= SESSION_LIMITS.deduplicatedOperations) {
      const oldest = [...receipts].find(([, receipt]) => !receipt.pending);
      if (!oldest) return Promise.resolve({ ok: false, diagnostics: [{ code: 'RESOURCE_LIMIT', path: '$', message: 'Too many concurrent tool operations.', recovery: 'Wait for pending operations.' }] });
      receipts.delete(oldest[0]);
    }
    const receipt = { fingerprint, pending: true, promise: Promise.resolve().then(() => execute(name, snapshot, options)).finally(() => { receipt.pending = false; }) };
    receipts.set(operationId, receipt); return receipt.promise;
  } };
}
