# Author a document through tools

The v2 path accepts JSON, with no project files, compiler or browser automation required for creation. Retrieve `visualization_discover` first, then `visualization_inspect` for current mutation guards. Tool discovery is a contract description, not proof of scientific correctness. The host must authenticate and authorize the browser session before forwarding a call.

A complete compact document:

```json
{
  "schemaVersion": "2.0",
  "id": "wave",
  "title": "Sine wave",
  "description": "Change amplitude and inspect the curve.",
  "parameters": { "amplitude": { "label": "Amplitude", "value": 2, "min": 0, "max": 5 } },
  "quantities": { "peak": { "expression": "amplitude*sin(2*pi*0.25)", "label": "At x = 0.25" } },
  "series": { "wave": { "label": "Model sine", "x": "x", "y": "amplitude*sin(2*pi*x)", "domain": [-1, 1], "samples": 201 } },
  "views": [
    { "id": "plot", "type": "plot", "title": "Sine", "bounds": [-1, 1, -5, 5], "marks": [ { "id": "curve", "type": "line", "label": "Sine curve", "series": "wave" } ] },
    { "id": "values", "type": "values", "title": "Probe", "quantities": ["peak"] }
  ],
  "assumptions": ["The sine argument is in radians."],
  "limitations": ["Uniform sampling is bounded and does not establish mathematical continuity."]
}
```

Send this as `document` to `visualization_create` with `guard`. Creation returns a candidate ID; `visualization_commit` accepts it if the base version is still current. Both operations need distinct operation IDs. A retry of the same operation uses the exact same input, including operation ID. Inspect again after a conflict; never just overwrite a newer user's version.

## Targeted revision

A revision is an atomic batch keyed by stable IDs. For a second curve, add its series and its mark in the same batch. This leaves the original series unchanged:

```json
[
  { "op": "set", "collection": "series", "id": "comparison", "value": { "label": "Cosine comparison", "x": "x", "y": "amplitude*cos(2*pi*x)", "domain": [-1, 1], "samples": 201 } },
  { "op": "setMark", "viewId": "plot", "mark": { "id": "comparison", "type": "line", "label": "Cosine comparison", "series": "comparison", "style": { "stroke": "#aa5533", "dash": "dashed" } } }
]
```

`set` and `setMark` replace the full identified object. Inspect it before changing one field so existing fields are preserved. `presentation` replaces the presentation object. Removing a referenced quantity fails with a path diagnostic. Repair the document or batch, then retry under a new operation ID. Candidate validation is schema/reference/computation validation with author provenance; it is not an independent model check.

To move a label, update its pixel `offset`; the scientific anchor stays in a bound quantity. Styling, bounds/projection, label placement, layout and precision change presentation identity while preserving run/time. Changing a binding, expression, data row, parameter domain/default or scientific coordinate creates a new model revision and run.

## Binding catalog

| Mark | Binding quantities |
| --- | --- |
| point, label | `position`: vector `[x,y]`, or scalar `x` and `y` |
| segment, arrow | `start`, `end`: two-element vectors |
| path, polygon | `points`: flat vector `[x0,y0,x1,y1,…]` |
| circle | `center` vector, `radius` scalar |
| ellipse | `center` vector, `rx`, `ry` scalars |
| angle | `center`, `radius`, `startAngle`, `endAngle`; angles in radians |
| line, scatter, bar, region | `series`: declared series ID; optional bound `baseline` for bar/region, default zero |
| group | bounded `children`, with stable IDs |

Every mark has an accessible label. `semanticId` links selection across views; selection has a non-color outline. Group order is z-order. Scientific coordinates are quantities evaluated in the worker. Literal SVG/HTML, event handlers, remote images, arbitrary CSS and raw path strings are rejected. Colors use bounded tokens; assets and links are not supported.

