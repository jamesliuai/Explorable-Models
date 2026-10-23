# Agent-first local preview: release evidence

Candidate: **0.2.0-preview.1**, schema **2.0**. Working date: **October 22, 2026 (America/Los_Angeles)**. The owner authorized a **source-repository developer preview** at `jamesliuai/Explorable-Models`. npm publishing, hosting, and external pilots remain deferred. This record does not mark the original supported-release plan complete.

## What ships

Three separately packed libraries (`core`, `player`, `agent`), a static composition studio, eight editable public documents, a versioned worker/session/authoring contract, React and plain-DOM consumers, scoped HTTP relay and stdio MCP examples, generated schemas, and integration/operations documentation. The legacy gallery, immutable v1 artifacts and trusted-local authoring CLI remain available.

The new authoring path supports bounded analytical/parametric expressions, explicit undefined values, quantities and immutable numeric datasets; typed 2D geometry, line/scatter/bar/region plots, values, safe plain-text equation substitutions and tables; exact parameter input, tentative drag/slider previews, selection, pan/zoom, analytical playback, semantic edits and portable artifacts. Scientific/model revisions restart runs; presentation changes preserve run/time.

**Preview limits:** no general installed model/renderer extension registry, general 3D authoring, numerical solvers, stochastic adapters, arbitrary JavaScript, unit conversion engine, automatic layout/collision guarantee or symbolic continuity proof. Capture supports mounted frozen SVG scenes; PNG/full-page capture needs a host adapter or legacy CLI. Pan/zoom is local surface state: saved artifacts retain authored bounds and selection, while transient per-surface camera changes reset on remount. General restoration of all host presentation state is not claimed.

## Evidence locations

| Evidence | Record |
| --- | --- |
| Exact tarballs, SHA256/integrity, clean install and SSR imports | `release/preview/package-evidence.json` |
| Static site and all preview deliverable hashes | `release/preview/preview-manifest.json` |
| Cross-browser engines, test result and package identity | `release/preview/cross-browser-evidence.json` |
| Final command results and exact candidate identity | `release/preview/verification.json` |
| Five legacy numerical reports; eight v2 fresh-session restores with external network blocked | `dist/release-checks.json` |
| Independent-from-candidate numerical fixture values | `tests/reference/fixtures/declarative.json` and existing fixtures |
| Automated boundary review regressions | `tests/core/session-review.test.ts`, `tests/agent/review.test.ts` |
| Browser representation, keyboard and exact-frame checks | `tests/browser/composition.spec.ts`, `embedding-renderer.spec.ts`, `player.spec.ts` |
| Scoped HTTP demo | `examples/host-relay/`; 15 correlated scripted calls, save/reopen, two retained comparisons |
| Actual stdio-to-browser authoring | `tests/cli/document-mcp.test.ts`; `experiment-kit mcp-document` |
| Optional provider integration | `examples/host-relay/openai-agent.mjs`; mock transport tests only, no credentialed API run |

Reference fixtures are separate from candidate examples, but were produced during engineering work by agents; no independent human review is asserted. Separate-agent code review found and fixed concrete defects, but remains automated review. Screenshots and local logs are in `/tmp/experiment-kit-preview/` and `/tmp/experiment-kit-*`, outside distributions.

The baseline before changes passed typechecking, 123 tests and 12 Chromium browser tests. A sandboxed first attempt failed to bind loopback; rerunning with authorized loopback access passed. Final expanded counts and timestamps are in `verification.json`, so stale baseline counts are not presented as candidate evidence.

## Milestone accounting

| Milestone | Local outcome | Remaining supported-release evidence |
| --- | --- | --- |
| M0 contract/baseline | Versioned contract, source-preserving legacy path, budgets and baseline recorded | Public namespace ownership and final supported scope approval |
| M1 embedding | Packed React/DOM consumers, independent workers/instances, SSR import, controls, disposal, CSP and worker factory verified | Unfamiliar developer integrations and additional host/bundler claims |
| M2 agent workflow | Same authoring service through direct tools, scoped HTTP relay and real stdio MCP; create/add curve/annotation/revise/save/reopen | Credentialed real host-agent trial and image-capable integration |
| M3 composition/state | Geometry/data/linked selection/semantic edits/identities/retention/cancellation/retries implemented and tested | General host-installed extensions; full host presentation-state portability |
| M4 usability/presets | Eight editable compositions; desktop/boundary/mobile viewport checks, exact input, keyboard, readable errors, SVG export | Manual screen-reader and intended-user sessions, actual mobile hardware |
| M5 external validation | Trial protocol, misuse tests, separate-agent review, measured desktop workloads and lifecycle stress | All outside developers, users, blind attempts, pilots and independent human boundary review |
| M6 distribution | Tarballs, clean consumer builds, source/CLI packaging, schemas/docs/license inventory, local CI-equivalent checks | Hosted CI run, real maintainer/security endpoint, final compatibility acceptance |
| M7 release | Local artifacts and rollback/publication procedure prepared | Owner-controlled publication, public-install/deployment smoke tests, operational rollback exercise |

## Technical results and limits

Packed consumer tests use pinned dependencies installed in a fresh temporary directory from tarballs, without repository aliases. Both the package-relative worker and an explicit host worker factory are tested. The imperative mount isolates styles with Shadow DOM. The React entry uses shared peer dependencies. The default 2D consumer graph excludes Three.js, CLI tooling and provider SDKs.

