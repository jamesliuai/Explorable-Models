# Independent acceptance fixtures

These fixture copies are the repository acceptance oracle. They intentionally live outside `examples/` so an author changing candidate model code or `checks.ts` does not automatically change the expected answers used by the reference test suite. The portable example contains a transparent copy for browser checking, but the acceptance harness imports this directory.

The initial rolling and base-rate values and canonical linear cases come from the supplied project specification. Additional nonaxis matrix, boundary, fractional-count, and oscillator cases are explicit derived calculations. Riemann expected values use finite-sum formulas, while the model accumulates sample rectangles. These fixtures have automated consistency checks, but **no independent human subject reviewer has approved them**.

When evaluating an external authoring agent, mount or copy this directory read-only outside that agent's writable candidate workspace. A normal checkout is not a filesystem security boundary. Changes to these files need a separate review with derivation and reason; do not adjust them merely to make a changed model pass.

`models.test.ts` additionally checks conservation, phase, signed orientation, table totals, and mutations that must fail. It executes only trusted repository reference models. Arbitrary authored models and checks use the browser-worker verification path supplied by the CLI.
