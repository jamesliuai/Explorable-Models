/**
 * Host receipt verification (activity-runtime §1, D5). A receipt is accepted only as the resolved value of the
 * HostPort call made for that request and only when it binds exactly that request: contract and schema, activity,
 * idempotency key, base activity revision, the adapter's current policy revision, template and model references,
 * expiry by host time, the requested `{groupId, contentDigest}` set (exactly), scope, stages and parameter domain,
 * a receipt ID never used for a different request, and a grant exposure ID that no other receipt holds. Any mismatch
 * yields a diagnostic and nothing is applied. A receipt that matches its request in every respect but has expired is
 * reported with `history`: the host committed it, so the caller follows the host-owned activity revision and keeps the
 * grant as history that never counts for visibility.
 */
import { canonicalJSON } from '@explorable-models/core';
import type { ModelRef } from '@explorable-models/core/model';
import type { AssistanceReceipt, Diagnostic, ExposureGrant, ExposureReceipt, GroupDigest, StageReceipt, TemplateRef } from './contracts.js';
import { CONTRACTS } from './contracts.js';
import { timestampMs } from './semantic.js';
import { validateRecord } from './validator.js';

interface ExpectedBase {
  activityId: string;
  idempotencyKey: string;
  basedOnActivityRevision: number;
  policy: { policyId: string; revision: number };
  template: TemplateRef;
  model: ModelRef;
  /** Requested groups; the grant must name exactly these (assistance grants may add exact template groups). */
  groups: GroupDigest[];
  /** Latest observed host time (ms) or null. */
  hostNow: number | null;
  /** Fingerprint of the request; a receipt ID already bound to another fingerprint is rejected. */
  fingerprint: string;
}
export type ReceiptExpectation =
  | ExpectedBase & { kind: 'stage'; fromStage: string; toStage: string }
  | ExpectedBase & { kind: 'exposure'; scope: ExposureGrant['scope']; intendedStage: string; parameterDomain?: Record<string, [number, number]> }
  | ExpectedBase & { kind: 'assistance'; assistanceKind: AssistanceReceipt['kind']; digests: Readonly<Record<string, string>> };

export type VerifiedReceipt<K extends ReceiptExpectation['kind']> = K extends 'stage' ? StageReceipt : K extends 'exposure' ? ExposureReceipt : AssistanceReceipt;
export type ReceiptVerdict<K extends ReceiptExpectation['kind']> =
  | { ok: true; receipt: VerifiedReceipt<K> }
  /**
   * `refreshPolicy` is set when the receipt names a newer policy revision than the adapter holds. `history` is the
   * receipt when it matches the request exactly but has expired by host time (it is never displayed).
   */
  | { ok: false; diagnostic: Diagnostic; refreshPolicy: boolean; history?: VerifiedReceipt<K> };

const CONTRACT_OF = { stage: CONTRACTS.stageReceipt, exposure: CONTRACTS.exposureReceipt, assistance: CONTRACTS.assistanceReceipt } as const;
const mismatch = (field: string): { ok: false; diagnostic: Diagnostic; refreshPolicy: false } => ({
  ok: false, refreshPolicy: false,
  diagnostic: { code: 'RECEIPT_MISMATCH', path: `$.receipt.${field}`, message: 'The host receipt does not match this request; nothing was shown.', recovery: 'Retry the request; the host must return a receipt for exactly this request.' },
});
const sameJSON = (a: unknown, b: unknown): boolean => canonicalJSON(a ?? null) === canonicalJSON(b ?? null);
const groupKey = (group: GroupDigest) => `${group.groupId}\u0000${group.contentDigest}`;
function sameGroups(granted: readonly GroupDigest[], requested: readonly GroupDigest[]): boolean {
  const a = new Set(granted.map(groupKey)), b = new Set(requested.map(groupKey));
  return a.size === granted.length && a.size === b.size && [...a].every(key => b.has(key));
}

/**
 * Verifies a host receipt against the request it answers. `used` maps receipt IDs to request fingerprints and is
 * updated when the receipt matches its request (also when it has expired: its ID is then bound to this request).
 * `held` returns the receipt ID under which the caller's exposure ledger already holds an exposure ID (null when it
 * holds none): a grant reusing another receipt's exposure ID is a mismatch (activity-runtime §1); the same receipt
 * replayed for the same request keeps its exposure ID.
 */
