/**
 * Bounded JSON Schema (2020-12 subset) builders and validator shared by model and activity contracts.
 * The same emitted schema files are validated in Rust with the `jsonschema` crate, so only this subset is used:
 * type, properties, required, additionalProperties (false or schema), enum, const, minLength/maxLength (Unicode
 * code points), pattern (ASCII-only), minimum/maximum, exclusiveMinimum, minItems/maxItems, items, maxProperties,
 * propertyNames, anyOf, oneOf, $ref to #/$defs.
 */
import type { Diagnostic } from '../declarative/types.js';

export interface JsonSchema {
  $schema?: string;
  $id?: string;
  $ref?: string;
  $defs?: Record<string, JsonSchema>;
  title?: string;
  description?: string;
  type?: 'object' | 'array' | 'string' | 'number' | 'integer' | 'boolean' | 'null' | ('object' | 'array' | 'string' | 'number' | 'integer' | 'boolean' | 'null')[];
  properties?: Record<string, JsonSchema>;
  required?: string[];
  additionalProperties?: boolean | JsonSchema;
  enum?: (string | number | boolean | null)[];
  const?: string | number | boolean | null;
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  minimum?: number;
  maximum?: number;
  exclusiveMinimum?: number;
  minItems?: number;
  maxItems?: number;
  items?: JsonSchema;
  maxProperties?: number;
  propertyNames?: JsonSchema;
  anyOf?: JsonSchema[];
  oneOf?: JsonSchema[];
}

export const ID_PATTERN = '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$';
export const DIGEST_PATTERN = '^sha256:[0-9a-f]{64}$';
export const VERSION_PATTERN = '^[0-9]{1,4}[.][0-9]{1,4}[.][0-9]{1,6}(-[0-9A-Za-z.-]{1,32})?$';
export const TIMESTAMP_PATTERN = '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}([.][0-9]{1,9})?(Z|[+-][0-9]{2}:[0-9]{2})$';
/** Safe numeric range for contract numbers; scientific values are additionally bounded by manifests. */
export const SAFE_NUMBER = 1e15;

export const S = Object.freeze({
  string: (maxLength = 2000, minLength = 0): JsonSchema => ({ type: 'string', maxLength, ...(minLength ? { minLength } : {}) }),
  text: (maxLength = 2000): JsonSchema => ({ type: 'string', minLength: 1, maxLength }),
  pattern: (pattern: string, maxLength = 128): JsonSchema => ({ type: 'string', minLength: 1, maxLength, pattern }),
  id: (): JsonSchema => ({ type: 'string', minLength: 1, maxLength: 128, pattern: ID_PATTERN }),
  digest: (): JsonSchema => ({ type: 'string', minLength: 71, maxLength: 71, pattern: DIGEST_PATTERN }),
  version: (): JsonSchema => ({ type: 'string', minLength: 5, maxLength: 48, pattern: VERSION_PATTERN }),
  timestamp: (): JsonSchema => ({ type: 'string', minLength: 20, maxLength: 40, pattern: TIMESTAMP_PATTERN }),
  number: (minimum = -SAFE_NUMBER, maximum = SAFE_NUMBER): JsonSchema => ({ type: 'number', minimum, maximum }),
  positive: (maximum = SAFE_NUMBER): JsonSchema => ({ type: 'number', exclusiveMinimum: 0, maximum }),
  integer: (minimum = 0, maximum = 2 ** 53 - 1): JsonSchema => ({ type: 'integer', minimum, maximum }),
  boolean: (): JsonSchema => ({ type: 'boolean' }),
  null: (): JsonSchema => ({ type: 'null' }),
  constant: (value: string | number | boolean | null): JsonSchema => ({ const: value }),
  oneOfValues: (values: (string | number | boolean | null)[]): JsonSchema => ({ enum: values }),
  array: (items: JsonSchema, maxItems: number, minItems = 0): JsonSchema => ({ type: 'array', items, maxItems, ...(minItems ? { minItems } : {}) }),
  object: (properties: Record<string, JsonSchema>, required: string[] = Object.keys(properties)): JsonSchema => ({ type: 'object', properties, required, additionalProperties: false }),
  map: (value: JsonSchema, maxProperties: number, key: JsonSchema = { type: 'string', minLength: 1, maxLength: 128, pattern: ID_PATTERN }): JsonSchema => ({ type: 'object', additionalProperties: value, maxProperties, propertyNames: key }),
  anyOf: (...schemas: JsonSchema[]): JsonSchema => ({ anyOf: schemas }),
  oneOf: (...schemas: JsonSchema[]): JsonSchema => ({ oneOf: schemas }),
  ref: (name: string): JsonSchema => ({ $ref: `#/$defs/${name}` }),
  nullable: (schema: JsonSchema): JsonSchema => ({ anyOf: [schema, { type: 'null' }] }),
});

