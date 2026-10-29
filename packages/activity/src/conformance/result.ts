/**
 * Result record of one run of the HostPort conformance kit: `study-harness.host-conformance-result/1`, the form of
 * `docs/study-harness/templates/host-conformance-result.schema.json` (external gate G2, requirement A54). The JSON Schema
 * below is that template (a test keeps the two identical). Pure data and checks: no Node, DOM or native imports.
 */
import { jsonDataErrors, schemaErrors, type JsonSchema } from '@experiment-kit/core/model';

export const HOST_CONFORMANCE_RESULT_SCHEMA = 'study-harness.host-conformance-result/1' as const;

/** The G2 sequence, in order (docs/study-harness/external-gates.md). */
export const HOST_CONFORMANCE_STEPS = Object.freeze([
  'open-quadratic', 'prediction-reference', 'authorize-reveal', 'commit-exploration', 'camera-change', 'save', 'terminate', 'reopen-verify',
  'independent-task', 'crash-before-intent', 'crash-after-intent', 'crash-after-display',
] as const);
export type HostConformanceStepId = typeof HOST_CONFORMANCE_STEPS[number];

/** What each step covers (the template's step descriptions). */
export const HOST_CONFORMANCE_STEP_DESCRIPTIONS: Readonly<Record<HostConformanceStepId, string>> = Object.freeze({
  'open-quadratic': 'Open the quadratic activity from the approved catalogue through the host',
  'prediction-reference': 'Record the learner prediction as a host response reference',
  'authorize-reveal': 'Authorize and reveal the next stage; intent and display acknowledgement are persisted before the content shows',
  'commit-exploration': 'Commit an exploration parameter change (new run at index zero)',
  'camera-change': 'Change the presentation (camera or layout) without a scientific change',
  save: 'Save the activity artifact through the host store',
  terminate: 'Terminate the application process',
  'reopen-verify': 'Reopen and verify scientific state, permitted presentation, event order and conservative exposure',
  'independent-task': 'Start an independent task: the teaching visual is absent and late reveals are discarded',
  'crash-before-intent': 'Terminate before the exposure intent is persisted; reopen shows the content unseen',
  'crash-after-intent': 'Terminate after the intent is acknowledged, before display; reopen records it as authorized, not displayed',
  'crash-after-display': 'Terminate after display, before the display acknowledgement is persisted; reopen records it as uncertain (conservatively exposed)',
});

/**
 * `actual-host`: the Study Harness application with its own core, persistence, policy and agent connection. Fixture
 * results (`reference-fixture-host`, `memory-fixture-host`) never satisfy A54. The label always comes from the caller.
 */
export type HostConformanceSubject = 'actual-host' | 'reference-fixture-host' | 'memory-fixture-host';
export const HOST_CONFORMANCE_SUBJECTS: readonly HostConformanceSubject[] = Object.freeze(['actual-host', 'reference-fixture-host', 'memory-fixture-host']);
export type HostConformanceOutcome = 'pass' | 'fail' | 'not-run (environment)' | 'not-run';
const OUTCOMES: HostConformanceOutcome[] = ['pass', 'fail', 'not-run (environment)', 'not-run'];

export interface HostConformanceAssertion { id: string; outcome: HostConformanceOutcome; detail?: string }
export interface HostConformanceStep {
  outcome: HostConformanceOutcome;
  assertions?: HostConformanceAssertion[];
  environmentReason?: string;
  /** Why a step did not run or failed (fixed text; never learner data). */
  reason?: string;
  evidence?: string;
}
export interface HostConformanceIdentity {
  name: string;
  commit: string;
  dirty: boolean;
  binarySha256: string;
  signed?: boolean;
  platform: { os: 'macOS' | 'Windows' | 'Linux'; osVersion: string; arch: 'arm64' | 'x64'; webview?: string };
}
export interface HostConformancePackage { name: string; version: string; sha256: string }
export interface HostConformanceResult {
  schema: typeof HOST_CONFORMANCE_RESULT_SCHEMA;
  subject: HostConformanceSubject;
  runAt: string;
  host: HostConformanceIdentity;
  packages: HostConformancePackage[];
  /** The kit that produced the record (absent when a host's own harness filled the template). */
  kit?: { name: string; version: string };
  steps: Record<HostConformanceStepId, HostConformanceStep>;
  result: 'pass' | 'fail' | 'incomplete';
  limitations?: string[];
}

// ---------------------------------------------------------------------------------------------------------------
// JSON Schema of the record (identical to docs/study-harness/templates/host-conformance-result.schema.json)
// ---------------------------------------------------------------------------------------------------------------
const NAME_PATTERN = '^[A-Za-z0-9][A-Za-z0-9_.:@/+-]{0,127}$';
const outcomeSchema = (): JsonSchema => ({ enum: [...OUTCOMES] });
const stepSchema = (description: string): JsonSchema => ({
  description,
  type: 'object',
  additionalProperties: false,
  required: ['outcome'],
  properties: {
    outcome: outcomeSchema(),
    assertions: {
      type: 'array',
      maxItems: 64,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'outcome'],
        properties: {
          id: { type: 'string', pattern: NAME_PATTERN },
          outcome: outcomeSchema(),
          detail: { type: 'string', maxLength: 300, description: 'Why the assertion failed or did not run (fixed text with codes and counts; no learner data).' },
        },
      },
    },
    environmentReason: { type: 'string', maxLength: 300 },
    reason: { type: 'string', maxLength: 300, description: 'Why the step did not run or failed (for example a missing host hook or an earlier failed step).' },
    evidence: { type: 'string', maxLength: 300, description: 'Path or reference to the host-side log or capture (no learner data).' },
  },
});

