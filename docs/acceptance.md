# Release acceptance and evidence

> **Study Harness acceptance (A01–A60) is tracked elsewhere.** The criteria of the
> [Study Harness implementation report](study-harness-visualizer-implementation-report.md) are recorded in the
> [requirement ledger](study-harness/requirement-ledger.md) ([JSON](study-harness/requirement-ledger.json)). Each entry
> lists its status, implementation, tests and external dependencies. External-gate protocols are in
> [external gates](study-harness/external-gates.md), and current evidence is indexed in the
> [handoff](study-harness/README.md).
>
> This page is the earlier 0.1 acceptance record. Its IDs A01–A14 belong to the earlier specification and are **not**
> the same criteria as the ledger's A01–A14.

This record maps the supplied specification's A01–A14 conditions to implementation and reproducible checks. Explorable Models 0.1 is a usable software release for trusted local authors and ordinary browser playback. Software checks do not establish independent scientific review, WCAG certification, comparative authoring advantage, or learning efficacy.

The tests below are the evidence sources, not self-updating status badges. Run them against the exact source revision being released. The supplied example manifests deliberately remain **unreviewed**; reference assertions and model cards are available, but no independent human subject reviewer has signed them.

## Reproduce the software checks

From the repository root, with Node.js 22.12 or later:

```sh
npm ci
npx playwright install chromium
npm run typecheck
npm test
npm run build
npm run test:browser
npm run build --workspace @experiment-kit/core
npm pack --workspace @experiment-kit/core --dry-run
```

Core and reference tests ran during implementation with 109 passing cases after the active-revision domain and fixed coordinate-bounds regressions were added. The broader browser, CLI, export, and protocol tests are separate suites: use their current command output and generated artifacts for the release result. Test counts can change as regressions are added; a historical count is not a guarantee that another revision passes.

| Evidence layer | Reproducible source | Scope |
| --- | --- | --- |
| Contract/runtime | [`tests/core/runtime.test.ts`](../tests/core/runtime.test.ts) | Finite-value validation, exact boundaries, guarded mutations, previews, frozen command inputs, snapshots, candidate activation, worker errors/watchdog, and active-revision domain inspection |
| Independent reference harness | [`tests/reference/models.test.ts`](../tests/reference/models.test.ts), [`tests/reference/fixtures`](../tests/reference/fixtures) | Fixed numerical cases, limiting cases, invariants, nonaxis transformations, and injected mathematical mistakes |
| Build/transport boundary | [`tests/cli/tooling.test.ts`](../tests/cli/tooling.test.ts) | Fixed compilation, import restrictions, excluded local files, token/origin checks, and symlink containment |
| Browser worker execution | [`tests/cli/browser-runner.test.ts`](../tests/cli/browser-runner.test.ts) | Actual compiled worker evaluation, fresh-process restoration, isolated sampling, and termination of an infinite candidate |
| Agent protocol | [`tests/cli/mcp.test.ts`](../tests/cli/mcp.test.ts) | Official MCP client negotiation, tool schemas, runtime operations, and structured errors |
| Author workflow | [`tests/cli/workflow.test.ts`](../tests/cli/workflow.test.ts) | Static export, network-blocked playback, frozen capture, live coordinator, safe source activation, and a fresh external stdio client |
| Learner interaction | [`tests/browser/player.spec.ts`](../tests/browser/player.spec.ts) | Exact inputs, playback, semantic bindings, selection, snapshots, drag/keyboard controls, undefined probability, responsive widths, and automated accessibility checks |

The independent fixture directory is separate from candidate example directories. Its values are supplied specification references and transparent calculations, not a claim that a human independently reviewed all new tests. See [`tests/reference/README.md`](../tests/reference/README.md) for provenance.

## Acceptance matrix

