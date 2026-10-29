import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { jsonDataErrors, schemaErrors, type JsonSchema, type ModelManifest } from '../../packages/core/src/model/index.js';
import {
  CONTRACTS, type ActivityArtifact, type ActivityInstance, type ActivityRecords, type ActivityRequest, type ActivityTemplate, type AppendResult, type AssistanceReceipt,
  type AssistanceRequest, type DisplayAckRequest, type ExposureIntentRequest, type ExposureReceipt, type ExposureRecord, type HostAck, type HostPolicy,
  type InteractionEvent, type InteractionSummary, type JournalCursor, type PresentationSnapshot, type ReviewRecord, type ScientificSnapshot,
  type StageReceipt, type StageTransitionRequest,
} from '../../packages/activity/src/contracts.js';
import {
  LIMITS, MESSAGES, MODEL_MANIFEST_CONTRACT, SCHEMAS, SCHEMA_NAMES, SHORT_NAMES, dataLimitsFor, schemaFileName, type SchemaName,
} from '../../packages/activity/src/schemas.js';
import { isValidRecord, parseRecord, safePath, validateRecord, type SchemaTypes } from '../../packages/activity/src/validator.js';
import { SPATIAL_3D_CAPABILITY, type CapabilityRecord } from '../../packages/activity/src/capabilities.js';
import { buildFixtures, fixtureText, type ContractFixture } from '../../packages/activity/fixtures-src/cases.js';
import {
  EVENTS, EXEMPLARS, MESSAGE_EXEMPLARS, approvedPolicy, backupArtifact, cursor, displayedExposure, helpReceipt, modelReview, orientationPresentation,
  predictInstance, quadraticManifest, quadraticScientific, quadraticTemplate, revealReceipt, stageReceipt, tutorSummary,
} from '../../packages/activity/fixtures-src/exemplars.js';

const packageRoot = fileURLToPath(new URL('../../packages/activity/', import.meta.url));
const fixtureRoot = join(packageRoot, 'fixtures/contracts');
const walk = (directory: string): string[] => readdirSync(directory).flatMap(name => {
  const path = join(directory, name);
  return statSync(path).isDirectory() ? walk(path) : [path];
});
const fixtureFiles = walk(fixtureRoot).filter(path => path.endsWith('.json')).sort();
const fixtures = fixtureFiles.map(path => ({ file: relative(fixtureRoot, path).split('\\').join('/'), fixture: JSON.parse(readFileSync(path, 'utf8')) as ContractFixture }));

// Typed exemplars: each declared against its contract interface with `satisfies`, so a type change that the schema does
// not mirror (or the reverse) fails compilation here or validation below.
const TYPED = {
  [CONTRACTS.template]: quadraticTemplate satisfies ActivityTemplate,
  [CONTRACTS.instance]: predictInstance satisfies ActivityInstance,
  [CONTRACTS.policy]: approvedPolicy satisfies HostPolicy,
  [CONTRACTS.scientific]: quadraticScientific satisfies ScientificSnapshot,
  [CONTRACTS.presentation]: orientationPresentation satisfies PresentationSnapshot,
  [CONTRACTS.event]: EVENTS['parameters-committed']! satisfies InteractionEvent,
  [CONTRACTS.exposure]: displayedExposure satisfies ExposureRecord,
  [CONTRACTS.summary]: tutorSummary satisfies InteractionSummary,
  [CONTRACTS.artifact]: backupArtifact satisfies ActivityArtifact,
  [CONTRACTS.review]: modelReview satisfies ReviewRecord,
  [CONTRACTS.exposureReceipt]: revealReceipt satisfies ExposureReceipt,
  [CONTRACTS.stageReceipt]: stageReceipt satisfies StageReceipt,
  [CONTRACTS.assistanceReceipt]: helpReceipt satisfies AssistanceReceipt,
  [CONTRACTS.capability]: SPATIAL_3D_CAPABILITY satisfies CapabilityRecord,
  [MESSAGES.activityRequest]: MESSAGE_EXEMPLARS.activityRequest[0]! satisfies ActivityRequest,
  [MESSAGES.stageTransitionRequest]: MESSAGE_EXEMPLARS.stageTransitionRequest[1]! satisfies StageTransitionRequest,
  [MESSAGES.exposureIntentRequest]: MESSAGE_EXEMPLARS.exposureIntentRequest[1]! satisfies ExposureIntentRequest,
  [MESSAGES.displayAckRequest]: MESSAGE_EXEMPLARS.displayAckRequest[0]! satisfies DisplayAckRequest,
  [MESSAGES.assistanceRequest]: MESSAGE_EXEMPLARS.assistanceRequest[1]! satisfies AssistanceRequest,
  [MESSAGES.appendEventsRequest]: MESSAGE_EXEMPLARS.appendEventsRequest[1]! satisfies { activityId: string; events: InteractionEvent[] },
  [MESSAGES.appendResult]: MESSAGE_EXEMPLARS.appendResult[1]! satisfies AppendResult,
  [MESSAGES.journalCursor]: cursor satisfies JournalCursor,
  [MESSAGES.registerActivityRequest]: MESSAGE_EXEMPLARS.registerActivityRequest[0]! satisfies { instance: ActivityInstance; operationId: string },
  [MESSAGES.saveArtifactRequest]: MESSAGE_EXEMPLARS.saveArtifactRequest[0]! satisfies { artifact: ActivityArtifact; operationId: string },
  [MESSAGES.activityLookupRequest]: MESSAGE_EXEMPLARS.activityLookupRequest[0]! satisfies { activityId: string },
  [MESSAGES.hostAck]: MESSAGE_EXEMPLARS.hostAck[1]! satisfies HostAck & { artifactDigest?: string },
  [MESSAGES.activityRecords]: MESSAGE_EXEMPLARS.activityRecords[1]! satisfies ActivityRecords,
  [MODEL_MANIFEST_CONTRACT]: quadraticManifest satisfies ModelManifest,
} satisfies { [N in SchemaName]: SchemaTypes[N] };

