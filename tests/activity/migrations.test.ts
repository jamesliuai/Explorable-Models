import { beforeAll, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ExperimentRuntime, RUNTIME_VERSION, definitionRevision, validateSnapshot, type AnalyticModel, type ExperimentDefinition, type Manifest } from '../../packages/core/src/index.js';
import { canonicalJSON, sha256 } from '../../packages/core/src/identity.js';
import { DOCUMENT_RUNTIME_VERSION, createVisualizationSession } from '../../packages/core/src/declarative-session.js';
import { createPreset } from '../../packages/core/src/presets.js';
import { evaluateDocument } from '../../packages/core/src/declarative/evaluation.js';
import type { MutationGuard, VisualizationSession } from '../../packages/core/src/declarative/types.js';
import { CONTRACTS, type ActivityArtifact } from '../../packages/activity/src/contracts.js';
import { artifactIntegrity } from '../../packages/activity/src/identity.js';
import { restoreClaims, verifyArtifact } from '../../packages/activity/src/artifacts.js';
import {
  CURRENT_ARTIFACT_VERSION, DRAFT_0_9_FIELDS, DRAFT_0_9_TO_1_0, MIGRATIONS, createMigrationRegistry, draft09Integrity, migrateArtifact, migratedArtifactId, type MigrationStep,
} from '../../packages/activity/src/migrations.js';
import { UNSUPPORTED_RECOVERY } from '../../packages/activity/src/versions.js';
import { backupArtifact } from '../../packages/activity/fixtures-src/exemplars.js';

const directory = fileURLToPath(new URL('../../packages/activity/fixtures/migrations/', import.meta.url));
const read = (name: string) => readFileSync(join(directory, name), 'utf8');
const json = (value: unknown) => JSON.stringify(value, null, 2) + '\n';
const bytesDigest = (text: string) => 'sha256:' + createHash('sha256').update(text, 'utf8').digest('hex');
const deepFreeze = <T>(value: T): T => { if (value && typeof value === 'object') { Object.freeze(value); for (const item of Object.values(value)) deepFreeze(item); } return value; };

// ---------------------------------------------------------------------------------------------
// Fixture builders. Deterministic fixtures are checked for currency below; regenerate every fixture with
// UPDATE_MIGRATION_FIXTURES=1 npx vitest run tests/activity/migrations.test.ts
// ---------------------------------------------------------------------------------------------
const { integrity: _integrity, ...backupBody } = backupArtifact;
/** Draft 0.9 artifact derived from the 1.0 contract exemplar by the documented inverse mapping. */
function draftArtifact(): Record<string, unknown> {
  const { exposures, pending: _pending, migratedFrom: _migratedFrom, ...rest } = backupBody;
  const source: Record<string, unknown> = {
    ...rest, schemaVersion: '0.9', artifactId: 'artifact-draft-0001', reveals: exposures,
    schemas: rest.schemas.map(entry => entry.contract === CONTRACTS.artifact ? { ...entry, version: '0.9' } : entry),
  };
  const body = Object.fromEntries(DRAFT_0_9_FIELDS.map(field => [field, source[field]]));
  return { ...body, integrity: draft09Integrity(body) };
}
/** The report the 0.9 → 1.0 migration must produce for the draft fixture (normative wording). */
const DRAFT_REPORT = [
  'Format: the draft field "reveals" is now "exposures"; 2 exposure records are carried unchanged.',
  'Format: "pending" is recorded as none. The draft format kept only the committed checkpoint and had no field for a pending preview, so a preview active when the draft was saved was not retained and cannot be recovered.',
  'Format: the schema entry for study-harness.activity-artifact changed from 0.9 to 1.0; nested records were already 1.0 and are unchanged.',
  'Semantics: the scientific snapshot, presentation, exposure history and journal checkpoint are unchanged. Equivalence with the installed model is established only at restore, by the exact model digest.',
  'Identity: the migrated artifact has a new artifactId; the digest of the original bytes is retained in migratedFrom.',
];
/** Expected 1.0 output, assembled independently of the migration code from the exemplar and the draft bytes. */
function expectedMigration(draftText: string): ActivityArtifact {
  const digest = bytesDigest(draftText);
  const body = { ...backupBody, artifactId: `migrated-${digest.slice(7, 31)}`, migratedFrom: { contract: CONTRACTS.artifact, version: '0.9', digest, report: DRAFT_REPORT } };
  return { ...body, integrity: artifactIntegrity(body) };
}
function deterministicFixtures(): Map<string, string> {
  const draft = draftArtifact();
  const draftText = json(draft);
  const corrupted = structuredClone(draft) as { scientific: { params: Record<string, number> } };
  corrupted.scientific.params.eta = 1.25;
  const { scientific: _scientific, ...missingBlob } = draft;
  return new Map([
    ['draft-0.9-artifact.json', draftText],
    ['draft-0.9-migrated-1.0.json', json(expectedMigration(draftText))],
    ['draft-0.9-corrupted.json', json(corrupted)],
    ['draft-0.9-truncated.partial', draftText.slice(0, Math.floor(draftText.length * 0.6))],
    ['draft-0.9-missing-blob.json', json(missingBlob)],
    ['future-2.0.json', json({ ...backupArtifact, schemaVersion: '2.0', schemas: backupArtifact.schemas.map(entry => entry.contract === CONTRACTS.artifact ? { ...entry, version: '2.0' } : entry) })],
  ]);
}

