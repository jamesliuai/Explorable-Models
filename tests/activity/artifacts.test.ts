import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { canonicalJSON, sha256 } from '../../packages/core/src/identity.js';
import { validateRecord } from '../../packages/activity/src/validator.js';
import type { ActivityArtifact, ScientificSnapshot } from '../../packages/activity/src/contracts.js';
import { artifactIntegrity } from '../../packages/activity/src/identity.js';
import {
  ArtifactError, RAW_TEXT_FACTOR, buildArtifact, conservativeExposures, decodeArtifactInput, restoreClaims, tryBuildArtifact, verifyArtifact, type ArtifactParts, type LearnerFilter,
} from '../../packages/activity/src/artifacts.js';
import { ARTIFACT_DATA_LIMITS } from '../../packages/activity/src/schemas.js';
import {
  backupArtifact, cursor, displayedExposure, predictInstance, quadraticPresentation, quadraticScientific, snapshotArtifact, uncertainExposure,
} from '../../packages/activity/fixtures-src/exemplars.js';

const RUNTIME = { id: 'experiment-kit-activity', version: '0.3.0-preview.1' };
/** The parts the exemplar backup was assembled from. */
const parts = (overrides: Partial<ArtifactParts> = {}): ArtifactParts => ({
  kind: 'backup', artifactId: 'artifact-0001', runtime: RUNTIME, instance: { ...predictInstance, stage: { id: 'explore', enteredAtSequence: 15 }, activityRevision: 4 },
  scientific: quadraticScientific, presentation: quadraticPresentation, exposures: [displayedExposure, uncertainExposure], journal: { cursor, pendingEventIds: ['evt-0041', 'evt-0042'] },
  contentRefs: ['note-derivation', 'note-assumption'], reviewRefs: ['review-model-quadratic-1'], ...overrides,
});
/** Learner projection filter for a stage where the curvature `a` and the trajectory layer are not shown. */
const hideCurvature: LearnerFilter = {
  scientific: snapshot => ({ ...snapshot, params: { eta: snapshot.params.eta!, x0: snapshot.params.x0! }, comparisons: [] }),
  presentation: snapshot => ({ ...snapshot, views: { plot: { camera: snapshot.views.plot!.camera, layers: ['g-landscape'] } }, selection: null, displayUnits: { eta: 'dimensionless' } }),
  contentRefs: ['note-derivation'],
};
const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
const keys = (value: unknown): string[] => Array.isArray(value) ? value.flatMap(keys) : value && typeof value === 'object' ? Object.entries(value).flatMap(([key, item]) => [key, ...keys(item)]) : [];
const resign = (artifact: Omit<ActivityArtifact, 'integrity'>): ActivityArtifact => ({ ...artifact, integrity: artifactIntegrity(artifact) });

