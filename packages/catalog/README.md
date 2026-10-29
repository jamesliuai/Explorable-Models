# @explorable-models/catalog

Installed, versioned Study Harness activity catalogue: model manifests, activity templates, learner copy, pure
kernels, a kernel worker entry and the host review authority. Discovery returns only what is bundled in this package.
Agent input cannot name a path, URL, module or loader.

## Installed content

| Template | Model | Kernel | Reference suite |
| --- | --- | --- | --- |
| `quadratic-gradient-descent@1.0.0` | `quadratic-gradient-descent@1.0.0` | `quadratic-gradient-descent@1.0.0` (discrete, 0 ≤ n ≤ 1000) | `tests/reference/fixtures/activities/quadratic-gradient-descent.json` |
| `function-derivative@1.0.0` (2D) | `function-derivative@1.0.0` | `function-derivative@1.0.0` (static) | `tests/reference/fixtures/activities/function-derivative.json` |
| `linear-transformation@1.0.0` (2D) | `linear-transformation@1.0.0` | `linear-transformation@1.0.0` (static) | `tests/reference/fixtures/activities/linear-transformation.json` |
| `vector-orientation-3d@1.0.0` (3D) | `vector-orientation-3d@1.0.0` | `vector-orientation-3d@1.0.0` (static) | `tests/reference/fixtures/activities/vector-orientation-3d.json` |
| `quadratic-surface-gradient@1.0.0` (3D) | `quadratic-surface-gradient@1.0.0` | `quadratic-surface-gradient@1.1.0` (static; point values exact, then rounded once) | `tests/reference/fixtures/activities/quadratic-surface-gradient.json` |

Domains, conventions and undefined states of every package are summarised in
`docs/study-harness/content-packages.md`; each model manifest states them in full. The two 3D templates declare the
`spatial-3d@1.0` capability and declare alternatives without WebGL (2D projections, tables and exact entry). The
equivalence claim of each template alternative names, in `verifiedBy`, the browser test that checks it (an
`alternative <id>` test in `tests/browser/study-*.spec.ts`, run in Chromium against the integration fixture). These are
automated equivalence checks. Manual assistive-technology sessions remain an external gate (A37). The quadratic package is described in more detail below.

The quadratic model is fixed-step gradient descent on f(x) = a·x²/2. Its parameters are curvature a in [0.1, 10],
step size η in [0, 2] and start x0 in [−10, 10], with the coupled constraint η·a ≤ 4. Positions are evaluated in closed
form with one final rounding. x0 = 0 is exactly zero, η·a = 1 gives exactly zero after n = 0, and η·a = 2 alternates
±x0 exactly. A value beyond the double range is reported as a numerical-limit status, never as a number: `OVERFLOW`
carries the last finite iteration, and `UNDERFLOW` means a nonzero value too small to represent. Subnormal values are
valid but flagged as approximations. The regime is classified from (x0, η·a) only, never from iterates or displayed
digits.

The template's required flow runs predict → explore-step → explore-curvature → explain → closed. The trace,
observations, regime and substituted equation are solution-bearing groups, so they need a host exposure receipt.
`free-explore` is a separate stage for authorized free exploration. Response requests name host-owned task families
only. The catalogue contains no answers, rubrics or held-out items.

Template and model references are computed from content (`templateRef`, `modelIdentity`), never written by hand.
The manifest's reference-suite digest is the sha256 of the fixture file's exact bytes. `tests/catalog` checks it.

## Lifecycle status

`status(ref)` resolves, in order:

1. `revoked` when the host revocation list names the exact ID and version. This applies to every digest, including
   modified copies. A revoked model also revokes its templates.
2. `deprecated` when the host deprecation list names the entry or its model.
3. `reviewed` only when host-supplied review records match the exact subject. For a model, the subject is modelId,
   version and scientificRevision. For a template, it is templateId, version and contentDigest = `templateDigest`. The
   record must also name the current reference-suite digest. A template is reviewed only if its model is reviewed too.
   Any matching `rejected` record blocks approval.
4. `reference-checked` when the model has an installed reference suite.
5. `validated` otherwise.

A reference whose exact digest the catalogue does not hold gets `authored` with no reviews.

**No installed entry has an independent human subject review.** Without host records, the highest status is
`reference-checked`. Automated reference agreement is engineering evidence. It is not scientific review, an
accessibility certification or evidence of learning benefit.

## Host review records, revocations and deprecations

```ts
import { createInstalledCatalog } from '@explorable-models/catalog';

const catalog = createInstalledCatalog({
  reviews: hostReviewRecords,          // study-harness.review-record 1.0, from the host's trusted store
  revocations: [{ kind: 'template', id: 'quadratic-gradient-descent', version: '1.0.0', reason: '…' }],
  deprecations: [],
  include: ['quadratic-gradient-descent'], // optional subset
});
```

Review records are validated. Malformed records, records with an unknown outcome and records that reuse a review ID
with different content are ignored and listed in `catalog.reviewRegistry.ignored`. They never approve anything. A
malformed revocation or deprecation throws instead, because dropping a revocation silently would reactivate revoked
content. Review-like fields in templates, manifests, artifacts or agent input are never read. The registry keeps
frozen copies, so later changes to the host's input objects have no effect.