The initial desktop runs measured p95 commit-to-visible response around 34 ms for a wave, 1,001 samples, 100 semantic marks and a 5,000-row dataset; each measurement includes two animation frames and 30 measured commits after five warmups. Exact final measurements and device/browser information are in package evidence. Twenty-five mount/edit/dispose cycles leave zero mounted surfaces. Collected heap readings are not a memory-stabilization or leak-proof claim. The combined external-consumer JavaScript/worker gzip budget is 180,000 bytes and is enforced by the verifier. Real mobile measurements remain open.

Chromium, Firefox and WebKit are exercised by the declared automated suites. WebKit automation is not a real Safari-user validation. Tested React is the lockfile version; the declared broader peer range is not independently tested across every version. React SSR *imports* are tested; constructing workers/mounting during SSR is not supported. The tested CSP allows self-hosted scripts/workers and scoped inline styles; nonce-only styles and arbitrary bundlers need host integration work.

`npm audit --json` reported zero known vulnerabilities for the pinned lock during this work. This advisory snapshot does not replace boundary review. No scientific review, accessibility certification, learning efficacy or comparative authoring advantage is claimed.

## Original 20-item release checklist

“Verified locally” applies to this bounded preview only. Partial/open items prevent promoting it to the original supported release.

| # | Gate | Status and evidence |
| --- | --- | --- |
| 1 | Scope, package names, schema/runtime and support frozen | Preview contract frozen; public package ownership pending |
| 2 | Packed React/DOM, independent instances | Verified locally in package evidence |
| 3 | Real host agent creates/revises without filesystem/compiler | Scripted relay and real MCP client verified; actual LLM configuration trial open |
| 4 | Discovery matches behavior | Schema/limits/unsupported handling and no-op rejection tested |
| 5 | Numerical/frame/representation and exact boundaries | Verified local reference/browser suites; human subject review unperformed |
| 6 | Failure/cancellation/retries/concurrency preserve accepted state | Regression suite verified, including delayed authorization and disposal |
| 7 | Presentation preserves scientific state; inputs restart | Verified, including dataset metadata and semantic selection refresh |
| 8 | Concise authoring; editable public presets | Eight plain documents, generated schemas and targeted-edit examples |
| 9 | Artifacts/capture pin revisions and retained dependencies | JSON/SVG paths verified; broader capture and transient camera persistence outside preview |
| 10 | Legacy preservation/rejection | Original v1 flow retained; v2 explicitly rejects incompatible artifacts |
| 11 | Automated/cross-browser/default/boundary/mobile checks | Verified local suites and visual review; final commands in verification record |
| 12 | Keyboard and manual assistive technology | Keyboard/axe verified; manual AT/user evidence open |
| 13 | Boundary misuse tests and independent review | Automated misuse/separate-agent review verified; independent human review open |
| 14 | Performance/dependency budgets on declared devices | Desktop workloads/budget verified; real mobile and memory stabilization open |
| 15 | External integration/blind authoring/pilot gates | Open; owner arranges trials using external-trial-kit.md |
| 16 | Quickstarts exercised cleanly | Packed DOM/React and direct/MCP/relay examples verified; provider example mocked only |
| 17 | Inventories/licenses/dependencies/hashes/metadata | Local inventory and hashes verified; public ownership/contact metadata pending |
| 18 | Reproducible CI; no credentials/local artifacts | Read-only CI verifies each pushed revision and retains artifacts with source-commit metadata; inspect the intended commit's Actions result |
| 19 | Honest release notes | CHANGELOG.md and this preview record describe actual scope and review status |
| 20 | Contacts/reporting/patch/rollback | Procedures/templates prepared; live contacts and public rollback exercise pending |

## Public preview preparation

The owner selected **Explorable Models**, repository **https://github.com/jamesliuai/Explorable-Models.git**, and deferred hosting. Public branding and repository/issue/homepage metadata are configured locally. The technical package/CLI names and historical fixture/license attribution remain unchanged for compatibility and provenance.

The studio now opens at the site root, with `/agent.html` retained as an alias, `/gallery.html` for the legacy gallery, and `/guide.html` for a readable preview guide. Existing query-based experiment/embed/capture links and v1 startup snapshots retain their legacy entry behavior. All reusable libraries and the separate CLI package use the `preview` publish tag. The CI workflow runs the full local packaging/check pipeline and retains artifacts, with read-only repository access and no deployment/publication job.

`npm run release:preview` also runs release-integrity regressions and verifies the actual site ZIP at a nested path, including hashes, default/legacy routes, exact controls, scientific-state preservation, mobile/boundary views, and browser errors. Exact refreshed counts and package hashes are generated into `verification.json`; packaged-site smoke evidence/screenshots are under `/tmp/experiment-kit-public-preview/`. The previous verified candidate is retained separately under `release/archive/`.

The owner authorized the initial source commit and push. The final source inventory includes release-integrity tests and excludes generated output, dependencies, local credentials, and session bridges. CI results and downloadable preview evidence are tied to the exact pushed commit. Public maintainer/security contact details and npm ownership remain open for later package/website publication; `npm run preflight:public` reports those decisions without blocking source commits. No npm publication, website deployment, release tag, public package smoke check, or external human/agent trial is claimed. The [handoff](public-preview-handoff.md) records the remaining work.

## Next handoff

The repository has been supplied. The owner supplies working maintainer/security contacts and, for npm publication, namespace confirmation. Hosting is deferred; outside participants remain needed for supported-release validation. Follow `external-trial-kit.md`, `public-preview-handoff.md`, and `preview-operations.md`, retain failed attempts, fix recurring blockers, and rerun against a new exact candidate. Do not publish this preview under a supported/default release claim by simply checking off the remaining items.
