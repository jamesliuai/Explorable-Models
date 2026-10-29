# Study Harness visualization subsystem: handoff index

> **Namespace rename.** Measurements and release records below describe the candidate before the breaking namespace
> change. JSON copies with a `terminologyProjection` field normalize names for this checkout and identify their
> unmodified original Git blob. They do not verify the current package hashes or native binaries. Current rename
> checks are recorded separately; historical full-release results are not relabelled as a new release pass.

This index is the entry point for engineers who integrate, review or continue the Study Harness visualization
subsystem. The [implementation report](../study-harness-visualizer-implementation-report.md) is the specification. The
pages below record how this repository implements it, the evidence produced so far, and what remains open.

Version: `0.3.0-preview.1`. This version is unreleased: no npm publication, release tag, Developer ID signing, notarization or deployment has been performed. The local native binaries retain their recorded linker/ad-hoc signatures.
Integrate from locally packed tarballs ([below](#33-package-from-tarballs)). Record compatibility depends on contract
versions and content digests, not on package versions ([compatibility](compatibility.md)).

## 1 Status: three separate claims

The report (§1.2) keeps three claims apart. The repository establishes automated engineering evidence for this candidate. The owner-run network-disabled
procedure remains open; actual host approval and learning outcomes require external work.

| Claim | What it requires | Current state |
| --- | --- | --- |
| **Engineering complete** | Every implementation and automated acceptance gate passes against exact package hashes, including the packaged reference host and failure recovery | The candidate before the breaking namespace rename passed 19/19 effective gates and 168/168 packaged checks. These results are historical. The renamed implementation has its own [focused verification record](evidence/namespace-rename.json); fresh full native/performance/release identities remain to be established for distribution. Ledger: 52 verified, 4 implemented, 3 external-gate, 1 partially-external. A51 also retains the owner-run network-disabled procedure. |
| **Approved for Study Harness use** | The actual host integration passes, the selected activity versions have subject review, and intended-user and assistive-technology checks have been performed | **Not established.** No installed activity has an independent human subject review, so the highest catalogue status is `reference-checked`. No manual assistive-technology or intended-user session has been run, and the real Study Harness application has not run the conformance sequence ([external gates](external-gates.md) G1, G2, G4). The reference host cannot establish this status. |
| **Learning benefit evaluated** | Study Harness's delayed independent-performance comparison | **Not evaluated.** This is an application-level research outcome (G6), not a library test result. |

Run `2026-10-29T05-29-41.307Z` is an audited resume of failed full run `2026-10-29T04-04-18.057Z`: 6 affected gates were executed again and 13 unchanged passing gates retain their original execution times, logs and provenance. Within that historical resumed run, the six SDK tarballs were byte-identical. Only the reviewed verification setup, tests and tooling changed. The failed parent record is preserved; this is complete effective gate coverage, not a claim that all gates ran afresh in one uninterrupted run.

Automated checks, reference agreement and visual polish are engineering evidence. They are not scientific review,
accessibility certification or evidence of learning benefit.

## 2 Documents

| Topic | Document | What it records |
| --- | --- | --- |
| Architecture and decisions | [architecture.md](architecture.md) | Layers, package boundaries and dependency direction, decisions D1–D16, preserved invariants |
| Activity runtime | [activity-runtime.md](activity-runtime.md) | Adapter construction and authority, projection, persist-before-reveal, journal and outbox, summaries, independent context, deletion, artifacts |
| Revision spaces | [revisions.md](revisions.md) | Scientific, presentation, activity and host revisions, their guards, and the effect table tested by A03 |
| Native decisions | [native.md](native.md) | Decisions N1–N10 from the macOS feasibility spike, how the reference host realizes them, N11–N23 from later work (HostPort refusals, frozen answers, lock-aware runs, the Wave 1 host port, the HostPort conformance kit, the 3D chunk, interrupted saves), platform findings and an owner-run offline procedure |
| Native evidence | [evidence/native-spike.md](evidence/native-spike.md) ([JSON](evidence/native-spike.json)), [evidence/native-conformance.md](evidence/native-conformance.md) ([JSON](evidence/native-conformance.json)), [evidence/host-conformance-reference-fixture.json](evidence/host-conformance-reference-fixture.json) | Spike results, the packaged conformance run with binary and tarball hashes, the effective CSP and per-scenario checks, and the HostPort conformance kit's record for the reference host (template form, `reference-fixture-host`) |
| Content packages | [content-packages.md](content-packages.md) | The five installed activities, their domains, conventions, and undefined and boundary states |
| Review packets | [review-packets/README.md](review-packets/README.md) | Per-template subject-review packets for a human reviewer. Every sign-off section is empty. |
| Authoring | [authoring.md](authoring.md) | `explorable-models activity` commands, package format, import allowlist, worker-only execution of authored code |
| Agent tools | [agent-tools.md](agent-tools.md), [activity-tool-schemas.json](activity-tool-schemas.json) | Policy-scoped activity tools, the scope model, disclosure rules, the relay, and repair cases |
| Compatibility | [compatibility.md](compatibility.md) | Compatibility matrix by format and version, read/write rules, [migration examples](compatibility.md#4-migration-examples), [support policy](compatibility.md#5-support-policy), [rollback procedure](compatibility.md#6-rollback-procedure) |
| Lifecycle | [lifecycle.md](lifecycle.md) | Scheduling, timers, worker-pool policy (dispose on release), suspension and resume, counts measured by the lifecycle tests |
| Performance and budgets | [architecture.md D14](architecture.md#2-decisions), [budgets.json](budgets.json), [performance.md](performance.md), [lifecycle.md §4](lifecycle.md#4-measured-counts) | Frozen budgets and their measurement rules (`budgets.json`), enforced on the packed production consumer by `npm run verify:consumer` ([evidence/consumer.md](evidence/consumer.md)); `npm run verify:packages` enforces the 180,000 B gzip budget of the existing 2D consumer. §18 measurements of the packed production consumer on one desktop machine in Chromium by `npm run benchmark` ([evidence/performance.md](evidence/performance.md)); lifecycle counts from the dev-server lifecycle tests. |
| External gates | [external-gates.md](external-gates.md) | Protocols for gates that need a person, credentials, another repository or another platform (G1–G6), plus the templates: [AT session log](templates/at-session-log.md) (G1), [host conformance result](templates/host-conformance-result.md) with its [schema](templates/host-conformance-result.schema.json) (G2), [agent trial log](templates/agent-trial-log.md) with the [trial record schema](templates/agent-trial-record.schema.json) of the opt-in recorder (G3) |
| Release verification | [release.md](../release.md#verify-a-study-harness-release) | `npm run release:study-harness`: one pack, every gate with exact counts against those tarballs, `release/study-harness/verification.json` and append-only history |
| Requirement ledger | [requirement-ledger.md](requirement-ledger.md) ([JSON](requirement-ledger.json)) | A01–A60 with status, implementation locations, tests and external dependencies. Regenerate the Markdown with `npm run ledger`. |
| Security model | [SECURITY.md](../../SECURITY.md#study-harness-visualization-subsystem-030-preview1) | Threat model, worker and native boundaries, privacy and telemetry |
| Embedding | [docs/embedding.md](../embedding.md#study-harness-learner-surface) | `createStudyHarnessVisualizer`, `HostPort`, mount and dispose, response slot, spatial loader, capture, CSP |
| Changes | [CHANGELOG.md](../../CHANGELOG.md) | `0.3.0-preview.1` (unreleased) |

### Handoff artifacts (report §22.3)

| Artifact | Location | Produced by | State |
| --- | --- | --- | --- |
| Source changes | this repository | — | The implementation, handoff, and visualization gallery are included in version control. Historical candidate verification records baseline commit `910c03a` with `dirty: true`; its exact package and binary hashes identify the tested SDK. The Git commit containing this handoff identifies the source publication; commit-specific CI results are recorded separately (A59). |
| Architecture and contract guide | [architecture.md](architecture.md), [activity-runtime.md](activity-runtime.md), [revisions.md](revisions.md) | — | present |
| Generated schemas and types | `packages/activity/schema/` (JSON Schemas, `index.json`, `frozen-1.0.json` digest lock). The authoritative source is `packages/activity/src/schemas.ts`, with types in `src/contracts.ts`. | `npm run generate:contracts` (`--check` verifies) | present |
| Shared TypeScript/Rust contract fixtures | `packages/activity/fixtures/contracts/` | the same generator | present |
| The five activity packages | `packages/catalog/src/{kernels,models,templates}/` ([content packages](content-packages.md)) | — | present; status `reference-checked` |
| Reference host and instructions | [`examples/study-harness-tauri`](../../examples/study-harness-tauri/README.md) | — | present |
| Requirement ledger | [requirement-ledger.md](requirement-ledger.md) ([JSON](requirement-ledger.json)) | `npm run ledger` | present |
| Machine-readable verification results | `release/study-harness/verification.json` (latest run; every gate, exact counts, tarball sha256 set, source and lock identity) with append-only copies in `release/study-harness/history/` and, for full runs, `docs/study-harness/evidence/history/` (created by the first full run); `release/preview/verification.json`, `package-evidence.json`, `cross-browser-evidence.json`; [`evidence/native-conformance.json`](evidence/native-conformance.json), [`evidence/consumer.json`](evidence/consumer.json), [`evidence/performance.json`](evidence/performance.json) | `npm run release:study-harness`; `npm run release:preview`; `npm run test:native`; `npm run verify:consumer`; `npm run benchmark` | candidate run `2026-10-29T05-29-41.307Z` passed with audited reuse; commit-specific CI runs retain their own source identity and scope |
| Numerical reference reports | `tests/reference/fixtures/activities/` with oracles in `tests/reference/oracles/`; per-case results in each review packet's `packet.json` | `npm test`; `npm run models -- activity reference` | present |
| Representative captures | stage captures in `review-packets/<templateId>/` and [`evidence/native-spike-captures/`](evidence/native-spike-captures) | `npm run models -- activity review-packet --installed <id>` | present; the spatial templates are captured through the 2D projection fallback |
| Performance and resource evidence | [evidence/performance.md](evidence/performance.md) ([JSON](evidence/performance.json); every run, failed ones included, also in `evidence/history/performance-*.json` with its source commit, dirty flag and lock digest), budgets in [evidence/consumer.md](evidence/consumer.md); [lifecycle.md §4](lifecycle.md#4-measured-counts) (lifecycle counts, dev server); 2D consumer p50/p95 workloads in `release/preview/package-evidence.json` | `npm run benchmark`; `npm run verify:consumer`; `tests/browser/study-lifecycle.spec.ts`; `npm run verify:packages` | one desktop machine in Chromium, with packaged WKWebView measurements recorded separately; not low-end-device or host-level guarantees |
| Migration fixtures | [`packages/activity/fixtures/migrations/`](../../packages/activity/fixtures/migrations/README.md) | `tests/activity/migrations.test.ts` | present |
| Clean-consumer evidence | [evidence/consumer.json](evidence/consumer.json) (the six packed tarballs in a clean install, production build, CSP flows, budgets); `release/preview/package-evidence.json` (2D consumer); `release/release-manifest.json` (unified tarball with source commit, dirty flag, lock digest and Node version; A56 activity authoring); `examples/study-harness-tauri/packed-artifacts.json` (tarballs installed into the reference host) | `npm run verify:consumer`; `npm run verify:packages`; `npm run release`; `install-packed.mjs` | generated per run; the release pipeline checks that each names the same tarball sha256 set |
| Study Harness tarballs | `release/study-harness/packages/` and `manifest.json` (generated, not committed) | `npm run pack:study-harness` (the release pipeline packs once and every gate uses that pack) | generated per run |
| Review packets | [review-packets/](review-packets/README.md) | `npm run models -- activity review-packet --installed <id>` | present; unsigned |

## 3 Integrate into Study Harness

This is the order the reference host follows. [Embedding](../embedding.md#study-harness-learner-surface) has the API
details. [External gate G2](external-gates.md#g2-actual-study-harness-integration-a54) defines when the integration
counts as passed.

### 3.1 `HostPort` checklist

`HostPort` (`packages/activity/src/contracts.ts`) is the only path to the host's authoritative store. The adapter never
writes to browser storage.

- [ ] Implement all nine required methods: `getPolicy`, `registerActivity`, `requestStageTransition`, `recordExposureIntent`,
      `recordDisplayAck`, `recordAssistance`, `appendEvents`, `getJournalCursor` and `saveArtifact`, and the optional
      `getActivityRecords` (the host's exposure rows, assistance receipts and its activity state — current stage,
      activity revision, closed, context lineage and current stage receipt — `study-harness.activity-records`). A
      restore adopts the host's activity state, counts a saved grant only when the host holds the same grant and its
      lineage counts it, and merges the rest so an earlier checkpoint never erases history the host holds. Without
      `activity` only the host's latest checkpoint restores (restricted); without the read saved grants never count.
      Derive the activity state from your own decisions only (the receipts you issued, the independent tasks you
      activated), never from a registered instance, an artifact or adapter-written events; the conformance kit checks
      this (`authorize-reveal`, `reopen-verify`, `independent-task`).
      Refuse `getJournalCursor` for an activity you do not hold: a restore reads it first, so a backup never creates an
      activity in your store.
- [ ] Make every method idempotent. A repeated idempotency key or event ID returns the original result and writes
      nothing new. The host owns transactions, sequencing and duplicate detection.
- [ ] Commit `recordExposureIntent`, `requestStageTransition` and `recordAssistance` durably **before** returning a
      receipt. The receipt must echo the request's `contract`, `activityId`, `idempotencyKey` and
      `basedOnActivityRevision`, the host's current policy revision, the exact `{ groupId, contentDigest }` list, and
      the template and model references. Never reuse a receipt ID for a different request. The adapter displays
      nothing if a receipt does not match (`RECEIPT_MISMATCH`).
- [ ] Persist `recordDisplayAck` separately. On restore, an intent without a persisted acknowledgement becomes
      `uncertain`, which counts as potentially exposed.
- [ ] `appendEvents`: store events in order and deduplicate by `eventId`. Report duplicates as acknowledged.
      `getJournalCursor` returns the last durable sequence for `reconcile()`.
- [ ] `saveArtifact`: store artifacts content-addressed and return `artifactDigest`. Keep the original bytes of
      migrated artifacts.
- [ ] Own the policy (`study-harness.host-policy` 1.0): approve exact template and model references as computed by
      the catalogue, set visible groups, permitted controls, tools and independent-task conditions, and handle
      revocation and expiry. Pass review records from the host's trusted store, plus revocations and deprecations, to
      `createInstalledCatalog`. Review claims inside imported data are never read.
- [ ] Validate every argument again on the privileged side, using the Rust crate `study-harness-contracts`
      (`packages/activity/rust`) or the emitted JSON Schemas. Check the byte length before parsing, and return fixed
      error messages that never echo input (native.md N7).
- [ ] Construct the adapter or visualizer in trusted host code. The learner surface receives only
      `prepared.binding('learner', surfaceId)`, agent tools receive a tutor binding, and `prepared.host` stays with the
      host. No input field can choose an actor.
- [ ] Own the host session revision: your response transaction produces it; pass exactly that value to
      `submitResponseRef`/`updateResponseRef` as `hostSessionRevision` (or follow a revision you advanced elsewhere with
      `observeHostSessionRevision`), and refuse a registration that claims a revision you never produced.
- [ ] Store an independent-task answer with the adapter's `freezeAssistanceSnapshot` exactly as given (including
      `complete`, `limitations` and the assistance grant summaries), checked against your own records.
- [ ] Decide how `close` resolves an active preview (`pending: 'cancel' | 'commit' | 'retain'`) and re-offer a restore's
      `report.pendingDraft`. On a restore refused with `UNSUPPORTED_ARTIFACT` or `CONTENT_REVOKED`, show
      `archivalView(artifact, { audience })` with `mountArchivalRecord` (pass `labels: archivalLabels(template)` from the
      exact saved template when you still hold it, and a `returnAction`); show `mountStudyActivityPlaceholder` while
      preparing or restoring.
- [ ] Show persistence states (`saving`, `pending-recovery`, `failed`) and drive recovery with `retryPersistence` and
      `reconcile()`.
- [ ] Meet the portable backup requirements in [compatibility.md §5](compatibility.md#5-support-policy) before
      relying on backups for rollback.

### 3.2 CSP and worker rules

These rules are verified in the packaged macOS WKWebView ([native.md](native.md)). The browser fixture does not set a
CSP, so it is not CSP evidence.

- Workers are module workers loaded from the application's own origin. The catalogue creates them with a literal
  `new Worker(new URL('./worker.js', import.meta.url), { type: 'module' })`. Allow `worker-src 'self'` only: no `blob:`
  workers, no inline workers, no `'unsafe-eval'` (N1). If your bundler cannot emit the worker, pass `workerFactory` to
  `createInstalledCatalog`. Never accept a worker URL from an agent or from imported data.
- If the WebView attaches the CSP only to HTML responses, add `default-src 'none'; script-src 'self'; connect-src 'self'`
  to bundled JavaScript responses yourself (N2; the reference host uses `on_web_resource_request`).
- Tested production policy (N3): `default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' blob:;
  font-src 'self'; connect-src 'self' ipc:; worker-src 'self'; base-uri 'none'; form-action 'none';
  frame-ancestors 'none'; object-src 'none'`. `ipc:` is Tauri-specific. `connect-src 'self'` lets the surface fetch
  its packaged KaTeX stylesheet.
- No `'unsafe-inline'` styles are needed. The surface adopts constructable stylesheets, with the packaged
  `activity.css` as a fallback (N4). Math renders through `katex.render` into DOM nodes (N5). PNG capture rasterizes
  pure SVG through a `blob:` image (N6).
- Keep every packaged asset on the application origin: workers, KaTeX CSS and fonts, Inter, and `activity.css`. Pass
  `assetBase` if you relocate them. The subsystem needs no network access.

### 3.3 Package from tarballs

```sh
npm ci
node scripts/study-harness/pack.mjs     # npm run build:packages, then packs core, activity, catalog, player,
                                        # player-3d and agent into release/study-harness/packages/ with manifest.json
```

`manifest.json` records each tarball's sha256 and integrity, the source commit (and whether the tree was dirty), the
lockfile sha256 and the Node version. In the host application:

1. Depend on the tarballs through `file:` paths (or a private registry you control). Do not alias monorepo sources.
2. Check each tarball's sha256 against `manifest.json`. Install with an isolated, empty npm cache and
   `--ignore-scripts`. `examples/study-harness-tauri/scripts/install-packed.mjs` does both and records the installed
   identities.
The activity tarball also includes `rust/Cargo.toml` and `rust/src/` next to `schema/`. Native hosts can extract those exact packed files into a versioned vendor directory and use the Rust validator with a relative Cargo path, without a machine-specific source checkout. Keep the tarball and its manifest together; do not edit extracted sources. `validate_bytes` bounds raw bytes before JSON parsing as well as checking the shared data limits.

3. Peer dependencies: `react` and `react-dom` (`>=18.3.1 <20`). `@explorable-models/activity` is an optional peer of
   `@explorable-models/player`, but it is required when you import `@explorable-models/player/activity`. `three@0.186.1` is a
   peer of `@explorable-models/player-3d`; install it only if you load spatial activities.
4. Load `@explorable-models/player-3d` only through a dynamic `import()` in `spatialLoader`. That keeps Three.js out of
   the 2D path.
5. Ship the license files from `dist/activity/` with the application ([third-party notices](../../THIRD_PARTY_NOTICES.md)).

### 3.4 Conformance sequence

1. **Contracts.** Validate the shared fixtures (`packages/activity/fixtures/contracts/`) with the host's own native
   validator and compare its decisions with the declared `expect` values. The repository does this for its crate with
   `npm run test:contracts`.
2. **Browser behaviour.** Run the host page against the injected failures exercised by the browser fixture
   (`/study-harness.html?fail=…`, `?crash=…`, `?revoke=1`; see the
   [fixture README](../../examples/study-harness-host/README.md)).
3. **Packaged restart sequence** (report §17): open the quadratic activity → submit a host response reference →
   authorize and reveal the trace → commit an exploration → change the camera → save → terminate the process → reopen →
   verify the scientific state, permitted presentation, event order and conservative exposure history → start a fresh
   independent task without the teaching visual.
4. **Interrupted exposure.** Repeat with process termination before intent persistence, after the intent is
   acknowledged but before display, and after display but before the display acknowledgement is persisted. Expect
   honest unseen, uncertain or displayed records, one reveal record and receipt, and no duplicate reveal or prediction
   events. The reference runner's crash points are `intent-before-commit`, `intent-after-commit`,
   `intent-after-reply`, `display-ack-before-commit` and (interrupted save) `save-before-commit`.
5. **HostPort conformance kit.** Run `runHostPortConformance` (`@explorable-models/activity/conformance`) against your
   `HostPort` with your host hooks ([G2](external-gates.md#g2-actual-study-harness-integration-a54)); it checks the
   §3.1 semantics at every step of the sequence and returns the result record in the template form.
6. **Record** the application commit, binary hash, platform and per-step results in
   [`templates/host-conformance-result.md`](templates/host-conformance-result.md) form. Label them as actual-host
   results, separate from the reference-host results (A54).

Display-dependent steps need a visible window. A hidden or occluded WebView suspends the card, which then never
acknowledges a display, by design. Record such steps as not run (environment), never as passed.

## 4 Known limitations

- **No subject review.** The highest catalogue status of the five activities is `reference-checked`. A review packet
  is evidence for a reviewer, not a review.
- **One platform.** Packaged evidence exists for a single macOS machine (Apple M3, macOS 26.6). Windows and Linux are
  external gates (G5). Builds retain recorded linker/ad-hoc signatures; Developer ID signing and notarization were not performed.
- **Packaged reference host.** Packaged run `full-2026-10-29T05:53:42.866Z` (console unlocked, window visible; the
  latest run is always in [the evidence](evidence/native-conformance.md)) passed 168 of 168 checks on that machine,
  including all display-dependent checks, the spatial templates
  rendered through the packed 3D chunk, the interrupted save (`crash:save-before-commit`), the packaged §18
  performance chain and the HostPort conformance
  kit against the Rust store ([native.md](native.md#current-evidence),
  [record](evidence/host-conformance-reference-fixture.json)). These are fixture-host results; the kit's restarts and
  interruptions in that scenario are in-process (store reopened, simulated faults), and process terminations are the
  `restart` and `crash:*` scenarios. The machine's network was not disabled (an owner procedure is in native.md). A
  locked console or sleeping display makes display-dependent checks "not run (environment)"; re-run
  `npm run conformance:display` in `examples/study-harness-tauri` then.
- **Browser coverage.** Current release run `2026-10-29T05-29-41.307Z`: Chromium 208/208 passed; Firefox 178 passed, 1 documented skip; WebKit 178 passed, 1 documented skip. Counts and skip reasons come from the release pipeline and the preview record derived from it.
   Every Study Harness browser spec (`tests/browser/study-*.spec.ts`: the three 2D activities,
  lifecycle, projection, interaction, presentation, observed data and the spatial specs) runs in Playwright's Chromium
  (`npm run test:browser`) and, with the composition and embedding specs, in Playwright's Firefox and WebKit
  (`npm run test:cross-browser`). WebGL 2 is available headless in all three engines on macOS, so the 3D tests run in
  each and the no-WebGL fallback tests block WebGL in each. Engine-specific steps in the specs reflect platform
  behaviour, not weaker checks: keyboard-only runs press Option-Tab in WebKit on macOS (Safari's default Tab skips
  buttons and sliders); a trusted touch swipe needs the Chrome DevTools Protocol, so that one test is skipped in
  Firefox and WebKit, which check the slider's `touch-action: pan-y` instead; heap and engine-wide listener/node
  counts come from that protocol in Chromium, while the page's own counts are checked in every engine; the 3D
  renderer reuses pooled WebGL contexts across mounts, so no engine (WebKit included, which counts a lost context until
  it is collected) reaches its context limit in the mount/dispose cycles ([lifecycle §5](lifecycle.md#5-known-limits)).
  The cross-browser run found and fixed four engine defects in the learner card (slider drag under explicit pointer
  capture and blur on press in WebKit, Firefox's release-time `change` after a gesture ended by the host, WebKit's
  wider Pause face). Per-engine, per-spec pass/fail/skip counts, engine versions and the reason for each skip are
  recorded by the release pipeline's `test:cross-browser` gate and in `release/preview/cross-browser-evidence.json`.
  Playwright WebKit is not Safari and not the packaged reference host's WKWebView (recorded separately by the native
  gate); Safari and real mobile devices are not tested (A53).
- **Performance.** §18 measurements (`npm run benchmark`) and the dependency budgets (`npm run verify:consumer`)
  cover one desktop machine in Chromium with the packed production consumer; the latest results are in
  [evidence/performance.md](evidence/performance.md) and [evidence/consumer.md](evidence/consumer.md). The §18
  targets that apply to a host are also measured in the packaged reference host's WKWebView on the same machine
  ([performance.md §3a](performance.md#3a-packaged-reference-host-wkwebview)). Low-end devices and the host-level launch
  and memory targets are not measured. Lifecycle counts are fixture results
  from the dev server ([lifecycle.md](lifecycle.md)).
- **Spatial review captures.** Review packets show the two spatial templates through the learner surface's 2D
  projection fallback.
- **Fixture storage.** The browser fixture keeps host tables in `sessionStorage`, which is not an authoritative store.
- **Isolation limits.** Workers isolate model code from the DOM and allow termination. They are not a hostile-code
  sandbox or a memory quota. A shadow root is a styling boundary, not a security boundary
  ([SECURITY.md](../../SECURITY.md)).
- **Preview versions.** Preview releases make no semver promise between previews. Record compatibility follows
  [compatibility.md](compatibility.md).

### 4.1 Remaining work

The prior handoff's code leftovers are resolved: drag and document unit scales, invisible label identity,
benchmark failure handling and raw-result verdicts, release ACL reuse, exact archival return controls and detached
embedding styles have focused regressions. The packaged drag scope is explicit in
[performance.md §3b](performance.md#3b-supported-packaged-drag-scope-2026-10-28); the test-host profile decision is in
[activity-runtime.md §10](activity-runtime.md#10-host-refusals-and-persistence-failures-63-72). Candidate verification and evidence reconciliation are complete for run `2026-10-29T05-29-41.307Z` (19/19 effective gates; six rerun and thirteen reused with audited provenance). The root README subsequently gained a [gallery of production learner-component screenshots](../images/activities/README.md); that documentation refresh preserves the tested runtime.

Retained decisions and owner actions:

1. **Label fixes need re-review.** Capitalization and typo fixes in model labels change the scientific revision under
   the conservative `labelWording` rule.
2. **Source provenance.** Source publication includes the implementation and README gallery under the owner's commit/push authorization. Historical candidate evidence keeps its original working-tree identity; consult the containing Git commit and its CI run for commit-specific provenance.
3. **Unexercised release paths.** A Linux pipeline run and the CI `validate` job have not been exercised. The owner-run
   procedure with networking disabled ([native.md](native.md#owner-run-offline-procedure-not-run-here)) has not been
   performed. No Developer ID signing or notarization was performed; recorded linker/ad-hoc signatures remain part of the binary evidence.
4. **Packaged drag optimization.** 60 fps remains an improvement objective; the macOS reference host supports the
   documented 30 fps scope. Profiling to establish a stable 60 fps path is deferred explicitly.

### 4.2 External gates

These need people, credentials, another repository or other platforms ([external-gates.md](external-gates.md)). No
repository result stands in for them.

- **G1 (A37):** manual assistive-technology and intended-user sessions. Not run.
- **G2 (A54):** actual Study Harness integration. The HostPort conformance kit and the fixture-host results are
  preparation only.
- **G3 (A57):** a real configured host-agent trial. The trial recorder, its schema and the log template are
  preparation; scripted runs are labelled as scripted fixtures.
- **G4:** independent subject review. The review packets are prepared but not reviewed.
- **G5 (A53 remainder):** other platforms. This covers packaged Windows (WebView2) and Linux (WebKitGTK) runs, and real
  Safari, iOS and Android devices. Packaged evidence covers one macOS machine; browser engines are Playwright's on macOS.
- **G6:** learning benefit. This is an application-level research outcome, not a library result.
