/**
 * Exposure ledger (activity-runtime §4, report §6.3, D7). Records what the host authorized and what a surface
 * acknowledged displaying. Transitions only move toward "potentially seen": authorized → displayed, authorized →
 * uncertain, uncertain → displayed. A displayed record never reverts; undo, reset, cancellation, context changes and
 * restore never delete a record (A19). Each record belongs to a lineage (the context epoch it was granted in);
 * reveal grants count for visibility only within their lineage, so entering an independent context ends them.
 */
import { deepFreeze } from '@explorable-models/core';
import type { ModelRef } from '@explorable-models/core/model';
import type { DisplayEndReason, ExposureGrant, ExposureRecord, TemplateRef } from './contracts.js';
import { ACTIVITY_SCHEMA_VERSION, CONTRACTS } from './contracts.js';

export interface ExposureLedger {
  /** Current lineage number (starts at 0). */
  readonly lineage: number;
  /**
   * Records a host-authorized grant from a verified receipt; idempotent for a repeated exposure and receipt ID. With
   * `history`, the grant is recorded outside every lineage, so it never counts for visibility: a receipt the host
   * committed that the adapter could no longer apply (the context changed while the host answered, or it expired), which
   * stays part of the exposure history (report §6.3). A history entry never changes an existing record's lineage.
   */
  authorize(input: { activityId: string; receiptId: string; grant: ExposureGrant; intendedStage: string; activityRevision: number; template: TemplateRef; model: ModelRef }, options?: { history?: boolean }): ExposureRecord;
  /** The receipt ID that holds `exposureId` in the ledger, or null (receipt verification refuses a grant reusing it). */
  receiptOf(exposureId: string): string | null;
  get(exposureId: string): ExposureRecord | null;
  /** Every record, oldest first (frozen copies). */
  all(): ExposureRecord[];
  /**
   * Every record as an artifact stores it (activity-runtime §4 step 5, §9). A displayed record whose acknowledgement the
   * host has not confirmed yet (still in flight, or failed) is written with `ACK_NOT_PERSISTED`: the artifact must not
   * claim the host holds an acknowledgement it may never have committed, so a restore resends that acknowledgement.
   */
  forArtifact(): ExposureRecord[];
  /** Records of the current lineage; these are the grants that can count for visibility. */
  current(): ExposureRecord[];
  /** Records of the current lineage still waiting for a display acknowledgement (authorized, or uncertain before an acknowledgement). */
  awaitingDisplay(): ExposureRecord[];
  /** Records displayed locally whose acknowledgement the host has not yet persisted. */
  unpersistedAcks(): ExposureRecord[];
  markDisplayed(exposureId: string, displayed: NonNullable<ExposureRecord['displayed']>): ExposureRecord | null;
  markUncertain(exposureId: string, uncertainty: NonNullable<ExposureRecord['uncertainty']>): ExposureRecord | null;
  /** The host persisted the acknowledgement: the record stays displayed and loses its ACK_NOT_PERSISTED uncertainty. */
  ackPersisted(exposureId: string): ExposureRecord | null;
  /**
   * The host refused to record the acknowledgement (a host decision, activity-runtime §10): the record stays displayed,
   * is no longer offered for persistence and carries no ACK_NOT_PERSISTED uncertainty, since the outcome is definite.
   */
  ackRefused(exposureId: string): ExposureRecord | null;
  /** Starts a new lineage (independent context entered, instructional context reopened). Records are kept. */
  advanceLineage(): void;
  /** IDs of records outside the current lineage (they never count for visibility; a backup lists them in `lineage`). */
  ended(): string[];
  /**
   * Sets (or, with null, clears) the end of a displayed record's observed display interval (report §5.1). Only a
   * displayed record has an interval; the start (`displayed.monotonicMs`) never changes.
   */
  endDisplay(exposureId: string, end: { endedMonotonicMs: number; endedBy: DisplayEndReason } | null): ExposureRecord | null;
  /**
   * Merges the host's durable records (`HostPort.getActivityRecords`) conservatively after a restore (report §6.3:
   * restoring an earlier checkpoint cannot erase exposure history). A record the ledger lacks is added outside the
   * current lineage, so it never makes content visible; an `authorized` one becomes `uncertain`
   * (`INTERRUPTED_BEFORE_ACK`). A record the host holds as displayed upgrades a local record that is not displayed to
   * displayed with the host's acknowledgement (persisted, so nothing is resent). Nothing ever moves back toward "unseen".
   */
  mergeHost(records: readonly ExposureRecord[]): { added: string[]; updated: string[]; mismatched: string[] };
  /**
   * Restores records conservatively (activity-runtime §4 step 6): an authorized record without a persisted
   * acknowledgement becomes uncertain (INTERRUPTED_BEFORE_ACK); a displayed record stored with `ACK_NOT_PERSISTED`
   * stays displayed and is offered again by `unpersistedAcks` (the same acknowledgement is resent). `counts` decides which
   * restored records join the current lineage.
   */
  restore(records: readonly ExposureRecord[], counts: (record: ExposureRecord) => boolean): { changed: string[] };
}

