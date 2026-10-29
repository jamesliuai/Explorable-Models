# @explorable-models/player-3d

Optional, lazily loaded spatial renderer for the `scene3d` views of Study Harness activities. It implements the
learner surface's `SpatialRendererModule` contract from `@explorable-models/player/activity` and draws **bounded
scientific primitives only**, strictly from the authorized learner projection: it never evaluates, differentiates or
re-derives model values.

```ts
import { mountStudyActivity } from '@explorable-models/player/activity';

mountStudyActivity(container, {
  binding,
  // Loaded only when a card shows a scene3d view; the 2D path never imports this package or Three.js.
  spatialLoader: () => import('@explorable-models/player-3d'),
});
```

Three.js `0.186.1` is a peer dependency (the bundle keeps `three` and `three/addons/lines/*` external). Without a
loader, when loading fails, or when `webglAvailable()` is false, the surface renders its tested 2D alternative: a
coordinate-plane projection plus the full coordinate table, and says why.

## What it draws

| Projection input | Drawing |
| --- | --- |
| `points3` (and resolved `at`) | glyph solids by marker: sphere, cube, octahedron, tetrahedron or a 3-axis cross; missing points become notes |
| `segments3`, `arrow` marks | directed marks (`arrow`, or `segment`/`segments` with the `triangle` marker) get a cone head whose apex sits at the tip; a zero-length vector is a dot with a note and never gets a head. The segments of a directed `segments` mark, or several directed segments, are named by ID at their tips (a zero vector's dot reads `u (zero vector)`), and only those IDs appear in notes; undirected segments are never named, and their zero-length ones are counted in one note |
| `polyline3` | wide lines split at missing samples (never bridged); gaps are listed with their reasons |
| `surface-grid` | an indexed mesh over the sampled grid; cells touching an undefined sample are holes; a wireframe option; the sampling grid is disclosed |
| `vector-field3` / `vector-field2` | arrows at the field's declared scale factor, always disclosed with the field's own disclosure text |
| 2D geometry in a 3D view | placed in the z = 0 plane |
| axes | through the crossing point, right-handed, each with its colour (x red, y green, z blue) **and** a line pattern (solid, dashed, dotted), an arrowhead and its name at the positive end; ticks labelled in canonical units |

Labels are a DOM overlay positioned through CSSOM (no `style` attributes, no SVG `foreignObject`). Arrow shafts and
arrowheads are label obstacles. An axis, mark or segment label that would overlap another label, an arrowhead or a
shaft tries the other sides of its point at two distances. A label never covers an arrowhead: if no position is clear
of arrowheads, it is hidden, and the tables list every value. Tick labels that would overlap a label or an arrowhead
are hidden. The labels of an axis seen end-on are hidden. When a sampled surface is drawn, arrows and points also get a faint copy without the depth test, so
the parts a surface hides stay visible (dimmed). Nothing is fetched and no textures are created. Styles are a constructable stylesheet adopted into the containing (shadow) root.
When equal aspect is off, only the vertical axis is rescaled and the scale ratio is disclosed.

## Limits (the `spatial-3d@1.0` capability)

The limits are contract data: the `spatial-3d@1.0` capability record (`SPATIAL_3D_CAPABILITY` in
`@explorable-models/activity`, schema `study-harness.capability-record` 1.0). Template validation checks a 3D template's
declared worst-case geometry against them. `getCapabilities()` reports them. The learner surface passes them to
`mount(…, { limits })`. `SPATIAL_LIMITS` are the renderer's own maxima, equal to the record (a test checks this).
Limits passed at mount can only lower them.

| Limit | Value | Behaviour at limit + 1 |
| --- | --- | --- |
| data-derived vertices per view | 20,000 | the whole mark is not drawn; a visible note points to the 2D projection and table |
| surface triangle + wireframe indices | 120,000 | same |
| vector-field samples | 1,000 | same |
| draw calls per rendered frame (scaffolding included) | 128 | same, for the mark that would cross the per-frame budget |
| overlay labels | 32 | lowest-priority labels (ticks, then segment names) are dropped with a note |
| texture edge | 1,024 | no textures are allocated |

Draw calls are bounded per mark, not per element. A mark's lines are one wide-line object, its arrow shafts one more,
and its arrowheads one instanced mesh. Its glyphs of one shape are one instanced mesh, so 20,000 points cost one draw
call. A surface costs two (mesh and wireframe) and a field three. Every arrow and glyph object gets a ghost copy when a
surface is drawn. `drawCallsOf` counts exactly what the scene builder issues. Each rendered frame's count
(`renderer.info.render.calls`) is reported by `stats().drawCalls` and `inspect().drawCalls`. Scaffolding (axes, ticks,
box, floor grid) counts toward draw calls, but not toward vertices.

## Camera

Orthographic by default, perspective on request. The authored default view looks from azimuth −20°, elevation 30°
(front right, above; z up), chosen so that no axis or starting vector of the bundled activities is seen end-on.
Presets: isometric, front (x–z, seen from −y), top (x–y, seen from +z), side (y–z, seen from +x); reset (to the
default view); whole box; zoom in/out (0.25×–4×).

**Default framing (zoom 1).** The camera fits the three axes with their arrowheads and names, and every drawn data point
inside the axis box, with room for labels. It does not fit the box's bounding sphere, so small data in a teaching box
reads on a narrow card. Data drawn outside the box is not framed; the planner's note discloses it. The framing is
computed when the view mounts (and when its box changes), not on every commit, so the drawing does not rescale between
runs. `Whole box` zooms out from the current direction until the whole box fits. Serialized cameras are absolute
positions, so a restored camera shows the same view whatever framing the renderer fits. The 3D viewport is one tab stop: arrow keys turn the view
in 15° steps, `+`/`−` zoom and `Home` resets. Pointer drag turns the view (vertical page scrolling stays available on
touch); the wheel zooms when the viewport has focus or with Ctrl. The camera is serialized through `onCamera` at the end
of a gesture, a short pause after keyboard steps, or a preset/reset/projection change — never per frame — and the
surface stores it with a presentation-revision guard. A presentation camera is restored on remount. Camera changes
never alter scientific state.

## Lifecycle

- Renders on demand only; no continuous loop. Presets ease over ~280 ms unless reduced motion is requested.
- Hidden tab or offscreen (IntersectionObserver): no frames until visible again, then one frame, no catch-up.
- `ResizeObserver` keeps the drawing buffer in step with the viewport.
- WebGL context loss: a visible “Graphics context lost” state, automatic restore attempts (after 0.8 s, 1.5 s and 3 s),
  then `failed` with a “Try again” button; `onStatus` lets the surface show its 2D projection meanwhile. The state
  names the alternative only in the host surface's own words (`describeAlternative`, which the learner surface fills
  with the same per-view wording as its 2D fallback, so a coordinate table that summarises curves or surfaces is never
  described as showing the same values); without it the state names no alternative. Try again
  discards the lost renderer and mounts another (an idle pooled one with its own canvas and context, or a new one); the
  new renderer reports its status (normally `ready`) through `onStatus`,
  the visible state hides and focus moves from the button to the 3D view.
