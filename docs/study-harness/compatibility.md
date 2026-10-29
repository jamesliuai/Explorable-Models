# Compatibility, migration and rollback

Report §14 and A04/A49/A60. This page is the compatibility matrix for every record format the toolkit reads or
writes, what each component version reads and writes, how to migrate, what is supported, and how to roll back. The
code-level registry is `COMPATIBILITY`, `LEGACY_FORMATS` and `CONTRACT_VERSIONS` in
`packages/activity/src/versions.ts`; this page and that registry must agree.

## 1 Version identities in this release

| Component | Identity in this release | Where it is recorded |
| --- | --- | --- |
| npm packages (`@explorable-models/core`, `activity`, `catalog`, `player`, `player-3d`, `agent`) | `0.3.0-preview.1` (preview tag) | `package.json`; not recorded in artifacts |
| Activity adapter | `ADAPTER_VERSION` `0.3.0-preview.1` | `getCapabilities().adapterVersion` |
| Study Harness contracts (`study-harness.*`) | schema `1.0`, frozen by the digest lock `packages/activity/schema/frozen-1.0.json` | `schemaVersion` of every record; `schemas[]` of artifacts |
| Model manifest | `explorable-models.model-manifest` `1.0`; identity = `digest` (exact bytes) + `scientificRevision` + `presentationRevision` | `ModelRef` in templates, instances, artifacts, receipts |
| Activity template | `templateId@version` + content `digest`; per-group content digests | `TemplateRef`; exposure grants carry group digests |
| Model runtime | `explorable-models.model-runtime` `1.0.0` (`MODEL_RUNTIME`) | `runtime` of artifacts and scientific snapshots |
| Model worker protocol | `explorable-models.model-worker/1.0` (main thread ↔ catalogue worker; ship together) | not persisted |
| Schema 2.0 documents | `schemaVersion: '2.0'`; document runtime `0.2.0-preview.1` (`DOCUMENT_RUNTIME_VERSION`) | `runtimeVersion` of `explorable-models-document` artifacts |
| Schema 1.0 experiments | `schemaVersion: '1.0'`; runtime `0.1.0` (`RUNTIME_VERSION`) | `runtimeVersion` of 1.0 snapshots |

Artifacts carry contract versions and exact content identities, never package versions: compatibility is decided by
the record's declared contract/version and by the exact template/model digests, not by which package wrote it.

## 2 Compatibility matrix by artifact format and version

Every input is first classified by its own declared identity (`classifyRecord`), before validation. Nothing is
relabelled: a record is either read as what it declares, migrated by an explicit registered step, routed to its
retained runtime, or refused with a recovery path.

