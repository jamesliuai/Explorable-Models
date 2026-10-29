// HostPort over the reference host's narrow native commands, plus the host-owned operations the host chrome uses.
// Nothing here decides authority: the Rust host validates every request again, owns policy revisions, receipts,
// idempotency keys and the journal, and refuses anything its embedded approval does not cover.
//
// HostPort refusal convention (`@experiment-kit/activity`, `isHostRefusal`): a HostPort method rejects with one of
// `HOST_REFUSAL_CODES` when the host decided against the request (the adapter reports it and does not retry); any other
// rejection is a retryable persistence failure. The Rust HostPort commands already report their decisions that way
// (`src-tauri/src/errors.rs`: the specific host code travels as `reason`) and keep storage failures distinct
// (`PERSISTENCE_FAILED`, `INTEGRITY_FAILURE`). The only decision taken outside Rust is the IPC layer's ACL rejection of
// an ungranted command, which this port reports as `POLICY_DENIED`; transport failures stay retryable.
import type {
  ActivityArtifact, ActivityInstance, ActivityRecords, AppendResult, AssistanceReceipt, AssistanceRequest, AssistanceSnapshot, DisplayAckRequest, ExposureIntentRequest,
  ExposureReceipt, HostAck, HostPolicy, HostPort, InteractionEvent, JournalCursor, ResponseRef, StageReceipt, StageTransitionRequest,
} from '@experiment-kit/activity';
import { call, NativeHostError } from './native-bridge';

/** Calls a HostPort command: a rejection is a host refusal under its convention code or a retryable failure. */
async function port<T>(command: string, request: unknown): Promise<T> {
  try {
    return await call<T>(command, request);
  } catch (error) {
    if (error instanceof NativeHostError && error.code === 'IPC_DENIED') throw new NativeHostError('POLICY_DENIED', 'The host does not grant this command.', 'IPC_DENIED');
    throw error;
  }
}

/**
 * The adapter's host port: one raw-body native command per method, including the optional `getActivityRecords`: the
 * host's durable exposure and assistance records (merged conservatively) and its own activity state, which a restore
 * and `reconcile` adopt — stage, activity revision, closed, context lineage and the receipt that moved the activity to
 * its stage (`ActivityRecords.activity`; the Rust host derives them from its activity row and the receipts it issued,
 * never from a registered instance or an artifact). A restore reads `getJournalCursor`, then `getActivityRecords`, and
 * registers only then; both reads are refused for an activity the host does not hold.
 */
export class NativeHostPort implements HostPort {
  getPolicy(request: { activityId: string }): Promise<HostPolicy> { return port('get_policy', request); }
  registerActivity(request: { instance: ActivityInstance; operationId: string }): Promise<HostAck> { return port('register_activity', request); }
  requestStageTransition(request: StageTransitionRequest): Promise<StageReceipt> { return port('request_stage_transition', request); }
  recordExposureIntent(request: ExposureIntentRequest): Promise<ExposureReceipt> { return port('record_exposure_intent', request); }
  recordDisplayAck(request: DisplayAckRequest): Promise<HostAck> { return port('record_display_ack', request); }
  recordAssistance(request: AssistanceRequest): Promise<AssistanceReceipt> { return port('record_assistance', request); }
  appendEvents(request: { activityId: string; events: InteractionEvent[] }): Promise<AppendResult> { return port('append_events', request); }
  getJournalCursor(request: { activityId: string }): Promise<JournalCursor> { return port('get_journal_cursor', request); }
  saveArtifact(request: { artifact: ActivityArtifact; operationId: string }): Promise<HostAck & { artifactDigest: string }> { return port('save_artifact', request); }
  getActivityRecords(request: { activityId: string }): Promise<ActivityRecords> { return port('get_activity_records', request); }
}

/** The frozen assistance/exposure snapshot of a submitted independent-task answer as the host stores it (A26). */
export interface StoredResponseSnapshot {
  responseId: string;
  activityId: string;
  status: 'pending' | 'submitted';
  frozenAt: string;
  snapshotDigest: string;
  snapshot: {
    format: string;
    responseId: string;
    activityId: string;
    kind: string;
    taskId: string;
    taskRef: string | null;
    frozenAt: string;
    /** The adapter's `freezeAssistanceSnapshot` result as submitted (`complete`/`limitations` say whether its local record may be partial). */
    adapter: { responseId: string; cursor: number; exposures: unknown[]; assistance: { receiptId: string; kind: string; sequence: number; grant?: { exposureId: string; groups: string[] } | null }[]; complete?: boolean; limitations?: string[] };
    host: {
      policyRevision: number;
      independentTaskActive: boolean;
      journalLastSequence: number;
      exposures: { exposureId: string; scope: string; displayStatus: string; groups: string[] }[];
      assistance: { receiptId: string; kind: string; actor: string; recordedAt: string }[];
      origin: { activityId: string; exposures: { exposureId: string; scope: string; displayStatus: string; groups: string[] }[] } | null;
    };
  };
}