- `dispose()` removes listeners and observers, cancels frames and timers, disposes every geometry and material and
  removes its DOM. The renderer, its canvas and its WebGL context go back to a per-document pool (at most
  `IDLE_RENDERER_LIMIT` = 2 idle, GL state reset, drawing buffer shrunk to 1 × 1, canvas out of the page) and the next
  mount in that document reuses them, so repeated mount/dispose cycles create no new context; a renderer the pool does
  not keep (pool full, context lost) is disposed with `renderer.dispose()` and, unless its context is already lost,
  `renderer.forceContextLoss()`. This keeps WebKit, which counts a lost context until it is garbage-collected and then
  loses the oldest one, from taking the context of a view still shown ([lifecycle §5](../../docs/study-harness/lifecycle.md#5-known-limits)).
  `releaseIdleRenderers(document?)` releases the idle renderers and returns how many it released. `stats()` exposes
  live counts (own registry, `renderer.info.memory`, programs, listeners, observers, pending work); a disposed instance
  reports none of the renderer's counters.

`inspect(element)` returns the world-space and screen positions of rendered arrows and axis ends, the camera, labels,
notes and counts of the renderer mounted in `element` (for automated tests and developer tools; presentation only).

## Evidence scope

Unit tests (`tests/player-3d`) cover limits, camera math, presets, handedness and disposal with a fake renderer;
`tests/browser/study-spatial.spec.ts` covers the two spatial activities in Chromium through the integration-fixture
host, including WebGL-unavailable completion, context loss (restored automatically, and permanent until Try again),
resize, suspension and repeated mount/dispose; `tests/browser/study-lifecycle.spec.ts` cycles both spatial activities
100 times through the real learner surface (mount, commit, camera turn, host suspend/resume, save, dispose, restore,
motion-preference remounts) and counts WebGL contexts, canvases, observers, listeners, workers, timers and animation
frames in the page. Headless Chromium draws WebGL with SwiftShader. These are
automated engineering checks: they are not an accessibility certification, a subject review or evidence of learning
benefit, and no packaged-WebView run of the 3D renderer is recorded here.
