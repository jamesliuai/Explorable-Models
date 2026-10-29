# External gates: protocols and handoff

Engineering completion (report §1.2, claim 1) is established by automated, reproducible evidence in this
repository. The gates below need a person, credentials, another repository or another platform. They are
**open** until someone performs them; nothing in this repository claims they have passed. Each protocol states
what to run, what to record, and what counts as passing.

## G1 Manual assistive-technology and intended-user sessions (A37)

**Why external:** requires people: an evaluator using a screen reader on the claimed platform, and intended
learners. Automated axe/semantic checks (recorded separately under A36) cannot substitute.

**Prerequisites:** a packaged reference host build (`examples/study-harness-tauri`, see its README) or the actual
Study Harness app; VoiceOver on macOS (the only platform with packaged evidence today); a session log template
(`docs/study-harness/templates/at-session-log.md`).

**Procedure per bundled activity:** (1) keyboard-only: complete every stage including reveal acknowledgement,
exact entry, scenario selection, index navigation and the table alternative; (2) VoiceOver: operate the same
tasks, confirm stage instructions, control labels, disabled reasons, live announcements (committed changes,
boundaries, errors only), "Read current values", and that hidden content is not announced before reveal;
(3) 200 % text and 400 % zoom (≈ 320 CSS px effective width): instructions and controls usable, contained scroll
only for the scene/table; (4) reduced motion: no automatic animation; (5) for spatial activities record which task
equivalence was actually tested (projection/table vs 3D), per report §11.

**Record:** evaluator role (no personal data beyond what they consent to), date, platform/AT versions, binary
sha256, activity template digest, task, outcome, defects with severity. Store outside public artifacts if it
contains personal data.

**Pass condition:** every bundled activity completed by keyboard and screen reader without blocking defects; any
defect fixed and re-verified or recorded as an accepted limitation by the owner.

## G2 Actual Study Harness integration (A54)

**Why external:** the Study Harness application, its core, persistence, policy and agent connection live in a
separate repository not available here.

**Handoff:** implement `HostPort` (`packages/activity/src/contracts.ts`) over the application's authoritative
store; validate every native argument with the Rust contract crate (`packages/activity/rust`) or the emitted JSON
Schemas (`packages/activity/schema/`); create windows with the worker CSP hook and production CSP from
`docs/study-harness/native.md`; mount `@experiment-kit/player/activity` from the packed tarballs.

**Conformance sequence:** open quadratic → host response reference → authorize and reveal → commit exploration →
camera change → save → terminate → reopen → verify state/presentation/event order/conservative exposure → independent
task without the teaching visual; repeat with termination before intent persistence, after intent acknowledgement
before display, and after display before display-ack persistence. Record results with the application's commit,
binary hash and platform.

**Run (the command the application runs):** the host-agnostic HostPort conformance kit, a separate entry of the packed
`@experiment-kit/activity` tarball: `import { runHostPortConformance } from '@experiment-kit/activity/conformance'`.
It is plain TypeScript (no Node, DOM or native imports), so the application runs it in its own test harness — Node
against its core, a browser, or its packaged WebView:

```ts
const run = await runHostPortConformance(applicationHostPort, {
  subject: 'actual-host',                                   // the caller's label; the kit never chooses it
  host: { name, commit, dirty, binarySha256, signed, platform: { os, osVersion, arch, webview } },
  packages,                                                 // name, version, sha256 from release/study-harness/packages/manifest.json
  catalog,                                                  // the installed catalogue the application serves
  hooks: {
    openActivity,           // required: the core opens the quadratic activity (IDs, host session, first policy)
    restart,                // reopen the authoritative store (or restart the core process and reconnect); resolve a fresh HostPort
    respond,                // the core's response transaction: returns the reference and the host session revision it produced
    hostSessionRevision,    // the revision the core durably holds
    authorizeReveal,        // the core raises its ceiling for held-back groups: resolves the next policy revision
    startIndependentTask,   // a fresh independent task from the activity: request, taskRef, policy
    armCrash,               // fault injection at intent-before-commit, intent-after-commit, display-ack-before-commit
  },
});
```

