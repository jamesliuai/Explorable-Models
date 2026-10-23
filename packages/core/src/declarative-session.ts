/** Instance-owned v2 session. No browser globals are touched until construction. */
import { normalizeDocument, documentIdentity, createDocumentEvaluator } from './declarative/index.js';
import { DocumentError } from './declarative/types.js';
import type { Candidate, Diagnostic, DocumentArtifact, DocumentEvaluator, DocumentFrame, DocumentIdentity, DocumentRun, MutationGuard, SemanticEdit, SessionEvent, SessionOptions, SessionState, VisualizationDocument, VisualizationSession } from './declarative/types.js';

export const DOCUMENT_RUNTIME_VERSION = '0.2.0-preview.1';
export const SESSION_LIMITS = Object.freeze({ maxRuns: 10, maxCandidates: 8, deduplicatedOperations: 64, maxEdits: 100, maxArtifactBytes: 4_000_000, maxComparisonBytes: 3_300_000 });
type SavedRun = DocumentArtifact['comparisons'][number];
type Receipt = { fingerprint: string; pending: boolean; value?: unknown; failure?: unknown };
const copy = <T>(value: T): T => structuredClone(value);
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') { Object.freeze(value); for (const child of Object.values(value)) freeze(child); }
  return value;
}
function fail(code: string, path: string, message: string, recovery = 'Inspect the current state and retry with fresh guards.'): never {
  throw new DocumentError([{ code, path, message, recovery }]);
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(',')}}`;
  return JSON.stringify(value) ?? 'undefined';
}
function record(value: unknown, path: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('INVALID_INPUT', path, 'Expected an object.');
  return value as Record<string, unknown>;
}
function exactKeys(value: Record<string, unknown>, keys: string[], path: string): void {
  const unknown = Object.keys(value).find(key => !keys.includes(key));
  if (unknown) fail('INVALID_INPUT', `${path}.${unknown}`, 'Unknown field.');
}
function checkAbort(signal?: AbortSignal): void { if (signal?.aborted) fail('CANCELLED', '$', 'The operation was cancelled.', 'Start a new operation when ready.'); }
function parameterValues(document: VisualizationDocument, updates: Record<string, number>, base?: Record<string, number>): Record<string, number> {
  record(updates, '$.parameters');
  for (const key of Object.keys(updates)) if (!Object.hasOwn(document.parameters, key)) fail('INVALID_PARAMETER', `$.parameters.${key}`, 'Unknown parameter.');
  return Object.fromEntries(Object.entries(document.parameters).map(([key, spec]) => {
    const value = updates[key] ?? base?.[key] ?? spec.value;
    if (typeof value !== 'number' || !Number.isFinite(value) || value < spec.min || value > spec.max || (spec.integer && !Number.isInteger(value))) fail('INVALID_PARAMETER', `$.parameters.${key}`, `Expected a finite number from ${spec.min} to ${spec.max}.`, 'Choose a value inside the declared parameter domain.');
    // Null is never a request to silently reset a scientific parameter.
    if (Object.hasOwn(updates, key) && updates[key] !== value) fail('INVALID_PARAMETER', `$.parameters.${key}`, 'Expected a finite numeric parameter.');
    return [key, value];
  }));
}
function boundedInteger(value: number | undefined, fallback: number, max: number, name: string): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < 1 || value > max) fail('RESOURCE_LIMIT', name, `Expected an integer from 1 to ${max}.`);
  return value;
}
function semanticIds(document: VisualizationDocument): Set<string> {
  const ids = new Set<string>();
  const marks = (items: NonNullable<VisualizationDocument['views'][number]['marks']>) => { for (const mark of items) { ids.add(mark.id); if (mark.semanticId) ids.add(mark.semanticId); if (mark.children) marks(mark.children); } };
  for (const view of document.views) { ids.add(view.id); marks(view.marks ?? []); }
  return ids;
}
function applyEdits(document: VisualizationDocument, edits: SemanticEdit[]): VisualizationDocument {
  if (!Array.isArray(edits) || edits.length < 1 || edits.length > SESSION_LIMITS.maxEdits) fail('RESOURCE_LIMIT', '$.edits', `Expected 1–${SESSION_LIMITS.maxEdits} semantic edits.`);
  const next = copy(document);
  for (const [index, edit] of edits.entries()) {
    const value = record(edit, `$.edits[${index}]`);
    if (edit.op === 'set' || edit.op === 'remove') {
      exactKeys(value, edit.op === 'set' ? ['op', 'collection', 'id', 'value'] : ['op', 'collection', 'id'], `$.edits[${index}]`);
      if (!['parameters', 'quantities', 'datasets', 'series'].includes(edit.collection) || typeof edit.id !== 'string' || !/^[A-Za-z][\w.-]{0,79}$/.test(edit.id) || ['__proto__', 'constructor', 'prototype'].includes(edit.id)) fail('INVALID_EDIT', `$.edits[${index}]`, 'Invalid collection or stable object ID.');
      const collection = (next[edit.collection] ??= {}) as Record<string, unknown>;
      if (edit.op === 'remove') { if (!Object.hasOwn(collection, edit.id)) fail('NOT_FOUND', `$.edits[${index}].id`, 'Object does not exist.'); delete collection[edit.id]; }
      else collection[edit.id] = copy(edit.value);
    } else if (edit.op === 'setView') {
      exactKeys(value, ['op', 'view'], `$.edits[${index}]`);
      record(edit.view, `$.edits[${index}].view`);
      const viewIndex = next.views.findIndex(view => view.id === edit.view.id);
      if (viewIndex < 0) next.views.push(copy(edit.view)); else next.views[viewIndex] = copy(edit.view);
    } else if (edit.op === 'removeView') {
      exactKeys(value, ['op', 'id'], `$.edits[${index}]`);
      const viewIndex = next.views.findIndex(view => view.id === edit.id);
      if (viewIndex < 0) fail('NOT_FOUND', '$.edits.id', 'View does not exist.');
      next.views.splice(viewIndex, 1);
    } else if (edit.op === 'setMark' || edit.op === 'removeMark') {
      exactKeys(value, edit.op === 'setMark' ? ['op', 'viewId', 'mark'] : ['op', 'viewId', 'id'], `$.edits[${index}]`);
      const view = next.views.find(view => view.id === edit.viewId);
      if (!view) fail('NOT_FOUND', '$.edits.viewId', 'View does not exist.');
      view.marks ??= [];
      if (edit.op === 'setMark') record(edit.mark, `$.edits[${index}].mark`);
      const targetId = edit.op === 'setMark' ? edit.mark.id : edit.id;
      const locate = (marks: NonNullable<typeof view.marks>): { marks: typeof marks; index: number } | null => {
        for (let index = 0; index < marks.length; index++) { if (marks[index].id === targetId) return { marks, index }; const child = marks[index].children; if (child) { const found = locate(child); if (found) return found; } } return null;
      };
      const target = locate(view.marks);
      if (edit.op === 'removeMark') { if (!target) fail('NOT_FOUND', '$.edits.id', 'Mark does not exist.'); target.marks.splice(target.index, 1); }
      else if (target) target.marks[target.index] = copy(edit.mark); else view.marks.push(copy(edit.mark));
    } else if (edit.op === 'presentation') {
      exactKeys(value, ['op', 'value'], `$.edits[${index}]`); next.presentation = copy(edit.value);
    } else if (edit.op === 'metadata') {
      exactKeys(value, ['op', 'title', 'description'], `$.edits[${index}]`);
      if (edit.title !== undefined) next.title = edit.title;
      if (edit.description !== undefined) next.description = edit.description;
    } else fail('INVALID_EDIT', `$.edits[${index}].op`, 'Unsupported semantic edit.');
  }
  return normalizeDocument(next);
}

/** Construction is browser-only by default; tests/hosts may inject a trusted evaluator. */
export async function createVisualizationSession(options: SessionOptions = {}): Promise<VisualizationSession> {
  const maxRuns = boundedInteger(options.maxRuns, SESSION_LIMITS.maxRuns, SESSION_LIMITS.maxRuns, 'maxRuns');
  const maxCandidates = boundedInteger(options.maxCandidates, SESSION_LIMITS.maxCandidates, SESSION_LIMITS.maxCandidates, 'maxCandidates');
  const evaluator: DocumentEvaluator = options.evaluator ?? createDocumentEvaluator(options.workerFactory);
  const id = crypto.randomUUID();
  let state: SessionState = freeze({ sessionId: id, status: 'empty', document: null, identity: null, version: 0, run: null, frame: null, playing: false, selection: null, preview: null, error: null });
  const listeners = new Set<(event: SessionEvent) => void>();
  const candidates = new Map<string, Candidate>();
  const receipts = new Map<string, Receipt>();
  let comparisons: SavedRun[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  let playbackEpoch = 0;
  let activeTick: AbortController | undefined;
  const emit = (type: SessionEvent['type'], guard?: MutationGuard) => {
    const event = freeze({ type, state, ...(guard && { operationId: guard.operationId, origin: guard.origin }) });
    for (const listener of [...listeners]) { try { listener(event); } catch { /* Observers cannot roll back accepted state. */ } }
  };
  const trimComparisons = () => { while (comparisons.length && new TextEncoder().encode(JSON.stringify(comparisons)).length > SESSION_LIMITS.maxComparisonBytes) comparisons.shift(); };
  const update = (patch: Partial<SessionState>, type: SessionEvent['type'] = 'change', guard?: MutationGuard, advance = true) => { state = freeze({ ...state, ...patch, version: state.version + Number(advance) }); if (Object.hasOwn(patch, 'document')) trimComparisons(); emit(type, guard); };
  const live = () => { if (state.status === 'disposed') fail('DISPOSED', '$.sessionId', 'This session has been disposed.', 'Create a new session.'); };
  const validateGuard = (guard: MutationGuard) => {
    live(); record(guard, '$.guard'); exactKeys(guard as unknown as Record<string, unknown>, ['sessionId', 'expectedVersion', 'expectedRunId', 'operationId', 'origin'], '$.guard');
    if (guard.sessionId !== id) fail('SESSION_MISMATCH', '$.guard.sessionId', 'Guard targets a different session.');
    if (typeof guard.operationId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(guard.operationId)) fail('INVALID_GUARD', '$.guard.operationId', 'Provide a bounded unique operation ID.');
    if (!Number.isSafeInteger(guard.expectedVersion) || guard.expectedVersion < 0 || (guard.origin !== undefined && !['human', 'agent', 'host'].includes(guard.origin))) fail('INVALID_GUARD', '$.guard', 'Invalid version or origin.');
  };
  const current = (guard: MutationGuard) => {
    live();
    if (guard.expectedVersion !== state.version || guard.expectedRunId !== state.run?.id) fail('CONFLICT', '$.guard', `State changed: expected version ${guard.expectedVersion}, actual ${state.version}; active run ${state.run?.id ?? 'none'}.`);
  };
  const noPreview = () => { if (state.preview) fail('PREVIEW_ACTIVE', '$.preview', 'Commit or cancel tentative parameters first.', 'Call setParameters to commit or cancelPreview to discard.'); };
  const ready = () => { live(); if (!state.document || !state.run || !state.frame || !state.identity) fail('NOT_READY', '$', 'No accepted visualization.', 'Create and commit a candidate.'); };
  const stopClock = () => { playbackEpoch++; if (timer !== undefined) clearTimeout(timer); timer = undefined; activeTick?.abort(); activeTick = undefined; };
  const retain = () => { if (state.document && state.identity && state.run) { comparisons.push(copy({ document: state.document, identity: state.identity, run: state.run })); comparisons = comparisons.slice(-(maxRuns - 1 || comparisons.length)); if (maxRuns === 1) comparisons = []; trimComparisons(); } };
  const run = (document: VisualizationDocument, identity: DocumentIdentity, params = parameterValues(document, {}), time = 0, restoredFrom?: string): DocumentRun => ({ id: crypto.randomUUID(), version: 0, params, time, modelRevision: identity.modelRevision, ...(restoredFrom && { restoredFrom }) });
  const report = (error: unknown, guard: MutationGuard) => {
    if (state.status === 'disposed') return;
    const diagnostics: Diagnostic[] = error instanceof DocumentError ? error.diagnostics : [{ code: 'EXECUTION_FAILURE', path: '$', message: error instanceof Error ? error.message.slice(0, 1000) : 'Operation failed.', recovery: 'Inspect the diagnostic and retry.' }];
    update({ error: copy(diagnostics.slice(0, 20)) }, 'error', guard, false);
  };
  const receipt = (name: string, payload: unknown, guard: MutationGuard): { entry: Receipt; existing: boolean } => {
    validateGuard(guard);
    const fingerprint = canonical({ name, payload, guard });
    if (new TextEncoder().encode(fingerprint).length > SESSION_LIMITS.maxArtifactBytes) fail('RESOURCE_LIMIT', '$', 'Operation payload exceeds the session byte limit.');
    const previous = receipts.get(guard.operationId);
    if (previous) { if (previous.fingerprint !== fingerprint) fail('OPERATION_CONFLICT', '$.guard.operationId', 'Operation ID was already used with different arguments.', 'Use a new operation ID for a different request.'); return { entry: previous, existing: true }; }
    current(guard);
    if (receipts.size >= SESSION_LIMITS.deduplicatedOperations) { const oldest = [...receipts].find(([, value]) => !value.pending); if (!oldest) fail('RESOURCE_LIMIT', '$', 'Too many concurrent operations.'); receipts.delete(oldest[0]); }
    const entry = { fingerprint, pending: true }; receipts.set(guard.operationId, entry); return { entry, existing: false };
  };
  const asyncOperation = <T>(name: string, payload: unknown, guard: MutationGuard, action: () => Promise<T>): Promise<T> => {
    let result: ReturnType<typeof receipt>;
    try { result = receipt(name, payload, guard); } catch (error) { return Promise.reject(error); }
    if (result.existing) return result.entry.value as Promise<T>;
    // The promise enters the dedupe map before any asynchronous work runs.
    const promise = Promise.resolve().then(action).catch(error => { report(error, guard); throw error; }).finally(() => { result.entry.pending = false; });
    result.entry.value = promise; return promise;
  };
  const syncOperation = (name: string, payload: unknown, guard: MutationGuard, action: () => void): void => {
    const result = receipt(name, payload, guard);
    if (result.existing) { if (result.entry.failure) throw result.entry.failure; return; }
    try { action(); } catch (error) { result.entry.failure = error; report(error, guard); throw error; } finally { result.entry.pending = false; }
  };
  const prepare = async (input: unknown, guard: MutationGuard, signal?: AbortSignal): Promise<Candidate> => {
    noPreview(); checkAbort(signal); const document = normalizeDocument(input);
    if (candidates.size >= maxCandidates) fail('RESOURCE_LIMIT', '$.candidates', `Retained candidate limit ${maxCandidates} reached.`, 'Discard unused candidates.');
    const identity = await documentIdentity(document);
    checkAbort(signal);
    const frame = await evaluator.evaluate({ document, params: parameterValues(document, {}), time: 0 }, signal);
    checkAbort(signal); current(guard); noPreview();
    if (candidates.size >= maxCandidates) fail('RESOURCE_LIMIT', '$.candidates', `Retained candidate limit ${maxCandidates} reached.`, 'Discard unused candidates.');
    const candidate: Candidate = freeze({ id: crypto.randomUUID(), document, identity, baseVersion: guard.expectedVersion, frame, status: 'validated' });
    candidates.set(candidate.id, candidate); emit('candidate', guard); live(); return candidate;
  };
  const schedule = () => {
    if (!state.playing || !state.document || !state.run) return;
    const epoch = playbackEpoch; const document = state.document; const runId = state.run.id;
    const step = document.time?.step ?? 1 / 30;
    timer = setTimeout(async () => {
      if (epoch !== playbackEpoch || !state.playing || !state.run) return;
      const controller = new AbortController(); activeTick = controller;
      try {
        const frame = await evaluator.evaluate({ document, params: state.run.params, time: state.run.time + step }, controller.signal);
        if (epoch !== playbackEpoch || state.run?.id !== runId || !state.playing) return;
        const acceptedFrame = { ...frame, datasets: copy(state.document?.datasets ?? {}) };
        update({ frame: acceptedFrame, run: { ...state.run, time: frame.time }, playing: !frame.terminal }, 'change', undefined, false);
        if (frame.terminal) stopClock(); else schedule();
      } catch (error) {
        if (epoch !== playbackEpoch || state.status === 'disposed') return;
        stopClock(); update({ playing: false, error: [{ code: 'PLAYBACK_FAILURE', path: '$.time', message: error instanceof Error ? error.message : 'Playback failed.', recovery: 'Retry playback or inspect the model.' }] }, 'error', undefined, false);
      }
    }, Math.max(16, Math.min(1000, step * 1000)));
  };
  const session: VisualizationSession = {
    id,
    getState: () => state,
    subscribe(listener) { live(); listeners.add(listener); listener(freeze({ type: 'ready', state })); return () => { listeners.delete(listener); }; },
    createCandidate(input, guard, signal) { input = copy(input); guard = copy(guard); return asyncOperation('createCandidate', input, guard, () => prepare(input, guard, signal)); },
    reviseCandidate(edits, guard, signal) { edits = copy(edits); guard = copy(guard); return asyncOperation('reviseCandidate', edits, guard, async () => { ready(); return prepare(applyEdits(state.document!, edits), guard, signal); }); },
    commitCandidate(candidateId, guard, signal) { guard = copy(guard); return asyncOperation('commitCandidate', candidateId, guard, async () => {
      checkAbort(signal); current(guard); noPreview(); const candidate = candidates.get(candidateId);
      if (!candidate) fail('NOT_FOUND', '$.candidateId', 'Candidate is missing, discarded, or already committed.');
      if (candidate.baseVersion !== state.version) fail('CONFLICT', '$.candidateId', 'Accepted state changed since candidate preparation.', 'Prepare a new candidate against current state.');
      const presentationOnly = state.identity?.modelRevision === candidate.identity.modelRevision;
      if (presentationOnly) {
        const datasets = candidate.document.datasets ?? {};
        const frame = canonical(state.frame!.datasets) === canonical(datasets) ? state.frame! : { ...state.frame!, datasets: copy(datasets) };
        const selection = state.selection !== null && !semanticIds(candidate.document).has(state.selection) ? null : state.selection;
        update({ document: candidate.document, identity: candidate.identity, frame, selection, error: null }, 'change', guard);
      }
      else { stopClock(); retain(); update({ status: 'ready', document: candidate.document, identity: candidate.identity, run: run(candidate.document, candidate.identity), frame: candidate.frame, playing: false, selection: null, preview: null, error: null }, 'change', guard); }
      candidates.delete(candidateId); return state;
    }); },
    discardCandidate(candidateId, guard) { syncOperation('discardCandidate', candidateId, guard, () => { current(guard); noPreview(); if (!candidates.delete(candidateId)) fail('NOT_FOUND', '$.candidateId', 'Candidate does not exist.'); emit('candidate', guard); }); },
    setParameters(params, guard, signal) { params = copy(params); guard = copy(guard); return asyncOperation('setParameters', params, guard, async () => {
      ready(); checkAbort(signal); const document = state.document!; const identity = state.identity!;
      const values = parameterValues(document, params, state.run!.params);
      const frame = await evaluator.evaluate({ document, params: values, time: 0 }, signal);
      checkAbort(signal); current(guard); stopClock(); retain();
      update({ run: run(document, identity, values), frame, preview: null, playing: false, error: null }, 'change', guard); return state;
    }); },
    previewParameters(params, guard) { syncOperation('previewParameters', params, guard, () => { current(guard); ready(); const preview = parameterValues(state.document!, params, state.run!.params); stopClock(); update({ preview, playing: false, error: null }, 'change', guard); }); },
    cancelPreview(guard) { syncOperation('cancelPreview', null, guard, () => { current(guard); update({ preview: null, error: null }, 'change', guard); }); },
    seek(time, guard, signal) { guard = copy(guard); return asyncOperation('seek', time, guard, async () => {
      ready(); noPreview(); checkAbort(signal); if (!state.document!.time) fail('UNSUPPORTED_CAPABILITY', '$.time', 'This parametric document has no time domain.'); if (!Number.isFinite(time) || time < 0) fail('INVALID_TIME', '$.time', 'Time must be finite and nonnegative.');
      const frame = await evaluator.evaluate({ document: state.document!, params: state.run!.params, time }, signal);
      checkAbort(signal); current(guard); noPreview(); stopClock(); update({ frame, run: { ...state.run!, time: frame.time, version: state.run!.version + 1 }, playing: false, error: null }, 'change', guard); return state;
    }); },
    play(guard) { syncOperation('play', null, guard, () => { current(guard); ready(); noPreview(); if (!state.document!.time) fail('UNSUPPORTED_CAPABILITY', '$.time', 'This parametric document has no playback.'); if (state.frame!.terminal) fail('AT_BOUNDARY', '$.time', 'Playback has reached its exact end.', 'Seek to an earlier time before playing.'); stopClock(); update({ playing: true, error: null }, 'change', guard); schedule(); }); },
    pause(guard) { syncOperation('pause', null, guard, () => { current(guard); noPreview(); stopClock(); update({ playing: false, error: null }, 'change', guard); }); },
    select(selection, guard) { syncOperation('select', selection, guard, () => { current(guard); ready(); noPreview(); if (selection !== null && !semanticIds(state.document!).has(selection)) fail('NOT_FOUND', '$.selection', 'No matching semantic object.'); update({ selection, error: null }, 'selection', guard); }); },
    exportDocument() { ready(); noPreview(); return copy({ format: 'experiment-kit-document', version: '2.0', runtimeVersion: DOCUMENT_RUNTIME_VERSION, document: state.document!, identity: state.identity!, run: state.run!, selection: state.selection, comparisons }); },
    restoreDocument(input, guard, signal) { input = copy(input); guard = copy(guard); return asyncOperation('restoreDocument', input, guard, async () => {
      noPreview(); checkAbort(signal);
      const artifact = record(input, '$'); exactKeys(artifact, ['format', 'version', 'runtimeVersion', 'document', 'identity', 'run', 'selection', 'comparisons'], '$');
      if (artifact.format !== 'experiment-kit-document' || artifact.version !== '2.0' || artifact.runtimeVersion !== DOCUMENT_RUNTIME_VERSION) fail('INCOMPATIBLE_ARTIFACT', '$.version', 'Artifact format or exact runtime version is incompatible.', 'Use the original runtime; legacy 1.0 bundles remain independently playable.');
      if (!Array.isArray(artifact.comparisons) || artifact.comparisons.length >= maxRuns) fail('RESOURCE_LIMIT', '$.comparisons', `At most ${maxRuns - 1} retained comparisons are supported.`);
      const validateSaved = async (input: unknown, path: string): Promise<SavedRun & { frame: DocumentFrame }> => {
        checkAbort(signal); const saved = record(input, path); exactKeys(saved, ['document', 'identity', 'run'], path);
        const document = normalizeDocument(saved.document); const identity = await documentIdentity(document);
        if (canonical(identity) !== canonical(saved.identity)) fail('REVISION_MISMATCH', `${path}.identity`, 'Artifact does not match its exact document, model and presentation revisions.');
        const savedRun = record(saved.run, `${path}.run`); exactKeys(savedRun, ['id', 'version', 'params', 'time', 'modelRevision', 'restoredFrom'], `${path}.run`);
        if (typeof savedRun.id !== 'string' || savedRun.id.length > 128 || !savedRun.id.length || !Number.isSafeInteger(savedRun.version) || (savedRun.version as number) < 0 || savedRun.modelRevision !== identity.modelRevision || typeof savedRun.time !== 'number' || !Number.isFinite(savedRun.time) || savedRun.time < 0 || (savedRun.restoredFrom !== undefined && (typeof savedRun.restoredFrom !== 'string' || savedRun.restoredFrom.length > 128))) fail('INVALID_ARTIFACT', `${path}.run`, 'Invalid saved run or mismatched model revision.');
        const rawParams = record(savedRun.params, `${path}.run.params`);
        if (Object.keys(rawParams).length !== Object.keys(document.parameters).length) fail('INVALID_ARTIFACT', `${path}.run.params`, 'Saved runs require every parameter.');
        const params = parameterValues(document, rawParams as Record<string, number>);
        const frame = await evaluator.evaluate({ document, params, time: savedRun.time }, signal);
        if (frame.time !== savedRun.time) fail('INVALID_ARTIFACT', `${path}.run.time`, 'Saved time lies outside the model domain.');
        return { document, identity, run: { ...(savedRun as unknown as DocumentRun), params }, frame };
      };
      const accepted = await validateSaved({ document: artifact.document, identity: artifact.identity, run: artifact.run }, '$');
      const restoredComparisons: SavedRun[] = [];
      for (const [index, saved] of artifact.comparisons.entries()) { const { frame: _, ...valid } = await validateSaved(saved, `$.comparisons[${index}]`); restoredComparisons.push(valid); }
      if (new Set(restoredComparisons.map(saved => saved.run.id)).size !== restoredComparisons.length) fail('INVALID_ARTIFACT', '$.comparisons', 'Duplicate comparison run IDs.');
      if (artifact.selection !== null && (typeof artifact.selection !== 'string' || !semanticIds(accepted.document).has(artifact.selection))) fail('INVALID_ARTIFACT', '$.selection', 'Selection refers to an unknown semantic object.');
      checkAbort(signal); current(guard); noPreview(); stopClock(); comparisons = restoredComparisons; candidates.clear();
      update({ status: 'ready', document: accepted.document, identity: accepted.identity, run: run(accepted.document, accepted.identity, accepted.run.params, accepted.frame.time, accepted.run.id), frame: accepted.frame, selection: artifact.selection as string | null, preview: null, playing: false, error: null }, 'change', guard); return state;
    }); },
    dispose() { if (state.status === 'disposed') return; stopClock(); evaluator.dispose(); candidates.clear(); receipts.clear(); comparisons = []; update({ status: 'disposed', document: null, identity: null, run: null, frame: null, playing: false, preview: null, selection: null }, 'disposed'); listeners.clear(); },
  };
  return session;
}
