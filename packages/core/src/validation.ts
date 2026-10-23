import { ExperimentError } from './errors.js';
import { clone } from './identity.js';
import type { Evaluation, Manifest, ParameterDefinition, ScalarParams, Snapshot, TimeDomain, TimePoint, ViewDefinition, ViewState } from './types.js';
export const LIMITS = Object.freeze({ parameters: 64, quantities: 256, vectorElements: 64, geometryElements: 50000, samples: 1000, runs: 256, snapshotBytes: 256000 });
const unsafeKeys = new Set(['__proto__', 'constructor', 'prototype']);
export function isRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value) && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}
function record(value: unknown, field: string): asserts value is Record<string, unknown> { if (!isRecord(value))
    throw new ExperimentError('INVALID_MANIFEST', `${field} must be a plain object.`, { field }); }
function keys(value: Record<string, unknown>, allowed: readonly string[], field: string) { for (const key of Object.keys(value))
    if (!allowed.includes(key) || unsafeKeys.has(key))
        throw new ExperimentError('INVALID_MANIFEST', `Unknown field ${field}.${key}.`, { field: `${field}.${key}` }); }
function text(value: unknown, field: string, max = 4000): asserts value is string { if (typeof value !== 'string' || value.length === 0 || value.length > max)
    throw new ExperimentError('INVALID_MANIFEST', `${field} must be nonempty text of at most ${max} characters.`, { field }); }
function strings(value: unknown, field: string): asserts value is string[] { if (!Array.isArray(value) || value.length > 128 || value.some(v => typeof v !== 'string' || v.length > 8000))
    throw new ExperimentError('INVALID_MANIFEST', `${field} must be a bounded string array.`, { field }); }
function id(value: string, field: string) { if (!/^[a-zA-Z][a-zA-Z0-9_.-]{0,99}$/.test(value) || unsafeKeys.has(value))
    throw new ExperimentError('INVALID_MANIFEST', `${field} is not a safe semantic identifier.`, { field }); }
