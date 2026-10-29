/** JSON Schemas for agent discovery and editor completion. Semantic cross-field checks also run at runtime. */
const scalar = { oneOf: [{ type: 'number' }, { type: 'string' }, { type: 'boolean' }] } as const;
const params = { type: 'object', maxProperties: 64, additionalProperties: scalar } as const;
const vec3 = { type: 'array', items: { type: 'number' }, minItems: 3, maxItems: 3 } as const;
const viewProperties = {
    selectedIds: { type: 'array', maxItems: 32, items: { type: 'string' } },
    layers: { type: 'object', maxProperties: 32, additionalProperties: { type: 'boolean' } },
    playbackSpeed: { type: 'number', minimum: 0.05, maximum: 10 }, mode: { type: 'string', maxLength: 100 },
    camera: { type: 'object', required: ['position', 'target'], properties: { position: vec3, target: vec3 }, additionalProperties: false },
} as const;
export const timePointJsonSchema = { oneOf: [
        { type: 'object', required: ['kind', 'time', 'tick', 'rateHz'], properties: { kind: { const: 'grid' }, time: { type: 'number', minimum: 0 }, tick: { type: 'integer', minimum: 0 }, rateHz: { type: 'number', exclusiveMinimum: 0, maximum: 10000 } }, additionalProperties: false },
        { type: 'object', required: ['kind', 'time', 'eventId'], properties: { kind: { const: 'event' }, time: { type: 'number', minimum: 0 }, eventId: { type: 'string', minLength: 1, maxLength: 100 } }, additionalProperties: false },
        { type: 'object', required: ['kind', 'time'], properties: { kind: { const: 'sample' }, time: { type: 'number', minimum: 0 } }, additionalProperties: false },
    ] } as const;