describe('backup artifacts (A48)', () => {
  it('builds the backup with an integrity manifest identical to the independently assembled contract exemplar', () => {
    expect(buildArtifact(parts())).toEqual(backupArtifact);
  });

  it('restores exact scientific state, content identity, presentation and journal checkpoint from bytes alone', () => {
    const saved = buildArtifact(parts());
    const bytes = encode(saved);
    // A fresh process has only the bytes.
    const verified = verifyArtifact(bytes);
    expect(verified.ok).toBe(true);
    if (!verified.ok) return;
    expect(verified.artifact).toEqual(saved);
    expect(verified.artifact.scientific).toEqual(quadraticScientific);
    expect(verified.artifact.template).toEqual(predictInstance.template);
    expect(verified.artifact.model).toEqual(predictInstance.model);
    expect(verified.artifact.presentation).toEqual(quadraticPresentation);
    expect(verified.artifact.journal).toEqual({ cursor, pendingEventIds: ['evt-0041', 'evt-0042'] });
    expect(verified.artifact.exposures).toEqual([displayedExposure, uncertainExposure]);
    expect(verifyArtifact(new TextDecoder().decode(bytes)).ok).toBe(true);
    expect(verifyArtifact(JSON.parse(new TextDecoder().decode(bytes))).ok).toBe(true);
  });

  it('records a pending preview separately and never as the saved scientific state', () => {
    const preview = { previewId: 'pv-4', params: { a: 1, eta: 1.9, x0: 8 }, baseRunId: quadraticScientific.runId };
    const artifact = buildArtifact(parts({ preview }));
    expect(artifact.pending).toEqual({ kind: 'preview', ...preview });
    expect(artifact.scientific).toEqual(quadraticScientific);
    expect(artifact.scientific.params.eta).toBe(1.5);
    const tentative = tryBuildArtifact(parts({ preview: { ...preview, baseRunId: 'run-tentative' } }));
    expect(tentative).toMatchObject({ ok: false, diagnostics: [{ code: 'INVALID_INPUT', path: '$.preview.baseRunId' }] });
    expect(buildArtifact(parts({ preview: null })).pending).toEqual({ kind: 'none' });
  });

  it('refuses parts that do not form a valid artifact', () => {
    expect(() => buildArtifact(parts({ artifactId: 'not an id' }))).toThrow(ArtifactError);
    const otherModel = tryBuildArtifact(parts({ scientific: { ...quadraticScientific, model: { ...quadraticScientific.model, version: '9.9.9' } } }));
    expect(otherModel).toMatchObject({ ok: false, diagnostics: [{ code: 'INVALID_REFERENCE', path: '$.scientific.model' }] });
  });
});

describe('learner snapshots exclude hidden and host-only data (A21, §19)', () => {
  it('keeps only projected parameters, layers and content and strips every host-only record', () => {
    const preview = { previewId: 'pv-4', params: { a: 3, eta: 1.9, x0: 8 }, baseRunId: quadraticScientific.runId };
    const snapshot = buildArtifact(parts({ kind: 'learner-snapshot', artifactId: 'artifact-0002', learner: hideCurvature, preview }));
    expect(snapshot.kind).toBe('learner-snapshot');
    expect(snapshot.scientific.params).toEqual({ eta: 1.5, x0: 8 });
    expect(snapshot.scientific.comparisons).toEqual([]);
    expect(snapshot.instance.initialParameters).toEqual({ eta: 0.5, x0: 8 });
    expect(snapshot.pending).toEqual({ kind: 'preview', previewId: 'pv-4', params: { eta: 1.9, x0: 8 }, baseRunId: quadraticScientific.runId });
    expect(snapshot.presentation.views).toEqual({ plot: { camera: quadraticPresentation.views.plot!.camera, layers: ['g-landscape'] } });
    expect(snapshot).toMatchObject({ exposures: [], reviewRefs: [], contentRefs: ['note-derivation'], journal: { cursor: { activityId: cursor.activityId, lastSequence: 40, lastEventId: null, checkpointDigest: null }, pendingEventIds: [] } });
    expect(snapshot.instance).toMatchObject({ objectiveIds: [], responses: [] });
    expect(snapshot.schemas.map(entry => entry.contract)).not.toContain('study-harness.exposure-record');
    const text = JSON.stringify(snapshot);
    for (const hidden of ['"a":', 'review-model-quadratic-1', 'obj-descent-regimes', 'evt-0041', 'rcpt-reveal-1', 'g-trajectory', 'note-assumption', 'm-point', 'run-0001', 'η = 0.5']) expect(text, hidden).not.toContain(hidden);
    for (const artifact of [snapshot, buildArtifact(parts())]) expect(keys(artifact)).not.toContain('document');
    expect(verifyArtifact(encode(snapshot)).ok).toBe(true);
  });

  it('requires a filter and rejects a filter that adds or changes data', () => {
    expect(tryBuildArtifact(parts({ kind: 'learner-snapshot' }))).toMatchObject({ ok: false, diagnostics: [{ code: 'INVALID_INPUT', path: '$.learner' }] });
    const adds: LearnerFilter = { scientific: snapshot => ({ ...snapshot, params: { ...snapshot.params, hidden: 1 } }) };
    expect(tryBuildArtifact(parts({ kind: 'learner-snapshot', learner: adds }))).toMatchObject({ ok: false, diagnostics: [{ path: '$.scientific.params' }] });
    const moves: LearnerFilter = { scientific: snapshot => ({ ...snapshot, runId: 'run-other' }) };
    expect(tryBuildArtifact(parts({ kind: 'learner-snapshot', learner: moves }))).toMatchObject({ ok: false, diagnostics: [{ path: '$.scientific' }] });
    const layers: LearnerFilter = { ...hideCurvature, presentation: snapshot => ({ ...snapshot, views: { plot: { camera: null, layers: ['g-secret'] } } }) };
    expect(tryBuildArtifact(parts({ kind: 'learner-snapshot', learner: layers }))).toMatchObject({ ok: false, diagnostics: [{ path: '$.presentation.views.plot' }] });
    const content: LearnerFilter = { ...hideCurvature, contentRefs: ['note-other'] };
    expect(tryBuildArtifact(parts({ kind: 'learner-snapshot', learner: content }))).toMatchObject({ ok: false, diagnostics: [{ path: '$.learner.contentRefs' }] });
    // The filter receives a copy: mutating it cannot change the caller's snapshot.
    const scientific: ScientificSnapshot = structuredClone(quadraticScientific);
    buildArtifact(parts({ kind: 'learner-snapshot', scientific, learner: { scientific: snapshot => { snapshot.comparisons.length = 0; return snapshot; } } }));
    expect(scientific).toEqual(quadraticScientific);
  });

  it('refuses a learner snapshot that carries host-only records, whoever produced it', () => {
    const { integrity: _integrity, ...body } = snapshotArtifact;
    const forged = resign({ ...body, exposures: [displayedExposure], schemas: [...body.schemas, { contract: 'study-harness.exposure-record', version: '1.0' }], reviewRefs: ['review-model-quadratic-1'] });
    const result = verifyArtifact(forged);
    expect(result).toMatchObject({ ok: false });
    if (!result.ok) expect(result.diagnostics.map(item => item.path)).toEqual(['$.exposures', '$.reviewRefs']);
  });
});

