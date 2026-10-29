/**
 * Opt-in, sanitized recorder for the real configured host-agent trial (report §15.3; external gate G3, A57).
 *
 * The host creates a recorder only for a trial it runs on purpose, with its pinned provider/model configuration and
 * budget, and wraps the activity relay it already uses (`recorder.relay(relay)`), or reports calls from another channel
 * with `recorder.observe(...)`. The record keeps request identifiers, tool names, outcome codes, fixed-vocabulary
 * repairs, G3 step marks, a digest of the configuration and numeric usage against the budget. It never keeps tool
 * inputs, tool results, diagnostic messages or paths, learner or study text, provider keys or any free text: an
 * operationId is kept only as a salted digest (so retries of one operation stay correlated), and a configuration that
 * carries a credential-like setting is refused rather than digested.
 *
 * A record made from a scripted caller or a fixture host must say so (`kind: 'scripted-fixture'`); only a run through
 * the actual Study Harness agent path with real credentials is `real-agent-trial`, and this module cannot tell the
 * difference, so the host is responsible for that label. Nothing here sends the record anywhere.
 */
import { canonicalJSON, sha256 } from '@explorable-models/core';
import { ACTIVITY_TOOL_DESCRIPTORS, type ActivityToolResult } from './activity-tools.js';
import type { ActivityRelay } from './activity-relay.js';
import { RelayError } from './relay.js';

export const AGENT_TRIAL_RECORD_VERSION = 'study-harness.agent-trial-record/1';
/** The G3 sequence (docs/study-harness/external-gates.md); a step is evidenced by the requests marked with it. */
export const G3_STEPS = Object.freeze([
  'discover', 'personalise', 'inspect', 'rejected-request', 'repair', 'host-reveal', 'summarise', 'save', 'reopen', 'stale-operation', 'unsupported-declined',
] as const);
export type G3Step = (typeof G3_STEPS)[number];
/** Repairs are recorded as one of these kinds only (no free text). */
export const TRIAL_REPAIRS = Object.freeze([
  'refresh-guards', 'adjust-value', 'drop-parameter', 'request-stage-change', 'retry-same-operation', 'new-operation', 'decline-with-alternative', 'other',
] as const);
export type TrialRepair = (typeof TRIAL_REPAIRS)[number];
export type TrialKind = 'real-agent-trial' | 'scripted-fixture';
export const TRIAL_LIMITS = Object.freeze({ entries: 1000, codesPerEntry: 8, settings: 32 });

export interface TrialConfiguration {
  /** Provider identifier chosen by the host (e.g. its provider adapter name); never a key or endpoint secret. */
  provider: string;
  /** Pinned model identifier. */
  model: string;
  /** Non-secret generation settings (temperature, max tokens…); keys that look like credentials are refused. */
  settings?: Record<string, string | number | boolean | null>;
}
export interface TrialBudget { maxRequests: number; maxInputTokens?: number; maxOutputTokens?: number; maxCost?: { amount: number; currency: string } }
export interface TrialUsage { inputTokens?: number; outputTokens?: number; cost?: number }
export interface TrialHost { name?: string; commit?: string; binarySha256?: string; platform?: string }
export interface TrialRecorderOptions { trialId: string; kind: TrialKind; configuration: TrialConfiguration; budget: TrialBudget; host?: TrialHost; now?: () => number }

