# Study Harness reference host (Tauri 2) — conformance fixture

A small packaged desktop host that exercises the Study Harness visualizer boundary the way the real application must
(report §17): the learner card from the **packed** `@experiment-kit/*` tarballs (used through
`createStudyHarnessVisualizer`), host-owned stage controls, a host-owned response composer, durable host records in
SQLite, persist-before-reveal with receipts, save / terminate / reopen recovery, an independent task with the teaching
visual unavailable whose answer is stored with its frozen assistance/exposure snapshot (§6.4, A26), and an
assistance-recorded reopening.

**What it is not.** It is not a Study Harness application and not a second learning platform: no tutor, agent, grading,
curriculum, review scheduler, microphone, account, provider key, credential store or network access. Every screen is
labelled "Reference host — conformance fixture". Its results are fixture-host evidence for the toolkit boundary and are
kept separate from the actual Study Harness integration (A54, `docs/study-harness/external-gates.md` G2).

## Layout

| Path | Role |
| --- | --- |
| `src/app.ts`, `src/ui.ts`, `src/composer.ts`, `src/main.ts` | Host chrome and host steps (plain DOM; `createStudyHarnessVisualizer` prepares, restores and mounts the card; the composer is passed to the card through `responseSlot`; `mountStudyActivityPlaceholder` while preparing or restoring; the archival read-only record when a restore is refused as unsupported or revoked) |
| `src/spatial.ts` | `spatialLoader`: the packed `@experiment-kit/player-3d` chunk (with Three.js), loaded only when a spatial view is on screen; a host-side registry of mounted renderers and their counters (never shown to the learner) |
| `src/native-bridge.ts` | The only module that touches `@tauri-apps/api`; every request is a raw UTF-8 JSON byte body; rejections carry `{ code, message, reason? }` |
| `src/native-host.ts` | `HostPort` over the native commands (the nine required methods and the optional `getActivityRecords`; HostPort refusal convention, below), plus the host-owned operations |
| `src/conformance/*` | In-app scenario runner and probes — emitted only by `vite --mode conformance` (includes the HostPort conformance kit run, `hostport-kit`) |
| `public/csp-audit.js` | CSP violation and request log (offline audit, `docs/study-harness/native.md` N9) |
| `src-tauri/src/commands.rs`, `errors.rs` | Narrow commands: raw body → byte bound → shared JSON Schema (`packages/activity/rust`) → one host transaction → stable `{ code, message }` errors (HostPort commands: refusal convention with `reason`) |
| `src-tauri/src/host.rs`, `store.rs`, `backup.rs` | Host authority and records: SQLite (bundled), WAL + `synchronous=FULL`, receipts, idempotency, journal, content-addressed artifacts, immutable frozen answer snapshots, portable backup |
| `src-tauri/src/approved.rs`, `policy.rs`, `policy/approved.json` | Approval and policies issued by the host from the installed catalogue (generated at frontend build time, embedded with `include_str!`) |
| `src-tauri/src/conformance.rs` | TEST-ONLY commands and crash points, compiled only with `--features conformance` (scenario input, report, captures, exit, window, crash arming, simulated faults and store reopening for the kit, approval withdrawal for the archival probe) |
| `src-tauri/tauri.conformance.conf.json` | Config merged only into the conformance build (own product name, identifier, frontend and inline test capability) |
| `scripts/install-packed.mjs` | Installs the packed tarballs (core, activity, catalog, player, player-3d; `three` from the registry, pinned) with an isolated npm cache and records their identities in `packed-artifacts.json` |
| `scripts/generate-approved-policy.mjs` | Writes `src-tauri/policy/approved.json` from the installed catalogue |
| `scripts/conformance.mjs` | Packaged conformance runner (builds, launches, terminates, verifies, writes evidence) |
| `spike/` | Archived sources of the earlier feasibility spike (not built; provenance for `native-spike.*` evidence) |

## Build and run (macOS)

Requirements: Node ≥ 22.12, Rust (tested 1.95), Xcode command-line tools. Nothing is signed or notarized.

