// Shape of the single report the frontend sends to the narrow `spike_report` command.
// The Rust side (src-tauri/src/report.rs) mirrors this with deny_unknown_fields and
// re-validates every bound; keep the two in sync.

export const REPORT_SCHEMA = 'study-harness.native-spike.frontend/1' as const;

export const PROBE_IDS = [
  'environment',
  'csp-effective',
  'eval-negative',
  'inline-style-attr-negative',
  'module-worker',
  'worker-dynamic-import',
  'worker-csp',
  'blob-worker-negative',
  'web-crypto-main',
  'web-crypto-worker',
  'local-data-fetch',
  'local-font',
  'katex-dom',
  'katex-string-innerhtml',
  'katex-fonts',
  'svg-render',
  'png-capture-svg',
  'png-capture-svg-embedded-font',
  'png-capture-foreignobject-html',
  'png-capture-foreignobject-katex',
  'png-capture-katex-canvas',
  'png-data-url-negative',
  'offscreen-canvas-worker',
  'webgl',
  'animation-frame',
  'remote-connect-negative',
  'resource-origins',
  'command-forbidden-rejected',
  'plugin-command-rejected',
  'report-validation-rejects-unknown-key',
  'report-validation-rejects-oversized',
] as const;

export type ProbeId = (typeof PROBE_IDS)[number];

/**
 * pass: required capability works.
 * fail: required capability does not work.
 * info: report-only observation (for example optional WebGL).
 * expected-block: a negative test was blocked as the policy intends.
 * unexpected-allow: a negative test was NOT blocked (policy not enforced).
 */
export type ProbeStatus = 'pass' | 'fail' | 'info' | 'expected-block' | 'unexpected-allow';

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

export interface ProbeResult {
  id: ProbeId;
  status: ProbeStatus;
  summary: string;
  durationMs: number;
  details: { [key: string]: JsonValue };
}

export interface ViolationRecord {
  violatedDirective: string;
  effectiveDirective: string;
  blockedURI: string;
  sourceFile: string;
  sample: string;
  disposition: string;
  originalPolicy: string;
  atMs: number;
}

export interface CspObservation {
  /** Content-Security-Policy response header of index.html, read by a same-origin fetch. */
  header: string | null;
  /** <meta http-equiv> policy if the host injected one (Tauri does this on Linux). */
  meta: string | null;
  /** Distinct `originalPolicy` strings reported by securitypolicyviolation events. */
  violationPolicies: string[];
}

/** Bounded PNG artifact (base64) from a capture probe; the launcher re-hashes the decoded bytes. */
export interface CaptureArtifact {
  probeId: ProbeId;
  mimeType: 'image/png';
  width: number;
  height: number;
  sha256: string;
  base64: string;
}

export interface SpikeResults {
  schema: typeof REPORT_SCHEMA;
  runId: string;
  userAgent: string;
  origin: string;
  href: string;
  isSecureContext: boolean;
  startedAt: string;
  durationMs: number;
  probes: ProbeResult[];
  csp: CspObservation;
  violations: ViolationRecord[];
  requestLog: string[];
  resourceOrigins: string[];
  captures: CaptureArtifact[];
}

export interface ReportAck {
  accepted: boolean;
  bytes: number;
  wroteAppData: boolean;
  wroteSpikeOut: boolean;
}
