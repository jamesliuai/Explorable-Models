# Activity runtime specification

Normative implementation notes for `@experiment-kit/activity`. Types: `packages/activity/src/contracts.ts` (records)
and `packages/activity/src/api.ts` (runtime API). Report sections are cited as §n.

## 1 Construction and authority (§5.3, D5)

`createStudyHarnessAdapter({ catalog, host, maxWorkers, outboxLimit, persistenceWaitMs, clock, idFactory })` returns a
`StudyHarnessAdapter`. Everything privileged derives from this construction context:

- `prepare()` returns `PreparedActivity` with `host: HostActivityControl` (privileged, host-only) and
  `binding(actor, bindingId)` producing an `ActivityBinding` whose `actor` is fixed. The learner surface receives
  `binding('learner', surfaceId)`; agent tools receive `binding('tutor', toolExecutorId)`; host stage buttons use
  `host`. No binding command input contains an actor, origin or review field. The privileged host control is the only
  exception: `requestStageTransition` and `requestReveal` take an optional `actor` (`learner`, `tutor` or `host`) so the
  host can attribute a step it routes for the tutor or the learner (journaled with binding `host-control`); the
  attribution is trusted because only the host holds the control.
- Only a learner binding attests display: `registerSurface` on a tutor or host binding throws `TypeError`, and their
  `acknowledgeDisplay` and `reportVisibility` calls are ignored, so the exposure stays `authorized` (report §6.3 step 4).
- Receipts are accepted only as resolved values of the `HostPort` call made for that request. Before applying, the
  adapter verifies: `contract`, `activityId`, `idempotencyKey`, `basedOnActivityRevision` equal the request;
  `policyRevision` equals the adapter's current policy revision (a higher revision forces `getPolicy` refresh and
  re-validation before any display); every requested `{groupId, contentDigest}` is present exactly; template/model
  refs equal the instance; `expiresAt` (if set) is in the future per host timestamp; the receipt ID has not been
  used for a different request; the grant's exposure ID is not held by another receipt (an exposure ID names one
  grant). Any mismatch → `RECEIPT_MISMATCH`, nothing displayed, activity unchanged, nothing left pending. A receipt that
  binds its request exactly but arrives too late to apply — expired by host time (`POLICY_EXPIRED`), or after the
  context, activity or policy changed while the host answered (`STALE_ACTIVITY_REVISION`) — is a host commitment: it
  is never displayed, but the adapter follows the host-owned activity revision (and, for a stage receipt, the stage) and
  keeps its grant (journaled `reveal.authorized`/`exposure.scope-authorized`, in the ledger outside every lineage, so it
  never counts) and its assistance reference as history, so frozen snapshots and summaries stay complete (§2). A closed
  activity keeps the stage it was closed in: no `stage.changed` is journaled after `activity.closed` (the host's records
  hold the stage it committed, and a restore adopts it); the revision is followed and the grant kept as history.
- Policy checks happen before any reveal or mutation, and before isolated sampling leases a worker. They run again
  after the host answered and before a verified receipt is applied, and before `retryPersistence` resends a kept
  authorization: a policy that expired, a revocation or a closed activity ends the kept request instead (nothing is
  resent or shown; a receipt that arrived meanwhile is kept as history). `revoked` →
  `POLICY_DENIED`; expired → `POLICY_EXPIRED`; catalogue revocation → `CONTENT_REVOKED`; approved mode requires the
  exact template/model refs in `policy.approved` AND `catalog.status(ref).revoked === false`. Expiry is judged by
  host time: the latest timestamp of the policy, a receipt, a host acknowledgement or any journal acknowledgement
  (`AppendAck.hostTimestamp`). When a journal acknowledgement shows the policy has expired, the card shows
  `stale-policy` at once and any preview or playback ends; otherwise the next command, sampling call or read finds the
  expiry and blocks the activity the same way (the card shows `stale-policy`, any preview or playback ends). Either way
  it fails with `POLICY_EXPIRED`. Reads judge standing too: `getState` reports it as `AudienceState.standing`
  (`POLICY_DENIED`, `POLICY_EXPIRED`, `CONTENT_REVOKED` or null), and while it is set the policy-authorized audiences —
  teacher, tutor with full inspection — receive no `scientific` state or `exposures`, a teacher summary and
  `inspectDeveloper` fail with that code, and the host audience keeps its full state. Callers that read the host policy
  themselves judge it with `adapter.policyStanding(policy)`, which uses the adapter's host clock (the agent tools do so
  before every step, [agent-tools §1](agent-tools.md#1-scope-model)).
- `content.revoked` is journaled once per revocation source, with payload `{ source, code, reason? }`: `host`
  (`HostActivityControl.revoke`, with the host's reason), `policy` (a policy update or refresh that revokes the activity
  or no longer approves its exact content) and `catalogue` (catalogue revocation discovered by any command, gate or
  sampling call). Repeated commands against revoked content add no further event.
- Every failure returned to the host — adapter operations (`prepare`, `validate`, `restore`, `getState`,
  `summarizeInteraction`, `sample`, `getDiagnostics`, `exportDiagnostics`, `inspectDeveloper`) and every
  `HostActivityControl` command — carries a recovery: a diagnostic without its own receives `HOST_RECOVERY[code]`, a
  fixed host-facing sentence per diagnostic code that names API operations, never content. Learner and tutor bindings
  keep the learner vocabulary (§3).

## 2 Revision spaces (§4.2, D4)

| Revision | Advanced by | Guard field | Effect of change |
| --- | --- | --- | --- |
| scientific (`ModelSession.version`, run ID) | parameter commit, scenario, reset experiment, restore, navigation (version only) | `expectedScientificVersion`, `expectedRunId` | commit/scenario/reset/restore → new run at index/time 0 |
| presentation (`presentationRevision`) | camera, view reset, selection, layout, display unit | `expectedPresentationRevision` | run, index, activity revision unchanged |
| activity (`activityRevision`) | only values carried by verified host receipts: stage transition, reveal, exploration scope, assistance | `expectedActivityRevision` + `expectedPolicyRevision` | projection recomputed; science unchanged |
| host session | host only: the host passes the revision its own transaction produced (`hostSessionRevision`) | `expectedHostSessionRevision` on response refs and `observeHostSessionRevision` | adapter adopts the host's value and never computes one |

The host owns the activity revision and the stage, and the adapter follows them: a verified receipt it can no longer
apply still advances the revision (§1); a restore adopts the host's stage, revision and closed state from
`ActivityRecords.activity` (§9); `reconcile()` reads them again and follows the host wherever they differ (after a
receipt that did not bind its request, an outcome superseded by a context change, or a host store restored from another
copy), withdrawing a kept authorization whose outcome the host's records now settle. None of these makes content
visible: grants the adapter did not apply stay history. Host-local changes never advance `activityRevision`, so the
adapter never diverges from the host-owned counter:
`submitResponseRef` and `updateResponseRef` are guarded by `expectedHostSessionRevision` and carry the
`hostSessionRevision` the host's response transaction produced (it must be greater; the adapter adopts it, it never
adds one); `observeHostSessionRevision({ expectedHostSessionRevision, hostSessionRevision })` follows a revision the
host advanced elsewhere (nothing is journaled; later events carry it); `updatePolicy` requires a higher policy
revision and `enterIndependentTask` one that is not older; `close` takes no revision guard (it is idempotent, refused
before the activity is ready, and flushes the journal first). A display-unit change is presentation; a template/content edit is an activity revision requiring new
authorization; a model change creates a new model identity and a new run. Tests in
`tests/activity/revisions.test.ts` assert each row's effects and non-effects (A03).

