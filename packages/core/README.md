# @explorable-models/core

Dependency-free TypeScript contracts and runtime for inspectable analytical and parametric experiments. The same validated frame drives visible marks, numerical values, agent inspection, and snapshots.

```ts
import { ExperimentRuntime, WorkerExecutor } from '@explorable-models/core';

const executor = new WorkerExecutor(
  new Worker(new URL('./model.worker.ts', import.meta.url), { type: 'module' }),
  definition.manifest,
);
const runtime = await ExperimentRuntime.create(definition, executor);
const unsubscribe = runtime.subscribe(state => render(state.frame));
await runtime.command({ type: 'seek', time: 1, ...runtime.guard() });
const inspection = runtime.inspect();
const snapshot = runtime.checkpoint('At one second');
```

The worker entry imports only the model and SDK:

```ts
import { exposeModelWorker } from '@explorable-models/core';
import model from './model.js';
exposeModelWorker(model);
```

A definition contains a validated manifest, view bindings, a model card, and a SHA-256 `definitionRevision` covering source, dependencies, and runtime identity. Use `definitionRevision({ manifest, source, dependencyLock, views })` when building.

## Runtime contract

- `command()` serializes learner and agent changes. Mutations require the current `expectedRunVersion` and `expectedActiveRunId`; `guard()` provides both.
- Parameter changes create a new run at the start of the domain. Earlier runs remain available for comparison. Checkpointed runs are retained.
- `tick(deltaSeconds)` advances playback on a 120 Hz canonical grid. Playback ticks do not increment the command version. Exact terminal events preserve their unrounded computed time and physical quantities.
- A preview gesture has a separate identity. Inspect reports tentative parameters; mutations and snapshots fail with `BUSY` until commit or cancellation.
- Selection, layers, camera, and playback speed have a separate view version.
- `sample()` and `compare()` evaluate through the same worker without changing the learner’s active run. Each comparison trace ends at its own boundary.
- Snapshots record exact revision, runtime, parameters, time, and view. Incompatible snapshots fail explicitly; restoration creates a new run with original-run provenance.
- `verify()` returns per-assertion tolerances and provenance. Passing numerical checks does not claim independent model review or learning efficacy.
- `activateRevision()` requires a passing report for the exact candidate revision and current optimistic guards. Failed candidates leave the previous definition and frame intact.

`manifestJsonSchema`, `commandJsonSchema`, `snapshotJsonSchema`, and `timePointJsonSchema` are exported for tools and editors. Runtime validators additionally enforce cross-field relationships, finite values, semantic references, and resource limits.

`ExperimentError` exposes stable codes, a field where relevant, and a recovery suggestion. `toJSON()` returns the structured error used by adapters.

## Execution boundary

Use `WorkerExecutor` for authored model code. The worker is terminated after a configurable watchdog timeout (2 seconds by default), preserving the last accepted frame. The browser player and CLI checks use this worker path. `trustedInlineExecutor` exists only for toolkit-owned reference tests; never use it to load candidate source into a privileged Node process.

This release supports trusted local authoring and reviewed static bundles. A worker is not a hostile-code sandbox or a strict memory quota. Hosted execution of arbitrary uploaded code is outside the supported boundary.

## Build

From the repository root: `npm run build --workspace @explorable-models/core`. This produces ESM JavaScript, TypeScript declarations, and source maps with no runtime dependencies. `npm pack --workspace @explorable-models/core` creates the distributable tarball.

## Declarative preview

Since `0.2.0-preview.1`, the package preserves the legacy main entry and provides `@explorable-models/core/declarative`: schema 2.0, bounded AST expressions, datasets, editable presets, document identities, and browser-worker sessions. The schema 2.0 contract and document runtime `0.2.0-preview.1` are unchanged in `0.3.0-preview.1`, which adds `createDocumentInteractionController`, the shared preview-coalescing controller used by the showcase and hinged-rod examples. Importing this subpath is SSR-safe; its default evaluator needs a browser Worker. `@explorable-models/core/document-worker` is the worker entry for explicit bundler overrides and is marked side-effectful so bundlers retain its listener.

