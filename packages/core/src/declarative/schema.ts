import { deepFreeze } from '../identity.js';
/** Bounded JSON Schema exposed to hosts/agents; normalizeDocument adds cross-reference and expression checks. */
export const DOCUMENT_LIMITS = Object.freeze({ bytes: 524288, parameters: 64, quantities: 128, datasets: 8, rowsPerDataset: 5000, datasetCells: 20000, columns: 16, series: 32, samplesPerSeries: 2000, totalSamples: 10000, totalOperations: 2000000, views: 16, marks: 256, groupDepth: 8 });
type Schema = {
    type?: string | string[];
    properties?: Record<string, Schema>;
    required?: string[];
    additionalProperties?: boolean | Schema;
    enum?: unknown[];
    const?: unknown;
    minLength?: number;
    maxLength?: number;
    pattern?: string;
    minimum?: number;
    maximum?: number;
    minItems?: number;
    maxItems?: number;
    items?: Schema;
    maxProperties?: number;
    propertyNames?: Schema;
    anyOf?: Schema[];
    $ref?: string;
    $schema?: string;
    $id?: string;
    $defs?: Record<string, Schema>;
    description?: string;
};
const string = (maxLength = 2000): Schema => ({ type: 'string', maxLength });
const nonempty = (maxLength = 200): Schema => ({ ...string(maxLength), minLength: 1 });
const number: Schema = { type: 'number' };
const id: Schema = { type: 'string', minLength: 1, maxLength: 80, pattern: '^[A-Za-z_][A-Za-z0-9_.-]*$' };
const array = (items: Schema, maxItems: number, minItems = 0): Schema => ({ type: 'array', items, maxItems, minItems });
const object = (properties: Record<string, Schema>, required: string[] = []): Schema => ({ type: 'object', properties, required, additionalProperties: false });
const map = (schema: Schema, maxProperties: number, symbols = false): Schema => ({ type: 'object', additionalProperties: schema, maxProperties, propertyNames: symbols ? { ...id, pattern: '^[A-Za-z_][A-Za-z0-9_]*(?:[.][A-Za-z_][A-Za-z0-9_]*)*$' } : id });
const expression: Schema = { anyOf: [number, { type: 'string', minLength: 1, maxLength: 2048 }, array(number, 256, 2)] };
const mark: Schema = object({ id, type: { enum: ['point', 'segment', 'path', 'polygon', 'circle', 'ellipse', 'arrow', 'angle', 'label', 'line', 'scatter', 'bar', 'region', 'group'] }, label: nonempty(), description: string(), bindings: map(id, 12), series: id, text: string(), style: object({ stroke: nonempty(80), fill: nonempty(80), strokeWidth: { type: 'number', minimum: 0, maximum: 20 }, dash: { enum: ['solid', 'dashed', 'dotted'] }, opacity: { type: 'number', minimum: 0, maximum: 1 }, hidden: { type: 'boolean' } }), offset: array(number, 2, 2), children: array({ $ref: '#/$defs/mark' }, 256), drag: object({ x: id, y: id }, ['x', 'y']), semanticId: id }, ['id', 'type', 'label']);
export const DOCUMENT_SCHEMA: Schema = deepFreeze({
    $schema: 'https://json-schema.org/draft/2020-12/schema', $id: 'https://experiment-kit.invalid/schema/document-2.0.json',
    ...object({
        schemaVersion: { const: '2.0' }, id, title: nonempty(), description: nonempty(4000),
        capabilities: array(object({ id: nonempty(100), version: nonempty(40) }, ['id', 'version']), 16),
        parameters: map(object({ label: nonempty(), value: number, min: number, max: number, step: { type: 'number', minimum: Number.MIN_VALUE }, integer: { type: 'boolean' }, unit: string(80), dimension: nonempty(120) }, ['label', 'value', 'min', 'max']), 64, true),
        quantities: map(object({ expression, label: nonempty(), unit: string(80), dimension: nonempty(120), description: string() }, ['expression']), 128, true),
        datasets: map(object({ columns: array(object({ id, label: nonempty(), unit: string(80) }, ['id', 'label']), 16, 1), rows: array(array({ type: ['number', 'null'] }, 16, 1), 5000), description: nonempty(4000) }, ['columns', 'rows', 'description']), 8),
        series: map(object({ label: nonempty(), x: nonempty(2048), y: nonempty(2048), variable: id, domain: array(number, 2, 2), samples: { type: 'integer', minimum: 2, maximum: 2000 }, dataset: id, xColumn: id, yColumn: id, kind: { enum: ['model', 'observed'] } }, ['label']), 32),
        views: array(object({ id, type: { enum: ['scene', 'plot', 'values', 'equation', 'table'] }, title: nonempty(), description: string(), marks: array({ $ref: '#/$defs/mark' }, 256), quantities: array(id, 128), equation: string(4000), dataset: id, bounds: array(number, 4, 4), equalAspect: { type: 'boolean' }, xLabel: string(200), yLabel: string(200), scale: { enum: ['linear', 'log'] } }, ['id', 'type', 'title']), 16, 1),
        time: object({ end: expression, step: { type: 'number', minimum: 0.000001, maximum: 1000 } }, ['end']),
        presentation: object({ columns: { enum: [1, 2] }, controls: { type: 'boolean' }, precision: { type: 'integer', minimum: 1, maximum: 12 }, locale: nonempty(80) }),
        assumptions: array(nonempty(4000), 64), limitations: array(nonempty(4000), 64), sources: array(nonempty(2000), 64),
        provenance: object({ authoredBy: nonempty(200), review: { const: 'unreviewed' }, checks: { enum: ['author', 'none'] } }, ['review'])
    }, ['schemaVersion', 'id', 'title', 'description', 'parameters', 'quantities', 'views', 'assumptions', 'limitations']),
    $defs: { mark }
});
export type { Schema };
