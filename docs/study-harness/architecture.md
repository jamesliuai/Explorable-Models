# Study Harness visualization subsystem: architecture and decisions

Status: engineering contract for work packages W01–W14 of
[the implementation report](../study-harness-visualizer-implementation-report.md). The report remains the
specification; this document records how this repository implements it and the consequential decisions taken.
The [requirement ledger](requirement-ledger.md) tracks A01–A60.

## 1 Layers and packages

```mermaid
flowchart TD
  Host[Study Harness host or reference host] -->|HostPort: policy, receipts, journal, artifacts| Adapter
  Catalog[@explorable-models/catalog: installed manifests, templates, kernels, review registry] --> Adapter
  Adapter[@explorable-models/activity: contracts, reducer, projection, exposure, journal, summaries] --> Session
  Session[@explorable-models/core/model: guarded model session, units, constraints, sampling] --> Worker
  Worker[Catalog kernel worker: installed pure kernels, each loaded on first use] --> Frame[Identified ModelFrame]
  Frame --> Projection[LearnerProjection: only authorized groups]
  Projection --> Surface[@explorable-models/player/activity: StudyActivitySurface]
  Surface -.lazy, only for 3D templates.-> Spatial[@explorable-models/player-3d]
  Surface -->|intents, display acknowledgements| Adapter
  Tools[@explorable-models/agent activity tools] -->|bound host context| Adapter
  CLI[@explorable-models/cli activity commands] -->|browser worker only| Worker
```

| Package / entry | Responsibility | Must not depend on / do |
| --- | --- | --- |
| `@explorable-models/core` (`/model`) | Model manifest contract, units, constraints, numerical statuses, `ModelFrame`, worker evaluator, guarded `ModelSession`, preview coordinator, worker budget, isolated sampling | React, DOM rendering, tutor policy, Tauri, filesystem, provider SDKs |
| `@explorable-models/activity` | Versioned activity JSON schemas (authoritative), validator, activity reducer, projection policy, exposure protocol, journal/outbox, deterministic summaries, artifacts/migrations, `HostPort` interface, `createStudyHarnessAdapter` | React, provider SDKs, Tauri/native bridge, mastery or grading decisions, implicit durable storage |
| `@explorable-models/catalog` | Installed model manifests, activity templates, pure kernels, kernel worker entry, constraint data, sources, learner copy, review registry, revocation list | Agent-selected URLs/paths, self-issued review approval |
| `@explorable-models/player` (`.`) | Legacy generic schema 2.0 surface (unchanged budget) | — |
| `@explorable-models/player/activity` | `StudyActivitySurface`, `mountStudyActivity`, controls, math, 2D primitives, accessible equivalents, presentation state, SVG/PNG capture, `createStudyHarnessVisualizer` (six operations) | Studio/authoring compiler, Three.js (eager), Playwright, CLI |
| `@explorable-models/player-3d` | Lazy bounded spatial renderer (Three.js) | Imported eagerly by any 2D path |
| `@explorable-models/agent` | Existing document tools + policy-scoped activity tools and host relay ([agent-tools.md](agent-tools.md)) | Caller-selected principals, review elevation |
| `@explorable-models/cli` | Authoring: scaffold, validate, worker-backed check/reference/boundaries, stage capture, review packet, package ([authoring.md](authoring.md), [review packets](review-packets/README.md)) | Importing authored model/check code into Node |
| `examples/study-harness-host` | Browser integration fixture with injectable persistence/policy failures and the quadratic learning-and-return fixture | Pretending to be the tutor |
| `examples/study-harness-tauri` | Packaged Tauri 2 reference host: narrow Rust commands, SQLite records, production CSP, conformance runner | Credentials, grading, curriculum |

Dependency direction: `core ← activity ← catalog`; `core, activity ← player/activity`; `player-3d` depends on
`core` types only and is loaded through a host-supplied loader. The activity adapter receives the catalogue as an
injected interface; it never imports `@explorable-models/catalog`.

## 2 Decisions

**D1 Separate activity schema.** Activity records use their own contract family (`study-harness.*`, schema
`1.0`). Schema 2.0 documents are unchanged and remain a supported *execution kind* (`document`) for bounded
exploratory composition. Old artifacts keep their readers (see §8).

