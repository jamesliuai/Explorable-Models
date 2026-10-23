# Explorable Models

**An agent-first TypeScript toolkit for interactive scientific visualizations.**

Explorable Models turns explicit mathematical models and data into interactive scenes, plots, equations, and tables. Agents can discover the available capabilities, compose a visualization, inspect its computed values, and revise it through structured tools. Developers can embed the same visualization in a React or plain-DOM application.

Every model-driven view and agent inspection reads from the same committed model state. Move a point, change a parameter, or advance time, and the diagram, numerical readouts, and equations stay connected to the quantities they represent.

The toolkit includes a dependency-free core, an embeddable browser player, provider-neutral agent tools, and a local CLI with MCP adapters. Playback requires no AI connection or account. Your application owns the agent connection, authentication, navigation, and persistence.

> **Developer preview:** `0.2.0-preview.1` is available from this source repository. Build local package tarballs to use it in another application; npm publication and a hosted demo are deferred. See the [preview contract](docs/agent-first-contract.md) for the supported scope.

## What you can build

Compose linked 2D scenes, line and scatter plots, bars, shaded regions, equations, value panels, and tables. Add bounded parameter controls, draggable points with exact numeric alternatives, analytical playback, and comparisons between retained runs.

The studio includes eight editable examples:

| Example | Explore |
| --- | --- |
| Waves | Amplitude, frequency, and the exact value at a probe |
| Coordinate geometry | Triangle side lengths, area, and degenerate cases |
| Projectile motion | Trajectory, position, and velocity through the exact impact time |
| Linear transformations | Matrix action, basis vectors, determinant, and area |
| Riemann sums | A closed-form midpoint approximation and its signed error |
| Oscillators | Analytical displacement, velocity, and phase |
| Supplied data | Observations alongside an explicitly defined model curve |
| Probability | Base rates, expected frequencies, and conditional probability |

These presets are ordinary editable documents built from the public primitives. The separate source-based gallery includes five TypeScript experiments, including a rolling-body model with 2D and 3D views.

The declarative preview supports analytical and parametric models with bounded expressions and numeric datasets. General 3D, numerical differential-equation solvers, stochastic simulation, and arbitrary generated JavaScript are outside that API.

## Quick start

Requires **Node.js 22.12 or newer**.

```sh
git clone https://github.com/jamesliuai/Explorable-Models.git
cd Explorable-Models
npm ci
npm run dev
```