| Record (declared format / version) | Reader | Read | Restore | Rejection and recovery | Evidence |
| --- | --- | --- | --- | --- | --- |
| `study-harness.activity-artifact` 1.0, `kind: backup` | `migrateArtifact` → `verifyArtifact` → `adapter.restore` | yes | Yes, paused. `exact`, or `restricted` when the current policy shows less or the migration changed meaning, or `read-only` when it was closed. Exact template/model digests must be installed and not revoked; the saved position is re-evaluated in the worker and must reproduce. Exposures restore conservatively (authorized without acknowledgement → `uncertain`); context, approval and visibility come from the current host policy, and stage, activity revision, closure and which saved grants count from the host's records (`ActivityRecords`, including the host's context lineage), never from the artifact (`restoreClaims`); without the host's records saved grants do not count. A host that does not report its activity state reopens only the backup it holds as its latest checkpoint (`restricted`); a host that does not hold the activity at all refuses the restore. | `INTEGRITY_FAILURE` (corrupted, truncated or missing content): keep the original bytes, restore from another copy or a portable host backup. `UNSUPPORTED_ARTIFACT` (template or model not installed, different digest, saved state not reproducible, or a stage and revision the host can neither report nor confirm as its latest checkpoint): archival read-only view with `archivalView(artifact, { audience })`; nothing is evaluated or substituted. `CONTENT_REVOKED`: the same archival view. `POLICY_DENIED` / `POLICY_EXPIRED`: host decision. | `tests/activity/restore.test.ts`, `host-authority.test.ts`, `artifacts.test.ts`, `host-failures.test.ts`, `portable-backup.test.ts` |
| `study-harness.activity-artifact` 1.0, `kind: learner-snapshot` | `verifyArtifact` | yes (projection-filtered record) | No | `UNSUPPORTED_ARTIFACT` on restore: show it with `archivalView(artifact, { audience })` (the learner audience lists the values the snapshot recorded as visible). A snapshot that carries host-only records is refused. | `tests/activity/artifacts.test.ts`, `restore.test.ts` |
| `study-harness.activity-artifact` **0.9** (pre-release draft, never shipped as supported) | `migrateArtifact` with `DRAFT_0_9_TO_1_0` | via migration | Yes after migration: format-only (`semanticsChanged: false`) → `exact` when catalogue and policy allow. New `artifactId` `migrated-<24 hex of original digest>`; `migratedFrom` keeps contract, version, original digest and the change report. A preview active when a draft was saved was never recorded and cannot be recovered; the draft had no assistance list, so the restore notes that earlier assistance is known only from the host journal. | Corrupted, truncated (`draft-0.9-truncated.partial`) or missing content → `INTEGRITY_FAILURE` before any conversion; a failing or partial step → `UNSUPPORTED_ARTIFACT`, original unchanged. | `packages/activity/fixtures/migrations/`, `tests/activity/migrations.test.ts`, `host-failures.test.ts` |
| `study-harness.activity-artifact` other versions (for example `future-2.0.json`) | `classifyRecord` | no | No | `UNSUPPORTED_ARTIFACT`: keep the original bytes; open with the runtime that produced it; convert only with an explicit, registered migration. `archivalView` reads only artifacts this release verifies, so it refuses this record rather than interpret it. | `migrations.test.ts`, `versions.test.ts` |
| Other `study-harness.*` 1.0 records (instance, policy, event, exposure record, receipts, summary, template, review record, host messages) | `readRecord` / `validateRecord`, semantic validators | yes | n/a (host records) | Other versions: `UNSUPPORTED_ARTIFACT`; unknown fields or bounds: `SCHEMA`. TypeScript and Rust (`packages/activity/rust`) validate the same JSON Schemas. | `tests/activity/contracts*.test.ts`, `versions.test.ts`, `rust-agreement.test.ts` |
| `explorable-models.model-manifest` 1.0 | `validateManifest` | yes | Restore requires the identical `digest`; a meaning change (units, sign convention, assumption, declared `evaluation` behaviour) is a new `scientificRevision`, hence a new model identity and new run; approvals do not transfer. The optional `evaluation` field (determinism, checkpoint) is additive in 1.0. A `document` execution is read only where `enableDocumentExecution()` has run. | Other versions or invalid manifests: refused; no similar model is substituted. A `document` execution without the opt-in: `UNSUPPORTED_CAPABILITY`. | `tests/core/model-*.test.ts`, `tests/core/document-execution.test.ts`, `tests/catalog/` |
| `study-harness.capability-record` 1.0 (additive in 1.0) | `validateRecord`; `capabilityRecord(ref)` | yes (discovery data) | n/a | A record claiming a limit above the runtime's, an unknown capability or another version is invalid; a template requiring one is refused (`UNSUPPORTED_CAPABILITY`). | `tests/activity/capabilities.test.ts`, shared fixtures `capability/` |
| `explorable-models-document` 2.0 (`DocumentArtifact`) with `runtimeVersion` `0.2.0-preview.1` | core `VisualizationSession.restoreDocument`; `migrateArtifact` routes it (`kind: 'legacy'`, `route: 'document-session'`) | yes | Yes in a document session at the exact recorded runtime version; never converted into an activity artifact. | Another `runtimeVersion`: `INCOMPATIBLE_ARTIFACT` from the session; recovery: the original runtime (it is not an activity artifact, so `archivalView` does not read it; keep the original bytes). | `fixtures/migrations/legacy-document-2.0.json`, `migrations.test.ts` |
| Schema 2.0 `VisualizationDocument` | core `normalizeDocument` | yes | Opened in a document session, `createDocumentInteractionController`, or as a model `document` execution kind; it carries no activity state. | Invalid documents: diagnostics from validation; never turned into an activity record. | `tests/core/declarative.test.ts`, `session-v2.test.ts`, `interaction.test.ts` |
| Schema 1.0 experiment snapshot (runtime `0.1.0`) | core `validateSnapshot` (`route: 'source-runtime'`) | yes | Only against its exact `definitionRevision` with the 1.0 runtime. | Other definition revision or runtime: refused by the 1.0 runtime; keep the original bytes (`archivalView` reads activity artifacts only). | `fixtures/migrations/legacy-snapshot-1.0.json`, `migrations.test.ts` |
| Schema 1.0 `bundle-manifest.json` / `source-manifest.json` | exported playback bundle | yes | Played independently as exported. | Not an activity artifact; never converted. | `versions.test.ts` |
| Portable host backup bundle | host-owned format | — | The host imports it into an empty store, then restores the checkpoint artifact. | Missing or altered file, content whose digest differs, journal that does not reach the checkpoint: refused before anything is imported. | Reference requirements in §5; test fixture format in `tests/activity/support/portable-backup.ts` |