```sh
cd examples/study-harness-tauri
node scripts/install-packed.mjs --pack      # build + pack core, activity, catalog, player, player-3d; install them (isolated npm cache)
npm run test:rust                           # host logic tests (both feature sets)
npm run lint:rust                           # clippy -D warnings (both feature sets)
npx tauri build --bundles app --no-sign     # release app: src-tauri/target/release/bundle/macos/StudyHarnessReference.app
open src-tauri/target/release/bundle/macos/StudyHarnessReference.app
```

The app stores its records in `~/Library/Application Support/dev.experimentkit.studyharness.reference/`
(`reference-host.sqlite3`, store schema 3; `exports/` receives portable backups written by **Export portable backup**;
backups placed in `imports/` are offered for import, named by their sha256). Portable backups contain the host's full
records, including response text and the frozen answer snapshots: treat them as the learner's study record. Backups
written before schema 2 (no `response_snapshots`) or schema 3 (no `responses.host_session_revision`,
`activities.closed_pending`) still import, and an older store gains the schema-3 columns when it is opened.

A backup file is untrusted data (report §16). `backup.rs` keeps a fixed column list per table, equal to the store
schema (`backup_tables_match_the_store_schema`), and builds every export and import statement from those lists only.
Before any SQL runs, the document, each activity entry and every row must have exactly the expected keys (only the two
schema-3 columns may be absent), and every value its column's fixed shape. Contract records are validated with the
shared schemas. The host's own registrations, display acknowledgements, assistance, responses and recoveries must have
exactly the shapes this host writes, and rows must agree with the records they reference. A file that fails is listed
with `valid: false` and `INTEGRITY_FAILURE`, and importing it changes nothing (R06; the tests are listed in
`src-tauri/src/tests.rs` under "R06").

The app's Vite config has no monorepo aliases: `@experiment-kit/*` resolve to the extracted tarballs in this
directory's `node_modules`. After library changes, re-run `node scripts/install-packed.mjs --pack`. Note that `--pack`
replaces `release/study-harness/packages` with a five-package pack (`complete: false`); when a complete release pack
already exists there (`npm run release`), run `node scripts/install-packed.mjs` without `--pack` to install from it
(every tarball is checked against that pack's manifest). To keep the complete pack while installing library changes,
rebuild it first and then install from it:

```sh
node scripts/study-harness/pack.mjs                                  # repository root: complete six-package pack (complete: true)
cd examples/study-harness-tauri && node scripts/install-packed.mjs   # install core, activity, catalog, player, player-3d from it
npm run policy                                                       # regenerate src-tauri/policy/approved.json from the installed catalogue
```

## Host records added for the learner's answer (A26)

When the host-owned composer submits an answer in an independent task, the host first asks the adapter for
`freezeAssistanceSnapshot({ responseId })` (exposures and assistance up to the current journal cursor), then confirms
the response with that snapshot (`confirm_response` with `assistanceSnapshot`). In the same transaction that marks the
answer submitted, the Rust host checks the snapshot against its own records (every exposure and assistance receipt must
be one it holds for that activity), adds its own exposure/assistance records of the task and of the instructional
activity the task came from, and stores the result in `response_snapshots` with its sha256 digest. The row is
immutable (SQLite triggers refuse `UPDATE`, and `DELETE` while the response exists; the host deletion policy removes it
with the activity). A later reopening of the teaching visual, help or feedback is recorded as new assistance and never
changes it; an answer cannot be confirmed without its snapshot, and a second confirmation with a different snapshot is
refused (`OPERATION_CONFLICT`). `get_response_snapshot` returns the stored snapshot for inspection.

## Host records for the Wave 1 host port

- **Durable records read-back.** `get_activity_records` implements the optional `HostPort.getActivityRecords`: the
  host's exposure rows as stored and one `AssistanceRef` per assistance receipt (the sequence of its
  `assistance.recorded` event, or the journal's end when that event is not journaled; the grant summary), validated
  against `study-harness.activity-records`. A restore merges them, so an earlier checkpoint never erases history the
  host holds. They stay readable when the activity's approval is withdrawn.
- **Host-owned activity state.** The same reply carries `activity`, which a restore and `reconcile` adopt (report
  §4.2, §6.4, §14): the stage and activity revision of the activity row, `closed` (a receipt into the template's closed
  stage, or a journaled `activity.closed`), the context `lineage` and `stageReceiptId`. All of it is derived from the
  host's own decisions, never from a registered instance, an artifact or adapter-written events: an independent-task
  activity is `independent` (its task ref) from revision 1 (the host activates it at creation, revision 0) until the
  host records a `reopen-instructional` assistance, whose receipt revision starts the instructional lineage; an
  instructional activity is `instructional` from revision 0; `stageReceiptId` is the latest stage receipt when it moved
  the activity to the stage the host holds. A restore reads `get_journal_cursor`, then `get_activity_records`, and only
  then registers; both reads are refused for an activity the store does not hold, so a backup never creates one. The
  state survives a restart and a portable-backup import (it is derived from the imported rows).
- **Resuming a committed reveal.** `list_activity` names, per activity, the latest receipt when it is a reveal the host
  committed and no display acknowledgement followed (`unacknowledgedReveal`: idempotency key, receipt, exposure,
  groups, stage, activity and policy revision). After a termination between the host's commit and its reply, the
  restored card follows the host's revision and holds that grant as history. The host chrome re-issues the same reveal
  under that idempotency key, so the host replays the receipt it committed: one reveal record and one receipt (report
  §17, A20).
- **Host-owned session revision.** `confirm_response` is the host's response transaction: it stores and returns the
  host session revision it produced (`responses.host_session_revision`; the same value on replay). The host confirms
  first and passes exactly that value to `submitResponseRef`; if the activity cannot record the reference, it follows
  the revision with `observeHostSessionRevision`. A registration claiming a revision the host never produced is refused.
- **Frozen answer snapshots** carry the adapter's `complete` and `limitations` (stored as given) and full
  `AssistanceRef`s whose grant must match the host's own records.
- **Close.** The host panel sets the host's policy for an active preview on Close (`close({ pending })`: cancel, commit
  or keep it as a draft); the store keeps the journaled resolution (`activities.closed_pending`, shown in the records
  list), and a restore's retained draft (`report.pendingDraft`) is shown for the host to re-offer.