export function validateManifest(input: unknown): Manifest {
    record(input, 'manifest');
    keys(input, ['schemaVersion', 'id', 'title', 'description', 'question', 'kind', 'parameters', 'quantities', 'geometry', 'entities', 'assumptions', 'limitations', 'sources', 'capabilities', 'review', 'concept', 'misconception', 'tags'], 'manifest');
    if (input.schemaVersion !== '1.0')
        throw new ExperimentError('INVALID_MANIFEST', 'Unsupported manifest schemaVersion.');
    for (const key of ['id', 'title', 'description', 'question'] as const)
        text(input[key], key);
    id(input.id as string, 'id');
    if (input.kind !== 'analytic' && input.kind !== 'parametric')
        throw new ExperimentError('INVALID_MANIFEST', 'kind must be analytic or parametric.');
    record(input.parameters, 'parameters');
    record(input.quantities, 'quantities');
    if (Object.keys(input.parameters).length > LIMITS.parameters || Object.keys(input.quantities).length > LIMITS.quantities)
        throw new ExperimentError('RESOURCE_LIMIT', 'Manifest has too many parameters or quantities.');
    for (const [key, raw] of Object.entries(input.parameters)) {
        id(key, `parameters.${key}`);
        record(raw, `parameters.${key}`);
        keys(raw, ['type', 'label', 'default', 'description', 'min', 'max', 'step', 'unit', 'integer', 'options', 'display', 'advanced'], `parameters.${key}`);
        text(raw.label, `${key}.label`);
        if (!['number', 'string', 'boolean'].includes(raw.type as string) || typeof raw.default !== raw.type)
            throw new ExperimentError('INVALID_MANIFEST', `${key} has an invalid type or default.`);
        for (const name of ['min', 'max', 'step'] as const)
            if (raw[name] !== undefined && (typeof raw[name] !== 'number' || !Number.isFinite(raw[name])))
                throw new ExperimentError('INVALID_MANIFEST', `${key}.${name} must be finite.`);
        if (raw.min !== undefined && raw.max !== undefined && (raw.min as number) > (raw.max as number))
            throw new ExperimentError('INVALID_MANIFEST', `${key} has reversed bounds.`);
        if (raw.step !== undefined && (raw.step as number) <= 0)
            throw new ExperimentError('INVALID_MANIFEST', `${key}.step must be positive.`);
        for (const name of ['description', 'unit'] as const)
            if (raw[name] !== undefined)
                text(raw[name], `${key}.${name}`);
        if (raw.advanced !== undefined && typeof raw.advanced !== 'boolean')
            throw new ExperimentError('INVALID_MANIFEST', `${key}.advanced must be boolean.`);
        if (raw.integer !== undefined && typeof raw.integer !== 'boolean')
            throw new ExperimentError('INVALID_MANIFEST', `${key}.integer must be boolean.`);
        if (raw.options !== undefined) {
            if (!Array.isArray(raw.options) || !raw.options.length || raw.options.length > 128)
                throw new ExperimentError('INVALID_MANIFEST', `${key}.options is invalid.`);
            const optionValues = raw.options.map(option => { if (typeof option === 'string')
                return option; record(option, `${key}.option`); text(option.value, `${key}.option.value`); text(option.label, `${key}.option.label`); return option.value; });
            if (new Set(optionValues).size !== optionValues.length || raw.type !== 'string')
                throw new ExperimentError('INVALID_MANIFEST', `${key}.options must contain unique string values.`);
        }
        if (raw.display !== undefined) {
            record(raw.display, `${key}.display`);
            keys(raw.display, ['unit', 'scale', 'decimals'], `${key}.display`);
            if (raw.display.decimals !== undefined && (!Number.isInteger(raw.display.decimals) || (raw.display.decimals as number) < 0 || (raw.display.decimals as number) > 15))
                throw new ExperimentError('INVALID_MANIFEST', `${key}.display.decimals must be between 0 and 15.`);
            text(raw.display.unit, `${key}.display.unit`);
            if (typeof raw.display.scale !== 'number' || !Number.isFinite(raw.display.scale) || raw.display.scale === 0)
                throw new ExperimentError('INVALID_MANIFEST', `${key}.display.scale must be a finite nonzero number.`);
        }
        validateParameter(key, raw as unknown as ParameterDefinition, raw.default);
    }
    for (const [key, raw] of Object.entries(input.quantities)) {
        id(key, `quantities.${key}`);
        record(raw, `quantities.${key}`);
        keys(raw, ['label', 'type', 'unit', 'dimension', 'description', 'vectorLength', 'entityId', 'referenceFrame', 'signConvention'], `quantities.${key}`);
        for (const name of ['label', 'unit', 'dimension', 'description'] as const)
            text(raw[name], `${key}.${name}`);
        if (raw.type !== 'scalar' && raw.type !== 'vector')
            throw new ExperimentError('INVALID_MANIFEST', `${key}.type must be scalar or vector.`);
        if (raw.type === 'vector' && (!Number.isInteger(raw.vectorLength) || (raw.vectorLength as number) < 1 || (raw.vectorLength as number) > LIMITS.vectorElements))
            throw new ExperimentError('INVALID_MANIFEST', `${key}.vectorLength is required and must be bounded.`);
    }
    for (const key of ['assumptions', 'limitations', 'capabilities'] as const)
        strings(input[key], key);
    if (!Array.isArray(input.sources) || input.sources.length > 128)
        throw new ExperimentError('INVALID_MANIFEST', 'sources must be a bounded array.');
    for (const source of input.sources) {
        record(source, 'source');
        keys(source, ['title', 'url'], 'source');
        text(source.title, 'source.title');
        text(source.url, 'source.url');
        try {
            const url = new URL(source.url);
            if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password)
                throw new Error();
        }
        catch {
            throw new ExperimentError('INVALID_MANIFEST', 'Source URLs must use HTTP(S) without credentials.');
        }
    }
    if (input.entities !== undefined) {
        if (!Array.isArray(input.entities) || input.entities.length > 128)
            throw new ExperimentError('INVALID_MANIFEST', 'entities must be a bounded array.');
        const ids = new Set<string>();
        for (const entity of input.entities) {
            record(entity, 'entity');
            keys(entity, ['id', 'label', 'description', 'quantityIds'], 'entity');
            text(entity.id, 'entity.id');
            id(entity.id, 'entity.id');
            text(entity.label, 'entity.label');
            strings(entity.quantityIds, 'entity.quantityIds');
            if (ids.has(entity.id))
                throw new ExperimentError('INVALID_MANIFEST', 'Entity IDs must be unique.');
            ids.add(entity.id);
            for (const key of entity.quantityIds)
                if (!Object.hasOwn(input.quantities, key))
                    throw new ExperimentError('INVALID_MANIFEST', `Entity references unknown quantity ${key}.`);
        }
    }
    if (input.geometry !== undefined) {
        record(input.geometry, 'geometry');
        for (const [key, g] of Object.entries(input.geometry)) {
            id(key, `geometry.${key}`);
            record(g, `geometry.${key}`);
            keys(g, ['shape', 'unit', 'coordinateFrame', 'maxElements'], `geometry.${key}`);
            if (!['polyline2', 'polyline3', 'points2', 'points3', 'triangles3'].includes(g.shape as string))
                throw new ExperimentError('INVALID_MANIFEST', `Unsupported geometry shape for ${key}.`);
            text(g.unit, `${key}.unit`);
            text(g.coordinateFrame, `${key}.coordinateFrame`);
            if (!Number.isInteger(g.maxElements) || (g.maxElements as number) < 1 || (g.maxElements as number) > LIMITS.geometryElements)
                throw new ExperimentError('INVALID_MANIFEST', `${key}.maxElements must be bounded.`);
        }
    }
    if (input.review !== undefined) {
        record(input.review, 'review');
        keys(input.review, ['status', 'reviewer', 'scope', 'date'], 'review');
        if (!['unreviewed', 'reviewed'].includes(input.review.status as string))
            throw new ExperimentError('INVALID_MANIFEST', 'Unknown review status.');
        if (input.review.status === 'reviewed') {
            text(input.review.reviewer, 'review.reviewer');
            text(input.review.scope, 'review.scope');
        }
    }
    for (const optional of ['concept', 'misconception'] as const)
        if (input[optional] !== undefined)
            text(input[optional], optional);
    if (input.tags !== undefined)
        strings(input.tags, 'tags');
    return clone(input) as unknown as Manifest;
}
function validateParameter(key: string, def: ParameterDefinition, value: unknown) {
    const fail = (message: string) => { throw new ExperimentError('INVALID_PARAMETER', `${def.label}: ${message}`, { field: key }); };
    if (typeof value !== def.type)
        fail(`expected ${def.type}.`);
    if (typeof value === 'number') {
        if (!Number.isFinite(value))
            fail('value must be finite.');
        if (def.min !== undefined && value < def.min)
            fail(`minimum is ${def.min}${def.unit ? ' ' + def.unit : ''}.`);
        if (def.max !== undefined && value > def.max)
            fail(`maximum is ${def.max}${def.unit ? ' ' + def.unit : ''}.`);
        if (def.integer && !Number.isInteger(value))
            fail('value must be an integer.');
    }
    if (typeof value === 'string') {
        if (value.length > 2000)
            fail('text is too long.');
        if (def.options && !def.options.some(o => (typeof o === 'string' ? o : o.value) === value))
            fail('choose one of the declared options.');
    }
}
export function defaultParameters(manifest: Manifest): ScalarParams { return Object.fromEntries(Object.entries(manifest.parameters).map(([key, p]) => [key, p.default])); }
/** A patch is merged into a supplied base, or into defaults. Unknown keys are rejected. */
export function validateParameters(manifest: Manifest, input: unknown, base: ScalarParams = defaultParameters(manifest)): ScalarParams {
    if (!isRecord(input))
        throw new ExperimentError('INVALID_PARAMETER', 'Parameters must be a plain object.');
    for (const key of Object.keys(input))
        if (!Object.hasOwn(manifest.parameters, key))
            throw new ExperimentError('INVALID_PARAMETER', `Unknown parameter ${key}.`, { field: key });
    const output = { ...base, ...input };
    for (const [key, definition] of Object.entries(manifest.parameters))
        validateParameter(key, definition, output[key]);
    return output as ScalarParams;
}
export function validateEvaluation(manifest: Manifest, input: unknown): Evaluation {
    if (!isRecord(input) || !isRecord(input.quantities))
        throw new ExperimentError('MODEL_ERROR', 'Model must return a quantities object.');
    if (Object.keys(input).some(key => !['quantities', 'geometry', 'boundary'].includes(key)))
        throw new ExperimentError('MODEL_ERROR', 'Model returned an undeclared evaluation field.');
    if (Object.keys(input.quantities).length > LIMITS.quantities)
        throw new ExperimentError('RESOURCE_LIMIT', 'Too many returned quantities.');
    for (const key of Object.keys(input.quantities))
        if (!Object.hasOwn(manifest.quantities, key))
            throw new ExperimentError('MODEL_ERROR', `Model returned undeclared quantity ${key}.`, { field: key });
    for (const [key, definition] of Object.entries(manifest.quantities)) {
        const q = input.quantities[key];
        if (!isRecord(q) || !['valid', 'undefined', 'out_of_domain'].includes(q.status as string))
            throw new ExperimentError('MODEL_ERROR', `Missing or invalid quantity ${key}.`, { field: key });
        if (Object.keys(q).some(key => !['value', 'status', 'reason'].includes(key)))
            throw new ExperimentError('MODEL_ERROR', `Unexpected quantity field in ${key}.`);
        if (q.status === 'valid') {
            if (definition.type === 'scalar') {
                if (typeof q.value !== 'number' || !Number.isFinite(q.value))
                    throw new ExperimentError('MODEL_ERROR', `${key} must be a finite scalar.`, { field: key });
            }
            else if (!Array.isArray(q.value) || q.value.length !== definition.vectorLength || q.value.some(v => typeof v !== 'number' || !Number.isFinite(v)))
                throw new ExperimentError('MODEL_ERROR', `${key} must be a finite vector of length ${definition.vectorLength}.`, { field: key });
        }
        else if (q.value !== null || typeof q.reason !== 'string' || !q.reason.trim() || q.reason.length > 4000)
            throw new ExperimentError('MODEL_ERROR', `${key} must have a null value and a reason when not valid.`, { field: key });
    }
    if (manifest.geometry && Object.keys(manifest.geometry).some(key => !isRecord(input.geometry) || !Object.hasOwn(input.geometry, key))) throw new ExperimentError('MODEL_ERROR', 'Model omitted declared geometry.');
    if (input.geometry !== undefined) {
        if (!isRecord(input.geometry))
            throw new ExperimentError('MODEL_ERROR', 'Geometry must be an object.');
        let total = 0;
        for (const [key, value] of Object.entries(input.geometry)) {
            const definition = manifest.geometry?.[key];
            if (!definition || !Array.isArray(value))
                throw new ExperimentError('MODEL_ERROR', `Undeclared or invalid geometry ${key}.`);
            total += value.length;
            if (value.length > definition.maxElements || total > LIMITS.geometryElements)
                throw new ExperimentError('RESOURCE_LIMIT', `Geometry ${key} exceeds its element limit.`);
            const stride = definition.shape === 'triangles3' ? 9 : definition.shape.endsWith('2') ? 2 : 3;
            if (value.length % stride !== 0 || value.some(v => typeof v !== 'number' || !Number.isFinite(v)))
                throw new ExperimentError('MODEL_ERROR', `Geometry ${key} has invalid coordinates or shape.`);
        }
    }
    if (input.boundary !== undefined && (!isRecord(input.boundary) || typeof input.boundary.reached !== 'boolean' || typeof input.boundary.reason !== 'string' || input.boundary.reason.length > 4000))
        throw new ExperimentError('MODEL_ERROR', 'Invalid boundary description.');
    return clone(input) as unknown as Evaluation;
}
export function validateTimeDomain(input: unknown, kind: Manifest['kind']): TimeDomain {
    if (kind === 'parametric')
        return { start: 0, end: 0 };
    if (!isRecord(input) || typeof input.start !== 'number' || !Number.isFinite(input.start) || input.start < 0 || (input.end !== null && (typeof input.end !== 'number' || !Number.isFinite(input.end) || input.end < input.start)))
        throw new ExperimentError('MODEL_ERROR', 'Analytic model must declare a finite start and an ordered finite end or null.');
    if (input.endEventId !== undefined && (typeof input.endEventId !== 'string' || !input.endEventId || input.endEventId.length > 100))
        throw new ExperimentError('MODEL_ERROR', 'Invalid terminal event ID.');
    return clone(input) as unknown as TimeDomain;
}
export function validateTimePoint(input: unknown): TimePoint {
    if (!isRecord(input) || typeof input.time !== 'number' || !Number.isFinite(input.time) || input.time < 0)
        throw new ExperimentError('INCOMPATIBLE_SNAPSHOT', 'Invalid snapshot time.');
    if (input.kind === 'sample')
        return { kind: 'sample', time: input.time };
    if (input.kind === 'event' && typeof input.eventId === 'string' && input.eventId.length > 0 && input.eventId.length < 101)
        return { kind: 'event', time: input.time, eventId: input.eventId };
    if (input.kind === 'grid' && Number.isSafeInteger(input.tick) && (input.tick as number) >= 0 && typeof input.rateHz === 'number' && Number.isFinite(input.rateHz) && input.rateHz > 0 && input.rateHz <= 10000 && input.time === (input.tick as number) / input.rateHz)
        return { kind: 'grid', time: input.time, tick: input.tick as number, rateHz: input.rateHz };
    throw new ExperimentError('INCOMPATIBLE_SNAPSHOT', 'Time point has inconsistent tick, time, or event fields.');
}
export function validateViewState(input: unknown, manifest: Manifest): ViewState {
    if (!isRecord(input) || !Array.isArray(input.selectedIds) || input.selectedIds.length > 32 || !isRecord(input.layers) || Object.keys(input.layers).length > 32)
        throw new ExperimentError('INVALID_COMMAND', 'Invalid view state.');
    if (Object.keys(input).some(key => !['selectedIds', 'layers', 'camera', 'mode', 'playbackSpeed'].includes(key)))
        throw new ExperimentError('INVALID_COMMAND', 'Unknown view-state field.');
    const ids = new Set([...Object.keys(manifest.quantities), ...(manifest.entities ?? []).map(e => e.id)]);
    for (const selected of input.selectedIds)
        if (typeof selected !== 'string' || !ids.has(selected))
            throw new ExperimentError('NOT_FOUND', `Unknown selection ${String(selected)}.`);
    for (const [key, value] of Object.entries(input.layers))
        if (unsafeKeys.has(key) || key.length > 100 || typeof value !== 'boolean')
            throw new ExperimentError('INVALID_COMMAND', 'View layer flags must be boolean.');
    if (typeof input.playbackSpeed !== 'number' || !Number.isFinite(input.playbackSpeed) || input.playbackSpeed < 0.05 || input.playbackSpeed > 10)
        throw new ExperimentError('INVALID_COMMAND', 'Playback speed must be between 0.05 and 10.');
    if (input.mode !== undefined && (typeof input.mode !== 'string' || input.mode.length > 100))
        throw new ExperimentError('INVALID_COMMAND', 'View mode must be a short string.');
    if (input.camera !== undefined) {
        if (!isRecord(input.camera))
            throw new ExperimentError('INVALID_COMMAND', 'Invalid camera.');
        for (const key of ['position', 'target']) {
            const values = input.camera[key];
            if (!Array.isArray(values) || values.length !== 3 || values.some(v => typeof v !== 'number' || !Number.isFinite(v) || Math.abs(v) > 1e6))
                throw new ExperimentError('INVALID_COMMAND', 'Camera must use bounded finite coordinates.');
        }
    }
    return clone(input) as unknown as ViewState;
}
export function validateSnapshot(input: unknown, manifest: Manifest, revision: string, runtimeVersion: string): Snapshot {
    if (!isRecord(input))
        throw new ExperimentError('INCOMPATIBLE_SNAPSHOT', 'Snapshot must be an object.');
    if (Object.keys(input).some(key => !['schemaVersion', 'experimentId', 'definitionRevision', 'runtimeVersion', 'runId', 'runVersion', 'parameters', 'timePoint', 'view', 'viewVersion', 'comparisonReferences', 'annotations', 'createdAt'].includes(key)))
        throw new ExperimentError('INCOMPATIBLE_SNAPSHOT', 'Snapshot contains unsupported fields.');
    if (JSON.stringify(input).length > LIMITS.snapshotBytes)
        throw new ExperimentError('RESOURCE_LIMIT', 'Snapshot is too large.');
    if (input.schemaVersion !== '1.0' || input.experimentId !== manifest.id || input.definitionRevision !== revision || input.runtimeVersion !== runtimeVersion)
        throw new ExperimentError('INCOMPATIBLE_SNAPSHOT', 'Snapshot schema, experiment, definition revision, or runtime does not match.');
    if (typeof input.runId !== 'string' || input.runId.length > 200 || !Number.isSafeInteger(input.runVersion) || (input.runVersion as number) < 0 || !Number.isSafeInteger(input.viewVersion) || (input.viewVersion as number) < 0)
        throw new ExperimentError('INCOMPATIBLE_SNAPSHOT', 'Invalid snapshot run or view identity.');
    if (!isRecord(input.parameters) || Object.keys(input.parameters).length !== Object.keys(manifest.parameters).length)
        throw new ExperimentError('INCOMPATIBLE_SNAPSHOT', 'Snapshot must contain every parameter.');
    const parameters = validateParameters(manifest, input.parameters);
    const timePoint = validateTimePoint(input.timePoint);
    const view = validateViewState(input.view, manifest);
    if (!Array.isArray(input.comparisonReferences) || input.comparisonReferences.length > 16 || input.comparisonReferences.some(v => typeof v !== 'string' || v.length > 200))
        throw new ExperimentError('INCOMPATIBLE_SNAPSHOT', 'Invalid comparison references.');
    if (input.annotations !== undefined && (typeof input.annotations !== 'string' || input.annotations.length > 10000))
        throw new ExperimentError('INCOMPATIBLE_SNAPSHOT', 'Annotations are too long.');
    if (typeof input.createdAt !== 'string' || !Number.isFinite(Date.parse(input.createdAt)))
        throw new ExperimentError('INCOMPATIBLE_SNAPSHOT', 'Invalid snapshot date.');
    return { ...clone(input), parameters, timePoint, view } as unknown as Snapshot;
}
export function validateViews(views: readonly ViewDefinition[], manifest: Manifest): readonly ViewDefinition[] {
    if (!Array.isArray(views) || views.length > 32)
        throw new ExperimentError('INVALID_MANIFEST', 'Too many views.');
    const ids = new Set<string>();
    for (const view of views) {
        if (!view || !['scene2d', 'scene3d', 'plot', 'equation', 'table', 'frequency'].includes(view.type))
            throw new ExperimentError('INVALID_MANIFEST', 'Unsupported view primitive.');
        id(view.id, 'view.id');
        if (ids.has(view.id))
            throw new ExperimentError('INVALID_MANIFEST', 'View IDs must be unique.');
        ids.add(view.id);
        text(view.label, 'view.label');
        if (view.bounds !== undefined) {
            record(view.bounds, 'view.bounds');
            keys(view.bounds, ['x', 'y'], 'view.bounds');
            for (const axis of ['x', 'y'] as const) {
                const extent = view.bounds[axis];
                if (!Array.isArray(extent) || extent.length !== 2 || !extent.every(value => typeof value === 'number' && Number.isFinite(value)) || extent[0] >= extent[1])
                    throw new ExperimentError('INVALID_MANIFEST', `view.bounds.${axis} must contain two finite numbers with minimum less than maximum.`);
            }
        }
        if (!Array.isArray(view.bindings) || view.bindings.length > 256)
            throw new ExperimentError('INVALID_MANIFEST', 'Invalid view bindings.');
        for (const b of view.bindings) {
            id(b.id, 'binding.id');
            text(b.property, 'binding.property');
            if (Boolean(b.quantityId) === Boolean(b.geometryId) || (b.quantityId && !Object.hasOwn(manifest.quantities, b.quantityId)) || (b.geometryId && !Object.hasOwn(manifest.geometry ?? {}, b.geometryId)))
                throw new ExperimentError('INVALID_MANIFEST', `Binding ${b.id} must reference exactly one registered quantity or geometry.`);
            if (b.transform) {
                if (!['identity', 'scale', 'component'].includes(b.transform.kind))
                    throw new ExperimentError('INVALID_MANIFEST', 'Unsupported display transform.');
                if (b.transform.kind === 'scale' && !Number.isFinite(b.transform.factor))
                    throw new ExperimentError('INVALID_MANIFEST', 'Display scale must be finite.');
                if (b.transform.kind === 'component' && (!Number.isInteger(b.transform.index) || b.transform.index < 0 || !b.quantityId || manifest.quantities[b.quantityId]?.type !== 'vector' || b.transform.index >= manifest.quantities[b.quantityId]!.vectorLength!))
                    throw new ExperimentError('INVALID_MANIFEST', 'Invalid vector projection.');
            }
        }
        if (view.symbols)
            for (const quantity of Object.values(view.symbols as Record<string, string>))
                if (!Object.hasOwn(manifest.quantities, quantity))
                    throw new ExperimentError('INVALID_MANIFEST', 'Equation references an unknown quantity.');
        if (view.template !== undefined && view.template.length > 10000)
            throw new ExperimentError('RESOURCE_LIMIT', 'Equation template is too large.');
    }
    return clone(views);
}
/** Familiar parse/safeParse surface without exposing validator implementation details. */
function schema<T>(parse: (input: unknown) => T) { return { parse, safeParse: (input: unknown): {
        success: true;
        data: T;
    } | {
        success: false;
        error: ExperimentError;
    } => { try {
        return { success: true, data: parse(input) };
    }
    catch (error) {
        return { success: false, error: error instanceof ExperimentError ? error : new ExperimentError('INVALID_MANIFEST', String(error)) };
    } } }; }
