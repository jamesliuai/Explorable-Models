/**
 * Frame validation and identity. Kernel and worker output is never trusted: payload size is bounded before any deep
 * inspection, every key is exact, values match declared shapes, geometry respects `maxElements`, and the terminal
 * state must agree with the evaluated position. Geometry element counts are points/vertices/samples: a polyline
 * counts its points, `segments2/3` count two vertices per segment, a surface grid counts nx·ny samples.
 */
import { digest } from '../identity.js';
import { diagnostic, fail, ModelError } from './errors.js';
import { jsonDataErrors, type DataLimits } from './json-schema.js';
import { matchesObservations, observationGeometryIds, observedGeometry } from './observations.js';
import type {
  FramePosition, FrameRun, FrameTerminal, GeometryResult, KernelOutput, ModelFrame, ModelGeometryDefinition, ModelManifest, ModelQuantityDefinition,
  ModelRef, PositionRequest, QuantityResult, QuantityShape,
} from './types.js';

export const FRAME_LIMITS = Object.freeze({ reason: 2000, code: 64, id: 128 });
const UNDEFINED_CODE = /^[A-Z][A-Z0-9_]{0,63}$/;

const protocol = (path: string, message = 'Kernel output does not match the manifest.'): never => { throw new ModelError([diagnostic('WORKER_PROTOCOL', path, message)]); };
const isObject = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
function exact(value: unknown, path: string, required: readonly string[], optional: readonly string[] = []): Record<string, unknown> {
  if (!isObject(value)) return protocol(path, 'Expected an object.');
  for (const key of required) if (!Object.hasOwn(value, key)) protocol(`${path}.${key}`, 'Required field is missing.');
  for (const key of Object.keys(value)) if (!required.includes(key) && !optional.includes(key)) protocol(`${path}.${key.slice(0, 64)}`, 'Unknown field.');
  return value;
}
const finite = (value: unknown, path: string): number => typeof value === 'number' && Number.isFinite(value) ? value : protocol(path, 'Expected a finite number.');
const text = (value: unknown, path: string, max: number = FRAME_LIMITS.reason): string => typeof value === 'string' && value.length > 0 && value.length <= max ? value : protocol(path, `Expected text of 1–${max} characters.`);
function list(value: unknown, path: string, max: number, min = 0): unknown[] {
  if (!Array.isArray(value)) return protocol(path, 'Expected an array.');
  if (value.length > max) protocol(path, 'Geometry exceeds its declared maxElements.');
  if (value.length < min) protocol(path, 'Array is too short.');
  return value;
}
function vector(value: unknown, length: number, path: string): number[] {
  if (!Array.isArray(value) || value.length !== length) return protocol(path, `Expected ${length} coordinates.`);
  value.forEach((item, index) => finite(item, `${path}[${index}]`));
  return value as number[];
}
function uniqueIds(items: { id?: unknown }[], path: string): void {
  const ids = new Set<string>();
  items.forEach((item, index) => { const id = text(item.id, `${path}[${index}].id`, FRAME_LIMITS.id); if (ids.has(id)) protocol(`${path}[${index}].id`, 'Duplicate element ID.'); ids.add(id); });
}

export const shapeSize = (shape: QuantityShape): number => shape.kind === 'vector' ? shape.length : shape.kind === 'matrix' ? shape.rows * shape.columns : 1;

/** Upper bound on JSON nodes/bytes a legitimate output for this manifest can contain. */
export function outputLimits(manifest: ModelManifest): DataLimits {
  let nodes = 32;
  for (const q of Object.values(manifest.quantities)) nodes += shapeSize(q.shape) + 12;
  for (const g of Object.values(manifest.geometry)) nodes += 16 * g.maxElements + 32;
  return { maxDepth: 10, maxNodes: nodes, maxBytes: Math.min(64_000_000, nodes * 64 + 1_000_000) };
}