- **Archival record.** When a restore is refused because the saved content is not installed or no longer approved
  (`UNSUPPORTED_ARTIFACT`, `CONTENT_REVOKED`; `get_policy` refuses an activity whose exact refs the approval no longer
  lists), the card area shows `archivalView(artifact, { audience: 'learner' })` through `mountArchivalRecord`: read-only,
  no controls, nothing evaluated. While an activity is prepared or restored it shows `mountStudyActivityPlaceholder`.
- **Replay of carried events.** A restore resends the events a backup carried as unacknowledged with their original
  eventId and sequence; `append_events` reports those it already holds as duplicates and appends the rest.

## HostPort refusal convention

The `HostPort` commands (the nine required methods and `get_activity_records`) follow the convention exported by `@experiment-kit/activity` (`HOST_REFUSAL_CODES`,
`isHostRefusal`): a host decision rejects with `POLICY_DENIED`, `POLICY_EXPIRED`, `CONTENT_REVOKED`,
`STALE_POLICY_REVISION` or `INVALID_INPUT` and is not retried by the adapter; the specific host code travels as
`reason` (for example `{ code: 'INVALID_INPUT', reason: 'NOT_FOUND' }`, `{ code: 'POLICY_DENIED', reason:
'INDEPENDENT_CONTEXT' }`). An activity whose exact template/model refs the installed approval no longer lists is
`CONTENT_REVOKED`. Storage failures stay distinct and retryable: `PERSISTENCE_FAILED` (SQLite or file I/O) and
`INTEGRITY_FAILURE` for stored bytes (a *supplied* artifact that fails its manifest is a refusal, `INVALID_INPUT` /
`INTEGRITY_FAILURE`). Messages are fixed sentences; no field name or value is echoed. Host-owned commands (open, reveal
authorization, responses, backups, …) report the specific code. The bridge reports an IPC-layer ACL rejection of a
HostPort command as `POLICY_DENIED` (`reason: 'IPC_DENIED'`); transport failures stay retryable.