describe('artifact verification: corruption, truncation and missing data (A49)', () => {
  const text = JSON.stringify(backupArtifact);

  it('detects a corrupted field through the recomputed integrity manifest', () => {
    const corrupted = text.replace('"eta":1.5', '"eta":1.6');
    expect(corrupted).not.toBe(text);
    const result = verifyArtifact(corrupted);
    expect(result).toMatchObject({ ok: false, diagnostics: [{ code: 'INTEGRITY_FAILURE', message: 'Field "scientific" does not match its integrity digest.' }] });
    const tamperedDigest = verifyArtifact({ ...backupArtifact, integrity: { ...backupArtifact.integrity, digest: 'sha256:' + '0'.repeat(64) } });
    expect(tamperedDigest).toMatchObject({ ok: false, diagnostics: [{ code: 'INTEGRITY_FAILURE', path: '$.integrity.digest' }] });
  });

  it('reports truncated JSON and invalid bytes as integrity failures without parsing further', () => {
    for (const cut of [text.slice(0, text.length - 1), text.slice(0, Math.floor(text.length / 2)), '']) {
      expect(verifyArtifact(cut)).toMatchObject({ ok: false, diagnostics: [{ code: 'INTEGRITY_FAILURE', path: '$', message: 'The artifact is not complete JSON: it is truncated or corrupted.' }] });
    }
    const bytes = new TextEncoder().encode(text);
    bytes[10] = 0xff;
    expect(verifyArtifact(bytes)).toMatchObject({ ok: false, diagnostics: [{ code: 'INTEGRITY_FAILURE', message: 'The artifact bytes are not valid UTF-8.' }] });
  });

  it('reports missing content referenced by the integrity manifest and other missing fields', () => {
    const { scientific: _scientific, ...withoutScientific } = backupArtifact;
    expect(verifyArtifact(withoutScientific)).toMatchObject({ ok: false, diagnostics: [{ code: 'INTEGRITY_FAILURE', path: '$.scientific', message: 'The content of scientific is missing although the integrity manifest references it.' }] });
    const { pending: _pending, integrity: _integrity, ...rest } = backupArtifact;
    const withoutPending = { ...rest, integrity: { ...backupArtifact.integrity, entries: backupArtifact.integrity.entries.filter(entry => entry.path !== 'pending') } };
    expect(verifyArtifact(withoutPending)).toMatchObject({ ok: false, diagnostics: [{ code: 'SCHEMA', path: '$.pending' }] });
  });

  it('applies size and data limits before traversal', () => {
    const oversized = ' '.repeat(ARTIFACT_DATA_LIMITS.maxBytes * RAW_TEXT_FACTOR + 1);
    expect(verifyArtifact(oversized)).toMatchObject({ ok: false, diagnostics: [{ code: 'RESOURCE_LIMIT', path: '$' }] });
    let deep: unknown = 1;
    for (let level = 0; level < 40; level++) deep = { next: deep };
    expect(verifyArtifact({ ...backupArtifact, contentRefs: deep })).toMatchObject({ ok: false, diagnostics: [{ code: 'RESOURCE_LIMIT' }] });
    const decoded = decodeArtifactInput('﻿' + text);
    expect(decoded.ok).toBe(true);
  });

  it('refuses other contracts, versions and legacy formats without relabelling them', () => {
    expect(verifyArtifact(predictInstance)).toMatchObject({ ok: false, diagnostics: [{ code: 'UNSUPPORTED_ARTIFACT', message: 'The record is a different contract than an activity artifact.' }] });
    expect(verifyArtifact({ ...backupArtifact, schemaVersion: '2.0' })).toMatchObject({ ok: false, diagnostics: [{ code: 'UNSUPPORTED_ARTIFACT', path: '$.schemaVersion' }] });
    const legacy = { format: 'experiment-kit-document', version: '2.0', runtimeVersion: '0.2.0-preview.1', document: {} };
    expect(verifyArtifact(legacy)).toMatchObject({ ok: false, diagnostics: [{ code: 'UNSUPPORTED_ARTIFACT', message: 'The record is a legacy-document-artifact and needs its own reader.' }] });
  });

  it('reports content references that are unavailable offline', () => {
    const result = verifyArtifact(backupArtifact, { content: ref => ref === 'note-derivation' });
    expect(result).toMatchObject({ ok: false, diagnostics: [{ code: 'NOT_FOUND', path: '$.contentRefs[1]' }] });
    expect(verifyArtifact(backupArtifact, { content: () => true }).ok).toBe(true);
  });

  it('accepts the shared contract exemplars', () => {
    for (const artifact of [backupArtifact, snapshotArtifact]) expect(verifyArtifact(artifact).ok).toBe(true);
  });
});