A view is a scene, plot, values list, equation, or table. Equations are safe plain text with `{{quantityId}}` substitutions; full TeX authoring is not part of v2. Bounds are `[xmin,xmax,ymin,ymax]`; scenes default to equal aspect. Log scale requires positive domains and positive projected samples. The renderer clips to bounds and leaves gaps at missing samples. Readouts preserve inspected precision and use scientific notation for small nonzero values.

## Expressions and dimensions

See generated `document-schema.json` and installed type declarations for fields. Parse limits and supported functions are returned by the core expression exports. Arithmetic supports scalar/vector operations under explicit shapes, selected trigonometry and domain-safe functions; no loops, dynamic module names, property traversal or arbitrary JavaScript is accepted.

Symbols are declared parameter/quantity IDs, `time`, `pi`, `e`, and the series' local sampling variable. Hyphenated IDs are not recommended in expressions because minus is an operator; use identifier-safe names for referenced quantities. Literal vectors have 2–256 finite elements. Arrays of arbitrary records are not vectors; use datasets.

The `dimension` field is optional. A parameter without it is dimensionless; a quantity expression infers supported dimensions. Literal numeric/vector quantities can declare their physical dimension. A literal zero can adopt the compatible dimension in addition or a vector, but nonzero constants cannot silently become a length/time. `time` has time dimension. Unit strings label values and never imply conversion. Supported base dimensions and derived aliases are documented by the core expression source; unsupported symbolic/affine unit reasoning is rejected rather than claimed checked. Trigonometric arguments are dimensionless radians or angles. Use an explicit `pi/180` conversion for numeric degrees in a dimensionless parameter.

Division by zero, invalid square root/log/angle domains and nonfinite results produce `{value:null,status:'undefined',reason:...}`; the reason names the cause (a pole such as `0^-1`, a non-real power such as `(-8)^(1/3)`, or a numerical overflow). Dependent quantities propagate undefined. When a document runs as a model `document` execution (Study Harness model layer), the same interpreter classifies numerical limits separately: an overflow is reported as `numerical-limit`/`OVERFLOW`, a nonzero result that underflows to 0 (or a value computed from one) as `numerical-limit`/`UNDERFLOW`, and a subnormal result as valid with an `UNDERFLOW` approximation — never as a valid 0. The schema 2.0 frames of this runtime keep every status and value; only the reason of an `undefined` value is more specific than in earlier previews (it names the overflow, pole, non-real power or underflowed intermediate step instead of a generic nonfinite or division-by-zero sentence). Missing dataset cells stay null with reasons at series sampling. There is no inferred data cleaning or regression.

## Data, parameters and time

Datasets declare column IDs, labels, unit metadata, numeric/null rows and a description. A series either samples `x` and `y` expressions over a bounded domain or references dataset columns. `kind: 'model'` distinguishes predicted curves from supplied observations. Data edits are model-input revisions. The worker never fetches data; the host validates and supplies immutable snapshots.

Parameters have finite bounds; `integer: true` enforces integer exact entry. `step` is a UI increment, not an assertion that every valid value lies on that increment. Scientific commits restart at zero. Preview gestures remain tentative, with accepted visuals unchanged until commit; Escape/cancel discards them. Drag bindings name scalar x/y parameters and have exact-entry alternatives.

Analytical documents declare `time.end` and optional step. Seek clamps exactly to the end and evaluates actual terminal quantities. The projectile preset keeps its impact velocity. Parametric documents have time zero and no playback controls.

## Save, inspect, repair

Use `visualization_save` to obtain a JSON artifact and store it through the host. `visualization_restore` verifies all exact identities and dependencies before replacing accepted state. No implicit localStorage is used. Errors distinguish invalid input, resource limit, unsupported capability, conflict, cancellation and execution failure; undefined mathematical values are frame results, not fabricated zeros.

Reject unsupported requests honestly. General 3D, numerical differential solvers, stochastic simulation, arbitrary generated code, automatic graph layout and autonomous package installation are outside the declarative capability envelope. Preserve the last accepted visualization and describe the closest supported composition without claiming it implements the missing capability.