interface Entry { record: ExposureRecord; lineage: number; ackPersisted: boolean; ackRefused?: boolean }

const UNCONFIRMED_ACK = 'The display was acknowledged locally but the host had not confirmed the acknowledgement when this was saved; it is resent after a restore.';
const HOST_RECORD_REASON = 'The host holds this authorization without a persisted display acknowledgement; treat the content as potentially seen.';

export function createExposureLedger(): ExposureLedger {
  const entries = new Map<string, Entry>();
  let lineage = 0;
  const freeze = (record: ExposureRecord) => deepFreeze(structuredClone(record));
  const set = (entry: Entry, record: ExposureRecord): ExposureRecord => { entry.record = freeze(record); return entry.record; };
  return {
    get lineage() { return lineage; },
    authorize(input, options = {}) {
      const existing = entries.get(input.grant.exposureId);
      if (existing) {
        if (existing.record.receiptId !== input.receiptId) throw new RangeError('The host reused an exposure ID for a different receipt.');
        // The host replayed this grant's receipt for the current request (idempotent retry after a restart): the record,
        // kept from the host's records or an artifact, now counts in the current lineage. Its status is unchanged.
        if (!options.history) existing.lineage = lineage;
        return existing.record;
      }
      const record: ExposureRecord = {
        contract: CONTRACTS.exposure, schemaVersion: ACTIVITY_SCHEMA_VERSION, exposureId: input.grant.exposureId, activityId: input.activityId,
        receiptId: input.receiptId, scope: input.grant.scope, groups: input.grant.groups.map(group => ({ ...group })), template: { ...input.template },
        model: { ...input.model }, activityRevision: input.activityRevision, intendedStage: input.intendedStage,
        ...(input.grant.parameterDomain ? { parameterDomain: structuredClone(input.grant.parameterDomain) } : {}), displayStatus: 'authorized',
      };
      const entry: Entry = { record: freeze(record), lineage: options.history ? -1 : lineage, ackPersisted: false };
      entries.set(record.exposureId, entry);
      return entry.record;
    },
    receiptOf: exposureId => entries.get(exposureId)?.record.receiptId ?? null,
    get: exposureId => entries.get(exposureId)?.record ?? null,
    all: () => [...entries.values()].map(entry => entry.record),
    forArtifact: () => [...entries.values()].map(entry => {
      const record = structuredClone(entry.record) as ExposureRecord;
      if (record.displayStatus !== 'displayed' || entry.ackPersisted || entry.ackRefused || record.uncertainty) return record;
      return { ...record, uncertainty: { code: 'ACK_NOT_PERSISTED', reason: UNCONFIRMED_ACK } };
    }),
    current: () => [...entries.values()].filter(entry => entry.lineage === lineage).map(entry => entry.record),
    awaitingDisplay: () => [...entries.values()].filter(entry => entry.lineage === lineage && (entry.record.displayStatus === 'authorized'
      || entry.record.displayStatus === 'uncertain' && entry.record.uncertainty?.code !== 'ACK_NOT_PERSISTED')).map(entry => entry.record),
    unpersistedAcks: () => [...entries.values()].filter(entry => entry.record.displayStatus === 'displayed' && !entry.ackPersisted && !entry.ackRefused).map(entry => entry.record),
    markDisplayed(exposureId, displayed) {
      const entry = entries.get(exposureId);
      if (!entry || entry.record.displayStatus === 'displayed') return null;
      const { uncertainty: _previous, ...rest } = entry.record;
      return set(entry, { ...rest, displayStatus: 'displayed', displayed: { ...displayed } });
    },
    markUncertain(exposureId, uncertainty) {
      const entry = entries.get(exposureId);
      if (!entry) return null;
      // A displayed record stays displayed: only its acknowledgement can be uncertain.
      if (entry.record.displayStatus === 'displayed' && uncertainty.code !== 'ACK_NOT_PERSISTED') return null;
      const status = entry.record.displayStatus === 'displayed' ? 'displayed' : 'uncertain';
      return set(entry, { ...entry.record, displayStatus: status, uncertainty: { ...uncertainty } });
    },
    ackPersisted(exposureId) {
      const entry = entries.get(exposureId);
      if (!entry || entry.record.displayStatus !== 'displayed') return null;
      entry.ackPersisted = true;
      if (entry.record.uncertainty?.code !== 'ACK_NOT_PERSISTED') return entry.record;
      const { uncertainty: _cleared, ...rest } = entry.record;
      return set(entry, rest);
    },
    ackRefused(exposureId) {
      const entry = entries.get(exposureId);
      if (!entry || entry.record.displayStatus !== 'displayed' || entry.ackPersisted) return null;
      entry.ackRefused = true;
      if (entry.record.uncertainty?.code !== 'ACK_NOT_PERSISTED') return entry.record;
      const { uncertainty: _cleared, ...rest } = entry.record;
      return set(entry, rest);
    },
    advanceLineage() { lineage++; },
    ended: () => [...entries.values()].filter(entry => entry.lineage !== lineage).map(entry => entry.record.exposureId),
    endDisplay(exposureId, end) {
      const entry = entries.get(exposureId);
      if (!entry || entry.record.displayStatus !== 'displayed' || !entry.record.displayed) return null;
      const { endedMonotonicMs: _ended, endedBy: _by, ...start } = entry.record.displayed;
      return set(entry, { ...entry.record, displayed: end ? { ...start, endedMonotonicMs: end.endedMonotonicMs, endedBy: end.endedBy } : start });
    },
    mergeHost(records) {
      const added: string[] = [], updated: string[] = [], mismatched: string[] = [];
      for (const input of records) {
        const entry = entries.get(input.exposureId);
        if (!entry) {
          let record = structuredClone(input) as ExposureRecord;
          if (record.displayStatus === 'authorized') record = { ...record, displayStatus: 'uncertain', uncertainty: { code: 'INTERRUPTED_BEFORE_ACK', reason: HOST_RECORD_REASON } };
          entries.set(record.exposureId, { record: freeze(record), lineage: -1, ackPersisted: record.displayStatus === 'displayed' });
          added.push(record.exposureId);
          continue;
        }
        // A host row for another receipt under the same exposure ID is not merged; the local record stays as it is.
        if (entry.record.receiptId !== input.receiptId) { mismatched.push(input.exposureId); continue; }
        if (input.displayStatus !== 'displayed' || !input.displayed) continue;
        if (entry.record.displayStatus !== 'displayed') {
          const { uncertainty: _previous, ...rest } = entry.record;
          set(entry, { ...rest, displayStatus: 'displayed', displayed: { projectionDigest: input.displayed.projectionDigest, frameId: input.displayed.frameId, monotonicMs: input.displayed.monotonicMs } });
          entry.ackPersisted = true;
          updated.push(input.exposureId);
        }
        // A local display whose acknowledgement the artifact marks unconfirmed is left as it is: the identical
        // acknowledgement is resent and the host replays it (activity-runtime §4 step 6).
      }
      return { added, updated, mismatched };
    },
    restore(records, counts) {
      const changed: string[] = [];
      for (const input of records) {
        if (entries.has(input.exposureId)) continue;
        let record = structuredClone(input);
        if (record.displayStatus === 'authorized') {
          record = { ...record, displayStatus: 'uncertain', uncertainty: { code: 'INTERRUPTED_BEFORE_ACK', reason: 'The activity was interrupted after authorization and before a display acknowledgement was persisted; treat the content as potentially seen.' } };
          changed.push(record.exposureId);
        }
        // A restored displayed record's acknowledgement is persisted unless the artifact recorded otherwise.
        const ackPersisted = record.displayStatus === 'displayed' && record.uncertainty?.code !== 'ACK_NOT_PERSISTED';
        entries.set(record.exposureId, { record: freeze(record), lineage: counts(record) ? lineage : -1, ackPersisted });
      }
      return { changed };
    },
  };
}
