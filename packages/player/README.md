# Explorable Models player (0.3.0-preview.1, unreleased)

The default entry (`@experiment-kit/player`) is an embeddable 2D surface for the version 2 declarative contract. The
`./activity` entry is the Study Harness learner surface; see [its section](#study-harness-learner-surface-experiment-kitplayeractivity). The host owns authentication, the agent, session lifetime, storage, application navigation and error reporting. The default entry has no gallery, Three.js, compiler, model-provider SDK, fonts or network fetches. React and React DOM are peer dependencies, including for imperative mounting.

```sh
npm install @experiment-kit/core@0.3.0-preview.1 @experiment-kit/player@0.3.0-preview.1 react react-dom
```

These names and versions identify the local preview artifacts. They are not published on npm, and publication is a separate, owner-controlled release step. Until then, install the matching packed tarballs (`npm run verify:packages` writes them to `release/preview/`; `node scripts/study-harness/pack.mjs` writes the Study Harness set to `release/study-harness/packages/`).

## React

```tsx
import { createVisualizationSession, createPreset } from '@experiment-kit/core/declarative';
import { VisualizationSurface } from '@experiment-kit/player';

const session = await createVisualizationSession(); // browser module worker
const mutation = () => {
  const state = session.getState();
  return { sessionId: session.id, expectedVersion: state.version,
    expectedRunId: state.run?.id, operationId: crypto.randomUUID(), origin: 'host' as const };
};
const candidate = await session.createCandidate(createPreset('wave'), mutation());
await session.commitCandidate(candidate.id, mutation());

// Render inside the host's application; dispose the session on host teardown.
<VisualizationSurface session={session} theme="light" locale="en-US" />;
```

Create the session in a browser effect or client entry, never during server rendering. Pass an existing session as a stable prop. `controls={false}` allows host-owned controls; the host must retain exact entry, cancellation, pause, keyboard access and visible undefined reasons. `headingLevel` defaults to 2; match the host's heading hierarchy when nesting a surface. The React component's styles are scoped; host global styles can still affect it. The imperative mount adds a shadow boundary.

## Plain DOM

```ts
import { mountVisualization } from '@experiment-kit/player';
const surface = mountVisualization(document.querySelector('#visualization')!, { session });
// Multiple containers and sessions remain independent.
const frozen = surface.exportSceneSvg('plot'); // use an actual scene/plot view ID
console.log(frozen.metadata, frozen.svg);
surface.dispose(); // removes this surface only
session.dispose(); // host controls worker lifetime
```

Mounting uses a dedicated child shadow root and does not change existing container content, the page title, location or local storage. A module-capable bundler must preserve the core worker asset; see the core package's worker configuration. Surface disposal is idempotent.

## Binding conventions

All binding strings reference committed quantity IDs. No scientific expression is evaluated in a React component. Rendering applies only coordinate transforms and geometry projection. Undefined quantities retain their reason and are never interpreted as zero.

| Mark | Required bindings |
| --- | --- |
| `point`, `label` | `position` = vector `[x,y]`, or scalar `x` and `y` |
| `segment`, `arrow` | `start`, `end` = vectors `[x,y]` |
| `path`, `polygon` | `points` = flat vector `[x0,y0,x1,y1,...]` |
| `circle` | `center` = vector; scalar `radius` |
| `ellipse` | `center` = vector; scalar `rx`, `ry` |
| `angle` | `center` = vector; scalar `radius`, `startAngle`, `endAngle` in radians |
| `line`, `scatter`, `bar`, `region` | `series` ID; optional scalar `baseline` for bar/region, default zero |
| `group` | `children` containing ordinary marks; group styling supports `opacity` and `hidden` |

Scene/plot bounds are `[xMin,xMax,yMin,yMax]`. Geometric scenes default to equal coordinate aspect; plots default to independently scaled axes. Explicit bounds are recommended. `scale: 'log'` applies base-10 mapping to both axes; both bounds and rendered coordinates must be positive. A logarithmic bar/region requires a positive bound baseline. Gaps split line paths and shaded regions. Negative bars extend below their baseline.

Equations are safe text with `{{quantityId}}` substitutions, not HTML or executable TeX. Quantity tables and value panels use the same committed frame. Dataset tables display the supplied data, including explicit missing cells. Legends wrap into rows and truncate long names; every semantic mark also has its full accessible label. Label offsets are explicit screen pixels; automatic collision avoidance is not provided.

Selection links marks with the same `semanticId` and has a dashed/weight cue in addition to color. Enter/Space select focused marks. Drag bindings name `x` and `y` parameters, whose standard controls provide exact alternatives. Drag and range input changes are previews until release/commit; views continue displaying the committed frame during preview. Escape cancels a tentative gesture. Parameter commits restart the run. Pan/zoom are local surface state and do not modify scientific state; this preview does not persist camera state.

## Frozen scene export

`exportSceneSvg(session, viewId)` exports one mounted scene or plot with committed document/model/presentation revisions, run ID, time and session version embedded in SVG metadata. Pause playback and commit/cancel previews first. It checks that the visible DOM has caught up with that exact frame. No mounted surface means a clear unavailable error; rendering does not imply full-page screenshot capability. The host can supply a browser capture service for full-page screenshots. The SVG contains local geometry/text only. Export includes the current local camera.

## Accessibility and limits

Controls have labels, exact entry, visible focus and keyboard activation. Animation is opt-in and never continuously announces frame changes. The source inspector exposes assumptions, limitations, review status and all committed values. Finite tiny values use scientific notation instead of rounding to zero. Layout collapses to one column in narrow containers. This is implementation behavior, not an accessibility certification: manual assistive-technology sessions and real-device checks remain release gates.

The package is a preview. General 3D, numerical solvers, arbitrary renderers, automatic label layout and full-page capture are outside this entry point. Legacy gallery artifacts keep their separate API. This surface does not silently reinterpret them.

## Study Harness learner surface (`@experiment-kit/player/activity`)

A separate entry for Study Harness activities. It renders only the `LearnerProjection` that an `ActivityBinding` from `@experiment-kit/activity` publishes. It never receives a model, a document or hidden content, and every interaction goes back through guarded binding commands. The entry does not import Three.js, `@experiment-kit/player-3d`, the studio, Playwright, the CLI or provider SDKs. KaTeX is a lazy chunk, loaded only when an equation becomes visible.

`@experiment-kit/activity` is an optional peer dependency of this package because the default entry does not use it; hosts that import `@experiment-kit/player/activity` must install it, since the entry imports it at runtime (`createStudyHarnessVisualizer` constructs the adapter).

```tsx
import { StudyActivitySurface, adoptActivityStyles, mountStudyActivity } from '@experiment-kit/player/activity';

const binding = prepared.binding('learner', surfaceId); // host-constructed; the actor is fixed

// Plain DOM: a shadow root with constructable stylesheets (no style attributes, no inline <style>).
const surface = mountStudyActivity(container, {
  binding, theme: 'system', fonts: 'bundled',
  nextAction: { label: 'Submit prediction', onSelect: submit }, // host-owned
  responseSlot: <HostComposer />,                                // host-owned prediction/explanation UI
  spatialLoader: () => import('@experiment-kit/player-3d'),      // optional; 3D activities only
  onDiagnostic: report,
});
await surface.ready;
const png = await surface.capture({ format: 'png', viewId: 'landscape', scale: 2 });
surface.dispose(); // idempotent; nothing calls the host afterwards

// React in the host document: adopt the stylesheet once, then render.
adoptActivityStyles(document);
<StudyActivitySurface binding={binding} headingLevel={3} />;
```

**One API for the six report operations.** `createStudyHarnessVisualizer` wraps the adapter and the surface for hosts
that want a single object (report §5.3). It takes the adapter options (`catalog`, `host`, `maxWorkers`, …) plus
`surfaceDefaults` (theme, tokens, fonts, assets, loaders, callbacks) and an optional `mountSurface`.

```ts
import { createStudyHarnessVisualizer } from '@experiment-kit/player/activity';

const visualizer = createStudyHarnessVisualizer({ catalog, host, surfaceDefaults: { theme: 'system', fonts: 'bundled' } });
visualizer.getCapabilities();                       // installed templates, controls, alternatives, limits, review scope
const report = await visualizer.validate(request);  // defaults evaluated in a worker; nothing activated
const opened = await visualizer.prepare(request, { operationId });
if (opened.ok) {
  const surface = visualizer.mount(container, opened.prepared, { onError: event => show(event) }); // or render(...)
  await surface.ready;
  visualizer.getState(opened.prepared.activityId, 'tutor');
  visualizer.summarizeInteraction(opened.prepared.activityId, { audience: 'tutor' });
  // Privileged host commands stay on opened.prepared.host (stage transitions, reveals, save, close).
}
visualizer.dispose(); // idempotent
```

`restore` and `sample` pass through as well. `mount` accepts only an activity that this visualizer prepared or restored
and that is still open; otherwise it throws `VisualizerError` (`INVALID_REFERENCE`, `NOT_FOUND` or `DISPOSED`). Each
surface gets its own learner binding. Its error hook receives refused learner commands and surface failures (styles,
fonts or math assets unavailable, capture refused) as `{ kind: 'diagnostic' }`, and each entry into
`recoverable-failure`, `stale-policy`, `unsupported` or `disposed` as `{ kind: 'state' }`. Presentation fallbacks that
keep the task usable (label nudges, plain-text math, the 2D projection instead of 3D, ignored tokens) go to
`onDiagnostic` only. `dispose()` disposes every surface, aborts pending `validate`/`prepare`/`restore`/`sample` calls
(they resolve with `DISPOSED`), disposes the activities and their workers, rejects pending captures with `DISPOSED`, and
no surface callback reaches the host afterwards. `dispose(activityId)` closes one activity and its surfaces.

**Props.** `binding` (required), `theme` (`light`, `dark` or `system`), `tokens` (partial `ThemeTokens`), `headingLevel` (2–6), `locale`, `responseSlot`, `nextAction`, `mathLoader`, `spatialLoader`, `fonts` (`system` by default, or `bundled`), `onDiagnostic`. Optional extras: `surfaceId`, `assetBase` for hosts that relocate assets, and `onRecoveryAction` for `return`/`reload` recoveries. The card never renders its own transcript, microphone or response field.

**Lifecycle and exposure.** The surface calls `binding.registerSurface(surfaceId)` and reports visibility through `binding.reportVisibility`, using an IntersectionObserver plus document visibility. Once a projection is committed to the DOM of a registered, visible surface, the surface calls `binding.acknowledgeDisplay({ projectionId, projectionDigest, surfaceId })`, once per projection. The surface never applies command results directly. The binding's subscription is the only source of state.

**Layout and theme.** Layout follows the card's container width, not the viewport:

- a narrow side panel at 360px or less;
- an inline conversation card from about 390 to 640px;
- an expanded workspace at 800px or more, with controls beside the scene.

`presentation.layout` can force `card`, `side` or `expanded`. Both palettes define the colour roles `primary`, `secondary`, `accent`, `muted`, `positive`, `negative`, `warning` and `reference`, plus focus and error colours. Every role also has a non-colour cue: dash pattern, marker shape or label.

Host tokens must be literal opaque colours or bounded lengths. Any override that would push text, status, focus or mark contrast below its WCAG minimum, or that is not a literal value, is ignored and reported as `TOKEN_REJECTED`. Motion tokens drop to 0 under reduced motion.

**Interaction.** Each parameter has:

- a native range slider;
- exact numeric entry with an Apply button;
- a unit selector, when the projection offers more than one unit.

Gestures map onto the binding as follows:

| Input | Binding call |
| --- | --- |
| pointerdown | `beginPreview` |
| input | `updatePreview` (the binding coalesces) |
| pointerup or Enter | `commitPreview` |
| Escape, pointercancel, lost capture or blur | `cancelPreview` |
| arrow, Page or Home/End keys | one keyboard preview, committed on key up |

When the stage does not permit previews, a gesture becomes a local draft that is committed once on completion. Invalid typed input and IME compositions keep the draft and explain the problem inline. Fixed or disabled controls stay focusable with `aria-disabled` and a visible reason. Hidden controls are not rendered.

Discrete navigation shows whole indices (`n = 3 of 1000`) with start, previous, next, play/pause, restart and an exact "go to". Pan and zoom use the view toolbar, the keyboard (`+`, `−`, arrow keys and `0` when the plot has focus), Ctrl/⌘-wheel and mouse drag. The camera is serialized with `setCamera` and `expectedPresentationRevision` at the end of each gesture. A camera change never touches scientific state.

**Readouts and units.** Values are shown as the projection formats them: four significant digits in readouts and
substituted equations, and up to six significant digits in geometry tables, where a safe integer keeps every digit
(236,196, not 236,200). A long curve table keeps every *k*-th sample plus the last one, so the whole domain stays covered,
and says so; a trace table keeps its first and last rows. An iteration count reads `n = 700`, never `700 iter`. A
template may declare display units for a quantity (`quantityDisplay`, for example degrees for an angle evaluated in
radians): the projection converts at the output boundary, the values panel offers a unit selector, and
`setDisplayUnit` with the quantity ID changes only the presentation revision, never the run. Substituted equations then
carry the unit (`θ = 45°`).

**Undefined values.** The *Some values are undefined here* banner appears only when a drawn mark is affected: a scene or
plot mark whose bound quantity or point geometry has no value. A value that is legitimately conditional and appears only
in readouts or tables (the collapse direction of a full-rank matrix, the secant slope at h = 0, the vertex of a line) is
shown inline as *Undefined* with its reason. Neither ever becomes zero.

**2D rendering.** The surface draws only `ProjectedView` and `ProjectedMark` data. It never re-evaluates the model.

- Each polyline segment is drawn separately, and gaps are never bridged. Open and closed endpoints get glyphs.
- A zero vector is a dot labelled "zero vector", never an arrowhead.
- A degenerate polygon is drawn as the line or point it collapses to, with a note.
- Undefined coordinates appear as notes with their reasons, never as zeros.
- Labels of coincident features merge into one label (`x₀, xₙ` at n = 0, `P, Q` at h = 0, `v, Mv (zero vector)`).
- A comparison names the current and the kept run and lists each differing parameter with both values.

Labels support anchors, offsets, wrapping and leaders. They are nudged deterministically. A label that still has no free place, or that would need more than four lines, is drawn as a numbered callout tag at its feature, and its full text is listed in the figure's label key under the legend (part of the SVG, so captures carry it too). Authors are told through `onDiagnostic`: `LABEL_CALLOUT` for each label drawn as a callout, and `LABEL_OVERLAP` only for a callout tag that itself cannot be placed clear. Text in a drawing is never shrunk or cut: axis titles, legend entries and the key wrap to as many lines as they need. When geometry leaves the authored bounds, the view shows "Some values are outside the view" with **Inspect values** and an explicit **Fit to data** action. It never rescales silently. In a card with navigation (stepping or playback), the line under each figure that carries this indicator is reserved at the height of its longest possible text and reads "All drawn values are inside the view." until data leave the view, so playing past the authored range never moves the navigation or Pause. At the authored camera, each bounded data mark drawn outside the bounds is also reported to `onDiagnostic` once as a `CLIPPED` surface diagnostic for authors; `role: "reference"` marks, `grid` marks and `extent: "line"` segments are never counted.

`scene3d` views use the host's `spatialLoader`. If it is absent, fails, or WebGL is unavailable, they show a coordinate-plane projection (x–y, x–z or y–z, with equal aspect) and the full coordinate table.

**Math.** Equations are rendered with `katex.render` into a DOM node, never with `innerHTML`. The options are `trust: false`, `maxExpand: 1000`, `maxSize: 20`, `throwOnError: true`, `strict: 'ignore'` and `output: 'htmlAndMathml'`, with a fresh macro object for each render.

The source limit is 4096 code points, checked before KaTeX is called. Commands that define macros or reach resources or HTML (`\def`, `\href`, `\url`, `\includegraphics`, `\htmlClass` and similar) are rejected before KaTeX sees the source. Any failure keeps the plain-text form, which is also available through a toggle. The limits are exported as `MATH_LIMITS`.

KaTeX's CSS is fetched into a constructable stylesheet for the surface's root. Its font URL metadata is a separate local chunk loaded only when visible math requests `fonts: 'bundled'`; the corresponding `@font-face` rules are then registered on the document.

**Assets.** The package build copies a fixed set of files into `dist/activity/`:

- `katex.min.css` into `math/`;
- the KaTeX woff2 fonts into `math/fonts/`;
- the Inter variable Latin, Latin Extended and Greek woff2 files into `fonts/inter/`;
- a license file beside each of them: KaTeX's MIT license in `math/`, the SIL OFL 1.1 of the KaTeX fonts in
  `math/fonts/` (written from the fonts' own declarations, since the katex package ships no OFL file) and Inter's OFL 1.1
  in `fonts/inter/`, plus `THIRD_PARTY_NOTICES.md` listing versions; the build fails if a font directory has no license;
- `activity.css`, a fallback stylesheet for engines without constructable stylesheets.

Each asset is referenced with a literal `new URL('./…', import.meta.url)`, so bundlers can emit it. Hosts that relocate the files pass `assetBase`. `dist/activity/build-manifest.json` records the entry size and the lazy chunk list. In the source tree, the same files are read from `node_modules`, which works with the dev server.

**Capture.** `capture({ format: 'svg' | 'png', viewId?, scale? })` loads its local serialization/rasterization chunk on first use. Policy and committed-frame checks run before that load; changed content or revisions during loading are refused with `NOT_READY`; a save acknowledgement may settle without invalidating the same view. Disposal aborts a pending load. Public synchronous capture helpers stay synchronous. It then works as follows:

- It rejects tentative previews and running playback with `CAPTURE_REJECTED` (commit or cancel, or pause, first).
- It selects only this surface's view, matched by surface ID, projection ID and view ID.
- It serializes pure SVG: computed presentation is inlined as attributes, there is no `foreignObject`, and equations appear as their plain text.
- It embeds metadata limited to `{ surfaceId, projectionId, projectionDigest, frameId, activityRevision, presentationRevision, viewId }`.
- It embeds fonts as `data:` only when bundled fonts are in use.
- It rasterizes PNG through a `blob:` image onto a canvas of at most 4096 px per side and 16.7 M pixels.
- It returns a text/numeric companion built from the projection.

**Limits.** A shadow root is a styling boundary, not a security boundary. Automated tests cover the pure helpers: ticks, labels, clipping, formatting, math options, capture bounds and theme contrast. Rendering was inspected in the Projection lab fixture (`examples/study-harness-host/projection-lab.html`) and, for the function-derivative and linear-transformation activities, in the integration fixture through `tests/browser/study-function-derivative.spec.ts` and `tests/browser/study-linear-transformation.spec.ts` (Chromium, fixture host; screenshots at container widths 320–960, desktop, a mobile viewport, dark mode and 200 % text). This is not an accessibility certification. Manual assistive-technology and packaged-WebView checks remain separate gates.
