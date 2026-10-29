# Packed activity consumer (Study Harness visualizer)

A small application that consumes the Study Harness packages **only as packed tarballs**, the way an outside host
would. `scripts/study-harness/verify-consumer.mjs` copies this directory into a fresh temporary directory, installs the
six tarballs from `release/study-harness/packages/` with an isolated, empty npm cache (no workspace links, no aliases),
typechecks it against the packed declarations, builds it with Vite for production, serves the build under a strict
production CSP and drives it in Chromium. `scripts/study-harness/benchmark.mjs` measures the same production build.

It is a **packed-consumer fixture**, not a Study Harness host: its `HostPort` (`src/host.ts`) keeps every record in page
memory, approves exactly the installed template it is asked to open, and is labelled as a fixture on every page.
Results obtained with it say nothing about the Study Harness application, a packaged WebView or learning outcomes.

## Pages

| Page | Entry | What it shows |
| --- | --- | --- |
| `activity.html` | `src/activity-dom.ts` | Plain-DOM host: `createStudyHarnessVisualizer` with `mountStudyActivity` (shadow root per card) |
| `activity-react.html` | `src/activity-react.tsx` | React host: one React root renders every card as `<StudyActivitySurface binding={…} />`, adapter from `createStudyHarnessAdapter` |
| `spatial.html` | `src/spatial.ts` | Plain-DOM host with `spatialLoader: () => import('@experiment-kit/player-3d')`; Three.js loads only for a `scene3d` view |
| `bench.html` | `src/bench.ts` | Benchmark fixture (not budgeted): measured cards, a wrapped catalogue worker with optional reply delay, the fixture host with controllable latency, and the schema 2.0 document player for the document-path workloads |

All pages use the catalogue's own kernel module worker (`new Worker(new URL('./worker.js', import.meta.url), { type:
'module' })` inside `@experiment-kit/catalog`), bundled by Vite into a separate worker asset. Styles: the host chrome is
a linked stylesheet (`src/page.css`); the learner surface adopts its own constructable stylesheet. No page has inline
scripts or style attributes, so `style-src 'self'` and `script-src 'self'` suffice.

Each page exposes its host steps as `window.consumer` (`src/page.ts`: `open`, `transition`, `revealStage`,
`authorizeExploration`, `commit`, `settle`, `capture`, `exposures`, `displayAcks`, `events`, …) or `window.bench`
(`src/bench.ts`), and sets `document.body.dataset.ready = 'true'` once ready. Shared host sequencing is in
`src/session.ts`.

## Build and measure

```sh
node scripts/study-harness/verify-consumer.mjs   # pack, clean install, SSR imports, typecheck, builds, budgets, CSP flows
node scripts/study-harness/benchmark.mjs         # performance and lifecycle measurements of the production build
```

`vite.config.mjs` builds all four pages into `dist/`; `CONSUMER_ENTRY=activity` (or `activity-react`, `spatial`,
`bench`) builds one page alone into `dist-<name>/`, which is how the dependency budgets in
`docs/study-harness/budgets.json` are measured. The verified production build is kept in
`release/study-harness/consumer/dist` (with `build.json`, the tarball identities it was built from). Evidence:
`docs/study-harness/evidence/consumer.{json,md}` and `docs/study-harness/evidence/performance.{json,md}`; method and
findings: `docs/study-harness/performance.md`.

The root `tsc` also checks these sources against the monorepo sources (through the root path mappings); the clean
install checks them against the packed declarations with this directory's `tsconfig.json`.
