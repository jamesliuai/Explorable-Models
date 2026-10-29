# Native integration decisions (Tauri reference host)

Inputs: report §16–§17 and the macOS feasibility spike ([evidence](evidence/native-spike.md),
[machine-readable](evidence/native-spike.json)). Scope is the one verified macOS machine until other platforms
have packaged evidence (A53).

## Decisions derived from the spike

| ID | Decision | Reason (spike finding) |
| --- | --- | --- |
| N1 | Workers use `new Worker(new URL('./x.js', import.meta.url), { type: 'module' })`; `worker-src 'self'`; no `blob:` or inline workers | Module workers load from `tauri://localhost` with nested `import()`; `blob:` workers are blocked by policy and unnecessary |
| N2 | The host adds `default-src 'none'; script-src 'self'; connect-src 'self'` to every bundled JavaScript response through `on_web_resource_request`; windows are created in Rust | Tauri attaches CSP only to HTML responses, so worker scripts otherwise run with no policy (`new Function` executed) |
| N3 | Production CSP: `default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' blob:; font-src 'self'; connect-src 'self' ipc:; worker-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; object-src 'none'` (+ Tauri's per-file script hashes). Compared as directive sets | Minimal working set on macOS; `ipc:` avoids the postMessage fallback violation |
| N4 | Learner surface styles never rely on `style="…"` attributes or inline `<style>` text: component styles are applied with constructable stylesheets (`adoptedStyleSheets`) in the shadow root, with a bundled stylesheet asset fallback; dynamic values use CSSOM (`el.style`, React `style` props); SVG uses presentation attributes | `style-src 'self'` blocks parsed style attributes; `katex.renderToString` + `innerHTML` lost all 28 inline styles |
| N5 | Math renders with `katex.render` into a DOM node (`throwOnError: true`, host-rendered error UI), never `renderToString`/`innerHTML` | Only the DOM API keeps layout under the policy; KaTeX's error rendering uses `setAttribute('style')` |
| N6 | PNG capture: serialize pure SVG (no `<foreignObject>`), embed required fonts as `data:` inside the SVG document, rasterize via a `blob:` image onto a bounded canvas. Equations in captures use the plain-text form as SVG text plus a text/numeric companion; KaTeX canvas repaint is not used in production | `<foreignObject>` taints the WKWebView canvas; the KaTeX repaint was only a prototype |
| N7 | Native commands take raw request bodies, check byte length before parsing, validate against the shared JSON Schemas (`packages/activity/rust`), and map failures to stable error codes without echoing field names. Capture bytes travel as raw binary IPC | Tauri's automatic deserialization errors list expected field names; base64 JSON inflates captures |
| N8 | Command exposure: `tauri_build::AppManifest::commands` lists production commands only; the main-window capability grants exactly those; test-only commands exist only under the `conformance` cargo feature and are absent from the release binary (verified by an ACL rejection test and a symbol/strings check) | ACL rejected the registered-but-ungranted command; `invoke_handler` registration alone is not a permission boundary |
| N9 | Offline auditing uses CSP violation events, an app-level request log, a static bundle scan and process socket sampling | WKWebView Resource Timing reports zero entries for custom-scheme loads |
| N10 | Packaged automation: the `conformance` feature compiles an in-app scenario runner and crash-injection points; a Node driver launches the packaged binary per scenario and terminates/relaunches it (architecture D13). WebDriver is not used on macOS | Deterministic process termination at exact protocol points; no driver server in release builds |

## Open platform scope

Windows and Linux packaged runs, builds with Developer ID signing/notarization and manual assistive-technology inspection of the packaged
app are outside what this machine can establish. They are tracked as external gates in the ledger (A37, A53).

## Reference host results (packaged conformance run)

The feasibility spike grew into the packaged reference host `examples/study-harness-tauri` (see its README). Evidence:
[`evidence/native-conformance.md`](evidence/native-conformance.md) and
[`evidence/native-conformance.json`](evidence/native-conformance.json), produced by
`examples/study-harness-tauri/scripts/conformance.mjs` (or `node scripts/study-harness/native-conformance.mjs`). The
spike's sources are archived in `examples/study-harness-tauri/spike/` and are no longer built; its test-only scaffolding
(`SH_SPIKE_OUT`, auto-exit, watchdog, `spike_forbidden`) is gone from the release path.

How N1–N10 are realized in the reference host:

| ID | Realization | Verified by (conformance run) |
| --- | --- | --- |
| N1 | The catalogue kernel worker comes from `@experiment-kit/catalog`'s own `new Worker(new URL('./worker.js', import.meta.url), { type: 'module' })`, rebundled by Vite from the packed tarball (no aliases); a conformance-only probe worker checks nested `import()`, Web Crypto and fetch | `probe:module-worker`; the card's first committed frame (kernel evaluation runs only in the worker) |
| N2 | `create_main_window` (Rust) attaches `csp::add_worker_script_csp`; windows are never declared in `tauri.conf.json` | `probe:worker-eval-negative` |
| N3 | `tauri.conf.json` CSP unchanged from the spike; Vite `assetsInlineLimit: 0` | `probe:csp-effective` and the directive-set comparison in the evidence (equal apart from Tauri's per-file script hashes) |
| N4 | Host chrome uses a bundled stylesheet and CSSOM only; the composer inside the card uses React style props; the card adopts its stylesheet | `probe:inline-style-attr-negative`; no CSP violation outside the intended negative probes |
| N5, N6 | Provided by `@experiment-kit/player/activity` (KaTeX DOM rendering, pure-SVG capture rasterized via `blob:`) | `probe:katex-in-card`, `probe:explore-capture-svg`/`-png` (raw binary IPC to `conformance_capture`) |
| N7 | Every command takes `InvokeBody::Raw` (JSON-object invocations refused), bounds bytes before parsing (shared `dataLimits`), validates with `study-harness-contracts`, returns `{ code, message }` with fixed sentences | `probe:ipc-*`; Rust tests |
| N8 | `build.rs` lists production commands (conformance commands only with `CARGO_FEATURE_CONFORMANCE`) and prunes stale autogenerated permission files; `capabilities/main-window.json` grants exactly the production commands; the conformance capability is inline in `tauri.conformance.conf.json`, merged only into the separate conformance build, and leaves `conformance_ungranted` ungranted | `release-*` checks (manifest, capability, strings), `probe:acl-ungranted-command-rejected`, `probe:acl-*-plugin-*` |
| N9 | `public/csp-audit.js` records CSP violations and the origin of every fetch; the driver scans both bundles and samples the process's sockets with `lsof` | `csp-violations-only-from-intended-negative-probes`, `app-request-log-same-origin-only`, `*-no-sockets`, `frontend-remote-references-are-identifiers-only` |
| N10 | `--features conformance` + `vite --mode conformance` build a separate app (own product name, identifier, `CARGO_TARGET_DIR`); crash points `intent-before-commit`, `intent-after-commit`, `intent-after-reply`, `display-ack-before-commit` and (armed by the runner) `save-before-commit` call `std::process::abort()`; the driver sets `HOME` per scenario chain and terminates with `SIGKILL` | `restart`, `crash:*`, `restore` scenarios |

Additional findings from the reference host run:

- **A hidden window cannot complete display-dependent steps.** With the macOS console session locked (or the window
  otherwise occluded) WKWebView reports `document.visibilityState === 'hidden'`, stops animation frames and throttles
  the page; the card is suspended (A42) and never acknowledges a display, by design. The conformance runner therefore
  records display acknowledgement, live preview, lazily rendered math, captures and hide/show as "not run
  (environment)" in such a run instead of passing them. The host chrome renders with zero-delay tasks rather than
  animation frames so host state stays current while hidden.
- **Relaunch after deliberate aborts needs `-ApplePersistenceIgnoreState YES`.** After repeated `abort()`s AppKit's
  window-restoration crash history shows a modal "restore windows?" alert at the next launch, which blocks startup
  until answered. The driver passes the argument-domain default on every launch; the app is unchanged.
- **Tauri keeps stale permission files.** `tauri-build` never removes `permissions/autogenerated/*.toml` for commands
  that are no longer listed, so a conformance build would leak test-command permission definitions into a later
  release build's ACL (and the spike's `spike_report` permission had lingered). `build.rs` prunes them.
- **App data follows `HOME`.** Tauri's `app_data_dir()` on macOS derives from `$HOME`, which gives every scenario chain a
  fresh, isolated store without any test-only path input in the binary.

## Reference host: HostPort refusals, frozen answer snapshots, lock-aware runs

Added after the HostPort refusal convention landed in `@experiment-kit/activity` (`HOST_REFUSAL_CODES`,
`isHostRefusal`). Details: `examples/study-harness-tauri/README.md`.

| ID | Decision | Verified by |
| --- | --- | --- |
| N11 | The `HostPort` commands (nine, and `get_activity_records` since N14) report a host decision under the convention: `POLICY_DENIED` (also for `INDEPENDENT_CONTEXT`, `OUT_OF_DOMAIN`), `POLICY_EXPIRED`, `CONTENT_REVOKED` (exact refs no longer in the installed approval), `STALE_POLICY_REVISION`, otherwise `INVALID_INPUT`, with the specific host code as `reason` and fixed sentences only. Storage failures keep `PERSISTENCE_FAILED` / `INTEGRITY_FAILURE` (stored bytes) and stay retryable; a supplied artifact failing its manifest is a refusal. Host-owned commands keep their specific codes. The TypeScript port maps an IPC ACL rejection of a HostPort command to `POLICY_DENIED` (`reason: IPC_DENIED`) | `errors.rs` and `tests.rs` (`host_port_errors_separate_host_decisions_from_storage_failures`); `probe:ipc-*` including `ipc-host-port-refusal-recognized` (the packed `isHostRefusal` recognizes the native rejection) |
| N12 | An independent-task answer is confirmed together with the adapter's `freezeAssistanceSnapshot`; the host validates it against its own exposure and assistance records, adds its own records of the task and of the originating instructional activity, and stores it (digest-addressed) in the same transaction that marks the answer submitted. `response_snapshots` is immutable (SQLite triggers), carried by the portable backup with its identity, removed only with its response; `get_response_snapshot` exposes it for inspection (report §6.4, A26) | `independent_answers_bind_an_immutable_frozen_assistance_snapshot`; conformance `answer-submitted-with-frozen-assistance-snapshot`, `feedback-after-answer-leaves-frozen-snapshot-unchanged`, `frozen-snapshot-immutable-in-store`, `frozen-answer-snapshots-preserved:*` |
| N13 | The conformance driver samples the console lock state (`ioreg`, `CGSSessionScreenIsLocked`) before every launch, every second while it runs and at exit, and records it with each launch, each run and each display-dependent check (`displayContext`, with WebKit's reported visibility). `npm run conformance:display` (`--display-only`) re-runs only the scenario chains with display-dependent checks against the already-built apps and merges them into the evidence; it refuses unless both executables match the recorded sha256 and were built from the sources still in the tree (N24), and the session is unlocked | `runs[]` and `displayContext` in `evidence/native-conformance.json` |

The host now uses `createStudyHarnessVisualizer` (`@experiment-kit/player/activity`) for prepare, restore, mounting and
disposal instead of composing `createStudyHarnessAdapter` and `mountStudyActivity` itself. While the macOS console
session stays locked, every display-dependent check remains "not run (environment)"; none is reported as passed.

## First unlocked runs: display-dependent checks

Every native run before 26 October 2026 ran with the console session locked, so the 11 display-dependent checks were
recorded "not run (environment)". The first run with the session unlocked (`display-only-2026-10-26T14:48:34.156Z`,
against the binaries of `full-2026-10-26T13:23:35.215Z`) executed them: 112 pass, 3 fail. Both causes are resolved;
the run that produced the current evidence is listed below. Earlier runs stay in `runs[]` of the evidence as
superseded history (their scenario results belonged to other binaries).

| Failure | Root cause | Resolution | Verified by |
| --- | --- | --- | --- |
| `probe:katex-in-card`, `probe:katex-in-card@reopened`: "0 KaTeX nodes, MathML 0, strut 0.0 px" after about 4 s, although the KaTeX and Inter fonts had loaded | Probe defects, not product defects. (1) In the 1200×900 host window the equations panel starts below the fold (top ≈ 2397 px in a 1173 px viewport). The card loads the lazy KaTeX chunk, its stylesheet and fonts only once an equation is on screen (report §18: no eager math assets) and did exactly that; the probe never brought the panel on screen. (2) KaTeX 0.19 names its strut `katex-strut`; the probe measured `.strut`, so even rendered math read 0 px | The probe takes the learner's path: it records the panel's placement and requires that no KaTeX node or face exists while the panel is off screen, scrolls the panel into view, then requires KaTeX output for every equation (MathML, a strut and a formula box with non-zero layout, measured on `.katex-strut` or `.strut`) and a loaded `KaTeX_Main` face. Nothing was loosened | `probe:katex-in-card`, `probe:katex-in-card@reopened` (details: `beforeScroll`, `afterScroll`, `strutHeight`, `formulaBox`, `loadedKatexFaces`) |
| `display-acknowledged-after-resume` in `crash:display-ack-before-commit`: after the relaunch the reveal exposure stayed `uncertain` (`INTERRUPTED_BEFORE_ACK`) | Product defect in `@experiment-kit/activity`. The card displayed the trace and sent its display acknowledgement; the host's checkpoint save ran while that acknowledgement was in flight, and the host process then aborted before committing it. The artifact stored the exposure as plainly `displayed`, and the restored ledger treated a displayed record without `ACK_NOT_PERSISTED` as acknowledged by the host, so the queued acknowledgement (activity-runtime §4 step 5) was lost across the restart and never resent, while the host's restart rule had (correctly) marked the exposure uncertain. The `intent-*` points never reach a display before the crash: the restored record is `authorized` → `uncertain`, the surface displays it after resume and the first acknowledgement is recorded then | `ExposureLedger.forArtifact()`: an artifact stores a displayed record whose acknowledgement the host has not confirmed (in flight or failed) with `ACK_NOT_PERSISTED`. On restore such a record stays displayed (never reverts) and the adapter resends the identical acknowledgement (same exposure, receipt, projection digest, frame and monotonic time) once the restored activity is registered: it attests the display that happened in an active surface before the interruption. The identical request lets the host replay an acknowledgement it had committed (crash after commit, before the reply) instead of seeing a conflicting second one (`OPERATION_CONFLICT`), and record one it never committed. The host keeps its `recoveries` row next to the acknowledgement, so the earlier uncertainty is never erased. Refused acknowledgements are not resent | Vitest `tests/activity/exposure.test.ts` (crash injection, A23: in-flight acknowledgement before/after the host commit; checkpoint after a confirmed acknowledgement resends nothing); Rust `a_resent_display_ack_after_the_restart_rule_records_the_display_and_keeps_the_restart_record`; conformance `display-acknowledged-after-resume` (now also requires exactly one acknowledgement committed after the restart record and, when the checkpoint recorded the display, `ACK_NOT_PERSISTED` there and the original projection digest in the resent acknowledgement) |

The check's expectation was right under report §6.3 (persist the acknowledgement; an interruption leaves the outcome
uncertain and the content potentially exposed, never unseen); it was the adapter that lost the acknowledgement.

The same work closed G60: the restart scenario's `save-reopened` step is gated like every other step (a failed save
fails phase 3), every failed step lists the native calls that failed during it with the Rust host's `reason`
(host-side report only, never shown in the card), and the earlier `INVALID_INPUT` save failure (Rust
`INTEGRITY_FIELDS` without `assistance`, fixed in Phase 4a) is covered by the Rust tests
`rust_integrity_fields_match_the_typescript_adapter` (the Rust list read against `packages/activity/src/identity.ts`)
and `a_restored_independent_task_reopened_through_assistance_saves_its_artifact`.