// Legacy exports produced by their own retained runtimes (not deterministic: they carry session IDs and dates).
const legacyManifest: Manifest = {
  schemaVersion: '1.0', id: 'motion', title: 'Motion', description: 'A constant acceleration model.', question: 'How far does an accelerating point travel?', kind: 'analytic',
  parameters: { a: { type: 'number', default: 2, label: 'Acceleration', min: 0, max: 10, unit: 'm/s²' } },
  quantities: { position: { type: 'scalar', label: 'Position', unit: 'm', dimension: 'length', description: 'Distance from origin.' } },
  entities: [{ id: 'point', label: 'Moving point', quantityIds: ['position'] }], assumptions: ['Constant acceleration.'], limitations: ['Stops at t = 2 s.'],
  sources: [{ title: 'Reference', url: 'https://example.org/reference' }], capabilities: ['play'], review: { status: 'unreviewed' },
};
const legacyModel: AnalyticModel = { kind: 'analytic', timeDomain: () => ({ start: 0, end: 2, endEventId: 'stop' }), evaluate: ({ params, time }) => ({ quantities: { position: { value: 0.5 * Number(params.a) * time * time, status: 'valid' } } }) };
const legacyDefinition: ExperimentDefinition = { manifest: legacyManifest, model: legacyModel, definitionRevision: definitionRevision({ manifest: legacyManifest, source: 'migration-fixture-v1', dependencyLock: 'lock' }) };
let operation = 0;
const guard = (session: VisualizationSession): MutationGuard => ({ sessionId: session.id, expectedVersion: session.getState().version, ...(session.getState().run && { expectedRunId: session.getState().run!.id }), operationId: `fixture-${++operation}` });
const documentSession = () => createVisualizationSession({ evaluator: { evaluate: async request => evaluateDocument(request), dispose() {} } });
async function legacyFixtures(): Promise<Map<string, string>> {
  const session = await documentSession();
  const candidate = await session.createCandidate(createPreset('riemann-sums'), guard(session));
  await session.commitCandidate(candidate.id, guard(session));
  const document = session.exportDocument();
  session.dispose();
  const runtime = await ExperimentRuntime.create(legacyDefinition);
  const snapshot = runtime.checkpoint('Migration fixture');
  return new Map([['legacy-document-2.0.json', json(document)], ['legacy-snapshot-1.0.json', json(snapshot)]]);
}