export type TrialOutcome = { ok: true; status: string | null } | { ok: false; codes: string[] } | { relayError: string };
export interface TrialRecordEntry {
  sequence: number;
  requestId: string;
  tool: string;
  /** `sha256:` digest of the trial ID and the operationId, or null for read-only calls. */
  operation: string | null;
  outcome: TrialOutcome;
  durationMs: number;
  steps?: G3Step[];
  repair?: { kind: TrialRepair; of: string };
  usage?: TrialUsage;
}
export interface AgentTrialRecord {
  schema: typeof AGENT_TRIAL_RECORD_VERSION;
  trialId: string;
  kind: TrialKind;
  startedAt: string;
  endedAt: string;
  host: TrialHost;
  configuration: { provider: string; model: string; digest: string };
  budget: TrialBudget;
  entries: TrialRecordEntry[];
  steps: Record<G3Step, string[]>;
  totals: { requests: number; inputTokens: number; outputTokens: number; cost: number };
  withinBudget: boolean;
  truncated: boolean;
}
export interface TrialObservation { requestId: string; tool: string; input?: unknown; result?: ActivityToolResult; error?: unknown; durationMs?: number }
export interface TrialRecorder {
  /** A relay whose dispatch results are recorded; everything else passes through unchanged. */
  relay(relay: ActivityRelay): ActivityRelay;
  /** Records one call made through another channel. Only identifiers and codes are kept. */
  observe(call: TrialObservation): void;
  /** Marks a recorded request as evidence for a G3 step. */
  markStep(requestId: string, step: G3Step): void;
  /** Records that `requestId` repaired the earlier request `of`, as a fixed-vocabulary kind. */
  noteRepair(requestId: string, kind: TrialRepair, of: string): void;
  /** Adds host-measured usage (numbers only) to a recorded request. */
  noteUsage(requestId: string, usage: TrialUsage): void;
  record(): AgentTrialRecord;
}

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9_.:@/-]{0,127}$/;
const NAME = /^[A-Za-z0-9][A-Za-z0-9_.:@/+-]{0,127}$/;
const CODE = /^[A-Z][A-Z0-9_]{1,63}$/;
const STATUS = /^[a-z][a-z-]{0,31}$/;
/** Setting names that hold credentials (max_tokens and similar generation settings are fine). */
const SECRET_NAME = /(api[-_]?key|^key$|secret|passw(or)?d|authori[sz]ation|credential|bearer|cookie|(access|auth|refresh|session|id)[-_]?token|^token$)/i;
/** Values shaped like provider keys or bearer tokens, or long opaque strings. */
const looksSecret = (value: string): boolean => /^(sk|pk|rk)-|^bearer\s|^xox[abprs]-|^gh[pousr]_|^AKIA|^AIza/i.test(value) || /^[A-Za-z0-9_\-+/=.]{32,}$/.test(value);
const TOOL_NAMES: ReadonlySet<string> = new Set(ACTIVITY_TOOL_DESCRIPTORS.map(descriptor => descriptor.name));
const amount = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0;

function checkConfiguration(configuration: TrialConfiguration): TrialConfiguration {
  if (!configuration || typeof configuration !== 'object') throw new TypeError('A provider/model configuration is required.');
  if (typeof configuration.provider !== 'string' || !NAME.test(configuration.provider)) throw new TypeError('The provider must be a short identifier.');
  if (typeof configuration.model !== 'string' || !NAME.test(configuration.model)) throw new TypeError('The model must be a pinned identifier.');
  const settings = configuration.settings ?? {};
  if (typeof settings !== 'object' || Array.isArray(settings) || Object.keys(settings).length > TRIAL_LIMITS.settings) throw new TypeError('Settings must be a small object.');
  for (const [key, value] of Object.entries(settings)) {
    if (!IDENTIFIER.test(key) || SECRET_NAME.test(key)) throw new TypeError('Settings must not carry credentials; keep keys and tokens in the host.');
    if (!(value === null || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value)) || (typeof value === 'string' && value.length <= 128 && !looksSecret(value))))
      throw new TypeError('Settings values must be short non-secret primitives.');
  }
  return { provider: configuration.provider, model: configuration.model, settings: { ...settings } };
}

function checkBudget(budget: TrialBudget): TrialBudget {
  if (!budget || !Number.isSafeInteger(budget.maxRequests) || budget.maxRequests < 1) throw new TypeError('A budget with a positive maxRequests is required.');
  const out: TrialBudget = { maxRequests: budget.maxRequests };
  if (budget.maxInputTokens !== undefined) { if (!amount(budget.maxInputTokens)) throw new TypeError('maxInputTokens must be a non-negative number.'); out.maxInputTokens = budget.maxInputTokens; }
  if (budget.maxOutputTokens !== undefined) { if (!amount(budget.maxOutputTokens)) throw new TypeError('maxOutputTokens must be a non-negative number.'); out.maxOutputTokens = budget.maxOutputTokens; }
  if (budget.maxCost !== undefined) {
    if (!amount(budget.maxCost?.amount) || typeof budget.maxCost.currency !== 'string' || !/^[A-Z]{3}$/.test(budget.maxCost.currency)) throw new TypeError('maxCost needs an amount and an ISO currency code.');
    out.maxCost = { amount: budget.maxCost.amount, currency: budget.maxCost.currency };
  }
  return out;
}

