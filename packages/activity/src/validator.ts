/**
 * Record validation: JSON data safety and size limits (no accessors, prototype keys, cycles or oversized payloads,
 * checked before deep traversal), then the authoritative schema. Diagnostics never echo input values: messages are
 * fixed text and paths contain only identifier-shaped keys (other keys are redacted).
 */
import { jsonDataErrors, schemaErrors, type JsonSchema } from '@experiment-kit/core/model';
import type {
  ActivityArtifact, ActivityInstance, ActivityRecords, ActivityRequest, ActivityTemplate, AppendResult, AssistanceReceipt, AssistanceRequest, Diagnostic,
  DisplayAckRequest, ExposureIntentRequest, ExposureReceipt, ExposureRecord, HostAck, HostPolicy, InteractionEvent, InteractionSummary,
  JournalCursor, ModelManifest, PresentationSnapshot, ReviewRecord, ScientificSnapshot, StageReceipt, StageTransitionRequest,
} from './contracts.js';
import { CONTRACTS } from './contracts.js';
import type { CapabilityRecord } from './capabilities.js';
import { EVENT_TYPES, MESSAGES, SCHEMAS, dataLimitsFor, type RecordDataLimits, type SchemaName } from './schemas.js';

/** TypeScript type of each schema; exemplars are declared against this map so types and schemas cannot drift. */
export interface SchemaTypes {
  'study-harness.activity-template': ActivityTemplate;
  'study-harness.activity-instance': ActivityInstance;
  'study-harness.host-policy': HostPolicy;
  'study-harness.scientific-snapshot': ScientificSnapshot;
  'study-harness.presentation-snapshot': PresentationSnapshot;
  'study-harness.interaction-event': InteractionEvent;
  'study-harness.exposure-record': ExposureRecord;
  'study-harness.interaction-summary': InteractionSummary;
  'study-harness.activity-artifact': ActivityArtifact;
  'study-harness.review-record': ReviewRecord;
  'study-harness.exposure-receipt': ExposureReceipt;
  'study-harness.stage-receipt': StageReceipt;
  'study-harness.assistance-receipt': AssistanceReceipt;
  'study-harness.capability-record': CapabilityRecord;
  'study-harness.activity-request': ActivityRequest;
  'study-harness.stage-transition-request': StageTransitionRequest;
  'study-harness.exposure-intent-request': ExposureIntentRequest;
  'study-harness.display-ack-request': DisplayAckRequest;
  'study-harness.assistance-request': AssistanceRequest;
  'study-harness.append-events-request': { activityId: string; events: InteractionEvent[] };
  'study-harness.append-result': AppendResult;
  'study-harness.journal-cursor': JournalCursor;
  'study-harness.register-activity-request': { instance: ActivityInstance; operationId: string };
  'study-harness.save-artifact-request': { artifact: ActivityArtifact; operationId: string };
  'study-harness.activity-lookup-request': { activityId: string };
  'study-harness.host-ack': HostAck & { artifactDigest?: string };
  'study-harness.activity-records': ActivityRecords;
  'experiment-kit.model-manifest': ModelManifest;
}
// Compile-time check that SchemaTypes covers exactly the schema names.
type Exact<A, B> = [A] extends [B] ? [B] extends [A] ? true : never : never;
const _covered: Exact<keyof SchemaTypes, SchemaName> = true;
void _covered;

export interface ValidationResult { ok: boolean; diagnostics: Diagnostic[] }

const MAX_PATH = 160;
/** Keeps a path only up to the first character outside the identifier alphabet; caps its length. */
export function safePath(path: string): string {
  const cut = path.search(/[^$A-Za-z0-9_.:[\]-]/);
  let kept = path;
  if (cut >= 0) {
    const boundary = Math.max(path.lastIndexOf('.', cut), path.lastIndexOf('[', cut));
    kept = `${path.slice(0, Math.max(boundary, 1))}.<redacted-key>`;
  }
  return kept.length > MAX_PATH ? `${kept.slice(0, MAX_PATH)}<truncated>` : kept;
}

const RECOVERY: Partial<Record<string, string>> = {
  RESOURCE_LIMIT: 'Reduce the payload size, nesting or number of entries to the documented limits.',
  SCHEMA: 'Correct the field to match the published schema for this record and version.',
};
const finish = (diagnostics: Diagnostic[]): ValidationResult =>
  ({ ok: diagnostics.length === 0, diagnostics: diagnostics.map(item => ({ code: item.code, path: safePath(item.path), message: item.message, recovery: item.recovery ?? RECOVERY[item.code] ?? RECOVERY.SCHEMA! })) });
