# Explorable Models

A small TypeScript toolkit for interactive explanations that remain inspectable, reproducible, and portable. Models, diagrams, plots, equations, accessible values, and agent commands share one authoritative state.

Public project: [jamesliuai/Explorable-Models](https://github.com/jamesliuai/Explorable-Models). The project was originally called Experiment Kit; `@experiment-kit/*`, the `experiment-kit` CLI, storage keys, and artifact schemas retain their technical names for compatibility. npm namespace ownership remains unconfirmed.

The project includes a browser player, a dependency-free core SDK, a local CLI, and a stdio MCP adapter. Playback needs no AI connection or account.

## Agent-first developer preview

The `0.2.0-preview.1` candidate adds schema 2.0 editable documents, isolated browser sessions, React and plain-DOM surfaces, bounded expressions/data, and provider-neutral authoring tools. The composition studio opens at `/` (also `/agent.html`); `/guide.html` explains the preview. The existing gallery is at `/gallery.html`, and existing `?experiment=…`, embed/capture links, and downloaded v1 startup snapshots still select the legacy player.

```sh
npm run build:packages
npm run verify:packages
```

These commands produce and test local tarballs in `release/preview/`; they do not publish packages. Start with [embedding](docs/embedding.md), [document authoring](docs/declarative-authoring.md), and the [preview contract](docs/agent-first-contract.md). The [release evidence record](docs/agent-first-release-status.md) distinguishes completed checks from the external trials, independent review, and publishing work required for a supported release.

## Run the player

Requires Node.js 22.12 or newer.

```sh
npm ci
npx playwright install chromium
npm run dev
```

Open `http://127.0.0.1:5173` for the studio, or `/gallery.html` for the legacy browser player:

- **Rolling bodies:** four mass distributions, accurate signed rotation, forces, energy partition, time-aligned comparison, 2D and orbitable 3D.
- **Linear transformations:** matrix presets, draggable and exact point controls, basis vectors, signed determinant, and geometric area.
- **Base rates:** expected frequencies, a conditioning diagram, exact contingency table, probability tree, and explicit undefined results.
- **Extension examples:** Riemann sums and an analytical oscillator, using the same core contract.

Save, import, restore, and compare runs in the player. Open **Model & checks** for assumptions, full values, quantitative checks, and machine-readable state. Browser storage is a convenience; download snapshots for durable storage.

## Author an experiment

```sh
npm run kit -- init my-experiment --template linear-map
npm run kit -- dev my-experiment
npm run kit -- check my-experiment
npm run kit -- verify my-experiment
npm run kit -- inspect my-experiment
npm run kit -- capture my-experiment --out frame.png
npm run kit -- export my-experiment --out exports/my-experiment --zip
```

`model.ts` computes values. `experiment.json` declares parameters, quantities, units, and capabilities. `views.json` binds trusted renderers. `checks.ts`, `fixtures.json`, and `model.md` explain what is checked and under which assumptions. Start with an example; see [the authoring guide](docs/authoring.md) and [CLI/MCP reference](docs/tooling.md).

The CLI never imports candidate model/check code into privileged Node. It uses a fixed build pipeline and a dedicated browser worker for authored execution. Source edits are built as candidates; failed checks preserve the last working revision. The first release assumes trusted local authors and is not a public hostile-code hosting sandbox.

## Connect an agent

Use absolute paths in your host's MCP configuration:

```json
{
  "mcpServers": {
    "experiment-kit": {
      "command": "node",
      "args": ["/absolute/path/to/experiment-kit/packages/cli/bin/experiment-kit.mjs", "mcp", "/absolute/path/to/my-experiment"]
    }
  }
}
```

The tools expose describe, inspect, create_run, command, sample, compare, checkpoint, capture, verify, and activate_revision. A live development session can be targeted explicitly through an authenticated loopback bridge. See the tooling reference for session IDs and guarded mutations.

## Build and share

```sh
npm run build
npm run preview
npm run build:sdk
npm run release
```

`dist/` is a self-contained gallery with local fonts/assets, source, and content-addressed definitions. Serve it over HTTP using any static host; direct `file://` loading is not supported. `?experiment=linear-map&embed=1` provides an embeddable player. Production browser exports preserve the selected state in the downloaded bundle. CLI exports require passing quantitative checks and include the exact source, lockfile, hashes, and report.

`npm run release` creates the local distribution tarball. It does not publish to npm or deploy a website. Technical package names remain provisional until npm ownership is confirmed. See [release packaging](docs/release.md).

For the complete local preview artifacts, run `npm run release:preview`. This runs the required suites, builds/installs the tarballs, creates the static archive, checks every deliverable/asset hash, and exercises the actual site archive under a nested URL path. The source repository is the public developer preview; npm publication and website hosting are deferred. Generated `dist/`, `release/`, dependencies, and local session files are excluded from Git. The CI workflow verifies the pushed commit and retains downloadable artifacts with source-revision metadata; it has no publish/deploy job.

`npm run preflight:public` reports remaining metadata for future package/website publication; add `-- --packages` for the npm ownership gate. Those deferred metadata decisions do not block source-repository contributions. See [the public preview handoff](docs/public-preview-handoff.md).

## Check the project

```sh
npm run typecheck
npm test
npm run test:browser
npm run verify:gallery
```

Tests cover independent numerical fixtures, invariants, deliberately wrong calculations, worker timeouts, strict schemas, conflicts, preview isolation, incompatible snapshots, live source activation, MCP interoperability, portable exports, responsive UI, and accessibility checks. See [the acceptance record](docs/acceptance.md) for evidence and boundaries.

Technical checks are not a scientific certification or a learning study. The reference models have documented derivations and automated checks; independent human subject review, assistive-technology user sessions, and the proposed comparative authoring study remain open release-validation work.

## Repository

| Path | Purpose |
| --- | --- |
| `packages/core` | Public types, validation, identity, commands, snapshots, worker execution |
| `packages/player` | React shell and trusted SVG/Three.js renderers |
| `packages/cli` | Fixed compilation, browser coordinator, capture/export, stdio MCP |
| `examples` | Five complete source bundles and worker registries |
| `tests/reference` | Acceptance fixtures outside candidate source folders |
| `tests/core`, `tests/cli`, `tests/browser` | Runtime, tooling, and learner workflows |
| `docs` | Architecture, authoring, security, evidence, and distribution |

MIT licensed. See [third-party notices](THIRD_PARTY_NOTICES.md) and [contribution requirements](CONTRIBUTING.md).
