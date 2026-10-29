/**
 * SCRIPTED CONFORMANCE SEQUENCE — NOT AN LLM TRIAL. A deterministic, rule-based caller (no provider SDK, no network,
 * no model) drives the policy-scoped activity tools over the activity relay through the sequence of
 * docs/study-harness/external-gates.md G3: discover → prepare with personalised allowed parameters → inspect →
 * rejected request and repair → reveal through the host → summarize → save → reopen → stale operation handled →
 * unsupported request declined with the advertised alternative. It is protocol evidence against the fixture host only
 * and does NOT satisfy the real configured host-agent gate A57, which stays open until the owner runs G3 with the
 * actual Study Harness agent path, credentials and budget.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { ToolOperation } from '@explorable-models/activity';
import { createActivityRelay, createActivityToolEndpoint, type ActivityRelay, type ActivityToolResult, type ActivityTools } from '@explorable-models/agent';
import { harness, policyFor, settled } from '../activity/support/adapter-harness.js';
import { MemoryHost } from '../activity/support/memory-host.js';
import { ACTIVITY_ID, SESSION_ID, acknowledge, expectNoRestricted, rig, type Rig } from './support/activity-tools.js';

const EVIDENCE_LABEL = 'scripted conformance sequence (deterministic caller, fixture host); not an LLM trial; does not satisfy A57';
const TUTOR_GRANT: ToolOperation[] = ['discover', 'prepare', 'inspect.learner', 'propose-revision', 'request-reveal', 'operate.parameters', 'operate.navigation',
  'operate.playback', 'operate.presentation', 'summarize', 'save', 'restore', 'close'];
const target = { hostSessionId: SESSION_ID, activityId: ACTIVITY_ID };

interface Step { step: string; tool: string; requestId: string; operationId: string | null; outcome: string; repair?: string }

/**
 * Deterministic caller. It only sees tool results, keeps the guards the tools return, and repairs failures with fixed
 * rules keyed by diagnostic code (re-inspect on stale guards, choose a value inside the reported range, ask the host
 * for a stage change when a control is not interactive, decline unsupported requests with the listed alternative).
 */
class ScriptedCaller {
  readonly transcript: Step[] = [];
  private requests = 0;
  private operations = 0;
  expected: Record<string, unknown> | null = null;
  constructor(private relay: ActivityRelay) {}
  async call(step: string, tool: string, input: Record<string, unknown>): Promise<ActivityToolResult> {
    const requestId = `trial-request-${++this.requests}`;
    const result = await this.relay.dispatch({ principal: 'tutor-agent', ...target, requestId, name: tool, input });
    const status = result.ok && typeof result.data.status === 'string' ? `:${result.data.status}` : '';
    this.transcript.push({ step, tool, requestId, operationId: typeof input.operationId === 'string' ? input.operationId : null, outcome: result.ok ? `ok${status}` : result.diagnostics.map(item => item.code).join(',') });
    if (result.ok && result.data.expected) this.expected = result.data.expected as Record<string, unknown>;
    return result;
  }
  nextOperation(): string { return `trial-op-${++this.operations}`; }
  noteRepair(repair: string): void { this.transcript.at(-1)!.repair = repair; }
}

let rigs: Rig[] = [];
afterEach(() => { for (const r of rigs) r.h.adapter.dispose(); rigs = []; });
function connect(tools: ActivityTools): Promise<{ relay: ActivityRelay; dispose(): void }> {
  const relay = createActivityRelay({ authorize: (principal, where) => principal === 'tutor-agent' && where.hostSessionId === SESSION_ID && where.activityId === ACTIVITY_ID });
  let receive!: (message: never) => void;
  const endpoint = createActivityToolEndpoint({ ...target, tools, send: message => receive(message as never) });
  return relay.connect({ principal: 'tutor-agent', ...target, expiresAt: Date.now() + 60_000, send: message => endpoint.receive(message) })
    .then(connection => { receive = message => connection.receive(message); return { relay, dispose() { endpoint.dispose(); relay.dispose(); } }; });
}