function checkHost(host: TrialHost = {}): TrialHost {
  const out: TrialHost = {};
  if (host.name !== undefined) { if (!NAME.test(host.name)) throw new TypeError('host.name must be a short identifier.'); out.name = host.name; }
  if (host.commit !== undefined) { if (!/^[0-9a-f]{7,64}$/.test(host.commit)) throw new TypeError('host.commit must be a commit hash.'); out.commit = host.commit; }
  if (host.binarySha256 !== undefined) { if (!/^[0-9a-f]{64}$/.test(host.binarySha256)) throw new TypeError('host.binarySha256 must be a sha256 hex digest.'); out.binarySha256 = host.binarySha256; }
  if (host.platform !== undefined) { if (!NAME.test(host.platform)) throw new TypeError('host.platform must be a short identifier.'); out.platform = host.platform; }
  return out;
}

/** The outcome of a tool call reduced to codes: never data, messages or paths. */
export function sanitizedOutcome(result: ActivityToolResult | undefined, error: unknown): TrialOutcome {
  if (error !== undefined || !result) {
    const code = error instanceof RelayError && CODE.test(error.code) ? error.code : 'UNKNOWN_ERROR';
    return { relayError: code };
  }
  if (result.ok) {
    const status = (result.data as { status?: unknown } | undefined)?.status;
    return { ok: true, status: typeof status === 'string' && STATUS.test(status) ? status : null };
  }
  const codes = [...new Set((result.diagnostics ?? []).map((item): unknown => item?.code).filter((code): code is string => typeof code === 'string' && CODE.test(code)))].slice(0, TRIAL_LIMITS.codesPerEntry);
  return { ok: false, codes: codes.length ? codes : ['UNKNOWN_ERROR'] };
}

