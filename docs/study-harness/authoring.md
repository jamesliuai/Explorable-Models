# Activity authoring: packages and commands

Report §8.1, §12.6, §15.2 and §16; acceptance rows A09 (CLI side), A30 (review packets) and A56. This is the authoring
workflow for Study Harness activity templates: `experiment-kit activity <command>`. It complements the installed
catalogue (`@experiment-kit/catalog`), whose kernels are trusted repository code. Authored kernels and checks are
candidate code: Node only parses and bundles them, and they run only in browser module workers.

Nothing in this workflow reviews content. Every package reports lifecycle `authored`; schema validation, reference
agreement, mutation sensitivity and review packets are engineering evidence for a human reviewer. Approval for Study
Harness use comes only from a host-trusted `study-harness.review-record` bound to exact digests (architecture D16).

## 1 Package format

An authoring package is a directory. Only the files below are read; everything else is ignored (and excluded from
archives).

| File | Required | Content |
| --- | --- | --- |
| `model.json` | yes | `ModelManifest` (`experiment-kit.model-manifest` 1.0): an `execution` of kind `kernel` (authored in `kernel.ts`, or an installed kernel ID and version) or `document` (bounded schema 2.0 document) |
| `template.json` | yes | `ActivityTemplate` (`study-harness.activity-template` 1.0) whose `model` reference carries the exact model digest |
| `kernel.ts` | for authored kernels | Pure kernel exporting `kernel` (see §2); may import relative `.ts`/`.json` files of the package |
| `checks.ts` | no | Author checks exporting `checks` (see §3); run in the checks worker |
| `copy.md` | recommended | Every learner-visible string with its intent, for reviewers |
| `fixtures/reference.json` | recommended | Reference fixtures (`experiment-kit.reference-fixtures` 1.0, §4). May live outside the package: pass `--fixtures <path>` |
| `fixtures/boundaries.json` | no | Declared boundary cases (`experiment-kit.boundary-cases` 1.0, §5) |
| `authoring.json` | recommended | `experiment-kit.authoring-package` 1.0: lifecycle `authored` and the recorded relation to the installed catalogue (§6) |
| `review/` | generated | Captures and the review packet written by `capture` and `review-packet` |
| `.experiment-kit/` | generated | The last working candidate (`check`); never packaged |

### Import allowlist

`kernel.ts`, `checks.ts` and every file they import may use only:

- relative imports of `.ts` and `.json` files inside the package (no escaping the directory, no generated folders);
- `import type { … } from '@experiment-kit/core/model'` (types are erased; a value import is refused).

Refused, with file and line: Node built-ins (`node:fs`), npm packages (`react`), other toolkit entries, value imports
from `@experiment-kit/core/model`, dynamic `import()`, `require(…)` and `import x = require(…)`. The rule is checked by
parsing (TypeScript AST) in `validate`, and again inside the bundler before esbuild sees a file. The candidate's
`tsconfig.json`, `package.json` scripts and build configuration are never read.

## 2 Kernels

```ts
import type { KernelInput, KernelOutput, ModelKernel, QuantityResult } from '@experiment-kit/core/model';
import model from './model.json';

function evaluate({ params }: KernelInput): KernelOutput {
  const m = params.m!, b = params.b!;
  const root: QuantityResult = m !== 0 ? { status: 'valid', value: -b / m }
    : { status: 'undefined', code: 'NO_ROOT', reason: 'A horizontal line has no single root.' };
  return { quantities: { root /* , every other declared quantity */ }, geometry: { /* every declared geometry */ } };
}
export const kernel: ModelKernel = Object.freeze({ id: model.execution.kernelId, version: model.execution.kernelVersion, mode: 'static', evaluate });
```

- Export `kernel` (or a default export) with `id`, `version`, `mode` and `evaluate`; they must equal `model.json`'s
  `execution`. An authored kernel may not reuse an installed kernel ID: authored code never stands in for installed code.
- Return every declared quantity and geometry. Undefined, out-of-range and overflowing values are statuses with codes
  and reasons (`undefined`, `numerical-limit`), never `0` (report §8.2). The worker validates every output against the
  manifest (`validateKernelOutput`) exactly as the runtime does.
- Discrete kernels receive integer `index` from 0 to `maxIndex`.
- Declare how the model evaluates in `model.json` (report §8.1; additive in manifest 1.0, part of the scientific
  revision): `"evaluation": { "determinism": "bitwise" | "within-engine", "checkpoint": "none" }`. Use `bitwise` only
  when every output comes from exactly specified ECMAScript operations: IEEE-754 `+ − × ÷`, the correctly rounded
  `Math.sqrt`, BigInt, and `Math.abs`/`floor`/`ceil`/`sign`/`min`/`max`/`clz32`. Use `within-engine` as soon as an
  output depends on `Math.sin`, `cos`, `atan2`, `hypot`, `log2`, `exp` or Number `**`. `checkpoint: "none"` means the
  kernel keeps no state between evaluations; manifest 1.0 has no other value.
