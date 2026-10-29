/**
 * Authoring fixtures shared by the CLI (Node, through the bundled toolkit), the browser harness page and the candidate
 * worker. Pure data and functions: no DOM, no Node APIs, no authored code.
 *
 * - `explorable-models.reference-fixtures` 1.0: external reference cases with provenance and declared tolerances, compared
 *   with frames evaluated in a browser worker. The five installed suites in `tests/reference/fixtures/activities/` keep
 *   their own richer formats; `convertInstalledSuite` maps their quantity expectations to this format and lists the
 *   geometry checks it does not carry (those stay in `tests/reference/activities/*.test.ts`).
 * - `explorable-models.boundary-cases` 1.0: declared boundary cases and generated domain probes, classified as
 *   valid / undefined / numerical-limit / out-of-domain (or worker-error), never as zero.
 * - Mutation operators for the mutation-sensitivity summary: generic faults (sign, factor, unit, transposition, input
 *   swap, fabricated zeros, boundary nudges) applied to a kernel's inputs or outputs inside the worker.
 */
import {
  checkParameters, validateJson,
  type GeometryResult, type JsonSchema, type KernelOutput, type ModelManifest, type PositionRequest, type QuantityResult, type UnitId,
} from '@explorable-models/core/model';

export const FIXTURE_CONTRACT = 'explorable-models.reference-fixtures' as const;
export const BOUNDARY_CONTRACT = 'explorable-models.boundary-cases' as const;
export const FIXTURE_VERSION = '1.0' as const;
export const FIXTURE_LIMITS = Object.freeze({ cases: 2000, points: 2000, problemsPerCase: 8, boundaryCases: 256, mutations: 240 });

export interface Tolerance { absolute: number; relative: number }
export type ValueExpectation = number | number[] | string;
/**
 * A plain value means `valid` with no approximation note. The object forms state a status explicitly; for `valid`,
 * `approximation` defaults to `none` when a value is given and to `any` when it is omitted.
 */
export type Expectation =
  | ValueExpectation
  | { status: 'valid'; value?: ValueExpectation; approximation?: 'UNDERFLOW' | 'ROUNDING' | 'none' | 'any' }
  | { status: 'undefined'; code?: string }
  | { status: 'numerical-limit'; code?: 'OVERFLOW' | 'UNDERFLOW' | 'ITERATION_LIMIT'; lastFiniteIndex?: number };

export interface ReferencePoint { position?: PositionRequest; expect: Record<string, Expectation>; note?: string }
export interface ReferenceCase {
  id: string;
  label: string;
  provenance: string;
  /** Complete canonical-unit parameter values. */
  params: Record<string, number>;
  tolerance: Tolerance;
  /** Per-quantity tolerance overrides. */
  tolerances?: Record<string, Tolerance>;
  families?: string[];
  /** Evaluation points (exactly one of `points` and `reject`). */
  points?: ReferencePoint[];
  /** The parameters are rejected before evaluation with this code (and path, when given). */
  reject?: { code: string; path?: string };
}
export interface ReferenceSuite {
  contract: typeof FIXTURE_CONTRACT;
  version: typeof FIXTURE_VERSION;
  suiteId: string;
  /** The model this suite applies to. */
  model: { modelId: string; version: string };
  author: string;
  review: string;
  semantics: string;
  /** Present when the suite was converted from another fixture file; `digest` is that file's exact sha256. */
  derivedFrom: { path: string; digest: string; suiteId: string; conversion: string } | null;
  /** Expectations of the source that this suite does not carry, and where they are checked instead. */
  notCovered: string[];
  cases: ReferenceCase[];
}

export type BoundaryOutcome = 'valid' | 'undefined' | 'numerical-limit' | 'out-of-domain' | 'worker-error';
export interface BoundaryCase {
  id: string;
  label: string;
  rationale: string;
  /** Parameter values merged over the manifest defaults. */
  params: Record<string, number>;
  position?: PositionRequest;
  expect?: { outcome?: BoundaryOutcome; statuses?: Record<string, string> };
}
export interface BoundarySet { contract: typeof BOUNDARY_CONTRACT; version: typeof FIXTURE_VERSION; cases: BoundaryCase[] }

