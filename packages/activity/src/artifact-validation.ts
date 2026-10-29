/** Shared artifact constraints apply equally when building and reading an artifact. */
import type { ActivityArtifact, Diagnostic, DiagnosticCode } from './contracts.js';

export const diagnostic = (code: DiagnosticCode, path: string, message: string, recovery?: string): Diagnostic => ({ code, path, message, ...(recovery ? { recovery } : {}) });

/** A learner snapshot must not carry host-only records, whoever produced it. */
export function snapshotProblems(artifact: ActivityArtifact): Diagnostic[] {
  if (artifact.kind !== 'learner-snapshot') return [];
  const out: Diagnostic[] = [];
  const message = 'A learner snapshot cannot carry host-only records.';
  if (artifact.exposures.length) out.push(diagnostic('INVALID_INPUT', '$.exposures', message));
  if (artifact.reviewRefs.length) out.push(diagnostic('INVALID_INPUT', '$.reviewRefs', message));
  if (artifact.instance.responses.length) out.push(diagnostic('INVALID_INPUT', '$.instance.responses', message));
  if (artifact.journal.pendingEventIds.length) out.push(diagnostic('INVALID_INPUT', '$.journal.pendingEventIds', message));
  if (artifact.assistance !== undefined) out.push(diagnostic('INVALID_INPUT', '$.assistance', message));
  if (artifact.lineage !== undefined) out.push(diagnostic('INVALID_INPUT', '$.lineage', message));
  if (artifact.journal.pendingEvents !== undefined) out.push(diagnostic('INVALID_INPUT', '$.journal.pendingEvents', message));
  if (artifact.journal.lost !== undefined) out.push(diagnostic('INVALID_INPUT', '$.journal.lost', message));
  return out;
}
