import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sha256 } from '../../packages/core/src/identity.js';
import { DOCUMENT_SCHEMA } from '../../packages/core/src/declarative/schema.js';
import { DOCUMENT_RUNTIME_VERSION } from '../../packages/core/src/declarative-session.js';
import { createPreset, presetCatalog } from '../../packages/core/src/presets.js';
import { CONTRACTS } from '../../packages/activity/src/contracts.js';
import { MESSAGES, SCHEMAS, SCHEMA_NAMES, SCHEMA_VERSIONS, schemaFileName, type SchemaName } from '../../packages/activity/src/schemas.js';
import { COMPATIBILITY, CONTRACT_VERSIONS, UNSUPPORTED_RECOVERY, classifyRecord, readRecord, schemaDigest, schemaDigests } from '../../packages/activity/src/versions.js';
import { EXEMPLARS, backupArtifact, quadraticTemplate } from '../../packages/activity/fixtures-src/exemplars.js';

const packageRoot = fileURLToPath(new URL('../../packages/activity/', import.meta.url));
const repositoryRoot = fileURLToPath(new URL('../../', import.meta.url));
const lock = JSON.parse(readFileSync(join(packageRoot, 'schema/frozen-1.0.json'), 'utf8')) as { version: string; schemas: Record<string, string>; baseline: Record<string, string> };
const index = JSON.parse(readFileSync(join(packageRoot, 'schema/index.json'), 'utf8')) as { contracts: { name: SchemaName; file: string; sha256: string; digest: string; version: string }[] };
const RECORD_NAMES = new Set<string>([...Object.values(CONTRACTS), 'experiment-kit.model-manifest']);

describe('frozen schema identities (A04)', () => {
  it.each(Object.entries(lock.schemas))('%s 1.0 is unchanged', (name, digest) => {
    expect(SCHEMA_NAMES, `${name} was removed; a frozen 1.0 schema must keep a reader`).toContain(name);
    expect(schemaDigest(SCHEMAS[name as SchemaName]), `${name} 1.0 changed without a version bump: publish the change under a new schema version`).toBe(digest);
  });

  it('locks every current 1.0 schema', () => {
    const current = SCHEMA_NAMES.filter(name => SCHEMA_VERSIONS[name] === '1.0');
    expect(Object.keys(lock.schemas).sort(), 'a new 1.0 schema must be added to schema/frozen-1.0.json deliberately').toEqual([...current].sort());
    expect(lock.version).toBe('1.0');
  });

  it('keeps the baseline schema 2.0 document schema identity', () => {
    expect(schemaDigest(DOCUMENT_SCHEMA), 'the schema 2.0 document schema must never change; introduce a new document version instead').toBe(lock.baseline['experiment-kit.document-2.0']);
  });

  it('publishes each schema file with the sha256 and digest recorded in index.json', () => {
    const digests = schemaDigests();
    for (const entry of index.contracts) {
      const text = readFileSync(join(packageRoot, 'schema', entry.file), 'utf8');
      expect(entry.file).toBe(schemaFileName(entry.name));
      expect(sha256(text), entry.file).toBe(entry.sha256);
      expect(digests[entry.name]).toBe(entry.digest);
      expect(schemaDigest(JSON.parse(text))).toBe(entry.digest);
    }
    expect(index.contracts.map(entry => entry.name).sort()).toEqual([...SCHEMA_NAMES].sort());
  });

  it('registers exactly version 1.0 for every contract in this release', () => {
    for (const name of SCHEMA_NAMES) expect(CONTRACT_VERSIONS[name]).toEqual(['1.0']);
  });

  it('lists every classification kind in the compatibility matrix', () => {
    expect(COMPATIBILITY.map(row => row.kind).sort()).toEqual(['legacy-document-artifact', 'legacy-experiment-snapshot', 'legacy-source-bundle', 'study-harness', 'visualization-document']);
  });
});