export const HOST_CONFORMANCE_RESULT_JSON_SCHEMA: JsonSchema = Object.freeze({
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://experiment-kit.dev/schema/study-harness/host-conformance-result-1.json',
  title: 'Study Harness host conformance result (external gate G2, A54)',
  description: 'One run of the G2 conformance sequence against a host. subject labels whether the run used the actual Study Harness application or a fixture host (the packaged reference host or an in-memory host); fixture results never satisfy A54. Every step of the sequence is listed, with not-run and not-run (environment) kept distinct from pass. Do not put learner data, study content or credentials in this record.',
  type: 'object',
  additionalProperties: false,
  required: ['schema', 'subject', 'runAt', 'host', 'packages', 'steps', 'result'],
  properties: {
    schema: { const: HOST_CONFORMANCE_RESULT_SCHEMA },
    subject: { enum: [...HOST_CONFORMANCE_SUBJECTS] },
    runAt: { type: 'string', pattern: '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}([.][0-9]{1,9})?(Z|[+-][0-9]{2}:[0-9]{2})$' },
    host: {
      type: 'object',
      additionalProperties: false,
      required: ['name', 'commit', 'dirty', 'binarySha256', 'platform'],
      properties: {
        name: { type: 'string', pattern: NAME_PATTERN },
        commit: { type: 'string', pattern: '^[0-9a-f]{7,64}$' },
        dirty: { type: 'boolean' },
        binarySha256: { type: 'string', pattern: '^[0-9a-f]{64}$' },
        signed: { type: 'boolean' },
        platform: {
          type: 'object',
          additionalProperties: false,
          required: ['os', 'osVersion', 'arch'],
          properties: {
            os: { enum: ['macOS', 'Windows', 'Linux'] },
            osVersion: { type: 'string', pattern: '^[0-9A-Za-z][0-9A-Za-z._ ()-]{0,63}$' },
            arch: { enum: ['arm64', 'x64'] },
            webview: { type: 'string', maxLength: 128 },
          },
        },
      },
    },
    packages: {
      type: 'array',
      minItems: 1,
      maxItems: 16,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['name', 'version', 'sha256'],
        properties: {
          name: { type: 'string', pattern: '^@experiment-kit/[a-z0-9-]{1,32}$' },
          version: { type: 'string', pattern: '^[0-9]{1,4}[.][0-9]{1,4}[.][0-9]{1,6}(-[0-9A-Za-z.-]{1,32})?$' },
          sha256: { type: 'string', pattern: '^[0-9a-f]{64}$' },
        },
      },
    },
    kit: {
      type: 'object',
      additionalProperties: false,
      required: ['name', 'version'],
      description: 'The conformance kit that produced this record (for example @experiment-kit/activity/conformance); absent when the host ran the sequence with its own harness.',
      properties: {
        name: { type: 'string', pattern: '^@?[A-Za-z0-9][A-Za-z0-9_.:@/+-]{0,127}$' },
        version: { type: 'string', pattern: '^[0-9]{1,4}[.][0-9]{1,4}[.][0-9]{1,6}(-[0-9A-Za-z.-]{1,32})?$' },
      },
    },
    steps: {
      type: 'object',
      additionalProperties: false,
      required: [...HOST_CONFORMANCE_STEPS],
      properties: Object.fromEntries(HOST_CONFORMANCE_STEPS.map(step => [step, stepSchema(HOST_CONFORMANCE_STEP_DESCRIPTIONS[step])])),
    },
    result: { enum: ['pass', 'fail', 'incomplete'], description: 'pass only when every step and assertion passed; incomplete when any step was not run.' },
    limitations: { type: 'array', maxItems: 32, items: { type: 'string', maxLength: 300 } },
  },
} satisfies JsonSchema);

/** Schema problems of a result record (empty when it conforms to the template), as `path: message` lines. */
export function hostConformanceResultProblems(value: unknown): string[] {
  const data = jsonDataErrors(value, { maxBytes: 1_000_000, maxDepth: 16, maxNodes: 20_000 });
  const problems = data.length ? data : schemaErrors(value, HOST_CONFORMANCE_RESULT_JSON_SCHEMA);
  return problems.map(item => `${item.path}: ${item.message}`);
}

/**
 * The step outcome implied by its assertions: `fail` when any failed; otherwise `not-run (environment)` or `not-run` when
 * any did not run; `pass` only when every assertion passed (and there is at least one).
 */
export function stepOutcome(assertions: readonly HostConformanceAssertion[]): HostConformanceOutcome {
  if (!assertions.length) return 'not-run';
  if (assertions.some(item => item.outcome === 'fail')) return 'fail';
  if (assertions.some(item => item.outcome === 'not-run (environment)')) return 'not-run (environment)';
  if (assertions.some(item => item.outcome === 'not-run')) return 'not-run';
  return 'pass';
}

/** The record's `result`: `pass` only when every step passed; `fail` when any failed; otherwise `incomplete`. */
export function overallResult(steps: Readonly<Record<HostConformanceStepId, HostConformanceStep>>): HostConformanceResult['result'] {
  const outcomes = HOST_CONFORMANCE_STEPS.map(step => steps[step].outcome);
  if (outcomes.some(outcome => outcome === 'fail')) return 'fail';
  return outcomes.every(outcome => outcome === 'pass') ? 'pass' : 'incomplete';
}
