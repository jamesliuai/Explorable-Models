# Build and install a release

For the agent-first `0.2.0-preview.1` local candidate, run `npm run release:preview` and see [preview operations](preview-operations.md), [embedding](embedding.md), and [the evidence record](agent-first-release-status.md). This produces separately installable core/player/agent libraries and a static site archive. The unified source/CLI packaging described below remains a separate path and preserves the legacy schema 1.0 workflow. Nothing is published automatically.

The release package is a unified TypeScript toolkit plus its prebuilt static gallery. It retains `packages/core`, `packages/player`, `packages/cli`, examples, tests, and documentation so the fixed authoring compiler can resolve its trusted sources. The core SDK also has its own package build for applications that need only the contract and runtime.

## Build locally

```sh
npm ci
npx playwright install chromium
npm run build
node scripts/package-release.mjs
```

Packaging writes `release/experiment-kit-0.2.0-preview.1.tgz` and `release/release-manifest.json`. The script stages only declared source roots and allowed file types, promotes the compiler/browser dependencies required at runtime, removes workspace and private-package settings, generates a distributable lock, and builds the gallery in that staged dependency context.

The package includes `npm-shrinkwrap.json` because npm deliberately excludes `package-lock.json` from published tarballs. Gallery and CLI definition identities use the same exact lock bytes and runtime/player source digest. A normal source checkout uses its package lock instead. The package declares no installation lifecycle scripts of its own.

Before packing, the script verifies every gallery experiment in Chromium with external network requests blocked, checks fresh-instance state restoration, and includes the reports and upstream playback license texts in `dist`. It then checks `npm pack --dry-run`, verifies the file inventory excludes local credentials and session bridges, creates the tarball, extracts it into a fresh temporary directory, runs `npm ci --ignore-scripts`, starts the executable, runs a quantitative check through the actual Chromium worker, checks gallery/CLI revision agreement, and builds the standalone SDK. The release manifest records hashes, size, file count, and these results. Nothing is published to an npm registry or a hosting provider.

## Use the packaged toolkit

Extract the tarball and work inside its `package` directory:

```sh
tar -xzf experiment-kit-0.2.0-preview.1.tgz
cd package
npm ci
npx playwright install chromium
npm run kit -- init my-experiment --template rolling
npm run kit -- dev my-experiment
```

Or install the local tarball into another project:

```sh
npm install /absolute/path/to/experiment-kit-0.2.0-preview.1.tgz
npx playwright install chromium
npx experiment-kit init lesson --template linear-map
npx experiment-kit verify lesson
```

The executable is named `experiment-kit`. Node.js 22.12 or newer is required. Chromium is a one-time local authoring/test dependency; exported learners do not install Node, Chromium, or an AI client. The prebuilt `dist` directory can be hosted as a static gallery. Custom exports are built with `experiment-kit export <source> --out <directory> --zip` and served over HTTP.

## Release meaning

The distribution is usable software for the documented 0.1 scope: local analytical/parametric authoring, inspected state, guarded agent commands, saved comparisons, technical checks, static export, and accessible manual playback. Quantitative checks and browser tests do not establish scientific peer review or learning efficacy. The model cards retain their actual review status, and the acceptance record separately identifies human subject review, user studies, vendor-host compatibility, and comparative adoption evidence that have not been completed.

Hosted compilation, public arbitrary-code uploads, stateful numerical solvers, stochastic adapters, and MCP Apps embedding are outside this release. A browser worker is not advertised as an adversarial sandbox.
