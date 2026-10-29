/**
 * EXAMPLE HOST for the observed-data page — an in-memory HostPort for this page only. Not the Study Harness host, not a
 * reference host and not a learning database: it keeps the journal and receipts in memory for one tab, issues receipts
 * that echo each request exactly (idempotent by key), acknowledges display and saves without durability. Results
 * produced with it are example-page (Chromium) results.
 */
import {
  artifactDigest, CONTRACTS, hostRefusal,
  type ActivityArtifact, type AppendResult, type AssistanceReceipt, type AssistanceRequest, type DisplayAckRequest, type ExposureIntentRequest, type ExposureReceipt,
  type HostAck, type HostPolicy, type HostPort, type InteractionEvent, type JournalCursor, type StageReceipt, type StageTransitionRequest,
} from '@experiment-kit/activity';

type ReceiptRequest = StageTransitionRequest | ExposureIntentRequest;

export class ExampleHost implements HostPort {
  private readonly events = new Map<string, InteractionEvent[]>();
  private readonly receipts = new Map<string, StageReceipt | ExposureReceipt>();
  private counter = 0;
  constructor(private readonly policy: HostPolicy) {}

  private now(): string { return new Date().toISOString(); }
  private base(request: ReceiptRequest) {
    return {
      schemaVersion: '1.0' as const, receiptId: `example-receipt-${++this.counter}`, activityId: request.activityId,
      basedOnActivityRevision: request.basedOnActivityRevision, activityRevision: request.basedOnActivityRevision + 1,
      policyId: this.policy.policyId, policyRevision: request.expectedPolicyRevision, idempotencyKey: request.idempotencyKey,
      template: structuredClone(request.template), model: structuredClone(request.model), issuedAt: this.now(), expiresAt: null,
    };
  }
  private once<T extends StageReceipt | ExposureReceipt>(request: ReceiptRequest, issue: () => T): Promise<T> {
    if (request.expectedPolicyRevision !== this.policy.revision) return Promise.reject(hostRefusal('STALE_POLICY_REVISION'));
    const known = this.receipts.get(request.idempotencyKey);
    if (known) return Promise.resolve(structuredClone(known) as T);
    const receipt = issue();
    this.receipts.set(request.idempotencyKey, receipt);
    return Promise.resolve(structuredClone(receipt));
  }
  private cursor(activityId: string): JournalCursor {
    const events = this.events.get(activityId) ?? [];
    return { activityId, lastSequence: events.at(-1)?.sequence ?? 0, lastEventId: events.at(-1)?.eventId ?? null, checkpointDigest: null };
  }

  getPolicy(): Promise<HostPolicy> { return Promise.resolve(structuredClone(this.policy)); }
  registerActivity(): Promise<HostAck> { return Promise.resolve({ ok: true, hostTimestamp: this.now() }); }
  requestStageTransition(request: StageTransitionRequest): Promise<StageReceipt> {
    return this.once(request, () => ({
      ...this.base(request), contract: CONTRACTS.stageReceipt, fromStage: request.fromStage, toStage: request.toStage,
      grant: request.groups.length ? { exposureId: `example-exposure-${this.counter}`, scope: 'stage', groups: structuredClone(request.groups) } : null,
    }));
  }
  recordExposureIntent(request: ExposureIntentRequest): Promise<ExposureReceipt> {
    return this.once(request, () => ({
      ...this.base(request), contract: CONTRACTS.exposureReceipt, intendedStage: request.intendedStage,
      grant: { exposureId: `example-exposure-${this.counter}`, scope: request.scope, groups: structuredClone(request.groups), ...(request.parameterDomain ? { parameterDomain: structuredClone(request.parameterDomain) } : {}) },
    }));
  }
  recordDisplayAck(_request: DisplayAckRequest): Promise<HostAck> { return Promise.resolve({ ok: true, hostTimestamp: this.now() }); }
  recordAssistance(_request: AssistanceRequest): Promise<AssistanceReceipt> { return Promise.reject(hostRefusal('POLICY_DENIED', 'This example records no assistance.')); }
  appendEvents(request: { activityId: string; events: InteractionEvent[] }): Promise<AppendResult> {
    const stored = this.events.get(request.activityId) ?? [];
    this.events.set(request.activityId, stored);
    const known = new Set(stored.map(event => event.eventId));
    const duplicates: string[] = [], acknowledged: AppendResult['acknowledged'] = [];
    for (const event of request.events) {
      if (known.has(event.eventId)) { duplicates.push(event.eventId); continue; }
      stored.push(structuredClone(event));
      known.add(event.eventId);
      acknowledged.push({ eventId: event.eventId, durableSequence: event.sequence, hostTimestamp: this.now() });
    }
    return Promise.resolve({ acknowledged, duplicates, cursor: this.cursor(request.activityId) });
  }
  getJournalCursor(request: { activityId: string }): Promise<JournalCursor> { return Promise.resolve(this.cursor(request.activityId)); }
  saveArtifact(request: { artifact: ActivityArtifact; operationId: string }): Promise<HostAck & { artifactDigest: string }> {
    return Promise.resolve({ ok: true, hostTimestamp: this.now(), artifactDigest: artifactDigest(request.artifact) });
  }
  /** Journaled event types, in order (for the page's test hooks). */
  eventTypes(activityId: string): string[] { return (this.events.get(activityId) ?? []).map(event => event.type); }
}
