# Observed-data example

`observed.html` shows observed data beside a model prediction (report §8.5) through the real activity adapter, a real
module worker (core's model worker protocol with schema 2.0 document execution) and the learner surface. It is
**example content**, not an installed catalogue package: nothing here is reviewed, and the recorded heights are
illustrative values constructed by hand for this example (their provenance says so), not a measurement. The in-page
example host (`host.ts`) keeps the journal and receipts in memory; it is not the Study Harness host.

| File | Content |
| --- | --- |
| `content.ts` | Model manifest (document execution: the prediction h(t) = h₀ − g t²/2 as a model series, the recorded heights as an observed dataset series), its `observations.drops` dataset with units, missing-cell reasons and provenance, and the activity template |
| `worker.ts` | Module worker: `enableDocumentExecution()` and `serveModelWorker` with no kernels |
| `host.ts` | In-memory example HostPort (echoing receipts, idempotent by key) |
| `main.ts`, `observed.html` | The page; `window.observedExample` exposes read-only hooks and the host actions used by the browser test |

Run `npm run dev` and open `/examples/study-harness-observed/observed.html`. Query parameters: `?stage=compare` (the
host shows the model after opening; default is the `observe` stage), `&explore=1` (also authorizes slider previews),
`&width=<px>`, `&theme=dark`, `&text=200`.

What it demonstrates (authoring guide §13): observed rows are drawn as separate markers by a `points` mark and never
joined, interpolated or fitted; missing cells are shown as missing with their reasons; the source line, legend, table
columns, readouts, notes, summaries and captures say which data are observed and which are model output; changing the
model's parameters starts a new run while the observations stay identical. Tests: `tests/activity/observed-data.test.ts`,
`tests/player-activity/observed-plan.test.ts` and `tests/browser/study-observed-data.spec.ts` (Chromium example-page
results only).