## 3 Projection (§6.2, D6)

`computeVisibility(template, stage, policy, exposures, context)` returns `Record<groupId, Visibility>`:

1. Start with `stage.visible` (absent if unlisted).
2. Intersect with `policy.visibleGroups` (absent if not listed).
3. In an independent context, only `policy.independentTask.neutralScaffold` groups may remain; all others absent.
4. A `solutionBearing` group is visible only if an exposure grant with `displayStatus !== 'not-displayed'`
   covers its exact `{groupId, contentDigest}` for the current activity revision lineage (stage grants count for the
   stage that issued them; reveal grants persist until the context becomes independent).
5. Controls: `stage.controls[param]` ∩ `policy.permittedControls`; `fixed` when the group is fixed.

`projectLearnerView(...)` builds `LearnerProjection` from the identified frame (committed or the ready tentative
frame of the active preview — never a mixture). Hidden quantities are not read when formatting visible ones; a
mark whose bound quantity group is absent is omitted. Equation substitution replaces `{{q:id}}` only with formatted
numerals of visible quantities; otherwise the equation is omitted. Tables have exactly as many columns as each row has cells (segments: ID, start and end coordinates; vector fields: coordinates plus one component per axis) and are capped at 200 rows with a total count. A segment mark styled with the `triangle` marker is directed and is drawn with an arrowhead (a dot when shorter than the head). Tables, view summaries, `describeCurrentValues`,
error text and `reviewNotice` are generated from the projection only. `projectionDigest` = sha256 of the canonical
projection excluding `projectionId`, `status.live` and `presentation.revision`.

A blocked activity (`status.ui` `stale-policy` or `unsupported`) projects every group absent, no navigation, no pending
reveal and a stage with a fixed neutral instruction (`BLOCKED_INSTRUCTION`) and no response prompt: nothing on the card
invites work the activity cannot accept or promises content the host has not re-authorized (§5.3, §10.4). A current
policy restores the stage's own instruction and prompt.

Projection rules added with the 2D surface work (phase 3):