// ---------------------------------------------------------------------------------------------
// Schemas (JSON data safety first, then shape)
// ---------------------------------------------------------------------------------------------
const ID = '^[A-Za-z0-9][A-Za-z0-9_.:@=-]{0,159}$';
const text = (maxLength: number): JsonSchema => ({ type: 'string', minLength: 1, maxLength });
const id = (): JsonSchema => ({ type: 'string', minLength: 1, maxLength: 160, pattern: ID });
const number: JsonSchema = { type: 'number' };
const tolerance: JsonSchema = { type: 'object', properties: { absolute: { type: 'number', minimum: 0 }, relative: { type: 'number', minimum: 0 } }, required: ['absolute', 'relative'], additionalProperties: false };
const params: JsonSchema = { type: 'object', additionalProperties: number, maxProperties: 256 };
const position: JsonSchema = {
  anyOf: [
    { type: 'object', properties: { kind: { const: 'static' } }, required: ['kind'], additionalProperties: false },
    { type: 'object', properties: { kind: { const: 'index' }, index: { type: 'integer', minimum: 0 } }, required: ['kind', 'index'], additionalProperties: false },
    { type: 'object', properties: { kind: { const: 'time' }, time: { type: 'number', minimum: 0 } }, required: ['kind', 'time'], additionalProperties: false },
  ],
};
const value: JsonSchema = { anyOf: [number, { type: 'string', minLength: 1, maxLength: 200 }, { type: 'array', items: number, maxItems: 64, minItems: 1 }] };
const expectation: JsonSchema = {
  anyOf: [
    value,
    { type: 'object', properties: { status: { const: 'valid' }, value, approximation: { enum: ['UNDERFLOW', 'ROUNDING', 'none', 'any'] } }, required: ['status'], additionalProperties: false },
    { type: 'object', properties: { status: { const: 'undefined' }, code: { type: 'string', minLength: 1, maxLength: 64, pattern: '^[A-Z][A-Z0-9_]{0,63}$' } }, required: ['status'], additionalProperties: false },
    { type: 'object', properties: { status: { const: 'numerical-limit' }, code: { enum: ['OVERFLOW', 'UNDERFLOW', 'ITERATION_LIMIT'] }, lastFiniteIndex: { type: 'integer', minimum: 0 } }, required: ['status'], additionalProperties: false },
  ],
};
const point: JsonSchema = { type: 'object', properties: { position, expect: { type: 'object', additionalProperties: expectation, maxProperties: 256 }, note: text(400) }, required: ['expect'], additionalProperties: false };
const referenceCase: JsonSchema = {
  type: 'object',
  properties: {
    id: id(), label: text(400), provenance: text(4000), params, tolerance, tolerances: { type: 'object', additionalProperties: tolerance, maxProperties: 256 },
    families: { type: 'array', items: { type: 'string', minLength: 1, maxLength: 64 }, maxItems: 32 },
    points: { type: 'array', items: point, minItems: 1, maxItems: FIXTURE_LIMITS.points },
    reject: { type: 'object', properties: { code: { type: 'string', minLength: 1, maxLength: 64, pattern: '^[A-Z][A-Z0-9_]{0,63}$' }, path: text(200) }, required: ['code'], additionalProperties: false },
  },
  required: ['id', 'label', 'provenance', 'params', 'tolerance'],
  additionalProperties: false,
};
export const REFERENCE_SUITE_SCHEMA: JsonSchema = {
  type: 'object',
  properties: {
    contract: { const: FIXTURE_CONTRACT }, version: { const: FIXTURE_VERSION }, suiteId: id(),
    model: { type: 'object', properties: { modelId: id(), version: text(48) }, required: ['modelId', 'version'], additionalProperties: false },
    author: text(4000), review: text(4000), semantics: text(8000),
    derivedFrom: {
      anyOf: [{ type: 'null' }, {
        type: 'object', additionalProperties: false, required: ['path', 'digest', 'suiteId', 'conversion'],
        properties: { path: text(400), digest: { type: 'string', pattern: '^sha256:[0-9a-f]{64}$' }, suiteId: id(), conversion: text(4000) },
      }],
    },
    notCovered: { type: 'array', items: text(1000), maxItems: 32 },
    cases: { type: 'array', items: referenceCase, minItems: 1, maxItems: FIXTURE_LIMITS.cases },
  },
  required: ['contract', 'version', 'suiteId', 'model', 'author', 'review', 'semantics', 'derivedFrom', 'notCovered', 'cases'],
  additionalProperties: false,
};
const outcome: JsonSchema = { enum: ['valid', 'undefined', 'numerical-limit', 'out-of-domain', 'worker-error'] };
export const BOUNDARY_SET_SCHEMA: JsonSchema = {
  type: 'object',
  properties: {
    contract: { const: BOUNDARY_CONTRACT }, version: { const: FIXTURE_VERSION },
    cases: {
      type: 'array', minItems: 1, maxItems: FIXTURE_LIMITS.boundaryCases,
      items: {
        type: 'object', additionalProperties: false, required: ['id', 'label', 'rationale', 'params'],
        properties: {
          id: id(), label: text(400), rationale: text(2000), params, position,
          expect: { type: 'object', additionalProperties: false, properties: { outcome, statuses: { type: 'object', additionalProperties: { type: 'string', minLength: 1, maxLength: 80 }, maxProperties: 256 } } },
        },
      },
    },
  },
  required: ['contract', 'version', 'cases'],
  additionalProperties: false,
};

export interface FixtureDiagnostic { code: string; path: string; message: string; recovery?: string }
const FIXTURE_DATA_LIMITS = { maxBytes: 8 * 1024 * 1024, maxDepth: 16, maxNodes: 2_000_000 };
const diag = (code: string, path: string, message: string, recovery?: string): FixtureDiagnostic => ({ code, path, message, ...(recovery ? { recovery } : {}) });

