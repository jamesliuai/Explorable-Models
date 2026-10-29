# Embed a visualization

This guide covers two separate entry points:

- the schema 2.0 declarative player (`@explorable-models/player`), documented in the sections up to
  [Capture and export](#capture-and-export);
- the Study Harness learner surface (`@explorable-models/player/activity`), documented in
  [Study Harness learner surface](#study-harness-learner-surface).

They share the worker runtime but use different contracts.

The available distribution is the local, unreleased `0.3.0-preview.1` candidate. Do not assume these package names are
published or controlled on npm. Build and verify from this checkout:

```sh
npm ci
npm run build:packages
npm run verify:packages
```

The last command packs core, activity, player and agent. It installs the four tarballs into a fresh temporary
application with an isolated, initially empty npm cache, runs a production build without repository aliases, verifies
SSR imports, and exercises React and DOM consumers under a self-only worker/script CSP. Installation may fetch
dependency metadata and pinned dependencies from npm; playback remains local. Evidence and tarballs are in
`release/preview/`. Browser screenshots go to `/tmp/explorable-models-preview/`.

Install those exact tarballs in your application, alongside React and ReactDOM. All package versions must match. The
agent package depends on `@explorable-models/activity`, so install that tarball too. The imperative surface uses React
internally; React applications share the host's peer runtime.

```sh
npm install /absolute/path/to/explorable-models-core-0.3.0-preview.1.tgz \
  /absolute/path/to/explorable-models-activity-0.3.0-preview.1.tgz \
  /absolute/path/to/explorable-models-player-0.3.0-preview.1.tgz \
  /absolute/path/to/explorable-models-agent-0.3.0-preview.1.tgz react react-dom
```

## Plain DOM

```ts
import { createVisualizationSession, createPreset } from '@explorable-models/core/declarative';
import { mountVisualization } from '@explorable-models/player';

const session = await createVisualizationSession();
const guard = () => {
  const state = session.getState();
  return {
    sessionId: session.id,
    expectedVersion: state.version,
    ...(state.run ? { expectedRunId: state.run.id } : {}),
    operationId: crypto.randomUUID(),
    origin: 'host' as const,
  };
};
const candidate = await session.createCandidate(createPreset('wave'), guard());
await session.commitCandidate(candidate.id, guard());
const surface = mountVisualization(document.querySelector('#visualization')!, { session });

// Host-owned durable persistence. Handle storage failures without clearing session.
const artifact = session.exportDocument();
// await yourStorage.save(artifact);
// await session.restoreDocument(artifact, guard());

// On route teardown:
// surface.unmount();
// session.dispose();
```

The imperative mount owns a ShadowRoot to isolate controls from host CSS. Mount only into a dedicated element. It does not change URL, title, global navigation, or storage. Theme is `light` or `dark`; locale defaults to document locale then `en-US`. `controls: false` lets the host supply its own controls against the same session.

## React

Construct the session in a client lifecycle and retain it outside individual render calls. Dispose it when its owner unmounts. Do not dispose a shared session when only one of its surfaces unmounts.

```tsx
import { VisualizationSurface } from '@explorable-models/player';

export function Explanation({ session }) {
  return <VisualizationSurface session={session} controls theme="light" />;
}
```

`examples/consumer/react.tsx` and `dom.ts` are complete exercised entry points. React styles are scoped to the surface; aggressive global `!important` styles may still interfere, so use imperative ShadowRoot mounting when strict isolation is required. Multiple surfaces have unique SVG and label IDs. Two sessions own distinct workers, run state, subscriptions and candidates.

## Workers, SSR and CSP

Package imports do not read DOM, URL, localStorage or cookies. Session construction with the default evaluator requires a browser with module Workers and Web Crypto. Mounting is client-only. Do not create a browser session during a server render.

The default worker uses a package-relative URL. Vite production builds are verified by the packed consumer check. If your bundler cannot resolve this pattern, supply an explicit factory:

```ts
const session = await createVisualizationSession({
  workerFactory: () => new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' }),
});
// worker.ts contains: import '@explorable-models/core/document-worker';
```

Serve every worker dependency from an allowed origin. The CSP tested for this player uses `script-src 'self'; worker-src 'self'` and scoped inline styles (`style-src 'self' 'unsafe-inline'`). The Study Harness learner surface needs no inline styles; see [its policy](#content-security-policy-n1n6). There is no `unsafe-eval`. A host requiring a nonce-only style policy needs a style injection adapter; that policy is not claimed supported. Set the bundler asset base for subpath hosting. Do not supply arbitrary agent-selected worker URLs.

A failed or timed-out worker rejects the operation and retains accepted state. Late replies are discarded. Hidden-tab timers can be throttled; analytical playback advances by declared simulation steps, not wall-clock catch-up. Remounting a surface uses the same committed frame. Disposal is final; create a new session to continue.

## Capture and export

`exportSceneSvg(session, viewId)` or `surface.exportSceneSvg(viewId)` returns a frozen mounted SVG scene with revision metadata. Pause playback and commit/cancel preview first. It does not capture HTML controls, tables, or equations. The caller stores the returned SVG; do not treat it as an arbitrary HTML screenshot. This player exports SVG only; PNG and full-surface capture require a host adapter or the legacy CLI's browser capture. The Study Harness learner surface has its own SVG and PNG [capture](#capture).

JSON document artifacts are portable within the exact declared runtime. Persist the full artifact, including retained comparison definitions; saving only run IDs loses data. Legacy CLI exports remain independently playable over HTTP. Schema 1.0 snapshots are rejected by the v2 importer.

## Study Harness learner surface

`@explorable-models/player/activity` mounts Study Harness activities: the learner card, the adapter around it, and the
`HostPort` the host implements. The card renders only the `LearnerProjection` that the host's policy permits. Hidden
groups are left out of that object, not styled away. Every learner interaction goes back through a guarded binding
command. The entry does not import Three.js, `@explorable-models/player-3d`, the studio, Playwright, the CLI or provider
SDKs. The package reference is [`packages/player/README.md`](../packages/player/README.md#study-harness-learner-surface-explorable-modelsplayeractivity),
and the integration checklist is in the [handoff index](study-harness/README.md#3-integrate-into-study-harness).

### Packages

Pack the Study Harness tarballs with `node scripts/study-harness/pack.mjs`. It builds the packages and writes core,
activity, catalog, player, player-3d and agent, plus a `manifest.json` of hashes, to `release/study-harness/packages/`.
A host needs:

| Package | Why |
| --- | --- |
| `@explorable-models/core` | Model contract, sessions and worker evaluation |
| `@explorable-models/activity` | Contracts, adapter and `HostPort`. It is an optional peer of the player, but `/activity` imports it at runtime. Its separate `/conformance` entry is the host-agnostic HostPort conformance kit for the host's own tests ([external gate G2](study-harness/external-gates.md#g2-actual-study-harness-integration-a54)); the learner surface never imports it. |
| `@explorable-models/catalog` | Installed activities, the kernel worker and the host review registry |
| `@explorable-models/player` | The `./activity` entry |
| `react`, `react-dom` (`>=18.3.1 <20`) | Peers. The plain-DOM mount also uses React internally. |
| `@explorable-models/player-3d` and `three@0.186.1` | Optional. Install them only to render spatial activities in 3D. |

### Six operations: `createStudyHarnessVisualizer`

```ts
import { createInstalledCatalog } from '@explorable-models/catalog';
import { createStudyHarnessVisualizer } from '@explorable-models/player/activity';

const catalog = createInstalledCatalog({ reviews: hostReviewRecords, revocations: hostRevocations });
const visualizer = createStudyHarnessVisualizer({
  catalog, host: hostPort, maxWorkers: 4,
  surfaceDefaults: { theme: 'system', fonts: 'bundled' },
});
```

The options are those of the adapter (`catalog`, `host`, `maxWorkers`, `outboxLimit`, `clock`, `idFactory`), plus
`surfaceDefaults` (theme, tokens, fonts, assets, loaders and callbacks shared by every surface) and an optional
`mountSurface`.

| Operation | Behaviour |
| --- | --- |
| `getCapabilities()` | Installed template and model versions, schema versions, controls, stages with their actions (preview, playback, navigation, control modes, response kind), transitions, alternatives, limits, lifecycle, review scope, rendering requirements, unsupported capabilities with alternatives, and `unavailable` installed entries with the diagnostic that explains why — including entries the catalogue excluded or withdrew (`ActivityCatalog.problems()`, for example on-demand content that failed digest verification). It still answers after disposal. |
| `validate(request, signal?)` | Checks the whole `ActivityRequest`: references, current host policy, constraints and budget. The defaults are evaluated in a worker. Nothing is activated. |
| `mount(element, prepared, options?)` / `render(…)` | Mounts a learner surface for an open activity that this visualizer prepared or restored. Anything else throws `VisualizerError` (`INVALID_REFERENCE`, `NOT_FOUND` or `DISPOSED`). |
| `getState(activityId, audience)` | State for the `learner`, `tutor`, `teacher` or `host` audience: revision guards, committed versus tentative frame, persistence state, `standing` (why the activity is blocked: revoked, or expired by host time — a read that finds an expiry blocks the activity like a command), and only the observations that audience may see; a teacher or full-inspection tutor receives no scientific state or exposures while `standing` is set |
| `summarizeInteraction(activityId, options)` | Deterministic, bounded summary of an acknowledged event interval. It states omissions and never asserts mastery. |
| `dispose(activityId?)` | Without an ID, disposes every surface and activity and is idempotent. It aborts pending `validate`, `prepare`, `restore` and `sample` calls (they resolve with `DISPOSED`), stops workers, and rejects pending captures. With an ID, it closes one activity and its surfaces. |

`prepare(request, { operationId })`, `restore(artifact, { operationId, hostSessionRevision })`, `sample(…)`,
`getDiagnostics(activityId?)`, `exportDiagnostics({ activityId? })` and `inspectDeveloper(activityId)` pass through to the
adapter (see [Host diagnostics](#host-diagnostics-and-developer-inspection)). `sample` is isolated sampling that the policy authorizes separately; it never changes learner
state. `prepare` and `restore` return a `PreparedActivity`. Its `host` field (`HostActivityControl`) is the privileged
host binding: stage transitions, reveals, exploration scope, response references, independent tasks, assistance,
policy updates, revocation, suspension, save, close, `reconcile` and `forget`. Keep it in host code. Hosts that do not
want the wrapper can call `createStudyHarnessAdapter` from `@explorable-models/activity` and mount surfaces themselves.

### `HostPort`

The host implements `HostPort` (`packages/activity/src/contracts.ts`) over its authoritative store:

```ts
interface HostPort {
  getPolicy(request: { activityId: string }): Promise<HostPolicy>;
  registerActivity(request: { instance: ActivityInstance; operationId: string }): Promise<HostAck>;
  requestStageTransition(request: StageTransitionRequest): Promise<StageReceipt>;
  recordExposureIntent(request: ExposureIntentRequest): Promise<ExposureReceipt>;
  recordDisplayAck(request: DisplayAckRequest): Promise<HostAck>;
  recordAssistance(request: AssistanceRequest): Promise<AssistanceReceipt>;
  appendEvents(request: { activityId: string; events: InteractionEvent[] }): Promise<AppendResult>;
  getJournalCursor(request: { activityId: string }): Promise<JournalCursor>;
  saveArtifact(request: { artifact: ActivityArtifact; operationId: string }): Promise<HostAck & { artifactDigest: string }>;
  // Optional: the host's own exposure and assistance records and its activity state (stage, activity revision, closed,
  // context lineage), which a restore adopts; saved grants count only when these records hold them and the lineage counts them.
  getActivityRecords?(request: { activityId: string }): Promise<ActivityRecords>;
}
```

- Every method must be idempotent for a repeated idempotency key or event ID.
- The adapter accepts a receipt only as the resolved value of the call it made for that exact request. It verifies the
  receipt before anything is displayed ([activity runtime §1 and §4](study-harness/activity-runtime.md)).
- Reveals follow persist-before-reveal: the intent is committed, the receipt is verified, the projection is published,
  the surface acknowledges the exact projection digest, and then the display acknowledgement is recorded.
- Evidence-bearing work never disappears silently. A full outbox fails the command with `PERSISTENCE_BACKPRESSURE`;
  an event the adapter must record without a command uses a reserve, and one it still cannot record is journaled as a
  loss and reported by summaries ([activity runtime §5](study-harness/activity-runtime.md)).
- Implement `getActivityRecords`, including `activity`: the host's current stage, activity revision and closed state,
  its context lineage (`lineage`: `independent` from the host's activation of an independent task until it records a
  `reopen-instructional` assistance, with the first activity revision of that lineage) and the receipt that moved it to
  its current stage (`stageReceiptId`). Derive them from your own decisions (policies you issued, receipts you
  committed), never from a registered instance or from journal events the adapter wrote. The host, not a saved
  artifact, is the authority for these and for which exposure grants exist: a restore adopts the host's stage and
  revision, counts a saved grant only when the host holds the same grant and its lineage counts it, and restoring an
  earlier backup cannot erase exposure or assistance history the host holds. `reconcile()` reads the same records to
  follow the host after a divergence. A backup restores only an activity the host holds (`getJournalCursor` is read
  before anything is registered; refuse it for an activity you do not hold, and never create one from a registration
  you did not expect). Without `activity`, a restore reopens only the backup the host holds as its latest checkpoint
  (`checkpointDigest`), restricted; other backups are refused with the archival recovery. When the read itself fails
  for such a backup (it throws, or returns records that do not validate), the restore is refused with
  `PERSISTENCE_FAILED` instead (nothing is registered; retry with the same operation ID), and a refusal of the read is
  returned as the host's refusal. Without the read, saved
  grants do not count until the host authorizes the content again, the restore notes the gap, and frozen assistance
  snapshots say `complete: false`.

Two references implement this interface: the browser fixture (`examples/study-harness-host/fixture-host.ts`, labelled
as a fixture) and the native reference host (`examples/study-harness-tauri/src/native-host.ts`, which uses Rust
commands and SQLite). The [handoff checklist](study-harness/README.md#31-hostport-checklist) lists what a production
implementation must guarantee.

### Mount and dispose

```tsx
const surface = visualizer.mount(container, opened.prepared, {
  headingLevel: 3,
  nextAction: { label: 'Submit prediction', onSelect: submitPrediction }, // host-owned
  responseSlot: <HostComposer />,                                           // see below
  spatialLoader: () => import('@explorable-models/player-3d'),                 // optional
  onError: event => reportToHost(event),
});
await surface.ready;      // first committed render (and settled bundled fonts); rejects with DISPOSED if disposed first
surface.dispose();        // unmounts this surface only; idempotent; the activity stays open
visualizer.dispose(opened.prepared.activityId); // closes the activity and its surfaces
```

- **Without the wrapper.** `mountStudyActivity(container, { binding: prepared.binding('learner', surfaceId), … })`
  mounts the same card into its own shadow root, with constructable stylesheets.
- **React hosts.** Call `adoptActivityStyles(document)` once, then render
  `<StudyActivitySurface binding={binding} />`.
- **Lifecycle.** The surface registers itself with its binding and reports visibility through an
  `IntersectionObserver` and the document's visibility state. An offscreen, collapsed or hidden card suspends
  computation, and it resumes paused at the same position without catch-up ([lifecycle](study-harness/lifecycle.md)).
- **After disposal.** No surface callback reaches the host.
- **Errors.** The `onError` hook receives refused learner commands and surface failures as `{ kind: 'diagnostic' }`,
  and entries into `recoverable-failure`, `stale-policy`, `unsupported` or `disposed` as `{ kind: 'state' }`.
  Presentation fallbacks that keep the task usable (plain-text math, the 2D projection, label nudges, ignored tokens)
  go only to `onDiagnostic`.

### Response slot

The card has no transcript, microphone or answer field of its own. Pass the host's prediction or explanation composer
as `responseSlot`, a React node. The card renders it in its response region, inside the shadow root, so host
stylesheets do not reach it. Style it with React style props or the card's classes; the reference host's
`src/composer.ts` shows how. When the learner submits, store the text in the host's own records and give the activity
only a reference: `prepared.host.submitResponseRef({ operationId, response, expectedHostSessionRevision,
hostSessionRevision })`, where `hostSessionRevision` is the session revision your response transaction produced (the
activity adopts it; it never advances the host's counter itself). Corrections, disputes and deletions go through
`updateResponseRef` the same way; `observeHostSessionRevision` follows a revision you advanced elsewhere.

### Interaction and accessibility

The card follows report §9–§11; these rules are tested in `tests/browser/study-interaction.spec.ts` (fixture-host
results in Playwright Chromium, Firefox and WebKit, not manual assistive-technology evaluation).

- **Gestures.** A slider or a draggable point previews while it is moved and commits once on its completion event
  (pointer up, key up, Enter), recorded with its own kind (`pointer`, `keyboard`, `drag`; exact entry is `exact`).
  Escape, `pointercancel` (including a touch that turns into a page scroll: sliders allow vertical panning) and lost
  pointer capture cancel it. One blur rule applies to sliders and points: focus leaving an unfinished pointer or
  keyboard gesture cancels it (`blur`). A pressed slider or point takes focus, so Escape and the blur rule apply to
  pointer drags in every engine (WebKit on macOS gives a pressed range input no focus and blurs the focused element
  while handling the press; that blur belongs to the press and cancels nothing). Sliders take no explicit pointer
  capture: the native range input keeps its pressed pointer in Chromium, Firefox and WebKit, and an explicit capture
  stops WebKit's thumb from moving. After a cancel the still-pressed pointer changes nothing until it is released, and
  a value change the release itself produces (Firefox sets the release position and fires `change` after
  `pointerup`) is part of that release, never a new commit.
- **Pressed again during a commit.** A gesture that starts while the previous release is still committing follows the
  input at once, starts its preview from the run that commit produces and commits once; the earlier commit never
  resets the held control.
- **Ended by the host.** When a stage transition, policy change, suspension or context change ends a preview, or a
  draft's stage, context, policy or run changes under it, the held gesture shows the committed value again and its
  release commits nothing.
- **Draggable points** move relative to where they were pressed, snap to the control's step and range, and leave an
  axis the pointer did not move along unchanged; arrow keys move one step along one axis. Every point has the exact
  controls as a nondragging alternative.
- **Selection and probing.** The renderer supports selectable marks (one roving tab stop per drawing, Enter or Space
  to select, the selection kept as presentation state), but no bundled 1.0 template declares a selectable mark:
  the projection makes a mark interactive only when it is draggable, and the template contract has no field that
  links a selection across views. None of the bundled activities needs one (report §10.2 asks for linked probing
  “where the activity needs them”): each activity's probe is scientific state — a model parameter or the iteration
  index — so a change made in any view or control commits one run, and every linked marker is drawn from that one
  identified frame (or one tentative frame during a gesture). A presentation-only selection would instead let two
  views disagree about which point is meant. Per activity:
  - *function and derivative*: P = (p, f(p)) with its tangent of slope f′(p) on the graph of f and (p, f′(p)) on the
    graph of f′ follow p (exact entry, keyboard or dragging P), also during a preview;
  - *quadratic surface and gradient*: the point p and its gradient arrow on the contour view and (p, f(p)) with the
    3D arrow on the surface follow (pₓ, p_y) (exact entry or dragging the contour point); the two cross-sections are
    the approved axis sections y = 0 and x = 0 and deliberately do not follow p;
  - *quadratic gradient descent*: the current iterate on the landscape, the last point of the trace, the trace table's
    last row and the values follow the iteration n (navigation and playback);
  - *linear transformation*: v, Mv and the images Me₁ and Me₂ share one drawing and follow the matrix and vector
    entries; *vector orientation in 3D*: the three coordinate-plane views draw the components of the same u and v as
    the 3D view.

  `tests/activity/linked-views.test.ts` checks the agreement of these markers against analytic values from single
  projections; the browser test of P dragging checks that both figures render the same frame. The values panel and
  “Read current values” are the nondragging equivalent. Template-declared linked selection is not implemented.
- **Three resets.** Restart returns the same run to its first position; Reset view changes only the presentation
  (camera); Reset experiment (offered while a control is interactive) starts a new run from the activity's starting
  values through the guarded `resetExperiment` command and erases no history or exposure record.
- **Inert states.** In `suspended`, `stale-policy`, `unsupported`, `awaiting-persistence` and `disposed` every
  scientific control, scenario, navigation button, Reset experiment, Keep this run and Stop comparing is
  `aria-disabled` (or not offered) with a visible reason referenced by `aria-describedby` (for example “Paused by the
  host.”) and sends nothing when activated; an unfinished
  gesture ends without committing. A stale or unsupported card shows one consistent state: the projection itself
  carries a neutral instruction instead of the teaching instruction, no response prompt, no navigation and no pending
  reveal, so nothing invites work the activity cannot accept or promises content the host has not re-authorized.
  Disabled navigation buttons always say why through `aria-describedby` (already at the start, end of the computed
  run, playback not available here, a preview to finish first); lasting reasons are also shown, while the two that come
  and go with the learner's own steps (at the start, which the readout shows, and a preview, explained under the
  controls) are announced only, so the panel keeps its height. Hidden content is absent instead.
- **Recoverable failure.** After a worker timeout or crash the last accepted result stays shown and Try again
  re-issues the failed step (bounded; then Reload the activity), as specified in
  [activity-runtime §11](study-harness/activity-runtime.md#11-gestures-worker-recovery-and-disposal-9-104). Once the
  projection's recovery is `reload` (the attempts are used up), the banner offers Reload the activity through
  `onRecoveryAction('reload')` in place of Try again, which the runtime would refuse; without `onRecoveryAction` the
  action is named in the banner rather than offered as a control that does nothing. The live region says the same:
  the attempt that uses up the retries is announced once with the new status and “Reload the activity.”, and a later
  refusal of the same cause names Reload the activity, never Try again.
- **Disposed.** A card still mounted when its activity is disposed shows the disposed state at once: no figures,
  controls or values.
- **Focus.** When a stage, policy or disposal removes the focused element, focus moves to the stage instruction, or to
  the card heading when the state has no instruction (preparing, empty, disposed).
- **Announcements.** One polite live region, at most one message per 1.5 s: committed changes, relevant boundaries and
  actionable errors; the position once when playback is paused; entering a host suspension, awaiting persistence, a
  restored or a closed state, and independent work, once each; a change of the recovery the status offers while its
  state stays (worker recovery used up). A refused command says “Not applied.”, its learner-safe message and how to
  recover; when the status already presents its cause and offers a host action (Reload the activity, Return to the
  session), it names that action instead of the command's own hint, and the status is not announced a second time.
  Nothing is announced while playing or previewing, and a preview that ends without a commit (Escape, pointer
  cancellation, a revoked policy) returns to the committed frame without an “Updated” announcement; “Read current
  values” speaks the current values on request.
- **The live region follows the projection** (report §6.2). What it says stays only while the activity, stage,
  context and policy it was said under hold, the card still shows content and nothing it could mention has left the
  projection. Entering independent work, a stage or policy change, closing, a stale or unsupported state, or any view,
  mark, value, equation or control leaving the projection empties the region in the same render and drops anything
  still queued, so withdrawn values do not stay in the DOM or the accessibility tree.
- **Layout stability.** An equation is typeset when it comes on screen (KaTeX loads lazily), which changes its height,
  and a formula wider than its panel adds a hint and its plain form. While the learner's pointer is aiming at the card
  (it moved, scrolled or pressed within the last second), the element under it is kept in place by scrolling its
  container by the distance it moved, so a click aimed below an equation lands where it was aimed.

### Status, comparisons and layout

These rules are tested in `tests/browser/study-presentation.spec.ts` and `tests/player-activity/presentation-*.test.ts`
(fixture-host Chromium results and server rendering, not manual assistive-technology evaluation).

- **Before a binding exists.** `mountStudyActivityPlaceholder(container, { state: 'preparing' | 'empty', title, theme,
  … })` (React: `<StudyActivityPlaceholder />`) shows the same card frame and status vocabulary while the host prepares
  or restores an activity; dispose it before mounting the surface. Its host element carries
  `data-explorable-models-activity-placeholder`.
- **One presentation per cause.** The status banner is for states that need attention or action, with one title, the
  projection's message (never repeating the title), a tone that matches the cause and at most one recovery control: an
  in-flight reveal says it is saving and offers nothing; a reveal or display acknowledgement the host did not record
  says “Not saved yet” and offers one retry; a worker failure is one error banner (the refused command is not repeated
  in a second banner); a closed activity is titled closed. The persistence chip agrees with the banner (never “Saved”
  beside a saving or failed banner), keeps one width for every label and offers “Retry saving” only when no banner
  does. A pending reveal is named in the banner, not in a second row.
- **A still card.** Transient states are shown in place, never as a banner above the content: a tentative preview
  dashes the figures, renames their subtitle and shows “Previewing a change, not applied yet” with Apply and Cancel
  under the controls; playback shows Pause in place of Play (one width); a 2D figure reports data outside its range
  with its own indicator (Inspect values, Fit to data); legends keep an entry for every data mark whatever the frame
  draws. Nothing above a control in use moves while it is previewed or while Play and Pause are toggled.
- **Comparisons.** “Keep this run to compare” keeps the run under a label of every shown parameter by symbol
  (`η = 0.25, a = 2, x₀ = 4`). Each kept run is named by its differing parameters, drawn dashed under the current run
  with its own hollow marker shape and legend entry, and listed with the parameters and values that differ, the
  plotted values of both runs at the same n, where it was kept and where its own range ends. A differing setting that
  is not shown as a control is stated without its value (“Settings that are not shown here differ from the current
  run.”); “Same parameters as the current run.” appears only when no parameter differs. Kept runs belong to
  instructional work and are not shown on an independent card.
- **End of the run and navigation.** The end text says “numerical limit” only when the card shows a value or drawn gap
  at the limit; otherwise only the last step (“The last available step is reached.”) is named, so a hidden trace's
  outcome is never told by the end text, the playback notice or a kept run's range. Playback runs through a limit the
  card does not show to the last step, as it does for any run, and stops one step before a limit the card shows (with
  the notice “Playback stopped before a value that cannot be represented…”), so where playback stops does not tell the
  outcome either. Navigation and playback belong to
  the template's position group (the quadratic's iteration n): an independent card shows them only when the host's
  neutral scaffold keeps that group, and the learner binding refuses them otherwise
  ([activity-runtime §3](study-harness/activity-runtime.md#3-projection-62-d6)).
- **Control sections.** Controls that share a template section are one labelled group (`role="group"` named by its
  heading), for example `Matrix M` and `Test vector v`.
- **Long equations.** A typeset equation wider than its panel scrolls in a bordered region that is focusable, named
  by the equation label and described by a visible hint, and its plain-text form (which wraps) is shown beneath it;
  equations are never shrunk to fit.
- **3D fallback tables.** The coordinate table under a 2D projection lists segments, positioned marks and up to 50
  points per mark, summarises curves, sampled surfaces and fields in one row each, and says so in its notes; the
  fallback text claims “the same values” only when the table lists everything the 3D view draws. Rows are named in
  learner text: the mark's label; a segment's ID only where the 3D view shows that ID at the segment's tip (the
  segments of a directed `segments` mark or several directed segments, such as u and v); the segments of an undirected
  mark, which the 3D view never names, by their order (`Edges, segment 2`); words for a mark's several coordinates
  (`position`, `start → end`, `components`), never property keys; a point positioned by a one-point geometry is listed
  once. A coordinate
  without a value reads `Undefined: …`, or `Beyond numerical range (…)` when the projection lists its reason in
  `limitReasons`.

### Spatial loader

Spatial templates (`vector-orientation-3d`, `quadratic-surface-gradient`) declare `scene3d` views. The card calls
`spatialLoader` only when such a view becomes visible. Keep the import dynamic, for example in a module of its own
(`examples/study-harness-host/spatial-loader.ts`), so Three.js stays out of the 2D dependency graph. If there is no
loader, the import rejects, or WebGL is unavailable, the card shows a coordinate-plane projection and the full
coordinate table, reported as `SPATIAL_FALLBACK`. The tasks remain completable this way (`tests/browser/study-spatial.spec.ts`).
A disposed 3D view returns its renderer, canvas and WebGL context to a per-document pool that the next 3D view reuses
(at most two idle; [lifecycle §5](study-harness/lifecycle.md#5-known-limits)); a host that will show no 3D view for a
while can release them with the loaded module's `releaseIdleRenderers()`.

### Capture

```ts
const png = await surface.capture({ format: 'png', viewId: 'landscape', scale: 2 });
// { mimeType: 'image/png', bytes, width, height, scale, metadata, companionText, fonts }
```

- **What is captured.** Only this surface's view, matched by surface, projection and view ID. Another mounted card
  with a different camera or reveal state is never selected.
- **Who may capture.** The host policy decides: the learner projection carries `permissions.capture`, which mirrors
  `policy.export.capture` (and is false while the activity is revoked, stale, unsupported or closed). When it is false,
  `surface.capture` (`StudyHarnessSurface.capture` and `StudyActivityHandle.capture` alike) rejects with
  `CAPTURE_REJECTED` (“The host policy does not allow captures of this activity.”) before anything is read or
  serialized; a projection without an explicit grant is treated the same way. Hosts do not need to pre-filter, and the
  surface stays usable (`tests/player-activity/projection-outputs.test.ts`, `tests/browser/study-projection.spec.ts`).
- **When it refuses.** A tentative preview or running playback is rejected with `CAPTURE_REJECTED`; commit or cancel,
  or pause, first.
- **Output.** SVG output is pure SVG, with no `foreignObject`; equations appear as plain text. PNG rasterizes that SVG
  through a `blob:` image onto a canvas of at most 4096 px per side and 16,777,216 pixels (`CAPTURE_LIMITS`).
- **Metadata.** Limited to surface, projection, projection digest, frame, activity and presentation revisions, and
  view. The text and numeric companion is built from the projection, so hidden content cannot appear in it.
- **When rasterizing fails.** With `fonts: 'bundled'`, fonts that cannot be fetched are left out and the capture uses
  system fonts (`fonts: 'system'` in the result). A browser without a 2D canvas context rejects a PNG capture with
  `UNSUPPORTED_CAPABILITY`; an image that cannot be decoded, a tainted canvas or a PNG that cannot be encoded rejects it
  with `CAPTURE_REJECTED`. A rejected capture returns no bytes and leaves the surface usable; the SVG capture remains
  available (`tests/browser/study-presentation.spec.ts`).

Policy-filtered snapshots and full backups are separate artifacts, made with
`prepared.host.save({ operationId, kind: 'learner-snapshot' })` or `kind: 'backup'`. Full-window or native screenshots
are host operations.

### Archival read-only record

When `restore` refuses a verified artifact with `UNSUPPORTED_ARTIFACT` (the exact template or model is not installed,
re-evaluation does not reproduce the saved state, the artifact is a learner snapshot, or the host cannot confirm the
saved stage, activity revision and closure of a backup that is not its latest checkpoint: it provides no
`getActivityRecords`, or its records report no activity state or a stage the template does not declare) or
`CONTENT_REVOKED`, the recovery names `archivalView(artifact, { audience })` from `@explorable-models/activity`. A records
read that failed is not one of these causes: it is a retryable `PERSISTENCE_FAILED`. `archivalView` verifies the
artifact's integrity (applying registered migrations only) and describes the artifact's own records — identities, saved stage and
position, the parameter values the audience may read, exposure history and journal checkpoint — without evaluating a
model, consulting the catalogue or substituting anything. Learner and tutor views never list a backup's parameter
values (a learner snapshot's visible values are listed), receipts, digests or task references. Render it with
`mountArchivalRecord(container, view, { theme, headingLevel, labels, returnAction })` or the `ArchivalRecord` React
component from `@explorable-models/player/activity`. For the `learner` and `tutor` audiences the record shows
learner-facing words only (report §10.4, no unexplained identifiers): the view carries identities, not names, so the
host supplies `labels` — `archivalLabels(template)` builds the activity title, step names, control labels and content
group labels from the exact saved template it still holds (names for another template version are ignored) — and
anything without a name is counted, never listed by identifier; the artifact, template, model, stage and group
identifiers and the journal sequence are shown to the `teacher` and `host` audiences only. Its only control is the
host's `returnAction` (`{ label, onSelect }`, for example “Return to the session”); nothing saved can be changed. An artifact that cannot be verified (corrupted, an
unknown version, a legacy format) is refused with its diagnostics and is not interpreted. The browser fixture host
shows it after a refused restore (`tests/browser/study-projection.spec.ts`).

### Host diagnostics and developer inspection

- `getDiagnostics(activityId?)` returns host-only operational metrics: evaluation latency (commit, navigation and
  preview: count, last, p50, p95, max), the live preview queue (in flight, newest queued, accepted and coalesced
  updates), worker budget (workers, active leases by activity and purpose, idle, waiting), journal outbox (pending,
  limit, coalesced, unpersisted display acknowledgements), persistence state, surfaces and the most recent refused
  commands (operation, code and top-level path only). It contains no parameter values, quantities, labels or learner
  text.
- `exportDiagnostics({ activityId? })` returns the same record as a local, redacted export with the execution identity
  (adapter version, runtime, schema versions) attached, for a reproducible failure report. It is a plain value; the
  toolkit never transmits it, and nothing in it is content.
- `inspectDeveloper(activityId)` is the separate developer-inspection entry of report §6.2: every quantity of the shown
  frame (hidden ones included), group visibility and content digests, geometry sizes, exposures and the operational
  metrics. It is refused with `POLICY_DENIED` unless the current host policy sets `inspection.developer`; no learner,
  tutor or host binding, agent tool or surface reaches it. Keep it off in ordinary Study Harness use.

### Content security policy (N1–N6)

These requirements come from the macOS packaged run ([native decisions](study-harness/native.md)).

| ID | Requirement |
| --- | --- |
| N1 | The catalogue's kernel worker is a module worker from the application origin: `new Worker(new URL('./worker.js', import.meta.url), { type: 'module' })`. Allow `worker-src 'self'`; no `blob:` or inline workers. The worker loads each installed kernel's module from the same origin the first time it is needed (`script-src 'self'`), and `createLazyCatalog` loads each template's content chunk the same way. Pass `workerFactory` to `createInstalledCatalog` or `createLazyCatalog` if your bundler needs another construction, but never with a URL taken from an agent or from data. |
| N2 | Worker scripts need a policy too. If your WebView attaches the CSP only to HTML responses, add `default-src 'none'; script-src 'self'; connect-src 'self'` to bundled JavaScript responses. |
| N3 | Tested production policy: `default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' blob:; font-src 'self'; connect-src 'self' ipc:; worker-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; object-src 'none'`. `ipc:` is Tauri-specific. `connect-src 'self'` covers the packaged KaTeX stylesheet, which the surface fetches into a constructable stylesheet. There is no `'unsafe-eval'` and no `'unsafe-inline'`. |
| N4 | Styles never depend on `style="…"` attributes or inline `<style>` text. Component styles are adopted as constructable stylesheets, with the packaged `activity.css` as a fallback for engines without them (pass `assetBase` if you relocate assets). Content in `responseSlot` must follow the same rule. |
| N5 | Math renders with `katex.render` into DOM nodes, never `renderToString` or `innerHTML`. The limits are `trust: false`, `maxExpand: 1000`, `maxSize: 20`, 4096 code points, rejected macro and resource commands, and a plain-text fallback. |
| N6 | PNG capture rasterizes pure SVG through a `blob:` image (hence `img-src 'self' blob:`). With `fonts: 'bundled'`, the fonts are embedded in the SVG as `data:` URLs. |

The strict policy is verified only in the packaged WKWebView. The browser fixture and the dev server set no CSP.
Packaged hosts should also apply the native-command rules N7–N8 (raw, size-bounded, schema-validated command bodies;
only production commands granted) described in [native.md](study-harness/native.md).