export interface DataLimits { maxBytes: number; maxDepth: number; maxNodes: number }
export const DEFAULT_DATA_LIMITS: DataLimits = Object.freeze({ maxBytes: 4_000_000, maxDepth: 32, maxNodes: 200_000 });

const RESERVED = new Set(['__proto__', 'prototype', 'constructor']);
const diagnostic = (path: string, message: string, code = 'SCHEMA'): Diagnostic => ({ code, path, message });

/**
 * Rejects non-JSON data without invoking getters: accessors, symbols, cycles, class instances, sparse arrays,
 * reserved prototype keys and nonfinite numbers. Bounded before deep traversal.
 */
export function jsonDataErrors(input: unknown, limits: DataLimits = DEFAULT_DATA_LIMITS): Diagnostic[] {
  const seen = new Set<object>();
  const encoder = new TextEncoder();
  let bytes = 0, nodes = 0;
  const errors: Diagnostic[] = [];
  const visit = (value: unknown, path: string, depth: number): boolean => {
    if (depth > limits.maxDepth || ++nodes > limits.maxNodes) { errors.push(diagnostic(path, 'Nesting or node limit exceeded.', 'RESOURCE_LIMIT')); return false; }
    if (value === null || typeof value === 'boolean') { bytes += 5; return true; }
    if (typeof value === 'string') { bytes += encoder.encode(value).length + 2; return bytes <= limits.maxBytes || (errors.push(diagnostic(path, `Payload exceeds ${limits.maxBytes} bytes.`, 'RESOURCE_LIMIT')), false); }
    if (typeof value === 'number') { if (!Number.isFinite(value)) { errors.push(diagnostic(path, 'Numbers must be finite.')); return false; } bytes += 24; return true; }
    if (typeof value !== 'object') { errors.push(diagnostic(path, 'Only JSON-compatible data is accepted.')); return false; }
    const object = value as object;
    if (seen.has(object)) { errors.push(diagnostic(path, 'Cyclic references are not accepted.')); return false; }
    const prototype = Object.getPrototypeOf(object);
    if (!Array.isArray(object) && prototype !== Object.prototype && prototype !== null) { errors.push(diagnostic(path, 'Expected a plain JSON object.')); return false; }
    if (Reflect.ownKeys(object).some(key => typeof key === 'symbol')) { errors.push(diagnostic(path, 'Symbol properties are not accepted.')); return false; }
    seen.add(object);
    const descriptors = Object.getOwnPropertyDescriptors(object);
    for (const [key, descriptor] of Object.entries(descriptors)) {
      if (Array.isArray(object) && key === 'length') continue;
      if (RESERVED.has(key)) { errors.push(diagnostic(`${path}.${key}`, 'Reserved object key.')); return false; }
      if (!('value' in descriptor) || !descriptor.enumerable) { errors.push(diagnostic(`${path}.${key}`, 'Accessors and hidden properties are not accepted.')); return false; }
      bytes += Array.isArray(object) ? 1 : encoder.encode(key).length + 3;
      if (!visit(descriptor.value, Array.isArray(object) ? `${path}[${key}]` : `${path}.${key}`, depth + 1)) return false;
    }
    if (Array.isArray(object) && Object.keys(object).length !== object.length) { errors.push(diagnostic(path, 'Sparse or decorated arrays are not accepted.')); return false; }
    seen.delete(object);
    if (bytes > limits.maxBytes) { errors.push(diagnostic(path, `Payload exceeds ${limits.maxBytes} bytes.`, 'RESOURCE_LIMIT')); return false; }
    return true;
  };
  visit(input, '$', 0);
  return errors;
}

const codePoints = (value: string): number => { let count = 0; for (const _ of value) count++; return count; };
const patternCache = new Map<string, RegExp>();
const regex = (pattern: string): RegExp => { let compiled = patternCache.get(pattern); if (!compiled) { compiled = new RegExp(pattern, 'u'); patternCache.set(pattern, compiled); } return compiled; };
const typeMatches = (value: unknown, type: string): boolean =>
  type === 'null' ? value === null : type === 'array' ? Array.isArray(value) : type === 'object' ? !!value && typeof value === 'object' && !Array.isArray(value)
    : type === 'integer' ? typeof value === 'number' && Number.isInteger(value) : type === 'number' ? typeof value === 'number' : typeof value === type;

