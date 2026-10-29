# Build and install a release

The workspace version is `0.3.0-preview.1`, and it is unreleased. There are three local distribution paths and one
verification pipeline. None of them publishes, tags, signs or deploys anything.

| Path | Command | Output |
| --- | --- | --- |
| Study Harness library tarballs | `npm run pack:study-harness` (`node scripts/study-harness/pack.mjs`) | `release/study-harness/packages/`: the core, activity, catalog, player, player-3d and agent tarballs, plus `manifest.json` with sha256, integrity, source commit and lock digest. See the [handoff](study-harness/README.md#33-package-from-tarballs). |
| Study Harness release verification | `npm run release:study-harness` | Packs once, runs every gate against those tarballs and writes `release/study-harness/verification.json` (see [below](#verify-a-study-harness-release)). |
| Declarative libraries and static site | `npm run release:preview` | `release/preview/`: the core, activity, player and agent tarballs, the site archive and verification evidence. The procedure dates from the 0.2 preview; see [preview operations](preview-operations.md). `node scripts/verify-preview.mjs --from-pipeline` derives the preview's verification from a release pipeline run instead of running the gates again (CI does this). |
| Unified source/CLI toolkit | `npm run release` | `release/explorable-models-<version>.tgz` and `release/release-manifest.json` (described below) |

The unified release package is a TypeScript toolkit plus its prebuilt static site. It retains the following, so that
the fixed authoring compiler and the activity commands can resolve their trusted sources:

- `packages/core`, `packages/player`, `packages/activity` (including the Rust contract crate sources),
  `packages/catalog`, `packages/player-3d`, `packages/agent`, `packages/cli` and its activity templates;
- examples, tests and documentation.

The core SDK also has its own package build for applications that need only the contract and runtime.

## Build locally

```sh
npm ci
npx playwright install chromium    # add firefox webkit for npm run test:cross-browser and the release pipeline
npm run build
node scripts/package-release.mjs
```

Packaging writes `release/explorable-models-0.3.0-preview.1.tgz` and `release/release-manifest.json`. The script stages only declared source roots and allowed file types, promotes the compiler/browser dependencies required at runtime, removes workspace and private-package settings, generates a distributable lock, and builds the gallery in that staged dependency context.

The package includes `npm-shrinkwrap.json` because npm deliberately excludes `package-lock.json` from published tarballs. Gallery and CLI definition identities use the same exact lock bytes and runtime/player source digest. A normal source checkout uses its package lock instead. The package declares no installation lifecycle scripts of its own.

Before packing, the script verifies every gallery experiment in Chromium with external network requests blocked, checks fresh-instance state restoration, and includes the reports and upstream playback license texts in `dist`. It then checks `npm pack --dry-run`, verifies the file inventory excludes local credentials and session bridges, creates the tarball, extracts it into a fresh temporary directory, runs `npm ci --ignore-scripts`, starts the executable, runs a quantitative check through the actual Chromium worker, and checks gallery/CLI revision agreement. In an unrelated directory it then runs `explorable-models activity scaffold --from quadratic-gradient-descent`, `validate`, `check` (in a browser worker), `reference` and `review-packet` against the installed tree only (A56). Finally it builds the standalone SDK. The release manifest records hashes, size, file count, and these results. Nothing is published to an npm registry or a hosting provider.

`release/release-manifest.json` also identifies what it was made from: `source` (commit and whether the working tree
was dirty), `packageLock` (sha256 of the workspace `package-lock.json`; the shrinkwrap's own digest is in
`RELEASE.json`), `node` and `platform`. The release pipeline fails its `release` gate when these are missing.

## Verify a Study Harness release

`npm run release:study-harness` (`scripts/study-harness/release-pipeline.mjs`) is the single release pipeline
(report §20.1, A59). It packs the six packages **once** with `pack.mjs`, records the manifest digest and the tarball
sha256 set, and runs every gate in order:

| Gate | Command |
| --- | --- |
| `typecheck` | `npm run typecheck` |
| `test` | `npm test` (the full vitest suite) |
| `test:contracts` | schema lock check, contract and Rust-agreement vitest files, `cargo test` of the contract crate |
| `test:reference` | independent reference fixtures, catalogue tests, CLI reference checks |
| `test:disclosure` | disclosure, exposure, projection, independence, every template, text safety, agent tools, SSR |
| `test:migrations` | migrations, artifacts, host failures, portable backup, restore, deletion |
| `test:lifecycle` | interaction controller and spatial controller/limits unit tests, then `study-lifecycle.spec.ts` |
| `test:browser` | every Playwright spec in Chromium |
| `test:cross-browser` | Playwright Firefox and WebKit: every Study Harness spec plus the composition and embedding specs; each required spec must run in both engines and every skipped test must carry its reason, or the gate fails |
| `build`, `verify:gallery` | production site build and its worker checks |
| `verify:packages` | packed 2D consumer; its tarballs must equal the pipeline's |
| `verify:consumer` | `verify-consumer.mjs --use-pack=<manifest sha256>`: the packed Study Harness consumer and the [budgets](study-harness/budgets.json), from exactly this pack |
| `benchmark` | §18 measurements of the packed production consumer ([performance](study-harness/performance.md)). The gate judges `performance.json` itself: built from this pack, identified (source commit and dirty flag, package-lock sha256, Node), not a `--quick` run, every required row present (`REQUIRED_TARGET_KEYS` in `scripts/study-harness/benchmark-evidence.mjs`) and measured, every §18 target met, no workload error, console/page error, failed request or CSP violation. A workload that throws or a series without samples keeps its rows as "not measured" and fails, the reported-only spatial measures (GPU commit and camera, software WebGL) included; spatial rows that could not run because the GPU run had no hardware WebGL, or the software-WebGL run had no WebGL 2 context, make the gate `not-run (environment)` |
| `review-packets` | `tests/cli/activity-packet.test.ts` (packets match the installed templates) |
| `test:release` | release tooling tests |
| `release` | the unified toolkit package and its clean install |
| `native` | packaged reference host (macOS): `--native=verify` (default) checks that `docs/study-harness/evidence/native-conformance.json`, the host's installed tarballs and the tarballs each packaged app was built from (the runner's build records) are exactly this pack; that both apps were built from the same reference host sources, which were unchanged when the run ended and are still the sources in this tree (one sha256 per file, `HOST_SOURCE_INPUTS` in `examples/study-harness-tauri/scripts/build-record.mjs`); that both packaged executables are present with the recorded sha256; that the evidence holds every scenario of a full run (`examples/study-harness-tauri/scripts/scenarios.mjs`: release, offline, restart, each crash point, restore, hostport-kit, templates, performance), each from a current run, with the latest run not partial; and reports the per-check results. A partial (`--only`) run, a missing scenario or executable, binaries built from other tarballs or from sources that have since changed, or a check whose result is not one the runner writes (`pass`, `fail`, `not-run`, `not-run-environment`) fail the gate. `--native=run` installs this pack into the host (`native-conformance.mjs --install-existing`) and runs the full suite first |

Each gate records its commands, status, exact counts parsed from machine-readable output (vitest JSON, Playwright
JSON, node --test TAP, `cargo test` and `tsc` summaries), duration and a log under
`release/study-harness/logs/<run>/`. Statuses are `pass`, `fail`, `not-run (environment)` with a machine-checked
reason (no macOS, a Playwright browser not installed, cargo missing, display-dependent packaged checks not run because
the window was hidden or the console locked), `not-run (blocked)` when a prerequisite in the same run did not pass, and
`not-run (excluded)`. The overall status is `fail` if any gate failed, `partial` if `--only=…` or `--skip=…` excluded
anything (a development run, never release evidence), `incomplete` if a gate could not run here, and otherwise
`pass`. The exit code is 1 for `fail` and 2 for `incomplete` unless `--allow-environment-gaps` is given.

The `test:cross-browser` gate record lists, per engine, the browser version and Playwright build, totals,
pass/fail/flaky/skip counts for each spec and every skipped test with its reason, plus a scope statement:
Playwright's WebKit is not Safari and not the packaged reference host's WKWebView (the `native` gate's evidence), and
no run here covers real mobile devices (A53). `node scripts/verify-preview.mjs` copies that record (or, run on its
own, builds it from the Playwright JSON report of its own run) into `release/preview/cross-browser-evidence.json`.

`release/study-harness/verification.json` holds the latest run: schema `study-harness.release-verification/1`, source
commit and dirty flag, package-lock sha256, Node, npm, rustc, cargo, Playwright and browser builds, platform and OS
version, the tarball sha256 set, every gate record, and a `claims` object that keeps engineering gates apart from
actual Study Harness integration (A54), a real agent trial (A57), manual assistive-technology sessions (A37), other
platforms (A53), independent subject review and learning efficacy, all recorded as not established by the pipeline.
Every run is also kept, append-only, in `release/study-harness/history/`; a full run is copied to
`docs/study-harness/evidence/history/`, where `verify-consumer.mjs`, `benchmark.mjs` and the packaged-host
conformance runner also append a record of every run (failed ones and runs that throw included) while their summary
files stay the latest index; `verify-packages.mjs` does the same in `release/preview/history/`. `performance.json` and
`package-evidence.json` also carry the source commit and dirty flag, the package-lock sha256, Node and tool versions
themselves, and the pipeline fails either gate when that identity is missing.

CI's validate job runs the same pipeline with `--skip=benchmark --allow-environment-gaps` (the benchmark's targets
are measured on the recorded reference machine; the native gate needs macOS) and then packages the preview from that
run. A CI record is therefore partial and is not release evidence.

### Resume a full candidate after a reviewed verification fix

`node scripts/study-harness/resume-release.mjs` can continue a **completed full** candidate after narrowly reviewed
browser-wait or conformance-probe fixes. It does not accept `--only`, `--skip`, a partial parent, SDK or fixture changes,
dependency/lock changes, changed gate commands or changed budgets. The ordinary pipeline above retains its behavior.
Before editing, preserve the original source archive and a source checkpoint with schema
`study-harness.resume-source-checkpoint/1`: parent run ID, SHA-256 of the original pretty-printed verification JSON,
the preserved source archive path/hash, sorted `{path, sha256}` source files and their JSON SHA-256 digest. The
checkpoint covers runtime, fixtures, tests, scripts, configuration and authored `model.md`; native build-source
entries additionally identify assets outside that text-file scope. Generated build/dependency directories and other
Markdown are excluded. The resume command cross-checks those files against the original source archive, with explicit
exceptions for staging-generated root package/lock, revision/public-source files and native install record/lock/policy.
The source archive is built before the parent's native gate: its installer updates the native lock to the exact pack,
and `generate-approved-policy.mjs` writes installed template approvals before the native build. The parent's native
source entries bind that lock and generated policy; current source and installed-package checks keep those bytes
pinned during the continuation. The audit records every exception and its reason.

Review the exact change, then save this plan outside the source roots. Hashes are raw 64-character SHA-256 values;
`beforeSha256` is `null` only for a new file. Every difference must have one entry, and the command also restricts
permitted paths and kinds in `REVIEWABLE_PATHS` (a plan cannot authorize arbitrary product code). Changes to the
existing pipeline may only export its shared gate helpers. The review reason describes the accepted synchronization
or verification change; passing the hash check does not substitute for that review.

```json
{
  "schema": "study-harness.resume-change-plan/1",
  "parentRunId": "<completed full run>",
  "checkpointSha256": "<hash of source-checkpoint.json bytes>",
  "review": "Agent-reviewed verification changes under owner authorization.",
  "changes": [
    {
      "path": "tests/browser/study-spatial.spec.ts",
      "beforeSha256": "<original file hash>",
      "afterSha256": "<reviewed file hash>",
      "kind": "test-synchronization",
      "reason": "Wait for both viewport metadata and its queued rendered frame; keep all assertions."
    }
  ]
}
```

```sh
node scripts/study-harness/resume-release.mjs \
  --parent=docs/study-harness/evidence/history/verification-<timestamp>.json \
  --checkpoint=release/study-harness/artifacts/<parent-run>/source-checkpoint.json \
  --plan=/absolute/path/reviewed-change-plan.json --check
# After reviewing the check output, run the same command without --check.
```

`--check` only audits files and evidence; it does not launch browsers or run gates. The actual continuation verifies
the original immutable parent/archive, all six real tarballs and manifest bytes, root lock, native source/binary
identities and exact reviewed changes. Passing consumer evidence must match its immutable parent history; raw
dependency measurements are judged against the unchanged budgets. Benchmark targets and failed command series are
re-evaluated from raw evidence. Source, plan, parent, evidence and artifact identities are checked during the run.

The command always reruns typecheck, the full unit suite, the full Firefox/WebKit gate, release-tooling tests, the
unified source package/clean install and the full native suite with `--install-existing`. Other gates may be reused
only when they passed in the full parent. Each reused row retains its original timestamps, counts and logs, plus
the parent history/record hash, gate-record hash and log/report hashes. Native binaries are rebuilt for the reviewed
conformance instrumentation and checked against the same unchanged SDK pack; the new native evidence is evaluated
normally. A derived native install record may regenerate only for that exact pack; its dependency lock remains pinned.

The result is a **new** `mode: resumed-full-candidate` record, with complete 19-gate coverage, explicit `rerun`/`reused`
execution and parent provenance. It becomes passing release evidence only when every effective gate passes; it does
not claim every gate ran fresh. Both append-only history locations receive the new record. The failed parent remains
failed and immutable. The latest summary can point to the new record; partial selections never become full evidence.

## Use the packaged toolkit

Extract the tarball and work inside its `package` directory:

```sh
tar -xzf explorable-models-0.3.0-preview.1.tgz
cd package
npm ci
npx playwright install chromium
npm run models -- init my-experiment --template rolling
npm run models -- dev my-experiment
```

Or install the local tarball into another project:

```sh
npm install /absolute/path/to/explorable-models-0.3.0-preview.1.tgz
npx playwright install chromium
npx explorable-models init lesson --template linear-map
npx explorable-models verify lesson
```

The executable is named `explorable-models`. Node.js 22.12 or newer is required. Chromium is a one-time local authoring/test dependency; exported learners do not install Node, Chromium, or an AI client. The prebuilt `dist` directory can be hosted as a static gallery. Custom exports are built with `explorable-models export <source> --out <directory> --zip` and served over HTTP.

## Release meaning

For `0.3.0-preview.1`, a successful local release run is engineering evidence for the exact tarballs it records. It
does not establish approval for Study Harness use or learning benefit; the three claims are kept separate in the
[handoff](study-harness/README.md#1-status-three-separate-claims). Rolling back activity records and host stores is
described in [compatibility §6](study-harness/compatibility.md#6-rollback-procedure). Registry and deployment rollback,
once publication is authorized, is described in [preview operations](preview-operations.md).

For the original 0.1 scope, the distribution is usable software: local analytical/parametric authoring, inspected
state, guarded agent commands, saved comparisons, technical checks, static export, and accessible manual playback.
Quantitative checks and browser tests do not establish scientific peer review or learning efficacy. The model cards
retain their actual review status. The acceptance record separately identifies human subject review, user studies,
vendor-host compatibility, and comparative adoption evidence that have not been completed.

Hosted compilation, public arbitrary-code uploads, stateful numerical solvers, stochastic adapters, and MCP Apps
embedding are outside this release. A browser worker is not advertised as an adversarial sandbox.