- `limits.maxOperations` is an upper bound of the kernel's own evaluated operators, calls and loop iterations for any
  admissible input and index. A built-in function call counts once. The installed kernels are metered against their
  declaration in `tests/catalog/kernel-work.test.ts`. Declare the bound from the worst case, not the default.
- Schema 2.0 document executions are opt-in in the model layer (`enableDocumentExecution()`; the CLI's pages and
  worker enable it for authored packages). The installed catalogue's own worker serves installed kernels only.
- **Document executions agree with their manifest** (report §8.3, A10). `validate` checks, for every document parameter
  and quantity, that the dimension the document computes with — declared, or inferred from the quantity's expression —
  equals the manifest dimension, and that a unit the document states is the manifest unit (its ID or compact label,
  e.g. `m/s²`); document units are labels and are never converted. Unstated input units use coherent base units; computed quantity and series coordinate scales follow the actual input units through the expression. A manifest cannot relabel metres as centimetres, or seconds as milliseconds, without changing the computation. Mixed-scale additions and scaled trigonometric inputs are refused; use canonical radians with degree display controls. A document parameter without a `dimension` is
  *unspecified*, not dimensionless: it is accepted only under an explicitly `dimensionless` manifest parameter, so
  declare `"dimension": "length"` (and so on) on every dimensional document parameter. The manifest dimension
  `iteration` cannot be used by a document (its algebra cannot tell a count from a pure number); use an installed
  discrete kernel. Each model series' x and y dimensions must match the geometry's coordinate units (below). Failures
  are `UNIT_MISMATCH` with the path of the disagreeing field.
- **Numerical limits in documents** (D10, A11). Through the model layer a document value that overflows is
  `numerical-limit`/`OVERFLOW`; a nonzero value that underflows to 0, or a value computed from one, is
  `numerical-limit`/`UNDERFLOW`; a subnormal result (or a sum whose tiny term was dropped) is valid with an `UNDERFLOW`
  approximation; poles and non-real powers stay `undefined` with their own reasons. A series sample whose value is a
  numerical limit becomes a gap with its reason. Plain schema 2.0 frames keep every status and value (D1): overflow
  stays `undefined` there and underflow stays a valid 0. Only the reason text of an `undefined` value is more specific
  than before: it names the overflow, pole, non-real power or underflowed intermediate step instead of the former
  generic sentences ("The result is nonfinite.", or "Division by zero." for a divisor that underflowed to 0).
- **Geometry coordinate units** (additive in manifest 1.0; part of the scientific revision). A geometry's
  `dimension`/`unit` are those of its dependent coordinate (y of a 2D kind, z of a 3D kind or surface grid). When another
  coordinate has a different unit — the iteration index of a trace, the time axis of a height-over-time curve — declare
  `"coordinates": { "x": "iteration", "y": "dimensionless" }` (and `z` for 3D kinds). Without it every coordinate is in
  `unit`; observed geometry takes its columns' units.

## 3 Author checks

```ts
export const checks = [
  { id: 'flat-line-root-undefined', description: 'Slope 0 gives an undefined root, never 0.',
    run(context) { return context.evaluate({ m: 0, b: 1 }).quantities?.root?.status === 'undefined' || 'root should be undefined'; } },
];
```

`context.evaluate(params?, position?)` merges `params` over the defaults and evaluates through the worker's request
validation; `context.defaults()` returns the defaults. Return `true` (or `{ passed: true }`) to pass; a string,
`false` or `{ passed: false, detail }` fails; a thrown error fails with its message. Author checks are the author's own
assertions and are reported as such; they are not independent reference evidence.

## 4 Reference fixtures

`experiment-kit.reference-fixtures` 1.0 (`packages/cli/src/activity-fixtures.ts` holds the schema):

```json
{
  "contract": "experiment-kit.reference-fixtures", "version": "1.0", "suiteId": "my-line:0.1.0",
  "model": { "modelId": "my-line", "version": "0.1.0" },
  "author": "…", "review": "No independent human subject reviewer has approved these cases.", "semantics": "…",
  "derivedFrom": null, "notCovered": [],
  "cases": [
    { "id": "defaults", "label": "m = 1, b = 1, p = 2", "provenance": "Hand derivation: …",
      "params": { "m": 1, "b": 1, "p": 2 }, "tolerance": { "absolute": 0, "relative": 0 },
      "points": [{ "expect": { "probe.value": 3, "root": -1 } }] },
    { "id": "flat", "label": "m = 0", "provenance": "…", "params": { "m": 0, "b": 2, "p": 1 }, "tolerance": { "absolute": 0, "relative": 0 },
      "points": [{ "expect": { "root": { "status": "undefined", "code": "NO_ROOT" } } }] },
    { "id": "outside", "label": "rejected", "provenance": "…", "params": { "m": 3, "b": 5, "p": 4 }, "tolerance": { "absolute": 0, "relative": 0 },
      "reject": { "code": "CONSTRAINT_VIOLATION", "path": "$.constraints.probe-in-view" } }
  ]
}
```