| ID | Implementation and evidence | Scope or remaining evidence |
| --- | --- | --- |
| **A01** — Three reference experiments pass cases and publish assumptions/limits | Rolling, linear-map, and base-rate `model.md`/`experiment.json` files; reference harness; browser-worker verification across all five examples | Numerical checks and model cards are implemented. Independent subject review is **not performed**; manifests remain unreviewed. |
| **A02** — Representations and inspection agree at one committed frame | Core frame identity; semantic `data-frame-id`/`data-value` bindings; browser `assertBoundValues`; exact matrix/rolling/probability fixtures | Assertions inspect numerical binding data, not every pixel. Rendered orientation, arrow projection, trace freshness, and readiness also require the representation regressions and visual inspection described below. |
| **A03** — A fresh external agent creates two unseen topics without core changes | Riemann sums and analytical oscillator use the same contract; reference tests verify sums, signed area, phase, and energy; generic renderer supports additional source models | Structural extension is demonstrated. These examples were created by the implementation team. A blinded fresh-agent held-out authoring trial is **not performed** and is not claimed. |
| **A04** — Targeted revisions preserve behavior and fail safely | Core candidate activation tests; CLI workflow changes definition metadata, checks it, activates with guards, then rejects invalid TypeScript while preserving the live frame; a fresh live connection still inspects, controls, and captures the retained revisions while source is invalid | Technical preservation and failure behavior are tested. The full prescribed sequence of force-layer, label, accessible-control, and old-revision edits remains a useful additional authoring benchmark. |
| **A05** — Stale agent actions cannot overwrite learner actions | Core concurrent command tests check run version and active run ID; browser test changes inclination before a stale command; live workflow changes a matrix before a stale command | Conflicts are explicit and preserve the accepted state. View changes use a separate view version. |
| **A06** — Sampling/capture do not disturb active runs | Core isolated sample/comparison tests; browser sample test; CLI separate capture player; live explicit-snapshot capture regression | Capture uses a separate frozen instance. The readiness barrier must include the restored frame and all asynchronous visible views; a screenshot alone is not proof of correct pinning. |
| **A07** — Portable artifacts and snapshots reopen offline over HTTP | CLI export workflow serves the artifact with all external network blocked, exercises controls, and checks source availability; fresh browser process restores exact values | HTTP is the supported path. Direct file URLs are deliberately unsupported. A hosted gallery must retain referenced revision bundles. |
| **A08** — Incompatible snapshots fail explicitly | Core schema/revision/event/tick checks; browser wrong-revision test; snapshot restoration creates a new run with provenance | No silent migration. User source JSON is not modified by a rejection. |
| **A09** — Keyboard, exact input, nondragging alternatives, and nonvisual meaning | Exact numeric inputs, native controls/dialogs, accessible quantities, keyboard point movement, camera buttons, SVG descriptions; browser interaction and axe checks | Automated checks and keyboard workflows cover engineering behavior. Screen-reader/user sessions and a complete manual WCAG audit are **not performed**. |
| **A10** — Default/boundary/narrow visual cases are acceptable | Browser checks at 390, 1024, and 1440 px; rolling terminal-state checks; screenshot/capture workflows; [`docs/design.md`](design.md) | Visual inspection is separate from a passing build or axe run. Keep the final screenshot/viewport evidence with the release; no universal cross-browser pixel identity is promised. |
| **A11** — Important injected failures are detected | Reference tests inject angle conversion, reversed friction, transposed matrix, wrong Bayes denominator, and oscillator phase errors; runtime tests reject wrong revisions, stale actions, malformed worker data, and infinite execution | The injected formula tests prove sensitivity of the numerical harness. They do not by themselves prove every displayed path uses the correct transform. Browser binding/projection tests address that separate layer. |
| **A12** — Benchmark records attempts, repairs, costs, and scope honestly | Reproducible implementation scenarios and an explicit unperformed M0 record below | The 12-sequence comparative screen, human repair minutes, token costs, and comparative success rates are **not collected**. No superiority claim is made. |
| **A13** — No credentials, chats, or unrelated files in export | Source allowlist and resolved local imports; tooling tests exclude `.env`, candidate scripts, and unrelated files; bundle hash inventory | Authors can deliberately write sensitive text into their model source. The toolkit does not classify all source content for confidentiality; it transfers only the declared experiment source. |
| **A14** — Fixed build config, no candidate package scripts | Compiler uses fixed esbuild and Vite options, rejects unsupported imports, never imports candidate code into Node; tests include throwing candidate Vite config and a failing package script | Trusted local authoring is the supported boundary. This is not public hostile-upload isolation. |

## Release representation checklist

Run numerical assertions before checking the pictures. Preserve capture sidecars with frame/view identity when recording evidence.

- **Rolling:** release, one second, exact arrival, zero incline, 45° incline, smallest/largest radius, all four mass distributions. Check signed rotation against displacement, body contact with the ramp, force direction and disclosed scale, terminal velocity, current trace identity, and each comparison's separate boundary.
- **Linear map:** identity, nonsymmetric map at a nonaxis point, reflection, singular map, and 90° rotation. Check column-vector placement, transformed corners, signed determinant versus nonnegative area, exact point entry, dragging, and keyboard movement.
- **Base rates:** defaults, prevalence zero/one, sensitivity zero, false positives zero, zero flagged denominator, and fractional expected counts. Check that the condition is the flagged group and that frequency labels and all table totals match inspection.
- **State and capture:** restore across experiment navigation; restore a different camera without changing physical parameters; activate a changed analytical time domain; capture a pinned nondefault frame while the source player remains unchanged; reject a stale bundle download after source activation.
- **Accessibility and layout:** repeat primary tasks at 390, 1024, and 1440 px, using keyboard and exact numeric entry. Inspect focus, meaningful labels, reduced-motion behavior, readable equations, and overflow. Automated axe results supplement this checklist.