export function verifyReceipt<K extends ReceiptExpectation['kind']>(raw: unknown, expected: ReceiptExpectation & { kind: K }, used: Map<string, string>, held: (exposureId: string) => string | null = () => null): ReceiptVerdict<K> {
  const schema = validateRecord(CONTRACT_OF[expected.kind], raw);
  if (!schema.ok) return mismatch('contract');
  const receipt = raw as Omit<StageReceipt, 'contract' | 'grant'> & { grant: ExposureGrant | null; intendedStage?: string; kind?: AssistanceReceipt['kind'] };
  const want = expected as ReceiptExpectation;
  if (receipt.activityId !== expected.activityId) return mismatch('activityId');
  if (receipt.idempotencyKey !== expected.idempotencyKey) return mismatch('idempotencyKey');
  if (receipt.basedOnActivityRevision !== expected.basedOnActivityRevision) return mismatch('basedOnActivityRevision');
  if (receipt.policyId !== expected.policy.policyId) return mismatch('policyId');
  if (receipt.policyRevision > expected.policy.revision) return {
    ok: false, refreshPolicy: true,
    diagnostic: { code: 'STALE_POLICY_REVISION', path: '$.receipt.policyRevision', message: 'The host policy changed; nothing was shown.', recovery: 'Read the current policy revision and retry.' },
  };
  if (receipt.policyRevision !== expected.policy.revision) return mismatch('policyRevision');
  if (!sameJSON(receipt.template, expected.template)) return mismatch('template');
  if (!sameJSON(receipt.model, expected.model)) return mismatch('model');
  if (!(receipt.activityRevision > receipt.basedOnActivityRevision)) return mismatch('activityRevision');
  const previous = used.get(receipt.receiptId);
  if (previous !== undefined && previous !== expected.fingerprint) return mismatch('receiptId');

  const grant: ExposureGrant | null = receipt.grant ?? null;
  switch (want.kind) {
    case 'stage':
      if (receipt.fromStage !== want.fromStage || receipt.toStage !== want.toStage) return mismatch('toStage');
      if (want.groups.length === 0 ? grant !== null : !grant || grant.scope !== 'stage' || !sameGroups(grant.groups, want.groups)) return mismatch('grant');
      break;
    case 'exposure':
      if (receipt.intendedStage !== want.intendedStage) return mismatch('intendedStage');
      if (!grant || grant.scope !== want.scope || !sameGroups(grant.groups, want.groups)) return mismatch('grant');
      if (!sameJSON(grant.parameterDomain, want.parameterDomain)) return mismatch('grant.parameterDomain');
      break;
    case 'assistance':
      if (receipt.kind !== want.assistanceKind) return mismatch('kind');
      if (grant) {
        // Assistance grants are chosen by the host; every named group must be a template group with its exact digest.
        if (grant.groups.some(group => want.digests[group.groupId] !== group.contentDigest)) return mismatch('grant');
        if (new Set(grant.groups.map(groupKey)).size !== grant.groups.length) return mismatch('grant');
        if (want.groups.some(group => !grant.groups.some(item => groupKey(item) === groupKey(group)))) return mismatch('grant');
        if (grant.parameterDomain !== undefined && grant.scope !== 'exploration') return mismatch('grant.parameterDomain');
      } else if (want.groups.length) return mismatch('grant');
      break;
  }
  // An exposure ID names one grant: a receipt reusing the ID another receipt's grant holds is not this request's grant.
  if (grant) { const holder = held(grant.exposureId); if (holder !== null && holder !== receipt.receiptId) return mismatch('grant.exposureId'); }
  used.set(receipt.receiptId, expected.fingerprint);
  if (receipt.expiresAt !== null) {
    const issued = timestampMs(receipt.issuedAt), expires = timestampMs(receipt.expiresAt);
    if (!(expires > Math.max(issued, expected.hostNow ?? issued))) return {
      ok: false, refreshPolicy: false, history: structuredClone(receipt) as VerifiedReceipt<K>,
      diagnostic: { code: 'POLICY_EXPIRED', path: '$.receipt.expiresAt', message: 'The host authorization has expired; nothing was shown.', recovery: 'Request a new authorization.' },
    };
  }
  return { ok: true, receipt: structuredClone(receipt) as VerifiedReceipt<K> };
}
