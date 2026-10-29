/**
 * `@explorable-models/activity/conformance`: the host-agnostic HostPort conformance kit (external gate G2, A54
 * preparation). A separate entry from the adapter: hosts and their test harnesses import it; the learner surface and
 * the adapter never do. Pure TypeScript with no Node, DOM or native imports, so the same kit runs in Node, a browser and
 * a packaged WebView against any `HostPort`.
 *
 * `runHostPortConformance(host, options)` runs the G2 sequence through the real adapter and returns a result record in
 * the form of `docs/study-harness/templates/host-conformance-result.schema.json`, labelled by the caller
 * (`actual-host`, `reference-fixture-host`, `memory-fixture-host`). Fixture results never satisfy A54.
 */
export {
  HOST_CONFORMANCE_DEFAULT_TEMPLATE, HOST_CONFORMANCE_KIT, runHostPortConformance,
  type HostConformanceCheck, type HostConformanceHooks, type HostConformanceOptions, type HostConformanceRun, type HostCrashPoint,
} from './kit.js';
export {
  HOST_CONFORMANCE_RESULT_JSON_SCHEMA, HOST_CONFORMANCE_RESULT_SCHEMA, HOST_CONFORMANCE_STEP_DESCRIPTIONS, HOST_CONFORMANCE_STEPS, HOST_CONFORMANCE_SUBJECTS,
  hostConformanceResultProblems, overallResult, stepOutcome,
  type HostConformanceAssertion, type HostConformanceIdentity, type HostConformanceOutcome, type HostConformancePackage, type HostConformanceResult,
  type HostConformanceStep, type HostConformanceStepId, type HostConformanceSubject,
} from './result.js';