**D2 Authoritative schemas in TypeScript builders, emitted as JSON Schema 2020-12.** `packages/activity/src/schemas.ts`
builds every schema from a small subset (type, properties, required, additionalProperties=false, enum, const,
min/maxLength in Unicode code points, ASCII-only patterns, minimum/maximum, min/maxItems, items, maxProperties,
propertyNames, anyOf, oneOf, `$ref` into `$defs`). `npm run generate:contracts` writes
`packages/activity/schema/*.schema.json`, `.d.ts`-equivalent TypeScript types are hand-aligned and checked by a
compile-time conformance test, and the Rust crate `packages/activity/rust` validates the *same JSON files* with
the `jsonschema` crate. Shared fixtures in `packages/activity/fixtures/contracts/{valid,invalid}` run through both
validators (A02). Semantic cross-reference rules are TypeScript-only and run in the adapter; Rust performs schema
and authority checks (receipts it issued, policy revisions it owns) and does not reimplement mathematics.

**D3 Installed kernels plus bounded documents.** A model manifest selects either an installed kernel
(`kernelId@kernelVersion`, bundled in the catalogue worker) or a schema 2.0 document. Requests carry IDs and
data only, never executable source. Kernels are trusted repository code; candidate/authored kernels run only in
browser workers through the CLI path. Document execution is an opt-in capability of `@explorable-models/core/model`
(`enableDocumentExecution()`, called in each page and worker that serves document-kind models; until then such a
manifest is refused with `UNSUPPORTED_CAPABILITY`), so the schema 2.0 compiler and interpreter are not part of a
kernel-only learner page or of the catalogue worker, which serves installed kernels only and loads each kernel's code on
first use (`INSTALLED_KERNEL_SOURCE`). The installed catalogue's template content (templates, learner copy, manifests)
is loaded per template on demand by `createLazyCatalog`, verified against the generated installed index of digests;
`createInstalledCatalog` keeps everything in memory for tooling and tests (budgets: D14, `performance.md`).

**D4 Four revision spaces.** Scientific (`ModelSession.version` + run ID, invalidated by model digest change),
presentation (`presentationRevision`, camera/layout/selection), activity (`activityRevision`, stage/reveal/
content), host session (`hostSessionRevision`, owned by the host and only echoed). Every cross-boundary command
carries the expected revisions it depends on. See `docs/study-harness/revisions.md` for the effect table tested by
A03.

**D5 Authority by construction.** The adapter is constructed by the host with a `HostPort`. Receipts are accepted
only as return values of that port for the exact request (matching idempotency key, digests and revisions). Actor
attribution (`learner`, `tutor`, `host`) is fixed by which binding issued the command (surface binding, agent tool
executor, host API); no input field can choose it. Review approval is resolved only from the host-constructed
`ReviewRegistry`; review claims inside imported data are untrusted provenance.

**D6 One projection for every channel.** `projectLearnerView()` in `@explorable-models/activity` produces the only
object the learner surface, learner-scoped tools, learner snapshots and captures receive. Hidden groups are
omitted from the object, not styled away. Developer inspection is a separate entry,
`StudyHarnessAdapter.inspectDeveloper(activityId)` (passed through by the visualizer), refused with `POLICY_DENIED`
unless the current host policy sets `inspection.developer`; it is not part of any binding, agent tool or surface and
is never mounted by the learner surface. Host-only operational metrics (`getDiagnostics`, `exportDiagnostics`) carry
no content and need no flag.

**D7 Persist-before-reveal.** Reveal = prepare → `HostPort.recordExposureIntent` → verify receipt →
apply projection → surface acknowledges display of the exact projection digest → `HostPort.recordDisplayAck`.
Intent without acknowledgement restores as `uncertain` (conservatively potentially exposed). Exploration requires an
`exploration` exposure scope covering parameter domain and groups.

**D8 Durable journal through the host.** The adapter keeps a bounded outbox (default 256 evidence-bearing events)
and never drops evidence silently. When full, evidence-bearing commands fail with `PERSISTENCE_BACKPRESSURE` and
read-only viewing continues. Duplicate detection is by `eventId` at the host; reconciliation uses
`HostPort.getJournalCursor` before conflicting transitions.

**D9 Discrete iteration.** Discrete kernels expose integer `index` from 0 to `maxIndex`; playback advances whole
indices; interpolation is presentation-only and flagged. Fractional indices are rejected (`INVALID_INPUT`) before evaluation.