function checkValue(shape: QuantityShape, value: unknown, path: string): void {
  if (shape.kind === 'scalar') { finite(value, path); return; }
  if (shape.kind === 'category') { if (typeof value !== 'string' || !shape.values.includes(value)) protocol(path, 'Expected a declared category value.'); return; }
  vector(value, shapeSize(shape), path);
}
function quantityResult(definition: ModelQuantityDefinition, value: unknown, path: string, position: FramePosition): QuantityResult {
  const status = isObject(value) ? value.status : undefined;
  if (status === 'valid') {
    const result = exact(value, path, ['status', 'value'], ['approximation']);
    checkValue(definition.shape, result.value, `${path}.value`);
    if (result.approximation !== undefined) {
      const approximation = exact(result.approximation, `${path}.approximation`, ['code', 'reason']);
      if (approximation.code !== 'UNDERFLOW' && approximation.code !== 'ROUNDING') protocol(`${path}.approximation.code`, 'Unknown approximation code.');
      text(approximation.reason, `${path}.approximation.reason`);
    }
  } else if (status === 'undefined') {
    const result = exact(value, path, ['status', 'code', 'reason']);
    if (typeof result.code !== 'string' || !UNDEFINED_CODE.test(result.code)) protocol(`${path}.code`, 'Expected an uppercase reason code.');
    text(result.reason, `${path}.reason`);
  } else if (status === 'numerical-limit') {
    const result = exact(value, path, ['status', 'code', 'reason'], ['lastFiniteIndex']);
    if (!['OVERFLOW', 'UNDERFLOW', 'ITERATION_LIMIT'].includes(result.code as string)) protocol(`${path}.code`, 'Unknown numerical-limit code.');
    text(result.reason, `${path}.reason`);
    if (result.lastFiniteIndex !== undefined && (!Number.isSafeInteger(result.lastFiniteIndex) || (result.lastFiniteIndex as number) < 0 || position.kind === 'index' && (result.lastFiniteIndex as number) > position.index))
      protocol(`${path}.lastFiniteIndex`, 'lastFiniteIndex must be a nonnegative index no later than the frame.');
  } else protocol(`${path}.status`, 'Unknown quantity status.');
  return value as QuantityResult;
}

function polyline(value: Record<string, unknown>, definition: ModelGeometryDefinition, path: string, size: 2 | 3): void {
  const result = exact(value, path, ['kind', 'segments', 'gaps'], size === 2 ? ['sampling'] : []);
  const segments = list(result.segments, `${path}.segments`, definition.maxElements);
  let points = 0;
  segments.forEach((item, index) => {
    const at = `${path}.segments[${index}]`, segment = exact(item, at, ['points', 'start', 'end']);
    const coordinates = list(segment.points, `${at}.points`, definition.maxElements, 1);
    points += coordinates.length;
    if (points > definition.maxElements) protocol(`${at}.points`, 'Geometry exceeds its declared maxElements.');
    coordinates.forEach((point, n) => vector(point, size, `${at}.points[${n}]`));
    for (const end of ['start', 'end'] as const) if (!['open', 'closed', 'none'].includes(segment[end] as string)) protocol(`${at}.${end}`, 'Unknown endpoint.');
  });
  const gaps = list(result.gaps, `${path}.gaps`, segments.length + 1);
  gaps.forEach((item, index) => {
    const at = `${path}.gaps[${index}]`, gap = exact(item, at, ['after', 'before', 'reason']);
    for (const side of ['after', 'before'] as const) if (gap[side] !== null && (!Number.isSafeInteger(gap[side]) || (gap[side] as number) < 0 || (gap[side] as number) >= segments.length)) protocol(`${at}.${side}`, 'Gap must reference adjacent segment indices or null.');
    if (gap.after !== null && gap.before !== null && gap.before !== (gap.after as number) + 1) protocol(at, 'A gap lies between consecutive segments.');
    text(gap.reason, `${at}.reason`);
  });
  if (result.sampling !== undefined) {
    const sampling = exact(result.sampling, `${path}.sampling`, ['samples', 'domain']);
    if (!Number.isSafeInteger(sampling.samples) || (sampling.samples as number) < 1 || (sampling.samples as number) > definition.maxElements || (sampling.samples as number) < points) protocol(`${path}.sampling.samples`, 'Sample count is inconsistent with the geometry.');
    const domain = vector(sampling.domain, 2, `${path}.sampling.domain`);
    if (!(domain[0] < domain[1])) protocol(`${path}.sampling.domain`, 'Sampling domain must be increasing.');
  }
}