## Conformance run

```sh
npm run conformance           # FULL suite: builds both apps, runs every scenario, rewrites the evidence
npm run conformance:display   # ONLY the display-dependent scenario chains, against the already-built apps, merged into the evidence
node scripts/conformance.mjs --only=offline --no-build --keep --evidence-dir=/tmp/ev   # ad-hoc partial run into another folder
```

Both commands write `docs/study-harness/evidence/native-conformance.{json,md}` (from the repository root,
`node scripts/study-harness/native-conformance.mjs [--install] [--display-only]` does the same). `conformance:display`
(`--display-only`) re-runs `offline`, `restart`, `crash:*` and `templates` — the chains that hold display-dependent checks — and
replaces those scenarios' results; `release` and `restore` keep the results of the run that produced them, and every
scenario records its run. It refuses to start, changing nothing, unless both packaged executables have exactly the
sha256 recorded in the evidence and were built from the sources still in the tree (exit 2: run the full suite), and
the console session is unlocked (exit 3). A full (or
partial) run replaces every scenario result, since they belong to the binaries it ran, but keeps the earlier entries
of `runs[]` as superseded history with their binaries, console-session state and the evidence summary they left; each
new run record carries the outcome of its own scenarios.

The scenario chains are listed once, in `scripts/scenarios.mjs`; `--only` refuses a name that is not there. A run of
fewer than all chains is recorded as `partial` and is never release evidence: the release pipeline's native gate
requires every scenario of a full run (each crash point included), so write ad-hoc partial runs to another
`--evidence-dir`. Every build writes a build record next to its `.app`
(`src-tauri/target/…/bundle/macos/<product>.build-record.json`, `scripts/build-record.mjs`): the executable sha256,
the installed tarballs (`packed-artifacts.json`) the frontend was bundled from, the frontend dist digest and the
reference host sources the app was built from; the evidence's `builds` carries it. `--no-build` refuses to start
(exit 2, nothing written) unless both records still describe the existing executables, the currently installed
tarballs, the current dist and the current sources, so evidence can never attribute binaries to tarballs or sources
they were not built from; after `install-packed.mjs` installs a new pack, or after any source edit, rebuild.

`--no-build` also refuses any chain containing `release` (including the default full suite). Release ACL checks need
both apps rebuilt in the current run: Tauri's shared `src-tauri/gen/schemas` describes only the last build and is not
evidence of two different command scopes. Use `--only=offline --no-build` for an identified partial run, or omit
`--no-build` for release checks. `--display-only` still reuses identified binaries for the display-dependent chains.

The sources are `HOST_SOURCE_INPUTS` in `scripts/build-record.mjs`, one sha256 per file. They cover this app's
frontend (`src/`, `index.html`, `public/`, configuration, `package.json` and its lock), the Rust host (every file under
`src-tauri/src`, the build script, Cargo manifest and lock, Tauri configuration, capabilities, icons and the embedded
`policy/approved.json`), and the contracts crate it links (`packages/activity/rust`) with the JSON Schemas that crate
embeds. Build outputs and `node_modules` are not inputs. The tree is not committed, so a commit and a dirty flag
cannot say which `host.rs` a binary holds, but these digests can. The sources are checked at four points:

- The runner reads them before and after each `tauri build` (after regenerating the policy, which the build's first step does
  anyway) and refuses a build during which they changed.
- `--display-only` refuses evidence whose builds name other sources.
- At the end of every run the runner reads them again and writes the result to `sources` in the evidence. Sources changed since
  the build make the run exit 1 and are named in the evidence.
- The release pipeline's native gate compares the build records with the sources in the tree it verifies.

First unlocked runs (26 October 2026): the display-dependent checks found two probe defects in `probe:katex-in-card`
(the equations panel was never scrolled on screen, so the lazily loaded math never rendered; the strut was looked up
as `.strut`, while the installed KaTeX 0.19 names it `.katex-strut`) and an adapter defect behind
`display-acknowledged-after-resume` at `display-ack-before-commit` (a checkpoint saved while the display
acknowledgement was in flight claimed it as confirmed, so the restored adapter never resent it). Both are fixed
(`docs/study-harness/native.md`, "First unlocked runs").