Use `createVisualizationSession`, `createPreset`, `DOCUMENT_SCHEMA`, and `DOCUMENT_LIMITS` from that subpath. Keep schema 1.0 snapshots in their original legacy workflow; v2 rejects incompatible artifacts. Unit labels do not perform conversions. Review status remains unreviewed. The repository's `docs/embedding.md` and `docs/declarative-authoring.md` provide complete integration examples.

## Model contract (`@explorable-models/core/model`)

Model manifest 1.0 describes an installed, versioned model: canonical-unit parameters with domains and admissibility, quantities with shapes, units, meanings and sign conventions, bounded geometry, coupled constraints, interpretation, limits and sources. Execution is either an installed pure kernel (`kernelId@kernelVersion`, `discrete` with an integer `maxIndex` or `static`) or a schema 2.0 document. Requests carry IDs and data only, never source.

```ts
// Worker entry (bundled with the installed kernels).
import { serveModelWorker } from '@explorable-models/core/model';
serveModelWorker(self, [quadraticKernel]);

// Main thread.
import { createModelSession, createWorkerBudget } from '@explorable-models/core/model';
const budget = createWorkerBudget({ maxWorkers: 4, workerFactory: () => new Worker(kernelWorkerUrl, { type: 'module' }) });
const session = createModelSession({ budget, ownerId: 'activity-1' });
const guard = () => ({ sessionId: session.id, expectedVersion: session.getState().version, expectedRunId: session.getState().run?.id ?? null, operationId: crypto.randomUUID() });
await session.load(manifest, null, guard());
await session.previewParameters('gesture-1', { a: 2, eta: 0.3, x0: 4 }, guard()); // tentative frame
await session.commitParameters({ a: 2, eta: 0.3, x0: 4 }, guard());               // new run at index 0
await session.navigate({ kind: 'index', index: 3 }, guard());
```