function geometryResult(definition: ModelGeometryDefinition, value: unknown, path: string): GeometryResult {
  if (!isObject(value) || value.kind !== definition.kind) return protocol(`${path}.kind`, 'Geometry kind differs from the manifest.');
  const max = definition.maxElements;
  switch (definition.kind) {
    // Observed data are compared with the manifest dataset instead (validateKernelOutput); a kernel never returns them.
    case 'observations2': return protocol(path, 'Observed data are attached from the manifest, never computed.');
    case 'polyline2': polyline(value, definition, path, 2); break;
    case 'polyline3': polyline(value, definition, path, 3); break;
    case 'points2': case 'points3': {
      const size = definition.kind === 'points2' ? 2 : 3;
      const points = list(exact(value, path, ['kind', 'points']).points, `${path}.points`, max);
      points.forEach((item, index) => {
        const at = `${path}.points[${index}]`, point = exact(item, at, ['id', 'at'], ['reason']);
        if (point.at === null) text(point.reason, `${at}.reason`);
        else { vector(point.at, size, `${at}.at`); if (point.reason !== undefined) protocol(`${at}.reason`, 'A reason is reported only for a missing point.'); }
      });
      uniqueIds(points as { id?: unknown }[], `${path}.points`);
      break;
    }
    case 'segments2': case 'segments3': {
      const size = definition.kind === 'segments2' ? 2 : 3;
      const segments = list(exact(value, path, ['kind', 'segments']).segments, `${path}.segments`, Math.floor(max / 2));
      segments.forEach((item, index) => { const at = `${path}.segments[${index}]`, segment = exact(item, at, ['id', 'from', 'to']); vector(segment.from, size, `${at}.from`); vector(segment.to, size, `${at}.to`); });
      uniqueIds(segments as { id?: unknown }[], `${path}.segments`);
      break;
    }
    case 'polygon2': {
      const polygon = exact(value, path, ['kind', 'vertices', 'degenerate']);
      list(polygon.vertices, `${path}.vertices`, max).forEach((vertex, index) => vector(vertex, 2, `${path}.vertices[${index}]`));
      if (typeof polygon.degenerate !== 'boolean') protocol(`${path}.degenerate`, 'Expected a boolean.');
      break;
    }
    case 'surface-grid': {
      const grid = exact(value, path, ['kind', 'xs', 'ys', 'z', 'sampling']);
      const sampling = exact(grid.sampling, `${path}.sampling`, ['nx', 'ny', 'domain']);
      const nx = sampling.nx, ny = sampling.ny;
      if (!Number.isSafeInteger(nx) || !Number.isSafeInteger(ny) || (nx as number) < 1 || (ny as number) < 1 || (nx as number) * (ny as number) > max) protocol(`${path}.sampling`, 'Grid size exceeds its declared maxElements.');
      list(grid.xs, `${path}.xs`, nx as number, nx as number).forEach((x, index) => finite(x, `${path}.xs[${index}]`));
      list(grid.ys, `${path}.ys`, ny as number, ny as number).forEach((y, index) => finite(y, `${path}.ys[${index}]`));
      list(grid.z, `${path}.z`, (nx as number) * (ny as number), (nx as number) * (ny as number)).forEach((z, index) => { if (z !== null) finite(z, `${path}.z[${index}]`); });
      const domain = vector(sampling.domain, 4, `${path}.sampling.domain`);
      if (!(domain[0] < domain[1] && domain[2] < domain[3])) protocol(`${path}.sampling.domain`, 'Grid domain must be increasing.');
      break;
    }
    case 'vector-field2': case 'vector-field3': {
      const size = definition.kind === 'vector-field2' ? 2 : 3;
      const field = exact(value, path, ['kind', 'samples', 'scale']);
      list(field.samples, `${path}.samples`, max).forEach((item, index) => { const at = `${path}.samples[${index}]`, sample = exact(item, at, ['at', 'vector']); vector(sample.at, size, `${at}.at`); vector(sample.vector, size, `${at}.vector`); });
      const scale = exact(field.scale, `${path}.scale`, ['factor', 'disclosure']);
      if (!(finite(scale.factor, `${path}.scale.factor`) > 0)) protocol(`${path}.scale.factor`, 'Scale factor must be positive.');
      text(scale.disclosure, `${path}.scale.disclosure`);
      break;
    }
  }
  return value as GeometryResult;
}

