/**
 * Host policy and catalogue standing (activity-runtime §1, report §5.2–§5.3). Every privileged decision is made from
 * the host-issued policy and the injected catalogue status: approved mode needs the exact template and model
 * references in `policy.approved` and non-revoked catalogue entries; exploratory mode needs `exploratory.allowed`.
 * Review claims in requests or artifacts are never consulted; the review notice is derived from catalogue status.
 */
import type { ModelRef } from '@experiment-kit/core/model';
import type { ActivityCatalog, CatalogEntryStatus, Diagnostic, HostPolicy, TemplateRef, ToolOperation } from './contracts.js';
import { CONTRACTS } from './contracts.js';
import { timestampMs, validatePolicySemantics } from './semantic.js';
import { validateRecord } from './validator.js';

const diagnostic = (code: Diagnostic['code'], path: string, message: string, recovery: string): Diagnostic => ({ code, path, message, recovery });

/** Schema and semantic diagnostics of a host policy (empty when valid). */
export function policyDiagnostics(policy: unknown): Diagnostic[] {
  const record = validateRecord(CONTRACTS.policy, policy);
  return record.ok ? validatePolicySemantics(policy as HostPolicy) : record.diagnostics;
}

/** Host clock: the latest host timestamp the adapter has observed (policy issue time, acknowledgements, receipts). */
export interface HostClock { observe(timestamp: string | null | undefined): void; now(): number | null }
export function createHostClock(): HostClock {
  let latest: number | null = null;
  return {
    observe(timestamp) {
      if (typeof timestamp !== 'string') return;
      const ms = timestampMs(timestamp);
      if (Number.isFinite(ms) && (latest === null || ms > latest)) latest = ms;
    },
    now: () => latest,
  };
}

/** Revoked → POLICY_DENIED; expired by host time → POLICY_EXPIRED; otherwise null. */
export function policyStanding(policy: HostPolicy, hostNow: number | null): Diagnostic | null {
  if (policy.revoked) return diagnostic('POLICY_DENIED', '$.policy', 'The host policy for this activity was revoked.', 'Ask the host for a current policy.');
  if (policy.expiresAt !== null) {
    const issued = timestampMs(policy.issuedAt), expires = timestampMs(policy.expiresAt);
    const now = Math.max(issued, hostNow ?? issued);
    if (!(expires > now)) return diagnostic('POLICY_EXPIRED', '$.policy.expiresAt', 'The host policy for this activity has expired.', 'Ask the host for a current policy.');
  }
  return null;
}

const sameTemplate = (a: TemplateRef, b: TemplateRef): boolean => a.templateId === b.templateId && a.version === b.version && a.digest === b.digest;
const sameModel = (a: ModelRef, b: ModelRef): boolean => a.modelId === b.modelId && a.version === b.version && a.digest === b.digest;

/** Catalogue revocation of the template or its model → CONTENT_REVOKED. */
export function revocationDiagnostic(catalog: ActivityCatalog, template: TemplateRef, model: ModelRef): Diagnostic | null {
  const statuses = [catalog.status(template), catalog.status(model)];
  return statuses.some(status => status.revoked || status.lifecycle === 'revoked')
    ? diagnostic('CONTENT_REVOKED', '$.template', 'This activity content has been revoked by the host.', 'Choose another installed activity; revoked content cannot be reopened.')
    : null;
}

/**
 * Mode authorization. Approved: the exact `{template, model}` pair is listed in `policy.approved` (no substitution by
 * ID or version) and neither entry is revoked. Exploratory: `policy.exploratory.allowed`, and still never revoked
 * content. A forged or modified template has a different digest and therefore never matches an approval.
 */
export function modeDiagnostic(mode: 'approved' | 'exploratory', policy: HostPolicy, catalog: ActivityCatalog, template: TemplateRef, model: ModelRef): Diagnostic | null {
  const revoked = revocationDiagnostic(catalog, template, model);
  if (revoked) return revoked;
  if (mode === 'approved') {
    if (!policy.approved.some(entry => sameTemplate(entry.template, template) && sameModel(entry.model, model)))
      return diagnostic('POLICY_DENIED', '$.mode', 'The host policy does not approve this exact activity template and model.', 'Ask the host to approve the installed version, or use exploratory mode where the policy allows it.');
    return null;
  }
  if (!policy.exploratory.allowed) return diagnostic('POLICY_DENIED', '$.mode', 'The host policy does not allow exploratory activities.', 'Use an approved activity.');
  return null;
}

/** Tool permission under the current context: independent tasks restrict tools to `independentTask.permittedTools`. */
export function toolPermitted(policy: HostPolicy, tool: ToolOperation, independent: boolean): boolean {
  return policy.allowedTools.includes(tool) && (!independent || policy.independentTask.permittedTools.includes(tool));
}

const NOTICE_LIMIT = 200;
/**
 * Learner-facing review notice derived only from the mode and the host-resolved catalogue status. A hash or a passing
 * reference suite is never presented as subject review.
 */
export function reviewNotice(mode: 'approved' | 'exploratory', template: CatalogEntryStatus, model: CatalogEntryStatus): string {
  if (mode === 'exploratory') return 'Exploratory composition — not reviewed';
  const order = ['authored', 'validated', 'reference-checked', 'reviewed'] as const;
  if (template.revoked || model.revoked) return 'Revoked content — not available';
  if (template.lifecycle === 'deprecated' || model.lifecycle === 'deprecated') return 'Deprecated version; still approved by the host';
  const rank = (status: CatalogEntryStatus) => Math.max(0, order.indexOf(status.lifecycle as typeof order[number]));
  const lowest = order[Math.min(rank(template), rank(model))]!;
  if (lowest === 'reviewed') {
    const scope = template.reviews[0]?.scope ?? model.reviews[0]?.scope ?? '';
    return `Independently reviewed${scope ? ` for: ${scope}` : ''}`.slice(0, NOTICE_LIMIT);
  }
  if (lowest === 'reference-checked') return 'Reference-checked; no independent subject review';
  if (lowest === 'validated') return 'Mechanically validated; not reference-checked or reviewed';
  return 'Authored content; not validated or reviewed';
}