/** Validates JSON data (already checked by jsonDataErrors) against a schema subset. At most `maxErrors` reported. */
export function schemaErrors(value: unknown, schema: JsonSchema, root: JsonSchema = schema, path = '$', maxErrors = 32): Diagnostic[] {
  const errors: Diagnostic[] = [];
  const check = (current: unknown, rule: JsonSchema, at: string, depth: number): void => {
    if (errors.length >= maxErrors) return;
    if (depth > 64) { errors.push(diagnostic(at, 'Schema nesting exceeded.')); return; }
    if (rule.$ref) {
      const name = rule.$ref.startsWith('#/$defs/') ? rule.$ref.slice(8) : '';
      const target = root.$defs?.[name];
      if (!target) { errors.push(diagnostic(at, `Unresolved schema reference ${rule.$ref}.`)); return; }
      check(current, target, at, depth + 1); return;
    }
    if (rule.anyOf) { if (!rule.anyOf.some(option => !schemaErrors(current, option, root, at, 1).length)) errors.push(diagnostic(at, 'Value does not match any supported shape.')); return; }
    if (rule.oneOf) {
      const matching = rule.oneOf.filter(option => !schemaErrors(current, option, root, at, 1).length).length;
      if (matching !== 1) errors.push(diagnostic(at, matching ? 'Value matches more than one exclusive shape.' : 'Value does not match any supported shape.'));
      return;
    }
    if (Object.hasOwn(rule, 'const') && current !== rule.const) { errors.push(diagnostic(at, `Expected ${JSON.stringify(rule.const)}.`)); return; }
    if (rule.enum && !rule.enum.includes(current as never)) { errors.push(diagnostic(at, `Expected one of ${rule.enum.map(item => JSON.stringify(item)).join(', ')}.`)); return; }
    if (rule.type) {
      const types = Array.isArray(rule.type) ? rule.type : [rule.type];
      if (!types.some(type => typeMatches(current, type))) { errors.push(diagnostic(at, `Expected ${types.join(' or ')}.`)); return; }
    }
    if (typeof current === 'number') {
      if ((rule.minimum !== undefined && current < rule.minimum) || (rule.maximum !== undefined && current > rule.maximum) || (rule.exclusiveMinimum !== undefined && current <= rule.exclusiveMinimum))
        errors.push(diagnostic(at, `Value is outside the supported range.`));
      return;
    }
    if (typeof current === 'string') {
      const length = codePoints(current);
      if ((rule.minLength !== undefined && length < rule.minLength) || (rule.maxLength !== undefined && length > rule.maxLength)) errors.push(diagnostic(at, 'String length is outside the supported limit.'));
      else if (rule.pattern && !regex(rule.pattern).test(current)) errors.push(diagnostic(at, 'String format is invalid.'));
      return;
    }
    if (Array.isArray(current)) {
      if ((rule.minItems !== undefined && current.length < rule.minItems) || (rule.maxItems !== undefined && current.length > rule.maxItems)) { errors.push(diagnostic(at, 'Array length is outside the supported limit.')); return; }
      if (rule.items) current.forEach((item, index) => check(item, rule.items!, `${at}[${index}]`, depth + 1));
      return;
    }
    if (current && typeof current === 'object') {
      const entries = Object.entries(current);
      if (rule.maxProperties !== undefined && entries.length > rule.maxProperties) { errors.push(diagnostic(at, 'Object entry limit exceeded.')); return; }
      for (const key of rule.required ?? []) if (!Object.hasOwn(current, key)) errors.push(diagnostic(`${at}.${key}`, 'Required field is missing.'));
      for (const [key, item] of entries) {
        if (errors.length >= maxErrors) return;
        if (rule.propertyNames) check(key, rule.propertyNames, `${at}.${key}`, depth + 1);
        const child = rule.properties && Object.hasOwn(rule.properties, key) ? rule.properties[key] : undefined;
        if (child) check(item, child, `${at}.${key}`, depth + 1);
        else if (rule.additionalProperties === false) errors.push(diagnostic(`${at}.${key}`, 'Unknown field.'));
        else if (rule.additionalProperties && typeof rule.additionalProperties === 'object') check(item, rule.additionalProperties, `${at}.${key}`, depth + 1);
      }
    }
  };
  check(value, schema, path, 0);
  return errors.slice(0, maxErrors);
}

/** Full check: JSON data safety, then schema. */
export function validateJson(value: unknown, schema: JsonSchema, limits: DataLimits = DEFAULT_DATA_LIMITS): Diagnostic[] {
  const data = jsonDataErrors(value, limits);
  return data.length ? data : schemaErrors(value, schema);
}