## On-demand content for learner pages (`createLazyCatalog`)

`createInstalledCatalog` keeps every installed template, its learner copy, its model manifest and the pure kernels in
memory. That suits tooling, tests and hosts that need every template at once. A learner page that opens a few
templates uses `createLazyCatalog` instead. It takes the same options (`reviews`, `revocations`, `deprecations`,
`workerFactory`, `include`) and serves the same references, statuses and discovery entries:

```ts
import { createLazyCatalog } from '@explorable-models/catalog';

const catalog = createLazyCatalog({ reviews: hostReviewRecords, revocations: hostRevocations });
catalog.listTemplates();                 // exact references and statuses at once, no content fetched
await catalog.load({ templateId: 'quadratic-gradient-descent', version: '1.0.0' }); // or let the adapter do it
catalog.getTemplate({ templateId: 'quadratic-gradient-descent', version: '1.0.0' });  // now served
```

- **Eager and small:** the generated installed index (`src/installed-index.ts`, `INSTALLED_INDEX`). It holds template
  and model references, model identities, reference-suite digests, kernel identities and each template's discovery
  entry. Status resolution, revocation and review checks work from the index alone, so `getCapabilities()` lists
  every template before any content loads (`ActivityCatalog.describe`).
- **On demand:** each template's content is one bundled chunk (`src/content/<template-id>.ts`), fetched by `load()`.
  The adapter calls `load()` in `validate`, `prepare` and `restore`. The chunk is served only after it reproduces the
  installed template digest, model digest and model identity exactly. It must also pass the eager catalogue's checks:
  manifest, installed kernel, template schema and semantics. Content that does not match is withdrawn. It is reported
  by `problems()` with `INTEGRITY_FAILURE`, and every reference to it resolves as `authored`. Nothing else is
  substituted. A chunk that cannot be fetched is `NOT_READY` and is not withdrawn.
- A template's `identity()`, which includes its group digests, is available once its content is loaded. A model's
  identity is available at once. `loaded(ref)` and `loadAll()` are provided. The lazy catalogue has no `kernels()`:
  kernel code never enters the page.

The index is generated from the installed content through the eager catalogue's validation, so no reference is
written by hand: `node scripts/study-harness/generate-catalog-index.mjs` (`--check` reports a stale index). The
package `build` regenerates it, and `tests/catalog/lazy.test.ts` fails while the committed index is stale.

## Worker entry

`@explorable-models/catalog/worker` serves `{ type: 'evaluate' }` requests with the installed kernels through
`serveModelWorker`. It imports no templates, copy or manifests. It also imports no kernel code at start:
`INSTALLED_KERNEL_SOURCE` lists the installed kernel identities, and each kernel's module is loaded in the worker the
first time a request names it (a `KernelSource`). A request for any other kernel is refused without loading. The
worker does not enable schema 2.0 document execution, because the installed catalogue serves kernel models only. A
host that serves document-kind models supplies its own worker, which calls `enableDocumentExecution()` (see
`@explorable-models/core`). `catalog.createWorker()` creates the worker with
`new Worker(new URL('./worker.js', import.meta.url), { type: 'module' })`. Hosts whose bundler needs a different
construction pass `workerFactory`. `catalog.kernels()` (eager catalogue) returns the same trusted kernels for
in-process tests.

## Evaluation behaviour and work bounds

Every installed manifest declares `evaluation: { determinism, checkpoint }` (report §8.1).

- `bitwise`: quadratic gradient descent, function and derivative, and linear transformation use only exactly
  specified ECMAScript arithmetic. That includes the correctly rounded `Math.sqrt`; the quadratic kernel's logarithm
  only estimates an index that is then verified exactly.
- `within-engine`: vector orientation (`Math.atan2`, `Math.cos`, `Math.sin`, `**`) and the quadratic surface
  (`Math.cos`, `Math.sin`, `Math.hypot`). Their last bits can differ between JavaScript engines.
- `checkpoint: 'none'`: every kernel keeps no evaluation state. A frame is a pure function of the parameters and the
  position, so restore re-evaluates the saved position.

`limits.maxOperations` bounds the kernel's own evaluated operators, calls and loop iterations.
`tests/catalog/kernel-work.test.ts` meters each kernel over its worst cases and fails when the count exceeds the
declaration. The worst cases are the scenarios, the domain corners, the extreme admissible values including
subnormals, a seeded sample and the largest index. The test also checks the worst-case evaluation time.

## Adding a package

Add the kernel to `src/kernels/index.ts` and `src/kernels/loaders.ts`, the manifest to `src/models/index.ts`, the
template to `src/templates/index.ts`, a content module `src/content/<template-id>.ts` with its loader in
`src/content/loaders.ts`, then regenerate the installed index. Declare `evaluation` and an honest `maxOperations`
(checked by the work test). Add independent fixtures under `tests/reference/fixtures/activities/`, with an oracle that
does not import catalogue code. `createInstalledCatalog` validates every installed entry. An entry that fails is not
served and is reported by `problems()`. The index generator refuses to index content that fails.