describe('migration fixtures', () => {
  it('are current (regenerate with UPDATE_MIGRATION_FIXTURES=1)', async () => {
    const fixtures = deterministicFixtures();
    if (process.env.UPDATE_MIGRATION_FIXTURES === '1') {
      mkdirSync(directory, { recursive: true });
      for (const [name, text] of [...fixtures, ...await legacyFixtures()]) writeFileSync(join(directory, name), text);
    }
    for (const [name, text] of fixtures) expect(read(name), `${name} is stale`).toBe(text);
    expect(readdirSync(directory).sort()).toEqual([...fixtures.keys(), 'README.md', 'legacy-document-2.0.json', 'legacy-snapshot-1.0.json'].sort());
  });

  it('describe a self-consistent draft: its own integrity manifest verifies and it mirrors the 1.0 exemplar', () => {
    const draft = JSON.parse(read('draft-0.9-artifact.json')) as Record<string, unknown>;
    const { integrity, ...body } = draft;
    expect(integrity).toEqual(draft09Integrity(body));
    expect(Object.keys(body)).toEqual([...DRAFT_0_9_FIELDS]);
    expect(body.reveals).toEqual(backupArtifact.exposures);
    expect(body).not.toHaveProperty('pending');
    expect(body.scientific).toEqual(backupArtifact.scientific);
  });

  it('keep legacy exports readable by their own retained runtimes', async () => {
    const snapshot = JSON.parse(read('legacy-snapshot-1.0.json'));
    if (snapshot.runtimeVersion === RUNTIME_VERSION) expect(validateSnapshot(snapshot, legacyManifest, legacyDefinition.definitionRevision, RUNTIME_VERSION).runId).toBe(snapshot.runId);
    const document = JSON.parse(read('legacy-document-2.0.json'));
    const session = await documentSession();
    try {
      const restored = session.restoreDocument(document, guard(session));
      if (document.runtimeVersion === DOCUMENT_RUNTIME_VERSION) await expect(restored).resolves.toBeDefined();
      else await expect(restored).rejects.toBeDefined();
    } finally { session.dispose(); }
  });
});

