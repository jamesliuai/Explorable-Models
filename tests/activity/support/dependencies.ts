/**
 * TEST-ONLY host-side dependency check by stable reference (report §7.2, A18). A derived record — an interaction
 * summary or an activity artifact — lists the response references it was generated from, with their status, task
 * revision and supersession at that time, plus its journal cursor. The host marks it stale when any of those references
 * now differs or no longer exists; it never edits the derived record or deletes the causal journal events. This models
 * the host's deletion/correction policy for tests; it is not part of a package.
 */
import type { ActivityArtifact, InteractionSummary, ResponseRef } from '../../../packages/activity/src/contracts.js';

export interface StaleReference { responseId: string; recorded: Pick<ResponseRef, 'status' | 'taskRevision'> & { supersededBy?: string }; current: Pick<ResponseRef, 'status' | 'taskRevision'> & { supersededBy?: string } | 'missing' }

const shape = (ref: ResponseRef) => ({ status: ref.status, taskRevision: ref.taskRevision, ...(ref.supersededBy ? { supersededBy: ref.supersededBy } : {}) });

/** Response references of `derived` whose current host record differs (status, task revision, supersession) or is gone. */
export function staleReferences(derived: InteractionSummary | ActivityArtifact, current: readonly ResponseRef[]): StaleReference[] {
  const recorded = 'responses' in derived ? derived.responses : derived.instance.responses;
  const out: StaleReference[] = [];
  for (const ref of recorded) {
    const now = current.find(item => item.responseId === ref.responseId);
    const before = shape(ref);
    if (!now) { out.push({ responseId: ref.responseId, recorded: before, current: 'missing' }); continue; }
    const after = shape(now);
    if (JSON.stringify(before) !== JSON.stringify(after)) out.push({ responseId: ref.responseId, recorded: before, current: after });
  }
  return out;
}
