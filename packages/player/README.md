# Explorable Models player (0.2 preview)

An embeddable 2D surface for the version 2 declarative contract. The host owns authentication, the agent, session lifetime, storage, application navigation and error reporting. The default entry has no gallery, Three.js, compiler, model-provider SDK, fonts or network fetches. React and React DOM are peer dependencies, including for imperative mounting.

```sh
npm install @experiment-kit/core@0.2.0-preview.1 @experiment-kit/player@0.2.0-preview.1 react react-dom
```

These names and versions identify the local preview artifacts; public npm availability is a separate release step. Use the matching packed tarballs until publication.

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
