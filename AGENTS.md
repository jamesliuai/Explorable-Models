# Experiment Kit agent workflow

This repository is a toolkit, not a tutoring or account platform. Read README.md and docs/authoring.md before changing the public contract.

- Keep models pure and independent of React/DOM. Authored model/check code runs in the browser worker path, never in privileged CLI Node.
- Keep all scene/plot/equation/table values bound to model quantities and a committed frame. Undefined is a status with a reason, not zero.
- Preserve guarded command semantics, exact boundary events, snapshot revision checks, and the last working candidate.
- Parameter commits restart a run; presentation changes use view state. Preview gestures remain tentative until committed.
- Put independent acceptance fixtures in tests/reference/fixtures, outside candidate examples. Report author/reference provenance honestly.
- Run npm run typecheck and relevant tests. For rendered changes, run npm run test:browser and inspect default/boundary/mobile screenshots.
- Regenerate revisions and the production bundle with npm run build after source, runtime, or lockfile changes.
- Do not claim scientific review, accessibility certification, learning efficacy, or a comparative authoring advantage from automated checks alone.