describe('the integrity manifest is canonical in TypeScript and Rust alike (R36, A02)', () => {
  const root = new URL('../../packages/activity/fixtures/integrity/', import.meta.url);
  const files = ['valid', 'invalid'].flatMap(kind => readdirSync(new URL(`${kind}/`, root)).filter(name => name.endsWith('.json')).map(name => `${kind}/${name}`));
  it('ships valid and invalid shared fixtures, including a reordered manifest', () => {
    expect(files).toEqual(expect.arrayContaining(['valid/canonical-order.json', 'invalid/reordered-entries.json', 'invalid/extra-entry.json', 'invalid/missing-entry.json']));
  });
  it.each(files)('%s: verifyArtifact reaches the declared decision for a schema-valid artifact', name => {
    const fixture = JSON.parse(readFileSync(new URL(name, root), 'utf8')) as { contract: string; expect: 'valid' | 'invalid'; value: ActivityArtifact };
    expect(validateRecord(fixture.contract as never, fixture.value).diagnostics).toEqual([]);
    const verified = verifyArtifact(fixture.value);
    expect(verified.ok).toBe(fixture.expect === 'valid');
    // A refused manifest is an integrity failure (a repeated entry path is reported as the duplicate it is).
    if (!verified.ok) for (const item of verified.diagnostics) expect(['INTEGRITY_FAILURE', 'DUPLICATE_ID']).toContain(item.code);
  });
  it('refuses a reordered manifest whose digest was recomputed, which the Rust host also refuses', () => {
    const { integrity, ...body } = structuredClone(backupArtifact);
    const entries = [...integrity.entries].reverse();
    const reordered = { ...body, integrity: { algorithm: 'sha256' as const, entries, digest: `sha256:${sha256(canonicalJSON(entries))}` } };
    const verified = verifyArtifact(reordered);
    expect(verified.ok).toBe(false);
    expect(verified.ok ? [] : verified.diagnostics).toEqual([expect.objectContaining({ code: 'INTEGRITY_FAILURE', path: '$.integrity.entries' })]);
    expect(verifyArtifact(backupArtifact).ok).toBe(true);
  });
});