export const manifestSchema = schema(validateManifest);
export const timePointSchema = schema(validateTimePoint);

/** Parse the command envelope before it enters the serialized queue. */
export function validateCommand(input: unknown): import('./types.js').RuntimeCommand {
    if (!isRecord(input) || typeof input.type !== 'string') throw new ExperimentError('INVALID_COMMAND', 'Command must be an object with a type.');
    const fields: Record<string, readonly string[]> = {
        play: [], pause: [], reset: [], step: [], seek: ['time'],
        set_parameters: ['parameters'], restore: ['snapshot'], begin_preview: ['parameters'],
        update_preview: ['previewId', 'parameters'], commit_preview: ['previewId'], cancel_preview: ['previewId'],
        set_view: ['view'],
    };
    if (!Object.hasOwn(fields, input.type)) throw new ExperimentError('INVALID_COMMAND', `Unsupported command ${input.type}.`);
    const guard = input.type === 'set_view' ? ['expectedViewVersion'] : ['expectedRunVersion', 'expectedActiveRunId'];
    const allowed = ['type', ...guard, ...fields[input.type]!];
    if (Object.keys(input).some(key => !allowed.includes(key)) || allowed.some(key => !Object.hasOwn(input, key))) throw new ExperimentError('INVALID_COMMAND', `Command ${input.type} has missing or unsupported fields.`);
    const version = input.type === 'set_view' ? input.expectedViewVersion : input.expectedRunVersion;
    if (!Number.isSafeInteger(version) || (version as number) < 0) throw new ExperimentError('INVALID_COMMAND', 'Expected version must be a nonnegative integer.');
    if (input.type !== 'set_view' && (typeof input.expectedActiveRunId !== 'string' || !input.expectedActiveRunId || input.expectedActiveRunId.length > 200)) throw new ExperimentError('INVALID_COMMAND', 'Expected active run ID is required.');
    if (Object.hasOwn(input, 'previewId') && (typeof input.previewId !== 'string' || !input.previewId || input.previewId.length > 200)) throw new ExperimentError('INVALID_COMMAND', 'Preview ID is required.');
    if (input.type === 'seek' && (typeof input.time !== 'number' || !Number.isFinite(input.time))) throw new ExperimentError('INVALID_COMMAND', 'Seek time must be finite.');
    if (Object.hasOwn(input, 'parameters') && !isRecord(input.parameters)) throw new ExperimentError('INVALID_PARAMETER', 'Parameters must be an object.');
    return clone(input) as unknown as import('./types.js').RuntimeCommand;
}