Current evidence (27 October 2026, with the host-owned activity state in `get_activity_records`): run
`full-2026-10-27T07:14:12.490Z` (console unlocked, window visible) passes 168 of 168 checks, the display-dependent ones
and all 11 performance rows included. Both apps were built in that run from the host sources recorded in their build
records, and those sources were unchanged when it ended. The HostPort conformance kit passed all twelve steps against
the Rust store, with its new host-read assertions. It replaced `full-2026-10-27T06:42:32.273Z` (168 of 168), whose
binaries could not be tied to `src-tauri/src/host.rs` after a later edit. The rebuild from the current sources produced
byte-identical executables. An earlier run with the same pack, `full-2026-10-27T06:33:32.954Z`, failed 8
checks in `crash:intent-after-commit` and `crash:intent-after-reply`. The restored card followed the host's revision
past the reveal the host had committed before the termination. The host chrome then re-issued that reveal under a new
operation ID, which produced a second reveal record. The host chrome now resumes it under the committed request's own
idempotency key (`unacknowledgedReveal` in `list_activity`; `revealOperation` in `src/app.ts`). Earlier runs, failed
ones included, stay in `runs[]` and `docs/study-harness/evidence/history/`. Identities and the defects those runs
found: `docs/study-harness/native.md` ("Current evidence").