/** Schema diagnostics, then the cross-references against the manifest (parameters, quantities, positions, shapes). */
export function validateReferenceSuite(input: unknown, manifest: ModelManifest | null): FixtureDiagnostic[] {
  const shape = validateJson(input, REFERENCE_SUITE_SCHEMA, FIXTURE_DATA_LIMITS);
  if (shape.length) return shape.map(item => diag(item.code === 'RESOURCE_LIMIT' ? 'RESOURCE_LIMIT' : 'SCHEMA', item.path, item.message));
  const suite = input as ReferenceSuite;
  const out: FixtureDiagnostic[] = [];
  const seen = new Set<string>();
  suite.cases.forEach((entry, c) => {
    const at = `$.cases[${c}]`;
    if (seen.has(entry.id)) out.push(diag('DUPLICATE_ID', `${at}.id`, `Duplicate case ID ${JSON.stringify(entry.id)}.`));
    seen.add(entry.id);
    if ((entry.points === undefined) === (entry.reject === undefined)) out.push(diag('SCHEMA', at, 'A case has exactly one of points and reject.'));
  });
  if (!manifest) return out;
  if (suite.model.modelId !== manifest.modelId || suite.model.version !== manifest.version)
    out.push(diag('INVALID_REFERENCE', '$.model', `The suite applies to ${suite.model.modelId}@${suite.model.version}, not ${manifest.modelId}@${manifest.version}.`, 'Point the suite at the package model, or use fixtures written for it.'));
  const parameters = Object.keys(manifest.parameters);
  suite.cases.forEach((entry, c) => {
    const at = `$.cases[${c}]`;
    const missing = parameters.filter(name => !Object.hasOwn(entry.params, name));
    const unknown = Object.keys(entry.params).filter(name => !Object.hasOwn(manifest.parameters, name));
    if (missing.length) out.push(diag('INVALID_INPUT', `${at}.params`, `Missing parameters: ${missing.join(', ')}. Reference cases state every parameter.`));
    if (unknown.length) out.push(diag('INVALID_REFERENCE', `${at}.params`, `Unknown parameters: ${unknown.join(', ')}.`));
    for (const name of Object.keys(entry.tolerances ?? {})) if (!Object.hasOwn(manifest.quantities, name)) out.push(diag('INVALID_REFERENCE', `${at}.tolerances.${name}`, 'Tolerance for an unknown quantity.'));
    entry.points?.forEach((item, p) => {
      const problem = positionProblem(manifest, item.position);
      if (problem) out.push(diag('INVALID_INPUT', `${at}.points[${p}].position`, problem));
      for (const [quantity, expected] of Object.entries(item.expect)) {
        const definition = Object.hasOwn(manifest.quantities, quantity) ? manifest.quantities[quantity] : undefined;
        if (!definition) { out.push(diag('INVALID_REFERENCE', `${at}.points[${p}].expect.${quantity}`, `Quantity ${JSON.stringify(quantity)} does not exist in the model.`)); continue; }
        const expectedValue = typeof expected === 'object' && !Array.isArray(expected) ? (expected.status === 'valid' ? expected.value : undefined) : expected;
        if (expectedValue === undefined) continue;
        const size = definition.shape.kind === 'vector' ? definition.shape.length : definition.shape.kind === 'matrix' ? definition.shape.rows * definition.shape.columns : 1;
        const fits = definition.shape.kind === 'category' ? typeof expectedValue === 'string' && definition.shape.values.includes(expectedValue)
          : size === 1 ? typeof expectedValue === 'number' : Array.isArray(expectedValue) && expectedValue.length === size;
        if (!fits) out.push(diag('KIND_MISMATCH', `${at}.points[${p}].expect.${quantity}`, `The expected value does not fit the ${definition.shape.kind} shape of ${quantity}.`));
      }
    });
  });
  return out.slice(0, 64);
}

export function validateBoundarySet(input: unknown, manifest: ModelManifest | null): FixtureDiagnostic[] {
  const shape = validateJson(input, BOUNDARY_SET_SCHEMA, FIXTURE_DATA_LIMITS);
  if (shape.length) return shape.map(item => diag(item.code === 'RESOURCE_LIMIT' ? 'RESOURCE_LIMIT' : 'SCHEMA', item.path, item.message));
  const set = input as BoundarySet;
  const out: FixtureDiagnostic[] = [];
  const seen = new Set<string>();
  set.cases.forEach((entry, c) => {
    if (seen.has(entry.id)) out.push(diag('DUPLICATE_ID', `$.cases[${c}].id`, `Duplicate boundary case ID ${JSON.stringify(entry.id)}.`));
    seen.add(entry.id);
    if (!manifest) return;
    for (const name of Object.keys(entry.params)) if (!Object.hasOwn(manifest.parameters, name)) out.push(diag('INVALID_REFERENCE', `$.cases[${c}].params.${name}`, 'Unknown parameter.'));
    for (const name of Object.keys(entry.expect?.statuses ?? {})) if (!Object.hasOwn(manifest.quantities, name)) out.push(diag('INVALID_REFERENCE', `$.cases[${c}].expect.statuses.${name}`, 'Unknown quantity.'));
  });
  return out.slice(0, 64);
}

function positionProblem(manifest: ModelManifest, position: PositionRequest | undefined): string | null {
  const execution = manifest.execution;
  const discrete = execution.kind === 'kernel' && execution.mode === 'discrete';
  const timed = execution.kind === 'document' && !!execution.document.time;
  if (!position) return discrete ? 'A discrete model needs an index position.' : timed ? 'A time-based model needs a time position.' : null;
  if (discrete) return position.kind === 'index' ? null : 'A discrete model takes { kind: "index", index }.';
  if (timed) return position.kind === 'time' ? null : 'A time-based model takes { kind: "time", time }.';
  return position.kind === 'static' ? null : 'A static model takes { kind: "static" } or no position.';
}

/** The position a point is evaluated at (the manifest's initial position when omitted). */
export function pointPosition(manifest: ModelManifest, position: PositionRequest | undefined): PositionRequest {
  if (position) return position;
  const execution = manifest.execution;
  if (execution.kind === 'kernel') return execution.mode === 'discrete' ? { kind: 'index', index: 0 } : { kind: 'static' };
  return execution.document.time ? { kind: 'time', time: 0 } : { kind: 'static' };
}

// ---------------------------------------------------------------------------------------------
// Comparison
// ---------------------------------------------------------------------------------------------
/** `valid`, `valid:<APPROXIMATION>`, `undefined:<CODE>` or `numerical-limit:<CODE>`; `missing` when absent. */
export function statusText(result: QuantityResult | undefined): string {
  if (!result) return 'missing';
  if (result.status === 'valid') return result.approximation ? `valid:${result.approximation.code}` : 'valid';
  return `${result.status}:${result.code}`;
}
const show = (value: unknown): string => typeof value === 'number' ? (Object.is(value, -0) ? '-0' : String(value)) : JSON.stringify(value);
const within = (observed: unknown, expected: number, tol: Tolerance): boolean =>
  typeof observed === 'number' && Number.isFinite(observed) && Math.abs(observed - expected) <= tol.absolute + tol.relative * Math.abs(expected);

function valueMatches(observed: unknown, expected: ValueExpectation, tol: Tolerance): boolean {
  if (typeof expected === 'string') return observed === expected;
  if (typeof expected === 'number') return within(observed, expected, tol);
  return Array.isArray(observed) && observed.length === expected.length && expected.every((item, i) => within(observed[i], item, tol));
}

