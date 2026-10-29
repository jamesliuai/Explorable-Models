# Authoring, agent tools, and portable exports

Explorable Models uses one public runtime for learner controls, CLI inspection, and agent commands. Model and author-check modules execute in a dedicated browser worker. The Node CLI bundles source using toolkit-owned esbuild and Vite configuration; it never imports a candidate model, loads its Vite config, runs its package scripts, or evaluates its checks in Node.

## Install and create an experiment

Use Node.js 22.12 or later. From the toolkit checkout or unpacked release:

```sh
npm ci
npx playwright install chromium
npm run kit -- init my-experiment --template linear-map
npm run kit -- dev my-experiment
```

The preview command prints a loopback URL and writes `my-experiment/.experiment-kit-session.json` with mode `0600`. Open the URL in an ordinary browser. Stop the command with Ctrl+C. The connection file is removed on a clean shutdown and is never included in exports.

Available templates are `rolling`, `linear-map`, `base-rates`, `riemann-sums`, and `oscillator`. Initialization refuses to overwrite a nonempty directory. Source is ordinary TypeScript plus JSON:

| File | Purpose |
| --- | --- |
| `experiment.json` | Public identity, learning question, parameter/quantity schemas, assumptions, and capabilities |
| `model.ts` | Default or named `model` export implementing `AnalyticModel` |
| `views.json` | Trusted view declarations and semantic bindings |
| `checks.ts` | Default or named `checks` export containing a `CheckSuite` |
| `fixtures.json` | Transparent fixture data for readers and independent harnesses |
| `model.md` | Model derivation, assumptions, units, sources, and limitations |

Use `import type { AnalyticModel, CheckSuite } from '@experiment-kit/core'` for public types. Static relative imports of TypeScript or JSON helper files are allowed inside the experiment directory. Symlink escapes, remote imports, arbitrary packages, and dynamic imports are rejected. Imported helper files enter the source digest and export. The limit is 128 files and 2 MiB of source. The toolkit lockfile and exact core and player sources also enter definition identity.

Scientific parameter edits always start a new run. Presentation changes use separate view state. Angles are radians in models; a control may declare a degrees conversion. Undefined values must use `value: null`, an explicit status, and a reason.

## Check before sharing

```sh
npm run kit -- check my-experiment
npm run kit -- verify my-experiment --out check-report.json
npm run kit -- inspect my-experiment
npm run kit -- sample my-experiment --args '{"parameters":{"a":2,"b":0,"c":0,"d":3},"times":[0]}'
npm run kit -- capture my-experiment --out frame.png
npm run kit -- export my-experiment --out exported-experiment --zip
npm run kit -- serve exported-experiment
```

`check` validates schemas, builds the worker, launches Chromium, and validates a default frame. `verify` asks the worker for the author suite and runs the same mathematical evaluation path used in playback. Candidate assertions are reported as **author** provenance even if the supplied object calls itself a reference suite. The independent reference tests in the toolkit repository are separate evidence. A failed check returns a nonzero exit status. Passing quantitative checks does not imply subject review, accessibility certification, or learning efficacy.

`capture` opens a separate frozen player, restores its exact snapshot, waits for the player to confirm render readiness and fonts, and writes both a PNG and `<filename>.png.json` containing frame/view identity and viewport. It never pauses or seeks the source player. Capture supports widths and heights from 320 to 4096 pixels. Use `--snapshot saved-state.json` to restore before a headless operation.

Exports contain `index.html`, local assets, the model card, experiment metadata, source files, `source.zip`, the dependency lock, a quantitative check report, and a bundle manifest with SHA-256 hashes. `--zip` also creates a sibling archive. Export refuses to overwrite a nonempty directory and refuses a failing check report. Source transfer uses an explicit allowlist plus imported local helpers; `.env`, chat logs, local connection tokens, and unrelated files are excluded.

Serve the directory through HTTP. Direct `file://` execution is not supported. The browser runner blocks all external network during verification and capture; ordinary exported playback needs only its local assets. Embed the player using its `?embed=1` route in an iframe. Hosting applications should preserve the exact exported revision alongside snapshots.

## Operate the learner's live player

Every agent mutation must carry the current version and active-run identity. Do not cache those guards across learner changes.

```sh
npm run kit -- inspect my-experiment --session my-experiment/.experiment-kit-session.json
npm run kit -- command my-experiment --session my-experiment/.experiment-kit-session.json \
  --args '{"type":"set_parameters","parameters":{"a":2},"expectedRunVersion":0,"expectedActiveRunId":"run-ID-FROM-INSPECT"}'
npm run kit -- checkpoint my-experiment --session my-experiment/.experiment-kit-session.json --out saved-state.json
```

Inspect returns the real frame, parameter values, units, statuses, view version, selected objects, and preview status. A stale mutation returns `CONFLICT`; an active preview gesture returns `BUSY` to agent mutations and checkpoint operations. Restore with `command` type `restore`, the snapshot object, and current guards. Restoration creates a new run and preserves provenance. Definition or schema incompatibility returns `INCOMPATIBLE_SNAPSHOT`.