describe('draft 0.9 → 1.0 migration (A49)', () => {
  let draftText = '';
  beforeAll(() => { draftText = read('draft-0.9-artifact.json'); });

  it('migrates the original bytes, retains their digest, assigns a new identity and reports every change', () => {
    const outcome = migrateArtifact(draftText);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(json(outcome.artifact)).toBe(read('draft-0.9-migrated-1.0.json'));
    expect(outcome).toMatchObject({ migrated: true, semanticsChanged: false, restore: 'exact', report: DRAFT_REPORT, original: { digest: bytesDigest(draftText), basis: 'bytes', contract: CONTRACTS.artifact, version: '0.9' } });
    const draft = JSON.parse(draftText) as { artifactId: string; reveals: unknown; scientific: unknown; journal: unknown };
    expect(outcome.artifact.artifactId).not.toBe(draft.artifactId);
    expect(outcome.artifact.artifactId).toBe(migratedArtifactId(bytesDigest(draftText)));
    expect(outcome.artifact.migratedFrom).toEqual({ contract: CONTRACTS.artifact, version: '0.9', digest: bytesDigest(draftText), report: DRAFT_REPORT });
    expect(outcome.artifact.exposures).toEqual(draft.reveals);
    expect(outcome.artifact.scientific).toEqual(draft.scientific);
    expect(outcome.artifact.journal).toEqual(draft.journal);
    expect(outcome.artifact.pending).toEqual({ kind: 'none' });
    expect(verifyArtifact(outcome.artifact).ok).toBe(true);
    expect(restoreClaims(outcome.artifact).map(claim => claim.path)).toContain('$.migratedFrom');
    // Deterministic: the same bytes give the same artifact; the same bytes as Uint8Array give the same digest.
    const again = migrateArtifact(new TextEncoder().encode(draftText));
    expect(again.ok && json(again.artifact)).toBe(json(outcome.artifact));
  });

  it('uses the canonical JSON digest when only a parsed value is available', () => {
    const parsed = JSON.parse(draftText);
    const outcome = migrateArtifact(parsed);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.original).toMatchObject({ basis: 'canonical-json', digest: 'sha256:' + sha256(canonicalJSON(parsed)) });
    expect(outcome.report.at(-1)).toBe('Identity: the migrated artifact has a new artifactId; the digest of the original canonical JSON is retained in migratedFrom.');
  });

  it('never modifies the original value, even when a later step fails', () => {
    const parsed = deepFreeze(JSON.parse(draftText));
    expect(migrateArtifact(parsed).ok).toBe(true);
    const breaking: MigrationStep = { ...DRAFT_0_9_TO_1_0, migrate: () => { throw new Error('step failure'); } };
    const renaming: MigrationStep = {
      from: { contract: CONTRACTS.artifact, version: '0.8' }, to: { contract: CONTRACTS.artifact, version: '0.9' }, verify: () => [],
      migrate: value => { value.schemaVersion = '0.9'; return { value, report: ['Format: 0.8 to 0.9.'], semanticsChanged: false }; },
    };
    const registry = createMigrationRegistry([renaming, breaking]);
    const older = deepFreeze({ ...JSON.parse(draftText), schemaVersion: '0.8' });
    const before = json(older);
    const outcome = migrateArtifact(older, { registry });
    expect(outcome).toMatchObject({ ok: false, kind: 'rejected', diagnostics: [{ code: 'UNSUPPORTED_ARTIFACT', message: 'The migration from 0.9 to 1.0 failed.' }] });
    if (!outcome.ok) expect(outcome.diagnostics[0]!.recovery).toContain('The original artifact is unchanged.');
    expect(json(older)).toBe(before);
    // A step whose output does not validate is rejected as a whole.
    const invalid: MigrationStep = { ...DRAFT_0_9_TO_1_0, migrate: value => ({ ...DRAFT_0_9_TO_1_0.migrate(value), value: { ...DRAFT_0_9_TO_1_0.migrate(value).value, kind: 'everything' } }) };
    expect(migrateArtifact(draftText, { registry: createMigrationRegistry([invalid]) })).toMatchObject({ ok: false, kind: 'rejected', diagnostics: [{ message: 'The migrated artifact did not validate.' }, { code: 'SCHEMA' }] });
  });

  it('separates format migration from scientific equivalence: a meaning change restricts the restore', () => {
    const units: MigrationStep = {
      from: { contract: CONTRACTS.artifact, version: '0.8' }, to: CURRENT_ARTIFACT_VERSION, verify: () => [],
      migrate: ({ integrity: _drop, ...value }) => ({ value: { ...value, schemaVersion: '1.0' }, report: ['Semantics: the draft stored angles in degrees; they are now radians.'], semanticsChanged: true }),
    };
    const outcome = migrateArtifact({ ...backupArtifact, schemaVersion: '0.8' }, { registry: createMigrationRegistry([units]) });
    expect(outcome).toMatchObject({ ok: true, migrated: true, semanticsChanged: true, restore: 'restricted' });
    if (outcome.ok) expect(outcome.artifact.migratedFrom?.report[0]).toBe('Semantics: the draft stored angles in degrees; they are now radians.');
  });

  it('rejects a corrupted, truncated or incomplete draft without converting it', () => {
    expect(migrateArtifact(read('draft-0.9-corrupted.json'))).toMatchObject({
      ok: false, kind: 'rejected', diagnostics: [{ code: 'UNSUPPORTED_ARTIFACT' }, { code: 'INTEGRITY_FAILURE', path: '$.scientific', message: 'Field scientific does not match its integrity digest.' }],
    });
    expect(migrateArtifact(read('draft-0.9-truncated.partial'))).toMatchObject({ ok: false, kind: 'rejected', diagnostics: [{ code: 'INTEGRITY_FAILURE', path: '$', message: 'The artifact is not complete JSON: it is truncated or corrupted.' }] });
    expect(migrateArtifact(read('draft-0.9-missing-blob.json'))).toMatchObject({
      ok: false, kind: 'rejected', diagnostics: [{ code: 'UNSUPPORTED_ARTIFACT' }, { code: 'INTEGRITY_FAILURE', path: '$.scientific', message: 'The content of scientific is missing although the integrity manifest references it.' }],
    });
    const extra = { ...JSON.parse(draftText), teacherNotes: 'x' };
    expect(migrateArtifact(extra)).toMatchObject({ ok: false, diagnostics: [{ code: 'UNSUPPORTED_ARTIFACT' }, { code: 'SCHEMA', path: '$' }] });
  });

  it('rejects unknown and future versions with UNSUPPORTED_ARTIFACT and a recovery that keeps the original', () => {
    for (const raw of [read('future-2.0.json'), { ...JSON.parse(draftText), schemaVersion: '0.7' }]) {
      const outcome = migrateArtifact(raw);
      expect(outcome).toMatchObject({ ok: false, kind: 'rejected', diagnostics: [{ code: 'UNSUPPORTED_ARTIFACT', path: '$.schemaVersion', recovery: UNSUPPORTED_RECOVERY }] });
    }
    expect(migrateArtifact({ contract: 'study-harness.activity-artifact-v9', schemaVersion: '0.9' })).toMatchObject({ ok: false, kind: 'rejected', diagnostics: [{ code: 'UNSUPPORTED_ARTIFACT', path: '$.contract' }] });
  });

  it('passes a current artifact through after verification', () => {
    const text = JSON.stringify(backupArtifact);
    const outcome = migrateArtifact(text);
    expect(outcome).toMatchObject({ ok: true, migrated: false, semanticsChanged: false, restore: 'exact', report: [], original: { digest: bytesDigest(text), basis: 'bytes', version: '1.0' } });
    if (outcome.ok) expect(outcome.artifact).toEqual(backupArtifact);
    expect(migrateArtifact(text.replace('"eta":1.5', '"eta":1.6'))).toMatchObject({ ok: false, kind: 'rejected', diagnostics: [{ code: 'INTEGRITY_FAILURE' }] });
  });
});