The kit drives the sequence through the real adapter and checks, at every step, the HostPort semantics listed in
[README §3.1](README.md#31-hostport-checklist): idempotency by operation ID and request fingerprint, receipts that echo
their request, the refusal convention (codes recognised and never retried), durable-before-return across `restart`,
authorization kept apart from display acknowledgement, duplicate-eventId deduplication and gap refusal, the host-owned
session revision, exposure/assistance read-back after a restart, artifact save idempotency and conflict,
conservative records after each interruption, and the host-owned activity state of `getActivityRecords` (the stage,
revision and stage receipt a receipt produced; the context lineage of the activity and of an independent task; a
registration that never moves that state; a backup whose grant names a receipt the host never issued, which the host's
records do not confirm; an earlier checkpoint that adopts the host's stage and revision and continues). A step whose
hook the application does not provide, or an assertion whose host read it does not offer, is recorded `not-run` with
the reason; only `openActivity` is required. When `restart` reopens the store inside a running process rather than
terminating the process (as the reference host's in-app run does), also run the process-termination sequence
(README §3.4 steps 3–4) with the application's own harness and record it as a second result.

**Record:** one result per run in the form of [`templates/host-conformance-result.md`](templates/host-conformance-result.md),
machine-readable as [`templates/host-conformance-result.schema.json`](templates/host-conformance-result.schema.json)
(`study-harness.host-conformance-result/1`). The kit's `run.result` is that record (`run.problems` lists its schema
problems and must be empty); keep `run.checks` (every assertion with its step and failure detail) as the host-side log
it references in `evidence`. Its twelve step IDs are the sequence above: `open-quadratic`,
`prediction-reference`, `authorize-reveal`, `commit-exploration`, `camera-change`, `save`, `terminate`,
`reopen-verify`, `independent-task`, `crash-before-intent`, `crash-after-intent`, `crash-after-display`. The `subject`
field labels the run `actual-host`, `reference-fixture-host` or `memory-fixture-host`; outcomes are `pass`, `fail`,
`not-run (environment)` (with its reason) or `not-run` (with its `reason`), never a pass for a step that did not run.
The kit passes against the test-only memory host (`tests/activity/host-conformance.test.ts`, with sabotaged
variants that each fail the step checking the violated semantics) and inside the packaged reference host against its
Rust store (`hostport-kit` scenario; record:
[`evidence/host-conformance-reference-fixture.json`](evidence/host-conformance-reference-fixture.json)). Both are
fixture results.


**Pass condition:** every step's assertions hold against the application's real store; results labelled as the
actual host, separate from the reference-fixture results.

## G3 Real configured host-agent trial (A57)

**Why external:** requires the real Study Harness agent path with owner-supplied provider credentials, a pinned
model configuration and a budget. This repository never stores keys or calls paid providers.

**Procedure:** using the policy-scoped activity tools (`@experiment-kit/agent`, activity tools), the agent must:
discover an approved activity; prepare it with personalised allowed parameters; inspect learner-visible state;
attempt a rejected request (out-of-domain parameter or forbidden reveal) and repair it; request a reveal through
the host; summarise interaction; save; reopen; handle a stale operation (expected revision mismatch); decline an
unsupported request (e.g. "plot a general ODE") with the advertised alternative.

**Record:** sanitized request/response identifiers, tool names, outcomes and repairs, provider/model identifier
and configuration digest, budget used; no keys, no unrelated study content. Use the opt-in recorder in
`@experiment-kit/agent` (`createTrialRecorder({ trialId, kind: 'real-agent-trial', configuration, budget, host })`;
wrap the activity relay with `recorder.relay(relay)`, mark G3 steps with `markStep`, repairs with `noteRepair` and
host-measured usage with `noteUsage`). It keeps identifiers, tool names, outcome codes, fixed-vocabulary repairs and a
configuration digest only, refuses credential-like settings, and produces a record that validates against
[`templates/agent-trial-record.schema.json`](templates/agent-trial-record.schema.json); fill
[`templates/agent-trial-log.md`](templates/agent-trial-log.md) alongside it. The recorder's redaction is tested in
`tests/agent/trial-recorder.test.ts` with a scripted caller (labelled `scripted-fixture`). The scripted conformance
sequence in `tests/agent/activity-trial.test.ts` remains separate evidence and is never presented as an LLM trial.

**Pass condition:** every step completed, rejections handled without guard bypass, results recorded.

## G4 Independent subject review (approval for Study Harness use)

**Why external:** requires a qualified human reviewer. Review packets are prepared in
`docs/study-harness/review-packets/<template-id>/`; an engineering agent cannot sign them. A completed review is
entered by the host as a `ReviewRecord` in its trusted registry, bound to the exact model `scientificRevision`,
template digest and reference-suite digest.

## G5 Additional platforms (A53 remainder)

Windows and Linux packaged evidence (WebView2 / WebKitGTK) requires those platforms. Run the reference host's
conformance runner there and add the results; until then the support claim is limited to the recorded macOS
machine.

## G6 Learning benefit

Delayed independent-performance comparison is an application-level research outcome (report §1.2 claim 3) and
outside engineering completion.