/** Disagreement between one expectation and one quantity result, or null when they agree. */
export function expectationProblem(quantity: string, expected: Expectation, result: QuantityResult | undefined, tol: Tolerance): string | null {
  if (!result) return `${quantity} is missing from the frame`;
  const observed = statusText(result);
  if (typeof expected !== 'object' || Array.isArray(expected)) {
    if (result.status !== 'valid' || result.approximation) return `${quantity}: status ${observed}, expected valid`;
    return valueMatches(result.value, expected, tol) ? null : `${quantity}: ${show(result.value)}, expected ${show(expected)} (absolute ${tol.absolute}, relative ${tol.relative})`;
  }
  if (expected.status === 'valid') {
    if (result.status !== 'valid') return `${quantity}: status ${observed}, expected valid`;
    const approximation = expected.approximation ?? (expected.value === undefined ? 'any' : 'none');
    if (approximation === 'none' && result.approximation) return `${quantity}: status ${observed}, expected valid without an approximation`;
    if (approximation !== 'none' && approximation !== 'any' && result.approximation?.code !== approximation) return `${quantity}: status ${observed}, expected valid:${approximation}`;
    if (expected.value !== undefined && !valueMatches(result.value, expected.value, tol)) return `${quantity}: ${show(result.value)}, expected ${show(expected.value)} (absolute ${tol.absolute}, relative ${tol.relative})`;
    return null;
  }
  if (result.status !== expected.status) return `${quantity}: status ${observed}, expected ${expected.status}${expected.code ? `:${expected.code}` : ''}`;
  if (expected.code !== undefined && result.code !== expected.code) return `${quantity}: status ${observed}, expected ${expected.status}:${expected.code}`;
  if (expected.status === 'numerical-limit' && expected.lastFiniteIndex !== undefined && (result.status !== 'numerical-limit' || result.lastFiniteIndex !== expected.lastFiniteIndex))
    return `${quantity}: lastFiniteIndex ${show(result.status === 'numerical-limit' ? result.lastFiniteIndex : undefined)}, expected ${expected.lastFiniteIndex}`;
  return null;
}

export type PointOutcome = { ok: true; quantities: Record<string, QuantityResult> } | { ok: false; diagnostics: { code: string; path: string; message: string }[] };
const positionLabel = (position: PositionRequest | undefined): string =>
  !position || position.kind === 'static' ? '' : position.kind === 'index' ? `n=${position.index}: ` : `t=${position.time}: `;

/** Problems of one point (empty when every expectation holds). */
export function pointProblems(entry: ReferenceCase, point: ReferencePoint, outcome: PointOutcome): string[] {
  const prefix = positionLabel(point.position);
  if (!outcome.ok) return [`${prefix}evaluation failed (${outcome.diagnostics.map(item => item.code).join(', ') || 'no diagnostic'})`];
  const problems: string[] = [];
  for (const [quantity, expected] of Object.entries(point.expect)) {
    const tol = entry.tolerances?.[quantity] ?? entry.tolerance;
    const problem = expectationProblem(quantity, expected, outcome.quantities[quantity], tol);
    if (problem) problems.push(prefix + problem);
  }
  return problems;
}

/** Problems of a rejection case given the diagnostics of the attempted evaluation (or its success). */
export function rejectionProblems(entry: ReferenceCase, outcome: PointOutcome): string[] {
  const reject = entry.reject!;
  if (outcome.ok) return [`expected rejection ${reject.code}, but the parameters were evaluated`];
  const match = outcome.diagnostics.some(item => item.code === reject.code && (reject.path === undefined || item.path === reject.path));
  return match ? [] : [`expected rejection ${reject.code}${reject.path ? ` at ${reject.path}` : ''}, got ${outcome.diagnostics.map(item => `${item.code} at ${item.path}`).join(', ')}`];
}

// ---------------------------------------------------------------------------------------------
// Boundaries
// ---------------------------------------------------------------------------------------------
const REJECTIONS = new Set(['OUT_OF_DOMAIN', 'CONSTRAINT_VIOLATION', 'INVALID_INPUT']);
/** Outcome of one evaluation. Precedence: out-of-domain, worker-error, numerical-limit, undefined, valid. */
export function classifyOutcome(outcome: PointOutcome): BoundaryOutcome {
  if (!outcome.ok) return outcome.diagnostics.some(item => REJECTIONS.has(item.code)) ? 'out-of-domain' : 'worker-error';
  const statuses = Object.values(outcome.quantities).map(result => result.status);
  if (statuses.includes('numerical-limit')) return 'numerical-limit';
  if (statuses.includes('undefined')) return 'undefined';
  return 'valid';
}

const nudgeOutside = (value: number, direction: -1 | 1, span: number): number => value + direction * Math.max(Math.abs(value), span, 1) * 1e-6;
/**
 * Generated domain probes: every parameter at its minimum and maximum and just outside each (others at defaults), and
 * for discrete models the first and last index and one past the last. They complement declared boundary cases.
 */
export function domainProbes(manifest: ModelManifest): BoundaryCase[] {
  const probes: BoundaryCase[] = [];
  const execution = manifest.execution;
  const discrete = execution.kind === 'kernel' && execution.mode === 'discrete' ? execution.maxIndex : null;
  for (const [name, definition] of Object.entries(manifest.parameters)) {
    const span = definition.max - definition.min;
    probes.push(
      { id: `generated.${name}.min`, label: `${name} at its minimum ${definition.min}`, rationale: 'Generated probe: lower end of the declared domain (other parameters at defaults).', params: { [name]: definition.min } },
      { id: `generated.${name}.max`, label: `${name} at its maximum ${definition.max}`, rationale: 'Generated probe: upper end of the declared domain (other parameters at defaults).', params: { [name]: definition.max } },
      { id: `generated.${name}.below`, label: `${name} just below its minimum`, rationale: 'Generated probe: just outside the declared domain; must be rejected before evaluation.', params: { [name]: nudgeOutside(definition.min, -1, span) }, expect: { outcome: 'out-of-domain' } },
      { id: `generated.${name}.above`, label: `${name} just above its maximum`, rationale: 'Generated probe: just outside the declared domain; must be rejected before evaluation.', params: { [name]: nudgeOutside(definition.max, 1, span) }, expect: { outcome: 'out-of-domain' } },
    );
  }
  if (discrete !== null) {
    probes.push(
      { id: 'generated.index.first', label: 'Index 0 at the default parameters', rationale: 'Generated probe: first iteration.', params: {}, position: { kind: 'index', index: 0 } },
      { id: 'generated.index.last', label: `Index ${discrete} at the default parameters`, rationale: 'Generated probe: last admissible iteration.', params: {}, position: { kind: 'index', index: discrete } },
      { id: 'generated.index.beyond', label: `Index ${discrete + 1} at the default parameters`, rationale: 'Generated probe: one past the last iteration; must be rejected before evaluation.', params: {}, position: { kind: 'index', index: discrete + 1 }, expect: { outcome: 'out-of-domain' } },
    );
  }
  return probes;
}