- `MODEL_MANIFEST_SCHEMA` (bounded JSON Schema, unknown fields rejected) and `validateManifest` (shape, then semantics: ordered bounds, unit/dimension agreement, constraint references, limits, document agreement) return deep-frozen copies. `modelIdentity` splits the exact `digest`, a `scientificRevision` (units, domains, admissibility, meanings, sign/coordinate conventions, declared geometry coordinate units, assumptions, constraint bounds, kernel version or document model revision, and the explanatory content: summary, parameter descriptions and symbols, quantity symbols, geometry and dataset descriptions, constraint messages, and the wording of the title and every label, computed by the exported `labelWording`) and a `presentationRevision` (the exact spelling of the title and labels, and UI steps — label spelling and display precision, report §8.3). Only ordinary white space (excluding invisible U+FEFF and dash-like U+1680), quotation-mark style, Unicode composition and a hyphen or en dash joining two words of three or more letters count as harmless spelling; a reworded, swapped or recapitalized label changes the scientific revision, so a model review does not survive it. For a `document` execution, validation also requires the document's computed dimensions and coherent unit scales to agree with the manifest (unstated input units use base units; output scales follow the expression) (`UNIT_MISMATCH`; an unspecified document dimension is not dimensionless), and the model layer reports document overflow and underflow as `numerical-limit` (OVERFLOW/UNDERFLOW), never as `undefined` or a valid 0.
- Geometry may declare `coordinates: { x, y, z? }`, the canonical unit of each coordinate (additive in 1.0). Without it every coordinate is in the geometry's `unit` (observed geometry: its columns' units). `geometryCoordinates(manifest, id)` returns the units template axes must name exactly.
- `createWorkerBudget({ maxWorkers, workerFactory, maxWaitMs? })`: a lease the owner marks `setReclaimable(true)` (a session's scratch lease between gestures) is released whenever another request would otherwise wait, and a wait longer than `maxWaitMs` (default 10 000 ms) fails with `RESOURCE_LIMIT` and a recovery.
- Manifests may declare `evaluation: { determinism: 'bitwise' | 'within-engine', checkpoint: 'none' }` (additive in 1.0, part of the `scientificRevision`). `bitwise`: every output is determined by exactly specified ECMAScript operations (IEEE-754 arithmetic, the correctly rounded `Math.sqrt`, BigInt, `Math.abs`/`floor`/`ceil`/`sign`/`min`/`max`/`clz32`). `within-engine`: some outputs use engine-approximated functions (`Math.sin`, `Math.cos`, `Math.atan2`, `Math.hypot`, Number `**`, …). `checkpoint: 'none'`: a frame is a pure function of parameters and position, so restore re-evaluates. `limits.maxOperations` bounds the kernel's own evaluated operators, calls and loop iterations; the catalogue tests meter each installed kernel's worst cases against it.
- Schema 2.0 document executions are **opt-in**: call `enableDocumentExecution()` once in every realm that validates, identifies or evaluates a `document` execution, that is, the page and its model worker. Until then they fail with `UNSUPPORTED_CAPABILITY`, and a kernel-only bundle never contains the document compiler or interpreter (`tests/core/document-execution.test.ts`). `serveModelWorker` also accepts a `KernelSource` (installed identities plus `load(id, version)`): each kernel's code is then loaded in the worker on first use, and replies keep arrival order.
- `UNITS`/`convert` cover only the bundled activities' units. `dimensionless` and `iteration` are distinct dimensions and there is no unspecified unit; incompatible conversions throw.
- `checkParameters` is the single rule set for exact entry, previews, commits, restore, sampling and worker requests: exact keys, finite values, `[min, max]` (`OUT_OF_DOMAIN`), integer or `multipleOf` admissibility (relative tolerance 1e-9) and coupled constraints (`CONSTRAINT_VIOLATION`; an undefined constraint value is a violation). `clampForPreview` clamps pointer gestures per parameter, visibly, and never clamps coupled violations.
- Every frame is identified (`frameId` digests model, run, parameters and position) and validated twice: in the worker and again on the main thread, with exact keys, declared shapes, `maxElements` (points, vertices — two per segment — or grid samples) and a terminal consistent with the position. Undefined values and numerical limits keep their status and reason; nothing becomes zero. Missing curve samples split polylines into segments; `gaps[].after/before` index the neighbouring segments.
- `createModelEvaluator` owns one worker with serialized jobs, AbortSignal cancellation, a watchdog (`WORKER_TIMEOUT`), termination on protocol violations (`WORKER_PROTOCOL`), a bounded queue and disposal. `createWorkerBudget` shares a bounded number of workers across activities; primary leases wait ahead of scratch/sample leases, a full wait queue fails with `RESOURCE_LIMIT`, and released evaluators are disposed unless `idleMs` opts into reuse.
- `createModelSession` guards every mutation with `{ sessionId, expectedVersion, expectedRunId, operationId }`. Load, commit and restore start a new run (index/time zero; the saved position for restore); navigation keeps the run and advances the version; discrete indices are whole numbers in `[0, maxIndex]`; time navigation clamps to the exact analytical end. Playback advances one whole index (or one document time step) per scheduler tick without advancing the version and stops at the end or before a numerical limit (play from a frame at a limit is refused with `OUT_OF_DOMAIN`); `play(guard, { throughNumericalLimit })` lets a caller whose display does not show the limit cross it, so playback runs on to the position's own end as for any other run. Previews evaluate the would-be run's initial position on a separate scratch evaluator through `createPreviewCoordinator` (also usable on its own): one active request, one newest queued value, and epochs that discard late replies. `sample` is isolated from run, version, preview, playback and listeners. `suspend` stops playback, cancels the preview and releases workers; `resume` stays paused without catch-up. A failure keeps the last accepted frame with `stale: true`; `dispose` rejects pending work and no listener runs afterwards.

Workers isolate model code from the DOM and allow termination; they are not a hostile-code sandbox or a memory quota. Passing these checks is engineering verification, not scientific review.