## Reproducible implementation scenarios

The following exercise the delivered software and can be rerun by another author. They are not substitutes for the comparative M0 experiment.

```sh
# Build and inspect source without importing the candidate into Node.
node packages/cli/bin/experiment-kit.mjs init /tmp/kit-linear --template linear-map
node packages/cli/bin/experiment-kit.mjs check /tmp/kit-linear
node packages/cli/bin/experiment-kit.mjs verify /tmp/kit-linear --out /tmp/linear-checks.json
node packages/cli/bin/experiment-kit.mjs sample /tmp/kit-linear \
  --args '{"parameters":{"a":1,"b":2,"c":0.5,"d":-1,"x":1.25,"y":-0.875},"times":[0]}'

# Exercise both additional model families using the unchanged core.
node packages/cli/bin/experiment-kit.mjs verify examples/riemann-sums --out /tmp/riemann-checks.json
node packages/cli/bin/experiment-kit.mjs verify examples/oscillator --out /tmp/oscillator-checks.json

# Produce a self-contained player and frozen visual evidence.
node packages/cli/bin/experiment-kit.mjs export /tmp/kit-linear --out /tmp/kit-linear-export --zip
node packages/cli/bin/experiment-kit.mjs capture /tmp/kit-linear --out /tmp/kit-linear.png
node packages/cli/bin/experiment-kit.mjs serve /tmp/kit-linear-export
```

Use a fresh empty destination for each run. Expected nonsymmetric-map output is `[-0.5, 1.5]` and determinant `-2`. At `n=100`, the Riemann right estimate is `0.33835` and midpoint estimate is `0.333325`. The default oscillator has zero position and velocity `-2` at `t=π/4`, within recorded tolerance. The default rolling sphere reaches the four-metre boundary at about `1.511087125792 s`, retaining speed about `5.294201680005 m/s`. These are model fixtures, not real-world experimental measurements.

## Comparative M0 record

**Status: not run.** No ordinary-web baseline or Mojulo extension trial was executed under a matched authoring budget. No human repair minutes, per-attempt token costs, blinded clarity ratings, completion-rate delta, or maintenance comparison were collected. The independent runtime is an implementation choice for this delivery, not the result of a demonstrated competitive advantage.

A reproducible future screening run should use:

| Dimension | Precommitted procedure |
| --- | --- |
| Topics | Rolling bodies and linear transformations |
| Approaches | Ordinary generated web code, a supported existing extension path, and Explorable Models |
| Repetitions | Two fresh attempts per topic/approach: 12 sequences total |
| Inputs | Identical teaching question, initial values, exact inspection query, targeted edit, comparison, restore, and export requests |
| Budget | Declare one agent/model/tool configuration, wall-time limit, and tool/token budget before the first attempt; use the same limits for all approaches |
| Independent evaluation | Keep fixture values outside each candidate's writable directory; disclose any fixture or instruction exposure |
| Measures | Success/failure by stage, numerical correctness, representation agreement, state recovery, human repair minutes, elapsed agent time, tool/token cost, and visual clarity |
| Reporting | Preserve failed and timed-out attempts; show individual results and separate one-time setup from repeated authoring work |
| Decision | Adopt an extension if it meets the contracts with lower maintenance; keep independent implementation claims provisional until measured |

Each attempt should produce this record, with actual observed values rather than estimated numbers:

```json
{
  "attemptId": "topic-approach-repeat",
  "approach": "ordinary-web | existing-extension | experiment-kit",
  "topic": "rolling | linear-map",
  "agentConfiguration": {},
  "budget": {},
  "setupMinutes": null,
  "elapsedMinutes": null,
  "humanRepairMinutes": null,
  "tokenOrToolCost": null,
  "stages": {
    "create": null,
    "exactInput": null,
    "inspect": null,
    "targetedRevision": null,
    "compare": null,
    "restore": null,
    "export": null
  },
  "failures": [],
  "artifacts": [],
  "reviewer": null
}
```

Likewise, testing an official MCP client and a fresh stdio process establishes protocol interoperability, not compatibility with two specific vendor agent UIs. Performance targets such as p95 control response below 100 ms and near-60 fps playback require profiling on a declared device/browser; no measured performance claim is made here.

## Remaining empirical work

The reusable software and automated checks are deliverables. Independent subject review, screen-reader/user sessions, formative learner studies, two external-agent authoring trials, the M0 comparative screen, and reference-device performance profiling are distinct evidence-producing activities. They remain explicit so the release can be used within its documented scope without presenting implementation success as scientific or educational certification.
