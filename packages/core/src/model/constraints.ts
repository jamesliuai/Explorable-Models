/**
 * Parameter admissibility (report §8.2, A06). The same function serves exact entry, previews, commits, restore,
 * sampling, tools and worker requests, so every entry point enforces identical rules.
 */
import { evaluateExpression, expressionReferences, parseExpression, type ExpressionNode } from '../declarative/expressions.js';
import type { Diagnostic } from '../declarative/types.js';
import { diagnostic } from './errors.js';
import type { ModelConstraint, ModelManifest, ModelParameterDefinition } from './types.js';
import { UNITS } from './units.js';

/**
 * Relative tolerance for `{ multipleOf: m }` admissibility: v is admissible when
 * |v − m·round(v/m)| ≤ 1e-9 · max(|v|, m). It absorbs binary rounding of decimal steps (0.1 + 0.2) without
 * admitting values a visible step away.
 */
export const MULTIPLE_OF_RELATIVE_TOLERANCE = 1e-9;
const RESERVED_SYMBOLS = new Set(['pi', 'e']);

// Constraint ASTs are cached by exact expression text: equivalent to caching per manifest digest for the constraint
// part, and a caller that mutates an unfrozen manifest can never reuse a stale AST.
const AST_CACHE_LIMIT = 256;
const astCache = new Map<string, ExpressionNode>();
/** Parses (and caches) a constraint expression; throws DocumentError for an invalid expression. */
export function constraintAst(expression: string): ExpressionNode {
  let node = astCache.get(expression);
  if (node) { astCache.delete(expression); astCache.set(expression, node); return node; }
  node = parseExpression(expression, '$.constraints.expression');
  astCache.set(expression, node);
  if (astCache.size > AST_CACHE_LIMIT) astCache.delete(astCache.keys().next().value!);
  return node;
}

const isRecord = (value: unknown): value is Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return (prototype === Object.prototype || prototype === null) && !Reflect.ownKeys(value).some(key => typeof key === 'symbol');
};
/** Reads an own data property without invoking accessors. */
const ownValue = (record: object, key: string): unknown => { const descriptor = Object.getOwnPropertyDescriptor(record, key); return descriptor && 'value' in descriptor ? descriptor.value : undefined; };

export function isAdmissible(definition: ModelParameterDefinition, value: number): boolean {
  const rule = definition.step.admissible;
  if (rule === 'continuous') return true;
  if (rule === 'integer') return Number.isSafeInteger(value);
  const m = rule.multipleOf, nearest = m * Math.round(value / m);
  return Math.abs(value - nearest) <= MULTIPLE_OF_RELATIVE_TOLERANCE * Math.max(Math.abs(value), m);
}
const unitText = (definition: ModelParameterDefinition) => UNITS[definition.unit]?.label ? ` ${UNITS[definition.unit].label}` : '';

/** True when the value lies inside the constraint interval with the declared inclusivity (inclusive by default). */
export function withinConstraint(constraint: ModelConstraint, value: number): boolean {
  if (constraint.min !== undefined && (constraint.minInclusive ?? true ? value < constraint.min : value <= constraint.min)) return false;
  if (constraint.max !== undefined && (constraint.maxInclusive ?? true ? value > constraint.max : value >= constraint.max)) return false;
  return true;
}

/**
 * Evaluates one coupled constraint over parameter values. An undefined, nonscalar or unparsable expression is a
 * violation: a constraint never passes silently.
 */
export function constraintHolds(constraint: ModelConstraint, params: Readonly<Record<string, number>>): boolean {
  let node: ExpressionNode;
  try { node = constraintAst(constraint.expression); } catch { return false; }
  const result = evaluateExpression(node, name => Object.hasOwn(params, name) && !RESERVED_SYMBOLS.has(name)
    ? { status: 'valid', value: params[name] } : { status: 'undefined', value: null, reason: 'Unknown reference.' });
  return result.status === 'valid' && typeof result.value === 'number' && Number.isFinite(result.value) && withinConstraint(constraint, result.value);
}

/**
 * Parameter IDs a coupled constraint references (reserved symbols excluded), or null when its expression does not
 * parse. Callers use it to decide where a constraint's own message may be shown (for example only when every referenced
 * parameter is a visible control).
 */
export function constraintReferences(constraint: Pick<ModelConstraint, 'expression'>): string[] | null {
  try { return [...new Set(expressionReferences(constraintAst(constraint.expression)).filter(ref => !RESERVED_SYMBOLS.has(ref)))]; } catch { return null; }
}

export interface CheckOptions {
  /** Accept a subset of parameters (for example a single control update). Coupled constraints are then evaluated only
   * when every parameter they reference is present. */
  partial?: boolean;
}

/**
 * Checks parameter values in canonical units. Diagnostics: unknown/missing/nonnumeric/inadmissible →
 * `INVALID_INPUT`; outside [min, max] → `OUT_OF_DOMAIN` at `$.parameters.<id>`; coupled violations →
 * `CONSTRAINT_VIOLATION` at `$.constraints.<id>` with the manifest's learner-safe message and recovery.
 */