describe('legacy readers route records to their retained runtimes (A04, A49)', () => {
  it('routes a schema 2.0 document artifact to the document session without relabelling it', () => {
    const text = read('legacy-document-2.0.json');
    const outcome = migrateArtifact(text);
    expect(outcome).toMatchObject({ ok: false, kind: 'legacy', route: 'document-session', legacy: { kind: 'legacy-document-artifact', version: '2.0', runtimeVersion: JSON.parse(text).runtimeVersion }, original: { digest: bytesDigest(text), basis: 'bytes' } });
    if (!outcome.ok && outcome.kind === 'legacy') {
      expect(outcome.recovery).toContain('DeclarativeSession.restoreDocument');
      expect(outcome.diagnostics).toEqual([{ code: 'UNSUPPORTED_ARTIFACT', path: '$', message: 'The record is a legacy-document-artifact; it is not an activity artifact and is not converted.', recovery: outcome.recovery }]);
    }
    expect(outcome).not.toHaveProperty('artifact');
  });

  it('routes a schema 1.0 snapshot and bundle manifest to the source runtime, and a 2.0 document to a document session', () => {
    const snapshot = migrateArtifact(read('legacy-snapshot-1.0.json'));
    expect(snapshot).toMatchObject({ ok: false, kind: 'legacy', route: 'source-runtime', legacy: { kind: 'legacy-experiment-snapshot', schemaVersion: '1.0' } });
    const bundle = { schemaVersion: '1.0', experimentId: 'motion', definitionRevision: 'sha256:' + '4'.repeat(64), runtimeVersion: '0.1.0', assets: [] };
    expect(migrateArtifact(bundle)).toMatchObject({ ok: false, kind: 'legacy', route: 'source-runtime', legacy: { kind: 'legacy-source-bundle' } });
    expect(migrateArtifact(createPreset('riemann-sums'))).toMatchObject({ ok: false, kind: 'legacy', route: 'document-session', legacy: { kind: 'visualization-document' } });
  });
});

describe('migration registry', () => {
  it('registers exactly the draft 0.9 path in this release', () => {
    expect(MIGRATIONS.steps.map(step => `${step.from.version}->${step.to.version}`)).toEqual(['0.9->1.0']);
    expect(MIGRATIONS.chain({ contract: CONTRACTS.artifact, version: '0.9' })).toEqual([DRAFT_0_9_TO_1_0]);
    expect(MIGRATIONS.chain({ contract: CONTRACTS.artifact, version: '2.0' })).toBeNull();
    expect(MIGRATIONS.chain(CURRENT_ARTIFACT_VERSION)).toBeNull();
  });

  it('rejects duplicate starts, cycles and paths that never reach the current version', () => {
    const step = (from: string, to: string): MigrationStep => ({ from: { contract: CONTRACTS.artifact, version: from }, to: { contract: CONTRACTS.artifact, version: to }, verify: () => [], migrate: value => ({ value, report: [], semanticsChanged: false }) });
    expect(() => createMigrationRegistry([step('0.9', '1.0'), step('0.9', '1.0')])).toThrow(/Two migrations/);
    expect(() => createMigrationRegistry([step('0.8', '0.7'), step('0.7', '0.8')])).toThrow(/does not reach/);
    expect(() => createMigrationRegistry([step('0.5', '0.6')])).toThrow(/does not reach/);
    expect(() => createMigrationRegistry([step('1.0', '1.0')])).toThrow(/cannot start/);
  });
});