Open [localhost:5173](http://127.0.0.1:5173) for the composition studio. Choose a preset, adjust its parameters, and inspect the document and computed values. The preview guide is at `/guide.html`; the source-based gallery is at `/gallery.html`.

Install Chromium before using the CLI's browser-backed commands or running browser tests:

```sh
npx playwright install chromium
```

## Author with an agent

Agent-first means authoring is a structured API: tools expose schemas, expression capabilities, resource limits, computed state, and repair diagnostics. An agent can create and revise declarative documents without generating application code or automating the UI.

The workflow is explicit:

1. **Discover** the document grammar and supported capabilities with `visualization_discover`.
2. **Inspect** the current session and mutation guards with `visualization_inspect`.
3. **Create or revise** a candidate with `visualization_create` or `visualization_revise`.
4. **Commit** the validated candidate with `visualization_commit`.
5. **Operate, inspect, and save** the accepted visualization through the same session.

Edits target stable quantity, series, view, and mark IDs. Mutations carry version guards so stale agent calls cannot silently overwrite newer user changes. Failed candidates preserve the last accepted visualization. Validation checks schema, references, and computation; scientific correctness still needs independent evidence.

For a compatible MCP host, configure the local declarative adapter using the absolute path to your checkout:

```json
{
  "mcpServers": {
    "explorable-models": {
      "command": "node",
      "args": [
        "/absolute/path/to/Explorable-Models/packages/cli/bin/experiment-kit.mjs",
        "mcp-document"
      ]
    }
  }
}
```

This starts a browser-backed session for document authoring and computational inspection. It has no mounted visual surface or screenshot tool. To show the visualization in your own application, use the embedded player and `@experiment-kit/agent`, with the host authorizing calls to the browser session.

See [document authoring](docs/declarative-authoring.md), the [agent package](packages/agent/README.md), and the [CLI/MCP reference](docs/tooling.md) for document examples, transport integration, and the full tool contract.

## Embed in an application

Build and verify the local packages from the repository root:

```sh
npm run build:packages
npm run verify:packages
```

The verification command creates and tests package tarballs in `release/preview/`. Install those matching tarballs in your application as described in the [embedding guide](docs/embedding.md).

In a browser client entry, create a session, commit a preset, and mount it into a dedicated container:

```ts
import { createPreset, createVisualizationSession } from '@experiment-kit/core/declarative';
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

// When the host tears down this visualization:
// surface.unmount();
// session.dispose();
```

React applications can render `<VisualizationSurface session={session} />` from `@experiment-kit/player`. The imperative DOM API uses React internally and provides a ShadowRoot for style isolation. Each session owns its worker and state; multiple surfaces can share a session. The [embedding guide](docs/embedding.md) covers lifecycle, worker configuration, persistence, and SVG export.

## Keep the model and the view connected

The runtime makes the relationship between computation, interaction, and rendering explicit:

- **One committed frame.** Scientific values come from model quantities evaluated in a browser worker. Renderers bind to those values and apply presentation transforms.
- **Separate model and presentation changes.** Committing parameters or model edits starts a new run. Styling and layout edits preserve scientific state. Preview gestures remain tentative until committed or cancelled.
- **Explicit undefined values.** Invalid mathematical results carry a status and reason. Missing data stays missing, and plotted lines leave gaps at missing samples.
- **Reproducible artifacts.** Saved artifacts record exact revisions and runtime identities. Incompatible restores fail explicitly. Hosts own durable storage.
- **Inspectable assumptions and checks.** Documents and source bundles expose assumptions and limitations. Author checks and independent reference fixtures retain distinct provenance.

## Author custom TypeScript models

For source-based experiments, the retained schema 1.0 workflow provides pure TypeScript models, declared view bindings, model documentation, and author checks:

```sh
npm run kit -- init my-experiment --template linear-map
npm run kit -- dev my-experiment
```

After stopping the development server, validate, inspect, capture, or export the experiment:

```sh
npm run kit -- check my-experiment
npm run kit -- verify my-experiment
npm run kit -- inspect my-experiment
npm run kit -- capture my-experiment --out frame.png
npm run kit -- export my-experiment --out exports/my-experiment --zip
```

Authored model and check code runs in a browser worker, never in privileged CLI Node. This workflow supports trusted local authors; it is not a hostile-code hosting sandbox. See [TypeScript authoring](docs/authoring.md) for the source contract and [tooling](docs/tooling.md) for its MCP adapter.

Schema 1.0 source artifacts and schema 2.0 declarative documents have separate contracts. Keep existing snapshots with their original player and runtime; there is no silent migration between them.

## Build, verify, and share

```sh
npm run typecheck
npm test
npm run build
npm run test:browser
npm run verify:gallery
```

`npm run build` produces the studio and gallery in `dist/`, with local assets and model definitions. Use `npm run preview` to inspect the production build, or serve it over HTTP on a static host. Direct `file://` loading is unsupported. The source-based player supports iframe embedding through `?experiment=linear-map&embed=1`; CLI exports include source, revision hashes, and check reports.

For the complete local preview distribution, `npm run release:preview` runs the verification pipeline and packages the libraries and static site. It does not publish to npm or deploy a website. See [release packaging](docs/release.md) and the [preview handoff](docs/public-preview-handoff.md).

Tests cover numerical reference fixtures, state transitions, boundary and undefined cases, worker failures, guarded edits, snapshots, agent tools, exports, and browser interactions. Automated checks do not establish independent scientific review, accessibility certification, or learning efficacy. The [acceptance record](docs/acceptance.md) and [preview evidence](docs/agent-first-release-status.md) document completed checks and remaining validation work.

## Repository and documentation

| Path | Purpose |
| --- | --- |
| [`packages/core`](packages/core) | TypeScript contracts, document validation, expressions, worker evaluation, and session state |
| [`packages/player`](packages/player) | Embeddable React and DOM surfaces, studio, and source-based gallery |
| [`packages/agent`](packages/agent) | Provider-neutral tool schemas, executor, and session relay |
| [`packages/cli`](packages/cli) | Local authoring, browser coordination, MCP adapters, capture, and export |
| [`examples`](examples) | Source experiments, embedding consumers, and host integrations |
| [`tests/reference`](tests/reference) | Independent acceptance fixtures outside candidate source bundles |
| [`docs`](docs) | Authoring, embedding, architecture, contracts, and release evidence |

For implementation details, start with the [architecture](docs/architecture.md) and [agent-first contract](docs/agent-first-contract.md). For changes and new examples, see [Contributing](CONTRIBUTING.md).

The project was originally called Experiment Kit. Package names (`@experiment-kit/*`), the `experiment-kit` CLI, and existing artifact identifiers retain their technical names for compatibility; npm namespace ownership remains unconfirmed.

MIT licensed. See [LICENSE](LICENSE) and [third-party notices](THIRD_PARTY_NOTICES.md).