describe('typed exemplars', () => {
  it.each(SCHEMA_NAMES)('%s: the typed exemplar and every listed exemplar validate', name => {
    expect(validateRecord(name, TYPED[name]).diagnostics).toEqual([]);
    for (const exemplar of EXEMPLARS[name]) expect(validateRecord(name, exemplar.value), exemplar.case).toMatchObject({ ok: true });
  });
  it('covers every schema name', () => {
    expect(Object.keys(TYPED).sort()).toEqual([...SCHEMA_NAMES].sort());
  });
});

describe('shared fixtures (TypeScript decisions)', () => {
  it('are current: generated from the typed exemplars and declared mutations', () => {
    const built = new Map(buildFixtures().map(({ path, fixture }) => [path, fixtureText(fixture)]));
    expect(fixtures.map(entry => entry.file)).toEqual([...built.keys()].sort());
    for (const path of fixtureFiles) expect(readFileSync(path, 'utf8'), relative(fixtureRoot, path)).toBe(built.get(relative(fixtureRoot, path).split('\\').join('/')));
  });

  it.each(fixtures.map(entry => [entry.file, entry.fixture] as const))('%s', (file, fixture) => {
    expect(file.startsWith(`${fixture.expect}/${SHORT_NAMES[fixture.contract]}/`)).toBe(true);
    expect(typeof fixture.why).toBe('string');
    const result = validateRecord(fixture.contract, fixture.value);
    expect(result.ok, JSON.stringify(result.diagnostics.slice(0, 3))).toBe(fixture.expect === 'valid');
    if (!result.ok) expect(result.diagnostics.length).toBeGreaterThan(0);
  });

  it('every schema has at least 2 valid and 6 invalid fixtures, including unknown fields at two levels', () => {
    for (const name of SCHEMA_NAMES) {
      const own = fixtures.filter(entry => entry.fixture.contract === name);
      expect(own.filter(entry => entry.fixture.expect === 'valid').length, name).toBeGreaterThanOrEqual(2);
      const invalid = own.filter(entry => entry.fixture.expect === 'invalid').map(entry => entry.file.split('/').pop()!);
      expect(invalid.length, name).toBeGreaterThanOrEqual(6);
      expect(invalid, name).toContain('unknown-top-level-field.json');
    }
  });

  it('cover every required category across the corpus', () => {
    const names = fixtures.filter(entry => entry.fixture.expect === 'invalid').map(entry => entry.file);
    const categories: Record<string, RegExp> = {
      'unknown nested field': /unknown-(nested|payload)-field|-unknown-field/, 'missing required': /\/missing-/, 'astral over limit': /astral/,
      pattern: /-pattern\.json$/, range: /-(negative|out-of-range|zero|over-max|not-positive)\.json$/, 'non-integer': /non-integer/, 'max items': /over-max-items/,
      'max properties': /over-max-properties/, 'enum or const': /-(enum|const)\.json$/, 'oneOf/anyOf': /oneof|anyof/, '$ref target': /ref-target/, 'reserved key': /reserved-key|proto-key/,
    };
    for (const [category, pattern] of Object.entries(categories)) expect(names.some(name => pattern.test(name)), category).toBe(true);
    // Astral at-limit cases are valid with code points but would be rejected by a UTF-16 length check.
    const astralValid = fixtures.filter(entry => entry.fixture.expect === 'valid' && entry.file.includes('astral'));
    expect(astralValid.length).toBeGreaterThanOrEqual(4);
    for (const entry of astralValid) expect(JSON.stringify(entry.fixture.value)).toMatch(/[\u{10000}-\u{10FFFF}]/u);
  });
});

