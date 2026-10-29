# Hinged rod: an embedded conversation card

Run `npm run dev` from the repository root and open
<http://127.0.0.1:5173/hinged-rod.html>. The production build also includes
`hinged-rod.html`. This is a local example, not an agent-connected chat service.

Drag the angle, length, or gravity slider to see worker-computed geometry and
readouts update during the gesture. Release to keep the setting; Escape or pointer
cancellation restores the last accepted configuration. Arrow keys, Home/End,
exact numeric inputs (Enter or blur), and Reset are supported. The compact layout
is selected by the actual diagram width, including a narrow embedded panel.

## Embed the card

Create a `createRodController()` in the browser, render
`<RodCard controller={controller} />`, and call `controller.dispose()` when its
owner unmounts. `main.tsx` is a complete working host. Import the example's styles
in a dedicated host surface; its page styles are not a general style-isolated SDK.
`RodCard` is example source, not a new export from the player package.

`document.ts` is an ordinary schema 2.0 document. It can also be mounted in the
generic player, which retains its existing commit-on-release behavior. The card
is a custom representation of the same declarative quantities, with a specialized
diagram, controls and typography. Geometry tests cover the adapter.

The controller is the supported `createDocumentInteractionController` from
`@explorable-models/core/declarative` (`controller.ts` only binds it to the rod
document). It owns two toolkit sessions. The primary session records a tentative
parameter preview during dragging. A scratch session, created on the first preview,
evaluates complete frames for immediate display, with at most one retained run.
Both evaluate in browser workers. The SVG, results and accessible description all
read one identified tentative frame (`previewId`, `sequence`), not separate UI-side
physics calculations. Requests are coalesced by the core preview coordinator to one
in flight plus the newest pending value, and preview epochs prevent late replies
from replacing a committed or cancelled gesture.

Release commits one primary run. Only primary artifacts are exported, and exports
are rejected while a preview is tentative. Failures retain the primary frame. When
the page is hidden the card is suspended (scratch worker terminated, primary worker
released once idle) and it resumes paused without catch-up. This example does not
change the session contract or the generic player.

## Model and representation

The rod is uniform and rigid, with a fixed frictionless hinge at one end, in a
uniform gravitational field. Angle θ is from downward vertical toward the right,
bounded to 0–90 degrees. The model evaluates only the instant of release from
rest; this is not a time integration of its subsequent swing.

Torque magnitude is `mg(L/2) sin θ`; the moment of inertia is `mL²/3`.
Clockwise angular acceleration is therefore `3g sin θ/(2L)`, and center-of-mass
tangential acceleration is `3g sin θ/4`. Initial centripetal acceleration is zero.
Mass cancels, so there is no misleading mass slider. Changing rod length changes
angular acceleration but not center-of-mass tangential acceleration.

Scientific coordinates use x right, y up, with the hinge at the origin. The
adapter flips y for SVG and uses a fixed scale of 105 diagram units per metre
(85 in the compact layout). The teal acceleration vector uses 14 diagram units
per m/s² (10 compact), independently of rod scale. Its head is attached to its
endpoint; zero vectors have no arrow. The purple curve is a direction symbol,
not a magnitude scale. Center-of-mass labels are offset from the modeled point.

## Verification and provenance

`tests/reference/fixtures/hinged-rod.json` holds separately derived numerical
acceptance values outside the candidate example. These are engineering fixtures,
not independent human scientific review. The browser tests evaluate the actual
worker, compare reference values, verify perpendicular vectors and midpoint
geometry, exercise live pointer and keyboard previews, cancellation, newest-value
coalescing, failure retention, exact input, zero/boundary states and mobile layout.
Screenshots are written outside source to `/tmp/explorable-models-hinged-rod/`.

```sh
npm run typecheck
npm run test:browser -- hinged-rod.spec.ts
npm run build
```

This example does not claim scientific review, accessibility certification, or
learning efficacy. No provider connection or credentials are required.