When several preview tabs are open, run `sessions --session <connection-file>` and supply `--session-id <id>`. The coordinator refuses ambiguous routing. It binds only to `127.0.0.1`, checks Host and Origin, and requires a random per-process bearer token. Browser responses have a same-origin resource policy; worker responses prohibit network connections. Tokens never enter model messages or static exports.

After editing source, activate the candidate deliberately:

```sh
npm run kit -- activate my-experiment --session my-experiment/.experiment-kit-session.json \
  --args '{"expectedDefinitionRevision":"sha256:CURRENT-DIGEST","expectedRunVersion":0,"expectedActiveRunId":"run-CURRENT"}'
```

The CLI compiles the candidate with the fixed pipeline, runs author checks in a separate browser, stages an immutable worker, and asks the live runtime to activate it atomically with all three guards. A failed build, failed check, incompatible model, or stale guard preserves the current player. Activation restarts scientific state; arbitrary internal-state migration is outside 0.1. The previous checked bundle remains available for the lifetime of the session. Source control remains the durable source revision history.

## Connect through MCP

Use the standard stdio MCP server. A headless session persists across calls for the life of the server:

```json
{
  "mcpServers": {
    "experiment-kit": {
      "command": "node",
      "args": [
        "/absolute/path/to/experiment-kit/packages/cli/bin/experiment-kit.mjs",
        "mcp",
        "/absolute/path/to/my-experiment"
      ]
    }
  }
}
```

To target the learner's actual preview instead, append `--session` and its connection-file path. MCP exposes `describe`, `inspect`, `create_run`, `command`, `sample`, `compare`, `checkpoint`, `capture`, `verify`, and `activate_revision`; attached live sessions additionally expose `sessions`. Inputs and structured outputs have JSON schemas through the pinned MCP TypeScript SDK. The SDK negotiates its supported protocol versions with the host; no MCP Apps extension is required. The CLI writes diagnostics to stderr and reserves stdout for MCP transport while serving.

`sample` never changes the active run. `compare` requires explicit retained run IDs and time samples, and reports parameter differences and terminal domains. `checkpoint` saves or restores. `set_view` commands use `expectedViewVersion`; physical commands use `expectedRunVersion` and `expectedActiveRunId`. `activate_revision` additionally needs `expectedDefinitionRevision` and the source directory.

Large sample, comparison, or check results use MCP JSON resources with a short summary and resource link in the tool response. Each resource is limited to 8 MiB; the server retains at most sixteen resources and 16 MiB total for the current session. Save needed data before the session closes or older resources are evicted. CLI JSON output can be written directly with `--out`.

The same schemas work with any compatible MCP host; provider-specific prompts and API keys are unnecessary. Standard protocol-client integration is automated in the test suite. Compatibility with any specific vendor UI must be verified on that host before claiming it.

## Execution scope

Version 0.1 supports trusted local authors and curated exported bundles. A worker is a responsiveness boundary, not a hostile-code sandbox. The watchdog terminates an unresponsive worker after three seconds in the authoring runner. The last good committed frame remains available when runtime evaluation fails. Browsers do not provide a universal worker memory quota. Public uploads, remote compilation, cloud execution, arbitrary packages, and untrusted-code isolation are intentionally outside this release.

The model import surface and restrictive local response policies reduce accidental capabilities. They do not establish safety for adversarial source. Serve only the exported directory, not a directory containing private files. The general static server also rejects path traversal and symlink escapes.

## Declarative authoring over stdio MCP

Introduced in the 0.2 preview and unchanged in 0.3.0-preview.1 (the document schema 2.0 tools; the Study Harness
activity tools are separate, see `docs/study-harness/agent-tools.md`).

`experiment-kit mcp-document` creates a blank v2 session without a source directory. Its nine `visualization_*` tools are the same schemas and executor as `@experiment-kit/agent`: discover, create, revise, inspect, commit, discard, operate, save and restore. Existing `experiment-kit mcp <directory>` retains the legacy source-project workflow.

```json
{
  "mcpServers": {
    "experiment-kit-document": {
      "command": "node",
      "args": ["/absolute/path/to/experiment-kit/packages/cli/bin/experiment-kit.mjs", "mcp-document"]
    }
  }
}
```

Install the CLI's Playwright Chromium runtime once with `npx playwright install chromium`. The adapter builds only its fixed trusted harness, opens a local browser and sends authored documents as JSON to the browser session. Expressions execute in that session's dedicated worker; they never execute in privileged Node. No source project, candidate code, filesystem tool, compiler permission or provider SDK is exposed to the agent.

Start with `visualization_discover` and `{ "includeExample": true }`, then inspect the empty session for its guard. Create the example document as a candidate and commit its returned ID. Every mutation requires a new operation ID, current session version and active run ID when present. MCP request cancellation propagates into the browser tool executor. Saving returns an artifact for the host to persist; all session state and temporary build files are removed when the stdio connection closes. Results above 96 KiB are returned as JSON resource links, retained up to 16 results and 16 MB in the current MCP server. The host must read and store those resources before disconnecting.

This entry has no mounted visualization surface, so it supports computational inspection but does not provide screenshot capture. Use the browser embedding/host relay or the existing capture workflow for visual evidence. The automated stdio test exercises creation, revision, mutation, save/reopen and invalid-input retention against real Chromium. It is a scripted protocol test, not a real LLM authoring trial.