**D10 Numerical statuses.** `QuantityResult.status` is `valid` (optionally with an `approximation`), `undefined`
(mathematical, with code/reason), or `numerical-limit` (`OVERFLOW`/`UNDERFLOW`/`ITERATION_LIMIT`, with
`lastFiniteIndex` where known). Out-of-domain requests are rejected before evaluation (`CONSTRAINT_VIOLATION`,
`OUT_OF_DOMAIN`); worker failures are operation errors (`WORKER_ERROR`, `WORKER_TIMEOUT`). None becomes zero.

**D11 Interaction controller in core.** The primary/scratch coalescing pattern from `examples/shared/controller.ts`
becomes `createPreviewCoordinator` (`@explorable-models/core/model`): one active preview evaluation plus one newest
queued value per activity, epochs that discard stale replies, a shared `WorkerBudget` across activities, and
release of scratch workers on suspension. The activity controller keeps at most one preview submission outstanding
and holds only the newest accepted value behind it, so a burst of updates never grows the session's 64-operation
window and the shown tentative frame converges to the newest value. Examples consume it; the duplicate controller is removed. The
document-level consumer is `createDocumentInteractionController` (`@explorable-models/core/declarative`), which the
showcase and hinged-rod examples use in place of `examples/shared/controller.ts` (see [lifecycle.md](lifecycle.md)).

**D12 Math rendering.** KaTeX 0.19.0 is lazy-loaded by the activity surface with `trust:false`, `maxExpand:1000`,
`maxSize:20`, source ≤ 4096 characters, a fresh macro object per render, `output:'htmlAndMathml'`, and a
plain-text fallback. Substitutions insert formatted numerals from the projection only.

**D13 Native automation route.** The packaged conformance run uses a cargo feature `conformance` that compiles an
in-app scenario runner and crash-injection points into a *separate* test binary; the release binary is built without
the feature and is checked for the absence of those commands. The decision and its verification are recorded in
`docs/study-harness/native.md` (updated after the feasibility spike).

**D14 Budgets.** Existing `@explorable-models/player` 2D consumer: ≤ 180,000 B gzip JS including React (unchanged).
New activity entry: ≤ 250,000 B gzip JS including React, the kernel worker and the activity runtime, excluding
lazy KaTeX/fonts and `player-3d`. The frozen measurement rules, consumers and ceilings are recorded in
[`budgets.json`](budgets.json) (contract-milestone freeze for 0.3.0-preview.1): `legacy2dConsumer` (zlib default
level over `examples/consumer`, as `scripts/verify-packages.mjs` measures), `activityEntry` (gzip9 over the `.js`
files statically reachable from the `examples/study-harness-consumer` entry HTML, built from the six packed tarballs),
and the lazy math, UI font, 3D and catalogue-content ceilings. `scripts/study-harness/verify-consumer.mjs` enforces
them; raising a ceiling needs a recorded decision ([performance.md](performance.md) §5). The rules and ceilings did not
change when the activity entry first exceeded its ceiling (performance.md F1); the cause was fixed instead. The
consumer uses the on-demand catalogue, so each template's content and each kernel's code are reached only through
`import()` (from the page and from the kernel worker) and are measured as lazy assets: catalogue content against its
own ceiling, kernel code in the evidence.

Packaged drag scope decision (2026-10-28, report §18): the macOS WKWebView reference host supports the existing
30 fps usable floor for the ordinary quadratic drag; 60 fps remains an unmet improvement objective. Repeated full
runs measured 56.03 and 58.56 fps, with occasional missed display frames. `budgets.json`
`preview2d.packagedSupportedFps` records this explicitly and the native judgement reports both targets. The input,
commit, dependency and scientific checks are unchanged. Further profiling is deferred; no causal performance fix is
claimed. The workload, measured user impact and scope are in [performance.md §3b](performance.md#3b-supported-packaged-drag-scope-2026-10-28).

**D15 Reference fixtures.** Activity oracles live in `tests/reference/fixtures/activities/`, derived by hand or by an
independently written method in `tests/reference/oracles/` that does not import catalogue code. Provenance and
tolerances are declared per case.

**D16 Status vocabulary.** Catalogue entries carry lifecycle `authored | validated | reference-checked |
reviewed | deprecated | revoked`. Without a host-trusted review record the highest status is `reference-checked`.
Engineering completion, approval for Study Harness use and learning benefit are separate (report §1.2).

## 3 Preserved invariants

Pure models; authored code in browser workers; one identified frame behind all related views; explicit undefined
with reasons; guarded mutations; exact analytical boundaries; stale results rejected; last accepted candidate kept;
parameter commits start a new run at index/time zero; tentative gestures stay tentative; independent fixtures
outside candidates.
