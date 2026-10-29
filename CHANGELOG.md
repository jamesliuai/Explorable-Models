# Changelog

## 0.3.0-preview.1 — unreleased (local candidate; no publication, tag, Developer ID signing, notarization or deployment)

**Breaking identity rename:** the project is Explorable Models, packages use `@explorable-models/*`, and the CLI is
`explorable-models` (`npm run models` in this checkout). The previous namespace and command aliases are removed.
Schema identifiers, configuration, browser attributes, and native identifiers follow the new identity. The third
pre-release schema-lock amendment records this change and the preceding digests. See the
[rename verification](docs/study-harness/evidence/namespace-rename.json) for current checks; the full-release,
native-binary, and performance results below describe the candidate before the namespace rename. Normalized
historical evidence identifies its original Git blob and cannot be resumed as a current release record.

This version adds the Study Harness visualization subsystem specified in
`docs/study-harness-visualizer-implementation-report.md`. Start with the
[handoff index](docs/study-harness/README.md). Automated repository release verification passed 19/19 gates in `2026-10-29T05-29-41.307Z`; the owner-run network-disabled procedure remains unperformed. Approval for Study Harness use
and learning benefit are separate claims, and neither is established ([status](docs/study-harness/README.md#1-status-three-separate-claims)).

Run `2026-10-29T05-29-41.307Z` is an audited resume of failed full run `2026-10-29T04-04-18.057Z`: 6 affected gates were executed again and 13 unchanged passing gates retain their original execution times, logs and provenance. The six SDK tarballs are byte-identical. Only the reviewed verification setup, tests and tooling changed. The failed parent record is preserved; this is complete effective gate coverage, not a claim that all gates ran afresh in one uninterrupted run.

### Added

**New packages and entries**

- `@explorable-models/activity`:
  - The `study-harness.*` schema 1.0 contracts, built in TypeScript and emitted as JSON Schema 2020-12 with a digest
    lock (`packages/activity/schema/frozen-1.0.json`). Before 1.0 the lock was amended three times, deliberately and with the
    previous digests recorded (`preReleaseAmendments`); the second amendment also closes the payloads of seven event
    types that used an open generic payload.
  - Shared valid and invalid fixtures, and a Rust validator crate (`study-harness-contracts`) that validates the same
    schema files.
  - The activity adapter (`createStudyHarnessAdapter`) and the `HostPort` interface.
  - One learner projection for every output channel.
  - Persist-before-reveal exposure records with host receipts and display acknowledgements.
  - A bounded journal outbox with backpressure instead of silent drops.
  - Deterministic interaction summaries, independent-task context, assistance records, and response correction and
    deletion.
  - Backup and learner-snapshot artifacts with integrity digests, and explicit migrations (draft 0.9 → 1.0).
  - Learner playback crosses a numerical limit the card does not show: it plays on to the last index (or the end
    time), as for a run without a limit, so where playback stops never tells a hidden outcome apart (for example a
    diverging trace that is not shown). A limit the card shows still stops playback one step before it, with a notice.
  - `@explorable-models/activity/conformance`: the host-agnostic HostPort conformance kit (`runHostPortConformance`) for
    external gate G2. It runs the G2 sequence through the real adapter against any `HostPort` and returns a record in
    the `host-conformance-result` template form, labelled by the caller (fixture results never satisfy A54).
- `@explorable-models/core/model`:
  - Model manifest 1.0, units, and coupled constraints.
  - The numerical statuses `valid`, `undefined` and `numerical-limit`, and identified frames.
  - A worker evaluator with a watchdog, a shared worker budget, and a guarded model session with discrete iteration,
    previews, isolated sampling and suspension.
  - `ModelSession.play(guard, options?)` takes `ModelPlaybackOptions` (additive; `options` may be omitted). By default
    playback stops one position before a frame at a numerical limit (session error `NUMERICAL_LIMIT`; the limit frame
    stays reachable by navigation) and play from a frame at a limit is refused (`OUT_OF_DOMAIN`).
    `throughNumericalLimit(frame)` is asked about each such frame; `true` crosses it and plays on to the position's own
    end.
- `@explorable-models/catalog`:
  - Five installed activities: quadratic gradient descent, function and derivative, linear transformation, 3D vector
    orientation, and quadratic surface and gradient.
  - Pure kernels and their module worker.
  - A host-trusted review registry, plus revocation and deprecation lists.
  - Without host review records, the highest lifecycle status is `reference-checked`.
- `@explorable-models/player/activity`:
  - `StudyActivitySurface`, `mountStudyActivity`, and `createStudyHarnessVisualizer`, which provides the report's six
    operations.
  - Exact controls, lazy bounded KaTeX math, 2D primitives, accessible tables and descriptions, display units, and
    container-responsive layouts.
  - Theme tokens with contrast checks.
  - Surface-specific SVG and PNG capture.
  - Bundled Inter and KaTeX fonts, with license files beside them.
- `@explorable-models/player-3d`: an optional, lazily loaded spatial renderer with a Three.js 0.186.1 peer. A 2D
  projection and coordinate table serve as the fallback.

**Agent tools and authoring**

- `@explorable-models/agent`:
  - Twelve policy-scoped activity tools (`createActivityTools`). `createActivityTools` requires
    `adapter.policyStanding` (the policy's standing by the adapter's host clock) and throws a `TypeError` when it is
    missing, so an adapter wrapper must forward it.
  - `createActivityRelay` and `createActivityToolEndpoint`.
  - Generated schemas in `docs/study-harness/activity-tool-schemas.json`.
  - `createTrialRecorder`, an opt-in sanitized recorder for the real host-agent trial (external gate G3): request
    identifiers, tool names, outcome codes, fixed-vocabulary repairs and a configuration digest only. Its record schema
    is `docs/study-harness/templates/agent-trial-record.schema.json`.
- `@explorable-models/core/declarative`: `createDocumentInteractionController`, the shared preview-coalescing controller.
  The showcase and hinged-rod examples use it.
- CLI `explorable-models activity` commands: `scaffold`, `validate`, `check`, `reference`, `boundaries`, `capture`,
  `review-packet` and `package`. Authored kernels and checks run only in browser workers.
- Independent reference fixtures and oracles for the five activities (`tests/reference/`), and subject-review packets
  with empty sign-off sections (`docs/study-harness/review-packets/`).

**Examples, scripts and documentation**

- `examples/study-harness-host`: a browser integration fixture (`/study-harness.html`) with injectable host failures,
  plus lifecycle and projection-lab pages.
- `examples/study-harness-tauri`: a packaged Tauri 2 reference host built from the packed tarballs. It keeps SQLite
  host records, exposes narrow raw-body commands, sets a production CSP, and ships a conformance runner. Packaged
  evidence exists for one macOS machine.
- Scripts:
  - `npm run generate:contracts` and `npm run test:contracts`, the second including `cargo test` of the contract crate.
  - `npm run ledger` (with Evidence and Notes columns).
  - Named gates `npm run test:reference`, `test:disclosure`, `test:migrations` and `test:lifecycle`, and
    `npm run pack:study-harness`, `verify:consumer`, `benchmark` and `test:native` for the scripts in
    `scripts/study-harness/`.
  - `npm run release:study-harness`: one release pipeline that packs the six packages once, runs every gate with
    exact counts against those tarballs, and writes `release/study-harness/verification.json` plus an append-only
    history. Consumer, packaged-host and benchmark runs also keep append-only history records in
    `docs/study-harness/evidence/history/` (failed runs and runs that throw included), `npm run verify:packages` keeps
    them in `release/preview/history/`, and `release/release-manifest.json`, `performance.json` and
    `package-evidence.json` record their source commit, dirty flag, lock digest and Node version.
  - The pipeline's `native` gate (default `--native=verify`) requires every scenario of a full packaged run
    (`examples/study-harness-tauri/scripts/scenarios.mjs`, the runner's own list), both packaged executables present
    with the recorded sha256, build records showing each app was built from the pipeline's tarballs and from the
    reference host sources still in the tree (one sha256 per source file, unchanged until the run ended), and only
    check results the runner writes (any other value fails); the runner refuses unknown `--only` names and refuses
    `--no-build` and `--display-only` unless its build records still describe the existing apps, the installed
    tarballs, the frontend dist and the host sources.
  - The `benchmark` gate judges `performance.json` itself: every row is required, the §18 targets and the
    reported-only spatial measures (GPU commit and camera, software WebGL) alike; a workload that throws or a series
    without samples keeps its rows as not measured and fails the run (listed under Errors); a `--quick` run is never
    release evidence; and spatial rows without hardware WebGL in the GPU run, or without any WebGL 2 context in the
    software-WebGL run, are not run (environment). The benchmark records the measured console lock state instead of a
    fixed note.
  - Result templates for external gates G2 and G3 in `docs/study-harness/templates/`.
- Documentation:
  - `docs/study-harness/`: architecture and decisions, runtime, revisions, native decisions and evidence, content
    packages, authoring, agent tools, compatibility and rollback, lifecycle, external gates, and the requirement
    ledger.
  - The Study Harness section of `docs/embedding.md`.
  - The subsystem threat model in `SECURITY.md`.

### Changed

- Complete breaking rename to Explorable Models: `@explorable-models/*` packages, the `explorable-models` CLI,
  `npm run models`, schema identifiers, browser selectors, environment variables, and native bundle identifiers.
  Previous namespace and command aliases are intentionally removed. Historical evidence copies are explicitly
  terminology-normalized; original bytes remain in the recorded Git blobs and are not claimed as current results.

- Finished the final unit/identity and validation leftovers: canonical drag axes and conversion into selected display
  units, coherent document unit scales, scientific identity for invisible label edits, detached surface styling, strict
  benchmark failure/raw-result checks, safe release ACL handling and exactly one archival return action. The boundary
  allow-list names the local optional loaders and checks their absence from startup. Added regressions; the WebKit independent-task test now waits atomically for the latest rendered projection, retaining its
  disclosure assertions and timeout. Test transform caching is disabled to avoid retaining gigabytes across runs.
- Restored the unchanged packed-entry budget by keeping document agreement and scientific projection behind the
  existing opt-in capability, loading capture rendering and saved-record migration for their asynchronous operations,
  separating eager artifact construction from restore-only decoding/verification, and loading KaTeX font metadata only with visible bundled math. Native ESM loads dependencies without optional
  preload hints; the graph audit and validation stay intact. Deferred raw/gzip distribution costs are reported. Capture freezes approved content before the optional module loads, rechecks permission and content/revisions afterward, accepts bookkeeping-only settlement, and rejects promptly on disposal.
- Recorded the macOS packaged drag's supported 30 fps scope explicitly; the 60 fps improvement objective remains
  separately measured. No dependency ceiling or scientific-clarity check was relaxed.

- **Versions and dependencies.**
  - Every workspace package is versioned `0.3.0-preview.1`.
  - `@explorable-models/player` declares `@explorable-models/activity` as an optional peer, which `./activity` requires.
  - `@explorable-models/agent` now depends on `@explorable-models/activity`.
- **Example controller.** `examples/shared/controller.ts` is removed. Examples use
  `createDocumentInteractionController` instead.
- **Package gates.**
  - `npm run verify:packages` also packs `@explorable-models/activity`. The 2D consumer budget is unchanged: at most
    180,000 B gzip, including React.
  - The unified `npm run release` tarball includes the new packages, the contract crate sources and the fixture pages.
    It runs `explorable-models activity` scaffold, validate, check, reference and review-packet from a clean install
    (A56).
- **Licensing and CI.**
  - `THIRD_PARTY_NOTICES.md` lists the KaTeX code, stylesheet and fonts, and the Inter font, redistributed with
    `@explorable-models/player/activity`.
  - CI installs a pinned Rust toolchain and runs the release pipeline (`npm run release:study-harness`), then packages
    the preview from that run. A manually dispatched macOS job can run the packaged conformance runner. Neither signs
    or publishes.
- **Cross-browser gate.** `npm run test:cross-browser` runs every Study Harness spec, with the composition and
  embedding specs, in Firefox and WebKit, and the release pipeline fails it when a required spec did not run in an
  engine or a test was skipped without a recorded reason. Engine defects it found in the learner card are fixed:
  sliders no longer take an explicit pointer capture (WebKit's thumb did not follow the pointer), a pressed slider
  takes focus so WebKit's blur during the press no longer cancels the drag, a value change produced by the release
  itself is no longer committed as a new gesture (Firefox, after a gesture ended by the host), and the Play/Pause
  toggle reserves the width of its wider face (WebKit's Pause was 0.6 px wider).
- **Historical documents.** The 0.2 preview documents (`docs/agent-first-*.md`, `docs/public-preview-handoff.md`,
  `docs/preview-operations.md`) are marked historical and point to the current documents.

### Compatibility

- Schema 2.0 documents and `explorable-models-document` artifacts (document runtime `0.2.0-preview.1`) are unchanged, and
  so are schema 1.0 exports.
- Activity records are a separate contract family. No record is relabelled or silently migrated.
- The matrix, migration examples, support policy and rollback procedure are in
  [docs/study-harness/compatibility.md](docs/study-harness/compatibility.md).
- Preview releases make no semver promise between previews.

### Known limitations and open gates

- **External gates G1–G6.** None of them has been performed ([external gates](docs/study-harness/external-gates.md)):
  manual assistive-technology and intended-user sessions, the actual Study Harness integration, a real configured
  host-agent trial, independent subject review, Windows and Linux packaged runs, and the learning-benefit evaluation.
- **Packaged reference host.** Evidence covers one macOS machine and the conformance fixture host only. Run
  `full-2026-10-29T05:53:42.866Z` (console unlocked) passed 168 of 168 checks, the display-dependent checks
  included; the latest run and its per-check results are in
  [native-conformance.md](docs/study-harness/evidence/native-conformance.md). A run with the console locked records its
  display-dependent checks as not run (environment), never as passed, and the release pipeline's native gate accepts
  only a complete full run built from the pipeline's own tarballs.
- **Performance.** The §18 measurements (`npm run benchmark`) and the dependency budgets (`npm run verify:consumer`)
  cover one desktop machine in Chromium with the packed production consumer. The §18 targets that apply to a host are
  also measured in the packaged reference host's WKWebView on the same machine, by the packaged conformance run's
  `performance` chain ([performance.md §3a](docs/study-harness/performance.md#3a-packaged-reference-host-wkwebview)).
  Low-end devices and the host-level launch and memory targets are not measured.
- **Browser coverage.** Final release run: Chromium 208/208 passed; Firefox 178 passed, 1 documented skip; WebKit 178 passed, 1 documented skip. The Study Harness browser specs run in Playwright's Chromium, Firefox and WebKit
  (`npm run test:cross-browser` adds Firefox and WebKit; per-engine, per-spec counts with skip reasons are recorded).
  Safari, real mobile devices and the packaged WKWebView are not covered by those runs; the packaged WKWebView has
  its own evidence. The renderer reuses a bounded pooled WebGL context across mounts ([lifecycle §5](docs/study-harness/lifecycle.md#5-known-limits)).
- **Release state.** No npm publication, hosted demo, release tag, Developer ID signing or notarization has been performed. The local native binaries retain their recorded linker/ad-hoc signatures.

## 0.2.0-preview.1 — 2026-10-22 (source preview; npm and hosting deferred)

- Named the public project Explorable Models and configured the owner-supplied repository links. Technical package/CLI names remain compatible; original contributor and fixture attribution are preserved.
- Made the studio the default site entry, added a public preview guide and explicit gallery route, and preserved legacy experiment/embed/capture links and startup snapshots.
- Standardized preview publishing tags, prepared read-only CI artifact retention, and added archive-integrity and nested-path production smoke checks. npm publishing and hosting are deferred.
- Prepared the initial source-only commit: include release-integrity tests, normalize source/lockfile line endings, exclude generated output and local credentials, and record commit provenance in preview evidence.
- Made packed-consumer verification use a normal install with an isolated empty npm cache, so clean CI does not depend on registry metadata from the maintainer's machine. Peer checks and exact dependency versions remain enforced.

- Added a versioned declarative document grammar, bounded expression interpreter, dimension/shape checks, immutable datasets, and browser-worker sessions.
- Added guarded candidate creation and semantic revision, retry deduplication, cancellation, exact boundary playback, preview isolation, portable artifacts, and retained comparison definitions.
- Added independently packed core, React/plain-DOM player, and provider-neutral agent packages, plus a scoped HTTP relay example.
- Added a composition studio with eight editable public presets, bound geometry/plots/values/equations/tables, exact controls, selection, drag, and SVG scene export.
- Fixed meaningful small-value formatting, mobile label scaling, drag-coordinate drift, dataset metadata refresh, and stale selection during presentation edits.
- Added numerical, misuse, browser, external packed-consumer, lifecycle and performance checks. Evidence and scope are recorded in `docs/agent-first-release-status.md` and `release/preview/package-evidence.json`.

This is an explicitly limited source-repository developer preview. External developer/user pilots, blind real-agent trials, manual assistive-technology sessions, independent human security review, real-device performance and public package installation remain supported-release gates. The optional provider adapter is mocked-transport tested only. General installed computation/renderer adapters, PNG/full-surface browser capture and universal 3D remain outside this preview.

## 0.1.0 — 2026-10-21

- Initial TypeScript runtime and SDK for analytical and parametric experiments, with strict manifests, units, quantities, worker execution, guarded commands, canonical time, previews, snapshots, and revision activation.
- React browser player with linked SVG, Three.js, plots, equations, accessible tables, saved comparisons, exact controls, and portable exports.
- Rolling bodies, linear transformations, and base-rate probability reference experiments, plus Riemann sums and analytical oscillator extension examples.
- Fixed authoring compiler, local CLI, authenticated live coordination, isolated captures, static bundles, and standard stdio MCP tools.
- Independent numerical fixtures, injected failure cases, browser acceptance tests, CI, installation packaging, dependency licenses, and reproducible check reports.

The initial release supports trusted local authoring and static playback over HTTP. Model cards retain their actual review status. Independent scientific review, comparative authoring studies, and user research are recorded separately in `docs/acceptance.md`.