describe('record classification and readers', () => {
  it('classifies every exemplar record by its declared contract and version', () => {
    for (const name of SCHEMA_NAMES) {
      for (const exemplar of EXEMPLARS[name]) {
        if (RECORD_NAMES.has(name)) expect(classifyRecord(exemplar.value)).toEqual({ kind: 'study-harness', contract: name, version: '1.0' });
        const read = readRecord(name, exemplar.value);
        expect(read.ok, `${name}/${exemplar.case}`).toBe(true);
      }
    }
  });

  it.each(['1.1', '2.0', '0.9'])('rejects schema version %s with UNSUPPORTED_ARTIFACT and a recovery that keeps the original bytes', version => {
    const future = { ...quadraticTemplate, schemaVersion: version };
    const before = structuredClone(future);
    const classification = classifyRecord(future);
    expect(classification.kind).toBe('unsupported');
    if (classification.kind !== 'unsupported') return;
    expect(classification.diagnostic).toMatchObject({ code: 'UNSUPPORTED_ARTIFACT', path: '$.schemaVersion', recovery: UNSUPPORTED_RECOVERY });
    expect(classification.diagnostic.message).not.toContain(version);
    expect(UNSUPPORTED_RECOVERY).toMatch(/original bytes/);
    expect(UNSUPPORTED_RECOVERY).toMatch(/runtime that produced it/);
    expect(UNSUPPORTED_RECOVERY).toMatch(/archival read-only view/);
    const read = readRecord(CONTRACTS.template, future);
    expect(read.ok).toBe(false);
    if (!read.ok) expect(read.diagnostics[0]?.code).toBe('UNSUPPORTED_ARTIFACT');
    expect(future).toEqual(before);
  });

  it('rejects unknown contracts and non-objects without echoing them', () => {
    const unknown = classifyRecord({ ...backupArtifact, contract: 'study-harness.activity-artifact-secret-v9' });
    expect(unknown).toMatchObject({ kind: 'unsupported', diagnostic: { code: 'UNSUPPORTED_ARTIFACT', path: '$.contract' } });
    if (unknown.kind === 'unsupported') expect(unknown.diagnostic.message).not.toContain('secret');
    for (const value of [null, [], 'artifact', 42]) expect(classifyRecord(value).kind).toBe('unsupported');
    expect(classifyRecord({ ...quadraticTemplate, schemaVersion: undefined }).kind).toBe('unsupported');
  });

  it('refuses to read one contract as another', () => {
    const read = readRecord(CONTRACTS.instance, backupArtifact);
    expect(read.ok).toBe(false);
    if (!read.ok) expect(read.diagnostics[0]).toMatchObject({ code: 'UNSUPPORTED_ARTIFACT', message: 'The record is a different contract than expected.' });
    expect(readRecord(MESSAGES.journalCursor, { ...EXEMPLARS[MESSAGES.journalCursor][0]!.value, contract: CONTRACTS.instance }).ok).toBe(false);
  });

  describe('legacy formats keep their own identity and are never relabelled', () => {
    const document = createPreset(presetCatalog[0]!.id);
    const documentArtifact = {
      format: 'experiment-kit-document', version: '2.0', runtimeVersion: DOCUMENT_RUNTIME_VERSION, document,
      identity: { documentRevision: 'sha256:' + '1'.repeat(64), modelRevision: 'sha256:' + '2'.repeat(64), presentationRevision: 'sha256:' + '3'.repeat(64) },
      run: { id: 'run-1', version: 1, params: {}, time: 0, modelRevision: 'sha256:' + '2'.repeat(64) }, selection: null, comparisons: [],
    };
    const bundleManifest = {
      schemaVersion: '1.0', experimentId: 'rolling', definitionRevision: 'sha256:' + '4'.repeat(64), runtimeVersion: '0.1.0', exportedAt: '2026-01-01T00:00:00.000Z',
      dependencyLockDigest: 'sha256:' + '5'.repeat(64), assets: [], capabilities: { offlineHTTPPlayback: true, fileURLPlayback: false, hostileCodeIsolation: false },
      modelReview: { status: 'unreviewed' }, learnerEvidence: 'not_evaluated',
    };
    const snapshot = {
      schemaVersion: '1.0', experimentId: 'rolling', definitionRevision: 'sha256:' + '4'.repeat(64), runtimeVersion: '0.1.0', runId: 'run-1', runVersion: 0,
      parameters: {}, timePoint: { kind: 'time', value: 0 }, view: {}, viewVersion: 0, comparisonReferences: [], createdAt: '2026-01-01T00:00:00.000Z',
    };

    it('classifies a schema 2.0 document artifact with its exact runtime version', () => {
      expect(classifyRecord(documentArtifact)).toEqual({ kind: 'legacy-document-artifact', version: '2.0', runtimeVersion: DOCUMENT_RUNTIME_VERSION });
      const read = readRecord(CONTRACTS.artifact, documentArtifact);
      expect(read.ok).toBe(false);
      if (!read.ok) {
        expect(read.classification.kind).toBe('legacy-document-artifact');
        expect(read.diagnostics[0]).toMatchObject({ code: 'UNSUPPORTED_ARTIFACT', recovery: UNSUPPORTED_RECOVERY });
      }
      expect(classifyRecord({ ...documentArtifact, version: '3.0' })).toMatchObject({ kind: 'unsupported', diagnostic: { path: '$.version' } });
      expect(classifyRecord({ ...documentArtifact, runtimeVersion: undefined })).toMatchObject({ kind: 'unsupported', diagnostic: { path: '$.runtimeVersion' } });
    });

    it('classifies a schema 2.0 visualization document as a document, not an activity record', () => {
      expect(classifyRecord(document)).toEqual({ kind: 'visualization-document', schemaVersion: '2.0' });
      expect(readRecord(CONTRACTS.template, document).ok).toBe(false);
    });

    it('classifies schema 1.0 bundle manifests, source inventories and experiment snapshots', () => {
      expect(classifyRecord(bundleManifest)).toEqual({ kind: 'legacy-source-bundle', schemaVersion: '1.0' });
      const inventory = JSON.parse(readFileSync(join(repositoryRoot, 'public/source-manifest.json'), 'utf8'));
      expect(classifyRecord(inventory)).toEqual({ kind: 'legacy-source-bundle', schemaVersion: '1.0' });
      expect(classifyRecord(snapshot)).toEqual({ kind: 'legacy-experiment-snapshot', schemaVersion: '1.0', runtimeVersion: '0.1.0' });
      for (const legacy of [bundleManifest, inventory, snapshot]) {
        const read = readRecord(CONTRACTS.artifact, legacy);
        expect(read.ok).toBe(false);
        if (!read.ok) expect(read.classification.kind).not.toBe('study-harness');
      }
      expect(classifyRecord({ schemaVersion: '1.0' }).kind).toBe('unsupported');
    });
  });
});