export interface OpenedActivity {
  activityId: string;
  hostSessionId: string;
  hostSessionRevision: number;
  objectiveIds: string[];
  template: { templateId: string; version: string };
}
export interface IndependentTask extends OpenedActivity { taskRef: string; policy: HostPolicy }
export interface HostActivitySummary {
  activityId: string;
  templateId: string;
  templateVersion: string;
  kind: 'instructional' | 'independent-task';
  taskRef: string | null;
  originActivityId: string | null;
  stage: string;
  closed: boolean;
  activityRevision: number;
  hostSessionRevision: number;
  hasBackup: boolean;
  /** How the close resolved a pending preview (`activity.closed` payload), null when none was active or not closed. */
  closedPending: 'cancel' | 'commit' | 'retain' | null;
  createdAt: string;
  updatedAt: string;
  events: number;
  exposures: { displayed: number; uncertain: number; authorized: number };
  responses: number;
  /**
   * The activity's latest receipt when it is a reveal the host committed and no display acknowledgement followed (a
   * process that ended after the host's commit and before the reply reached the card), else null. The host re-issues
   * that request under this idempotency key to resume it: the host replays its committed receipt (one reveal record).
   */
  unacknowledgedReveal: { idempotencyKey: string; receiptId: string; exposureId: string; groups: string[]; intendedStage: string; activityRevision: number; policyRevision: number } | null;
}
export interface StoredArtifact { artifactId: string; artifactDigest: string; savedAt: string; artifact: ActivityArtifact }
export interface HostStatus {
  starts: number;
  recoveries: { activityId: string; exposureId: string; from: string; to: string; hostStart: number; at: string }[];
  approved: { templateId: string; version: string; title: string; lifecycle: string; dimension: string }[];
  database: { journalMode: string; synchronous: number; foreignKeys: boolean; schemaVersion: number };
  exportsFolder: string | null;
  importsFolder: string | null;
}
export interface ExportedBackup { backupId: string; fileName: string; sha256: string; bytes: number; activities: number; events: number; exportedAt: string }
export interface ImportableBackup { backupSha256: string; bytes: number; valid: boolean; exportedAt?: string; activities?: number; code?: string; importedAt: string | null }
export interface ImportSummary { backupSha256: string; importedAt: string; activityIds: string[]; inserted: Record<string, number>; alreadyPresent: Record<string, number>; alreadyImported: boolean }

/** Host-owned lifecycle operations of the reference host (not part of HostPort). */
export const hostCommands = {
  status: (): Promise<HostStatus> => call('host_status', {}),
  open: (templateId: string, version: string): Promise<OpenedActivity> => call('open_activity', { templateId, version }),
  list: (): Promise<{ activities: HostActivitySummary[] }> => call('list_activity', {}),
  loadLatestArtifact: (activityId: string): Promise<StoredArtifact> => call('load_latest_artifact', { activityId }),
  deleteActivity: (activityId: string): Promise<{ activityId: string; deleted: Record<string, number> }> => call('delete_activity', { activityId }),
  authorizeReveal: (activityId: string, groups: string[]): Promise<HostPolicy> => call('authorize_reveal', { activityId, groups }),
  startIndependentTask: (activityId: string): Promise<IndependentTask> => call('start_independent_task', { activityId }),
  reopenInstructional: (activityId: string): Promise<HostPolicy> => call('reopen_instructional', { activityId }),
  recordResponse: (input: { activityId: string; kind: ResponseRef['kind']; stageId: string; taskId: string; text: string }): Promise<{ ref: Omit<ResponseRef, 'status'>; expectedHostSessionRevision: number }> =>
    call('record_response', input),
  /**
   * The host's response transaction: marks the response submitted and returns the host session revision THIS transaction
   * produced (the adapter adopts exactly that value; it never computes one). An independent-task answer carries the
   * adapter's frozen snapshot (`freezeAssistanceSnapshot`, including `complete` and `limitations`).
   */
  confirmResponse: (activityId: string, responseId: string, assistanceSnapshot?: AssistanceSnapshot): Promise<{ hostSessionRevision: number; responseId: string }> =>
    call('confirm_response', assistanceSnapshot === undefined ? { activityId, responseId } : { activityId, responseId, assistanceSnapshot }),
  responseSnapshot: (activityId: string, responseId: string): Promise<StoredResponseSnapshot> => call('get_response_snapshot', { activityId, responseId }),
  exportBackup: (): Promise<ExportedBackup> => call('export_backup', {}),
  listImportableBackups: (): Promise<{ backups: ImportableBackup[] }> => call('list_importable_backups', {}),
  importBackup: (backupSha256: string): Promise<ImportSummary> => call('import_backup', { backupSha256 }),
};
