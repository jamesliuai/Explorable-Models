# Embed a declarative visualization

The available distribution is a local `0.2.0-preview.1` candidate. Do not assume these package names are published or controlled on npm. Build and verify from this checkout:

```sh
npm ci
npm run build:packages
npm run verify:packages
```

The last command packs core, player, and agent; installs all three tarballs into a fresh temporary application; runs a production build without repository aliases; verifies SSR imports; and exercises React and DOM consumers under a self-only worker/script CSP. Evidence and tarballs are in `release/preview/`. Browser screenshots go to `/tmp/experiment-kit-preview/`.

Install those exact three tarballs in your application, alongside React and ReactDOM. All package versions must match. The imperative surface uses React internally; React applications share the host's peer runtime.

```sh
npm install /absolute/path/to/experiment-kit-core-0.2.0-preview.1.tgz \
  /absolute/path/to/experiment-kit-player-0.2.0-preview.1.tgz \
  /absolute/path/to/experiment-kit-agent-0.2.0-preview.1.tgz react react-dom
```

## Plain DOM

```ts
import { createVisualizationSession, createPreset } from '@experiment-kit/core/declarative';
import { mountVisualization } from '@experiment-kit/player';

const session = await createVisualizationSession();
const guard = () => {
  const state = session.getState();
  return {
    sessionId: session.id,
    expectedVersion: state.version,
    ...(state.run ? { expectedRunId: state.run.id } : {}),
    operationId: crypto.randomUUID(),
    origin: 'host' as const,
  };
};
const candidate = await session.createCandidate(createPreset('wave'), guard());
await session.commitCandidate(candidate.id, guard());
const surface = mountVisualization(document.querySelector('#visualization')!, { session });

// Host-owned durable persistence. Handle storage failures without clearing session.
const artifact = session.exportDocument();
// await yourStorage.save(artifact);
// await session.restoreDocument(artifact, guard());

// On route teardown:
// surface.unmount();
// session.dispose();
```

The imperative mount owns a ShadowRoot to isolate controls from host CSS. Mount only into a dedicated element. It does not change URL, title, global navigation, or storage. Theme is `light` or `dark`; locale defaults to document locale then `en-US`. `controls: false` lets the host supply its own controls against the same session.

## React

Construct the session in a client lifecycle and retain it outside individual render calls. Dispose it when its owner unmounts. Do not dispose a shared session when only one of its surfaces unmounts.

```tsx
import { VisualizationSurface } from '@experiment-kit/player';

export function Explanation({ session }) {
  return <VisualizationSurface session={session} controls theme="light" />;
}
```

`examples/consumer/react.tsx` and `dom.ts` are complete exercised entry points. React styles are scoped to the surface; aggressive global `!important` styles may still interfere, so use imperative ShadowRoot mounting when strict isolation is required. Multiple surfaces have unique SVG and label IDs. Two sessions own distinct workers, run state, subscriptions and candidates.

## Workers, SSR and CSP

Package imports do not read DOM, URL, localStorage or cookies. Session construction with the default evaluator requires a browser with module Workers and Web Crypto. Mounting is client-only. Do not create a browser session during a server render.

The default worker uses a package-relative URL. Vite production builds are verified by the packed consumer check. If your bundler cannot resolve this pattern, supply an explicit factory:

```ts
const session = await createVisualizationSession({
  workerFactory: () => new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' }),
});
// worker.ts contains: import '@experiment-kit/core/document-worker';
```

Serve every worker dependency from an allowed origin. The tested CSP uses `script-src 'self'; worker-src 'self'` and scoped inline styles (`style-src 'self' 'unsafe-inline'`). There is no `unsafe-eval`. A host requiring a nonce-only style policy needs a style injection adapter; that policy is not claimed supported. Set the bundler asset base for subpath hosting. Do not supply arbitrary agent-selected worker URLs.

A failed or timed-out worker rejects the operation and retains accepted state. Late replies are discarded. Hidden-tab timers can be throttled; analytical playback advances by declared simulation steps, not wall-clock catch-up. Remounting a surface uses the same committed frame. Disposal is final; create a new session to continue.

## Capture and export

`exportSceneSvg(session, viewId)` or `surface.exportSceneSvg(viewId)` returns a frozen mounted SVG scene with revision metadata. Pause playback and commit/cancel preview first. It does not capture HTML controls, tables, or equations. The caller stores the returned SVG; do not treat it as an arbitrary HTML screenshot. The initial player exports SVG only; PNG and full-surface capture require a host adapter or the legacy CLI's browser capture.

JSON document artifacts are portable within the exact declared runtime. Persist the full artifact, including retained comparison definitions; saving only run IDs loses data. Legacy CLI exports remain independently playable over HTTP. Schema 1.0 snapshots are rejected by the v2 importer.
