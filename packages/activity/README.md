# @experiment-kit/activity

Versioned contracts for the Study Harness visualization subsystem: activity templates, instances, host policy,
snapshots, interaction events, exposure records, summaries, artifacts, review records, host receipts and host-port
messages (schema `1.0`). The package is DOM-free and provider-neutral. It imports `@experiment-kit/core` only, and
never imports the catalogue, the player, a native bridge or a provider SDK.

Status: developer preview (`0.3.0-preview.1`, unreleased). Passing schema or semantic validation shows that a record is
well formed and internally consistent. It is not scientific review, accessibility certification or evidence of
learning benefit.

The package also contains the activity adapter: `createStudyHarnessAdapter({ catalog, host })`. `host` is the
`HostPort` the host implements over its authoritative store. The adapter covers the six report operations, the
privileged `HostActivityControl` and fixed-actor `ActivityBinding`s, the learner projection, persist-before-reveal,
the journal outbox, summaries, artifacts and migrations. A `HostPort` method that decides against a request rejects with
a refusal code (`HOST_REFUSAL_CODES`; build one with `hostRefusal`, recognise one with `isHostRefusal`): the adapter
reports that code without retrying; any other rejection is a retryable `PERSISTENCE_FAILED`. The bounded hostile-TeX
screen shared by the learner surface and the agent tools is `FORBIDDEN_TEX_COMMANDS` / `checkTexSource`. See
[activity runtime](../../docs/study-harness/activity-runtime.md), the [embedding guide](../../docs/embedding.md#study-harness-learner-surface)
and [compatibility and rollback](../../docs/study-harness/compatibility.md).

## Contracts

| Name | Type (`src/contracts.ts`) |
| --- | --- |
| `study-harness.activity-template` | `ActivityTemplate` |
| `study-harness.activity-instance` | `ActivityInstance` |
| `study-harness.host-policy` | `HostPolicy` |
| `study-harness.scientific-snapshot` / `.presentation-snapshot` | `ScientificSnapshot` / `PresentationSnapshot` |
| `study-harness.interaction-event` | `InteractionEvent` (one schema variant per event type, each with its own payload) |
| `study-harness.exposure-record`, `.interaction-summary`, `.activity-artifact`, `.review-record` | matching interfaces |
| `study-harness.exposure-receipt`, `.stage-receipt`, `.assistance-receipt` | host receipts |
| `study-harness.*-request`, `.append-result`, `.journal-cursor`, `.host-ack`, `.activity-records` | `HostPort` messages (`MESSAGES` in `src/schemas.ts`; `.activity-records` is the reply of the optional `getActivityRecords`) |
| `experiment-kit.model-manifest` | `ModelManifest` (schema owned by `@experiment-kit/core/model`) |

## Schema files

`src/schemas.ts` is the authoritative source. It uses the bounded JSON Schema 2020-12 subset from
`@experiment-kit/core/model`. `node scripts/study-harness/generate-contracts.mjs` writes:

- `schema/<name>.schema.json`: one standalone document per contract, with only the `$defs` it references.
- `schema/index.json`: the file list, the sha256 of each file, the canonical digests, and the data limits of each contract.
- `schema/frozen-1.0.json`: the digest lock for version 1.0. It also records the immutable schema 2.0 document schema.
  The generator writes it only when it is missing. Do not change a 1.0 schema: publish a new version and keep a reader
  for 1.0.
- `fixtures/contracts/<valid|invalid>/<short-name>/<case>.json`: the shared fixtures. Each file has the form
  `{ contract, expect, why, value }`. They are generated from typed exemplars and hand-declared mutations in
  `fixtures-src/`.

`--check` verifies all of these files without writing them.

Every object rejects unknown fields, and every string, array, map and number has a bound. String lengths are counted
in Unicode code points. Patterns are ASCII-only. The main limits are in `LIMITS`: IDs 128, labels 200, learner text
4000, TeX 4096, 64 groups, 16 views, 256 marks per view, 16 stages, 32 transitions, 64 scenarios and 64 parameters.
The summary bounds come from `SUMMARY_LIMITS`. Model-derived bounds follow the manifest contract
(`MANIFEST_LIMITS` in `@experiment-kit/core/model`): quantity values in events and summaries may be any finite double
(only values beyond the double range are numerical-limit statuses) with up to 4096 numbers, and positions and
`lastFiniteIndex` go up to index 10,000,000, the largest manifest `maxIndex`.

## Validation

```ts
import { validateRecord, validateTemplateSemantics, readRecord, CONTRACTS } from '@experiment-kit/activity';

const shape = validateRecord(CONTRACTS.template, input);            // data limits, then schema
const meaning = validateTemplateSemantics(template, manifest);      // cross-references, units, disclosure
const read = readRecord(CONTRACTS.artifact, stored);                // classify by declared version, then validate
```

- `validateRecord` applies data limits before it walks the schema: 4 MiB for artifacts, 512 KiB for other records,
  1 MiB for model manifests, 8 KiB for each event payload, nesting depth 32, and node counts. It also rejects
  accessors, cycles, class instances, non-finite numbers and `__proto__`/`prototype`/`constructor` keys.
  Diagnostic messages are fixed text, and paths keep identifier-shaped keys only, so input values are never echoed.
- `validateTemplateSemantics`, `validatePolicySemantics`, `validateInstanceSemantics` and `validateArtifactSemantics`
  return stable codes: `INVALID_REFERENCE`, `KIND_MISMATCH`, `UNIT_MISMATCH`, `DUPLICATE_ID`, `EQUATION_DISCLOSURE`,
  `MISSING_EQUIVALENT`, `OUT_OF_DOMAIN`, `CONSTRAINT_VIOLATION`, `INTEGRITY_FAILURE` and `STALE_ACTIVITY_REVISION`.
  A template's model reference must carry the exact digest of the manifest it is checked against. Authored scenario
  values are checked with core's admissibility and coupled-constraint rules, the same rules every runtime entry point
  applies.
- `templateWarnings(template, manifest)` returns authoring warnings for a template that passes
  `validateTemplateSemantics`: `NEVER_VISIBLE` (views, groups, marks, equations, controls and view quantities no stage
  can show under the projection's visibility rules, even with every group granted) and `UNREFERENCED` (empty groups,
  equations no equation view lists, controls no stage lists, quantity and dataset members nothing shows). They are
  warnings: the adapter does not run them and they never block preparation (docs/study-harness/authoring.md §7).
- `fromModelDiagnostics` maps model-layer diagnostics to this vocabulary. Core's `WORKER_PROTOCOL` becomes
  `WORKER_ERROR`; a compile-time check fails if core gains any other code this vocabulary lacks.
- `classifyRecord` / `readRecord` find Study Harness records, schema 2.0 document artifacts, schema 2.0 documents, and
  schema 1.0 bundles and snapshots. Legacy formats are never relabelled. An unknown or future version is rejected
  with `UNSUPPORTED_ARTIFACT` and a recovery route: keep the original bytes and open the record with the runtime that
  produced it, or show an archival read-only view.
- Identities: `templateDigest`, `templateRef`, `groupContentDigest` (the content of each exposure group, including all
  learner and accessible text), `artifactIntegrity` and `schemaDigest`.

## HostPort conformance kit (`@experiment-kit/activity/conformance`)

A separate entry for hosts and their test harnesses (the adapter and the learner surface never import it): the
host-agnostic conformance kit for external gate G2 (requirement A54 preparation). It is plain TypeScript with no Node,
DOM or native imports, so the same kit runs in Node, a browser and a packaged WebView.

```ts
import { runHostPortConformance } from '@experiment-kit/activity/conformance';

const run = await runHostPortConformance(hostPort, {
  subject: 'actual-host',                 // or 'reference-fixture-host' / 'memory-fixture-host'; always the caller's label
  host: { name, commit, dirty, binarySha256, platform: { os, osVersion, arch } },
  packages,                               // the packed @experiment-kit/* tarballs (name, version, sha256)
  catalog,                                // the installed catalogue the host serves
  hooks: { openActivity, restart, respond, hostSessionRevision, authorizeReveal, startIndependentTask, armCrash },
});
// run.result: study-harness.host-conformance-result/1 (docs/study-harness/templates/host-conformance-result.schema.json)
// run.checks: every assertion with its step and failure detail; run.problems: schema problems of run.result (empty)
```

It drives the G2 sequence (open the quadratic activity, prediction reference, authorize and reveal, commit an
exploration, camera change, save, terminate, reopen and verify, independent task, and the three interruption points)
through the real adapter and checks the HostPort semantics a host must honour at each step: idempotency by operation ID
and request fingerprint, receipts that echo their request, the refusal convention (codes recognised, never retried),
durable-before-return across the `restart` hook (a fresh `HostPort` over the same durable store), authorization kept
apart from display acknowledgement, duplicate-eventId deduplication and gap refusal, the host-owned session revision,
exposure/assistance read-back after a restart, artifact save idempotency and conflict, and conservative records after
each interruption. It also checks the host-owned activity state of `getActivityRecords` (`ActivityRecords.activity`):
the stage and activity revision a receipt produced and the stage receipt that moved the activity (also after later
receipts), the context lineage (instructional for the activity, independent for a task from the revision after its
activation), a registration that claims another stage, revision, closure or context and leaves that state unchanged, a
backup whose grant names a receipt the host never issued (stored through `saveArtifact` with a recomputed manifest)
that the host's records do not confirm, and an earlier checkpoint that adopts the host's stage and revision, counts the
grant the host holds identically and continues with a host-authorized step. The kit acts as the learner surface (it
acknowledges the projections it is given); rendering is not part of it. A step or assertion the supplied hooks or host
reads cannot exercise is `not-run` with the reason, never passed. Only `openActivity` is required. Tests:
`tests/activity/host-conformance.test.ts` (the memory host, sabotaged variants that each fail the assertion checking the
violated semantics, and a host that omits its activity state, whose host-read assertions are not run).

## Rust crate

`rust/` (`study-harness-contracts`) embeds the same schema files with `include_str!`. It validates them with the
`jsonschema` crate: draft 2020-12, no format assertions, and the linear-time `regex` engine. It mirrors the
TypeScript data limits exactly.

```sh
cargo test --manifest-path packages/activity/rust/Cargo.toml
cargo run --quiet --manifest-path packages/activity/rust/Cargo.toml --bin validate-fixtures   # [{file, contract, expect, valid}]
```

`tests/activity/rust-agreement.test.ts` requires that both validators reach the declared decision for every fixture.
If `cargo` is missing, that test fails; a missing toolchain is never treated as a pass.
