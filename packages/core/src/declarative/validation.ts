import { DocumentError, type VisualizationDocument, type MarkSpec, type Diagnostic } from './types.js';
import { DOCUMENT_LIMITS, DOCUMENT_SCHEMA, type Schema } from './schema.js';
import { parseDimension, parseExpression, expressionReferences, inferExpressionType, sameDimension, expressionOperationCost, type ExpressionNode, type ExpressionType } from './expressions.js';
const symbolPattern = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const reserved = new Set(['pi', 'e', 'time', '__proto__', 'prototype', 'constructor']);
const error = (path: string, message: string, code = 'INVALID_DOCUMENT'): never => { throw new DocumentError([{ code, path, message }]); };
/** Reject non-JSON values/accessors without invoking getters, before bounded traversal/serialization. */
function assertJSON(input: unknown): void {
    const seen = new Set<object>();
    const encoder = new TextEncoder();
    let bytes = 0, nodes = 0;
    const visit = (value: unknown, path: string, depth: number): void => {
        if (depth > 32 || ++nodes > 60000)
            error(path, 'Document nesting or node limit exceeded.', 'LIMIT');
        if (value === null || typeof value === 'boolean') {
            bytes += 5;
            return;
        }
        if (typeof value === 'string') {
            bytes += encoder.encode(JSON.stringify(value)).length;
            if (bytes > DOCUMENT_LIMITS.bytes)
                error(path, 'Document exceeds 512 KiB.', 'LIMIT');
            return;
        }
        if (typeof value === 'number') {
            if (!Number.isFinite(value))
                error(path, 'Numbers must be finite.');
            bytes += String(value).length;
            return;
        }
        if (typeof value !== 'object')
            error(path, 'Only JSON-compatible data is accepted.');
        const object = value as object;
        if (seen.has(object))
            error(path, 'Cyclic object references are not accepted.');
        if (!Array.isArray(object) && Object.getPrototypeOf(object) !== Object.prototype && Object.getPrototypeOf(object) !== null)
            error(path, 'Expected a plain JSON object.');
        seen.add(object);
        bytes += 2;
        const descriptors = Object.getOwnPropertyDescriptors(object);
        if (Reflect.ownKeys(object).some(key => typeof key === 'symbol'))
            error(path, 'Symbol properties are not accepted.');
        for (const [key, descriptor] of Object.entries(descriptors)) {
            if (Array.isArray(object) && key === 'length')
                continue;
            if (key === '__proto__' || key === 'prototype' || key === 'constructor')
                error(`${path}.${key}`, 'Reserved object key.');
            if (!('value' in descriptor) || !descriptor.enumerable)
                error(`${path}.${key}`, 'Accessors and hidden properties are not accepted.');
            bytes += Array.isArray(object) ? 1 : encoder.encode(JSON.stringify(key)).length + 2;
            visit(descriptor.value, `${path}.${key}`, depth + 1);
        }
        if (Array.isArray(object) && Object.keys(object).length !== object.length)
            error(path, 'Sparse or decorated arrays are not accepted.');
        seen.delete(object);
        if (bytes > DOCUMENT_LIMITS.bytes)
            error(path, 'Document exceeds 512 KiB.', 'LIMIT');
    };
    visit(input, '$', 0);
}
function schemaErrors(value: unknown, schema: Schema, path: string): Diagnostic[] {
    if (schema.$ref)
        return schemaErrors(value, DOCUMENT_SCHEMA.$defs![schema.$ref.split('/').pop()!], path);
    const bad = (message: string): Diagnostic[] => [{ code: 'SCHEMA', path, message }];
    if (schema.anyOf) {
        if (schema.anyOf.some(s => !schemaErrors(value, s, path).length))
            return [];
        return bad('Value does not match any supported shape.');
    }
    if (schema.const !== undefined && value !== schema.const)
        return bad(`Expected ${JSON.stringify(schema.const)}.`);
    if (schema.enum && !schema.enum.includes(value))
        return bad(`Expected one of ${schema.enum.join(', ')}.`);
    if (schema.type) {
        const types = Array.isArray(schema.type) ? schema.type : [schema.type];
        const matches = types.some(type => type === 'null' ? value === null : type === 'array' ? Array.isArray(value) : type === 'object' ? !!value && typeof value === 'object' && !Array.isArray(value) : type === 'integer' ? typeof value === 'number' && Number.isInteger(value) : typeof value === type);
        if (!matches)
            return bad(`Expected ${types.join(' or ')}.`);
    }
    if (typeof value === 'number' && ((schema.minimum !== undefined && value < schema.minimum) || (schema.maximum !== undefined && value > schema.maximum)))
        return bad(`Value is outside [${schema.minimum ?? '-∞'}, ${schema.maximum ?? '∞'}].`);
    if (typeof value === 'string' && ((schema.minLength !== undefined && value.length < schema.minLength) || (schema.maxLength !== undefined && value.length > schema.maxLength) || (schema.pattern && !new RegExp(schema.pattern).test(value))))
        return bad('String length or format is invalid.');
    if (Array.isArray(value)) {
        if ((schema.minItems !== undefined && value.length < schema.minItems) || (schema.maxItems !== undefined && value.length > schema.maxItems))
            return bad('Array length is outside the supported limit.');
        return schema.items ? value.flatMap((v, i) => schemaErrors(v, schema.items!, `${path}[${i}]`)).slice(0, 32) : [];
    }
    if (value && typeof value === 'object') {
        const entries = Object.entries(value);
        if (schema.maxProperties !== undefined && entries.length > schema.maxProperties)
            return bad('Object entry limit exceeded.');
        const errors: Diagnostic[] = [];
        for (const key of schema.required ?? [])
            if (!Object.hasOwn(value, key))
                errors.push(...bad(`Missing required field '${key}'.`));
        for (const [key, item] of entries) {
            if (schema.propertyNames)
                errors.push(...schemaErrors(key, schema.propertyNames, `${path}.${key}`));
            const child = schema.properties?.[key];
            if (child)
                errors.push(...schemaErrors(item, child, `${path}.${key}`));
            else if (schema.additionalProperties === false)
                errors.push(...schemaErrors(undefined, { const: 'unknown fields are rejected' }, `${path}.${key}`).map(d => ({ ...d, message: 'Unknown field.' })));
            else if (typeof schema.additionalProperties === 'object')
                errors.push(...schemaErrors(item, schema.additionalProperties, `${path}.${key}`));
        }
        return errors.slice(0, 32);
    }
    return [];
}
export interface CompiledDocument {
    document: VisualizationDocument;
    expressions: Record<string, ExpressionNode>;
    order: string[];
    types: Record<string, ExpressionType>;
    end?: ExpressionNode;
    series: Record<string, {
        x: ExpressionNode;
        y: ExpressionNode;
    }>;
}
export function compileDocument(input: unknown): CompiledDocument {
    assertJSON(input);
    const issues = schemaErrors(input, DOCUMENT_SCHEMA, '$');
    if (issues.length)
        throw new DocumentError(issues);
    const document = structuredClone(input) as VisualizationDocument;
    const expressions: Record<string, ExpressionNode> = Object.create(null), types: Record<string, ExpressionType> = Object.create(null), order: string[] = [];
    const symbols = new Set<string>();
    const checkId = (id: string, path: string, expression = false) => {
        if (id.length > 80 || !(expression ? symbolPattern : /^[A-Za-z_][A-Za-z0-9_.-]*$/).test(id) || reserved.has(id) || id.split('.').some(piece => reserved.has(piece)))
            error(path, 'Invalid or reserved identifier.');
    };
    for (const collection of ['parameters', 'quantities', 'datasets', 'series'] as const)
        for (const id of Object.keys(document[collection] ?? {})) {
            checkId(id, `$.${collection}.${id}`, collection === 'parameters' || collection === 'quantities');
            if ((collection === 'parameters' || collection === 'quantities') && symbols.has(id))
                error(`$.${collection}.${id}`, 'Parameter and quantity identifiers must be distinct.');
            if (collection === 'parameters' || collection === 'quantities')
                symbols.add(id);
        }
    for (const [id, p] of Object.entries(document.parameters)) {
        if (p.integer && !Number.isSafeInteger(p.value))
            error(`$.parameters.${id}.value`, 'Integer parameters require a safe integer default.');
        if (p.min > p.max || p.value < p.min || p.value > p.max)
            error(`$.parameters.${id}`, 'Parameter default must lie in its ordered bounds.');
        types[id] = { size: 1, dimension: parseDimension(p.dimension, `$.parameters.${id}.dimension`) };
    }
    for (const [id, q] of Object.entries(document.quantities))
        expressions[id] = parseExpression(q.expression, `$.quantities.${id}.expression`);
    const visiting = new Set<string>(), visited = new Set<string>();
    function quantity(id: string, depth = 0): ExpressionType {
        if (depth > 128)
            error(`$.quantities.${id}`, 'Quantity dependency depth exceeded.', 'LIMIT');
        if (Object.hasOwn(types, id))
            return types[id];
        if (visiting.has(id))
            error(`$.quantities.${id}.expression`, 'Quantity dependency cycle.', 'REFERENCE');
        if (!Object.hasOwn(expressions, id))
            error(`$.quantities.${id}`, 'Unknown quantity reference.', 'REFERENCE');
        visiting.add(id);
        const path = `$.quantities.${id}.expression`;
        const inferred = inferExpressionType(expressions[id], name => resolve(name, path, depth + 1), path), declared = document.quantities[id].dimension;
        if (declared) {
            const dimension = parseDimension(declared, `$.quantities.${id}.dimension`);
            const isLiteral = typeof document.quantities[id].expression !== 'string';
            if (!isLiteral && !sameDimension(inferred.dimension, dimension))
                error(path, 'Declared dimension does not match expression.', 'DIMENSION');
            inferred.dimension = dimension;
        }
        types[id] = inferred;
        visiting.delete(id);
        if (!visited.has(id)) {
            order.push(id);
            visited.add(id);
        }
        return inferred;
    }
    function resolve(name: string, path: string, depth = 0): ExpressionType {
        if (name === 'time')
            return { size: 1, dimension: { time: 1 } };
        if (Object.hasOwn(document.parameters, name))
            return types[name];
        if (Object.hasOwn(expressions, name))
            return quantity(name, depth);
        return error(path, `Unknown reference '${name}'.`, 'REFERENCE');
    }
    for (const id of Object.keys(expressions))
        quantity(id);
    // Resolve references separately so reserved names cannot hide in otherwise unchecked metadata.
    for (const [id, expression] of Object.entries(expressions))
        for (const ref of expressionReferences(expression))
            if (ref !== 'pi' && ref !== 'e')
                resolve(ref, `$.quantities.${id}.expression`);
    let end: ExpressionNode | undefined;
    if (document.time) {
        end = parseExpression(document.time.end, '$.time.end');
        const type = inferExpressionType(end, n => resolve(n, '$.time.end'), '$.time.end');
        if (type.size !== 1 || (!sameDimension(type.dimension, { time: 1 }) && !sameDimension(type.dimension, {})))
            error('$.time.end', 'Time end must be a scalar duration.');
        const refs = expressionReferences(end);
        const dependsOnTime = (id: string, seen = new Set<string>()): boolean => {
            if (id === 'time')
                return true;
            if (seen.has(id) || !expressions[id])
                return false;
            seen.add(id);
            return expressionReferences(expressions[id]).some(ref => dependsOnTime(ref, seen));
        };
        if (refs.some(r => dependsOnTime(r)))
            error('$.time.end', 'Time end cannot depend on the current time.');
        document.time.step ??= 1 / 60;
    }
    let cells = 0;
    for (const [id, dataset] of Object.entries(document.datasets ?? {})) {
        const ids = new Set<string>();
        for (const column of dataset.columns) {
            checkId(column.id, `$.datasets.${id}.columns`);
            if (ids.has(column.id))
                error(`$.datasets.${id}.columns`, 'Duplicate column identifier.');
            ids.add(column.id);
        }
        for (const row of dataset.rows)
            if (row.length !== dataset.columns.length)
                error(`$.datasets.${id}.rows`, 'Every row must match the column count.');
        cells += dataset.rows.length * dataset.columns.length;
    }
    if (cells > DOCUMENT_LIMITS.datasetCells)
        error('$.datasets', 'Total dataset cell limit exceeded.', 'LIMIT');
    const series: CompiledDocument['series'] = Object.create(null);
    let samples = 0;
    for (const [id, s] of Object.entries(document.series ?? {})) {
        const path = `$.series.${id}`;
        if (s.dataset) {
            if (s.x !== undefined || s.y !== undefined || s.variable !== undefined || s.domain !== undefined || s.samples !== undefined)
                error(path, 'A dataset series cannot also declare sampled expressions.');
            const dataset = document.datasets?.[s.dataset];
            if (!dataset)
                error(path, `Unknown dataset '${s.dataset}'.`, 'REFERENCE');
            if (!s.xColumn || !s.yColumn || !dataset!.columns.some(c => c.id === s.xColumn) || !dataset!.columns.some(c => c.id === s.yColumn))
                error(path, 'Dataset series must name existing xColumn and yColumn.');
            s.kind ??= 'observed';
        }
        else {
            if (s.xColumn !== undefined || s.yColumn !== undefined || !s.y || !s.domain)
                error(path, 'Sampled series needs y and domain; column names require dataset.');
            if (s.domain![0] >= s.domain![1])
                error(`${path}.domain`, 'Sampling domain must be strictly increasing.');
            s.variable ??= 'x';
            checkId(s.variable, `${path}.variable`, true);
            if (symbols.has(s.variable) || reserved.has(s.variable))
                error(`${path}.variable`, 'Sampling variable must not shadow a parameter, quantity, or constant.');
            s.x ??= s.variable;
            s.samples ??= 201;
            s.kind ??= 'model';
            samples += s.samples;
            const x = parseExpression(s.x, `${path}.x`), y = parseExpression(s.y!, `${path}.y`);
            const resolver = (n: string) => n === s.variable ? { size: 1, dimension: {} } : resolve(n, path);
            for (const [name, node] of [['x', x], ['y', y]] as const) {
                const type = inferExpressionType(node, resolver, `${path}.${name}`);
                if (type.size !== 1)
                    error(`${path}.${name}`, 'Series coordinates must be scalar.');
            }
            series[id] = { x, y };
        }
    }
    if (samples > DOCUMENT_LIMITS.totalSamples)
        error('$.series', 'Total sample limit exceeded.', 'LIMIT');
    const size = (name: string) => types[name]?.size ?? 1;
    let operations = Object.values(expressions).reduce((total, node) => total + expressionOperationCost(node, size), 0) * (document.time ? 2 : 1);
    if (end)
        operations += expressionOperationCost(end, size);
    for (const [id, asts] of Object.entries(series))
        operations += (expressionOperationCost(asts.x, size, true) + expressionOperationCost(asts.y, size, true)) * document.series![id].samples!;
    if (operations > DOCUMENT_LIMITS.totalOperations)
        error('$.series', 'Expression workload exceeds two million bounded primitive operations per frame.', 'LIMIT');
    const viewIds = new Set<string>(), markIds = new Set<string>();
    let markCount = 0;
    const quantityRef = (id: string, path: string, size?: number) => {
        if (!Object.hasOwn(document.quantities, id))
            error(path, `Unknown quantity '${id}'.`, 'REFERENCE');
        if (size !== undefined && types[id].size !== size)
            error(path, `Expected ${size === 1 ? 'scalar' : `${size}-component vector`} quantity.`);
        return types[id];
    };
    function mark(m: MarkSpec, path: string, depth: number): void {
        if (++markCount > DOCUMENT_LIMITS.marks || depth > DOCUMENT_LIMITS.groupDepth)
            error(path, 'Mark count or group depth limit exceeded.', 'LIMIT');
        checkId(m.id, `${path}.id`);
        if (markIds.has(m.id))
            error(`${path}.id`, 'Mark identifiers must be unique across views.');
        markIds.add(m.id);
        if (m.semanticId)
            checkId(m.semanticId, `${path}.semanticId`);
        if (m.text !== undefined && m.type !== 'label')
            error(`${path}.text`, 'Text is supported only by label marks.');
        if (m.offset !== undefined && m.type !== 'label')
            error(`${path}.offset`, 'Screen placement offsets are supported only by label marks.');
        if (m.type === 'group' && m.style && Object.keys(m.style).some(key => !['hidden', 'opacity'].includes(key)))
            error(`${path}.style`, 'Groups support hidden and opacity only; style child marks explicitly.');
        if (m.type === 'label' && m.style && (m.style.dash !== undefined || m.style.strokeWidth !== undefined))
            error(`${path}.style`, 'Labels support fill, stroke color, opacity and hidden; line dash/width do not apply.');
        if (['line', 'segment', 'arrow', 'angle'].includes(m.type) && m.style?.fill !== undefined && m.style.fill !== 'none')
            error(`${path}.style.fill`, 'This line mark has no fill area; use stroke for its color.');
        if (m.style)
            for (const key of ['stroke', 'fill'] as const) {
                const color = m.style[key];
                if (color && !/^(?:#[0-9a-fA-F]{3,8}|[a-zA-Z]{1,30}|(?:rgb|rgba|hsl|hsla)\([0-9.,%\s+-]+\))$/.test(color))
                    error(`${path}.style.${key}`, 'Use a literal color; URLs, CSS variables and external resources are not supported.');
            }
        const bindings = m.bindings ?? {};
        let allowed: string[] = [], required: string[] = [];
        switch (m.type) {
            case 'point':
            case 'label':
                allowed = ['position', 'x', 'y'];
                required = bindings.position ? ['position'] : ['x', 'y'];
                if (bindings.position && (bindings.x || bindings.y))
                    error(`${path}.bindings`, 'Use position or x/y, not both.');
                break;
            case 'segment':
            case 'arrow':
                allowed = required = ['start', 'end'];
                break;
            case 'path':
            case 'polygon':
                allowed = required = ['points'];
                break;
            case 'circle':
                allowed = required = ['center', 'radius'];
                break;
            case 'ellipse':
                allowed = required = ['center', 'rx', 'ry'];
                break;
            case 'angle':
                allowed = required = ['center', 'radius', 'startAngle', 'endAngle'];
                break;
            case 'line':
            case 'scatter':
            case 'bar':
            case 'region':
                allowed = m.type === 'bar' || m.type === 'region' ? ['baseline'] : [];
                if (!m.series)
                    error(`${path}.series`, 'Plot marks require a series.');
                break;
            case 'group':
                if (!m.children?.length)
                    error(`${path}.children`, 'Groups require children.');
                break;
        }
        for (const key of required)
            if (!bindings[key])
                error(`${path}.bindings.${key}`, 'Required model binding is missing.');
        for (const [key, ref] of Object.entries(bindings)) {
            if (!allowed.includes(key))
                error(`${path}.bindings.${key}`, 'Binding is not supported for this mark.');
            const size = ['position', 'center', 'start', 'end'].includes(key) ? 2 : key === 'points' ? undefined : 1;
            const type = quantityRef(ref, `${path}.bindings.${key}`, size);
            if (key === 'points' && (type.size % 2 !== 0 || type.size < (m.type === 'polygon' ? 6 : 4)))
                error(`${path}.bindings.points`, 'Expected a flat vector of coordinate pairs (at least three pairs for polygons).');
        }
        if (m.series && !Object.hasOwn(document.series ?? {}, m.series))
            error(`${path}.series`, 'Unknown series.', 'REFERENCE');
        if (m.series && !['line', 'scatter', 'bar', 'region'].includes(m.type))
            error(`${path}.series`, 'Only plot marks accept a series.');
        if (m.children && m.type !== 'group')
            error(`${path}.children`, 'Only group marks accept children.');
        if (m.drag) {
            if (m.type !== 'point')
                error(`${path}.drag`, 'Dragging is supported for point marks.');
            for (const axis of ['x', 'y'] as const)
                if (!Object.hasOwn(document.parameters, m.drag[axis]))
                    error(`${path}.drag.${axis}`, 'Drag bindings must name parameters.');
            if (m.drag.x === m.drag.y)
                error(`${path}.drag`, 'Drag axes must bind distinct parameters.');
        }
        if (m.type === 'label' && !m.text)
            error(`${path}.text`, 'Label marks require text.');
        m.children?.forEach((child, i) => mark(child, `${path}.children[${i}]`, depth + 1));
    }
    document.views.forEach((view, i) => {
        const path = `$.views[${i}]`;
        checkId(view.id, `${path}.id`);
        if (viewIds.has(view.id))
            error(`${path}.id`, 'Duplicate view identifier.');
        viewIds.add(view.id);
        const graphical = view.type === 'scene' || view.type === 'plot';
        for (const field of ['marks', 'bounds', 'equalAspect', 'xLabel', 'yLabel', 'scale'] as const)
            if (view[field] !== undefined && !graphical)
                error(`${path}.${field}`, 'This field is supported only in scene and plot views.');
        if (view.dataset !== undefined && view.type !== 'table')
            error(`${path}.dataset`, 'Datasets are displayed by table views; plots use dataset series.');
        if (view.equation !== undefined && view.type !== 'equation')
            error(`${path}.equation`, 'Equation templates are supported only in equation views.');
        if (view.quantities !== undefined && !['values', 'table'].includes(view.type))
            error(`${path}.quantities`, 'Quantity lists are supported only in values and table views; equations use substitutions.');
        if (view.type === 'values' && !view.quantities?.length)
            error(`${path}.quantities`, 'Values views require at least one quantity.');
        if (view.type === 'table' && view.dataset && view.quantities !== undefined)
            error(path, 'Choose a dataset or a quantity table, not both.');
        view.quantities?.forEach((id, j) => quantityRef(id, `${path}.quantities[${j}]`));
        if (view.bounds && (view.bounds[0] >= view.bounds[1] || view.bounds[2] >= view.bounds[3] || !Number.isFinite(view.bounds[1] - view.bounds[0]) || !Number.isFinite(view.bounds[3] - view.bounds[2])))
            error(`${path}.bounds`, 'Bounds must be [xMin, xMax, yMin, yMax] with finite increasing axes.');
        if (view.scale === 'log' && (!view.bounds || view.bounds[0] <= 0 || view.bounds[2] <= 0))
            error(`${path}.bounds`, 'Log views require explicit strictly positive bounds on both axes.');
        if (view.type === 'scene')
            view.equalAspect ??= true;
        if (view.dataset && !Object.hasOwn(document.datasets ?? {}, view.dataset))
            error(`${path}.dataset`, 'Unknown dataset.', 'REFERENCE');
        if (view.type === 'table' && !view.dataset && !view.quantities?.length)
            error(path, 'Table views require a dataset or quantities.');
        if (view.type === 'equation' && !view.equation)
            error(`${path}.equation`, 'Equation views require an equation template.');
        if (view.equation) {
            for (const ref of view.equation.matchAll(/\{\{([^{}]+)\}\}/g))
                quantityRef(ref[1], `${path}.equation`);
            if (view.equation.replace(/\{\{[^{}]+\}\}/g, '').includes('{{'))
                error(`${path}.equation`, 'Unclosed equation substitution.');
        }
        view.marks?.forEach((m, j) => mark(m, `${path}.marks[${j}]`, 0));
    });
    if (document.capabilities) {
        const seen = new Set<string>();
        for (const cap of document.capabilities) {
            if (seen.has(cap.id))
                error('$.capabilities', 'Duplicate capability.');
            seen.add(cap.id);
            if (!SUPPORTED_DOCUMENT_CAPABILITIES.some(c => c.id === cap.id && c.version === cap.version))
                error('$.capabilities', `Unsupported capability '${cap.id}@${cap.version}'.`, 'UNSUPPORTED_CAPABILITY');
        }
    }
    if (document.presentation?.locale) {
        try {
            new Intl.NumberFormat(document.presentation.locale);
        }
        catch {
            error('$.presentation.locale', 'Unsupported locale format.');
        }
    }
    document.provenance ??= { review: 'unreviewed', checks: 'none' };
    return { document, expressions, types, order, end, series };
}
export const SUPPORTED_DOCUMENT_CAPABILITIES = Object.freeze([Object.freeze({ id: 'declarative-2d', version: '1.0' }), Object.freeze({ id: 'bounded-expressions', version: '1.0' }), Object.freeze({ id: 'bounded-datasets', version: '1.0' })]);
export function normalizeDocument(input: unknown): VisualizationDocument { return compileDocument(input).document; }