/** The terminal implied by the position, merged with a kernel-reported numerical limit. */
function terminalFor(position: FramePosition, value: unknown): FrameTerminal {
  let reported: FrameTerminal | undefined;
  if (value !== undefined) {
    const terminal = exact(value, '$.terminal', ['reached'], ['event', 'detail']);
    if (typeof terminal.reached !== 'boolean') protocol('$.terminal.reached', 'Expected a boolean.');
    if (terminal.reached !== (terminal.event !== undefined)) protocol('$.terminal', 'A reached terminal names its event; an unreached one names none.');
    if (terminal.event !== undefined && !['max-index', 'numerical-limit', 'end-time'].includes(terminal.event as string)) protocol('$.terminal.event', 'Unknown terminal event.');
    if (terminal.detail !== undefined) text(terminal.detail, '$.terminal.detail');
    reported = terminal as unknown as FrameTerminal;
  }
  if (reported?.event === 'numerical-limit') {
    if (position.kind === 'static') protocol('$.terminal.event', 'A static model has no terminal event.');
    return { reached: true, event: 'numerical-limit', ...(reported.detail !== undefined && { detail: reported.detail }) };
  }
  const expected: FrameTerminal['event'] | undefined = position.kind === 'index' && position.index === position.maxIndex ? 'max-index'
    : position.kind === 'time' && position.endTime !== null && position.time === position.endTime ? 'end-time' : undefined;
  if (reported && reported.event !== expected) protocol('$.terminal', 'Terminal state is inconsistent with the evaluated position.');
  return expected ? { reached: true, event: expected, ...(reported?.detail !== undefined && { detail: reported.detail }) } : { reached: false };
}

/**
 * Validates untrusted kernel/worker output for an evaluated position and returns a detached copy with an explicit
 * terminal. Throws ModelError(`WORKER_PROTOCOL`) on any violation.
 *
 * Observed geometry (`observations2`, report §8.5) is never model output. With `observations: 'excluded'` (the default:
 * kernel and document output) it must be absent; the runtime attaches it from the manifest (`attachObservations`).
 * With `'included'` (a worker reply) it must be present and equal, cell for cell, to the manifest's dataset.
 */
export function validateKernelOutput(manifest: ModelManifest, position: FramePosition, output: unknown, options: { observations?: 'excluded' | 'included' } = {}): KernelOutput & { terminal: FrameTerminal } {
  const data = jsonDataErrors(output, outputLimits(manifest));
  if (data.length) protocol(data[0].path, data[0].code === 'RESOURCE_LIMIT' ? 'Kernel output exceeds the size its manifest allows.' : 'Kernel output is not plain JSON data.');
  const included = options.observations === 'included';
  const observed = new Set(observationGeometryIds(manifest));
  const root = exact(output, '$', ['quantities', 'geometry'], ['terminal']);
  const quantities = exact(root.quantities, '$.quantities', Object.keys(manifest.quantities));
  const geometry = exact(root.geometry, '$.geometry', Object.keys(manifest.geometry).filter(id => included || !observed.has(id)));
  for (const [id, definition] of Object.entries(manifest.quantities)) quantityResult(definition, quantities[id], `$.quantities.${id}`, position);
  for (const [id, definition] of Object.entries(manifest.geometry)) {
    if (!observed.has(id)) geometryResult(definition, geometry[id], `$.geometry.${id}`);
    else if (included && !matchesObservations(manifest, id, geometry[id])) protocol(`$.geometry.${id}`, 'Observed data differ from the manifest dataset.');
  }
  const terminal = terminalFor(position, root.terminal);
  return { quantities: structuredClone(quantities) as Record<string, QuantityResult>, geometry: structuredClone(geometry) as Record<string, GeometryResult>, terminal };
}

