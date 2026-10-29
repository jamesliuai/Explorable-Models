# README visualization captures

These six PNGs are screenshots of the actual learner-facing chart components in the production build. They were
captured with headless Playwright Chromium at device scale factor 2, with bundled fonts and reduced motion.
The Browser plugin was unavailable in this session.

The selection combines a tilted 3D surface as the lead image with representative convergence, derivative, shear,
vector, and contour examples. The gallery is about 1.1 MB in total. Click an image in the [main README](../../../README.md#visualizations)
to open the full-resolution PNG.

The existing browser host supplies catalogue registration, worker execution, persistence, and authorized free
exploration. Screenshots select only the learner component's real figure element. Host buttons, logs, and test
panels are outside the image. Scientific content, axes, legends, status messages, and scaling disclosures are
unchanged. Parameter, scenario, projection, and zoom choices use the actual component controls.

| Image | Pixels | Captured state |
| --- | --- | --- |
| [quadratic-surface.png](quadratic-surface.png) | 2094 × 1384 | Narrow tilted positive-definite bowl; a=2,b=-1.8,c=2; p=(1,-1); perspective projection. |
| [surface-contours.png](surface-contours.png) | 2094 × 1394 | Standard bowl a=2,b=0.5,c=1 with p=(1,1); contours and gradient field; authored view. |
| [function-derivative.png](function-derivative.png) | 2094 × 1328 | A standard quadratic with probe p=-1.5 and secant offset h=1.5; tangent and secant are visible. |
| [linear-transformation.png](linear-transformation.png) | 2094 × 1460 | Shear M=[[1,1.5],[0,1]], with transformed grid, basis, unit square, and test vector; one normal Zoom in action (1.5x). |
| [quadratic-descent.png](quadratic-descent.png) | 2094 × 1464 | Alternating convergence: a=2,eta=0.75,x0=8,iteration8. |
| [vector-orientation.png](vector-orientation.png) | 2094 × 1298 | u=(1,2,0),v=(-1,1,1),u×v=(2,-1,3),their angle; isometric camera. |

The machine-readable [capture record](captures.json) includes the URLs, exact parameters, view and frame IDs,
Chromium version, dimensions, file sizes, SHA-256 hashes, and focused check results. The viewport was
1468 × 1400 CSS pixels, with a 1420 px embedding container. The screenshots use a committed model frame after
persistence and rendering settle. Files are direct PNG captures, with no resampling or compositing.

The capture workflow checks page identity, meaningful learner content, absence of a framework overlay, console
health, and parameter/scenario interactions. Separate default, exact oscillation-boundary, and 390 px learner-card
captures were visually inspected; those QA outputs remain temporary files outside the repository. A full-card
capture can include the explicit suspended state when screenshot scrolling leaves the card viewport; this does not
claim an active-playback or assistive-technology result.

These images were made after SDK candidate verification `2026-10-29T05-29-41.307Z`. They document presentation and
example states; they do not establish scientific review, assistive-technology certification, actual Study Harness
application integration, or learning efficacy.