Evidence of that work (now superseded history, see the last section): run `full-2026-10-26T19:12:10.157Z` (full suite, console session unlocked at start and end, WebKit
reported the window visible): 115 checks pass, 0 fail, 0 not run (environment), 0 not run; all 13 display-dependent
check results ran with `consoleLock` false. Release executable sha256
`01184903e4b4fb207a1d6b65e8951fa41d756bff172f1877fc22c127d95a3344`, conformance executable sha256
`54cb8d454f0227f1964cb8ad53a7f056655125be52d116cf2979d3791ae39c40`. Packed libraries from the complete six-package
pack `release/study-harness/packages/manifest.json` (`complete: true`, created 2026-10-26T19:04:58.919Z from commit
`910c03a` with a dirty tree, lock sha256 `804030326e78…`; manifest file sha256 `66554a9d6023…`); installed into the
host: core `e05487ce…`, activity `a88b28d9…`, catalog `3b46d426…`, player `54502b48…` (full hashes in
`examples/study-harness-tauri/packed-artifacts.json` and the evidence). An intermediate full run of the same sources
(19:07 UTC, not kept in `runs[]` because the next full run replaced the evidence before history retention existed)
failed only `display-acknowledged-after-resume`, a driver defect: it read the crashed store's checkpoint after the
relaunch had saved newer ones; the driver now reads it before the relaunch. The run `full-2026-10-26T19:08:49.191Z`
(same binaries) also passed 115/115 and is kept as history.

