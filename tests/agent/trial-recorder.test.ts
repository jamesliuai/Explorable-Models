/**
 * Opt-in sanitized trial recorder (report §15.3; external gate G3, A57 preparation; G75). The recorder wraps the real
 * activity relay over the fixture host (in-process workers, memory host): it is exercised here with a deterministic
 * caller, so every record made in this file is labelled `scripted-fixture` and is NOT G3 evidence. What is tested is the
 * redaction: tool inputs, results, messages, learner/study text and credentials never reach the record, which validates
 * against the published JSON Schema.
 */
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { schemaErrors, type JsonSchema } from '@explorable-models/core/model';
import {
  AGENT_TRIAL_RECORD_SCHEMA, G3_STEPS, TRIAL_LIMITS, TRIAL_REPAIRS, createActivityRelay, createActivityToolEndpoint, createTrialRecorder, sanitizedOutcome,
  type ActivityRelay, type ActivityTools, type TrialRecorder,
} from '@explorable-models/agent';
import { RelayError } from '../../packages/agent/src/relay';
import { harness, policyFor, settled } from '../activity/support/adapter-harness.js';
import { ACTIVITY_ID, ALL_OPERATIONS, QUADRATIC, SESSION_ID, acknowledge, rig, type Rig } from './support/activity-tools.js';

const target = { hostSessionId: SESSION_ID, activityId: ACTIVITY_ID };
const CONFIGURATION = { provider: 'host-provider-adapter', model: 'example-model-2026-10-01', settings: { temperature: 0, max_tokens: 800 } };
const BUDGET = { maxRequests: 40, maxInputTokens: 200_000, maxOutputTokens: 20_000, maxCost: { amount: 2, currency: 'USD' } };
const rigs: Rig[] = [];
const disposers: (() => void)[] = [];
afterEach(() => { for (const dispose of disposers.splice(0)) dispose(); for (const r of rigs.splice(0)) r.h.adapter.dispose(); });

async function connect(tools: ActivityTools): Promise<ActivityRelay> {
  const relay = createActivityRelay({ authorize: (principal, where) => principal === 'tutor-agent' && where.hostSessionId === SESSION_ID && where.activityId === ACTIVITY_ID });
  let receive!: (message: never) => void;
  const endpoint = createActivityToolEndpoint({ ...target, tools, send: message => receive(message as never) });
  const connection = await relay.connect({ principal: 'tutor-agent', ...target, expiresAt: Date.now() + 60_000, send: message => endpoint.receive(message) });
  receive = message => connection.receive(message);
  disposers.push(() => { endpoint.dispose(); relay.dispose(); });
  return relay;
}

function recorder(): TrialRecorder {
  let clock = Date.parse('2026-10-26T12:00:00.000Z');
  return createTrialRecorder({ trialId: 'trial-fixture-1', kind: 'scripted-fixture', configuration: CONFIGURATION, budget: BUDGET, host: { name: 'memory-host', platform: 'node' }, now: () => (clock += 5) });
}