/** Suites are bounded data. Model evaluation still occurs through the configured executor. */
export function validateCheckSuite(input: unknown): import('./types.js').CheckSuite {
    if (!isRecord(input) || typeof input.id !== 'string' || !input.id || input.id.length > 100 || typeof input.version !== 'string' || !input.version || input.version.length > 100 || typeof input.author !== 'string' || !input.author || input.author.length > 1000 || !['reference', 'author'].includes(input.provenance as string) || !Array.isArray(input.cases) || !input.cases.length || input.cases.length > LIMITS.samples) throw new ExperimentError('INVALID_PARAMETER', 'Invalid or oversized check suite.');
    const ids = new Set<string>();
    for (const item of input.cases) {
        if (!isRecord(item) || typeof item.id !== 'string' || !item.id || item.id.length > 100 || ids.has(item.id) || typeof item.label !== 'string' || !item.label || item.label.length > 1000 || !isRecord(item.expected) || !Object.keys(item.expected).length || Object.keys(item.expected).length > LIMITS.quantities) throw new ExperimentError('INVALID_PARAMETER', 'Check cases need distinct IDs, labels, and bounded expected values.');
        ids.add(item.id);
        for (const expected of Object.values(item.expected)) {
            const valid = expected === null || (typeof expected === 'number' && Number.isFinite(expected)) || (Array.isArray(expected) && expected.length > 0 && expected.length <= LIMITS.vectorElements && expected.every(value => typeof value === 'number' && Number.isFinite(value)));
            if (!valid) throw new ExperimentError('INVALID_PARAMETER', 'Expected values must be null, finite scalars, or bounded finite vectors.');
        }
        for (const field of ['atol', 'rtol', 'time']) if (item[field] !== undefined && (typeof item[field] !== 'number' || !Number.isFinite(item[field]) || item[field] < 0)) throw new ExperimentError('INVALID_PARAMETER', `Check ${field} must be finite and nonnegative.`);
        if (item.parameters !== undefined && !isRecord(item.parameters)) throw new ExperimentError('INVALID_PARAMETER', 'Check parameters must be an object.');
        if (item.statuses !== undefined) {
            if (!isRecord(item.statuses)) throw new ExperimentError('INVALID_PARAMETER', 'Check statuses must be an object.');
            for (const [key, status] of Object.entries(item.statuses)) if (!Object.hasOwn(item.expected, key) || !['valid', 'undefined', 'out_of_domain'].includes(status as string)) throw new ExperimentError('INVALID_PARAMETER', 'Check statuses must name an expected quantity and a supported status.');
        }
    }
    return clone(input) as unknown as import('./types.js').CheckSuite;
}
