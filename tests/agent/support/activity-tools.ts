/**
 * TEST-ONLY rig for the activity tool, relay and scripted-trial tests: the installed catalogue with in-process kernel
 * workers, the memory host double (tests/activity/support) and a tool set bound the way a host would bind it. Results
 * produced with it are fixture-host results, not evidence about the Study Harness host or a real agent.
 */
import { expect } from 'vitest';
import { TOOL_OPERATIONS, type ActivityBinding, type HostPolicy, type PreparedActivity, type ToolOperation } from '@explorable-models/activity';
import {
  ACTIVITY_TOOL_MESSAGES, ACTIVITY_TOOL_REASONS, createActivityTools,
  type ActivityToolAudience, type ActivityToolContext, type ActivityToolResult, type ActivityTools, type VisualizationTools,
} from '@explorable-models/agent';
import { harness, manifest, policyFor, settled, template, type Harness } from '../../activity/support/adapter-harness.js';

export const ACTIVITY_ID = 'act-quadratic-1';
export const SESSION_ID = 'session-1';
export const ALL_OPERATIONS: ToolOperation[] = [...TOOL_OPERATIONS];
export const QUADRATIC = { templateId: template.templateId, version: template.version };

export interface RigOptions {
  harness?: Harness;
  policy?: Partial<HostPolicy>;
  audience?: ActivityToolAudience;
  /** Host grant; every operation when omitted. */
  allowed?: ToolOperation[];
  /** Whether the bind hook hands the host control to the tools (reveal/save/close routing). */
  hostRoute?: boolean;
  /** Whether the host enables prepare/restore through the lifecycle hook. */
  lifecycle?: boolean;
  composition?: VisualizationTools;
  /** Replaces the host policy source (for injecting policy changes mid-call). */
  policySource?: (h: Harness) => () => HostPolicy | Promise<HostPolicy>;
  /** Policy revision the tools are bound to; the host's current revision when omitted. */
  policyRevision?: number;
  activityId?: string;
  hostSessionId?: string;
  /** Binds the tools to an activity the host already prepared (instead of preparing through the tools). */
  bindTo?: PreparedActivity;
}
export interface Rig {
  h: Harness;
  tools: ActivityTools;
  context: ActivityToolContext;
  /** The most recent activity prepared or restored through the tools (host side). */
  prepared(): PreparedActivity;
  /** The learner surface binding the host mounted for that activity (registered and visible). */
  learner(): ActivityBinding;
  binds: number;
}

/** Builds a tool set the way a host would: bound principal context, host policy source and lifecycle hooks. */
export function rig(options: RigOptions = {}): Rig {
  const h = options.harness ?? harness({ policy: policyFor({ allowedTools: ALL_OPERATIONS, ...options.policy }) });
  let prepared: PreparedActivity | null = null, learner: ActivityBinding | null = null;
  const state: Rig = {
    h, binds: 0, tools: null as unknown as ActivityTools, context: null as unknown as ActivityToolContext,
    prepared: () => { if (!prepared) throw new Error('nothing prepared'); return prepared; },
    learner: () => { if (!learner) throw new Error('no learner surface'); return learner; },
  };
  const context: ActivityToolContext = {
    adapter: h.adapter, catalog: h.catalog, policy: options.policySource ? options.policySource(h) : () => h.host.policy(),
    hostSessionId: options.hostSessionId ?? SESSION_ID, activityId: options.activityId ?? ACTIVITY_ID, policyRevision: options.policyRevision ?? h.host.policy().revision,
    audience: options.audience ?? 'tutor', allowedOperations: options.allowed ?? ALL_OPERATIONS,
    ...(options.lifecycle === false ? {} : {
      lifecycle: {
        request: () => ({ objectiveIds: ['obj-step-size'], hostSessionRevision: 0 }),
        bind(next: PreparedActivity) {
          prepared = next;
          learner = next.binding('learner', 'surface-main');
          learner.registerSurface('surface-main');
          state.binds++;
          return { binding: next.binding('tutor', 'tool-executor'), ...(options.hostRoute === false ? {} : { host: next.host }) };
        },
        loadArtifact: (artifactId: string) => h.host.artifacts().find(artifact => artifact.artifactId === artifactId) ?? null,
      },
    }),
    ...(options.composition ? { composition: options.composition } : {}),
    ...(options.bindTo ? { binding: options.bindTo.binding('tutor', 'tool-executor'), ...(options.hostRoute === false ? {} : { host: options.bindTo.host }) } : {}),
  };
  state.context = context;
  state.tools = createActivityTools(context);
  return state;
}