- Cases state every parameter. A case has `points` (each with an optional `position`; discrete models need
  `{ "kind": "index", "index": n }`) or `reject` (the parameters must be refused before evaluation).
- Expectations: a plain number, array or string means `valid` with no approximation note; `{ "status": "valid",
  "value", "approximation" }` (`UNDERFLOW`, `ROUNDING`, `none`, `any`); `{ "status": "undefined", "code" }`;
  `{ "status": "numerical-limit", "code", "lastFiniteIndex" }`. Numbers match when `|o − e| ≤ absolute + relative·|e|`
  with the case `tolerance` or a per-quantity entry in `tolerances`; statuses, codes and categories match exactly.
- `model.json` binds its suite: `referenceSuite.digest` is the sha256 of the fixture file's exact bytes, so editing the
  fixtures changes the model's scientific revision. `validate` reports the binding (`matches`, `derived-from`,
  `differs`, `unbound`).
- Independence (report §12.6): derive cases by hand or with an independently written method that does not import the
  kernel, and state that in `provenance`. Keep the authoritative copy outside the package (`--fixtures`) when it must
  not change with candidate edits. Converted installed suites record their source file and digest in `derivedFrom` and
  list in `notCovered` the expectations (mostly geometry) that only their repository tests check.

## 5 Boundary cases

`experiment-kit.boundary-cases` 1.0: `{ id, label, rationale, params, position?, expect?: { outcome?, statuses? } }`.
Parameters are merged over the defaults. `boundaries` evaluates the declared cases and generated domain probes (each
parameter at its minimum, maximum and just outside them; first, last and one-past-last index) and classifies each
frame as `valid`, `undefined`, `numerical-limit`, `out-of-domain` (refused before evaluation) or `worker-error`.
Statuses are written `valid`, `valid:UNDERFLOW`, `undefined:<CODE>`, `numerical-limit:<CODE>`.

## 6 Template edits versus new compositions

`validate` computes the relation of `template.json` to the installed catalogue (A08):

| Relation | Condition | Consequence |
| --- | --- | --- |
| `new-composition` | the template ID is not installed | exploratory content, lifecycle `authored`; `scaffold --from` always produces this, with `derivedFrom` naming the exact installed template |
| `template-edit` | installed template ID with a new version | warning: reviews of the installed version do not apply; a new subject review is needed |
| conflict (error) | installed template ID and version with different content | refused: an approved template cannot change under its identity |
| `installed-identical` | exact installed digest | no change |

The same rule applies to `model.json` (an installed model ID and version with different content is refused). A package
cannot declare its own review status: `authoring.json` `lifecycle` other than `authored` is an error.

### Required capabilities

A template names each runtime capability it needs in `requires`, at an exact version. The installed capability records
(`study-harness.capability-record` 1.0, listed by `getCapabilities().capabilities`) are `discrete-iteration@1.0`
(integer indices up to 10,000,000) and `spatial-3d@1.0`. The second carries the 3D renderer's limits per `scene3d` view:
20,000 vertices, 120,000 surface indices, 1,000 vector-field samples, 32 labels, textures of at most 1,024 px and 128
draw calls per frame. `validate` (`validateTemplateSemantics`) rejects the following:

- an unknown capability ID or an unsupported version, with `UNSUPPORTED_CAPABILITY`; no nearest version is used;
- a model capability the template does not require;
- a `scene3d` view in a template that does not require `spatial-3d@1.0`;
- a `scene3d` view whose declared worst-case geometry exceeds the limits, with `RESOURCE_LIMIT`.

Worst-case geometry is computed from the bound geometry's `maxElements`: two vertices per segment or field arrow, and
fewer than ten indices per surface sample. Labels count the three axis names and every mark that carries text.

### Presentation conventions for templates

- **Control sections.** Related controls share an optional `section: { id, label }` (report §10.2, additive in 1.0), for
  example the four entries of a matrix (`Matrix M`) and the components of a vector (`Test vector v`); the learner card
  renders each section as one labelled group where its first control is. Every control of a section carries the same
  label (`validate` reports `DUPLICATE_ID` otherwise). A section is presentation only: visibility stays with `group`.
- **Authored bounds.** The default stages at default parameters should show all their data inside the authored
  `bounds`/`bounds3` (reference-role marks, `grid` marks and `extent: 'line'` marks do not count), so a card opens
  without an out-of-view indicator; explicit Fit to data and zoom remain presentation.
- **Stage instructions.** An instruction must not assert that held content is shown ("The tangent … is now shown")
  when the stage lists solution-bearing groups that are absent until the host reveals them; say what to do once it is
  shown ("Once the tangent at P is shown, …").
