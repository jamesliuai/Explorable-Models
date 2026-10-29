// Scenario chains of the packaged reference-host conformance runner (scripts/conformance.mjs) and the evidence keys a
// full run produces (report §17, A23, A51). Side-effect free: the runner imports it to choose what to run, and the
// release pipeline's native gate (scripts/study-harness/release-pipeline.mjs) imports it to require every key of a
// full run, so a scenario added here is required of the release evidence without a second list to keep in step.

/**
 * The scenario chains, in run order (`--only=` takes these names). `performance` measures the report §18 targets that
 * apply to a host inside the packaged app's WKWebView (input feedback, 2D preview frame rate, commit → visible frame,
 * suspension, the 100-cycle lifecycle stress and each spatial activity's orbit input; R22), so every full run carries
 * packaged-host measurements of the exact binaries it built.
 */
export const SCENARIO_CHAINS = Object.freeze(['release', 'offline', 'restart', 'crash', 'restore', 'hostport-kit', 'templates', 'performance']);

/**
 * Process-termination points of the `crash` chain (report §17 "Repeat with process termination before persistence
 * acknowledgement, after acknowledgement but before display, and after display but before display-ack persistence",
 * plus the interrupted save). Each point is its own evidence scenario `crash:<point>`.
 */
export const CRASH_POINTS = Object.freeze(['intent-before-commit', 'intent-after-commit', 'intent-after-reply', 'display-ack-before-commit', 'save-before-commit']);

/** Chains holding display-dependent checks (re-run by `--display-only`). */
export const DISPLAY_SCENARIOS = Object.freeze(['offline', 'restart', 'crash', 'templates', 'performance']);

/** Evidence scenario keys produced by running `chains` (`crash` expands to one key per crash point). */
export function scenarioKeys(chains = SCENARIO_CHAINS) {
  return chains.flatMap((chain) => (chain === 'crash' ? CRASH_POINTS.map((point) => `crash:${point}`) : [chain]));
}

/** Every evidence scenario a full run records; the native release gate requires each of them. */
export const REQUIRED_SCENARIOS = Object.freeze(scenarioKeys(SCENARIO_CHAINS));

/**
 * Parses `--only=a,b`: unknown chain names are refused (a typo must not silently run nothing and exit 0). Returns the
 * selected chains in run order and whether they make a full run.
 */
export function parseOnly(value) {
  const names = String(value ?? SCENARIO_CHAINS.join(',')).split(',').map((name) => name.trim()).filter(Boolean);
  const unknown = names.filter((name) => !SCENARIO_CHAINS.includes(name));
  if (unknown.length) throw new Error(`Unknown scenario chain(s) ${unknown.join(', ')} in --only. Known: ${SCENARIO_CHAINS.join(', ')}.`);
  if (!names.length) throw new Error(`--only selects no scenario chain. Known: ${SCENARIO_CHAINS.join(', ')}.`);
  const chains = SCENARIO_CHAINS.filter((name) => names.includes(name));
  return { chains, full: chains.length === SCENARIO_CHAINS.length };
}