/** Boundary cases drawn from a reference suite: rejections and points that expect a non-valid or approximate status. */
export function boundaryCasesFromSuite(suite: ReferenceSuite, limit = 64): BoundarySet | null {
  const cases: BoundaryCase[] = [];
  const seen = new Set<string>();
  for (const entry of suite.cases) {
    if (cases.length >= limit) break;
    if (entry.reject) {
      cases.push({ id: entry.id, label: entry.label, rationale: `From reference case ${entry.id}: ${entry.provenance}`.slice(0, 2000), params: entry.params, expect: { outcome: 'out-of-domain' } });
      continue;
    }
    for (const [p, point] of (entry.points ?? []).entries()) {
      const statuses: Record<string, string> = {};
      for (const [quantity, expected] of Object.entries(point.expect)) {
        if (typeof expected !== 'object' || Array.isArray(expected)) continue;
        if (expected.status === 'valid') { if (expected.approximation && expected.approximation !== 'none' && expected.approximation !== 'any') statuses[quantity] = `valid:${expected.approximation}`; }
        else statuses[quantity] = `${expected.status}${expected.code ? `:${expected.code}` : ''}`;
      }
      if (!Object.keys(statuses).length) continue;
      const kinds = Object.values(statuses);
      const outcomeOf: BoundaryOutcome = kinds.some(item => item.startsWith('numerical-limit')) ? 'numerical-limit' : kinds.some(item => item.startsWith('undefined')) ? 'undefined' : 'valid';
      const suffix = point.position?.kind === 'index' ? `@n=${point.position.index}` : (entry.points?.length ?? 0) > 1 ? `.${p}` : '';
      let caseId = `${entry.id}${suffix}`.slice(0, 150);
      if (seen.has(caseId)) caseId = `${caseId}.${p}`;
      seen.add(caseId);
      cases.push({
        id: caseId, label: `${entry.label}${point.position?.kind === 'index' ? ` (n = ${point.position.index})` : ''}`.slice(0, 400),
        rationale: `From reference case ${entry.id}: ${entry.provenance}`.slice(0, 2000), params: entry.params,
        ...(point.position ? { position: point.position } : {}), expect: { outcome: outcomeOf, statuses },
      });
      if (cases.length >= limit) break;
    }
  }
  return cases.length ? { contract: BOUNDARY_CONTRACT, version: FIXTURE_VERSION, cases } : null;
}

/** Statuses an observed frame disagrees with (`<quantity>: observed, expected`). */
export function statusMismatches(expected: Record<string, string>, outcome: PointOutcome): string[] {
  if (!outcome.ok) return Object.keys(expected).length ? ['the evaluation was rejected or failed'] : [];
  return Object.entries(expected).filter(([quantity, status]) => {
    const observed = statusText(outcome.quantities[quantity]);
    return status.includes(':') ? observed !== status : observed.split(':')[0] !== status;
  }).map(([quantity, status]) => `${quantity}: ${statusText(outcome.quantities[quantity])}, expected ${status}`);
}

// ---------------------------------------------------------------------------------------------
// Mutation operators (applied inside the worker; generic faults, not activity-specific mutants)
// ---------------------------------------------------------------------------------------------
export type MutationOperator = 'sign' | 'factor' | 'unit' | 'transpose' | 'swap-inputs' | 'undefined-as-zero' | 'limit-as-zero' | 'boundary-nudge';
export interface Mutation { id: string; operator: MutationOperator; target: string; description: string; factor?: number; other?: string; size?: number }

const UNIT_SLIPS: Partial<Record<UnitId, number>> = { rad: 180 / Math.PI, deg: Math.PI / 180, m: 100, cm: 0.01, mm: 0.001, s: 1000, ms: 0.001, kg: 1000, g: 0.001 };
const expectationKinds = (suite: ReferenceSuite) => {
  const numeric = new Set<string>(), undefinedQ = new Set<string>(), limitQ = new Set<string>();
  for (const entry of suite.cases) for (const point of entry.points ?? []) for (const [quantity, expected] of Object.entries(point.expect)) {
    if (typeof expected === 'number' || Array.isArray(expected)) numeric.add(quantity);
    else if (typeof expected === 'object') {
      if (expected.status === 'valid' && expected.value !== undefined && typeof expected.value !== 'string') numeric.add(quantity);
      if (expected.status === 'undefined') undefinedQ.add(quantity);
      if (expected.status === 'numerical-limit') limitQ.add(quantity);
    }
  }
  return { numeric, undefinedQ, limitQ };
};

/** Quantities a suite never states an expectation for (their faults cannot be detected by it). */
export function uncoveredQuantities(manifest: ModelManifest, suite: ReferenceSuite): string[] {
  const covered = new Set<string>();
  for (const entry of suite.cases) for (const point of entry.points ?? []) for (const quantity of Object.keys(point.expect)) covered.add(quantity);
  return Object.keys(manifest.quantities).filter(quantity => !covered.has(quantity));
}

