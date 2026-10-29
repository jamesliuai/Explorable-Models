/**
 * Review authority (report §5.2, D5, D16). Review records and revocations come only from the host that constructs
 * the catalogue; review-like fields inside templates, manifests, artifacts or agent input are never consulted.
 * Approval resolves by exact subject: a model review names modelId + version + scientificRevision, a template review
 * names templateId + version + contentDigest (the template digest). Any change to the reviewed mathematics,
 * interpretation or content therefore leaves the changed entry unreviewed. A hash establishes identity, not truth.
 */
import { validateRecord, type Diagnostic, type ReviewRecord } from '@experiment-kit/activity';
import { canonicalJSON, deepFreeze } from '@experiment-kit/core';
import { S, validateJson } from '@experiment-kit/core/model';

export type ReviewSubject = ReviewRecord['subject'];
export interface ReviewResolution {
  /** True only with at least one approving record for this exact subject and reference suite and no rejection. */
  approved: boolean;
  approving: ReviewRecord[];
  rejecting: ReviewRecord[];
}
export interface ReviewRegistry {
  /** Accepted host-supplied records (detached, frozen copies). */
  readonly records: readonly ReviewRecord[];
  /** Input records that were ignored and can never approve anything, with the reason. */
  readonly ignored: readonly { index: number; diagnostics: Diagnostic[] }[];
  /** Accepted records whose subject equals `subject` exactly, of any outcome. */
  matching(subject: ReviewSubject): ReviewRecord[];
  /**
   * Approval for an exact subject. Approving records must also name the subject's current reference-suite digest
   * (a review of an older suite is stale); a matching rejection blocks approval whatever suite it names.
   */
  resolve(subject: ReviewSubject, referenceSuiteDigest: string | null): ReviewResolution;
}

const sameSubject = (a: ReviewSubject, b: ReviewSubject): boolean =>
  a.kind === 'model' && b.kind === 'model' ? a.modelId === b.modelId && a.version === b.version && a.scientificRevision === b.scientificRevision
    : a.kind === 'template' && b.kind === 'template' ? a.templateId === b.templateId && a.version === b.version && a.contentDigest === b.contentDigest
      : false;

/**
 * Builds the host-trusted review registry. Each record is validated against `study-harness.review-record` 1.0;
 * malformed records, and records that reuse a review ID with different content, are ignored (reported in `ignored`).
 */
export function createReviewRegistry(records: readonly ReviewRecord[]): ReviewRegistry {
  if (!Array.isArray(records)) throw new TypeError('Review records must be an array.');
  const ignored: { index: number; diagnostics: Diagnostic[] }[] = [];
  const byId = new Map<string, { index: number; record: ReviewRecord; text: string }>();
  const conflicting = new Set<string>();
  records.forEach((input, index) => {
    const result = validateRecord('study-harness.review-record', input);
    if (!result.ok) { ignored.push({ index, diagnostics: result.diagnostics }); return; }
    const record = structuredClone(input);
    const text = canonicalJSON(record);
    const previous = byId.get(record.reviewId);
    if (previous && previous.text !== text) conflicting.add(record.reviewId);
    if (!previous) byId.set(record.reviewId, { index, record, text });
  });
  for (const id of conflicting) {
    ignored.push({ index: byId.get(id)!.index, diagnostics: [{ code: 'CONFLICT', path: '$.reviewId', message: 'Two different review records share one review ID.', recovery: 'Give each review record a distinct ID.' }] });
    byId.delete(id);
  }
  const accepted = deepFreeze([...byId.values()].map(entry => entry.record));
  const matching = (subject: ReviewSubject): ReviewRecord[] => accepted.filter(record => sameSubject(record.subject, subject));
  return Object.freeze({
    records: accepted,
    ignored: deepFreeze(ignored),
    matching,
    resolve(subject: ReviewSubject, referenceSuiteDigest: string | null): ReviewResolution {
      const candidates = matching(subject);
      const rejecting = candidates.filter(record => record.outcome === 'rejected');
      const approving = referenceSuiteDigest === null ? [] : candidates.filter(record => record.outcome !== 'rejected' && record.referenceSuiteDigest === referenceSuiteDigest);
      return { approved: approving.length > 0 && rejecting.length === 0, approving, rejecting };
    },
  });
}

/** A host-issued mark on one exact catalogue version (all digests of that ID and version). */
export interface CatalogMark { kind: 'template' | 'model'; id: string; version: string; reason: string }
export type RevocationEntry = CatalogMark;
export type DeprecationEntry = CatalogMark;
export interface MarkList {
  readonly entries: readonly CatalogMark[];
  lookup(kind: CatalogMark['kind'], id: string, version: string): CatalogMark | null;
}
export type RevocationList = MarkList;

const MARK_SCHEMA = S.object({ kind: S.oneOfValues(['template', 'model']), id: S.id(), version: S.version(), reason: S.text(2000) });

/**
 * Validated list of host marks. Unlike review records, a malformed entry is an error rather than ignored: silently
 * dropping a revocation would reactivate revoked content.
 */
export function createMarkList(entries: readonly CatalogMark[], what = 'revocation'): MarkList {
  if (!Array.isArray(entries)) throw new TypeError(`The ${what} list must be an array.`);
  const problems = entries.flatMap((entry, index) => validateJson(entry, MARK_SCHEMA).map(item => `[${index}]${item.path.slice(1)}: ${item.message}`));
  if (problems.length) throw new RangeError(`Invalid ${what} entries: ${problems.slice(0, 8).join('; ')}`);
  const frozen = deepFreeze(entries.map(entry => structuredClone(entry)));
  const index = new Map(frozen.map(entry => [`${entry.kind}\u0000${entry.id}\u0000${entry.version}`, entry]));
  return Object.freeze({ entries: frozen, lookup: (kind: CatalogMark['kind'], id: string, version: string) => index.get(`${kind}\u0000${id}\u0000${version}`) ?? null });
}

/** Host revocation list: revoked IDs/versions stay revoked for every digest, including modified copies. */
export const createRevocationList = (entries: readonly RevocationEntry[]): RevocationList => createMarkList(entries, 'revocation');