## Wave 1 host-port changes, HostPort conformance kit, spatial chunk and interrupted save

The reference host follows every `HostPort` and host-control change of the activity runtime's Wave 1, implemented in the
durable SQLite store (store schema 3; an older store gains the new columns when it is opened). Details:
`examples/study-harness-tauri/README.md`.

| ID | Decision | Realization | Verified by |
| --- | --- | --- | --- |
| N14 | The optional `HostPort.getActivityRecords` is a native HostPort command | `get_activity_records` (production command, granted by `main-window`): the host's exposure rows as stored (authorized, uncertain after a restart, displayed with projection digest, frame and time) and one `AssistanceRef` per assistance receipt (sequence of its `assistance.recorded` event, or the journal's end; grant summary), plus the host-owned `activity` state (stage, activity revision, closed, context lineage, `stageReceiptId`) derived from the activity row and the receipts the host issued, never from a registration, an artifact or adapter events; validated against `study-harness.activity-records`; readable for an activity whose approval was withdrawn; refused, like `get_journal_cursor`, for an activity the store does not hold | Rust `activity_records_read_back_durable_exposures_and_assistance_after_a_restart`, `activity_records_report_the_host_owned_stage_revision_closure_and_stage_receipt`, `activity_records_report_the_context_lineage_from_host_decisions_only`, `restore_reads_refuse_an_activity_the_host_does_not_hold`, `withdrawn_approval_keeps_the_records_readable_for_an_archival_view`; kit `reopen-verify/host-records-read-on-restore`, `authorize-reveal/host-stage-follows-receipt`, `authorize-reveal/stage-receipt-named`, `reopen-verify/host-activity-state`, `reopen-verify/stage-receipt-kept`, `reopen-verify/registration-keeps-host-state`, `reopen-verify/forged-grant-not-confirmed`, `reopen-verify/earlier-checkpoint-adopts-host-state`, `independent-task/independent-lineage` and every crash step's host-record assertions |
| N15 | The host session revision is host-owned | `confirm_response` is the response transaction: it stores the revision it produced (`responses.host_session_revision`) and returns it, also on replay; `src/app.ts` confirms first and passes exactly that value to `submitResponseRef` (no `expected + 1` mirror), and follows it with `observeHostSessionRevision` if the reference cannot be recorded; `register_activity` refuses a revision the host never produced | Rust `the_response_transaction_returns_the_host_session_revision_it_produced`, `a_schema_two_store_is_upgraded_in_place`; kit `prediction-reference` (`host-revision-durable`, `registration-ahead-refused`) |
| N16 | A frozen answer snapshot is stored as the adapter froze it | `check_frozen_snapshot` accepts `complete` + `limitations` (a complete snapshot names no limitation; an incomplete one says why) and `AssistanceRef.grant`, checked against the host's own assistance and exposure rows | Rust `frozen_snapshots_keep_completeness_and_assistance_grants`, `frozen_snapshot_assistance_grants_match_the_host_records`; conformance `answer-submitted-with-frozen-assistance-snapshot` |
| N17 | Close resolves an active preview under host policy | Host chrome policy (cancel / commit / keep as a draft) passed as `close({ pending })`; the store keeps the journaled resolution (`activities.closed_pending`); a restore's `report.pendingDraft` is shown to the host for re-offering | Rust `closing_records_how_a_pending_preview_was_resolved` |
| N18 | Unsupported or revoked content restores as an archival record | `get_policy` refuses an activity whose exact refs the installed approval no longer lists (`CONTENT_REVOKED`); on `UNSUPPORTED_ARTIFACT`/`CONTENT_REVOKED` the host mounts `archivalView(artifact, { audience: 'learner' })` with `mountArchivalRecord` (learner-facing names from the installed exact template, no identifiers; the only control is the host's return action; nothing evaluated); the records stay | `restore/archival-record-on-withdrawn-approval` (approval withdrawn in-process by the test-only `conformance_withdraw_approval`) |
| N19 | The card area shows the placeholder while preparing or restoring | `mountStudyActivityPlaceholder` (`empty` with nothing open, `preparing` while an activity is prepared or restored), disposed before the surface mounts | `restart/placeholder-before-the-card`, `restart/placeholder-while-restoring` |
| N20 | Spatial activities load the real lazy 3D chunk | `@experiment-kit/player-3d` and its pinned peer `three` are installed from the pack (`install-packed.mjs`, `packed-artifacts.json`); `src/spatial.ts` is the `spatialLoader` (a dynamic `import()` chunk, never loaded by a 2D activity). The catalogue worker imports each kernel's own chunk on first use | `templates` scenario: every template prepared with its kernel in the worker, kernel chunks imported by the worker chunk, `spatial-renders-frames:*` and `spatial-releases-resources:*` for both spatial templates (frames counted through the renderer's `stats()`, then geometries, materials, textures, listeners, observers and pending work all 0 after disposal), no CSP violation |
| N21 | The host-agnostic HostPort conformance kit runs against the Rust store inside the packaged app | `hostport-kit` scenario: `runHostPortConformance` (`@experiment-kit/activity/conformance`) over `NativeHostPort`, labelled `reference-fixture-host`; its restart hook is `conformance_reopen_store` (drops the host, opens the same SQLite store again, the restart rule runs) and its interruption hook `conformance_fault` (an in-process simulated fault at the named crash point: nothing after it commits, no reply, nothing answered until the store is reopened). Process terminations stay covered by `restart` and `crash:*` | `kit:*` checks, `kit-result-conforms-to-template` (the record checked against the docs template file; the kit's embedded schema must equal it), `kit-result-identifies-this-binary`; record [`evidence/host-conformance-reference-fixture.json`](evidence/host-conformance-reference-fixture.json) |
| N22 | Interrupted save and full disk are tested | Crash point `save-before-commit` inside `save_artifact` after its writes and before its commit, armed only for the explicit Save (`conformance_arm`); `SQLITE_FULL` forced with `PRAGMA max_page_count` in a Rust test | `crash:save-before-commit` (no partial rows, previous checkpoint restored, evidence retained, repeated save committed); Rust `a_full_disk_save_fails_retryably_without_partial_rows_and_keeps_evidence`, `an_interrupted_save_leaves_the_previous_checkpoint_and_no_partial_rows` (both feature sets) |
| N23 | The host journal is complete after every interruption, or the loss is recorded | Re-verified for Wave 1's replay of unacknowledged events (backups carry `journal.pendingEvents`; a restore resends them with their original IDs and sequences; the host deduplicates by eventId) | `crash:*/host-journal-complete-or-loss-recorded`: exactly one `reveal.authorized` and one `reveal.displayed` for the reveal exposure, every event the checkpoint carried present by eventId, or a durable `operation.failed` loss record |
| N24 | Packaged evidence names the sources its binaries were built from | The tree is uncommitted, so a commit and a dirty flag cannot tie a binary to its `host.rs`. Each build record lists the reference host sources (`HOST_SOURCE_INPUTS` in `scripts/build-record.mjs`: the frontend, every file under `src-tauri/src`, the build script, Cargo manifest and lock, Tauri configuration, capabilities, icons, the embedded policy, and the contracts crate with the schemas it embeds), one sha256 per file. The runner reads them before and after each `tauri build` and refuses a build during which they changed. `--no-build` and `--display-only` refuse binaries built from other sources. Every run reads the sources again when it ends (`sources` in the evidence); a change fails the run. The release pipeline's native gate compares the build records with the tree | `tests/release/native-gate.test.mjs` (`the host sources a build record names cover …`, `hostSourceDigest changes with any host source …`, `the native gate refuses evidence whose apps were not built from the reference host sources in the tree`, `the runner reads the host sources before and after each build …`); `sources` and `builds.*.sources` in `evidence/native-conformance.json` |

N23 tightened the `crash:display-ack-before-commit` expectation. In the run before Wave 1 (`full-2026-10-26T19:12:10.157Z`)
the final journal of that chain held `reveal.requested` but neither `reveal.authorized` nor `reveal.displayed`: both
were unacknowledged at the crash, not carried by the checkpoint, and lost without any record, which no check looked at.
With Wave 1 the checkpoint saved while the acknowledgement was in flight carries them and the restored adapter resends
them; the strict check now passes and would fail on the earlier journal.

The Rust host also adds `lineage` to `INTEGRITY_FIELDS` (the TypeScript adapter's list; `rust_integrity_fields_match_the_typescript_adapter`
and the `backup-with-pending-events-and-lineage` fixture in `typescript_artifact_fixtures_verify_with_the_rust_canonical_encoding`).
Without it every artifact carrying `lineage` (an independent-task checkpoint, a restored task) fails the host's integrity
check, which is the G60 failure class again; `restart/phase3-sequence` (save of the reopened task) passes with it.

### Owner-run offline procedure (not run here)

The scenarios show that the app references and fetches no remote origin, that CSP blocks remote connections and that
the app process opens no socket; the machine's network was not disabled. To check the offline and restore scenarios
with networking disabled, an owner can run on the target Mac:

1. Build and install as in the reference host README, then confirm the apps exist (`npm run conformance` once, online,
   to build them; existing identified apps can be checked with `node scripts/conformance.mjs --only=offline --no-build`).
2. Disable every network interface (System Settings → Network: turn off Wi-Fi and disconnect Ethernet, or
   `networksetup -setairportpower <device> off`), and confirm with `route -n get default` (no route) and
   `ping -c 1 1.1.1.1` (fails).
3. With the console unlocked and the display awake, run
   `node scripts/conformance.mjs --no-build --only=offline,restart,restore,templates --evidence-dir=<a new folder>`
   from `examples/study-harness-tauri` (a separate evidence folder keeps the recorded evidence unchanged).
4. Record the run (date, interfaces disabled, the command, the binaries' sha256 from the new evidence, the summary)
   next to that folder, then re-enable networking.

Nothing in this repository claims that this procedure was performed.

### Current evidence

Full packaged run `full-2026-10-29T05:53:42.866Z` from release verification `2026-10-29T05-29-41.307Z` passed **168 checks,
0 failed, 0 not run (environment), 0 not run** on one macOS machine. The console was unlocked at start and end,
and display-dependent scenarios ran in a visible window. This is reference-fixture evidence, not Study Harness
application integration or a network-disabled machine test. [Immutable native record](evidence/history/native-conformance-2026-10-29T05-56-31.432Z.json).

Release executable sha256 `ec1326175861bb619a42dd732dec967f2fd44c86d602cc710eec259868e900bb`; conformance executable sha256
`46545ff01ea37b7cc817b7be8a9b84c83468ea91608ceb5450cd91df4223f32b`. Both apps were freshly built from host sources
`sha256:260beeff1172193f317bcd9afa78d369f6328dc16a31a4ac3c9b4840b3ca5af7` (81 files),
which were unchanged at the end. The packed libraries come from the six-package manifest created
`2026-10-29T04:04:38.116Z`; the host installs its five runtime packages from that manifest, and the release pipeline
checks exact tarball hashes. Builds use `--no-sign`; release and conformance signatures are recorded as
`adhoc` and `adhoc` respectively
(linker/ad-hoc signatures). No Developer ID signing or notarization was performed.

The HostPort kit and packaged performance chain are included in the per-check evidence. The supported packaged drag
scope is 30 fps; the separate 60 fps objective is reported honestly in [performance.md §3a](performance.md#3a-packaged-reference-host-wkwebview).

### Earlier packaged evidence and fixes

The following dated runs preceded the final candidate above; their original identities and findings are retained as history.

Run `full-2026-10-27T07:14:12.490Z` (`npm run test:native -- --install-existing` from the repository root, which
installs the existing pack and runs `node scripts/conformance.mjs` in `examples/study-harness-tauri`; full suite, the
`performance` chain included; console session unlocked at start and end, WebKit reported the window visible):
**168 checks pass, 0 fail, 0 not run (environment), 0 not run**; every display-dependent check ran with
`consoleLock` false. The HostPort conformance kit passed all twelve steps (79 assertions) against the Rust store,
including the host-read assertions below. All 11 packaged performance rows were met. Release executable sha256
`611a0f4fc3bf3dc1f81dd1eaff9c982122fcb7bd45b176bd368f644c32764b33`, conformance executable sha256
`755b89834193826cd42351ef31c51776661fa4d082e3ec0a92407d9f3359568c`. Both apps were built in this run from reference
host sources `sha256:a73435318566f90bb6827d2927ca1ad888cb9d237a02c1cdd9c7891403232bcc` (80 files, N24), which were
unchanged when the run ended. Packed libraries come from the complete six-package
pack `release/study-harness/packages/manifest.json`, created 2026-10-27T06:32:44.245Z from commit `910c03a` with a
dirty tree (lock sha256 `804030326e78…`). The pack was made in the middle of other work on this tree, so it is a working
pack, not a release candidate. Installed into the host: core `9bf22eae…`, activity `7c494d93…`, catalog `0138850d…`,
player `40939a91…`, player-3d `0de6c367…` (full hashes in `examples/study-harness-tauri/packed-artifacts.json` and
the evidence). The approved policy was regenerated from that pack; only the recorded tarball integrities changed (no
template or model digest).

This run replaced `full-2026-10-27T06:42:32.273Z` (same pack, 168 of 168 checks). A review found that
`src-tauri/src/host.rs` had been edited after that run's binaries were built (the owner reports temporary
sabotage-and-restore edits after the run). The build records then named only the executables, tarballs and dist, not the sources, so nothing could
show which `host.rs` those binaries held. N24 adds the sources to the build records, the evidence and the release
gate. The apps were then rebuilt from the current tree, and the full suite was run again. The rebuilt executables have
exactly the sha256 of the earlier ones, so the binaries that run cited are the ones the current sources produce. The
earlier run stays in `runs[]` and `evidence/history/` as superseded history.

The run before it with the same pack, `full-2026-10-27T06:33:32.954Z`, failed 8 checks: `relaunch-and-resume`,
`one-reveal-record-and-receipt`, `display-acknowledged-after-resume` and `host-journal-complete-or-loss-recorded` in
both `crash:intent-after-commit` and `crash:intent-after-reply`. The host now reports its own activity revision
(below), so the restored card followed the host past the reveal the host had committed before the termination. The
host chrome derived the reveal's operation ID from the card's activity revision, so it re-issued the reveal under a
new idempotency key. The host refused it as stale, and the adapter then asked for a new authorization: two reveal
records for one reveal (A20). Fixed in the host chrome (`revealOperation` in `src/app.ts`): when the host's latest
receipt for the activity is a reveal of exactly these groups, in this stage, at the card's revisions, that no display
acknowledgement followed (`list_activity` reports it as `unacknowledgedReveal`), the host re-issues that request under
its own idempotency key and the host replays the receipt it committed. A crash-chain run into a scratch evidence folder
(38 of 38) and the full run above confirm one reveal record, one receipt and the display acknowledged after resume.

Run `full-2026-10-27T04:20:05.108Z` (the previous pack) passed 166 checks and failed `kit-overall-result` (`incomplete`): the kit in
that pack asserted the host's activity state, which the Rust host did not return yet. The run before it,
`full-2026-10-27T04:16:25.812Z` (same pack), also failed `archival-record-on-withdrawn-approval`.
The archival read-only record now carries the host's "Return to the session" action, which R29 asked for, and the
driver still required zero controls. The check now accepts that action as the record's only control
(`controlLabels` in the step detail) and still refuses any other control. Before these two runs,
`full-2026-10-27T02:38:51.987Z` passed 155 of 155 checks with the previous pack and without the `performance` chain.

Earlier runs of this work stay in `runs[]` and in `evidence/history/` with their binaries and summaries:
`full-2026-10-26T23:47:23.667Z` failed 3 checks (the save-crash relaunch phase was routed to the reveal-resume flow, a
runner defect; and the restore scenario compared the learner projection's camera of a closed activity, which no longer
carries presentation for views its stage hides — the check now reads the restored presentation snapshot);
`full-2026-10-26T23:50:19.371Z` passed 155/155 (its placeholder check was then tightened to the host's own card-state
record, which starts before the startup restore); `full-2026-10-26T23:52:53.571Z` failed only the new kit scenario's
socket check (5 samples over a 1.3 s run against a threshold of more than 5; now at least 3, as for the restore
scenario; no socket was seen); `full-2026-10-26T23:54:39.899Z` passed 155/155 with an earlier kit (before its assistance
read-back assertion was added) and an earlier pack; `full-2026-10-27T00:01:46.095Z` (the same binaries as the current
run) passed 155/155 with an earlier driver that validated the kit's record with a JSON Schema library the repository
does not declare (now: the packed kit's checker against the docs template file, after confirming the kit's embedded
schema equals it).

## Portable backup import and packaged-host performance (R06, R22)

**Backup import treats the file as data (R06).** A portable backup is an imported document from another host, so it
is untrusted (report §16). Before this change, `backup.rs` built `INSERT` column lists from the keys of each backup
row. An unknown key was listed as valid and reached SQLite as a column name; the import then failed with
`PERSISTENCE_FAILED` instead of a validation refusal. Five tables (registrations, display acknowledgements,
assistance, responses, recoveries) were not validated at all.

- Every table now has a fixed column list equal to the store schema (`backup_tables_match_the_store_schema` compares
  them with `pragma_table_info`). Exports and imports name only those columns, never a key from a file.
- `parse_backup` runs before any SQL. It requires the exact key set of the document, of its `host` and `integrity`
  objects, of each activity entry and of every row. Only the two schema-3 columns may be absent; they import as NULL.
- Every value must have its column's fixed shape: contract ID, RFC 3339 host timestamp, `sha256:` digest, hex
  address, safe integer, 0/1 flag, enumeration, bounded text or JSON object.
- The contract records are validated with the shared contracts. The host's own records must have exactly the shapes
  this host writes, for example: a display acknowledgement whose request matches its digest and names the receipt of a
  displayed exposure; assistance matching its receipt's kind and grant; a response with trimmed bounded text, a stage
  of the approved template and the exact reference the host issued; a recovery recording authorized → uncertain for an
  exposure of the activity.
- Rows must agree with each other: checkpoint and latest backup, receipt grants and exposures, unique identities
  across entries.

A file that fails is listed with `valid: false` and `INTEGRITY_FAILURE`, and its import is refused with the store
unchanged. The tests cover an unknown key in every table, an entry and the document; keys carrying SQL text (identifier
quoting, a conflict clause, a second statement, a renamed column); and 36 shape violations (`src-tauri/src/tests.rs`,
section R06). In the packaged run above, the `restore` scenario imported the backup the `restart` chain exported
through the new checks into an empty store.

**Packaged-host performance (R22).** Report §18 asks for measurements of the packaged reference host, not only of
production consumers in Chromium. The conformance runner's `performance` chain now measures, inside the packaged app's
WKWebView and against the Rust host and its SQLite store:

- input feedback and the 2D preview frame rate during 60 Hz slider drags;
- commit → visible frame, with worker, render, paint and the native journal acknowledgement reported separately;
- suspension by the host and by a hidden window, during playback (no work in a 2 s window after 1 s to settle, and
  resume without catch-up);
- the 100-cycle lifecycle stress, after which no activity-owned workers, timers, intervals, listeners, surfaces or
  open activities may remain;
- each spatial activity's pointer orbit input and a suspended renderer.

The measurements run after the 101 lifecycle activities, whose records the store keeps. Rows and rules are in
`examples/study-harness-tauri/scripts/performance-targets.mjs`, judged against `budgets.json`. The chain is part of every
full run (`scripts/scenarios.mjs`), so the release pipeline's native gate requires it, and `--display-only` re-runs it.
A hidden window records the rows as not run (environment), never as passed. The console lock state now counts
`IOConsoleLocked` as well as `CGSSessionScreenIsLocked`.

In run `full-2026-10-27T04:20:05.108Z` all 11 rows were met. Numbers and method are in
[performance.md §3a](performance.md#3a-packaged-reference-host-wkwebview); the per-row details are in the evidence.
Limits: the inputs are DOM events the runner dispatches, not OS input. The host mounts one card at a time. WebKit
exposes no heap figures. The run is one launch on one machine that was also used for other work (its load average is
recorded). The 60 fps display target was not met during the drags (56.03 fps, 23 dropped frames of 690); the usable
30 fps was.


In the current run `full-2026-10-27T07:14:12.490Z` all 11 rows were met again:

- input feedback p95 42 ms, n = 720;
- commit → visible frame p95 24 ms, n = 30;
- spatial orbit input p95 33 ms and 34 ms, n = 180 each;
- 100 lifecycle cycles with no surviving activity-owned resources.

The row's own rule still records the 60 fps display target as not met during the drags (58.56 fps p50, 32 dropped
frames of 695). The usable 30 fps was met. The load average was 14.69 / 6.71 / 5.00 at the start, so the machine was
busy with other work. Per-row details are in the evidence. The numbers of the superseded run
`full-2026-10-27T06:42:32.273Z`, which ran byte-identical executables, stay in its history record.

## Host-owned activity state in the Rust host (R01, R04)

The restore and `reconcile` adopt the host's own stage, activity revision, closure and context lineage
(`ActivityRecords.activity`, activity-runtime §9). The Rust host now returns that state from `get_activity_records`. It
derives every field from its own decisions, never from a registered instance, an artifact or adapter-written events:

- `stage`, `activityRevision` and `closed` come from the activity row its transactions write. A receipt into the
  template's closed stage, or a journaled `activity.closed`, closes the activity; the host then refuses further
  receipts.
- `lineage` is `independent` (with its task ref) for an independent-task activity, from revision 1. The host
  activates the task at its creation, at revision 0, so no grant issued at or before the activation counts again. A
  `reopen-instructional` assistance receipt starts an instructional lineage at its own revision, so its own grant
  counts. The instructional policy that precedes the reopening does not start it. An instructional activity is
  `instructional` from revision 0.
- `stageReceiptId` is the latest stage receipt when it moved the activity to the stage the host holds. It is absent
  while the activity is still in the stage it was opened in.

The reply is validated against the regenerated `study-harness.activity-records` schema. The state survives a restart
and a portable-backup import, because it is derived from the imported rows and receipts. A restore reads
`get_journal_cursor`, then `get_activity_records`, and registers only then. Both reads are refused for an activity the
store does not hold (`NOT_FOUND`, reported as `INVALID_INPUT` under the refusal convention), so a backup never creates
an activity. A registration claiming another stage, revision, closure or context is stored as the latest registration
only.

Rust tests (both feature sets, `npm run test:rust`):

- `activity_records_report_the_host_owned_stage_revision_closure_and_stage_receipt`
- `activity_records_report_the_context_lineage_from_host_decisions_only`
- `restore_reads_refuse_an_activity_the_host_does_not_hold`
- `the_listing_names_a_committed_reveal_no_acknowledgement_followed` (the resume key above)
- `shared_integrity_fixtures_reach_the_declared_decision`: the TypeScript and Rust verifiers agree on manifest order
  (R36). A reordered or swapped manifest is refused in both languages. Making the Rust check order-insensitive fails
  this test on `reordered-entries.json`.

The HostPort conformance kit checks the same semantics through the real adapter. In `authorize-reveal` it checks
`host-stage-follows-receipt` and `stage-receipt-named`. In `reopen-verify` it checks `host-activity-state`,
`host-lineage-instructional`, `host-revision-is-latest-receipt`, `stage-receipt-kept` and
`registration-keeps-host-state`. Also in `reopen-verify`:

- `forged-grant-not-confirmed`: a backup whose displayed grant names a receipt the host never issued, stored through
  `save_artifact` with a recomputed manifest, restores restricted and shows none of its groups. The host keeps its
  own receipt.
- `earlier-checkpoint-adopts-host-state`, `saved-grant-confirmed-by-host` and `host-step-after-earlier-checkpoint`: the
  honest earlier checkpoint adopts the host's stage and revision, shows the grant the host holds identically, and the
  next help request is based on the host's revision.

In `independent-task` it checks `independent-lineage`. The kit passed all of them against the Rust store in the
packaged run above (`hostport-kit`). It passes against the memory host in its `conformant` profile, and fails the
matching assertion for each sabotaged variant (`tests/activity/host-conformance.test.ts`). A host that omits its
activity state has these assertions recorded as not run, never as passed.