## 3 What each component version reads and writes

| Component | Writes | Reads | Change rule |
| --- | --- | --- | --- |
| Study Harness contracts 1.0 | 1.0 only | 1.0; artifact 0.9 through the registered migration | 1.0 schemas never change (digest lock checked by `npm run test:contracts`). A change is a new schema version with its own lock, a reader for 1.0 and, for artifacts, a registered migration with fixtures. Before the 1.0 release the lock was amended deliberately twice (`preReleaseAmendments` in `frozen-1.0.json`, each listing the previous digests). The first added optional fields only (`MarkSpec.extent`, `ActivityArtifact.assistance`). The second, for the audit fixes, added optional fields to events, exposure records, artifacts, summaries, templates and model manifests, added the `activity-records` and `capability-record` schemas, and made one tightening: the seven event types that used the open generic payload now have closed payloads, so an event of those types with fields the adapter never emits is rejected. Records written by the adapter stay valid. |
| Model manifest 1.0 | — (catalogue content) | 1.0 | Presentation-only metadata changes keep `scientificRevision`; any change of meaning creates a new identity. Presentation is the exact spelling of the title and labels and UI step increments only ("label spelling and display precision", report §8.3); the summary, parameter descriptions and symbols, quantity symbols, geometry and dataset descriptions, constraint messages and the wording of the title and of every label (`labelWording`: everything except white space, quotation-mark style, Unicode composition and compound hyphenation) are explanatory content bound to `scientificRevision`, so a model review does not survive them (pre-release amendment of 2026-10-26). The optional geometry `coordinates` (canonical unit of each coordinate) is additive and identity-bound. |
| Templates | — (catalogue content) | exact `templateId@version` + digest | Any content change (including accessible text) changes the digest and needs new host authorization; earlier approvals and exposure grants name the old digests. |
| Model runtime 1.0.0 | `runtime` in artifacts | artifacts of any runtime, re-evaluated | Restore re-evaluates the saved position with the installed kernel and refuses if it does not reproduce the saved position and terminal state. |
| Document runtime 0.2.0-preview.1 | `explorable-models-document` 2.0 | exactly `0.2.0-preview.1` | A new document runtime version must keep a reader or route older artifacts to a retained runtime. |
| Legacy runtime 0.1.0 | schema 1.0 exports | schema 1.0 | Unchanged; kept for existing exports. |
| Packages 0.3.0-preview.1 | — | — | Preview releases make no semver promise between previews; record compatibility is governed by the rows above. |

## 4 Migration examples

The fixtures in `packages/activity/fixtures/migrations/` (see their `README.md`) are the worked examples; the tests
regenerate and compare them byte for byte.

```ts
import { migrateArtifact } from '@explorable-models/activity';

// Pass the stored bytes, so the original digest covers exactly what the host stored.
const outcome = migrateArtifact(bytes); // bytes: Uint8Array of draft-0.9-artifact.json
if (outcome.ok) {
  outcome.migrated;              // true
  outcome.artifact.artifactId;   // 'migrated-' + first 24 hex digits of the original digest
  outcome.artifact.migratedFrom; // { contract, version: '0.9', digest: <sha256 of the original bytes>, report: [...] }
  outcome.report;                // 'Format: the draft field "reveals" is now "exposures"; …', 'Semantics: … unchanged …'
  // Store the migrated artifact as a new record; keep the original bytes. Equivalence with the installed model is
  // established only at restore, by the exact model digest.
} else if (outcome.kind === 'legacy') {
  outcome.route;                 // 'document-session' or 'source-runtime': open with the retained runtime
} else {
  outcome.diagnostics;           // INTEGRITY_FAILURE / UNSUPPORTED_ARTIFACT with a recovery that keeps the original
}
```