describe('emitted schema files', () => {
  const index = JSON.parse(readFileSync(join(packageRoot, 'schema/index.json'), 'utf8')) as { contracts: { name: string; file: string; dataLimits: unknown }[] };
  it.each(SCHEMA_NAMES)('%s is current on disk', name => {
    expect(readFileSync(join(packageRoot, 'schema', schemaFileName(name)), 'utf8')).toBe(JSON.stringify(SCHEMAS[name], null, 2) + '\n');
    expect(index.contracts.find(entry => entry.name === name)?.dataLimits).toEqual(dataLimitsFor(name));
  });

  const ALLOWED = new Set(['$schema', '$id', '$ref', '$defs', 'title', 'description', 'type', 'properties', 'required', 'additionalProperties', 'enum', 'const',
    'minLength', 'maxLength', 'pattern', 'minimum', 'maximum', 'exclusiveMinimum', 'minItems', 'maxItems', 'items', 'maxProperties', 'propertyNames', 'anyOf', 'oneOf']);
  /** The model manifest embeds a schema 2.0 document validated by core normalizeDocument, not by this schema. */
  const EXEMPT_OPEN_OBJECTS = new Set([`${MODEL_MANIFEST_CONTRACT}:$.properties.execution.oneOf[2].properties.document`]);
  const audit = (name: SchemaName, schema: JsonSchema, at: string, problems: string[]): void => {
    for (const key of Object.keys(schema)) if (!ALLOWED.has(key)) problems.push(`${at}: keyword ${key} is outside the shared subset`);
    if (schema.$ref) { if (Object.keys(schema).length !== 1) problems.push(`${at}: $ref has siblings`); return; }
    if ((schema.anyOf || schema.oneOf) && Object.keys(schema).some(key => !['anyOf', 'oneOf', 'title', 'description', '$schema', '$id', '$defs'].includes(key))) problems.push(`${at}: anyOf/oneOf has siblings`);
    const types = Array.isArray(schema.type) ? schema.type : schema.type ? [schema.type] : [];
    if (schema.pattern !== undefined && !/^[\x20-\x7e]*$/.test(schema.pattern)) problems.push(`${at}: pattern is not ASCII`);
    if (schema.pattern !== undefined && /\\[dDwWsSbB]/.test(schema.pattern)) problems.push(`${at}: pattern uses an engine-dependent class escape`);
    if (types.includes('string') && schema.maxLength === undefined && !schema.enum && schema.const === undefined) problems.push(`${at}: unbounded string`);
    if ((types.includes('number') || types.includes('integer')) && (schema.maximum === undefined || (schema.minimum === undefined && schema.exclusiveMinimum === undefined))) problems.push(`${at}: unbounded number`);
    if (types.includes('array') && schema.maxItems === undefined) problems.push(`${at}: unbounded array`);
    if (types.includes('object') && !EXEMPT_OPEN_OBJECTS.has(`${name}:${at}`)) {
      if (schema.additionalProperties === undefined || schema.additionalProperties === true) problems.push(`${at}: object accepts unknown fields`);
      if (typeof schema.additionalProperties === 'object' && (schema.maxProperties === undefined || !schema.propertyNames)) problems.push(`${at}: map is unbounded`);
    }
    for (const [key, child] of Object.entries(schema.properties ?? {})) audit(name, child, `${at}.properties.${key}`, problems);
    for (const [key, child] of Object.entries(schema.$defs ?? {})) audit(name, child, `${at}.$defs.${key}`, problems);
    for (const [index, child] of (schema.anyOf ?? []).entries()) audit(name, child, `${at}.anyOf[${index}]`, problems);
    for (const [index, child] of (schema.oneOf ?? []).entries()) audit(name, child, `${at}.oneOf[${index}]`, problems);
    if (schema.items) audit(name, schema.items, `${at}.items`, problems);
    if (typeof schema.additionalProperties === 'object') audit(name, schema.additionalProperties, `${at}.additionalProperties`, problems);
    if (schema.propertyNames) audit(name, schema.propertyNames, `${at}.propertyNames`, problems);
  };
  it.each(SCHEMA_NAMES)('%s uses only the bounded shared subset and rejects unknown fields everywhere', name => {
    const problems: string[] = [];
    audit(name, SCHEMAS[name], '$', problems);
    expect(problems).toEqual([]);
  });

  it('records declare their exact contract name and schema version', () => {
    for (const name of Object.values(CONTRACTS)) {
      const schema = SCHEMAS[name];
      const variants = schema.oneOf ? schema.oneOf.map(option => schema.$defs![option.$ref!.slice(8)]!) : [schema];
      for (const variant of variants) {
        expect(variant.properties?.contract).toEqual({ const: name });
        expect(variant.properties?.schemaVersion).toEqual({ const: '1.0' });
      }
    }
  });

  it('applies the documented bounds', () => {
    expect(LIMITS).toMatchObject({ id: 128, label: 200, text: 4000, tex: 4096, groups: 64, views: 16, marksPerView: 256, stages: 16, transitions: 32, scenarios: 64, parameters: 64 });
    expect(dataLimitsFor(CONTRACTS.artifact).maxBytes).toBe(4 * 1024 * 1024);
    expect(dataLimitsFor(CONTRACTS.template).maxBytes).toBe(512 * 1024);
  });
});

