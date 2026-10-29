# Contributing

Run `npm ci`, `npx playwright install chromium`, and `npm run check`. Browser changes also require `npm run test:browser` and visual inspection at desktop and 390px width.

`npm test` includes the TypeScript/Rust contract agreement test, so install a Rust toolchain first (tested with 1.95).
A missing `cargo` fails that test; it is never a pass.

Study Harness changes have extra rules:

- **Contracts.** Edit contracts only in `packages/activity/src/schemas.ts`. Regenerate them with
  `npm run generate:contracts`, then run `npm run test:contracts`. The `study-harness.*` 1.0 schemas are frozen by a
  digest lock: add a new version with a reader (and, for artifacts, a registered migration with fixtures) instead of
  changing 1.0.
- **Reference fixtures.** Keep activity fixtures in `tests/reference/fixtures/activities/`, with oracles in
  `tests/reference/oracles/` that never import catalogue code. Declare provenance and tolerances per case.
- **Content changes.** A change to a template, model, kernel or learner surface needs regenerated review packets
  ([review packets](docs/study-harness/review-packets/README.md)). It also invalidates any review bound to the old
  digests.
- **Ledger.** Record progress in `docs/study-harness/requirement-ledger.json` and regenerate the Markdown with
  `npm run ledger`. An external gate stays open until its external evidence exists. Keep the three completion claims
  (engineering complete, approved for Study Harness use, learning benefit evaluated) separate.
- **Packaged host.** For changes to the reference host or its CSP, run
  `node scripts/study-harness/native-conformance.mjs --install` on macOS with the console unlocked and the display
  awake. Report checks a hidden window cannot run as not run (environment).
- **Release verification.** Before handing over a release candidate, run `npm run release:study-harness`. It packs
  once, runs every gate against those tarballs and writes `release/study-harness/verification.json`. A run with
  `--only` or `--skip` is a development run and is never release evidence. Evidence files keep append-only history in
  `docs/study-harness/evidence/history/`; do not delete failed attempts from it.

A new example needs one clear question, defaults, model card, exact parameter domains, quantity metadata, accessible controls, independent reference cases, boundary cases, and screenshot review. New models must run through the browser worker pathway. Do not execute authored model or check code in privileged CLI Node.

Keep mathematical changes separate from presentation transforms. Use the bounded version 2 composition grammar for agent-authored documents. Add shared primitives when concrete scenarios need them; presets must remain ordinary editable public documents. Keep arbitrary scripting, numerical solvers, and general 3D behind separately reviewed extension contracts. Document source revisions, migrations, and compatibility changes. Preserve the last working candidate and reject stale commands.

Add tests for the failure a change addresses. Maintain separate claims for build/schema, runtime, quantitative, representation, model review, and learner evidence. Do not describe generated content as independently reviewed.

This project uses MIT licensing for original code and examples. Do not copy restricted lesson text, graphics, or incompatible upstream code. Preserve dependency licenses and notices.
