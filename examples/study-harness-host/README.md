# Study Harness browser integration fixture

`study-harness.html` (sources in this directory) plays a Study Harness **host** around the learner card so the
boundary can be exercised in a real browser: the real catalogue kernel module worker, the activity adapter and the
learner surface in its shadow root. It is an **integration fixture, not a tutor**: the quadratic flow's tutor messages
are fixed scripted text, the generic flow has no tutor messages or task content at all, responses are never evaluated,
and nothing here is evidence of learning benefit. Host tables live in the tab's `sessionStorage`, which is **not an
authoritative store**: it is per tab, unencrypted, cleared with the tab and bounded by the browser quota. A reload of
the tab simulates a host restart.

## Opening each template

Run `npm run dev` and open:

| Template | Page | Flow |
| --- | --- | --- |
| `quadratic-gradient-descent` | `/study-harness.html` | scripted learning-and-return flow (report §6.1, A31) |
| `quadratic-gradient-descent` | `/study-harness.html?flow=generic` | generic host flow |
| `function-derivative` | `/study-harness.html?template=function-derivative` | generic host flow |
| `linear-transformation` | `/study-harness.html?template=linear-transformation` | generic host flow |
| `vector-orientation-3d` | `/study-harness.html?template=vector-orientation-3d&spatial=1` | generic host flow, 3D renderer loaded lazily |
| `quadratic-surface-gradient` | `/study-harness.html?template=quadratic-surface-gradient&spatial=1` | generic host flow, 3D renderer loaded lazily |

Add `&mode=free` to any of them for the authorized free-exploration stage. An unknown `?template=` shows the list of
installed IDs (and sets `document.body.dataset.fixtureReady = 'failed'`). While the fixture prepares or restores the
activity, the card container shows the learner card's own `preparing` placeholder (`mountStudyActivityPlaceholder`);
`?delay=register:<ms>` keeps it on screen longer.

## Query parameters

| Parameter | Effect |
| --- | --- |
| `?template=<templateId>` | Installed template (default `quadratic-gradient-descent`). |
| `?flow=scripted\|generic` | The quadratic template runs the scripted flow unless `flow=generic`; every other template runs the generic flow. |
| `?mode=guided\|free` | Guided flow from the template's initial stage (default) or the `free-explore` stage, authorized by the host at start (reveal of its solution-bearing groups, then an exploration scope). |
| `?policy=held\|full` | Generic flow only (fixture host decision): `held` (default) keeps every solution-bearing group outside the policy ceiling until the host reveals it — the reveal button raises the ceiling for that group, then requests the reveal; `full` puts every group under the ceiling, so stage transitions carry stage-scope grants for the target stage's solution-bearing groups. |
| `?spatial=1` | Passes `spatialLoader` (a lazy `import('@explorable-models/player-3d')`, isolated in `spatial-loader.ts`) to the card. Absent or `0`: no loader, the card shows its 2D projection and coordinate table. The loader is called only when a card shows a `scene3d` view; if the import rejects, the card falls back to the 2D projection with a `SPATIAL_FALLBACK` diagnostic (visible in `studyHarnessFixture.diagnostics`). In the dev server, a renderer source that cannot be resolved or transformed also opens Vite's error overlay. |
| `?fail=<point>[:n][,…]` | One-shot host failures before commit, armed when the fixture session starts. Points: `exposure-intent`, `scope-intent`, `stage`, `display-ack`, `append`, `save`, `assistance`, `policy`, `cursor`, `register`. |
| `?delay=<point>:<ms>[,…]` | Host call delays before processing (a bare number delays exposure intents). |
| `?lag=<point>:<ms>[,…]` | Late host replies: the call commits at once, its reply arrives after `<ms>`. |
| `?crash=before-intent\|after-intent\|after-display` | Terminate the host once at an exposure protocol point (a crash point fires once per fixture session). |
| `?revoke=1` | Revoke the host policy right after the activity opens. |
| `?workerDelay=<ms>` | Delay every kernel-worker reply (late-reply tests). |
| `?width=320\|390\|640\|960`, `?theme=light\|dark\|system`, `?text=200`, `?fonts=bundled\|system` | Card container width, theme, 200 % root text, font mode. |

A stored fixture session belongs to one flow and template (`scripted:<id>` or `generic:<id>`); opening another
selection in the same tab starts a new fixture session.

## Flows

**Scripted quadratic flow** (`fixture-session.ts`): prediction with the trace hidden → step-size exploration →
trace reveal under an updated policy (persist-before-reveal) → curvature control → explanation → close → a new
independent changed-representation task with only the neutral scaffold. Host steps are idempotent and resumable after
a crash. Its host composer stays in the host column, outside the card (the A31 spec asserts the card holds no response
field of its own).

**Generic flow** (`generic-session.ts`), for every installed template:

- *Stage transitions* — one button per template transition out of the current stage (`data-fx-transition="<toStage>"`).
- *Reveal requests* — one button per solution-bearing group (`data-fx-reveal="<groupId>"`), disabled with a reason
  when the stage, the context, the policy or a running request forbids it, and marked *Shown* once its content is shown.
- *Host actions* (`data-fx-action="…"`): `authorize-exploration` (exploration scope for the current stage's interactive
  controls and every shown group, over the model's full parameter domains), `enter-independent` (neutral scaffold =
  the template's non-solution-bearing equation groups, no controls; a fixture decision), `reopen` (instructional policy
  revision, then `reopenInstructional`, recorded as assistance), `save-backup`, `save-snapshot`, `close` (moves to the
  closed stage when a transition leads there, closes, checkpoints and removes the card).