describe('sanitized trial recorder (G3 preparation; fixture-labelled)', () => {
  it('records identifiers, tool names, outcome codes, repairs and steps, never inputs, results, text or keys', async () => {
    const r = rig({ harness: harness({ policy: policyFor({ allowedTools: ALL_OPERATIONS, permittedControls: ['eta', 'x0'] }) }), audience: 'tutor' });
    rigs.push(r);
    const trial = recorder();
    const relay = trial.relay(await connect(r.tools));
    const call = (requestId: string, name: string, input: Record<string, unknown>) => relay.dispatch({ principal: 'tutor-agent', ...target, requestId, name, input });

    // Inputs carry text that must never be recorded: a learner-style operation ID, a secret-looking value, a label.
    const LEARNER_TEXT = 'alice-thinks-the-step-is-too-big';
    const discovered = await call('req-1', 'activity_discover', {});
    trial.markStep('req-1', 'discover');
    const denied = await call('req-2', 'activity_prepare', { operationId: LEARNER_TEXT, template: QUADRATIC, parameters: { a: 4, x0: -6 } });
    expect(denied.ok).toBe(false);
    trial.markStep('req-2', 'rejected-request');
    const prepared = await call('req-3', 'activity_prepare', { operationId: 'op-prepare', template: QUADRATIC, parameters: { x0: -6 } });
    expect(prepared.ok).toBe(true);
    trial.noteRepair('req-3', 'drop-parameter', 'req-2');
    trial.markStep('req-3', 'personalise');
    trial.markStep('req-3', 'repair');
    await settled(r.h);
    const inspected = await call('req-4', 'activity_inspect', {});
    trial.markStep('req-4', 'inspect');
    trial.noteUsage('req-4', { inputTokens: 1200, outputTokens: 90, cost: 0.004 });
    const guards = inspected.ok ? inspected.data.expected as Record<string, unknown> : {};
    const revealed = await call('req-5', 'activity_request_reveal', { operationId: 'op-reveal', target: { kind: 'stage', toStage: 'explore-step' }, expected: guards });
    expect(revealed.ok && revealed.data.status).toBe('authorized');
    trial.markStep('req-5', 'host-reveal');
    await settled(r.h); acknowledge(r); await settled(r.h);
    const stale = await call('req-6', 'activity_operate', { action: 'commit-parameters', operationId: 'op-stale', values: { eta: 0.75 }, expected: guards });
    expect(stale.ok).toBe(false);
    trial.markStep('req-6', 'stale-operation');
    // A relay-level refusal (an authority field in the arguments) is recorded as its relay error code.
    await expect(call('req-7', 'activity_inspect', { actor: 'host' })).rejects.toBeInstanceOf(RelayError);
    const summary = await call('req-8', 'activity_summarize', {});
    trial.markStep('req-8', 'summarise');

    const record = trial.record();
    const json = JSON.stringify(record);
    expect(schemaErrors(record, AGENT_TRIAL_RECORD_SCHEMA as unknown as JsonSchema)).toEqual([]);
    expect(record.kind).toBe('scripted-fixture');
    expect(record.entries.map(entry => [entry.requestId, entry.tool, entry.outcome])).toEqual([
      ['req-1', 'activity_discover', { ok: true, status: null }],
      ['req-2', 'activity_prepare', { ok: false, codes: ['POLICY_DENIED'] }],
      ['req-3', 'activity_prepare', { ok: true, status: null }],
      ['req-4', 'activity_inspect', { ok: true, status: null }],
      ['req-5', 'activity_request_reveal', { ok: true, status: 'authorized' }],
      ['req-6', 'activity_operate', { ok: false, codes: [(stale.ok ? [] : stale.diagnostics)[0]!.code] }],
      ['req-7', 'activity_inspect', { relayError: 'FORBIDDEN' }],
      ['req-8', 'activity_summarize', { ok: true, status: null }],
    ]);
    expect(record.entries[2]!.repair).toEqual({ kind: 'drop-parameter', of: 'req-2' });
    expect(record.steps.discover).toEqual(['req-1']);
    expect(record.steps.repair).toEqual(['req-3']);
    expect(record.steps.reopen).toEqual([]);
    expect(record.totals).toEqual({ requests: 8, inputTokens: 1200, outputTokens: 90, cost: 0.004 });
    expect(record.withinBudget).toBe(true);
    expect(record.configuration).toEqual({ provider: CONFIGURATION.provider, model: CONFIGURATION.model, digest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/) });
    // Operation IDs survive only as digests; nothing from inputs, results, diagnostics or settings appears.
    expect(record.entries[1]!.operation).toMatch(/^sha256:[0-9a-f]{64}$/);
    const forbidden = [
      LEARNER_TEXT, 'op-prepare', 'op-reveal', 'explore-step', '"x0"', '"eta"', QUADRATIC.templateId, 'temperature', 'max_tokens', 'actor', '"values"', '"parameters"',
      ...(discovered.ok ? [JSON.stringify(discovered.data).slice(1, 40)] : []),
      ...(inspected.ok ? [(inspected.data.projection as { title: string }).title, (inspected.data.projection as { stage: { instruction: string } }).stage.instruction] : []),
      ...(denied.ok ? [] : denied.diagnostics.flatMap(item => [item.message, item.recovery, item.path])),
      ...(summary.ok ? [(summary.data.summary as { text: string }).text.slice(0, 40)] : []),
    ];
    for (const text of forbidden) expect(json, text).not.toContain(text);
    // The digest of the same operation is stable (retries stay correlated), and depends on the trial.
    const again = recorder();
    again.observe({ requestId: 'x-1', tool: 'activity_prepare', input: { operationId: LEARNER_TEXT }, result: denied });
    expect(again.record().entries[0]!.operation).toBe(record.entries[1]!.operation);
  });

  it('refuses credentials in the configuration and only accepts fixed vocabularies for steps and repairs', () => {
    const make = (configuration: unknown) => () => createTrialRecorder({ trialId: 't-1', kind: 'real-agent-trial', configuration: configuration as never, budget: { maxRequests: 5 } });
    expect(make({ provider: 'p', model: 'm', settings: { apiKey: 'value' } })).toThrow(/credentials/);
    expect(make({ provider: 'p', model: 'm', settings: { authorization: 'x' } })).toThrow(/credentials/);
    expect(make({ provider: 'p', model: 'm', settings: { access_token: 'x' } })).toThrow(/credentials/);
    expect(make({ provider: 'p', model: 'm', settings: { header: 'Bearer abc' } })).toThrow(/non-secret/);
    expect(make({ provider: 'p', model: 'm', settings: { note: 'sk-ant-api03-abcdefghijklmnop' } })).toThrow(/non-secret/);
    expect(make({ provider: 'p', model: 'm', settings: { blob: 'A'.repeat(40) } })).toThrow(/non-secret/);
    expect(make({ provider: 'https://api.example/v1?key=abc', model: 'm' })).toThrow(/provider/);
    expect(make({ provider: 'p', model: 'm', settings: { temperature: 0.2, max_tokens: 800, reasoning: 'low' } })).not.toThrow();
    expect(() => createTrialRecorder({ trialId: 't-1', kind: 'llm' as never, configuration: CONFIGURATION, budget: BUDGET })).toThrow(/kind/);
    expect(() => createTrialRecorder({ trialId: 't-1', kind: 'real-agent-trial', configuration: CONFIGURATION, budget: { maxRequests: 0 } })).toThrow(/budget/);
    const trial = recorder();
    trial.observe({ requestId: 'r-1', tool: 'activity_inspect', result: { ok: true, data: {}, scope: {} } as never });
    expect(() => trial.markStep('r-1', 'celebrate' as never)).toThrow(/Unknown G3 step/);
    expect(() => trial.noteRepair('r-1', 'explained it nicely to the learner' as never, 'r-1')).toThrow(/Unknown repair kind/);
    expect(() => trial.markStep('r-404', 'discover')).toThrow(/Unknown request ID/);
    expect(() => trial.noteUsage('r-1', { inputTokens: -1 })).toThrow(/non-negative/);
    expect(G3_STEPS).toContain('unsupported-declined');
    expect(TRIAL_REPAIRS).toContain('decline-with-alternative');
  });

  it('reduces outcomes to codes, labels invalid identifiers and unknown tools, bounds entries and checks the budget', () => {
    expect(sanitizedOutcome({ ok: false, diagnostics: [{ code: 'OUT_OF_DOMAIN', path: '$.values.eta', message: 'secret value 2.5 is too big', recovery: 'try 1' }] } as never, undefined)).toEqual({ ok: false, codes: ['OUT_OF_DOMAIN'] });
    expect(sanitizedOutcome({ ok: true, data: { status: 'Shown to <b>Alice</b>' }, scope: {} } as never, undefined)).toEqual({ ok: true, status: null });
    expect(sanitizedOutcome(undefined, new Error('provider said: key sk-123 invalid'))).toEqual({ relayError: 'UNKNOWN_ERROR' });
    const trial = createTrialRecorder({ trialId: 't-2', kind: 'scripted-fixture', configuration: CONFIGURATION, budget: { maxRequests: 2 } });
    trial.observe({ requestId: 'learner said hello', tool: 'activity_inspect' });
    trial.observe({ requestId: 'r-2', tool: 'shell_exec' });
    trial.observe({ requestId: 'r-2', tool: 'activity_inspect' });
    const record = trial.record();
    expect(record.entries.map(entry => [entry.requestId, entry.tool])).toEqual([['invalid-1', 'activity_inspect'], ['r-2', 'unknown'], ['duplicate-3', 'activity_inspect']]);
    expect(record.withinBudget).toBe(false);
    expect(JSON.stringify(record)).not.toContain('learner said hello');
    expect(schemaErrors(record, AGENT_TRIAL_RECORD_SCHEMA as unknown as JsonSchema)).toEqual([]);
    const many = createTrialRecorder({ trialId: 't-3', kind: 'scripted-fixture', configuration: CONFIGURATION, budget: { maxRequests: 5000 } });
    for (let index = 0; index <= TRIAL_LIMITS.entries; index++) many.observe({ requestId: `r-${index}`, tool: 'activity_inspect' });
    const bounded = many.record();
    expect(bounded.entries).toHaveLength(TRIAL_LIMITS.entries);
    expect(bounded.truncated).toBe(true);
    expect(bounded.totals.requests).toBe(TRIAL_LIMITS.entries + 1);
  });

  it('the published schema file is exactly the runtime schema, and the schema rejects free text', () => {
    const published = JSON.parse(readFileSync(new URL('../../docs/study-harness/templates/agent-trial-record.schema.json', import.meta.url), 'utf8'));
    expect(published).toEqual(JSON.parse(JSON.stringify(AGENT_TRIAL_RECORD_SCHEMA)));
    const record = recorder().record();
    const schema = AGENT_TRIAL_RECORD_SCHEMA as unknown as JsonSchema;
    expect(schemaErrors(record, schema)).toEqual([]);
    expect(schemaErrors({ ...record, notes: 'the learner said…' }, schema)).not.toEqual([]);
    expect(schemaErrors({ ...record, entries: [{ sequence: 1, requestId: 'r', tool: 'activity_inspect', operation: null, outcome: { ok: true, status: null }, durationMs: 1, input: { x: 1 } }] }, schema)).not.toEqual([]);
    expect(schemaErrors({ ...record, entries: [{ sequence: 1, requestId: 'r', tool: 'activity_inspect', operation: null, outcome: { ok: false, codes: ['the learner was wrong'] }, durationMs: 1 }] }, schema)).not.toEqual([]);
    expect(schemaErrors({ ...record, kind: 'llm-trial' }, schema)).not.toEqual([]);
  });
});
