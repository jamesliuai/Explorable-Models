import { asExperimentError, ExperimentError } from './errors.js';
import { clone, createId, deepFreeze, digest } from './identity.js';
import { DEFAULT_RATE_HZ, RUNTIME_VERSION, SCHEMA_VERSION, type CheckCase, type CheckReport, type CheckSuite, type CommandResult, type Comparison, type Evaluation, type ExperimentDefinition, type Inspection, type ModelExecutor, type MutationGuard, type NumericValue, type Run, type RunFrame, type RuntimeCommand, type RuntimeState, type SampleResult, type ScalarParams, type Snapshot, type TimeDomain, type TimePoint, type ViewState } from './types.js';
import { defaultParameters, isRecord, LIMITS, validateCheckSuite, validateCommand, validateEvaluation, validateManifest, validateParameters, validateSnapshot, validateTimeDomain, validateViews, validateViewState } from './validation.js';
import { trustedInlineExecutor } from './worker.js';
const defaultView = (): ViewState => ({ selectedIds: [], layers: {}, playbackSpeed: 1 });
export class ExperimentRuntime {
    private definition: ExperimentDefinition;
    private executor: ModelExecutor;
    private runs = new Map<string, Run>();
    private pinned = new Set<string>();
    private activeRunId = '';
    private view = defaultView();
    private viewVersion = 0;
    private preview?: RuntimeState['preview'];
    private lastError?: RuntimeState['lastError'];
    private listeners = new Set<(state: RuntimeState) => void>();
    private queue: Promise<unknown> = Promise.resolve();
    private disposed = false;
    private clockTime = 0;
    private revisions = new Map<string, {
        definition: ExperimentDefinition;
        executor: ModelExecutor;
    }>();
    private constructor(definition: ExperimentDefinition, executor: ModelExecutor) { this.definition = definition; this.executor = executor; this.revisions.set(definition.definitionRevision, { definition, executor }); }
    static async create(definition: ExperimentDefinition, executor?: ModelExecutor): Promise<ExperimentRuntime> {
        const checked = ExperimentRuntime.checkDefinition(definition);
        const selectedExecutor = executor ?? (definition.model ? trustedInlineExecutor(definition.model, checked.manifest) : undefined);
        if (!selectedExecutor)
            throw new ExperimentError('MODEL_ERROR', 'Provide a model worker executor.');
        if (definition.model && definition.model.kind !== checked.manifest.kind)
            throw new ExperimentError('INVALID_MANIFEST', 'Model kind does not match the manifest.');
        const runtime = new ExperimentRuntime(checked, selectedExecutor);
        const run = await runtime.makeRun(defaultParameters(checked.manifest));
        runtime.runs.set(run.id, run);
        runtime.activeRunId = run.id;
        runtime.clockTime = run.frame.timePoint.time;
        return runtime;
    }
    private static checkDefinition(definition: ExperimentDefinition): ExperimentDefinition {
        if (!definition || typeof definition.definitionRevision !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(definition.definitionRevision))
            throw new ExperimentError('INVALID_MANIFEST', 'definitionRevision must be a SHA-256 content digest.');
        const manifest = validateManifest(definition.manifest);
        const views = definition.views ? validateViews(definition.views, manifest) : undefined;
        return deepFreeze({ manifest, definitionRevision: definition.definitionRevision, ...(views ? { views } : {}), ...(definition.modelCard ? { modelCard: definition.modelCard } : {}) });
    }
    private get active(): Run { const run = this.runs.get(this.activeRunId); if (!run)
        throw new ExperimentError('NOT_FOUND', 'No active run.'); return run; }
    private enqueue<T>(work: () => Promise<T>): Promise<T> {
        const operation = this.queue.then(async () => { if (this.disposed)
            throw new ExperimentError('MODEL_ERROR', 'Runtime is disposed.'); try {
            return await work();
        }
        catch (error) {
            const failure = asExperimentError(error);
            this.lastError = failure.toJSON();
            this.emit();
            throw failure;
        } });
        this.queue = operation.catch(() => undefined);
        return operation;
    }
    private emit() { const state = this.getState(); for (const listener of this.listeners) {
        try {
            listener(state);
        }
        catch { /* A consumer must not disrupt the authoritative command queue. */ }
    } }
    private clearError() { this.lastError = undefined; }
    getState(): RuntimeState { const run = this.active; return clone({ activeRunId: this.activeRunId, run, frame: this.preview?.frame ?? run.frame, view: this.view, viewVersion: this.viewVersion, ...(this.preview ? { preview: this.preview } : {}), ...(this.lastError ? { lastError: this.lastError } : {}) }); }
    subscribe(listener: (state: RuntimeState) => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
    guard(): MutationGuard { return { expectedRunVersion: this.active.version, expectedActiveRunId: this.activeRunId }; }
    describe() { return clone({ ...this.definition, runtimeVersion: RUNTIME_VERSION, limits: LIMITS, clockRateHz: DEFAULT_RATE_HZ, activeRunId: this.activeRunId, runVersion: this.active.version, viewVersion: this.viewVersion }); }
    listRuns(): Run[] { return clone([...this.runs.values()]); }
    /** Resolve the active revision’s valid interval without changing the learner’s run. */
    getTimeDomain(parameters?: ScalarParams): Promise<TimeDomain> {
        let patch: ScalarParams;
        try { patch = clone(parameters ?? {}); } catch { return Promise.reject(new ExperimentError('INVALID_PARAMETER', 'Domain parameters must be cloneable JSON data.')); }
        return this.enqueue(async () => this.domain(validateParameters(this.definition.manifest, patch, this.active.parameters)));
    }

    private checkGuard(guard: MutationGuard) { if (guard.expectedActiveRunId !== this.activeRunId || guard.expectedRunVersion !== this.active.version)
        throw new ExperimentError('CONFLICT', 'The learner’s current run changed after this command was prepared.', { currentVersion: this.active.version, currentActiveRunId: this.activeRunId }); }
    private ensureIdle() { if (this.preview)
        throw new ExperimentError('BUSY', 'A parameter control gesture is being previewed.'); }
    private async domain(params: ScalarParams, executor = this.executor, definition = this.definition): Promise<TimeDomain> { return validateTimeDomain(await executor.timeDomain(clone(params)), definition.manifest.kind); }
    private timePoint(time: number, domain: TimeDomain, mode: 'grid' | 'sample' = 'grid'): TimePoint {
        if (!Number.isFinite(time) || time < domain.start || (domain.end !== null && time > domain.end))
            throw new ExperimentError('OUT_OF_DOMAIN', `Requested time ${time} is outside [${domain.start}, ${domain.end ?? 'unbounded'}].`, { field: 'time' });
        if (this.definition.manifest.kind === 'parametric') {
            if (time !== 0)
                throw new ExperimentError('OUT_OF_DOMAIN', 'Parametric experiments have no clock; their time is zero.');
            return { kind: 'sample', time: 0 };
        }
        if (domain.end !== null && time === domain.end)
            return { kind: 'event', time, eventId: domain.endEventId ?? 'terminal' };
        if (mode === 'sample')
            return { kind: 'sample', time };
        const tick = Math.round(time * DEFAULT_RATE_HZ);
        const canonical = tick / DEFAULT_RATE_HZ;
        if (canonical < domain.start)
            return { kind: 'sample', time: domain.start };
        if (domain.end !== null && canonical >= domain.end)
            return { kind: 'event', time: domain.end, eventId: domain.endEventId ?? 'terminal' };
        return { kind: 'grid', time: canonical, tick, rateHz: DEFAULT_RATE_HZ };
    }
    private async evaluate(params: ScalarParams, point: TimePoint, identity: {
        runId: string;
        version: number;
    }, status: RunFrame['status'], previewId?: string, executor = this.executor, definition = this.definition): Promise<RunFrame> {
        const evaluation = validateEvaluation(definition.manifest, await executor.evaluate(clone(params), point.time));
        const terminal = point.kind === 'event';
        return deepFreeze({ ...evaluation, definitionRevision: definition.definitionRevision, runId: identity.runId, runVersion: identity.version, timePoint: point, frameId: digest({ revision: definition.definitionRevision, runId: identity.runId, version: identity.version, timePoint: point, ...(previewId ? { previewId, parameters: params } : {}) }), status: terminal ? 'boundary' : status, ...(previewId ? { previewId } : {}) });
    }
    private async makeRun(parameters: ScalarParams, point?: TimePoint, restoredFrom?: string): Promise<Run> {
        const checked = validateParameters(this.definition.manifest, parameters);
        const domain = await this.domain(checked);
        const requested = point ?? this.timePoint(domain.start, domain);
        this.timePoint(requested.time, domain, 'sample');
        if (requested.kind === 'event' && (requested.time !== domain.end || requested.eventId !== (domain.endEventId ?? 'terminal')))
            throw new ExperimentError('INCOMPATIBLE_SNAPSHOT', 'Snapshot event does not match this model’s boundary.');
        const id = createId('run');
        const frame = await this.evaluate(checked, requested, { runId: id, version: 0 }, point ? 'paused' : 'ready');
        return deepFreeze({ id, definitionRevision: this.definition.definitionRevision, version: 0, parameters: checked, frame, ...(restoredFrom ? { restoredFrom } : {}) });
    }
    private adopt(run: Run): CommandResult {
        const previousRunId = this.activeRunId;
        this.runs.set(run.id, run);
        this.activeRunId = run.id;
        this.clockTime = run.frame.timePoint.time;
        this.preview = undefined;
        this.clearError();
        while (this.runs.size > LIMITS.runs) {
            const discard = [...this.runs.keys()].find(id => id !== this.activeRunId && !this.pinned.has(id));
            if (!discard)
                break;
            this.runs.delete(discard);
        }
        this.emit();
        return { state: this.getState(), previousRunId };
    }
    private async changeFrame(point: TimePoint, status: RunFrame['status'], increment = true): Promise<CommandResult> {
        const run = this.active;
        const version = run.version + (increment ? 1 : 0);
        const frame = await this.evaluate(run.parameters, point, { runId: run.id, version }, status);
        this.runs.set(run.id, deepFreeze({ ...run, version, frame }));
        this.clockTime = point.time;
        this.clearError();
        this.emit();
        return { state: this.getState() };
    }
    command(rawCommand: RuntimeCommand): Promise<CommandResult> {
        let command: RuntimeCommand;
        try { command = validateCommand(rawCommand); } catch (error) { return Promise.reject(asExperimentError(error)); }
        return this.enqueue(async () => {
            if (!command || typeof command !== 'object' || Array.isArray(command) || typeof command.type !== 'string')
                throw new ExperimentError('INVALID_COMMAND', 'Command must have a type.');
            const previewCommand = ['update_preview', 'commit_preview', 'cancel_preview'].includes(command.type);
            if (!previewCommand)
                this.ensureIdle();
            if (command.type === 'set_view') {
                if (command.expectedViewVersion !== this.viewVersion)
                    throw new ExperimentError('CONFLICT', 'View state changed.', { currentVersion: this.viewVersion });
                if (!isRecord(command.view))
                    throw new ExperimentError('INVALID_COMMAND', 'View patch must be an object.');
                const view = validateViewState({ ...this.view, ...command.view, layers: { ...this.view.layers, ...command.view.layers } }, this.definition.manifest);
                this.view = view;
                this.viewVersion++;
                this.clearError();
                this.emit();
                return { state: this.getState() };
            }
            this.checkGuard(command as MutationGuard);
            const run = this.active;
            switch (command.type) {
                case 'set_parameters': return this.adopt(await this.makeRun(validateParameters(this.definition.manifest, command.parameters, run.parameters)));
                case 'restore': {
                    const snapshot = validateSnapshot(command.snapshot, this.definition.manifest, this.definition.definitionRevision, RUNTIME_VERSION);
                    const next = await this.makeRun(snapshot.parameters, snapshot.timePoint, snapshot.runId);
                    this.view = snapshot.view;
                    this.viewVersion++;
                    return this.adopt(next);
                }
                case 'begin_preview': {
                    const parameters = validateParameters(this.definition.manifest, command.parameters, run.parameters);
                    const id = createId('preview');
                    const domain = await this.domain(parameters);
                    const frame = await this.evaluate(parameters, this.timePoint(domain.start, domain), { runId: run.id, version: run.version }, 'paused', id);
                    this.preview = { id, parameters, frame };
                    this.clearError();
                    this.emit();
                    return { state: this.getState() };
                }
                case 'update_preview': {
                    if (!this.preview || this.preview.id !== command.previewId)
                        throw new ExperimentError('CONFLICT', 'The preview gesture is no longer active.');
                    const parameters = validateParameters(this.definition.manifest, command.parameters, run.parameters);
                    const domain = await this.domain(parameters);
                    const frame = await this.evaluate(parameters, this.timePoint(domain.start, domain), { runId: run.id, version: run.version }, 'paused', this.preview.id);
                    this.preview = { ...this.preview, parameters, frame };
                    this.clearError();
                    this.emit();
                    return { state: this.getState() };
                }
                case 'commit_preview': {
                    if (!this.preview || this.preview.id !== command.previewId)
                        throw new ExperimentError('CONFLICT', 'The preview gesture is no longer active.');
                    return this.adopt(await this.makeRun(this.preview.parameters));
                }
                case 'cancel_preview': {
                    if (!this.preview || this.preview.id !== command.previewId)
                        throw new ExperimentError('CONFLICT', 'The preview gesture is no longer active.');
                    this.preview = undefined;
                    this.clearError();
                    this.emit();
                    return { state: this.getState() };
                }
                case 'play':
                    if (this.definition.manifest.kind === 'parametric')
                        throw new ExperimentError('UNSUPPORTED_CAPABILITY', 'Parametric experiments have no playback clock.');
                    if (run.frame.status === 'boundary')
                        throw new ExperimentError('OUT_OF_DOMAIN', 'The terminal event has been reached. Reset or seek before playing.');
                    return this.changeFrame(run.frame.timePoint, 'running');
                case 'pause': return this.changeFrame(run.frame.timePoint, 'paused');
                case 'reset': {
                    const domain = await this.domain(run.parameters);
                    return this.changeFrame(this.timePoint(domain.start, domain), 'ready');
                }
                case 'seek': {
                    const domain = await this.domain(run.parameters);
                    return this.changeFrame(this.timePoint(command.time, domain), 'paused');
                }
                case 'step': {
                    if (this.definition.manifest.kind === 'parametric')
                        throw new ExperimentError('UNSUPPORTED_CAPABILITY', 'Parametric experiments do not support time steps.');
                    const domain = await this.domain(run.parameters);
                    const time = Math.min(run.frame.timePoint.time + 1 / DEFAULT_RATE_HZ, domain.end ?? Number.MAX_VALUE);
                    return this.changeFrame(this.timePoint(time, domain), 'paused');
                }
                default: throw new ExperimentError('INVALID_COMMAND', `Unsupported command ${(command as {
                    type: string;
                }).type}.`);
            }
        });
    }
    /** Advance playback by wall time; accepted playback ticks never increment runVersion. */
    tick(deltaSeconds: number): Promise<RuntimeState> {
        return this.enqueue(async () => {
            if (!Number.isFinite(deltaSeconds) || deltaSeconds < 0 || deltaSeconds > 60)
                throw new ExperimentError('INVALID_PARAMETER', 'Playback delta must be between 0 and 60 seconds.');
            if (this.preview || this.active.frame.status !== 'running')
                return this.getState();
            const domain = await this.domain(this.active.parameters);
            const nextTime = this.clockTime + deltaSeconds * this.view.playbackSpeed;
            const target = Math.min(nextTime, domain.end ?? Number.MAX_VALUE);
            const point = this.timePoint(target, domain);
            const result = point.time === this.active.frame.timePoint.time ? { state: this.getState() } : await this.changeFrame(point, 'running', false);
            this.clockTime = target;
            return result.state;
        });
    }
    inspect(quantityIds?: readonly string[]): Inspection {
        const state = this.getState();
        const frame = state.frame;
        const requested = quantityIds ?? Object.keys(this.definition.manifest.quantities);
        if (!Array.isArray(requested) || requested.some(id => typeof id !== 'string')) throw new ExperimentError('INVALID_PARAMETER', 'Quantity IDs must be a string array.');
        if (requested.length > LIMITS.quantities)
            throw new ExperimentError('RESOURCE_LIMIT', 'Too many inspected quantities.');
        const quantities: Inspection['quantities'] = {};
        for (const id of requested) {
            const metadata = this.definition.manifest.quantities[id];
            if (!Object.hasOwn(this.definition.manifest.quantities, id))
                throw new ExperimentError('NOT_FOUND', `Unknown quantity ${id}.`);
            quantities[id] = { ...metadata, ...frame.quantities[id]! };
        }
        return clone({ experimentId: this.definition.manifest.id, definitionRevision: frame.definitionRevision, runId: frame.runId, runVersion: frame.runVersion, frameId: frame.frameId, timePoint: frame.timePoint, status: frame.status, parameters: state.preview?.parameters ?? state.run.parameters, quantities, entities: this.definition.manifest.entities ?? [], selectedIds: this.view.selectedIds, viewVersion: this.viewVersion, assumptions: this.definition.manifest.assumptions, ...(state.preview ? { preview: { previewId: state.preview.id, tentative: true as const } } : {}) });
    }
    sample(request: {
        parameters?: ScalarParams;
        times: readonly number[];
    }): Promise<SampleResult> {
        let prepared: typeof request;
        try { prepared = clone(request); } catch { return Promise.reject(new ExperimentError('INVALID_PARAMETER', 'Sample request must contain cloneable JSON data.')); }
        return this.enqueue(async () => this.sampleInternal(prepared));
    }
    private async sampleInternal(request: {
        parameters?: ScalarParams;
        times: readonly number[];
    }, runId = createId('sample'), runVersion = 0): Promise<SampleResult> {
        if (!request || !Array.isArray(request.times) || !request.times.length || request.times.length > LIMITS.samples)
            throw new ExperimentError('RESOURCE_LIMIT', `Supply between 1 and ${LIMITS.samples} sample times.`);
        const parameters = validateParameters(this.definition.manifest, request.parameters ?? {}, this.active.parameters);
        const domain = await this.domain(parameters);
        const frames: RunFrame[] = [];
        for (const time of request.times) {
            const point = this.timePoint(time, domain, 'sample');
            frames.push(await this.evaluate(parameters, point, { runId, version: runVersion }, 'paused'));
        }
        return { definitionRevision: this.definition.definitionRevision, parameters, frames };
    }
    createRun(parameters: ScalarParams, guard: MutationGuard): Promise<CommandResult> { return this.command({ type: 'set_parameters', parameters, ...guard }); }
    checkpoint(annotations?: string, comparisonReferences: readonly string[] = []): Snapshot {
        this.ensureIdle();
        if (annotations !== undefined && (typeof annotations !== 'string' || annotations.length > 10000))
            throw new ExperimentError('INVALID_PARAMETER', 'Annotations must be at most 10,000 characters.');
        if (!Array.isArray(comparisonReferences) || comparisonReferences.length > 16 || comparisonReferences.some(id => !this.runs.has(id)))
            throw new ExperimentError('NOT_FOUND', 'Comparison references must name at most 16 retained runs.');
        if (new Set([...this.pinned, this.activeRunId, ...comparisonReferences]).size > 64)
            throw new ExperimentError('RESOURCE_LIMIT', 'At most 64 runs may be retained as checkpoints in this session. Export snapshots before starting a new session.');
        this.pinned.add(this.activeRunId);
        comparisonReferences.forEach(id => this.pinned.add(id));
        return clone({ schemaVersion: SCHEMA_VERSION, experimentId: this.definition.manifest.id, definitionRevision: this.definition.definitionRevision, runtimeVersion: RUNTIME_VERSION, runId: this.activeRunId, runVersion: this.active.version, parameters: this.active.parameters, timePoint: this.active.frame.timePoint, view: this.view, viewVersion: this.viewVersion, comparisonReferences, ...(annotations === undefined ? {} : { annotations }), createdAt: new Date().toISOString() });
    }
    compare(rawRequest: {
        runIds: readonly string[];
        times: readonly number[];
    }): Promise<Comparison> {
        let request: typeof rawRequest;
        try { request = clone(rawRequest); } catch { return Promise.reject(new ExperimentError('INVALID_PARAMETER', 'Comparison request must contain cloneable JSON data.')); }
        return this.enqueue(async () => {
            if (!request || !Array.isArray(request.runIds) || request.runIds.length < 2 || request.runIds.length > 8 || new Set(request.runIds).size !== request.runIds.length)
                throw new ExperimentError('INVALID_PARAMETER', 'Compare 2 to 8 distinct retained runs.');
            if (!Array.isArray(request.times) || request.times.length < 1 || request.times.length * request.runIds.length > LIMITS.samples)
                throw new ExperimentError('RESOURCE_LIMIT', 'Comparison exceeds the total sample limit.');
            const selected = request.runIds.map(id => { const run = this.runs.get(id); if (!run)
                throw new ExperimentError('NOT_FOUND', `Run ${id} is no longer retained.`); if (run.definitionRevision !== this.definition.definitionRevision)
                throw new ExperimentError('INCOMPATIBLE_SNAPSHOT', 'Compare runs from the same definition revision.'); return run; });
            const runs: Comparison['runs'] = [];
            for (const run of selected) {
                const domain = await this.domain(run.parameters);
                for (const time of request.times)
                    if (!Number.isFinite(time) || time < domain.start)
                        throw new ExperimentError('OUT_OF_DOMAIN', 'Comparison times must be finite and inside each run’s domain.');
                const validTimes = request.times.filter(time => domain.end === null || time <= domain.end);
                const end = domain.end;
                if (end !== null && request.times.some(time => time > end) && !validTimes.includes(end))
                    validTimes.push(end);
                const frames = validTimes.length ? (await this.sampleInternal({ parameters: run.parameters, times: validTimes }, run.id, run.version)).frames : [];
                runs.push({ runId: run.id, parameters: run.parameters, frames, domain });
            }
            const parameterDifferences: Comparison['parameterDifferences'] = {};
            for (const key of Object.keys(this.definition.manifest.parameters)) {
                const values = selected.map(run => ({ runId: run.id, value: run.parameters[key]! }));
                if (values.some(v => v.value !== values[0]!.value))
                    parameterDifferences[key] = values;
            }
            return clone({ alignment: 'time', definitionRevision: this.definition.definitionRevision, runs, parameterDifferences });
        });
    }
    verify(rawSuite: CheckSuite): Promise<CheckReport> {
        let suite: CheckSuite;
        try { suite = validateCheckSuite(rawSuite); } catch (error) { return Promise.reject(asExperimentError(error)); }
        return this.enqueue(async () => {
            if (!suite || typeof suite.id !== 'string' || typeof suite.version !== 'string' || typeof suite.author !== 'string' || !['reference', 'author'].includes(suite.provenance) || !Array.isArray(suite.cases) || suite.cases.length < 1 || suite.cases.length > LIMITS.samples)
                throw new ExperimentError('INVALID_PARAMETER', 'Invalid or oversized check suite.');
            const results: CheckReport['results'] = [];
            for (const check of suite.cases as readonly CheckCase[]) {
                const parameters = validateParameters(this.definition.manifest, check.parameters ?? {});
                const time = check.time ?? 0;
                const assertions: CheckReport['results'][number]['assertions'] = [];
                try {
                    const sampled = await this.sampleInternal({ parameters, times: [time] });
                    for (const [quantityId, expected] of Object.entries(check.expected)) {
                        const observed = sampled.frames[0]!.quantities[quantityId];
                        if (!Object.hasOwn(sampled.frames[0]!.quantities, quantityId))
                            throw new ExperimentError('NOT_FOUND', `Check names unknown quantity ${quantityId}.`);
                        const atol = check.atol ?? 1e-9;
                        const rtol = check.rtol ?? 1e-8;
                        if (!Number.isFinite(atol) || !Number.isFinite(rtol) || atol < 0 || rtol < 0)
                            throw new ExperimentError('INVALID_PARAMETER', 'Check tolerances must be finite and nonnegative.');
                        const passed = close(observed.value, expected, atol, rtol) && observed.status === (check.statuses?.[quantityId] ?? (expected === null ? 'undefined' : 'valid'));
                        assertions.push({ quantityId, observed: observed.value, expected, passed, atol, rtol });
                    }
                    results.push({ id: check.id, label: check.label, parameters, time, assertions, passed: assertions.length > 0 && assertions.every(a => a.passed) });
                }
                catch (error) {
                    results.push({ id: check.id, label: check.label, parameters, time, assertions, passed: false, error: asExperimentError(error).toJSON() });
                }
            }
            return { definitionRevision: this.definition.definitionRevision, runtimeVersion: RUNTIME_VERSION, suiteId: suite.id, suiteVersion: suite.version, author: suite.author, provenance: suite.provenance, category: 'quantitative', createdAt: new Date().toISOString(), passed: results.every(result => result.passed), results, modelReview: this.definition.manifest.review ?? { status: 'unreviewed' }, learnerEvidence: 'not_evaluated' };
        });
    }
    activateRevision(definition: ExperimentDefinition, executor: ModelExecutor, report: CheckReport, guard: MutationGuard & {
        expectedDefinitionRevision: string;
    }): Promise<CommandResult> {
        return this.enqueue(async () => {
            this.ensureIdle();
            this.checkGuard(guard);
            if (guard.expectedDefinitionRevision !== this.definition.definitionRevision)
                throw new ExperimentError('CONFLICT', 'The active definition revision changed.');
            const checked = ExperimentRuntime.checkDefinition(definition);
            if (!report?.passed || report.definitionRevision !== checked.definitionRevision || report.runtimeVersion !== RUNTIME_VERSION || !report.results.length || report.results.some(result => !result.passed))
                throw new ExperimentError('MODEL_ERROR', 'Only a candidate with passing checks for its exact revision can be activated.');
            if (checked.manifest.id !== this.definition.manifest.id)
                throw new ExperimentError('INCOMPATIBLE_SNAPSHOT', 'Candidate must describe the same experiment.');
            const candidate = await ExperimentRuntime.create(checked, executor);
            const run = candidate.active;
            this.definition = checked;
            this.executor = executor;
            this.revisions.set(checked.definitionRevision, { definition: checked, executor });
            this.view = defaultView();
            this.viewVersion++;
            return this.adopt(run);
        });
    }
    dispose() { if (this.disposed)
        return; this.disposed = true; for (const { executor } of this.revisions.values())
        executor.dispose?.(); this.listeners.clear(); }
}
export function close(observed: NumericValue | null, expected: NumericValue | null, atol = 1e-9, rtol = 1e-8): boolean {
    if (expected === null || observed === null)
        return expected === observed;
    if (typeof expected === 'number' && typeof observed === 'number')
        return Number.isFinite(expected) && Number.isFinite(observed) && Math.abs(observed - expected) <= atol + rtol * Math.abs(expected);
    return Array.isArray(expected) && Array.isArray(observed) && expected.length === observed.length && expected.every((v, i) => close(observed[i]!, v, atol, rtol));
}
