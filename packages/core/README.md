# @experiment-kit/core

Dependency-free TypeScript contracts and runtime for inspectable analytical and parametric experiments. The same validated frame drives visible marks, numerical values, agent inspection, and snapshots.

```ts
import { ExperimentRuntime, WorkerExecutor } from '@experiment-kit/core';

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
import { exposeModelWorker } from '@experiment-kit/core';
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

From the repository root: `npm run build --workspace @experiment-kit/core`. This produces ESM JavaScript, TypeScript declarations, and source maps with no runtime dependencies. `npm pack --workspace @experiment-kit/core` creates the distributable tarball.

## Declarative preview

Version `0.2.0-preview.1` preserves the legacy main entry and adds `@experiment-kit/core/declarative`: schema 2.0, bounded AST expressions, datasets, editable presets, document identities, and browser-worker sessions. Importing this subpath is SSR-safe; its default evaluator needs a browser Worker. `@experiment-kit/core/document-worker` is the worker entry for explicit bundler overrides and is marked side-effectful so bundlers retain its listener.

Use `createVisualizationSession`, `createPreset`, `DOCUMENT_SCHEMA`, and `DOCUMENT_LIMITS` from that subpath. Keep schema 1.0 snapshots in their original legacy workflow; v2 rejects incompatible artifacts. Unit labels do not perform conversions. Review status remains unreviewed. The repository's `docs/embedding.md` and `docs/declarative-authoring.md` provide complete integration examples.