| Input fixture | Outcome |
| --- | --- |
| `draft-0.9-artifact.json` | migrates to exactly `draft-0.9-migrated-1.0.json` |
| `draft-0.9-corrupted.json` | `INTEGRITY_FAILURE` at `$.scientific` |
| `draft-0.9-truncated.partial` | `INTEGRITY_FAILURE` (not complete JSON) |
| `draft-0.9-missing-blob.json` | `INTEGRITY_FAILURE` (content referenced by the integrity manifest is missing) |
| `future-2.0.json` | `UNSUPPORTED_ARTIFACT`, original kept |
| `legacy-document-2.0.json` | routed to the document session, never converted |
| `legacy-snapshot-1.0.json` | routed to the schema 1.0 runtime, never converted |

`adapter.restore()` runs the same migration first, so a host can pass stored bytes directly; the restore report lists
the migration notes and `artifact.restored` records `migratedFrom` (`tests/activity/host-failures.test.ts`). A failing
step anywhere in a chain leaves no partial result (`createMigrationRegistry` + `migrateArtifact` with a custom registry
in the same test).

## 5 Support policy

- **Readable for as long as hosts may hold them**: activity artifacts 1.0, `study-harness.*` 1.0 records, model
  manifests 1.0, document artifacts 2.0 (exact runtime), schema 1.0 exports. Dropping a reader requires a documented
  replacement path (migration or retained runtime) and a release note.
- **Explicit migrations only**: a migration is a registered, versioned, deterministic step with fixtures; it never
  modifies the original, retains the original digest, assigns a new identity and reports every change. Format
  migration is separate from scientific equivalence; a step that changes meaning makes the restore `restricted`.
- **No substitution**: a missing or different template/model is refused with a readable unsupported state and a
  read-only recovery (`archivalView(artifact, { audience })`, which never evaluates or substitutes a model); revoked
  content is never reopened silently.
- **Host-owned durability**: the host owns the transactional store, content-addressed blobs and backups. The toolkit
  supplies schemas, validation, migrations and conformance fixtures; it keeps no authoritative store in browser storage.
- **Portable host backups** must contain, for each activity: the journal records through the backup checkpoint, the
  host exposure, receipt, idempotency and display-acknowledgement records those records reference, every artifact of
  the activity, and every referenced immutable content blob (exact template and model by digest), listed in a
  manifest with a digest per file. Records are keyed by their own identity (eventId, exposureId, receiptId,
  idempotency key, artifactId) so a re-import adds nothing. `tests/activity/portable-backup.test.ts` restores such a
  bundle into an empty store in a fresh Node process with networking disabled and the original files deleted.
- **Status vocabulary**: compatibility here is engineering compatibility. It is not scientific review, accessibility
  certification or evidence of learning benefit.

## 6 Rollback procedure

1. **Before upgrading**: let every open activity reach `persistence: 'saved'` (`retryPersistence`, `reconcile()`), save
   a `backup` artifact per activity, and take a portable host backup (§5). Record the installed package versions and
   `packages/activity/schema/index.json` / `frozen-1.0.json` digests.
2. **Upgrade** from packed tarballs with the lockfile; run `npm run test:contracts` (schema digest lock and TS/Rust
   agreement) and the restore conformance tests against a copy of the backup.
3. **If the upgrade must be rolled back**: stop preparing new activities; reinstall the previous exact package versions
   from the lockfile; restore the pre-upgrade host backup into the host store (import is idempotent by record identity).
4. **Artifacts written after the upgrade**: if they use the same contract version (1.0), the previous release reads
   them (the schemas are frozen). If they use a newer contract version, the previous release refuses them with
   `UNSUPPORTED_ARTIFACT`; keep the bytes and reopen them after re-upgrading. A migrated artifact keeps the original
   bytes' digest in `migratedFrom`, so the original can be reopened by the release that wrote it.
5. **Catalogue changes**: if the rolled-back catalogue lacks the exact template or model version an artifact names, the
   restore is refused (no substitution); reinstall that exact version or show the artifact with `archivalView`.
6. Never edit an artifact by hand to make it pass verification; integrity digests and the host journal are the
   evidence trail.