/** Generic mutants for the quantities a suite covers and the model's inputs (bounded by FIXTURE_LIMITS.mutations). */
export function mutationsFor(manifest: ModelManifest, suite: ReferenceSuite): Mutation[] {
  const { numeric, undefinedQ, limitQ } = expectationKinds(suite);
  const out: Mutation[] = [];
  for (const quantity of Object.keys(manifest.quantities)) {
    const definition = manifest.quantities[quantity]!;
    if (definition.shape.kind === 'category' || !numeric.has(quantity)) continue;
    out.push({ id: `sign:${quantity}`, operator: 'sign', target: quantity, description: `${quantity} with the wrong sign` });
    out.push({ id: `factor:${quantity}`, operator: 'factor', target: quantity, factor: 2, description: `${quantity} off by a factor of 2` });
    const slip = UNIT_SLIPS[definition.unit];
    if (slip !== undefined) out.push({ id: `unit:${quantity}`, operator: 'unit', target: quantity, factor: slip, description: `${quantity} reported in the wrong unit (×${Number(slip.toPrecision(6))})` });
    if (definition.shape.kind === 'matrix' && definition.shape.rows === definition.shape.columns && definition.shape.rows > 1)
      out.push({ id: `transpose:${quantity}`, operator: 'transpose', target: quantity, size: definition.shape.rows, description: `${quantity} transposed` });
  }
  for (const quantity of undefinedQ) {
    const definition = manifest.quantities[quantity];
    if (definition && definition.shape.kind !== 'category') out.push({ id: `undefined-as-zero:${quantity}`, operator: 'undefined-as-zero', target: quantity, description: `undefined ${quantity} reported as a valid zero` });
  }
  for (const quantity of limitQ) {
    const definition = manifest.quantities[quantity];
    if (definition && definition.shape.kind !== 'category') out.push({ id: `limit-as-zero:${quantity}`, operator: 'limit-as-zero', target: quantity, description: `numerical limit of ${quantity} reported as a valid zero` });
  }
  const names = Object.keys(manifest.parameters);
  for (let i = 0; i < names.length; i++) for (let j = i + 1; j < names.length; j++) {
    const a = manifest.parameters[names[i]!]!, b = manifest.parameters[names[j]!]!;
    if (a.unit === b.unit && a.min === b.min && a.max === b.max) out.push({ id: `swap-inputs:${names[i]},${names[j]}`, operator: 'swap-inputs', target: names[i]!, other: names[j]!, description: `inputs ${names[i]} and ${names[j]} transposed` });
  }
  for (const name of names) out.push({ id: `boundary-nudge:${name}`, operator: 'boundary-nudge', target: name, factor: 1e-9, description: `${name} shifted by a relative 1e-9 (boundary off by a hair)` });
  return out.slice(0, FIXTURE_LIMITS.mutations);
}

/** Mutated inputs; null when the mutation does not apply to these inputs (they stay inadmissible otherwise). */
export function mutateParams(manifest: ModelManifest, mutation: Mutation, params: Record<string, number>): Record<string, number> {
  if (mutation.operator === 'swap-inputs') return { ...params, [mutation.target]: params[mutation.other!]!, [mutation.other!]: params[mutation.target]! };
  if (mutation.operator !== 'boundary-nudge') return params;
  const definition = manifest.parameters[mutation.target];
  const value = params[mutation.target];
  if (!definition || value === undefined) return params;
  const step = Math.max(Math.abs(value), 1) * (mutation.factor ?? 1e-9);
  const up = value + step, down = value - step;
  const next = { ...params, [mutation.target]: up <= definition.max ? up : down };
  // A nudge that leaves the admissible set would be caught by validation, not by the reference values; keep the input.
  return checkParameters(manifest, next).length ? params : next;
}

const zeroOf = (shape: ModelManifest['quantities'][string]['shape']): number | number[] =>
  shape.kind === 'vector' ? new Array<number>(shape.length).fill(0) : shape.kind === 'matrix' ? new Array<number>(shape.rows * shape.columns).fill(0) : 0;
function scaled(result: QuantityResult, factor: number): QuantityResult {
  if (result.status !== 'valid' || typeof result.value === 'string') return result;
  const value = Array.isArray(result.value) ? result.value.map(item => item * factor) : result.value * factor;
  return { ...result, value };
}

/** Mutated kernel output (a fresh object; the input is not modified). */
export function mutateOutput(mutation: Mutation, output: KernelOutput, manifest: ModelManifest): KernelOutput {
  const quantities: Record<string, QuantityResult> = { ...output.quantities };
  const target = quantities[mutation.target];
  const definition = manifest.quantities[mutation.target];
  if (target && definition) {
    switch (mutation.operator) {
      case 'sign': quantities[mutation.target] = scaled(target, -1); break;
      case 'factor': case 'unit': quantities[mutation.target] = scaled(target, mutation.factor ?? 2); break;
      case 'transpose':
        if (target.status === 'valid' && Array.isArray(target.value) && mutation.size) {
          const n = mutation.size, source = target.value;
          quantities[mutation.target] = { ...target, value: source.map((_, k) => source[(k % n) * n + Math.floor(k / n)]!) };
        }
        break;
      case 'undefined-as-zero':
        if (target.status === 'undefined') quantities[mutation.target] = { status: 'valid', value: zeroOf(definition.shape) };
        break;
      case 'limit-as-zero':
        if (target.status === 'numerical-limit') quantities[mutation.target] = { status: 'valid', value: zeroOf(definition.shape) };
        break;
      default: break;
    }
  }
  return { quantities, geometry: output.geometry as Record<string, GeometryResult>, ...(output.terminal ? { terminal: output.terminal } : {}) };
}

// ---------------------------------------------------------------------------------------------
// Conversion of the installed suites (tests/reference/fixtures/activities/*.json)
// ---------------------------------------------------------------------------------------------
type Raw = Record<string, unknown>;
const isRecord = (value: unknown): value is Raw => !!value && typeof value === 'object' && !Array.isArray(value);
const asTolerance = (value: unknown): Tolerance => isRecord(value) && typeof value.absolute === 'number' && typeof value.relative === 'number' ? { absolute: value.absolute, relative: value.relative } : { absolute: 0, relative: 0 };
const EXACT: Tolerance = Object.freeze({ absolute: 0, relative: 0 });