const asActivityDiagnostics = (items: { code: string; path: string; message: string; recovery?: string }[]): Diagnostic[] =>
  items.map(item => ({ code: item.code === 'RESOURCE_LIMIT' ? 'RESOURCE_LIMIT' : 'SCHEMA', path: item.path, message: item.message, ...(item.recovery ? { recovery: item.recovery } : {}) }));

const KNOWN_EVENT_TYPES: ReadonlySet<string> = new Set(EVENT_TYPES);
const eventVariant = (root: JsonSchema, value: unknown): JsonSchema | null => {
  const type = value && typeof value === 'object' && !Array.isArray(value) ? (value as { type?: unknown }).type : undefined;
  return typeof type === 'string' && KNOWN_EVENT_TYPES.has(type) ? root.$defs?.[`event.${type}`] ?? null : null;
};
const ONE_OF_MISMATCH = 'Value does not match any supported shape.';

/** Event payload byte bound (same accounting as the record limit), for events alone or inside an append batch. */
function payloadErrors(contract: SchemaName, value: unknown, limits: RecordDataLimits): Diagnostic[] {
  if (limits.maxPayloadBytes === undefined || !value || typeof value !== 'object') return [];
  const record = value as { payload?: unknown; events?: unknown };
  const payloads: [string, unknown][] = contract === CONTRACTS.event ? [['$.payload', record.payload]]
    : Array.isArray(record.events) ? record.events.map((event, index) => [`$.events[${index}].payload`, event && typeof event === 'object' ? (event as { payload?: unknown }).payload : undefined]) : [];
  return payloads.filter(([, payload]) => payload !== undefined).flatMap(([path, payload]) =>
    asActivityDiagnostics(jsonDataErrors(payload, { maxBytes: limits.maxPayloadBytes!, maxDepth: limits.maxDepth, maxNodes: limits.maxNodes }))
      .map(item => ({ ...item, path: path + item.path.slice(1), message: item.message.startsWith('Payload exceeds') ? `Event payload exceeds ${limits.maxPayloadBytes} bytes.` : item.message })));
}

/**
 * Validates one record or host-port message against its schema 1.0. Event variants are discriminated by `type`
 * before validation, which reports precise paths with the same accept/reject decision as the exclusive `oneOf`.
 */
export function validateRecord(contract: SchemaName, value: unknown): ValidationResult {
  const root = Object.hasOwn(SCHEMAS, contract) ? SCHEMAS[contract] : undefined;
  if (!root) return finish([{ code: 'INVALID_INPUT', path: '$', message: 'Unknown contract name.', recovery: 'Use a contract name listed in SCHEMA_NAMES.' }]);
  const limits = dataLimitsFor(contract);
  const data = jsonDataErrors(value, limits);
  if (data.length) return finish(asActivityDiagnostics(data));
  const payload = payloadErrors(contract, value, limits);
  if (payload.length) return finish(payload);
  if (contract === CONTRACTS.event) {
    const variant = eventVariant(root, value);
    if (variant) return finish(asActivityDiagnostics(schemaErrors(value, variant, root)));
  }
  let diagnostics = asActivityDiagnostics(schemaErrors(value, root));
  if (contract === MESSAGES.appendEventsRequest && diagnostics.length) {
    const events = (value as { events?: unknown }).events;
    diagnostics = diagnostics.flatMap(item => {
      const index = /^\$\.events\[(\d+)\]$/.exec(item.path)?.[1];
      const event = index !== undefined && Array.isArray(events) ? events[Number(index)] : undefined;
      const variant = item.message === ONE_OF_MISMATCH ? eventVariant(root, event) : null;
      const precise = variant ? asActivityDiagnostics(schemaErrors(event, variant, root, item.path)) : [];
      return precise.length ? precise : [item];
    });
  }
  return finish(diagnostics);
}

/** Type guard over {@link validateRecord}. */
export function isValidRecord<N extends SchemaName>(contract: N, value: unknown): value is SchemaTypes[N] {
  return validateRecord(contract, value).ok;
}

/** Validates and returns a typed value, or the diagnostics. */
export function parseRecord<N extends SchemaName>(contract: N, value: unknown): { ok: true; value: SchemaTypes[N] } | { ok: false; diagnostics: Diagnostic[] } {
  const result = validateRecord(contract, value);
  return result.ok ? { ok: true, value: value as SchemaTypes[N] } : { ok: false, diagnostics: result.diagnostics };
}