The console lock state (`ioreg -n Root -d1`: `CGSSessionScreenIsLocked` or `IOConsoleLocked` = Yes means locked) is sampled before every launch, every second
while the app runs and at exit; it is recorded with each launch, in each run record, and in the `displayContext` of
every display-dependent check (with WebKit's reported window visibility in that process).

The full suite builds the release app and a separate conformance app
(`--features conformance --config src-tauri/tauri.conformance.conf.json`, own `CARGO_TARGET_DIR`), then launches the
packaged binary per scenario with `SH_SCENARIO`, `SH_PHASE`, `SH_CRASH_AT`, `SH_REPORT_OUT` and `HOME` set to a fresh
directory per scenario chain (Tauri's app-data directory follows `HOME` on macOS), with bounded waits and `SIGKILL` as
"terminate the process":

| Scenario | What is checked |
| --- | --- |
| `release` | Release binary: no conformance command, crash point or `SH_*` input in its strings; app manifest and capability grant exactly the production commands; release frontend has no runner; starts offline with no socket |
| `offline` | Effective CSP, intended negative probes only, module worker + nested `import()`, worker CSP, Web Crypto, raw-body/bound/schema/ACL rejections, KaTeX in the card, SVG/PNG capture over raw binary IPC, optional WebGL, hide/show suspend-resume without catch-up, window close/reopen, no sockets |
| `restart` | §17 sequence across three processes: open → host response reference → authorize and reveal → exploration → camera → save → terminate → relaunch → exact state, presentation, event order, conservative exposures → independent task without the teaching visual → answer submitted with its frozen assistance snapshot → terminate → relaunch → reopen through host assistance (snapshot unchanged, immutable in the store) → save the reopened task → export backup. Every step is gated: a failed step (the save of the reopened task included) fails the phase, and its report lists the native calls that failed during it with the host's `reason` (host-side evidence only, never shown in the card) |
| `crash:*` | `std::process::abort()` at `intent-before-commit`, `intent-after-commit`, `intent-after-reply` (next command after the receipt) and `display-ack-before-commit`; relaunch; honest unseen / uncertain / displayed-uncertain host records; one reveal record and receipt; after resume in a visible window the host holds exactly one display acknowledgement, committed after its restart (`recoveries`) record, which stays — for `display-ack-before-commit` the checkpoint must mark the in-flight acknowledgement `ACK_NOT_PERSISTED` and the acknowledgement the restored adapter resends must carry the original display's projection digest; no duplicate reveal or prediction events; the host journal is complete (exactly one `reveal.authorized` and one `reveal.displayed` for the reveal exposure, every event the checkpoint carried present by eventId) or holds the durable loss record |
| `crash:save-before-commit` | Abort inside `save_artifact` after its writes and before its commit, armed by the runner only for the explicit Save: no partial row (no orphan or missing blob, checkpoint unchanged), the relaunch restores the previous checkpoint with every earlier event and exposure, and the repeated save commits |
| `restore` | The exported backup imported into an EMPTY store after the original store is deleted; journal, receipts, assistance and frozen answer snapshots preserved by identity; re-import adds nothing; restored state equals the original (the camera read from the restored presentation snapshot: the restored activity is closed and its learner projection shows no view); then, with the template's approval withdrawn in the process, reopening shows the archival read-only record (`CONTENT_REVOKED`; nothing evaluated, and its only control is the host's "Return to the session") and the records stay |
| `hostport-kit` | The host-agnostic HostPort conformance kit (`@experiment-kit/activity/conformance`) against the Rust store through `NativeHostPort` (subject `reference-fixture-host`): all twelve G2 steps with their HostPort assertions; restarts reopen the same SQLite store in the running app (`conformance_reopen_store`), interruptions are in-process simulated faults (`conformance_fault`). The record is checked against the docs template file (the kit's embedded schema must equal it) and written to `docs/study-harness/evidence/host-conformance-reference-fixture.json` |
| `performance` | Report §18 targets that apply to a host, measured in this app's WKWebView against the Rust host on a fresh store (`src/conformance/performance.ts`, judged by `scripts/performance-targets.mjs` against `docs/study-harness/budgets.json`): 100 lifecycle cycles after a warm-up with no surviving activity-owned workers, timers, intervals, listeners, surfaces or open activities; then, with those activities retained in the store, the quadratic activity's commit → visible frame (p95 ≤ 100 ms; worker, render, paint and the native journal acknowledgement reported separately), 60 Hz slider drags (input feedback p95 ≤ 100 ms, display frame rate ≥ 30 fps with tentative frames keeping up), playback suspended by the host and by a hidden window (no work in a 2 s window after 1 s to settle, resume without catch-up); and each spatial activity's pointer orbit input → renderer frame (p95 ≤ 100 ms) with a suspended renderer drawing nothing. Inputs are DOM events dispatched by the runner, not OS input |
| `templates` | Every installed template opened through the host (each kernel evaluated in the catalogue worker, loaded as its own chunk on first use); both spatial templates render through the packed `@experiment-kit/player-3d` chunk (frames counted from the renderer's own counters) and release every renderer resource when the card goes away; no CSP violation, no remote request, no socket |

The `restart` scenario also checks the placeholder: the card area shows `empty`, then `preparing`, before the first
surface, and `preparing` until the restored surface replaces it after a relaunch (the host's own card-state record).

Display-dependent checks need an **unlocked console session with the display awake**: WebKit reports a hidden window
otherwise, a hidden card never acknowledges a display and is suspended (A42), so those checks are recorded as
"not run (environment)", never as passed. They are marked `displayDependent` in the JSON and in the Markdown table.
The full suite still runs every other check in a locked session; afterwards, with the session unlocked,
`npm run conformance:display` completes the display-dependent ones without rebuilding.

## Security boundaries

- Commands take raw bodies only (a JSON-object invocation is refused), check the byte length before parsing, validate
  against the shared JSON Schemas, and return fixed `{ code, message }` errors without field names or values
  (`reason` on a HostPort refusal is another fixed code).
- The host never approves what the webview asks for: approved templates, group content digests, stage transitions and
  parameter domains come from the embedded `policy/approved.json`; receipts, policy revisions, idempotency keys,
  durable sequences and duplicate detection are host-owned.
- There is no path, filesystem, shell, HTTP, dialog, credential or generic command, and no core or plugin permission is
  granted. Exports and imports use host-chosen folders and content hashes, never a path from the webview.
- Production CSP and the worker CSP hook follow `docs/study-harness/native.md` N1–N10.

## Platform scope (A53)

Only the recorded macOS machine has packaged evidence (`docs/study-harness/evidence/native-conformance.md`). Windows
(WebView2) and Linux (WebKitGTK) are external gates; run the same conformance script there before claiming them.
