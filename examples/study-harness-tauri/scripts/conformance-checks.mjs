// Pure predicates for packaged conformance observations. A missing host action is a broken archival fallback,
// even when the record exposes no scientific controls (report §14, §17).
import { isDeepStrictEqual } from 'node:util';

export function validArchivalRecord(detail) {
  return !!detail && detail.archivalElement === true && detail.surfaceMounted === false
    && detail.controls === 1 && isDeepStrictEqual(detail.controlLabels, ['button:Return to the session'])
    && detail.cardState === 'archival' && detail.archival?.codes?.includes('CONTENT_REVOKED') === true
    && detail.recordsKept === true;
}
