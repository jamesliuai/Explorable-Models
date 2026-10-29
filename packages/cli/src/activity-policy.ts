/**
 * Host policies for learner-scoped authoring views (report §6.2, §15.2): `capture --policy` and `preview`. Data only;
 * bundled into the Node-side toolkit (activity-toolkit.ts) and never handed authored code.
 *
 * - `previewPolicyFile` validates a supplied `study-harness.host-policy` (schema and semantics) and decides the mode the
 *   activity is prepared in: an authored package always runs exploratory, so the policy must allow exploratory
 *   activities; an installed template runs approved when the policy approves its exact template and model digests,
 *   otherwise exploratory when the policy allows that. A supplied policy is never widened: nothing is added to its
 *   ceiling, approvals or tools.
 * - `derivedLearnerPolicy` is the documented default learner policy (authoring.md §7): every group of the template
 *   inside the ceiling, every control permitted, learner-facing tools only, no inspection beyond the learner
 *   projection, no sampling, no independent task. What the learner then sees is decided by the stages and the host's
 *   exposure grants, exactly as in a host that permits the whole template.
 * - `authorViewTemplate` is the author view's template: every group visible and every control listed in every stage
 *   (stage modes kept where the stage lists the group or control, `fixed` elsewhere). It is an author aid run in
 *   exploratory mode, never a learner channel.
 */
import {
  CONTRACTS, templateRef, timestampMs, validatePolicySemantics, validateRecord,
  type ActivityTemplate, type HostPolicy, type TemplateRef, type ToolOperation,
} from '@experiment-kit/activity';
import type { ModelRef } from '@experiment-kit/core/model';
import type { AuthorDiagnostic } from './activity-validation.js';

/** Tools of the derived learner policy: the learner surface's operations, the host's reveal requests and summaries. */
export const LEARNER_TOOLS: readonly ToolOperation[] = Object.freeze(['prepare', 'inspect.learner', 'request-reveal', 'operate.parameters', 'operate.navigation', 'operate.playback', 'operate.presentation', 'summarize', 'close']);

export interface PolicyContext {
  template: ActivityTemplate;
  model: ModelRef;
  /** True for an installed template (approved mode possible); false for an authored package (always exploratory). */
  installed: boolean;
}
export interface PolicyCheck {
  ok: boolean;
  diagnostics: AuthorDiagnostic[];
  policy: HostPolicy | null;
  /** Mode the activity is prepared in under this policy. */
  mode: 'approved' | 'exploratory' | null;
  /** What the policy ceiling withholds from the template (informational; the stages decide the rest). */
  notes: PolicyNotes | null;
}
export interface PolicyNotes {
  groupsOutsideCeiling: string[];
  controlsNotPermitted: string[];
  unknownGroups: string[];
  unknownControls: string[];
  independentTask: boolean;
  capture: boolean;
}

const sameTemplate = (a: TemplateRef, b: TemplateRef) => a.templateId === b.templateId && a.version === b.version && a.digest === b.digest;
const sameModel = (a: ModelRef, b: ModelRef) => a.modelId === b.modelId && a.version === b.version && a.digest === b.digest;
const problem = (code: string, file: string, path: string, message: string, recovery?: string): AuthorDiagnostic => ({ severity: 'error', code, file, path, message, ...(recovery ? { recovery } : {}) });

export function policyNotes(policy: HostPolicy, template: ActivityTemplate): PolicyNotes {
  const ceiling = new Set(policy.visibleGroups), permitted = new Set(policy.permittedControls);
  const groups = new Set(template.groups.map(group => group.id)), controls = new Set(template.controls.map(control => control.parameter));
  return {
    groupsOutsideCeiling: template.groups.filter(group => !ceiling.has(group.id)).map(group => group.id),
    controlsNotPermitted: template.controls.filter(control => !permitted.has(control.parameter)).map(control => control.parameter),
    unknownGroups: policy.visibleGroups.filter(id => !groups.has(id)),
    unknownControls: policy.permittedControls.filter(id => !controls.has(id)),
    independentTask: policy.independentTask.active,
    capture: policy.export.capture,
  };
}