/** Creates an opt-in trial recorder (see the module comment). */
export function createTrialRecorder(options: TrialRecorderOptions): TrialRecorder {
  if (!options || typeof options.trialId !== 'string' || !IDENTIFIER.test(options.trialId)) throw new TypeError('A trial ID (identifier) is required.');
  if (options.kind !== 'real-agent-trial' && options.kind !== 'scripted-fixture') throw new TypeError('kind must be real-agent-trial or scripted-fixture.');
  const configuration = checkConfiguration(options.configuration);
  const budget = checkBudget(options.budget);
  const host = checkHost(options.host);
  const now = options.now ?? Date.now;
  const startedAt = new Date(now()).toISOString();
  const digest = `sha256:${sha256(canonicalJSON(configuration))}`;
  const entries: TrialRecordEntry[] = [];
  const byRequest = new Map<string, TrialRecordEntry>();
  const steps = Object.fromEntries(G3_STEPS.map(step => [step, [] as string[]])) as Record<G3Step, string[]>;
  const totals = { requests: 0, inputTokens: 0, outputTokens: 0, cost: 0 };
  let truncated = false;

  const operationOf = (input: unknown): string | null => {
    const operationId = input && typeof input === 'object' && !Array.isArray(input) ? Object.getOwnPropertyDescriptor(input, 'operationId')?.value : undefined;
    return typeof operationId === 'string' ? `sha256:${sha256(`${options.trialId}\u0000${operationId}`)}` : null;
  };
  const known = (requestId: string): TrialRecordEntry => {
    const entry = typeof requestId === 'string' ? byRequest.get(requestId) : undefined;
    if (!entry) throw new TypeError('Unknown request ID: record the call before annotating it.');
    return entry;
  };

  const recorder: TrialRecorder = {
    observe({ requestId, tool, input, result, error, durationMs }) {
      totals.requests++;
      if (entries.length >= TRIAL_LIMITS.entries) { truncated = true; return; }
      const valid = typeof requestId === 'string' && IDENTIFIER.test(requestId);
      const id = !valid ? `invalid-${totals.requests}` : byRequest.has(requestId) ? `duplicate-${totals.requests}` : requestId;
      const entry: TrialRecordEntry = {
        sequence: totals.requests, requestId: id, tool: typeof tool === 'string' && TOOL_NAMES.has(tool) ? tool : 'unknown',
        operation: operationOf(input), outcome: sanitizedOutcome(result, error), durationMs: amount(durationMs) ? Math.round(durationMs) : 0,
      };
      entries.push(entry);
      byRequest.set(id, entry);
    },
    relay(relay) {
      return {
        connect: options => relay.connect(options),
        unbind: options => relay.unbind(options),
        dispose: () => relay.dispose(),
        async dispatch(call) {
          const started = now();
          try {
            const result = await relay.dispatch(call);
            recorder.observe({ requestId: call.requestId, tool: call.name, input: call.input, result, durationMs: now() - started });
            return result;
          } catch (error) {
            recorder.observe({ requestId: call.requestId, tool: call.name, input: call.input, error, durationMs: now() - started });
            throw error;
          }
        },
      };
    },
    markStep(requestId, step) {
      if (!G3_STEPS.includes(step)) throw new TypeError(`Unknown G3 step: use one of ${G3_STEPS.join(', ')}.`);
      const entry = known(requestId);
      entry.steps = [...new Set([...(entry.steps ?? []), step])];
      if (!steps[step].includes(entry.requestId)) steps[step].push(entry.requestId);
    },
    noteRepair(requestId, kind, of) {
      if (!TRIAL_REPAIRS.includes(kind)) throw new TypeError(`Unknown repair kind: use one of ${TRIAL_REPAIRS.join(', ')}.`);
      const entry = known(requestId);
      entry.repair = { kind, of: known(of).requestId };
    },
    noteUsage(requestId, usage) {
      const entry = known(requestId);
      const clean: TrialUsage = {};
      for (const key of ['inputTokens', 'outputTokens', 'cost'] as const) {
        const value = usage?.[key];
        if (value === undefined) continue;
        if (!amount(value)) throw new TypeError(`${key} must be a non-negative number.`);
        clean[key] = value;
        totals[key] += value;
      }
      entry.usage = { ...entry.usage, ...clean };
    },
    record() {
      const withinBudget = totals.requests <= budget.maxRequests
        && (budget.maxInputTokens === undefined || totals.inputTokens <= budget.maxInputTokens)
        && (budget.maxOutputTokens === undefined || totals.outputTokens <= budget.maxOutputTokens)
        && (budget.maxCost === undefined || totals.cost <= budget.maxCost.amount);
      return structuredClone({
        schema: AGENT_TRIAL_RECORD_VERSION, trialId: options.trialId, kind: options.kind, startedAt, endedAt: new Date(now()).toISOString(), host,
        configuration: { provider: configuration.provider, model: configuration.model, digest }, budget, entries, steps, totals, withinBudget, truncated,
      });
    },
  };
  return recorder;
}

const STEP_LIST = { type: 'array', maxItems: TRIAL_LIMITS.entries, items: { type: 'string', pattern: IDENTIFIER.source } } as const;
/**
 * JSON Schema (2020-12, the bounded subset the activity contracts use) of an agent trial record. Published as
 * docs/study-harness/templates/agent-trial-record.schema.json.
 */