/** Unwraps a successful tool result (fails the test with the diagnostics otherwise). */
export function dataOf(result: ActivityToolResult): any {
  if (!result.ok) throw new Error(`tool failed: ${JSON.stringify(result.diagnostics)}`);
  return result.data;
}
/** Codes of a failed tool result (fails the test when it succeeded). */
export function codesOf(result: ActivityToolResult): string[] {
  if (result.ok) throw new Error(`expected a failure: ${JSON.stringify(result.data).slice(0, 400)}`);
  return result.diagnostics.map(item => item.code);
}

let counter = 0;
export const opId = (prefix = 'tool-op'): string => `${prefix}-${++counter}`;

/** Prepares the quadratic activity through the tools (default parameters) and waits for the journal. */
export async function prepareThroughTools(r: Rig, patch: Record<string, unknown> = {}): Promise<any> {
  const result = dataOf(await r.tools.execute('activity_prepare', { operationId: opId('prepare'), template: QUADRATIC, ...patch }));
  await settled(r.h);
  return result;
}
/** Current guards as the learner-visible inspection reports them. */
export async function expectedGuards(r: Rig): Promise<any> {
  return dataOf(await r.tools.execute('activity_inspect', {})).expected;
}
/** Acknowledges the current projection on the host-mounted learner surface. */
export function acknowledge(r: Rig): void {
  const projection = r.learner().getProjection();
  r.learner().acknowledgeDisplay({ projectionId: projection.projectionId, projectionDigest: projection.projectionDigest, surfaceId: 'surface-main' });
}

/** Strings that belong only to content the predict stage does not show, or to teacher-only detail. */
export const RESTRICTED: readonly string[] = (() => {
  const hidden = template.groups.filter(group => group.solutionBearing);
  const quantities = hidden.filter(group => group.kind === 'quantity').flatMap(group => group.members);
  return [
    ...quantities.map(id => manifest.quantities[id]!.label).filter(label => !['Position', 'Loss', 'Gradient', 'Regime'].includes(label)),
    ...template.views.flatMap(view => view.marks).filter(mark => hidden.some(group => group.id === mark.group)).map(mark => mark.label),
    ...template.equations.filter(equation => hidden.some(group => group.id === equation.group)).map(equation => equation.label),
    ...template.content.filter(entry => entry.kind !== 'learner-copy').map(entry => entry.text.slice(0, 48)),
    manifest.constraints[0]!.message.slice(0, 48),
  ];
})();
const VOCABULARY = new Set([...Object.values(ACTIVITY_TOOL_MESSAGES), ...Object.values(ACTIVITY_TOOL_REASONS)].flatMap(text => [text.message, text.recovery]));
/** Every diagnostic uses the fixed vocabulary and its serialized form names no restricted content. */
export function expectSafeFailure(result: ActivityToolResult): void {
  if (result.ok) throw new Error('expected a failure');
  for (const item of result.diagnostics) {
    expect(VOCABULARY.has(item.message), item.message).toBe(true);
    expect(VOCABULARY.has(item.recovery), item.recovery).toBe(true);
    expect(item.recovery).not.toMatch(/bypass|override|force|set (?:the )?(?:origin|actor)/i);
  }
  expectNoRestricted(JSON.stringify(result));
}
export function expectNoRestricted(text: string): void {
  for (const label of RESTRICTED) expect(text, label).not.toContain(label);
}

/** Prepares through the tools, reveals the step-size exploration through the host and acknowledges the display. */
export async function atExplore(r: Rig): Promise<void> {
  await prepareThroughTools(r);
  await revealExploreStep(r);
}
/** Requests the predict → explore-step transition through the host route and acknowledges the revealing projection. */
export async function revealExploreStep(r: Rig): Promise<void> {
  const reveal = dataOf(await r.tools.execute('activity_request_reveal', { operationId: opId('reveal'), target: { kind: 'stage', toStage: 'explore-step' }, expected: await expectedGuards(r) }));
  expect(reveal.status).toBe('authorized');
  await settled(r.h);
  acknowledge(r);
  await settled(r.h);
}
