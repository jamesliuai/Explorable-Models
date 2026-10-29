/**
 * Shared artifact integrity-manifest fixtures (report §5.1 "run shared valid/invalid fixtures through both", A02). Every
 * value is a schema-valid `study-harness.activity-artifact`; the declared expectation is the integrity decision: the
 * manifest is canonical exactly as `artifactIntegrity` computes it — one entry per present top-level field, in
 * `INTEGRITY_FIELDS` order, each the sha256 of the field's canonical JSON, and `digest` the sha256 of the entries. The
 * TypeScript verifier (`verifyArtifact`) and the Rust reference host (`verify_integrity`) must both reach the declared
 * decision for every file. Expectations and reasons are declared here by hand, independently of either verifier.
 */
import { canonicalJSON, sha256 } from '@experiment-kit/core';
import type { ActivityArtifact, IntegrityEntry } from '../src/contracts.js';
import { CONTRACTS } from '../src/contracts.js';
import type { ContractFixture, FixtureFile } from './cases.js';
import { backupArtifact, lineageBackupArtifact } from './exemplars.js';

const hash = (value: unknown): string => 'sha256:' + sha256(canonicalJSON(value));
/** The artifact with its manifest entries replaced and the manifest digest recomputed over them (as a forger would). */
function withEntries(artifact: ActivityArtifact, entries: (current: IntegrityEntry[]) => IntegrityEntry[]): ActivityArtifact {
  const next = entries(structuredClone(artifact.integrity.entries));
  return { ...structuredClone(artifact), integrity: { algorithm: 'sha256', entries: next, digest: hash(next) } };
}
const fixture = (expect: ContractFixture['expect'], why: string, value: ActivityArtifact): ContractFixture => ({ contract: CONTRACTS.artifact, expect, why, value });

/** Integrity fixtures, written to `packages/activity/fixtures/integrity/<valid|invalid>/<case>.json`. */
export function buildIntegrityFixtures(): FixtureFile[] {
  const cases: [string, ContractFixture][] = [
    ['valid/canonical-order', fixture('valid', 'The manifest artifactIntegrity computes: every present field, in INTEGRITY_FIELDS order.', backupArtifact)],
    ['valid/canonical-order-with-lineage', fixture('valid', 'Fields added later (assistance, lineage) are appended in INTEGRITY_FIELDS order.', lineageBackupArtifact)],
    ['invalid/reordered-entries', fixture('invalid', 'The same entries in reverse order, with the manifest digest recomputed: the order is part of the canonical manifest.',
      withEntries(backupArtifact, entries => entries.reverse()))],
    ['invalid/swapped-adjacent-entries', fixture('invalid', 'Two adjacent entries swapped, with the manifest digest recomputed.',
      withEntries(backupArtifact, entries => [entries[1]!, entries[0]!, ...entries.slice(2)]))],
    ['invalid/extra-entry', fixture('invalid', 'An entry for a field the artifact does not have (migratedFrom), with the manifest digest recomputed.',
      withEntries(backupArtifact, entries => [...entries, { path: 'migratedFrom', digest: hash({ contract: CONTRACTS.artifact, version: '0.9' }) }]))],
    ['invalid/duplicate-entry', fixture('invalid', 'The first entry listed twice, with the manifest digest recomputed.',
      withEntries(backupArtifact, entries => [entries[0]!, ...entries]))],
    ['invalid/missing-entry', fixture('invalid', 'The lineage field is present but its entry is dropped, with the manifest digest recomputed.',
      withEntries(lineageBackupArtifact, entries => entries.filter(entry => entry.path !== 'lineage')))],
    ['invalid/stale-entry-digest', fixture('invalid', 'One entry digest no longer matches its field, with the manifest digest recomputed.',
      withEntries(backupArtifact, entries => entries.map(entry => entry.path === 'scientific' ? { ...entry, digest: hash({ tampered: true }) } : entry)))],
    ['invalid/stale-manifest-digest', fixture('invalid', 'Canonical entries but a manifest digest over other entries.',
      { ...structuredClone(backupArtifact), integrity: { ...structuredClone(backupArtifact.integrity), digest: hash([]) } })],
  ];
  return cases.map(([path, value]) => ({ path: `${path}.json`, fixture: value }));
}