describe('validator hardening', () => {
  const secret = 'SOLUTION-x-equals-3.75-hidden';

  it('rejects prototype keys, accessors, cycles, class instances and nonfinite numbers without invoking getters', () => {
    expect(validateRecord(MESSAGES.journalCursor, JSON.parse(`{"activityId":"a","lastSequence":0,"lastEventId":null,"checkpointDigest":null,"__proto__":{"admin":true}}`)).ok).toBe(false);
    let invoked = false;
    const getter = { ...cursor };
    Object.defineProperty(getter, 'activityId', { enumerable: true, get: () => { invoked = true; return 'act-1'; } });
    expect(validateRecord(MESSAGES.journalCursor, getter).ok).toBe(false);
    expect(invoked).toBe(false);
    const cyclic: Record<string, unknown> = { activityId: 'act-1', events: [] };
    (cyclic.events as unknown[]).push(cyclic);
    expect(validateRecord(MESSAGES.appendEventsRequest, cyclic).diagnostics[0]?.message).toMatch(/Cyclic/);
    expect(validateRecord(MESSAGES.journalCursor, new (class Cursor { activityId = 'a'; lastSequence = 0; lastEventId = null; checkpointDigest = null })()).ok).toBe(false);
    expect(validateRecord(MESSAGES.displayAckRequest, { ...MESSAGE_EXEMPLARS.displayAckRequest[0], monotonicMs: Number.POSITIVE_INFINITY }).ok).toBe(false);
    expect(validateRecord(MESSAGES.journalCursor, { ...cursor, [Symbol('hidden')]: 1 }).ok).toBe(false);
  });

  it('rejects oversized and deeply nested payloads before schema traversal', () => {
    const big = { ...MESSAGE_EXEMPLARS.activityLookupRequest[0], activityId: 'x'.repeat(600 * 1024) };
    expect(validateRecord(MESSAGES.activityLookupRequest, big).diagnostics).toEqual([expect.objectContaining({ code: 'RESOURCE_LIMIT' })]);
    let deep: unknown = 1;
    for (let level = 0; level < 40; level++) deep = { k: deep };
    expect(validateRecord(CONTRACTS.event, { ...EVENTS['help-requested'], payload: { nested: deep } }).diagnostics[0]?.code).toBe('RESOURCE_LIMIT');
    // An artifact may be larger than an ordinary record (4 MiB vs 512 KiB).
    const largeLimitations = { ...backupArtifact, migratedFrom: { contract: 'study-harness.activity-artifact', version: '1.0', digest: backupArtifact.integrity.digest, report: Array.from({ length: 64 }, () => 'r'.repeat(3999)) } };
    expect(validateRecord(CONTRACTS.artifact, largeLimitations).diagnostics.every(item => item.code !== 'RESOURCE_LIMIT')).toBe(true);
  });

  it('never echoes input values in messages, recoveries or paths', () => {
    const cases: [SchemaName, unknown][] = [
      [MESSAGES.journalCursor, { activityId: secret + ' with spaces', lastSequence: secret, lastEventId: secret, checkpointDigest: secret }],
      [CONTRACTS.template, { ...quadraticTemplate, title: secret.repeat(20), dimension: secret, locale: secret, [`${secret} key`]: secret }],
      [CONTRACTS.event, { ...EVENTS['comparison-retained'], payload: { runId: secret + '!', label: secret.repeat(10) } }],
      [CONTRACTS.event, { ...EVENTS['help-requested'], payload: { [`${secret} spaced key`]: secret } }],
      [CONTRACTS.policy, { ...approvedPolicy, allowedTools: [secret], visibleGroups: [secret + '/'] }],
    ];
    for (const [name, value] of cases) {
      const { ok, diagnostics } = validateRecord(name, value);
      expect(ok).toBe(false);
      for (const diagnostic of diagnostics) {
        expect(diagnostic.message).not.toContain(secret);
        expect(diagnostic.recovery ?? '').not.toContain(secret);
        expect(diagnostic.path).not.toMatch(/ /);
        expect(diagnostic.path.length).toBeLessThanOrEqual(200);
      }
    }
    expect(safePath('$.views[0].bad key.x')).toBe('$.views[0].<redacted-key>');
    expect(safePath('$.ok')).toBe('$.ok');
  });

  it('discriminates event variants for precise paths with the same decision as the exclusive oneOf', () => {
    const value = { ...EVENTS['parameters-committed'], payload: { ...EVENTS['parameters-committed']!.payload, secretAnswer: 1 } };
    expect(validateRecord(CONTRACTS.event, value).diagnostics.map(item => item.path)).toEqual(['$.payload.secretAnswer']);
    for (const { fixture } of fixtures.filter(entry => entry.fixture.contract === CONTRACTS.event)) {
      const limits = dataLimitsFor(CONTRACTS.event);
      const payload = (fixture.value as { payload?: unknown } | null)?.payload;
      const payloadOk = payload === undefined || jsonDataErrors(payload, { ...limits, maxBytes: limits.maxPayloadBytes! }).length === 0;
      const full = jsonDataErrors(fixture.value, limits).length === 0 && payloadOk && schemaErrors(fixture.value, SCHEMAS[CONTRACTS.event]).length === 0;
      expect(validateRecord(CONTRACTS.event, fixture.value).ok).toBe(full);
    }
    const batch = { activityId: 'act-1', events: [{ ...EVENTS['preview-cancelled'], payload: { previewId: 'pv-1', reason: 'boredom' } }] };
    expect(validateRecord(MESSAGES.appendEventsRequest, batch).diagnostics.map(item => item.path)).toEqual(['$.events[0].payload.reason']);
    const heavy = { ...EVENTS['help-requested'], payload: { a: 'p'.repeat(2800), b: 'p'.repeat(2800), c: 'p'.repeat(2800) } };
    expect(validateRecord(CONTRACTS.event, heavy).diagnostics).toEqual([expect.objectContaining({ code: 'RESOURCE_LIMIT', path: expect.stringMatching(/^\$\.payload/), message: 'Event payload exceeds 8192 bytes.' })]);
  });

  it('types valid records and reports unknown contract names', () => {
    expect(isValidRecord(CONTRACTS.review, modelReview)).toBe(true);
    const parsed = parseRecord(CONTRACTS.review, modelReview);
    expect(parsed.ok && parsed.value.reviewId).toBe('review-model-quadratic-1');
    expect(validateRecord('study-harness.unknown' as SchemaName, {}).diagnostics[0]).toMatchObject({ code: 'INVALID_INPUT' });
  });
});