export function checkParameters(manifest: ModelManifest, params: unknown, options: CheckOptions = {}): Diagnostic[] {
  if (!isRecord(params)) return [diagnostic('INVALID_INPUT', '$.parameters', 'Expected an object of parameter values.')];
  const errors: Diagnostic[] = [];
  const keys = Object.keys(params);
  if (keys.length > 256) return [diagnostic('RESOURCE_LIMIT', '$.parameters', 'Too many parameter entries.')];
  for (const key of keys) if (!Object.hasOwn(manifest.parameters, key)) errors.push(diagnostic('INVALID_INPUT', `$.parameters.${key.slice(0, 128)}`, 'Unknown parameter.', 'Use only parameters declared by the model.'));
  const values: Record<string, number> = Object.create(null);
  for (const [id, definition] of Object.entries(manifest.parameters)) {
    const path = `$.parameters.${id}`;
    if (!Object.hasOwn(params, id)) { if (!options.partial) errors.push(diagnostic('INVALID_INPUT', path, 'Missing parameter.', 'Provide every model parameter.')); continue; }
    const value = ownValue(params, id);
    if (typeof value !== 'number' || !Number.isFinite(value)) { errors.push(diagnostic('INVALID_INPUT', path, 'Expected a finite number.')); continue; }
    if (value < definition.min || value > definition.max) { errors.push(diagnostic('OUT_OF_DOMAIN', path, `Expected a value from ${definition.min} to ${definition.max}${unitText(definition)}.`, `Choose a value from ${definition.min} to ${definition.max}${unitText(definition)}.`)); continue; }
    if (!isAdmissible(definition, value)) {
      const rule = definition.step.admissible;
      errors.push(diagnostic('INVALID_INPUT', path, rule === 'integer' ? 'Expected a whole number.' : `Expected a multiple of ${(rule as { multipleOf: number }).multipleOf}${unitText(definition)}.`, 'Enter an admissible value; it is not rounded for you.'));
      continue;
    }
    values[id] = value;
  }
  // Coupled constraints only run over individually valid values, so their messages never mask a simpler error.
  for (const constraint of manifest.constraints) {
    let node: ExpressionNode | null = null;
    try { node = constraintAst(constraint.expression); } catch { /* An unparsable expression is a violation below. */ }
    const refs = node ? expressionReferences(node).filter(ref => !RESERVED_SYMBOLS.has(ref)) : [];
    const declared = refs.every(ref => Object.hasOwn(manifest.parameters, ref));
    // A declared input that is absent (partial check) or individually invalid (already reported) defers the constraint;
    // an unparsable expression or an undeclared reference is always a violation.
    if (node && declared && refs.some(ref => !Object.hasOwn(values, ref))) continue;
    if (!node || !declared || !constraintHolds(constraint, values)) errors.push(diagnostic('CONSTRAINT_VIOLATION', `$.constraints.${constraint.id}`, constraint.message, constraint.recovery));
  }
  return errors.slice(0, 64);
}

const roundTo = (value: number): number => Number(value.toPrecision(15));
/** Nearest admissible value inside [min, max] for one parameter (deterministic; ties round half away from zero). */
export function clampParameter(definition: ModelParameterDefinition, value: number): number {
  let next = Math.min(definition.max, Math.max(definition.min, value));
  const rule = definition.step.admissible;
  if (rule === 'integer') {
    next = Math.sign(next) * Math.round(Math.abs(next));
    if (next < definition.min) next = Math.ceil(definition.min);
    if (next > definition.max) next = Math.floor(definition.max);
  } else if (rule !== 'continuous') {
    const m = rule.multipleOf;
    next = roundTo(m * Math.sign(next) * Math.round(Math.abs(next) / m));
    if (next < definition.min) next = roundTo(m * Math.ceil(definition.min / m));
    if (next > definition.max) next = roundTo(m * Math.floor(definition.max / m));
  }
  return Object.is(next, -0) ? 0 : next;
}

/**
 * Per-parameter clamping for pointer gestures only. Each finite declared value moves to the nearest admissible value
 * in its bounds; the moved IDs are returned so the clamp is visible. Unknown keys and nonfinite values pass through
 * unchanged for `checkParameters` to reject, and coupled-constraint violations are never clamped (they are reported).
 */
export function clampForPreview(manifest: ModelManifest, params: Record<string, number>): { params: Record<string, number>; clamped: string[] } {
  const next: Record<string, number> = {};
  const clamped: string[] = [];
  if (!isRecord(params)) return { params: next, clamped };
  for (const key of Object.keys(params)) {
    const value = ownValue(params, key) as number;
    const definition = Object.hasOwn(manifest.parameters, key) ? manifest.parameters[key] : undefined;
    if (!definition || typeof value !== 'number' || !Number.isFinite(value)) { next[key] = value; continue; }
    const adjusted = clampParameter(definition, value);
    if (adjusted !== value) clamped.push(key);
    next[key] = adjusted;
  }
  return { params: next, clamped };
}