/** Validates a supplied policy file's parsed JSON for a learner-scoped view of `context.template` at time `now`. */
export function previewPolicyFile(raw: unknown, file: string, context: PolicyContext, now: number = Date.now()): PolicyCheck {
  const failed = (...diagnostics: AuthorDiagnostic[]): PolicyCheck => ({ ok: false, diagnostics, policy: null, mode: null, notes: null });
  const record = validateRecord(CONTRACTS.policy, raw);
  if (!record.ok) return failed(...record.diagnostics.map(item => problem(item.code, file, item.path, item.message, item.recovery)));
  const policy = raw as HostPolicy;
  const semantic = validatePolicySemantics(policy);
  if (semantic.length) return failed(...semantic.map(item => problem(item.code, file, item.path, item.message, item.recovery)));
  if (policy.revoked) return failed(problem('POLICY_DENIED', file, '$.revoked', 'The policy is revoked, so no activity can be prepared under it.', 'Use a policy that is not revoked.'));
  if (policy.expiresAt !== null && !(timestampMs(policy.expiresAt) > now)) return failed(problem('POLICY_EXPIRED', file, '$.expiresAt', 'The policy has expired, so no activity can be prepared under it.', 'Set a later expiresAt, or null.'));
  const ref = templateRef(context.template);
  let mode: 'approved' | 'exploratory';
  if (context.installed && policy.approved.some(entry => sameTemplate(entry.template, ref) && sameModel(entry.model, context.model))) mode = 'approved';
  else if (policy.exploratory.allowed) mode = 'exploratory';
  else return failed(problem('POLICY_DENIED', file, context.installed ? '$.approved' : '$.exploratory.allowed',
    context.installed ? 'The policy neither approves this exact installed template and model nor allows exploratory activities.' : 'An authored package runs in exploratory mode, but the policy does not allow exploratory activities.',
    context.installed ? `Approve { "template": ${JSON.stringify(ref)}, "model": ${JSON.stringify(context.model)} }, or set exploratory.allowed with mode "exploratory".`
      : 'Set "mode": "exploratory" and "exploratory": { "allowed": true, … } in the preview policy.'));
  return { ok: true, diagnostics: [], policy, mode, notes: policyNotes(policy, context.template) };
}

/** The documented default learner policy for a learner-scoped view (see the module comment). */
export function derivedLearnerPolicy(context: PolicyContext, issuedAt: string): HostPolicy {
  const approved = context.installed ? [{ template: templateRef(context.template), model: { ...context.model } }] : [];
  return {
    contract: CONTRACTS.policy, schemaVersion: '1.0', policyId: `learner-preview-${context.template.templateId}`.slice(0, 128), revision: 1, issuedAt, expiresAt: null,
    revoked: false, mode: context.installed ? 'approved' : 'exploratory', approved, allowedTools: [...LEARNER_TOOLS],
    visibleGroups: context.template.groups.map(group => group.id), permittedControls: context.template.controls.map(control => control.parameter),
    export: { learnerSnapshot: false, capture: true, backup: false }, inspection: { developer: false, tutor: 'learner-visible', teacher: false },
    independentTask: { active: false, taskRef: null, permittedTools: [], neutralScaffold: [] }, sampling: { allowed: false, maxPositions: 0 },
    exploratory: { allowed: !context.installed, maxParametersOverride: 0 },
  };
}

/** The author view's template (see the module comment); same IDs, identity of its own. */
export function authorViewTemplate(template: ActivityTemplate): ActivityTemplate {
  const copy = structuredClone(template);
  for (const stage of copy.stages) {
    stage.visible = Object.fromEntries(copy.groups.map(group => [group.id, stage.visible[group.id] ?? 'fixed']));
    stage.controls = Object.fromEntries(copy.controls.map(control => [control.parameter, stage.controls[control.parameter] ?? 'fixed']));
  }
  return copy;
}

/** The author view's policy: exploratory, every group and control of the author view template. */
export function authorViewPolicy(template: ActivityTemplate, issuedAt: string): HostPolicy {
  return {
    contract: CONTRACTS.policy, schemaVersion: '1.0', policyId: `author-view-${template.templateId}`.slice(0, 128), revision: 1, issuedAt, expiresAt: null,
    revoked: false, mode: 'exploratory', approved: [], allowedTools: [...LEARNER_TOOLS],
    visibleGroups: template.groups.map(group => group.id), permittedControls: template.controls.map(control => control.parameter),
    export: { learnerSnapshot: false, capture: true, backup: false }, inspection: { developer: false, tutor: 'learner-visible', teacher: false },
    independentTask: { active: false, taskRef: null, permittedTools: [], neutralScaffold: [] }, sampling: { allowed: false, maxPositions: 0 },
    exploratory: { allowed: true, maxParametersOverride: 0 },
  };
}
