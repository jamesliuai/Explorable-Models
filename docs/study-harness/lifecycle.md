# Scheduling, suspension and worker-pool policy

Report §9 and §18; A41–A43; architecture D11. This page states how computation is scheduled, when it stops, which
worker-pool policy is used and why, and the counts measured by the automated lifecycle tests. Measurements are
fixture results (Chromium through Playwright 1.64 against the Vite dev server, Node 22 for unit tests, on the
development machine: macOS 26.6, Apple M3). They are not packaged-WebView or Study Harness host measurements, and
they are counts, not p50/p95 latency or memory budgets (§18 asks for those separately). The same spec also runs in
Playwright's Firefox and WebKit (`npm run test:cross-browser`); the counts in §4 are the Chromium run's, and §5 says
how the 3D renderer avoids the one engine difference found (WebKit's count of lost WebGL contexts).

## 1 One interaction authority per activity

| Layer | Authority | Scheduling |
| --- | --- | --- |
| Activity (`@explorable-models/activity`) | one activity controller per activity, owning one guarded `ModelSession` | commands run in call order; journal appends never contact the host directly: one flush per turn (microtask) |
| Model session (`@explorable-models/core/model`) | primary slot (committed run, navigation, playback) and scratch slot (previews) | previews through `createPreviewCoordinator`: at most one active evaluation plus one newest queued value; superseded values resolve `null`; a new epoch (commit, cancel, navigation, suspension, disposal) discards late replies |
| Document controller (`@explorable-models/core/declarative`) | `createDocumentInteractionController`: primary session + scratch session (created on the first preview) | the same preview coordinator; identified tentative frames `{ previewId, sequence, baseRunId }`; examples (`examples/showcase`, `examples/hinged-rod`) use it |
| Learner surface (`@explorable-models/player/activity`) | renders projections; never computes | no animation loop in 2D; `requestAnimationFrame` only while a capture waits for the current projection to reach the DOM |

Timers owned by the runtime, all cleared on completion, suspension or disposal:

| Timer | Interval | Exists while |
| --- | --- | --- |
| Playback tick (model session) | 400 ms per discrete index; document time step clamped to 16–1000 ms | playing and not suspended |
| Evaluation watchdog (model and document evaluators) | 5 s per job; a timeout terminates the worker, which is recreated lazily | a job is in flight |
| Host call timeout (journal outbox) | 15 s per `appendEvents` call | a flush is in flight |
| Outbox retry | exponential from 500 ms to 30 s, at most 8 automatic attempts, then explicit `retryPersistence` / `reconcile` | the host did not confirm a batch |
| Announcer (surface live region) | at most one polite announcement per 1.5 s | an announcement is pending |

Nothing in the runtime uses `setInterval`.

## 2 Worker-pool policy: dispose on release

The adapter creates one `createWorkerBudget({ maxWorkers, workerFactory })` and every activity's model session leases
workers from it; the document controller accepts the same budget through its `budget` option.

- **Policy used: `idleMs: 0`, dispose on release.** A released lease terminates its worker at once; no idle worker
  is kept for reuse. Why: ownership stays deterministic (no worker survives behind a suspended or historical card,
  which the lifecycle stress test checks), and reuse has not been measured to help — worker start-up of the catalogue
  module worker is a one-off cost per lease, while an idle pool would need its own eviction and accounting. Reuse
  remains available as an opt-in (`idleMs > 0`, idle workers count toward `maxWorkers`) if a measurement justifies it.
- **Bounds**: adapter default `maxWorkers` 4 (at most 64); a bounded FIFO wait queue (32) beyond which leasing fails
  with `RESOURCE_LIMIT`; `primary` requests wait ahead of `scratch` and `sample` requests. A wait is also bounded in
  time: a request not granted within `maxWaitMs` (default 10 000 ms, `createWorkerBudget` option) fails with
  `RESOURCE_LIMIT` — “No worker became free within … ms” — and the recovery “Suspend, hide or close another activity
  (or configure more workers), then retry”, instead of waiting without a diagnostic (report §5.3).
- **Who holds what**: an active activity holds its primary lease; the scratch lease is acquired by the first preview
  and kept between gestures, but once a preview ends (commit, cancel, a failed value, navigation) the session marks it
  *reclaimable* (`Lease.setReclaimable`). Whenever any request would otherwise wait, the budget releases the oldest
  reclaimable lease — terminating its worker — and grants the request, so an idle scratch worker never keeps another
  activity's prepare or commit waiting (report §9 “Budget scratch workers across activities”); the card leases again on
  its next preview. A gesture in progress keeps its scratch lease; a primary lease is never reclaimed. Sampling and
  `validate()` lease per call and release at once. Suspension and disposal release leases as before. A document
  controller without a budget owns at most two workers, each created lazily on its first evaluation; with a shared
  budget its leases are never marked reclaimable (they are counting authorities for its own document workers), so they
  are released by suspension and disposal, and the bounded wait applies to them.
- **Three visible cards on the default budget** (`tests/activity/worker-budget.test.ts`): two quadratic cards that each
  ran a preview hold two primary and two idle scratch leases (4 workers); a third card's prepare is granted by
  reclaiming an idle scratch worker, and each earlier card previews again with a fresh lease. Unit counts in
  `tests/core/model-budget-reclaim.test.ts` (reclamation order, a gesture in progress, the timed-out wait and timer
  cleanup).

## 3 Suspension and resume

| Trigger | Detected by | Reason journaled |
| --- | --- | --- |
| Offscreen (scrolled out of view) | `IntersectionObserver` on the surface root | `hidden` |
| Collapsed (`<details>` closed, `display: none`) | `IntersectionObserver` (the surface has no box) | `hidden` |
| Hidden page | `document.visibilityState` and `visibilitychange` | `hidden` |
| Host suspension | `HostActivityControl.suspend({ reason })` (`offscreen`, `collapsed`, `hidden`, `host`) | the given reason |

An activity suspends when the host suspends it, or when it has registered surfaces and none is visible. The learner
surface names the reason: “Paused by the host” for a host suspension with reason `host` (the card may still be
visible) and “Paused while hidden” for the visibility reasons (`offscreen`, `collapsed`, `hidden`, or a surface that
reports itself not visible). Effects, in
order: an active preview is interrupted (`preview.observed`, `preview.cancelled`), playback is paused
(`playback.paused`), the model session suspends (scratch lease released at once, primary lease released as soon as no
evaluation is in flight), and `activity.suspended` is journaled. Commands that need computation return `NOT_READY`
while suspended; the projection keeps showing the frozen state. Resume journals `activity.resumed` and stays paused at
the declared position: there is no catch-up for the elapsed time, and a worker is leased again only by the next
evaluation. The document controller behaves the same way (`suspend()` / `resume()`); the showcase and hinged-rod
examples suspend their card while the page is hidden.

## 4 Measured counts

From `tests/browser/study-lifecycle.spec.ts` (page `examples/study-harness-host/lifecycle.html`; one adapter,
`maxWorkers` 6, two active activities — quadratic gradient descent and function/derivative — and 20 suspended history
cards; the spec instruments Worker construction/messages/termination, timers, intervals, animation frames,
window/document/MediaQueryList listeners and `attachShadow`, and for the spatial cycles also WebGL contexts, canvases,
observers and listeners on connected nodes). Each test attaches its measured counts as an annotation.

| Check | Measured (run of 2026-10-26) |
| --- | --- |
| Isolation (A41) | commit, navigate, layout change and a committed preview on the quadratic card left the derivative card's projection, guards, frame and journal unchanged; simultaneous previews on both cards kept separate preview IDs |
| Coalescing, 40 synchronous preview updates with worker replies held (A41) | 1 worker message while held; 2 for the whole preview (first value + newest); 3 including the commit |
| Coalescing, 25-step pointer drag with replies held (A41) | 1 worker message while held; 2 including the commit |
| 20 suspended history cards (§9, §18) | 2 live workers (the two active cards' primary leases), peak 3 during setup; in a 1.5 s window: 0 worker messages, 0 timers, 0 animation frames, 0 DOM mutations, 0 listener notifications; projections unchanged |
| Reactivating one history card | resume alone: 0 workers created, 0 messages; the next commit leased 1 worker; suspending again returned to 0 |
| Offscreen / collapsed / `display: none` / hidden page / host suspend during playback (A42) | each: ticks observed before; after suspension a 1.5 s window had 0 worker messages, 0 timers, 0 animation frames, 0 DOM mutations, 0 notifications; resume paused at the same index (2), still there 0.9 s later; `play` then advanced exactly one index per tick |
| 100 mount → interact → suspend → save → dispose → restore → mount → suspend/resume → dispose cycles (A43, §18) | about 12.1–12.4 s; 200 workers created and 200 terminated, 0 live at the end, peak 1; 0 pending timers and 0 live intervals created by the cycles; 0 window and 0 document listeners left; net 0 MediaQueryList listeners; 200 shadow roots attached, 0 surfaces connected at the end; 0 activities open in the adapter |
| 100 spatial cycles, alternating vector orientation and the quadratic surface: mount (renderer ready) → commit a parameter → turn the camera with the keyboard → host suspend/resume → save → dispose → restore (camera restored) → dispose; every fourth cycle also switches the motion preference twice, which remounts the renderer (A47, §13, §18) | about 275 s with SwiftShader WebGL (headless Chromium; about 77 s each in Firefox and WebKit); the 250 renderer mounts (200 card mounts, 50 motion remounts) created 0 WebGL contexts and 0 canvases: each reused the one pooled renderer the warm-up created (§5); exactly 1 live context and 1 connected canvas while a card is mounted, and after each disposal only that idle pooled context with no canvas in the page (0 live contexts after `releaseIdleRenderers()`); 0 contexts lost while their canvas was in the page and 0 "too many active WebGL contexts" messages in each of the three engines; 0 Resize/Intersection/Mutation observers left unreleased beyond the page's own (1050/1650/250 created); 0 listeners added on window, MediaQueryLists or connected nodes; 0 pending animation frames, timers or intervals from the cycles; 200 workers created and 200 terminated, peak 1; 200 shadow roots attached, 0 surfaces connected; 0 activities open; every restored card carried the saved camera. Counted by page instrumentation, not by the renderer's own counters; the page's dev-server HMR socket is stubbed for this run so a saved file cannot reload the page mid-measurement |
| Disposal during prepare, evaluate, save, reveal (A43) | each resolved `DISPOSED`; 0 listener notifications, 0 journal events and 0 display acknowledgements after disposal; dispose during prepare created no worker |
| Disposal during capture (A43) | immediate dispose: capture rejects `DISPOSED`; a capture still in progress at disposal rejects `DISPOSED` (or had already resolved before the disposal), with no data and no DOM left. Dispose while the surface waits for the current frame settles the wait at once with `DISPOSED`, also when no animation frame ever comes (a hidden page); that path is checked with controlled frames in `tests/player-activity/capture-theme.test.ts` |

Bounded pool resources, reported separately from activity-owned resources: the worker budget (at most `maxWorkers`
live, none idle), the 3D renderer pool (at most `IDLE_RENDERER_LIMIT` = 2 idle renderers per document, each with its
canvas out of the page, a 1 × 1 drawing buffer and no listeners, observers or timers of its own; see §5), the
reference-counted adopted stylesheets per shadow root, the lazily loaded KaTeX module (one promise per loader), bundled
font registrations (only with `fonts: 'bundled'`), and the host's own records (journal, exposures, artifacts — 101
activity tables after the stress test) which are durable host state by design.

Unit-level counts (`tests/core/interaction.test.ts`, in-process evaluators): 30 synchronous preview values with the
first evaluation held produce 3 scratch evaluations (scratch session creation, the first value, the newest value) and
1 primary evaluation on commit; two controllers sharing a 2-worker budget queue the second card's scratch lease until
another card suspends; disposal releases every lease.

## 5 Known limits

- **WebGL contexts are reused, not recreated, across 3D mounts.** Engines bound the WebGL contexts a page holds (WebKit:
  per web process): past 16, Chromium and WebKit lose the oldest context to create a new one. Forcing the loss of a
  disposed renderer's context (`WEBGL_lose_context`) releases it at once in Chromium and Firefox, but WebKit keeps a
  lost context in its count until the context object is garbage-collected. Before this change every mount created a
  context and every disposal forced its loss, and in Playwright WebKit 50 rapid mount/dispose cycles made the engine
  lose the context of the card's own 3D view, which was still shown ("There are too many active WebGL contexts on this
  page" and "loseContext: context already lost" in the console; 89 such pairs in the 100 spatial lifecycle cycles of
  an earlier run). The renderer therefore keeps a bounded per-document pool (`packages/player-3d/src/pool.ts`): a
  disposed view hands its renderer back after disposing every geometry and material it drew; the pool resets the GL
  state, drops the render lists, shrinks the drawing buffer to 1 × 1 and keeps the renderer, its canvas (out of the
  page) and its context for the next mount in that document. At most `IDLE_RENDERER_LIMIT` (2) renderers are idle; a
  renderer beyond that, or one whose context is lost, is disposed and its context released as before.
  `releaseIdleRenderers()` releases the idle ones (a host calls it when no 3D view will be shown for a while). Repeated
  mount/dispose cycles therefore create no context after the first, in every engine: the spatial specs check 0 contexts
  created by 50 cycles (`study-spatial.spec.ts`) and by 100 lifecycle cycles with motion-preference remounts
  (`study-lifecycle.spec.ts`), no context lost while its canvas was in the page and no "too many contexts" message, in
  Chromium, Firefox and WebKit alike.
- **Remaining WebGL bound.** Views mounted at the same time each hold a context, and only two idle renderers are kept:
  a page that mounts more than two 3D views at once and then disposes them all forces the loss of the surplus, which
  WebKit counts until collection. A page that keeps 16 or more contexts live or uncollected (for example many 3D views
  shown at once and disposed repeatedly) can still make an engine lose an older view's context; the view then shows
  its context-lost state, restores automatically and offers Try again, while its 2D projection and coordinate table
  carry the task.

- `examples/study-harness-host/lifecycle.html` is a root Vite build input (`vite.config.ts`), but the counts in §4 come
  from running it on the dev server. Lifecycle workloads of the production bundle (packed tarballs, production CSP) are
  measured by `npm run benchmark` ([performance.md](performance.md)).
- Latency percentiles, frame rates and memory are measured by the benchmark on one desktop machine in Chromium, not by
  these tests; packaged-WebView behaviour is covered by the packaged conformance run
  ([evidence/native-conformance.md](evidence/native-conformance.md)), not here.