- **Undefined banner.** `status.ui` is `undefined` only when the drawing itself is affected: a visible mark in a
  `scene2d`, `plot2d` or `scene3d` view whose bound quantity or primary geometry has no value. A legitimately
  conditional value that appears only in readouts, equations or tables (the collapse direction of a full-rank matrix,
  the secant slope at h = 0, the direction of a zero gradient) is shown inline with its reason and does not raise the
  banner; the drawing state (`ready`, `clipped`, …) is unchanged. `status.cause` says what the affected drawn values
  are — `undefined` (mathematical undefinedness), `numerical-limit` (overflow, underflow or iteration limit; a geometry
  gap takes the status of the frame quantity whose reason it carries) or `mixed` — and the message follows it
  (`VALUE_STATUS_TEXT`): a numerical limit is never described as "not defined" (report §8.2, A11). A `boundary` status
  at a numerical-limit end (its message is the terminal text "The next value cannot be represented…", stated only
  when the projection shows the limit) carries `status.cause: 'numerical-limit'` too; other states carry no cause. Each mark also
  lists the reasons of its numerical-limit gaps (`ProjectedMark.limitReasons`: missing geometry points, geometry gaps
  and an `undefinedReason` whose frame quantity is a numerical limit), so the drawing notes of the 2D planner and the
  3D renderer (`numerical-limit` notes, "beyond the representable range") and the 3D coordinate table ("Beyond
  numerical range (…)") word them apart from undefined values; an unclassified gap keeps the `undefined` wording.
- **Navigation is position content.** The run's position, navigation and playback belong to the template's position
  groups: quantity groups that list a position quantity (a scalar of dimension `iteration` for a discrete model — the
  quadratic's `navigation` group with `index` — or `time` for a time document; `positionGroupIds`). `navigation` is
  projected only when the stage allows navigation or playback and a position group is visible
  (`navigationVisibility`); a `fixed` group shows the position without stepping or playback. In an independent context
  a template's navigation therefore remains only when the neutral scaffold keeps a position group; a template that
  declares no position group keeps the stage's navigation in instructional work and has none in independent work.
  `navigate`, `step`, `restartPlayback` and `play` are accepted from every binding only where the projection offers
  them (`INDEPENDENT_CONTEXT` in independent work, `POLICY_DENIED` otherwise); a worker recovery that re-evaluates
  the shown position is not a navigation and still runs (report §6.2, §6.4, A25).
- **Terminal outcome text.** A numerical-limit end is content of the groups whose values reach it: `status.message`
  (`boundary`), `frame.terminal`/`terminalDetail`, `navigation.terminal`/`canStepForward` and a kept run's `boundary`
  state "The next value cannot be represented…" only when the projection shows a numerical-limit value or a drawn gap
  that stops at one (`numericalLimitShown`). Otherwise the learner sees only the position's own bound — "The last
  available step is reached." at the last index (or the end time) where the position is shown — and any other frame
  reads as not terminal, so stepping stays available (the session navigates past a limit; the values stay limit
  statuses). A hidden trace's outcome (for example divergence versus convergence) is never stated or implied by the end
  text (report §6.2, A21; `tests/activity/terminal-disclosure.test.ts`).
- **Playback across a limit.** Playback behaves the same way: the controller plays with the model session's
  `throughNumericalLimit` decision (`ModelPlaybackOptions`), asked at every frame at a numerical limit that playback
  reaches and at the shown frame when play starts at one. A limit the learner projection does not show
  (`numericalLimitShown` false under the current groups) is crossed — playback runs on to the position's own end (the
  last index or the end time) and `play` is accepted from a frame past the limit, exactly as for a run without one — so
  where playback stops, whether `play` is refused and the journaled end (`reason: 'terminal'` at the last index) are the
  same for a diverging and a converging run whose trace is hidden. A shown limit is not crossed: playback stops one step
  before it (`reason: 'numerical-limit'`), and `play` from a frame at it is refused (`OUT_OF_DOMAIN`). A limit that
  becomes shown while playback is crossing it (a reveal during playback) stops playback at the frame it has reached,
  whose end text then states the limit.
- **Playback end.** Playback that stops by itself journals `playback.ended` with `reason` (`terminal`,
  `numerical-limit`, `error`; additive in 1.0). When it stops one step before a shown limit, the status carries the
  notice `PLAYBACK_LIMIT_NOTICE` until the next navigation, commit or play, but only while the projection still shows
  the limit of the frame it stopped before (`numericalLimitShown` of that frame): a host that hides the trace afterwards
  also removes the notice, the status reads `Paused.` and `play` then crosses the limit. The limit frame stays reachable
  by stepping (report §8.4).
- **Presentation and permissions.** `projection.presentation` is the learner-visible part of the presentation
  snapshot: cameras and layers of visible views, display units of shown controls and visible quantities, and a
  selection only when its target is shown (the controller keeps the full snapshot for restore and clears an invalid
  selection on stage changes, the independent context, revocation, close and stale or revoked policy).
  `projection.permissions.capture` mirrors `policy.export.capture` (false while the activity is blocked); the learner
  surface refuses a capture with `CAPTURE_REJECTED` when it is false.
- **Coupled constraints.** A `CONSTRAINT_VIOLATION` sent to a learner or tutor binding carries the manifest's own
  learner-safe message and recovery when every parameter the constraint references is a control shown in the current
  stage (the quadratic's "η·a can be at most 4"); otherwise, and for every other code, the fixed vocabulary applies.
- **Table shortening.** Above 200 rows a sampled curve (`polyline2`/`polyline3` geometry) keeps every `step`-th sample
  plus the last one, so the whole domain stays covered (`shortened: { kind: 'every', step }`); every other table keeps
  its first and last 100 rows, i.e. the start and the current end of a trace (`shortened: { kind: 'ends' }`). Geometry
  cells use 6 significant digits, and safe integers keep every digit with locale grouping (236,196).
- **Unbounded lines.** A `segment`/`segments` mark of a 2D view with `extent: 'line'` (additive in 1.0) depicts lines:
  the renderer extends each segment to the view and clips it silently, and its endpoints are neither out-of-view data
  (no `clipped` state, no "values outside the view" indicator) nor part of the fit-to-data extent. Genuinely
  out-of-view data — points, traces, curves, transformed grids — is still reported. Used for the linear-transformation
  unchanged-direction lines and the function-derivative tangent and secant.
- **Out-of-view data (`clipped`).** Each graphical view carries `clipped: true` when visible data lie outside the
  range it shows now: a 2D view's committed camera applied to its authored bounds (the learner surface's own camera
  domain; `shownRange`), else the authored bounds; a 3D view's authored `bounds3`. Points, curves, segment ends, arrow
  tips and scaled field tips count; `reference`-role marks, `grid` marks and unbounded lines are background and never
  do. `status.ui` is `clipped` while any view is; after Fit to data (a camera that contains the data) it is not. An
  equal-aspect 2D drawing may show more than this range along one axis, never less, so the learner surface presents a
  2D view's clipped state with its own figure indicator (exact for what it draws, with Inspect values and Fit to data)
  and keeps the status banner for 3D views. The authored bounds of every installed template contain its default
  stages at default parameters (`tests/player-activity/presentation-projection.test.ts`).
- **Comparisons.** A retained run is projected from the identified frame at which it was kept, under the current
  visibility: `name` lists every differing shown parameter by its manifest symbol with the kept value (`η = 0.25`);
  a parameter that differs but is not shown as a control is stated without its value (`hiddenDifferences: true`;
  `η = 0.25, and settings not shown here`, or `settings not shown here differ from the current run` when only such
  parameters differ), and `same settings as the current run` is used only when no parameter differs (report §10.2,
  A34). `label` keeps the label it was kept under; `alignment` is
  `index`, `time` or `static` (single states; never progress wording); `positionText` and `boundary` state where the
  kept run was kept and where its own range ends (a terminal event with the last finite index, or "kept at n = 10 and
  is not computed beyond it"); `values` lists the shown values that differ (each run at its own position, `sameValues`
  counts the rest); `aligned` reads both runs' plotted values at the current n from each run's own drawn points in
  plots against the iteration index; `overlays` carries the kept run's version of each visible data mark of a 2D view
  (never reference, muted, grid, label, angle or unbounded-line marks; never interactive) for a dashed overlay. A
  hidden quantity or mark of the current run is hidden for every kept run too, and a kept run's end is stated by the
  terminal rule above. Retained runs belong to instructional work: an independent context projects none, and a learner
  snapshot saved there carries none; they are shown again after `reopenInstructional`.
- **Control sections.** `ControlSpec.section` (optional, additive in 1.0) is projected as `ProjectedControl.section`;
  every control of one section ID must carry the same label (semantic `DUPLICATE_ID`). `ProjectedControl.symbol` is the
  plain form of the manifest parameter symbol (`m_{11}` → `m₁₁`).
- **Display units.** `ActivityTemplate.quantityDisplay[quantityId].units` declares selectable display units for a
  quantity (the first is the default; all must match the quantity's dimension). `setDisplayUnit` accepts such a
  quantity ID as well as a controlled parameter; the conversion happens at the projection boundary, is presentation
  only (no run restart, no scientific revision), and is kept by backups and learner snapshots. A substituted numeral
  carries its unit only for a quantity with selectable display units (θ = 45°).

`contentDigest(group)` = sha256 of canonical JSON of every template element referenced by the group's members
(view/mark/equation/control/alternative specs including all learner text, and quantity definitions of member
quantities from the manifest). Accessible text is part of the digest.

## 4 Persist-before-reveal (§6.3, D7)

`requestReveal(groups)` / revealing `requestStageTransition(to)`:

1. Validate guards, policy and that each group is permitted by stage+policy and solution-bearing (non-solution
   groups need no receipt). Compute the exact `{groupId, contentDigest}` set the step needs (groups the stage and
   policy would show that no counting grant covers yet); nothing is projected or published before the receipt.
2. Append `reveal.requested`; call `host.recordExposureIntent` (or `requestStageTransition` with `groups`).
   Status `pendingReveal.state = 'requesting'`. On failure: keep transition pending, `PERSISTENCE_FAILED` with a
   retry action, nothing displayed. The pending request is resent unchanged — no second `reveal.requested` — when
   the host repeats the same command with the same operation ID and identical arguments (the recovery text names
   that command), or when the learner surface calls `retryPersistence`; the host's idempotency key replays a receipt
   it may already have committed. Other arguments under the same operation ID fail with `OPERATION_CONFLICT`.
3. Verify the receipt (§1). Re-check activity/policy revisions have not moved since step 1, otherwise
   `STALE_ACTIVITY_REVISION` and discard.
4. Record exposure `displayStatus:'authorized'`, append `reveal.authorized`, advance `activityRevision` to the
   receipt's value, publish the projection with `pendingReveal.state='awaiting-display'`.
5. When the surface calls `acknowledgeDisplay(projectionId, projectionDigest, surfaceId)` for a projection that
   contains the granted groups (digest must equal the published one, surface must be registered as active and not
   suspended), mark `displayed`, append `reveal.displayed`, call `host.recordDisplayAck`. If that call fails the
   exposure stays `displayed` locally, is queued for retry, and the record is marked `uncertainty:
   ACK_NOT_PERSISTED` until acknowledged. A displayed exposure never reverts. An artifact saved while the host has
   not yet confirmed the acknowledgement (still in flight, or failed) stores that record as `displayed` with
   `ACK_NOT_PERSISTED`: it never claims an acknowledgement the host may not have committed. The observed display
   interval (additive in 1.0): `displayed.monotonicMs` is the first acknowledged display; when none of the record's
   groups is in the published projection any more, the process that acknowledged it sets `displayed.endedMonotonicMs`
   and `displayed.endedBy` (`stage`, `independent`, `policy`, `revoked` or `closed`), and clears them if the groups are
   published again (an envelope from the first display to the last end). Suspension does not end the interval (the
   journal's `activity.suspended`/`activity.resumed` bound idle periods); a restored record's interval is not
   continued across processes (monotonic times have different origins).
6. Restore: an exposure that the host holds as authorized without a persisted display ack is restored as
   `uncertain` (`INTERRUPTED_BEFORE_ACK`) and treated as potentially exposed; it does not re-trigger a new reveal.
   When the surface later displays its groups, the acknowledgement of step 5 is recorded (uncertain → displayed).
   A record stored as `displayed` with `ACK_NOT_PERSISTED` stays displayed and its queued acknowledgement is resent
   as the identical request (same exposure, receipt, projection digest, frame and monotonic time): the display it
   attests happened in an active surface before the interruption. The identical request lets the host replay an
   acknowledgement it already committed (crash after commit, before the reply) instead of seeing a conflicting second
   one, and record one it never committed (crash before commit). The host keeps its own restart record of the
   uncertainty (the reference host's `recoveries` row) next to the acknowledgement; nothing erases it. When the host
   provides `HostPort.getActivityRecords` (optional, additive in 1.0), the restore also merges the host's own exposure
   and assistance records (§9), so restoring an earlier checkpoint never erases history the host holds, and a saved
   grant counts again only when those records hold the same grant (§9). A grant the host committed after the restored
   checkpoint whose receipt never reached the saving process (a crash after the host's commit, before its reply) stays
   history until exactly that request (same scope, groups, digests, stage and parameter domain) is re-issued: the
   adapter resends it as it was issued — based on the activity revision the host held before that grant, which it takes
   from the checkpoint or from a later host-held grant — so the host's idempotency replays its committed receipt and no
   second authorization is recorded (A20). When the host refuses that resumption (`INVALID_INPUT`: the operation is not
   the one that produced the grant, or another step without a host-held grant came between), nothing was recorded, and
   the request is sent again with the same operation ID, based on the host's current revision. A host that does not
   follow the refusal convention (§10) makes the refused resumption look retryable, so it stays pending.

Causal references (`causes`, at most 16 event IDs) link events journaled by the same process: `stage.changed` and the
`reveal.authorized`/`exposure.scope-authorized` of a request → its `reveal.requested`; `reveal.displayed` and
`reveal.uncertain` → the authorizing event of the same exposure; `preview.observed`, `preview.cancelled` and a
`parameters.committed` with a `previewId` → that preview's `preview.started`; `response.superseded` and
`response.invalidated` → the `response.submitted` of the response (and of the superseding response); help's
`assistance.recorded` and its grant → `help.requested`; `context.instructional-reopened` → its `assistance.recorded`.
An antecedent journaled before a restore is not named (its eventId is not known to the restored process).

Exploration: `requestExplorationScope(groups, parameterDomain)` records a `scope:'exploration'` grant. A preview
may start only if the stage allows preview, an exploration grant covers the current tentative groups and the
parameter domain, and no stage, reveal, exploration or assistance authorization is awaiting the host
(`PERSISTENCE_PENDING`); pointer moves never call the host. The authorization is re-checked for the whole gesture —
before every projection is built, on every `updatePreview` and before `commitPreview`: the stage and context it began
in, a stage that allows preview, interactive controls for every value it changes, and an exploration grant that covers
every solution-bearing group visible now. A stage or context change, a reveal or policy change that makes a group
visible that its grant does not cover, a control that is no longer interactive, or a policy found revoked or expired
ends it (`preview.cancelled` `navigation` for a stage or context change, otherwise `revoked` — `navigation` when a
policy update ends it, as before); it commits nothing and no tentative frame is projected afterwards (report §6.3,
A24, A40; `tests/activity/preview-authorization.test.ts`). This holds while `commitPreview` is in flight too: such a
change aborts the preview's commit, so the session refuses it (`commitPreview` returns `POLICY_DENIED`, or `CANCELLED`
when the card was hidden or the preview cancelled) and no `parameters.committed` follows `preview.cancelled`; a commit
the session had already applied before the change is journaled before it and its preview ends `committed`. `preview.started` is appended at gesture start,
`preview.observed` at gesture end/pause/stage change/close with at most 20 sampled rendered values (policy:
first, last, and evenly spaced by order; `omitted` counts the rest), `preview.cancelled` on cancel. Cancelling
reverts tentative parameters but never removes exposure records.

## 5 Journal and persistence (§7.2, D8)

- Every event gets `eventId` (uuid), gap-free `sequence` per activity, `operationId`, actor, revisions, frame ref,
  bounded payload (≤ 8 KiB), `monotonicMs`, `causes`.
- Payloads are closed per event type (unknown keys are rejected): `activity.prepared` `{ templateId, templateVersion,
  mode, stageId }`, `activity.opened` `{ stageId }`, `activity.closed` `{ reason, pending? }`, `activity.suspended`
  `{ reason }` (`offscreen`, `collapsed`, `hidden`, `host`), `activity.resumed` and `help.requested` `{}`,
  `content.revoked` `{ source, code, reason? }`; the other types have their own schemas (`EVENT_PAYLOADS`).
- Outbox: append locally, flush in order via `host.appendEvents` (batch ≤ 32). Ack → remove; duplicates reported by
  the host count as acknowledged; every acknowledgement's `hostTimestamp` advances the adapter's host clock (§1).
  Failure → `persistence = 'pending-recovery'`, exponential retry (bounded, host-driven
  `retryPersistence`/`reconcile`). An unanswered host call is treated as an uncertain outcome after
  `DEFAULT_HOST_TIMEOUT_MS` (15,000 ms) and resent.
- Flush first: before a stage transition, reveal, exploration scope, assistance request or close, every journaled
  event must be acknowledged. A batch still in flight is awaited for at most `persistenceWaitMs` (adapter option,
  0–60,000 ms, default `DEFAULT_PERSISTENCE_WAIT_MS` = 1,000 ms); the step is then refused with `PERSISTENCE_PENDING`
  at once — it never waits silently for the host call timeout — and the card shows `awaiting-persistence` until the
  journal is saved. Nothing was requested from the host; the host repeats the step with the same operation ID.
- Bound: `outboxLimit` (default 256) bounds unacknowledged events. Commands stop at `commandCapacity(limit)`: if
  their evidence-bearing events would exceed it, the command fails with `PERSISTENCE_BACKPRESSURE` and does not happen
  (every learner command that journals evidence: commits, scenarios, reset, navigation, stepping, playback, previews and
  retained or removed comparisons; test: `tests/activity/host-failures.test.ts`).
  Room is counted only for the events the command will journal (a preview or playback it ends, groups it requests).
  The rest of the bound, `systemReserve(limit)` (an eighth, at least two, none below four), is kept for events the
  adapter records without a command: suspension and resumption, display acknowledgements and their uncertainty,
  playback end, revocation. Viewing already covered by acknowledged exposure continues.
- Journal losses: an event the outbox still cannot accept is counted, never dropped silently. The adapter records it
  as the next journaled event once there is room — `operation.failed` with `{ operation: 'appendEvents', code,
  recoverable: false, lost: { count, types, afterSequence } }` — and until then the card shows a recoverable failure;
  `retryPersistence` clears that state only after the record is journaled. The cumulative loss stays with the
  activity: every later backup carries it (`journal.lost`, additive in 1.0), a restore keeps it, and summaries report
  it as a limitation with `complete: false`.
- Acknowledged mirror: the adapter keeps at most `ACKNOWLEDGED_MIRROR_LIMIT` (5,000) acknowledged events in memory for
  summaries; older ones are trimmed (the host journal keeps them) and summaries report them as omitted
  (`complete: false`).
- `reconcile()`: reads `host.getJournalCursor`. A cursor ahead of an outbox with nothing pending is adopted; a cursor
  that ends before acknowledged events, or runs ahead while local events are unconfirmed, is reported as a `CONFLICT`
  for the host to resolve (nothing is dropped); otherwise every unconfirmed event is resent in order and the host's
  acknowledgements or duplicate reports confirm it (resending is safe: the host dedupes by eventId). It then reads
  `getActivityRecords` (when provided) and follows the host-owned stage and activity revision (§2), reported as
  `activity: { stage, activityRevision, adopted }`. What it adopts is journaled, so summaries name every grant the
  ledger holds: each host-held grant this adapter never journaled as a history `reveal.authorized` (or
  `exposure.scope-authorized`, with `reveal.uncertain` `INTERRUPTED_BEFORE_ACK`, since it is merged as potentially
  seen), and a stage the host moved to as `stage.changed` naming the host's receipt
  (`ActivityRecords.activity.stageReceiptId`; a host that does not report it leaves the move unjournaled).
- Persistence states: `saved` (outbox empty, last ack ok), `saving` (flush in flight), `pending-recovery`
  (unacknowledged events with a recoverable failure), `failed` (host rejected an event as invalid: requires host
  action).

## 6 Summary (§7.3)

`summarizeInteraction(activityId, {audience, fromSequence, toSequence, limits})` reads the adapter's acknowledged
journal mirror (and pending events, which are reported as not yet acknowledged). Deterministic: same events +
same options → byte-identical JSON. Limits default to 20/20/32 KiB and can only be lowered. Selection of
representative committed configurations: first, last, and evenly spaced by sequence. `complete` is true only when
every event in the interval is acknowledged and nothing is omitted, and false whenever a journal loss (§5) is
recorded for the activity or in the summarized events. Text is generated from fixed sentence templates
over structured fields ("Explored N committed configurations of …"), never verbs like *understood*, *mastered*,
*knows*, *learned* (a test scans for a forbidden-word list). Learner/tutor audiences receive only values that
were visible in the projection at the event's time (recorded in the event payload as `visibleQuantities`) and only the
parameters shown as controls at that time (recorded as `visibleParameters` in `parameters.committed` and
`preview.observed`, additive in 1.0; an event recorded before that field existed falls back to the template's
controls). Teacher and host audiences receive every recorded value.

Every summary states its `mode` (`approved` or `exploratory`) and the host-resolved `reviewNotice` of the exact
template and model (both additive in 1.0). An exploratory summary's text carries the fixed sentence
`EXPLORATORY_SUMMARY_SENTENCE` ("This was an exploratory composition: it is not reviewed, and its results are not
reviewed assessment content."), so exploratory results are never presented as reviewed content (report §5.2).

## 7 Independent context and assistance (§6.4)

`enterIndependentTask(taskRef, policy)`: cancel preview (`preview.cancelled`, reason `navigation`), pause playback,
invalidate pending reveal requests (a late receipt is never applied; it is kept as history and its activity revision
followed, §1), set context independent, recompute projection
with neutral scaffold only (navigation and playback only when the scaffold keeps a position group, no retained runs,
§3), clear a selection that is no longer visible, append `context.independent-entered`. The independent card shows a fixed neutral instruction and no response prompt: the host owns the independent task statement. `requestHelp` and `reopenInstructional` go through
`host.recordAssistance` before any display change. `freezeAssistanceSnapshot(responseId)` returns exposures and
assistance references (`AssistanceRef`: receipt ID, kind, journal sequence of `assistance.recorded`, grant summary)
up to the current cursor so the host can bind them to the submitted answer; later events never change a frozen
snapshot. Its `complete` flag is false, with `limitations` saying why, when the local ledger may be partial: the
activity was restored without the host's records (the host provides no `getActivityRecords`, or the read failed), or
from a migrated artifact without an assistance list; the host's own records then govern. A restore never turns
supported work into independent work and never reopens instructional content without assistance: context comes from
the current policy, and a backup saved during independent work (or while a reopening was pending) records
`lineage.reopenRequired`; restored into instructional work, its grants do not count, `requestReveal`,
`requestExplorationScope` (for solution-bearing groups) and `requestStageTransition` fail with
`INDEPENDENT_CONTEXT`, and instructional content appears only after `reopenInstructional` has recorded assistance
through the host. A backup lists the assistance references (`ActivityArtifact.assistance`, additive in 1.0) and a restore
carries them over, so snapshots frozen after a restore still name the assistance recorded before it (A19, A26).

## 8 Deletion and correction (§7.2, A18)

`updateResponseRef` changes status through references and appends `response.superseded`/`response.invalidated`
(caused by the affected `response.submitted` events). The toolkit retains no summaries: a summary is returned to the
caller with its cursor and the `responses[].status` it saw, so the host marks summaries it stored stale by reference
when a later event changes a response they name; events are never rewritten. `forget({scope})` releases the
adapter's own cached copies: for `responses`, frozen snapshots, acknowledged journal copies, cached save outcomes and
unsent save copies of artifacts naming responses the host has deleted; for `activity`, retained comparisons, preview
samples, published projections, frozen snapshots, unsent save copies, every acknowledged journal copy and the cached
outcome of every earlier operation (saved artifacts and projections held for deduplication), including the adapter's
own `prepare` and `restore` outcomes for that activity (a restore report holds the pending draft's parameter values and
the restore notes). An operation still in
flight when `forget` runs is released when it settles: its caller receives its outcome once, the cache keeps no copy,
and a save in flight that then fails keeps no unsent copy for a retry (the retry builds the artifact anew). The
operation IDs stay used: replaying a released one with the same arguments fails with `NOT_FOUND` (path
`$.operationId`), with other arguments `OPERATION_CONFLICT`; the `forget` itself is not released and replays its own
outcome. Pending (unacknowledged) events are never released. Summaries made afterwards report the
released events as omitted.

## 9 Artifacts (§14)

`save('backup')` includes everything needed to restore (§14). `save('learner-snapshot')` includes only the
projection-filtered state (no hidden quantities, no teacher metadata, no unrestricted document). Saving during a
preview stores the committed checkpoint and the pending preview separately; it never commits or cancels it.
`restore(artifact)`: verify integrity → migrate if needed (explicit, versioned, original digest retained) →
revalidate catalogue status, current host policy and compatibility → model must exist with the exact digest
(no substitution; otherwise `UNSUPPORTED_ARTIFACT`, or `CONTENT_REVOKED` for revoked content, whose recovery names
`archivalView(artifact, { audience })`: a verified, audience-filtered read-only description of the artifact's own
records that never evaluates or substitutes a model) → re-evaluate the
saved position in the worker and compare → start paused → restore exposures conservatively (authorized without ack
→ uncertain) → merge the host's records → resend carried unacknowledged events → never duplicate reveal or prediction
events → append `artifact.restored`. Every step that changes what the artifact said is named in `report.notes`.

- Presentation: a saved camera is kept only for a template view of the matching kind (a 2D camera on `scene2d`/`plot2d`,
  a 3D camera on `scene3d`), otherwise it is null; saved layers are dropped (layers are not settable in 1.0); views the
  template does not declare are dropped; a display unit is kept only when the template lists it for that control or
  quantity; the selection is kept when the restored projection offers its target to `select` (a visible view, mark,
  displayed quantity or control) and cleared otherwise. A note is added only when something was actually removed. The
  restored presentation never widens visibility: the projection still
  shows only what the current stage, policy and grants permit, and a control the current policy no longer permits is
  not interactive.
- Lineage (additive in 1.0, `ActivityArtifact.lineage`): `endedExposureIds` names grants whose context lineage ended
  before the save; they stay in the history and never count again. Grants of the saved lineage count only when the
  activity is restored into the same context (§7).
- Host authority (report §4.2, §6.4, §14; `restoreClaims`): the host's records decide what a saved artifact may claim;
  the artifact's integrity manifest is a checksum anyone can recompute, not a signature. A backup restores only an
  activity the host already holds: the adapter first reads the host's journal cursor (a host that does not hold the
  activity refuses the read, and nothing is registered), then the host's records, and registers the restored instance
  only once its stage and revision are settled. With `ActivityRecords.activity` the restored activity adopts the host's
  stage, activity revision and closed state (a host that closed the activity restores it `read-only`; a different stage
  or revision restores it `restricted`, with a note). Without it, the saved stage, revision, closure and lineage are
  confirmed only when the host holds this exact artifact as its latest checkpoint (`JournalCursor.checkpointDigest`
  equals the artifact digest: the host stored these bytes); the restore is then `restricted` (the host may have advanced
  since). Otherwise the restore is refused with `UNSUPPORTED_ARTIFACT` (path `$.instance.stage`) and the archival
  recovery: an earlier checkpoint, or an edited one, cannot be reopened on a host that cannot say where the activity is.
  A host that provides `getActivityRecords` but did not answer it (the read throws, or its reply does not validate) has
  not said that: such a restore is refused with `PERSISTENCE_FAILED` (path `$`, nothing registered), which is not
  cached under the operation ID, so the same operation can be retried; a refusal of the read is returned as the host's
  refusal.
  A saved exposure grant counts again only when all three hold: the artifact's own lineage marks count it (below; they
  only ever restrict), the host's records hold the same grant — exposure ID, receipt ID, scope, exact group digests,
  stage, revision, parameter domain and references — and the host's context lineage counts it
  (`ActivityRecords.activity.lineage`: the same context, and `activityRevision` at least `fromActivityRevision`).
  Restored into instructional work, instructional solution-bearing content and stage transitions wait for
  `reopenInstructional` whenever the host still holds the activity in independent work, whatever the artifact claims.
  A host that reports its state without its lineage confirms the saved lineage only through its latest checkpoint;
  otherwise no saved grant counts and, in instructional work, a reopening is required (conservatively, since whether the
  activity left independent work is unknown). Other grants stay history and the restore is `restricted`. A host that
  returns no records (no `getActivityRecords`, a failed or invalid read) never confirms a saved grant: saved grants do
  not count and solution-bearing content is shown again only after the host authorizes it. An edited backup therefore
  cannot widen what is shown beyond what the host's own records authorize: dropping lineage marks, claiming
  instructional context, editing the stage, closure or grants, or restoring onto a host store that does not hold the
  activity (tests: `tests/activity/host-authority.test.ts`).
- Closed activities: a restored closed activity (saved closed, or closed by the host) is suspended at once, as `close`
  does, so a historical card holds no worker lease; host suspension and visibility never resume it.
- Host records: with the optional `HostPort.getActivityRecords`, exposure records the artifact lacks are added as
  history that never counts for visibility (authorized without an acknowledgement → `uncertain`,
  `INTERRUPTED_BEFORE_ACK`); a record the host holds as displayed upgrades a local record that is not displayed;
  assistance references the artifact lacks are added (sequence of their `assistance.recorded` event, or the host
  journal's end as an upper bound). A host without the read still restores, with a note, and frozen assistance
  snapshots report `complete: false`.
- Journal: a backup carries its unacknowledged events (`journal.pendingEvents`, the longest contiguous prefix within
  1 MiB, `PENDING_EVENT_BYTES`). A restore resends those the host journal lacks, with their original IDs and sequences
  (the host deduplicates by eventId), after confirming that the host journal ends at the checkpoint or within the
  carried events (its last event ID); events already in the host journal are not resent. Events that cannot be
  recovered — not carried, a host journal that ends before the checkpoint or continued with other events — are
  recorded as a journal loss (§5) in the restored journal's terms: after the last event of the journal the activity now
  continues (the host cursor plus resent events), never past the end of a later checkpoint. A loss the artifact carried
  is clamped to the host cursor in the same way (the original sequence is named in the restore notes), so every later
  backup validates.
- Pending preview: a preview active at the save is the backup's `pending` draft and is never committed by a restore;
  `report.pendingDraft` returns it so the host can re-offer it.
- Assistance references are host records like exposures: a backup lists them when there are any (a grant summary must
  match the exposure record of the same receipt), a learner snapshot never carries them, and a migrated 0.9 draft
  (whose format had no such list) restores with a note that earlier assistance is known only from the host journal.

`close({ reason, pending })` resolves an active preview under the host's policy (report §14; default `cancel`):
`cancel` journals `preview.observed` (`interrupted`) and `preview.cancelled` (`navigation`); `commit` commits the
preview's latest tentative values through the guarded commit path, attributed to the host (`parameters.committed` with
the `previewId`, then `preview.observed` `committed`), and the close fails with nothing closed if that commit fails;
`retain` journals `preview.observed` (`interrupted`) without committing and keeps the draft, which every later backup
records as `pending` (a restored closed activity keeps it). `activity.closed` records the choice (`pending`) when a
preview was resolved. Exposure records and the journaled observations survive every choice.

## 10 Host refusals and persistence failures (§6.3, §7.2)

A `HostPort` method that decides against a request rejects with an error or plain object whose `code` is one of
`HOST_REFUSAL_CODES`: `POLICY_DENIED`, `POLICY_EXPIRED`, `CONTENT_REVOKED`, `STALE_POLICY_REVISION`, `INVALID_INPUT`
(`hostRefusal(code, message)` builds one; `isHostRefusal(value)` recognises one). The host decided and recorded
nothing, so the adapter:

- reports that code at path `$.host` with a fixed sentence (`hostRefusalDiagnostic`; the host's message is never
  echoed; learner and tutor bindings see the learner vocabulary for the code);
- keeps nothing pending and never retries it: a refused stage transition, reveal, exploration scope or assistance
  request leaves no `pendingReveal`, `retryPersistence` does not resend it, and the same operation ID returns the same
  refusal; a refused save keeps no artifact for a retry; a refused display acknowledgement leaves the exposure
  `displayed` without an `ACK_NOT_PERSISTED` uncertainty and is not resent;
- journals `operation.failed` with the code and `recoverable: false`, and refreshes the policy after a policy refusal
  (a newer revision or a revocation then governs the card);
- treats a refused journal batch as a permanent failure (`persistence: 'failed'`, events kept, no automatic retry).

Every other rejection — a transport error, a timeout, a failed write, a crash, any other code — is a persistence
failure: the outcome may be uncertain, the request is retryable and the adapter reports `PERSISTENCE_FAILED` as in §4
and §5. The agent tool `activity_request_reveal` reports a refusal as `denied`, never `pending`. The test-only memory
host (`tests/activity/support/memory-host.ts`) and the browser fixture host (`examples/study-harness-host/fixture-host.ts`)
refuse policy decisions this way; tests: `tests/activity/host-refusal.test.ts`, `tests/agent/activity-tools.test.ts`.
The memory host's `conformant` profile reports every decision against a request under the convention (`INVALID_INPUT`
with the specific code as `reason`, as the reference host does), refuses a registration claiming a host session
revision it never produced, and refuses instructional grants while its own policy names an active independent task.
The default `test-double` profile reports other rejection codes, which the adapter treats as retryable persistence
failures, and accepts both of those requests; the core restore, authority, independence and exposure suites therefore
also run against the `conformant` profile (`tests/activity/conformant-profile.test.ts`), with setups a conforming host
accepts (the host produces the session revision a restore names, and ends the independent task in its policy before it
reopens instructional work). The host-agnostic HostPort conformance kit
(`runHostPortConformance`, `@experiment-kit/activity/conformance`; [external gates G2](external-gates.md#g2-actual-study-harness-integration-a54))
checks a host for this convention, idempotency, durable-before-return and the other `HostPort` semantics through the real
adapter.

Test-fixture decision (2026-10-28): retain `test-double` as the explicit adversarial fixture default. Its arbitrary
rejection codes and permissive registrations exercise recovery from hosts that do not follow the refusal convention;
changing the default would stop exercising those paths. The six duplicated restore/authority/independence/exposure/
host-authority/deletion suites in `conformant-profile.test.ts` and the HostPort conformance kit supply the separate
evidence for a conforming host. Production hosts must follow the convention above. The test double is never exported
or used as a host implementation.

## 11 Gestures, worker recovery and disposal (§9, §10.4)

- **Gesture provenance.** `parameters.committed.gesture` records how a run was started: `commitPreview` records the
  preview's gesture (`pointer`, `keyboard`, `drag`), and `commitParameters` takes an optional `gesture` (default
  `exact`) so a pointer, keyboard or drag gesture that had no authorized preview commits its draft as itself. Exact
  entry records `exact`; scenarios (`cause: 'scenario'`) and Reset experiment (`cause: 'reset'`) record no gesture.
  An unknown gesture is `INVALID_INPUT`.
- **Gestures the host ends.** A preview interrupted by a stage transition, a policy change, a reveal or grant change
  that leaves it unauthorized (§4), a policy found expired, a suspension, a context change or close is journaled
  `preview.cancelled` (`navigation` or `revoked`, by the controller) and commits nothing. The learner surface treats the interrupted gesture as ended: the still-pressed pointer or held key neither
  previews nor commits, and a surface gesture without a preview (a draft) ends the same way when the stage, context,
  policy revision or run changes under it. A preview still open when the card becomes inert (for example while it
  awaits persistence) is cancelled by the surface as `superseded`, and its release commits nothing either
  ([learner surface: interaction and accessibility](../embedding.md#interaction-and-accessibility)).
- **Worker failure recovery.** A worker timeout or crash (`WORKER_TIMEOUT`, `WORKER_ERROR`) keeps the last accepted
  frame (the model session marks it stale; it is never presented as recomputed), the evaluator terminates the failed
  worker and recreates one inside the same lease on the next evaluation, and the status is `recoverable-failure`
  with recovery `{ action: 'retry', label: 'Try again' }`. The controller records the operation the failure
  interrupted: a commit (parameters, cause and provenance, scenario ID), a navigation (the requested position and
  cause), the active preview's newest value, or — for a failed playback tick — the shown position. `retryPersistence`
  (the projected `retry`) first resends paused evidence as in §5 and §10, then re-issues that operation once through
  the same guarded command path with fresh guards; it is journaled as the retrying actor's operation (for example one
  `position.changed` to the requested index). A re-issued commit or navigation that the current stage or policy no
  longer permits is not replayed: the shown position is re-evaluated instead (a `position.changed` with equal `from`
  and `to`). Once the preview of a failed tentative evaluation has ended there is nothing left to recompute and the
  failure clears. Any accepted evaluation ends the episode. Recovery is bounded: after
  `WORKER_RECOVERY_ATTEMPTS` (3) failed attempts the status keeps `recoverable-failure` and the last accepted frame,
  appends “Trying again did not restore the calculation.” and offers `{ action: 'reload', label: 'Reload the
  activity' }`; further retries fail with `WORKER_ERROR` without evaluating. Tests:
  `tests/activity/worker-recovery.test.ts`, `tests/browser/study-interaction.spec.ts` (G38).
- **Disposal.** `dispose()` publishes nothing new but notifies the binding's listeners exactly once, at the end of
  disposal, with the final projection (`status.ui: 'disposed'`, no frame, views, controls or scenarios), then clears
  them; a surface that is still mounted therefore shows the disposed state at once instead of stale figures and live
  controls. No listener is called after that, and every later command fails with `DISPOSED`.
