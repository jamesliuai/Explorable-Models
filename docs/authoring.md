# Authoring an experiment

This guide covers the retained trusted-local source/CLI contract (schema 1.0). For the new tool-only schema 2.0 preview, use [declarative authoring](declarative-authoring.md) and [embedding](embedding.md). Their artifact formats are deliberately separate.

Choose one question, an explicit model, and useful default parameters. A compact analytical relationship often needs only a few registered quantities and a diagram. Use a static SVG or plot for problems that do not benefit from manipulation or saved state.

## Source contract

Create a source bundle with `npm run models -- init demo --template linear-map`. The compiler accepts only declared local TypeScript/JSON imports and `@explorable-models/core`; it does not load candidate Vite configs, package hooks, or remote modules.

```ts
import type { AnalyticModel } from '@explorable-models/core';

export const model: AnalyticModel = {
  kind: 'parametric',
  evaluate({ params }) {
    return { quantities: {
      'result.square': { value: Number(params.x) ** 2, status: 'valid' }
    } };
  }
};
export default model;
```

Declare `result.square` in the manifest before binding it in a view. Each quantity has a label, dimension, unit, scalar/vector shape, description, and optional entity/reference frame/sign convention. The core rejects nonfinite elements, unknown fields, missing quantities, undeclared geometry, and oversized payloads.

Return `{value:null,status:'undefined',reason:'...'}` when a mathematical result is undefined. Do not substitute zero, NaN, or Infinity. An analytic model declares `timeDomain(params)` with a finite `end` or `null`; parametric models have time zero and no playback controls.

Evaluation must be pure: no DOM, wall-clock, network, ambient randomness, or cross-run mutable state. The trusted local author is responsible for the mathematics. A worker watchdog and CSP limit accidental capabilities; they do not certify hostile-code isolation.

## Visual contract

Use declared geometry (`polyline2`, `polyline3`, `points2`, `points3`, or bounded triangles) and quantities as the public output. The generic player renders 2D geometry, values, equations, and controls for new examples; the three flagship examples also have reviewed-in-code topic-specific renderer adapters. A new custom visual adapter is trusted code and needs its own representation tests.

Keep coordinate conventions explicit. Reference quantity IDs rather than recalculating the formula in a component. Disclose view transforms such as force-arrow scale. A geometric area is nonnegative even when a determinant is negative. Expected frequency displays may contain fractional counts and must disclose rounding.

Every direct manipulation needs an exact numeric or click alternative. Include semantic IDs, descriptive labels, non-color encodings, keyboard focus, and structured values. Do not announce animation frames to screen readers. Honor reduced-motion settings and provide pause and single-step.

## A repeatable agent workflow

1. Read the question, assumptions, and manifest. Reuse the closest example.
2. Edit the model and views without introducing a new dependency unless needed.
3. Run schema/build checks, then quantitative verification against independent fixtures.
4. Inspect default, interior, boundary, and undefined states through the same worker path.
5. Capture representative scenes and review geometry, labels, selection, and mobile layout.
6. Save a checkpoint, revise one feature, and confirm unrelated values still agree.
7. Export only after checks pass. Preserve the source and exact definition revision.

Independent acceptance fixtures live outside the candidate folder. Author checks may be included in `checks.ts`, but remain `author` provenance. Correctness, representation quality, subject review, and learner evidence are distinct claims.

## State and commands

All scientific parameter commits start a new run at the initial time. Preview gestures expose tentative values and block checkpoint/capture mutation until committed or cancelled. Saved runs remain available for comparison. View commands use `expectedViewVersion`; model commands use `expectedRunVersion` and `expectedActiveRunId`. Playback ticks do not increment the mutation version.

Sample alternate parameters without replacing the learner's active state. Snapshot restore creates a new run with original provenance. A mismatched schema, runtime, or definition revision fails explicitly; there is no silent migration. Captures execute in a separate frozen browser context.

## Verify and publish responsibly

Use fixed numerical values plus invariants, degenerate cases, and transformations with known effects. Conservation alone does not prove phase or dynamics. Default scalar tolerance is `1e-9 + 1e-8 × abs(reference)` unless a check declares otherwise.

Include question, assumptions, domain, derivation, units, sources, limitations, and checks in `model.md`. Keep review status unreviewed until an independent named reviewer has performed a scoped review. Neither passing tests nor visual polish establishes learning efficacy.