/** `valid`, `valid:UNDERFLOW`, `undefined:CODE`, `numerical-limit:CODE` (status strings of the installed suites) to an expectation. */
function fromStatus(status: unknown, value: unknown, lastFiniteIndex?: number): Expectation | null {
  if (typeof status !== 'string') {
    if (typeof value === 'number' || typeof value === 'string' || Array.isArray(value)) return value as ValueExpectation;
    return value === null ? { status: 'numerical-limit' } : null;
  }
  const [kind, code] = status.split(':') as [string, string | undefined];
  if (kind === 'valid') {
    if (value === null || value === undefined) return code ? { status: 'valid', approximation: code as 'UNDERFLOW' } : { status: 'valid' };
    return code ? { status: 'valid', value: value as ValueExpectation, approximation: code as 'UNDERFLOW' } : value as ValueExpectation;
  }
  if (kind === 'undefined') return code ? { status: 'undefined', code } : { status: 'undefined' };
  if (kind === 'numerical-limit') return { status: 'numerical-limit', ...(code ? { code: code as 'OVERFLOW' } : {}), ...(lastFiniteIndex !== undefined && code === 'OVERFLOW' ? { lastFiniteIndex } : {}) };
  return null;
}
/** `{undefined: CODE}`, `{limit: CODE}`, `{subnormal: v}`, `{value, approximation}` or a plain value (object-form suites). */
function fromObjectForm(value: unknown): Expectation | null {
  if (typeof value === 'number' || typeof value === 'string' || Array.isArray(value)) return value as ValueExpectation;
  if (!isRecord(value)) return null;
  if (typeof value.undefined === 'string') return { status: 'undefined', code: value.undefined };
  if (typeof value.limit === 'string') return { status: 'numerical-limit', code: value.limit as 'UNDERFLOW' };
  if (value.subnormal !== undefined) return { status: 'valid', value: value.subnormal as number, approximation: 'UNDERFLOW' };
  if (value.value !== undefined) return { status: 'valid', value: value.value as ValueExpectation, approximation: (value.approximation as 'UNDERFLOW' | undefined) ?? 'none' };
  return null;
}

const compact = (expect: Record<string, Expectation | null>): Record<string, Expectation> =>
  Object.fromEntries(Object.entries(expect).filter((entry): entry is [string, Expectation] => entry[1] !== null));