- *Host response composer in the card* — whenever the current stage requests a response (and for the answer of an
  independent task), the host composer is rendered inside the card through `StudyActivitySurface`'s `responseSlot`
  (report §10.1). The card is mounted through the React entry (`host-card.tsx`) so the slot can follow the activity;
  the composer keeps its text, focus and submit status across projection updates. Submitting stores the text in the
  host tables and passes only a response reference (`submitResponseRef`). Hooks: `#fx-response`,
  `[data-fx-composer="<kind>"]`, `[data-fx-composer] button[type=submit]`, `[data-fx-response-recorded]`.
- *Fixture host policy* — approves exactly the selected installed template and its model by the catalogue's computed
  references (`approvedEntry()`); labelled on the page as a fixture decision.

## Test hooks: `window.studyHarnessFixture`

Existing hooks (both flows): `session`, `options`, `host`, `adapter`, `catalog`, `prepared`, `binding`, `surface`,
`projectionLog`, `diagnostics`, `state()`, `frozen(responseId)`, `validate(contract, record)`, `capture(format, viewId?)`.

Selection: `templateId`, `flow` (`'scripted' | 'generic'`), `installed` (every installed template ID), `template`
(the selected `ActivityTemplate`), `refs` (`{ template, model }` references the fixture policy approves).

Driver (generic flow). Every call is serialized with the host buttons and resolves after the host round trip and the
display acknowledgement have settled — no reveal requesting or awaiting display, no journal flush or checkpoint in
flight, the card rendering the current projection, every displayed exposure acknowledged in the host tables. It
resolves `{ ok, codes, message, stage, context, activityRevision, policyRevision, artifactId? }`; a host refusal is
`ok: false` with the adapter's codes (`HOST_TERMINATED` if the host terminated first). It rejects only when the fixture
does not settle within 15 s (for example, a card scrolled out of view cannot acknowledge display).

| Call | Effect |
| --- | --- |
| `transition(toStage)` | Template transition from the current stage. |
| `reveal(groupId)` | Reveal request for one group (`policy=held`: raises the ceiling first when the instructional stage shows the group). Requests the stage does not permit go to the adapter unchanged and are refused there. |
| `authorizeExploration()` | Exploration scope for the current stage. |
| `enterIndependent()` / `reopen()` | Independent task / reopen instructional content as assistance. |
| `respond(text)` | Same path as the composer in the card. |
| `save(kind)` | `'backup'` or `'learner-snapshot'` (also available in the scripted flow). |
| `close()` | Close the activity (the card is removed; `events()`/`exposures()` still read its tables). |
| `restartHost()` | In-page host restart: the card, adapter and host instance go away; a new host loads the persisted tables (restart rule) and the activity reopens from the latest checkpoint. The scripted flow restarts by reloading the tab instead. |
| `settle(timeoutMs?)` | Wait until the open activity has settled (both flows). |
| `events()` / `exposures()` / `projection()` | Host journal, host exposure records with `acked`, the learner projection as JSON (both flows). |

`session.getSnapshot()` in the generic flow returns `kind: 'generic'` with `stage`, `context`, `steps` (transitions),
`reveals`, `actions`, `busy`, `response` and `composer`; the shared helpers in `tests/browser/support/study-harness.ts`
(`openFixture`, `card`, `settle`, `respond`, `cardDom`, …) work with both flows. Example:

```ts
await openFixture(page, '?template=function-derivative');                   // initial stage "prepare"
await page.evaluate(() => window.studyHarnessFixture.transition('predict'));
await respond(page, 'The slope is negative left of the vertex.');           // composer in the card's slot
await page.evaluate(() => window.studyHarnessFixture.transition('explore-slope'));
const result = await page.evaluate(() => window.studyHarnessFixture.reveal('tangent'));
expect(result.ok).toBe(true);
```

## Files

| File | Role |
| --- | --- |
| `fixture-host.ts` | `FixtureHost` (`HostPort`): per-activity policies, receipts with idempotency, exposure records, display acknowledgements, journal with eventId dedupe, artifacts, host-owned response text, fault injection, `terminate()` for in-page restarts. |
| `fixture-runtime.ts` | Shared runtime of both flows: host, catalogue restricted to the selected template, adapter, card lifecycle, checkpoints (backups), settle, capture, crash handling. |
| `fixture-session.ts` | Scripted quadratic learning-and-return flow. |
| `generic-session.ts` | Generic host flow and driver for any installed template. |
| `host-card.tsx` | Generic flow's card: `StudyActivitySurface` in a host-owned shadow root with the host composer in `responseSlot`. |
| `spatial-loader.ts` | Lazy `@explorable-models/player-3d` loader for `?spatial=1`. |
| `fixture-worker.ts` | Wraps the catalogue's own module-worker factory to count workers and, optionally, delay replies. |
| `main.tsx`, `study-harness.css` | Host chrome for both flows, fault-injection controls, host tables and `window.studyHarnessFixture`. |
| `projection-lab.*` | Static projection fixtures for visual inspection of every UI state (no model, no host). |
| `lifecycle.html`, `lifecycle.tsx` | Lifecycle fixture for `tests/browser/study-lifecycle.spec.ts`: two active 2D activities and 20 suspended history cards under one adapter, an in-page host with hold/release gates, mount/suspend/restore/dispose cycles and disposal during prepare, evaluate, save, reveal and capture (A41–A43); spatial cards (vector orientation, quadratic surface) with the lazy `@explorable-models/player-3d` loader for the 3D mount/commit/camera/suspend/save/restore/dispose cycles (A47). |

Results obtained with this page are fixture-host results in a browser engine. They do not establish the behaviour of
the Study Harness host, a packaged WebView, assistive-technology use or learning outcomes.