describe(`G3 sequence — ${EVIDENCE_LABEL}`, () => {
  it('discovers, prepares, inspects, repairs, reveals, summarizes, saves, reopens, handles a stale operation and declines an unsupported request', async () => {
    const policy = policyFor({ allowedTools: TUTOR_GRANT, permittedControls: ['eta', 'x0'], sampling: { allowed: false, maxPositions: 0 } });
    const first = rig({ harness: harness({ policy }), allowed: TUTOR_GRANT, audience: 'tutor' });
    rigs.push(first);
    const link = await connect(first.tools);
    const caller = new ScriptedCaller(link.relay);

    // 1 Discover an approved activity.
    const discovered = await caller.call('discover', 'activity_discover', {});
    if (!discovered.ok) throw new Error(`discover failed: ${JSON.stringify(discovered.diagnostics)}`);
    const templates = discovered.data.templates as { template: { templateId: string; version: string }; availability: string; review: { scope: string }; controls: { parameter: string; min: number; max: number; personalisable: boolean }[] }[];
    const chosen = templates.find(item => item.availability === 'approved')!;
    expect(chosen.template.templateId).toBe('quadratic-gradient-descent');
    expect(chosen.review.scope).toBe('no independent subject review');
    const personalisable = chosen.controls.filter(control => control.personalisable).map(control => control.parameter);
    expect(personalisable).toEqual(['eta', 'x0']);

    // 2 Prepare with personalised allowed parameters (the caller first asks for a curvature it may not set, then repairs).
    const reference = { templateId: chosen.template.templateId, version: chosen.template.version };
    const notAllowed = await caller.call('prepare', 'activity_prepare', { operationId: caller.nextOperation(), template: reference, parameters: { a: 4, x0: -6 } });
    expect(notAllowed.ok ? [] : notAllowed.diagnostics.map(item => [item.code, item.path])).toEqual([['POLICY_DENIED', '$.parameters.a']]);
    caller.noteRepair('dropped the non-personalisable parameter a');
    const prepared = await caller.call('prepare', 'activity_prepare', { operationId: caller.nextOperation(), template: reference, parameters: { x0: -6 } });
    expect(prepared.ok).toBe(true);
    await settled(first.h);

    // 3 Inspect learner-visible state.
    const inspected = await caller.call('inspect', 'activity_inspect', {});
    if (!inspected.ok) throw new Error('inspect failed');
    const projection = inspected.data.projection as { stage: { id: string }; controls: { parameter: string; value: number; mode: string }[] };
    expect(projection.stage.id).toBe('predict');
    expect(projection.controls.find(control => control.parameter === 'x0')!.value).toBe(-6);
    expectNoRestricted(JSON.stringify(inspected));

    // 4 A rejected request and its repair: the step size is fixed while the learner predicts.
    const rejected = await caller.call('rejected-request', 'activity_operate', { action: 'commit-parameters', operationId: caller.nextOperation(), values: { eta: 0.75 }, expected: caller.expected });
    expect(rejected.ok ? [] : rejected.diagnostics.map(item => item.code)).toEqual(['POLICY_DENIED']);
    expect(rejected.ok ? '' : rejected.diagnostics[0]!.recovery).not.toMatch(/origin|actor/i);
    caller.noteRepair('proposed the declared stage transition instead of retrying the fixed control');
    const proposal = await caller.call('repair', 'activity_propose_revision', { operationId: caller.nextOperation(), proposal: { kind: 'stage', toStage: 'explore-step' } });
    if (!proposal.ok) throw new Error('proposal failed');
    expect(proposal.data.verdict).toBe('host-decision-required');
    const apply = proposal.data.apply as { tool: string; input: Record<string, unknown> };
    expect(apply.tool).toBe('activity_request_reveal');

    // 5 Request the reveal through the host; the learner surface acknowledges the display.
    const revealed = await caller.call('reveal', 'activity_request_reveal', { ...apply.input, operationId: caller.nextOperation() });
    expect(revealed.ok && revealed.data.status).toBe('authorized');
    await settled(first.h);
    acknowledge(first);
    await settled(first.h);
    const out = await caller.call('repair', 'activity_operate', { action: 'commit-parameters', operationId: caller.nextOperation(), values: { eta: 2.5 }, expected: caller.expected });
    expect(out.ok ? [] : out.diagnostics.map(item => [item.code, item.path])).toEqual([['OUT_OF_DOMAIN', '$.values.eta']]);
    caller.noteRepair('chose a value inside the control range reported by activity_inspect');
    await caller.call('inspect', 'activity_inspect', {});
    const committed = await caller.call('repair', 'activity_operate', { action: 'commit-parameters', operationId: caller.nextOperation(), values: { eta: 0.75 }, expected: caller.expected });
    expect(committed.ok).toBe(true);
    await caller.call('operate', 'activity_operate', { action: 'step', operationId: caller.nextOperation(), delta: 1, expected: caller.expected });
    await settled(first.h);

    // 6 Summarize the interaction.
    const summary = await caller.call('summarize', 'activity_summarize', {});
    if (!summary.ok) throw new Error('summary failed');
    const text = (summary.data.summary as { text: string; committedConfigurations: unknown[] });
    expect(text.committedConfigurations.length).toBeGreaterThanOrEqual(2);
    expect(text.text).not.toMatch(/understood|mastered|learned/i);

    // 7 Save a backup through the host.
    const saved = await caller.call('save', 'activity_save', { operationId: caller.nextOperation(), kind: 'backup' });
    if (!saved.ok) throw new Error('save failed');
    const staleGuards = caller.expected;
    await settled(first.h);
    link.dispose();
    first.h.adapter.dispose();

    // 8 Reopen after a restart: a new adapter over the durable host tables, a new tool set and a new relay binding.
    const restartedHost = first.h.host.restoreInto(new MemoryHost({ policy }));
    const second = rig({ harness: harness({ host: restartedHost }), allowed: TUTOR_GRANT, audience: 'tutor' });
    rigs.push(second);
    const relink = await connect(second.tools);
    const reopened = new ScriptedCaller(relink.relay);
    const restored = await reopened.call('reopen', 'activity_restore', { operationId: 'trial-op-reopen', artifactId: saved.data.artifactId as string });
    if (!restored.ok) throw new Error(`restore failed: ${JSON.stringify(restored.diagnostics)}`);
    // The current policy does not permit the curvature control the stage lists, so the restore is reported restricted.
    expect(restored.data.restored).toBe('restricted');
    expect((restored.data.projection as { stage: { id: string }; navigation: { playing: boolean } }).stage.id).toBe('explore-step');
    await settled(second.h);
    expect(reopened.expected).not.toEqual(staleGuards);

    // 9 A stale operation: the caller replays guards from before the restart; it re-inspects instead of forcing it.
    const stale = await reopened.call('stale-operation', 'activity_operate', { action: 'select', operationId: reopened.nextOperation(), target: 'landscape', expected: staleGuards });
    expect(stale.ok ? [] : stale.diagnostics.map(item => item.code)).toEqual([expect.stringMatching(/^STALE_/)]);
    reopened.noteRepair('re-inspected for current guards');
    await reopened.call('stale-operation', 'activity_inspect', {});
    const retried = await reopened.call('stale-operation', 'activity_operate', { action: 'select', operationId: reopened.nextOperation(), target: 'landscape', expected: reopened.expected });
    expect(retried.ok).toBe(true);

    // 10 An unsupported request ("plot a general ODE") is declined with the alternative discovery advertises.
    const listing = await reopened.call('unsupported', 'activity_discover', {});
    if (!listing.ok) throw new Error('discover failed');
    const alternative = (listing.data.unsupported as { capability: string; alternative: string }[]).find(item => item.capability === 'general-ode-solving');
    expect(alternative?.alternative).toMatch(/not installed/);
    reopened.noteRepair(`declined: ${alternative!.alternative.slice(0, 60)}`);
    relink.dispose();

    // Sanitized record: identifiers, tool names, outcomes and repairs only.
    const record = { evidence: EVIDENCE_LABEL, steps: [...caller.transcript, ...reopened.transcript] };
    expect(record.steps.map(step => step.step)).toEqual(expect.arrayContaining(['discover', 'prepare', 'inspect', 'rejected-request', 'repair', 'reveal', 'summarize', 'save', 'reopen', 'stale-operation', 'unsupported']));
    expect(JSON.stringify(record)).not.toMatch(/sha256:|"projection"/);
    expect(record.steps.filter(step => step.repair)).toHaveLength(5);
  });

  it('declines the unsupported request before any activity exists, using only the advertised alternative', async () => {
    const r = rig({ allowed: TUTOR_GRANT, audience: 'tutor', harness: harness({ policy: policyFor({ allowedTools: TUTOR_GRANT, sampling: { allowed: false, maxPositions: 0 } }) }) });
    rigs.push(r);
    const link = await connect(r.tools);
    const caller = new ScriptedCaller(link.relay);
    const attempt = await caller.call('unsupported', 'activity_prepare', { operationId: caller.nextOperation(), template: { templateId: 'general-ode-solver', version: '1.0.0' } });
    expect(attempt.ok ? [] : attempt.diagnostics.map(item => item.code)).toEqual(['INVALID_REFERENCE']);
    expect(attempt.ok ? '' : attempt.diagnostics[0]!.recovery).toMatch(/activity_discover/);
    const listing = await caller.call('unsupported', 'activity_discover', {});
    const offered = listing.ok ? (listing.data.unsupported as { capability: string; alternative: string }[]).find(item => item.capability === 'general-ode-solving') : undefined;
    expect(offered?.alternative).toMatch(/Offer an approved activity/);
    expect(r.h.host.calls('registerActivity')).toHaveLength(0);
    link.dispose();
  });
});