/** `derivation`: how expectations not stated literally in the source were restated (appended to `derivedFrom.conversion`). */
interface Converted { cases: ReferenceCase[]; notCovered: string[]; derivation?: string }
const CONVERTERS: Record<string, (raw: Raw) => Converted> = {
  'quadratic-gradient-descent': raw => {
    const maxIndex = typeof raw.maxIndex === 'number' ? raw.maxIndex : Infinity;
    const SEQUENCES = [['positions', 'position'], ['losses', 'loss'], ['gradients', 'gradient']] as const;
    const cases = (raw.cases as Raw[]).map(entry => {
      const expected = entry.expected as Raw;
      const statuses = (expected.statuses ?? {}) as Record<string, unknown[]>;
      const lfi = (expected.lastFiniteIndex ?? {}) as Record<string, number>;
      const params = entry.params as Record<string, number>;
      const start = (entry.indices as number[]).indexOf(0);
      // Parameter-only quantities (the same at every index), restated from the case itself: see `derivation` below.
      const parameterOnly = compact({
        'start.position': typeof params.x0 === 'number' ? params.x0 + 0 : null,
        'start.loss': start < 0 ? null : fromStatus(statuses.loss?.[start], (expected.losses as unknown[] | undefined)?.[start]),
        product: typeof params.eta === 'number' && typeof params.a === 'number' ? params.eta * params.a + 0 : null,
      });
      const points: ReferencePoint[] = (entry.indices as number[]).map((n, i) => ({
        position: { kind: 'index', index: n },
        expect: compact({
          regime: expected.regime === undefined ? null : expected.regime as string,
          multiplier: expected.multiplier === undefined ? null : expected.multiplier as number,
          threshold: expected.threshold === undefined ? null : expected.threshold as number,
          index: n,
          ...Object.fromEntries(SEQUENCES.map(([key, quantity]) => [quantity, fromStatus(statuses[quantity]?.[i], (expected[key] as unknown[] | undefined)?.[i], lfi[quantity])])),
          ...parameterOnly,
        }),
      }));
      for (const [quantity, k] of Object.entries(lfi)) {
        points.push({ position: { kind: 'index', index: k }, expect: { [quantity]: { status: 'valid' } }, note: `lastFiniteIndex ${k}: finite at this iteration` });
        if (k + 1 <= maxIndex) points.push({ position: { kind: 'index', index: k + 1 }, expect: { [quantity]: { status: 'numerical-limit', code: 'OVERFLOW', lastFiniteIndex: k } }, note: `lastFiniteIndex ${k}: overflows one iteration later` });
      }
      return { id: entry.id as string, label: entry.label as string, provenance: entry.provenance as string, params, tolerance: asTolerance(entry.tolerance), tolerances: { index: EXACT, 'start.position': EXACT, product: EXACT }, points };
    });
    return {
      cases,
      notCovered: ['Trace geometry (the trace ends at the current position or stops with a reason), the starting marker, the sampled objective curve and the current-iterate marker are checked by tests/reference/activities/quadratic.test.ts.'],
      derivation: 'Parameter-only quantities restated at every point of a case: start.position is the case\'s x0 (declared equal to it), start.loss is the case\'s own loss expectation at n = 0, and product is the IEEE-754 double product of the case\'s η and a, which the suite\'s declared semantics define as p (compared exactly).',
    };
  },
  'function-derivative': raw => ({
    cases: (raw.cases as Raw[]).map(entry => {
      const base = { id: entry.id as string, label: entry.label as string, provenance: entry.provenance as string, params: entry.params as Record<string, number>, tolerance: asTolerance(entry.tolerance), ...(Array.isArray(entry.families) ? { families: entry.families as string[] } : {}) };
      if (isRecord(entry.rejected)) return { ...base, reject: { code: entry.rejected.code as string, ...(typeof entry.rejected.path === 'string' ? { path: entry.rejected.path } : {}) } };
      return { ...base, points: [{ expect: compact(Object.fromEntries(Object.entries(entry.expected as Raw).map(([quantity, value]) => [quantity, fromObjectForm(value)]))) }] };
    }),
    notCovered: ['Tangent and secant endpoints and the sampled curves (lines, sampling tolerance) are checked by tests/reference/activities/function-derivative.test.ts.'],
  }),
  'linear-transformation': raw => ({
    cases: (raw.cases as Raw[]).map(entry => ({
      id: entry.id as string, label: entry.label as string, provenance: entry.provenance as string, params: entry.params as Record<string, number>, tolerance: asTolerance(entry.tolerance),
      points: [{ expect: compact(Object.fromEntries(Object.entries((entry.expected as Raw).quantities as Raw).map(([quantity, value]) => [quantity, fromObjectForm(value)]))) }],
    })),
    notCovered: ['The unit-square image polygon (vertices and degeneracy) is checked by tests/reference/activities/linear-transformation.test.ts.'],
  }),
  'vector-orientation-3d': raw => ({
    cases: (raw.cases as Raw[]).map(entry => {
      const expected = entry.expected as Raw, statuses = expected.statuses as Raw, values = expected.values as Raw;
      const tolerance = entry.tolerance as Raw;
      return {
        id: entry.id as string, label: entry.label as string, provenance: entry.provenance as string, params: entry.params as Record<string, number>,
        tolerance: asTolerance(tolerance.exact), tolerances: { angle: asTolerance(tolerance.angle), 'cross.direction': asTolerance(tolerance.direction) },
        points: [{ expect: compact(Object.fromEntries(Object.keys(statuses).map(quantity => [quantity, fromStatus(statuses[quantity], values[quantity])]))) }],
      };
    }),
    notCovered: ['The angle-arc flag and the exact geometry of u, v and their projections are checked by tests/reference/activities/vector-orientation-3d.test.ts.'],
  }),
  'quadratic-surface-gradient': raw => {
    const MAP = [['value', 'value', 'value'], ['gradient', 'gradient', 'gradient'], ['gradientNorm', 'gradient.norm', 'gradient.norm'], ['direction', 'gradient.direction', 'gradient.direction'], ['hessianDet', 'hessian.det', null], ['arrowScale', 'arrow.scale', null]] as const;
    const cases: ReferenceCase[] = (raw.cases as Raw[]).map(entry => {
      const expected = entry.expected as Raw, statuses = (expected.statuses ?? {}) as Raw, tolerance = entry.tolerance as Raw;
      return {
        id: entry.id as string, label: entry.label as string, provenance: entry.provenance as string, params: entry.params as Record<string, number>,
        tolerance: asTolerance(tolerance.rational), tolerances: { 'gradient.norm': asTolerance(tolerance.irrational), 'gradient.direction': asTolerance(tolerance.irrational), 'arrow.scale': EXACT },
        points: [{ expect: compact(Object.fromEntries(MAP.map(([key, quantity, statusKey]) => {
          const status = statusKey ? statuses[statusKey] : undefined;
          return [quantity, status === undefined && expected[key] === undefined ? null : fromStatus(status, expected[key])];
        }))) }],
      };
    });
    for (const entry of (raw.rejected ?? []) as Raw[]) cases.push({ id: entry.id as string, label: entry.label as string, provenance: entry.provenance as string, params: entry.params as Record<string, number>, tolerance: EXACT, reject: { code: entry.code as string, ...(typeof entry.path === 'string' ? { path: entry.path } : {}) } });
    return { cases, notCovered: ['Surface, section and field grids, contour levels and the perpendicularity of contours to the gradient direction are checked by tests/reference/activities/quadratic-surface-gradient.test.ts.'] };
  },
};

/** Installed suite IDs this module can convert. */
export const CONVERTIBLE_SUITES: readonly string[] = Object.freeze(Object.keys(CONVERTERS));

/**
 * Converts an installed activity suite to `explorable-models.reference-fixtures` 1.0. Case IDs, labels, provenance,
 * parameters and tolerances are copied unchanged; quantity expectations are restated in the generic vocabulary.
 */
export function convertInstalledSuite(templateId: string, raw: unknown, source: { path: string; digest: string }, target?: { modelId: string; version: string; suiteId: string }): ReferenceSuite {
  const convert = Object.hasOwn(CONVERTERS, templateId) ? CONVERTERS[templateId] : undefined;
  if (!convert || !isRecord(raw) || !Array.isArray(raw.cases)) throw new RangeError(`No reference-suite conversion is available for ${templateId}.`);
  const model = raw.model as Raw;
  const converted = convert(raw);
  return {
    contract: FIXTURE_CONTRACT, version: FIXTURE_VERSION,
    suiteId: target?.suiteId ?? String(raw.suiteId),
    model: target ? { modelId: target.modelId, version: target.version } : { modelId: String(model.modelId), version: String(model.version) },
    author: String(raw.author), review: String(raw.review), semantics: String(raw.semantics),
    derivedFrom: { path: source.path, digest: source.digest, suiteId: String(raw.suiteId), conversion: `Converted by explorable-models activity tooling: case IDs, labels, provenance, parameters and tolerances copied unchanged; quantity expectations restated as explorable-models.reference-fixtures 1.0 expectations.${converted.derivation ? ` ${converted.derivation}` : ''}` },
    notCovered: converted.notCovered,
    cases: converted.cases,
  };
}