/** Validated model output with the manifest's observed geometry attached (every `observations2` entry). */
export function attachObservations<T extends { geometry: Record<string, GeometryResult> }>(manifest: ModelManifest, output: T): T {
  const observed = observedGeometry(manifest);
  return Object.keys(observed).length ? { ...output, geometry: { ...output.geometry, ...observed } } : output;
}

/** Deterministic frame identity: the same model, run, parameters and position always yield the same ID. */
export function frameId(model: ModelRef, run: FrameRun, params: Record<string, number>, position: FramePosition): string {
  return digest({ model, run, params, position });
}

export type ResolvedPosition = { kind: 'static' } | { kind: 'index'; index: number; maxIndex: number } | { kind: 'time'; time: number };
export type PositionMode = 'index' | 'time' | 'static';
export const positionMode = (manifest: ModelManifest): PositionMode =>
  manifest.execution.kind === 'kernel' ? (manifest.execution.mode === 'discrete' ? 'index' : 'static') : manifest.execution.document.time ? 'time' : 'static';
export const initialPosition = (manifest: ModelManifest): PositionRequest => {
  const mode = positionMode(manifest);
  return mode === 'index' ? { kind: 'index', index: 0 } : mode === 'time' ? { kind: 'time', time: 0 } : { kind: 'static' };
};

/**
 * Validates a position request for the manifest's execution mode. Discrete models take whole indices in
 * [0, maxIndex] (fractional → INVALID_INPUT, never evaluated; outside → OUT_OF_DOMAIN); time documents take finite
 * time ≥ 0 (later times clamp to the exact end during evaluation); static models and parametric documents take
 * `{ kind: 'static' }` only.
 */
export function checkPosition(manifest: ModelManifest, position: unknown, path = '$.position'): ResolvedPosition {
  const mode = positionMode(manifest);
  if (!isObject(position) || Object.getPrototypeOf(position) !== Object.prototype && Object.getPrototypeOf(position) !== null) return fail('INVALID_INPUT', path, 'Expected a position object.');
  const keys = Object.keys(position);
  if (position.kind !== mode) fail('INVALID_INPUT', `${path}.kind`, mode === 'index' ? 'This model is navigated by integer iteration index.' : mode === 'time' ? 'This model is navigated by time.' : 'This model has a single static state.');
  const field = mode === 'index' ? 'index' : mode === 'time' ? 'time' : null;
  if (keys.some(key => key !== 'kind' && key !== field) || field && !keys.includes(field)) fail('INVALID_INPUT', path, `Expected exactly { kind${field ? `, ${field}` : ''} }.`);
  if (mode === 'static') return { kind: 'static' };
  const value = position[field!];
  if (typeof value !== 'number' || !Number.isFinite(value)) fail('INVALID_INPUT', `${path}.${field}`, 'Expected a finite number.');
  if (mode === 'index') {
    const maxIndex = (manifest.execution as { maxIndex: number }).maxIndex;
    if (!Number.isInteger(value)) fail('INVALID_INPUT', `${path}.index`, 'Iteration indices are whole numbers; a fractional index is never evaluated.', 'Choose a whole iteration index.');
    if (value < 0 || value > maxIndex) fail('OUT_OF_DOMAIN', `${path}.index`, `Expected an index from 0 to ${maxIndex}.`);
    return { kind: 'index', index: value === 0 ? 0 : value, maxIndex };
  }
  if (value < 0) fail('OUT_OF_DOMAIN', `${path}.time`, 'Time must be nonnegative.');
  return { kind: 'time', time: value === 0 ? 0 : value };
}

/** Attaches identity to validated evaluation data. */
export function assembleFrame(model: ModelRef, run: FrameRun, data: Omit<ModelFrame, 'frameId' | 'run' | 'model'>): ModelFrame {
  return { frameId: frameId(model, run, data.params, data.position), model, run, params: data.params, position: data.position, terminal: data.terminal, quantities: data.quantities, geometry: data.geometry };
}