export const snapshotJsonSchema = {
    $schema: 'https://json-schema.org/draft/2020-12/schema', title: 'Explorable Models snapshot', type: 'object',
    required: ['schemaVersion', 'experimentId', 'definitionRevision', 'runtimeVersion', 'runId', 'runVersion', 'parameters', 'timePoint', 'view', 'viewVersion', 'comparisonReferences', 'createdAt'],
    properties: { schemaVersion: { const: '1.0' }, experimentId: { type: 'string' }, definitionRevision: { type: 'string', pattern: '^sha256:[a-f0-9]{64}$' }, runtimeVersion: { type: 'string' }, runId: { type: 'string', maxLength: 200 }, runVersion: { type: 'integer', minimum: 0 }, parameters: params, timePoint: timePointJsonSchema,
        view: { type: 'object', required: ['selectedIds', 'layers', 'playbackSpeed'], properties: viewProperties, additionalProperties: false }, viewVersion: { type: 'integer', minimum: 0 }, comparisonReferences: { type: 'array', maxItems: 16, items: { type: 'string', maxLength: 200 } }, annotations: { type: 'string', maxLength: 10000 }, createdAt: { type: 'string', format: 'date-time' } }, additionalProperties: false,
} as const;
const guard = { expectedRunVersion: { type: 'integer', minimum: 0 }, expectedActiveRunId: { type: 'string', minLength: 1, maxLength: 200 } } as const;
function mutation(type: string, properties: Record<string, unknown> = {}, required: string[] = []) { return { type: 'object', required: ['type', 'expectedRunVersion', 'expectedActiveRunId', ...required], properties: { type: { const: type }, ...guard, ...properties }, additionalProperties: false }; }
export const commandJsonSchema = {
    $schema: 'https://json-schema.org/draft/2020-12/schema', title: 'Explorable Models command', oneOf: [
        ...['play', 'pause', 'reset', 'step'].map(type => mutation(type)), mutation('seek', { time: { type: 'number', minimum: 0 } }, ['time']),
        mutation('set_parameters', { parameters: params }, ['parameters']), mutation('restore', { snapshot: snapshotJsonSchema }, ['snapshot']),
        mutation('begin_preview', { parameters: params }, ['parameters']), mutation('update_preview', { parameters: params, previewId: { type: 'string', minLength: 1 } }, ['parameters', 'previewId']),
        ...['commit_preview', 'cancel_preview'].map(type => mutation(type, { previewId: { type: 'string', minLength: 1 } }, ['previewId'])),
        { type: 'object', required: ['type', 'expectedViewVersion', 'view'], properties: { type: { const: 'set_view' }, expectedViewVersion: { type: 'integer', minimum: 0 }, view: { type: 'object', properties: viewProperties, additionalProperties: false } }, additionalProperties: false },
    ],
} as const;
export const manifestJsonSchema = {
    $schema: 'https://json-schema.org/draft/2020-12/schema', title: 'Explorable Models manifest', type: 'object',
    required: ['schemaVersion', 'id', 'title', 'description', 'question', 'kind', 'parameters', 'quantities', 'assumptions', 'limitations', 'sources', 'capabilities'],
    properties: {
        schemaVersion: { const: '1.0' }, id: { type: 'string', pattern: '^[a-zA-Z][a-zA-Z0-9_.-]{0,99}$' }, title: { type: 'string', minLength: 1 }, description: { type: 'string', minLength: 1 }, question: { type: 'string', minLength: 1 }, kind: { enum: ['analytic', 'parametric'] },
        parameters: { type: 'object', maxProperties: 64, additionalProperties: { type: 'object', required: ['type', 'label', 'default'], properties: { type: { enum: ['number', 'string', 'boolean'] }, label: { type: 'string' }, default: scalar, description: { type: 'string' }, min: { type: 'number' }, max: { type: 'number' }, step: { type: 'number', exclusiveMinimum: 0 }, unit: { type: 'string' }, integer: { type: 'boolean' }, advanced: { type: 'boolean' }, options: { type: 'array', minItems: 1, maxItems: 128, items: { oneOf: [{ type: 'string' }, { type: 'object', required: ['value', 'label'], properties: { value: { type: 'string' }, label: { type: 'string' } }, additionalProperties: false }] } }, display: { type: 'object', required: ['unit', 'scale'], properties: { unit: { type: 'string' }, scale: { type: 'number' }, decimals: { type: 'integer', minimum: 0, maximum: 15 } }, additionalProperties: false } }, additionalProperties: false } },
        quantities: { type: 'object', maxProperties: 256, additionalProperties: { type: 'object', required: ['type', 'label', 'unit', 'dimension', 'description'], properties: { type: { enum: ['scalar', 'vector'] }, label: { type: 'string' }, unit: { type: 'string' }, dimension: { type: 'string' }, description: { type: 'string' }, vectorLength: { type: 'integer', minimum: 1, maximum: 64 }, entityId: { type: 'string' }, referenceFrame: { type: 'string' }, signConvention: { type: 'string' } }, additionalProperties: false } },
        geometry: { type: 'object', additionalProperties: { type: 'object', required: ['shape', 'unit', 'coordinateFrame', 'maxElements'], properties: { shape: { enum: ['polyline2', 'polyline3', 'points2', 'points3', 'triangles3'] }, unit: { type: 'string' }, coordinateFrame: { type: 'string' }, maxElements: { type: 'integer', minimum: 1, maximum: 50000 } }, additionalProperties: false } },
        entities: { type: 'array', maxItems: 128, items: { type: 'object', required: ['id', 'label', 'quantityIds'], properties: { id: { type: 'string' }, label: { type: 'string' }, description: { type: 'string' }, quantityIds: { type: 'array', items: { type: 'string' } } }, additionalProperties: false } },
        assumptions: { type: 'array', items: { type: 'string' } }, limitations: { type: 'array', items: { type: 'string' } }, capabilities: { type: 'array', items: { type: 'string' } }, tags: { type: 'array', items: { type: 'string' } }, concept: { type: 'string' }, misconception: { type: 'string' },
        sources: { type: 'array', maxItems: 128, items: { type: 'object', required: ['title', 'url'], properties: { title: { type: 'string' }, url: { type: 'string', format: 'uri', pattern: '^https?://' } }, additionalProperties: false } },
        review: { type: 'object', required: ['status'], properties: { status: { enum: ['unreviewed', 'reviewed'] }, reviewer: { type: 'string' }, scope: { type: 'string' }, date: { type: 'string' } }, additionalProperties: false },
    }, additionalProperties: false,
} as const;