export const AGENT_TRIAL_RECORD_SCHEMA = Object.freeze({
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://explorable-models.dev/schema/study-harness/agent-trial-record-1.json',
  title: 'Study Harness agent trial record (external gate G3, A57)',
  description: 'Sanitized record of a host-agent trial: identifiers, tool names, outcome codes, fixed-vocabulary repairs, G3 step marks, configuration digest and budget usage. It never contains tool inputs, results, messages, learner or study text, or credentials. kind distinguishes a real configured trial from scripted or fixture evidence.',
  type: 'object',
  additionalProperties: false,
  required: ['schema', 'trialId', 'kind', 'startedAt', 'endedAt', 'host', 'configuration', 'budget', 'entries', 'steps', 'totals', 'withinBudget', 'truncated'],
  properties: {
    schema: { const: AGENT_TRIAL_RECORD_VERSION },
    trialId: { type: 'string', pattern: IDENTIFIER.source },
    kind: { enum: ['real-agent-trial', 'scripted-fixture'] },
    startedAt: { type: 'string', pattern: '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}([.][0-9]{1,9})?Z$' },
    endedAt: { type: 'string', pattern: '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}([.][0-9]{1,9})?Z$' },
    host: {
      type: 'object', additionalProperties: false,
      properties: { name: { type: 'string', pattern: NAME.source }, commit: { type: 'string', pattern: '^[0-9a-f]{7,64}$' }, binarySha256: { type: 'string', pattern: '^[0-9a-f]{64}$' }, platform: { type: 'string', pattern: NAME.source } },
    },
    configuration: {
      type: 'object', additionalProperties: false, required: ['provider', 'model', 'digest'],
      properties: { provider: { type: 'string', pattern: NAME.source }, model: { type: 'string', pattern: NAME.source }, digest: { type: 'string', pattern: '^sha256:[0-9a-f]{64}$' } },
    },
    budget: {
      type: 'object', additionalProperties: false, required: ['maxRequests'],
      properties: {
        maxRequests: { type: 'integer', minimum: 1 }, maxInputTokens: { type: 'number', minimum: 0 }, maxOutputTokens: { type: 'number', minimum: 0 },
        maxCost: { type: 'object', additionalProperties: false, required: ['amount', 'currency'], properties: { amount: { type: 'number', minimum: 0 }, currency: { type: 'string', pattern: '^[A-Z]{3}$' } } },
      },
    },
    entries: {
      type: 'array', maxItems: TRIAL_LIMITS.entries,
      items: {
        type: 'object', additionalProperties: false, required: ['sequence', 'requestId', 'tool', 'operation', 'outcome', 'durationMs'],
        properties: {
          sequence: { type: 'integer', minimum: 1 },
          requestId: { type: 'string', pattern: IDENTIFIER.source },
          tool: { enum: [...TOOL_NAMES, 'unknown'] },
          operation: { type: ['string', 'null'], pattern: '^sha256:[0-9a-f]{64}$' },
          outcome: {
            oneOf: [
              { type: 'object', additionalProperties: false, required: ['ok', 'status'], properties: { ok: { const: true }, status: { type: ['string', 'null'], pattern: STATUS.source } } },
              { type: 'object', additionalProperties: false, required: ['ok', 'codes'], properties: { ok: { const: false }, codes: { type: 'array', minItems: 1, maxItems: TRIAL_LIMITS.codesPerEntry, items: { type: 'string', pattern: CODE.source } } } },
              { type: 'object', additionalProperties: false, required: ['relayError'], properties: { relayError: { type: 'string', pattern: CODE.source } } },
            ],
          },
          durationMs: { type: 'number', minimum: 0 },
          steps: { type: 'array', maxItems: G3_STEPS.length, items: { enum: [...G3_STEPS] } },
          repair: { type: 'object', additionalProperties: false, required: ['kind', 'of'], properties: { kind: { enum: [...TRIAL_REPAIRS] }, of: { type: 'string', pattern: IDENTIFIER.source } } },
          usage: { type: 'object', additionalProperties: false, properties: { inputTokens: { type: 'number', minimum: 0 }, outputTokens: { type: 'number', minimum: 0 }, cost: { type: 'number', minimum: 0 } } },
        },
      },
    },
    steps: { type: 'object', additionalProperties: false, required: [...G3_STEPS], properties: Object.fromEntries(G3_STEPS.map(step => [step, STEP_LIST])) },
    totals: {
      type: 'object', additionalProperties: false, required: ['requests', 'inputTokens', 'outputTokens', 'cost'],
      properties: { requests: { type: 'integer', minimum: 0 }, inputTokens: { type: 'number', minimum: 0 }, outputTokens: { type: 'number', minimum: 0 }, cost: { type: 'number', minimum: 0 } },
    },
    withinBudget: { type: 'boolean' },
    truncated: { type: 'boolean' },
  },
});