- **Axis units.** Every `axes` entry of a scene, plot or table names exactly the canonical unit of what is drawn along
  it: the coordinate units of each bound geometry (and of a table's `rowsFrom` geometry), the unit of each positional
  quantity binding (`at`, `vector`, `from`, `to`, `origin`, `vertices`), and the unit of an axis's own `quantity`.
  Bounds, ticks, coordinates and table cells are canonical values that no renderer converts, so a compatible but
  different unit (cm over metres, ms over seconds, degrees over radians) is a `UNIT_MISMATCH` like an incompatible one;
  an index axis is an `iteration` axis because the trace's horizontal coordinate is declared in iterations.
- **Position group.** A model with iterations or time should declare a quantity group listing its position quantity
  (a scalar of dimension `iteration`, or `time` for a time document), as the quadratic's `navigation` group lists
  `index`. The run's position, navigation and playback are that group's content: a stage shows navigation only while
  the group is visible (`fixed` shows the position without stepping or playback), and an independent task keeps it
  only when the host's neutral scaffold lists the group. Without a position group, navigation follows the stage in
  instructional work and is absent in independent work ([activity-runtime §3](activity-runtime.md#3-projection-62-d6)).

## 7 Commands

All commands print a JSON report and exit 1 on failure. Node never imports authored code.

| Command | What it does |
| --- | --- |
| `scaffold <dir> [--id <id>]` | Copies the example package (`packages/cli/templates/activity`: a line with an authored kernel, checks, fixtures and boundary cases) and assigns new IDs and digests |
| `scaffold <dir> --from <installedTemplateId> [--kernel copy\|installed]` | Exploratory copy of an installed package with a NEW template ID, version 0.1.0 and lifecycle `authored`. `copy` (default) copies the installed kernel source into `kernel.ts` under a new kernel and model ID; `installed` keeps the exact installed model. Converts the installed reference suite into `fixtures/reference.json` (with `derivedFrom`) and derives boundary cases from its non-valid expectations |
| `validate <dir> [--fixtures <path>]` | Data only: model and template schemas and semantics, the template warnings below, scenario values over the defaults against every coupled constraint, execution source, import allowlist, relation, fixtures and boundary files |
| `check <dir> [--timeout <ms>]` | Validates, bundles, and in Chromium (external network blocked) loads the checks worker, evaluates the defaults and every scenario through the runtime's worker client, and runs the author checks. A pass stores the last working candidate (`.experiment-kit/last-good/`: files, digests, time); a failure leaves it untouched and reports it |
| `reference <dir> [--fixtures <path>]` | Runs the fixtures against worker-evaluated frames; per-case pass/fail with provenance, tolerances and the first problems |
| `boundaries <dir>` | Declared boundary cases and generated probes with their outcome classification |
| `capture <dir> [--stage <id>\|--all-stages] [--width] [--theme] [--fonts] [--index]` | For each stage: prepares the activity through the adapter with the browser integration fixture host (author-preview policy whose ceiling is every group), has the host authorize the stage's solution-bearing groups through the persist-before-reveal path, mounts `StudyActivitySurface` with the learner binding and writes `<stage>.png` (card screenshot), `<stage>.svg` (the surface's pure-SVG capture of the primary view) and `<stage>.txt` (projection-only companion). Each stage record lists the surface diagnostics (`LABEL_CALLOUT`, `LABEL_OVERLAP`, `CLIPPED`, `MATH_FALLBACK`, …). Default output `review/captures/` |
| `capture <dir> --policy <file> [...]` | Learner-scoped capture: the same flow under a supplied `study-harness.host-policy` (see *Learner policies* below). The host authorizes only the stage's solution-bearing groups inside that policy's ceiling; under an active independent task the host enters the task, so only its neutral scaffold shows. The report and `captures.json` record the policy (`source: "supplied"`, ID, revision, mode, what its ceiling withholds). Default output `review/learner-captures/` |
| `preview <dir>` / `preview --installed <id>` `[--policy <file>] [--stage <id>] [--port <n>] [--theme] [--fonts] [--no-open]` | Serves the author view and the learner view side by side on `127.0.0.1` with a stage selector and a diagnostics panel (see *Preview* below). Prints a JSON report with the URL, opens the default browser unless `--no-open`, and stops on Ctrl-C (SIGINT/SIGTERM), removing its temporary bundle. `--host` accepts only `127.0.0.1` (or `localhost`); any other address is refused before anything is read or bound |
| `review-packet <dir>` / `review-packet --installed <id> --out <dir>` | Subject-review packet: README.md and packet.json (§8) plus captures of every stage. Default output `review/` |
| `package <dir> [--format zip\|tgz] [--out <file>]` | Validates, then writes a reproducible archive of exactly the authoring files with `package-manifest.json` (per-file byte length and sha256, template and model digests, scientific revision, reference-suite binding, authored-source digests, lifecycle `authored`) |

Outputs that replace earlier ones (captures, packets, the last-good record) are written to a staging directory and
swapped in only after the run completed, so a failed run keeps the previous outputs of the last working candidate.

### TeX parse check

`validate` (and `preview`, through the same `templateDiagnostics`) parses every equation's TeX with the toolkit's own
KaTeX under the learner renderer's bounds (`trust: false`, `maxExpand: 1000`, `maxSize: 20`, a fresh macro object,
MathML output only) — trusted toolkit code that reads the TeX as data; no authored code runs. Each `{{q:…}}`
placeholder is replaced, in turn, by every form the projection can substitute for its quantity (a signed decimal, an
approximate value in scientific notation, a vector in parentheses, and the status word every value can take), so an
equation that parses only with a numeral (`\frac{{q:a}}{2}`) is caught before any capture or preview shows
`MATH_FALLBACK`. A failure is a `MATH_FALLBACK` warning on `template.json` at `$.equations[i].tex` with KaTeX's reason
(never the source text) and the recovery — the code a mounted surface reports when it shows the equation as plain text.
It is a warning, like label and clipping diagnostics, because learners still get the equation's required plain-text
form; the TeX-safe symbols declared in `model.json` are parsed too and reported the same way at
`$.parameters.<id>.symbol` / `$.quantities.<id>.symbol`. Sources the hostile-TeX screen refuses are not parsed (the
semantic check already reports them as errors). The helpers are `templateTexSources`, `manifestTexSources` and
`texParseDiagnostics` in `@experiment-kit/activity`, which take the parser as an argument so the learner entry never
bundles it. The five installed templates and models parse cleanly (`tests/activity/text-safety.test.ts`).

### Template warnings

`validate` (and `preview`) report two warning codes from `templateWarnings` in `@experiment-kit/activity`, once the
template has no semantic errors. They are warnings: the package still validates and prepares, and the adapter's
`validateTemplateSemantics` is unchanged. Orphaned references (a stage, view, mark, control, equation, scenario or
alternative naming an ID that does not exist) remain `INVALID_REFERENCE` errors. Each stage is read as the most
permissive host would apply it (every group inside the ceiling, every solution-bearing group granted), with the
projection's own visibility rules, so a warning means that no host policy can make the element reach a learner.

| Code | Reported for |
| --- | --- |
| `UNREFERENCED` | a group with no members and nothing assigned to it; an equation no equation view lists; a control no stage lists in `controls`; a quantity of a quantity group that no view, axis, mark binding or equation placeholder uses; dataset geometry no mark draws and no table lists |
| `NEVER_VISIBLE` | a view whose group no stage shows (reported on the view, not again on its group); any other non-empty group no stage shows; a view quantity or table source no stage that shows the view can read; a mark never shown together with its view and the groups of the data it binds; an equation never shown together with an equation view listing it and the quantities it substitutes; a control whose stages never show its group |

The five installed templates produce none (`tests/activity/template-warnings.test.ts`).

### Learner policies

`capture --policy <file>` and `preview --policy <file>` read a `study-harness.host-policy` JSON file (at most 256 KiB).
It is validated against the schema and the policy semantics, must not be revoked or expired, and must authorize the
mode the activity runs in: an authored package always runs exploratory, so the policy must allow exploratory
activities; an installed template (`preview --installed`) runs approved when the policy approves its exact template and
model digests, otherwise exploratory if allowed. A refused policy is reported with `stage: "policy"` and exit code 1.
The supplied policy is never widened: nothing is added to its ceiling, permitted controls, approvals or tools.

Without `--policy`, `preview` uses the **derived default learner policy**: every group of the template inside the
ceiling, every control permitted, learner-facing tools only (`prepare`, `inspect.learner`, `request-reveal`, the
`operate.*` tools, `summarize`, `close`), tutor inspection limited to what the learner sees, no developer or teacher
inspection, no sampling, no learner snapshots or backups, no independent task; exploratory for an authored package and
approved (exactly this template and model) for an installed one. What the learner view shows is then decided by the
template's stages and the host's exposure grants, as in a host that permits the whole template.

### Preview

`experiment-kit activity preview` validates the package, resolves the learner policy (a refused `--policy` stops it
with `stage: "policy"` before anything is served), bundles the fixed preview page
(`packages/cli/src/activity-preview-page.ts`) with the model worker, writes `preview-input.json` next to it and serves
the bundle on `127.0.0.1` (an available port, or `--port`) with the CLI's content security policy: no remote
origin, worker scripts with `connect-src 'none'`, and a Host-header check. Authored model code runs only in the page's
module worker; the CLI process never evaluates it. The page runs two lanes, each a real adapter activity against its own
in-page browser integration fixture host (a conformance fixture, not a Study Harness host):

- **Author view** (purple): the template with every group visible and every control listed in every stage (stage
  modes kept where the stage lists them, `fixed` elsewhere), prepared exploratory under an author policy whose ceiling
  is every group; the fixture host authorizes its solution-bearing groups. It is an author aid, never a learner
  channel. Its table lists every group with the selected stage's own visibility and what the learner view shows of it,
  or why not (not in this stage, outside the policy ceiling, not in the independent task scaffold, no host grant).
- **Learner view** (green): the template itself under the learner policy, mounted with the learner binding. Its
  *Learner projection (JSON)* panel is the learner projection, nothing else.

The stage selector moves both lanes through the adapter's host-authorized flow: `requestStageTransition` along the
template's transitions (shortest path, receipts, persist-before-reveal). A stage the current stage cannot reach restarts
the activity at `initialStage` and walks the transitions from there; a stage no transition reaches is prepared
directly, with its solution-bearing groups requested through `requestReveal` as a stage entry. Under a policy with an
active independent task every stage is prepared directly and the host enters the task. The route line under the
selector names each step and host receipt. A surface acknowledges a grant only while it is visible, so a lane scrolled
out of view shows "Paused while hidden" and the grant as awaiting display until it is seen.

A package whose `model.json`, `template.json` or kernel does not validate cannot be prepared. The preview then serves a
diagnostics-only page listing every validation and semantic error (orphaned references, missing equivalents, unit
mismatches, schema errors, …) from a bundle without the authored kernel; the report has `passed: false`,
`stage: "validate"` and `learnerPolicy: null` (a `--policy` file is read only once the package validates), and the
command exits 1 when stopped.

The diagnostics panel lists the package's validation and semantic diagnostics (including the template warnings), what
the learner policy withholds, and the surface diagnostics each lane's surface reports for the selected stage:
`LABEL_CALLOUT` (a label with no free place, drawn as a numbered callout with its full text in the figure's label key),
`LABEL_OVERLAP` (a callout tag that still overlaps), `CLIPPED` (bounded data outside the authored view at the authored camera; `role: "reference"` marks,
`grid` marks and `extent: "line"` segments are never counted), `MATH_FALLBACK` and `MATH_ASSETS_UNAVAILABLE`, and
command failures. Surfaces are mounted afresh after each stage selection, so the panel shows exactly the selected
stage's reports. 3D views use the surface's 2D projection fallback and coordinate table, as captures do.

## 8 Review packets

A packet states: exact template and model digests, scientific and presentation revisions, the reference-suite digest
bound by the model and the fixture file actually run; derivation, assumptions, limitations, units and conventions,
parameters, quantities and constraints; the reference cases with provenance, tolerances and results; a mutation-
sensitivity summary (generic faults injected inside the checks worker: sign, factor of two, unit slip, transposition,
swapped inputs, undefined or limit reported as zero, boundary nudges) and pointers to activity-specific mutation tests;
boundary outcomes; default and scenario outcomes and author checks; stage-by-stage captures; task intent and host-owned
task families; content-group digests; accessible alternatives with their verification IDs (and whether the named file
exists); and an **empty reviewer sign-off**, which an engineering agent cannot sign.

Installed packets live in `docs/study-harness/review-packets/<templateId>/` and are regenerated with:

```sh
for id in quadratic-gradient-descent function-derivative linear-transformation vector-orientation-3d quadratic-surface-gradient; do
  npm run kit -- activity review-packet --installed "$id" --out "docs/study-harness/review-packets/$id" --index 4
done
```

`--index 4` shows iteration 4 in stages that allow navigation of discrete models. The 3D templates are captured
through the surface's 2D projection fallback and coordinate table: the capture page does not load a spatial renderer
(the 3D renderer is developed separately). Once the capture page can load it, the same command regenerates the packets
with 3D views; until then the packets say so.

## 9 Where authored code runs (§16)

1. `validate` parses JSON and TypeScript; it never evaluates authored code.
2. The bundler (esbuild) parses and concatenates: authored files enter only through the allowlist plugin; the worker
   entries and harness pages are fixed toolkit files (`packages/cli/src/activity-worker.ts`, `activity-harness.ts`,
   `activity-capture.ts`, `activity-preview-page.ts`).
3. Chromium loads the bundle from a loopback server. Worker scripts are served with `script-src 'self'` and
   `connect-src 'none'` (no `eval`, no network); every request to another origin is aborted and reported.
4. Model evaluation uses `createModelEvaluator` (watchdog, output validation, late-reply rejection); checks and mutation
   batches run in a separate worker, so a faulty `checks.ts` cannot disturb evaluation.

`tests/cli/activity-check.test.ts` runs a kernel whose top level tries `require('node:fs')`, `process.mainModule`,
`process.exit` and `fetch`: the CLI process is unaffected, no file is written, and the check fails in the worker with
`WORKER_ERROR` while the last good candidate is kept. Workers isolate candidate code from Node and the DOM and can be
terminated; they are not a complete hostile-code boundary (report §16). The supported threat model is trusted local
authoring.

## 10 Toolkit resolution and packed trees

The CLI resolves `TOOLKIT_ROOT` three directories above `packages/cli/src`: the repository root, or the root of the
unified `experiment-kit` release, which keeps the same layout. `@experiment-kit/*` resolve to
`packages/<name>/src` entries there, for the browser bundles and for the Node-side toolkit (bundled at run time, so the
working directory, workspace links and tsconfig paths do not matter). Documented fallbacks:

- a missing source entry is left to normal `node_modules` resolution of the published package;
- `scaffold --from … --kernel copy` needs `packages/catalog/src/kernels/`; without it the scaffold uses
  `--kernel installed`;
- installed reference suites come from `tests/reference/fixtures/activities/`; without them packets report the
  reference run as unavailable (a status, not a pass);
- stage captures need `examples/study-harness-host/fixture-host.ts` and fail with `TOOLKIT_INCOMPLETE` otherwise.

`tests/cli/activity-packed.test.ts` runs the executable from an unrelated directory against a copy of that layout
with no `@experiment-kit` links and no tsconfig. The release pipeline's clean install remains the authoritative check.

## 11 Repair cases

| Diagnostic | Typical cause | Repair |
| --- | --- | --- |
| `INVALID_IMPORT` (kernel.ts line n) | `import { x } from '@experiment-kit/core/model'` | `import type { x } …`, or copy the helper into the package |
| `INVALID_REFERENCE` model.json `$.referenceSuite.digest` | fixtures edited after binding | set the digest `validate` prints (the scientific revision changes), or restore the fixtures |
| `CONFLICT` template.json `$.version` | edited an installed template in place | new `templateId` (exploratory) or new `version` (reviewed-template edit, new review) |
| `CONFLICT` model.json `$.execution.kernelId` | authored kernel reuses an installed kernel ID | give the kernel and model a new ID |
| `CONSTRAINT_VIOLATION` template.json `$.scenarios[i]` | scenario values violate a coupled constraint over the defaults | choose admissible scenario values |
| `MISSING_EQUIVALENT` | a drawing has no equivalent alternative visible in a stage | add an `equivalent` alternative covering the view and make its group visible there |
| `WORKER_ERROR` (check `loadError`) | kernel.ts throws while loading or exports no kernel | read the message; export `kernel` |
| `INVALID_REFERENCE` kernel.ts (check) | kernel ID/version/mode differ from model.json | make them equal |
| `WORKER_TIMEOUT` | evaluation does not finish within `--timeout` | bound the work; declare `maxOperations` honestly |
| `INVALID_INPUT` model.json `$.observations.<id>.missingReason` | a `null` cell has no reason | list it in `missing` or give `missingReason` (§13) |
| `INVALID_INPUT` model.json `$.observations.<id>.rows` | the manifest copy of a document dataset differs from the document | make the rows equal cell for cell |
| `KIND_MISMATCH` template.json `…marks[j].bindings.geometry` (observed data) | a `curve`, `trace` or other connected mark draws observations | use a `points` mark; draw any curve from a model series |
| `UNIT_MISMATCH` template.json `$.views[i].axes.<axis>.unit` | the axis names a unit other than the canonical unit of a coordinate or quantity it draws | name that unit; nothing converts axis values |
| `UNIT_MISMATCH` model.json `$.execution.document.<parameters\|quantities>.<id>.<dimension\|unit\|expression>` | the manifest's dimension or unit contradicts the document (or the document leaves a dimensional parameter unspecified) | make the document and manifest declare the same dimension and unit |
| `UNIT_MISMATCH` model.json `$.execution.document.series.<id>.<x\|y>` | a document series draws a time (or another dimension) where the geometry's coordinates say otherwise | declare the geometry's `coordinates` |

## 12 Limits of this tooling

- Reference agreement shows agreement with the stated cases at the stated tolerances; it is not proof of correctness,
  and author checks are not independent evidence.
- Captures without `--policy` come from an author-preview policy that can show every group; a host's real policy may
  show less. `capture --policy` and the preview's learner view apply a policy you supply (or the derived default) in
  an in-page fixture host; they show what the projection rules give under that policy, not how a Study Harness host
  issues, stores or enforces policies.
- The preview's author view is an aid for authors: it shows content no learner policy shows, and its stage modes are
  not the template's. Its diagnostics are developer-facing; none of them is a review or an accessibility result.
- The generic mutation operators perturb outputs or inputs after evaluation; activity-specific mutants remain in the
  repository's reference tests. They cover only quantities with an expectation in the suite; `mutation.uncovered` lists
  the others.
- A converted installed suite copies case data. Where it restates an expectation that the fixture file does not list
  literally (the quadratic suite's start.position, start.loss and product), `derivedFrom.conversion` says how.
- Packets and archives record lifecycle `authored` or the installed catalogue status; they never approve content.

## 13 Observed datasets

Report §8.5: bounded, immutable observed data beside model output, never interpolated or fitted without an explicit
model. Observed rows live in the model manifest (`ModelManifest.observations`, additive in manifest 1.0) and are drawn
through `observations2` geometry. The example package `examples/study-harness-observed/` (illustrative values, not
catalogue content) shows the whole path.

```json
"sources": [{ "id": "drop-log", "kind": "dataset", "citation": "Where the data were published or recorded." }],
"geometry": {
  "measured": { "kind": "observations2", "label": "Recorded heights", "description": "…", "dimension": "length", "unit": "m",
    "coordinateFrame": "time horizontal (s), height vertical (m)", "maxElements": 11, "observations": { "dataset": "drops", "x": "t", "y": "h" } }
},
"observations": {
  "drops": {
    "label": "Recorded heights", "description": "One reading every 0.2 s.",
    "columns": [
      { "id": "t", "label": "Time", "dimension": "time", "unit": "s", "meaning": "Time since release." },
      { "id": "h", "label": "Height", "dimension": "length", "unit": "m", "meaning": "Height above the floor." }
    ],
    "rows": [[0, 20.02], [0.2, 19.81], [0.4, null], [null, 7.49]],
    "missing": [{ "row": 3, "column": "t", "reason": "The frame timestamp was not recorded." }],
    "missingReason": "No height could be read in this frame.",
    "provenance": { "sourceId": "drop-log", "description": "How the rows were obtained, selected, rounded or cleaned.", "license": "CC-BY-4.0" }
  }
}
```

- **Units and meaning.** Every column has a supported unit ID, the matching dimension and a meaning; free-form unit
  text is not accepted. An `observations2` geometry plots two columns, `x` then `y`, and declares the `y` column's
  dimension and unit. Values are stored as recorded, in the column's unit; nothing is converted.
- **Missing cells.** `null` is a missing cell. Each needs a reason: its own entry in `missing` (zero-based row, column
  ID) or the dataset's `missingReason`. A `missing` entry for a cell that holds a value, or listed twice, is an error.
  Missing cells are shown as missing with their reason in tables, notes and summaries; they are never 0, never filled
  in and never bridged.
- **Provenance.** `provenance.sourceId` names a manifest source of kind `dataset` (its citation is shown with the data);
  `description` says how the rows were obtained; `license` is given when known. Learners see a source line under the
  observed table.
- **Limits.** At most 8 datasets, 16 columns and 2000 rows per dataset, 20,000 cells in total, and `maxElements` of the
  observed geometry at least the row count. Every frame carries every observed row, so keep datasets small.
- **Identity.** Every cell, unit, dimension, meaning, missing-cell reason, the provenance and the geometry binding
  belong to the scientific revision; changing one cell invalidates approvals bound to it. Labels and the dataset
  description are presentation. The content digest of a `dataset` group includes the observed datasets its geometry
  plots.
- **Runtime.** Observed geometry is attached to each frame by the runtime from the manifest, never by the model: a
  kernel that returns observed geometry fails validation, and the page checks that every worker reply carries the
  manifest's rows exactly (`WORKER_PROTOCOL` otherwise).
- **Kernels and documents.** A kernel model declares observations only in the manifest. A schema 2.0 document plots a
  dataset through a dataset series, which is `observed` unless the document says `kind: "model"`: it maps to
  `observations2` geometry over the same dataset and columns, and the manifest observation dataset with the same ID
  must repeat the document dataset's column IDs and rows exactly (a document column unit, when given, must be the
  manifest unit ID or its label). A sampled expression series is model output; marking it `observed` is an error. A
  dataset series labelled `kind: "model"` is tabulated model output and maps to `polyline2`.
- **Templates.** Observed geometry is drawn only by a `points` mark in a 2D view. A `curve`, `trace`, `segments`,
  `region` or any other mark over observations is `KIND_MISMATCH`: a line through observations needs an explicit model
  series, a separate model geometry that a `curve` mark draws. A table's `rowsFrom` may name observed geometry: its
  columns are an observation number and the dataset's own column labels and units.
- **Labels.** When a model declares observed geometry, the learner projection names the origin of everything it
  shows: observed marks end with “(observed)”, other data marks and every readout with “(model)”, observed table
  columns with “(observed)” and model table columns with “(model)” (`origin` on projected marks, values and tables).
  The 2D plan draws each complete observed row as one marker of the mark's style and notes how many rows are drawn
  and which are missing, with their reasons; the view summary and capture text say the same.

Sampling of model curves is disclosed in the same places: a `polyline2` that carries `sampling` gets a `sampling`
note in the 2D plan (sample count, the range of its sampling variable — x for the installed kernels, a document
series' own variable otherwise — and the spacing; the line between samples does not certify values between them), and
`check` reports each default-frame geometry's `sampling` (and an observed geometry's row and missing counts).
Hand-written copy that states a sample count must match the kernel; `tests/catalog/sampling-copy.test.ts` checks the
installed copy against the kernel constants and the projected table step.