describe('restore never trusts saved claims (§14)', () => {
  it('lists independence, visibility, approval and exposure claims for re-derivation from host authorities', () => {
    const independent = resign({ ...(({ integrity: _integrity, ...body }) => body)(backupArtifact), instance: { ...backupArtifact.instance, context: { kind: 'independent', taskRef: 'task-quiz' }, mode: 'approved' } });
    const claims = restoreClaims(independent);
    const byPath = Object.fromEntries(claims.map(claim => [claim.path, claim]));
    expect(byPath['$.instance.context']).toMatchObject({ saved: { kind: 'independent', taskRef: 'task-quiz' }, rederiveFrom: 'host-policy' });
    expect(byPath['$.instance.mode']).toMatchObject({ saved: 'approved', rederiveFrom: 'host-policy' });
    expect(byPath['$.presentation.views']).toMatchObject({ saved: { plot: ['g-landscape', 'g-trajectory'], values: [] }, rederiveFrom: 'host-policy' });
    expect(byPath['$.reviewRefs']).toMatchObject({ rederiveFrom: 'review-registry' });
    expect(byPath['$.exposures']).toMatchObject({ rederiveFrom: 'host-exposures' });
    expect(byPath['$.model']).toMatchObject({ rederiveFrom: 'catalog' });
    // Stage, revision, closure and lineage come from the host's activity state (R01), never from the artifact.
    expect(byPath['$.instance.closed']).toMatchObject({ saved: false, rederiveFrom: 'host-activity' });
    expect(byPath['$.instance.stage']).toMatchObject({ rederiveFrom: 'host-activity' });
    const withLineage = resign({ ...(({ integrity: _integrity, ...body }) => body)(backupArtifact), lineage: { endedExposureIds: [], reopenRequired: true } });
    expect(restoreClaims(withLineage).find(claim => claim.path === '$.lineage')).toMatchObject({ rederiveFrom: 'host-activity', reason: expect.stringMatching(/absence is not trusted/) });
    expect(byPath['$.kind']).toBeUndefined();
    const learnerClaims = restoreClaims(snapshotArtifact).map(claim => claim.path);
    expect(learnerClaims).toContain('$.kind');
    expect(learnerClaims).toContain('$.migratedFrom');
    expect(learnerClaims).not.toContain('$.exposures');
  });

  it('restores exposures conservatively: authorized without acknowledgement becomes uncertain, displayed never reverts', () => {
    const authorized = { ...displayedExposure, exposureId: 'exp-9', displayStatus: 'authorized' as const, displayed: undefined };
    delete authorized.displayed;
    const restored = conservativeExposures([displayedExposure, authorized, uncertainExposure]);
    expect(restored[0]).toEqual(displayedExposure);
    expect(restored[1]).toMatchObject({ exposureId: 'exp-9', displayStatus: 'uncertain', uncertainty: { code: 'INTERRUPTED_BEFORE_ACK' } });
    expect(restored[2]).toEqual(uncertainExposure);
  });
});
