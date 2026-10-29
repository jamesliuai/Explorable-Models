/**
 * `createStudyHarnessAdapter` (report §5.3, activity-runtime §1): the six report operations plus preparation,
 * restore and isolated sampling. The host constructs the adapter with its HostPort and an injected catalogue; every
 * privileged decision derives from that construction context. One shared worker budget serves every activity's
 * model session, so many cards never allocate unbounded workers. The adapter never imports the catalogue package and
 * never substitutes a template or model: references resolve exactly or fail.
 */
import { canonicalJSON, sha256 } from '@experiment-kit/core';
import {
  assembleFrame, checkParameters, createWorkerBudget, initialPosition, isModelError, validateManifest,
  type ModelIdentity, type ModelManifest, type ModelRef, type WorkerBudget,
} from '@experiment-kit/core/model';
import type { AdapterDiagnostics, AdapterOptions, CapabilityReport, CommandFailure, DiagnosticExport, PreparedActivity, RestoreResult, StudyHarnessAdapter, ValidationReport } from './api.js';
import type { ActivityInstance, ActivityRequest, ActivityTemplate, CatalogEntryStatus, Diagnostic, DiagnosticCode, HostPolicy, TemplateRef } from './contracts.js';
import { ACTIVITY_SCHEMA_VERSION, CONTRACTS, isHostRefusal } from './contracts.js';
import { INSTALLED_CAPABILITIES } from './capabilities.js';
import { createActivityController, MODEL_RUNTIME, type ActivityController } from './controller.js';
import { withHostRecovery } from './describe.js';
import { fromModelDiagnostics, hostRefusalDiagnostic } from './diagnostics.js';
import { templateDiscovery } from './discovery.js';
import { artifactDigest, templateRef as refOf } from './identity.js';
import { createHostClock, modeDiagnostic, policyDiagnostics, policyStanding, revocationDiagnostic, reviewNotice } from './policy.js';
import { TABLE_ROW_LIMIT } from './projection.js';
import { MESSAGES, SCHEMA_VERSIONS } from './schemas.js';
import { validateTemplateSemantics } from './semantic.js';
import { DEFAULT_PERSISTENCE_WAIT_MS } from './journal.js';
import { parseRecord } from './validator.js';

/** Version of this adapter implementation, reported by `getCapabilities`. */
export const ADAPTER_VERSION = '0.3.0-preview.1';
/** Adapter-wide resource ceilings (report §18); a request whose model declares more is refused before activation. */
export const ADAPTER_LIMITS = Object.freeze({ maxWorkers: 64, defaultWorkers: 4, outbox: 256, geometryElements: 1_000_000, operations: 10_000_000, tableRows: TABLE_ROW_LIMIT });
const ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const OPERATION_CACHE = 64;
/** Failures that a retry with the same operation ID may resolve. */
const TRANSIENT: ReadonlySet<string> = new Set(['PERSISTENCE_FAILED', 'PERSISTENCE_PENDING', 'WORKER_ERROR', 'WORKER_TIMEOUT', 'RESOURCE_LIMIT', 'NOT_READY', 'CANCELLED', 'CONFLICT']);

const diag = (code: DiagnosticCode, path: string, message: string, recovery?: string): Diagnostic => ({ code, path, message, ...(recovery ? { recovery } : {}) });
/** A failure; every diagnostic without a recovery of its own gets the host-facing default (report §5.3, `HOST_RECOVERY`). */
const failure = (...diagnostics: Diagnostic[]): CommandFailure => ({ ok: false, diagnostics: withHostRecovery(diagnostics) });
/** Recovery for a verified artifact that cannot be reopened: the archival view of the same bytes; nothing is substituted. */
const ARCHIVAL_RECOVERY = 'Show the artifact read-only with archivalView(artifact, { audience }) (nothing is evaluated or substituted), or install the exact saved template and model version.';
const DISPOSED = () => failure(diag('DISPOSED', '$', 'The adapter has been disposed.', 'Create a new adapter.'));

interface Resolved { template: ActivityTemplate; manifest: ModelManifest; identity: ModelIdentity; templateRef: TemplateRef; modelRef: ModelRef }

export function createStudyHarnessAdapter(options: AdapterOptions): StudyHarnessAdapter {
  const { catalog, host } = options;
  if (!catalog || typeof catalog.getTemplate !== 'function' || typeof catalog.createWorker !== 'function') throw new TypeError('An activity catalogue is required.');
  if (!host || typeof host.getPolicy !== 'function') throw new TypeError('A host port is required.');
  const maxWorkers = options.maxWorkers ?? ADAPTER_LIMITS.defaultWorkers;
  if (!Number.isSafeInteger(maxWorkers) || maxWorkers < 1 || maxWorkers > ADAPTER_LIMITS.maxWorkers) throw new RangeError(`maxWorkers must be an integer from 1 to ${ADAPTER_LIMITS.maxWorkers}.`);
  const outboxLimit = options.outboxLimit ?? ADAPTER_LIMITS.outbox;
  if (!Number.isSafeInteger(outboxLimit) || outboxLimit < 1 || outboxLimit > ADAPTER_LIMITS.outbox) throw new RangeError(`outboxLimit must be an integer from 1 to ${ADAPTER_LIMITS.outbox}.`);
  const persistenceWaitMs = options.persistenceWaitMs ?? DEFAULT_PERSISTENCE_WAIT_MS;
  if (!Number.isSafeInteger(persistenceWaitMs) || persistenceWaitMs < 0 || persistenceWaitMs > 60_000) throw new RangeError('persistenceWaitMs must be an integer from 0 to 60000.');
  const clock = options.clock ?? { monotonic: () => globalThis.performance?.now() ?? Date.now() };
  const idFactory = options.idFactory ?? (() => crypto.randomUUID());
  const origin = clock.monotonic();
  const budget: WorkerBudget = createWorkerBudget({ maxWorkers, workerFactory: () => catalog.createWorker() });
  const hostClock = createHostClock();
  const activities = new Map<string, ActivityController>();
  /**
   * Prepare and restore outcomes by operation ID. `activityId` is set once an operation succeeded: `forget` of that
   * activity replaces its outcome with a NOT_FOUND release (the ID stays used, so it is never run again).
   */
  const operations = new Map<string, { fingerprint: string; promise: Promise<unknown>; activityId?: string }>();
  let disposed = false;

  /** Exact template and model resolution: no lookup by topic, no newer version, no other digest. */
  function resolve(reference: { templateId: string; version: string }, expected?: { template: TemplateRef; model: ModelRef }): Resolved | CommandFailure {
    const template = catalog.getTemplate({ templateId: reference.templateId, version: reference.version });
    if (!template) return failure(diag(expected ? 'UNSUPPORTED_ARTIFACT' : 'INVALID_REFERENCE', '$.template', 'The exact template version is not installed.', expected ? ARCHIVAL_RECOVERY : 'Choose an installed template version from getCapabilities().'));
    const manifestInput = catalog.getModel({ modelId: template.model.modelId, version: template.model.version });
    if (!manifestInput) return failure(diag(expected ? 'UNSUPPORTED_ARTIFACT' : 'INVALID_REFERENCE', '$.model', 'The exact model version is not installed.', expected ? ARCHIVAL_RECOVERY : 'Install the exact model version the template references; no other model is substituted.'));
    let manifest: ModelManifest, identity: ModelIdentity;
    try { ({ manifest, identity } = validateManifest(manifestInput)); } catch (error) {
      return failure(...(isModelError(error) ? fromModelDiagnostics(error.diagnostics, 'SCHEMA') : [diag('SCHEMA', '$.model', 'The installed model manifest is invalid.')]));
    }
    const modelRef: ModelRef = { modelId: manifest.modelId, version: manifest.version, digest: identity.digest };
    if (modelRef.digest !== template.model.digest) return failure(diag('INVALID_REFERENCE', '$.model.digest', 'The installed model digest differs from the template reference.', 'Reinstall a consistent catalogue; no other model is substituted.'));
    const templateRef = refOf(template);
    if (expected && (canonicalJSON(expected.template) !== canonicalJSON(templateRef) || canonicalJSON(expected.model) !== canonicalJSON(modelRef)))
      return failure(diag('UNSUPPORTED_ARTIFACT', '$.template.digest', 'The installed template or model differs from the saved exact version.', ARCHIVAL_RECOVERY));
    return { template, manifest, identity, templateRef, modelRef };
  }
  const isFailure = (value: unknown): value is CommandFailure => !!value && typeof value === 'object' && (value as { ok?: unknown }).ok === false;
  /**
   * Loads one template version's content when the catalogue loads content on demand (`ActivityCatalog.load`, which
   * verifies it against the catalogue's installed digests). NOT_FOUND leaves the reference error to `resolve`; any other
   * failure is returned, so content that does not match its installed digest is never used or substituted.
   */
  async function loadContent(reference: { templateId: string; version: string }): Promise<CommandFailure | null> {
    if (typeof catalog.load !== 'function' || catalog.getTemplate({ templateId: reference.templateId, version: reference.version })) return null;
    let loaded: Awaited<ReturnType<NonNullable<typeof catalog.load>>>;
    try { loaded = await catalog.load({ templateId: reference.templateId, version: reference.version }); } catch {
      return failure(diag('NOT_READY', '$.template', 'The installed content of this template could not be loaded.', 'Check that the catalogue content files are served with the page, then retry.'));
    }
    if (loaded.ok || loaded.diagnostics.every(item => item.code === 'NOT_FOUND')) return null;
    return failure(...loaded.diagnostics);
  }

  /** Initial parameters: defaults, then the scenario, then explicit values (canonical units). Approved mode may set only template controls. */
  function initialParameters(request: ActivityRequest, resolved: Resolved, policy: HostPolicy): { ok: true; params: Record<string, number> } | CommandFailure {
    const params: Record<string, number> = Object.fromEntries(Object.entries(resolved.manifest.parameters).map(([id, definition]) => [id, definition.default]));
    if (request.scenarioId !== undefined) {
      const scenario = resolved.template.scenarios.find(item => item.id === request.scenarioId);
      if (!scenario) return failure(diag('INVALID_REFERENCE', '$.scenarioId', 'The template has no scenario with this ID.'));
      Object.assign(params, scenario.parameters);
    }
    const explicit = request.parameters ?? {};
    const controlled = new Set(resolved.template.controls.map(control => control.parameter));
    for (const id of Object.keys(explicit)) {
      if (!Object.hasOwn(resolved.manifest.parameters, id)) return failure(diag('INVALID_INPUT', `$.parameters.${id}`, 'Unknown parameter.'));
      if (request.mode === 'approved' && !controlled.has(id)) return failure(diag('POLICY_DENIED', `$.parameters.${id}`, 'Approved activities set only parameters that the template exposes as controls.'));
    }
    if (request.mode === 'exploratory' && Object.keys(explicit).length > policy.exploratory.maxParametersOverride)
      return failure(diag('POLICY_DENIED', '$.parameters', 'The request overrides more parameters than the host policy allows for exploratory activities.'));
    Object.assign(params, explicit);
    const problems = checkParameters(resolved.manifest, params);
    return problems.length ? failure(...fromModelDiagnostics(problems)) : { ok: true, params };
  }
  function resourceEstimate(manifest: ModelManifest): { operations: number; geometryElements: number } {
    return { operations: manifest.limits.maxOperations, geometryElements: Object.values(manifest.geometry).reduce((total, geometry) => total + geometry.maxElements, 0) };
  }
  async function fetchPolicy(activityId: string): Promise<HostPolicy | CommandFailure> {
    let policy: HostPolicy;
    try { policy = await host.getPolicy({ activityId }); } catch (error) {
      return failure(isHostRefusal(error) ? hostRefusalDiagnostic(error.code, 'No policy was returned.') : diag('PERSISTENCE_FAILED', '$.policy', 'The host did not return a policy.', 'Retry when the host is available.'));
    }
    const problems = policyDiagnostics(policy);
    if (problems.length) return failure(...problems.map(item => ({ ...item, path: `$.policy${item.path.slice(1)}` })));
    hostClock.observe(policy.issuedAt);
    return structuredClone(policy);
  }
  /** Schema, references, semantics, policy standing, mode authorization, constraints and resource ceilings. */
  async function check(raw: unknown): Promise<{ request: ActivityRequest; resolved: Resolved; policy: HostPolicy; params: Record<string, number> } | CommandFailure> {
    const parsed = parseRecord(MESSAGES.activityRequest, raw);
    if (!parsed.ok) return failure(...parsed.diagnostics);
    const request = structuredClone(parsed.value);
    const unloaded = await loadContent(request.template);
    if (unloaded) return unloaded;
    const resolved = resolve(request.template);
    if (isFailure(resolved)) return resolved;
    const semantic = validateTemplateSemantics(resolved.template, resolved.manifest);
    if (semantic.length) return failure(...semantic);
    if (request.stageId !== undefined && !resolved.template.stages.some(stage => stage.id === request.stageId)) return failure(diag('INVALID_REFERENCE', '$.stageId', 'The template has no stage with this ID.'));
    const estimate = resourceEstimate(resolved.manifest);
    if (estimate.geometryElements > ADAPTER_LIMITS.geometryElements || estimate.operations > ADAPTER_LIMITS.operations) return failure(diag('RESOURCE_LIMIT', '$.model.limits', 'The model declares more work than this adapter supports.'));
    const policy = await fetchPolicy(request.activityId);
    if (isFailure(policy)) return policy;
    const standing = policyStanding(policy, hostClock.now()) ?? modeDiagnostic(request.mode, policy, catalog, resolved.templateRef, resolved.modelRef);
    if (standing) return failure(standing);
    const params = initialParameters(request, resolved, policy);
    if (isFailure(params)) return params;
    return { request, resolved, policy, params: params.params };
  }
  const notice = (mode: 'approved' | 'exploratory', resolved: Resolved): string => reviewNotice(mode, catalog.status(resolved.templateRef), catalog.status(resolved.modelRef));

  function instanceFor(request: ActivityRequest, resolved: Resolved, policy: HostPolicy, params: Record<string, number>): ActivityInstance {
    return {
      contract: CONTRACTS.instance, schemaVersion: ACTIVITY_SCHEMA_VERSION, activityId: request.activityId, objectiveIds: [...request.objectiveIds], hostSessionId: request.hostSessionId,
      hostSessionRevision: request.hostSessionRevision, template: { ...resolved.templateRef }, model: { ...resolved.modelRef }, initialParameters: { ...params }, mode: request.mode,
      stage: { id: request.stageId ?? resolved.template.initialStage, enteredAtSequence: 0 }, activityRevision: 0, policy: { policyId: policy.policyId, revision: policy.revision },
      context: { kind: 'instructional' }, responses: [], allowedActions: [...policy.allowedTools], persistence: 'saved', closed: false,
    };
  }
  function controller(resolved: Resolved, policy: HostPolicy, instance: ActivityInstance, mode: 'approved' | 'exploratory'): ActivityController {
    const activityId = instance.activityId;
    let created: ActivityController | null = null;
    created = createActivityController({
      activityId, template: resolved.template, manifest: resolved.manifest, identity: resolved.identity, templateRef: resolved.templateRef, modelRef: resolved.modelRef,
      catalog, host, budget, hostClock, clock, origin, idFactory, outboxLimit, persistenceWaitMs, policy, instance, reviewNotice: notice(mode, resolved),
      onDisposed: () => { if (created && activities.get(activityId) === created) activities.delete(activityId); },
      onForgotten: () => releaseOutcomes(activityId),
    });
    activities.set(activityId, created);
    return created;
  }
  /**
   * Deduplicates prepare/restore by operation ID: the same arguments return the original outcome, other arguments fail
   * with OPERATION_CONFLICT. Transient failures are forgotten so the same operation can be retried.
   */
  function single(operationId: unknown, fingerprint: string, run: () => Promise<unknown>): Promise<unknown> {
    if (typeof operationId !== 'string' || !ID.test(operationId)) return Promise.resolve(failure(diag('INVALID_INPUT', '$.operationId', 'Provide a bounded operation ID.')));
    const previous = operations.get(operationId);
    if (previous) return previous.fingerprint === fingerprint ? previous.promise : Promise.resolve(failure(diag('OPERATION_CONFLICT', '$.operationId', 'This operation ID was already used with different arguments.')));
    if (operations.size >= OPERATION_CACHE) operations.delete(operations.keys().next().value!);
    const entry: { fingerprint: string; promise: Promise<unknown>; activityId?: string } = { fingerprint, promise: Promise.resolve() };
    entry.promise = run().then(result => {
      if (isFailure(result) && result.diagnostics.some(item => TRANSIENT.has(item.code))) { if (operations.get(operationId) === entry) operations.delete(operationId); }
      else if (!isFailure(result)) {
        const activityId = (result as { prepared?: { activityId?: unknown } } | null)?.prepared?.activityId;
        if (typeof activityId === 'string') entry.activityId = activityId;
      }
      return result;
    });
    operations.set(operationId, entry);
    return entry.promise;
  }
  /**
   * `forget({ scope: 'activity' })` (activity-runtime §8): the settled prepare and restore outcomes of `activityId` hold
   * copies of activity data (a restore report's draft parameter values and notes). Each is replaced by a NOT_FOUND
   * release; its operation ID stays used, so a replay neither returns the copy nor runs the operation again.
   */
  function releaseOutcomes(activityId: string): void {
    for (const [operationId, entry] of operations) {
      if (entry.activityId !== activityId) continue;
      operations.set(operationId, {
        fingerprint: entry.fingerprint,
        promise: Promise.resolve(failure(diag('NOT_FOUND', '$.operationId', 'The outcome of this operation was released when the host forgot the activity\'s cached copies.', 'Use a new operation ID.'))),
      });
    }
  }
  /** Bounded fingerprint of restore input (bytes, text or a parsed value). */
  const rawFingerprint = (raw: unknown): string => {
    try {
      if (typeof raw === 'string') return sha256(raw);
      if (raw instanceof Uint8Array) return sha256(new TextDecoder().decode(raw));
      return sha256(canonicalJSON(raw ?? null));
    } catch { return 'unhashable'; }
  };

  const adapter: StudyHarnessAdapter = {
    getCapabilities(): CapabilityReport {
      const templates: CapabilityReport['templates'] = [];
      const unavailable: CapabilityReport['unavailable'] = [];
      const reviewScope = (status: CatalogEntryStatus): string => status.reviews.length ? status.reviews.map(review => review.scope).join(' | ').slice(0, 4000) : 'No independent subject review is recorded for this exact version.';
      const listed = new Set<string>();
      for (const entry of catalog.listTemplates()) {
        listed.add(`${entry.template.templateId}@${entry.template.version}`);
        // Content not loaded yet (a catalogue that loads on demand): the entry comes from its verified installed index.
        const described = catalog.getTemplate(entry.template) ? null : catalog.describe?.(entry.template) ?? null;
        if (described) {
          templates.push({ template: { ...entry.template }, model: { ...entry.model }, ...described, lifecycle: entry.status.lifecycle, reviewScope: reviewScope(entry.status) });
          continue;
        }
        const resolved = resolve(entry.template);
        // An installed entry that cannot be offered is reported with its reason, never dropped silently (report §5.3).
        const problems = isFailure(resolved) ? resolved.diagnostics : validateTemplateSemantics(resolved.template, resolved.manifest);
        if (isFailure(resolved) || problems.length) {
          unavailable.push({ template: { templateId: entry.template.templateId, version: entry.template.version }, diagnostics: withHostRecovery(problems.slice(0, 8)) });
          continue;
        }
        // Controls, per-stage actions, the stage graph and alternatives (activity content such as instructions and prompts is not listed).
        templates.push({
          template: { ...resolved.templateRef }, model: { ...resolved.modelRef }, ...templateDiscovery(resolved.template, resolved.manifest),
          lifecycle: entry.status.lifecycle, reviewScope: reviewScope(entry.status),
        });
      }
      // Installed template entries the catalogue excluded (failed verification or validation, for example on-demand content
      // whose digest does not match): reported with their diagnostics, never dropped silently (report §5.3).
      let problems: ReturnType<NonNullable<typeof catalog.problems>> = [];
      try { problems = typeof catalog.problems === 'function' ? catalog.problems() : []; } catch { problems = []; }
      for (const problem of Array.isArray(problems) ? problems : []) {
        if (problem?.kind !== 'template' || typeof problem.id !== 'string' || typeof problem.version !== 'string') continue;
        const key = `${problem.id}@${problem.version}`;
        if (listed.has(key) || unavailable.some(item => `${item.template.templateId}@${item.template.version}` === key)) continue;
        const diagnostics = Array.isArray(problem.diagnostics) && problem.diagnostics.length ? problem.diagnostics.slice(0, 8)
          : [diag('INTEGRITY_FAILURE', '$.template', 'The catalogue excluded this installed template version.')];
        unavailable.push({ template: { templateId: problem.id, version: problem.version }, diagnostics: withHostRecovery(diagnostics.map(item => ({ ...item }))) });
      }
      return {
        adapterVersion: ADAPTER_VERSION,
        schemas: Object.entries(SCHEMA_VERSIONS).map(([contract, version]) => ({ contract, version })),
        runtime: { ...MODEL_RUNTIME }, templates, unavailable, capabilities: INSTALLED_CAPABILITIES.map(record => structuredClone(record)),
        limits: { maxWorkers, outboxLimit, tableRows: TABLE_ROW_LIMIT, previewSamples: 20, eventPayloadBytes: 8 * 1024 },
        unsupported: [
          { capability: 'executable-model-source', alternative: 'Use an installed kernel by ID and version or a bounded schema 2.0 document; requests never carry code.' },
          { capability: 'remote-resources', alternative: 'All assets are bundled; activities run with network access blocked.' },
          { capability: 'learner-grading', alternative: 'The host owns responses, evaluation and mastery decisions; summaries report observations only.' },
        ],
      };
    },

    async validate(raw, signal) {
      if (disposed) return { ok: false, diagnostics: DISPOSED().diagnostics };
      const checked = await check(raw);
      if (isFailure(checked)) return { ok: false, diagnostics: checked.diagnostics };
      const { resolved, params } = checked;
      const report: ValidationReport = { ok: true, diagnostics: [], resourceEstimate: resourceEstimate(resolved.manifest) };
      // Defaults are evaluated in a worker lease from the shared budget; nothing is registered, journaled or shown.
      let lease;
      try {
        lease = await budget.acquire(`validate.${checked.request.activityId}`.slice(0, 128), 'sample', signal);
        const data = await lease.evaluator.evaluate({ manifest: resolved.manifest, params, position: initialPosition(resolved.manifest) }, signal);
        const frame = assembleFrame(resolved.modelRef, { kind: 'sample', sampleId: `validate.${idFactory()}`.slice(0, 128) }, data);
        report.defaults = { frameId: frame.frameId, statuses: Object.fromEntries(Object.entries(frame.quantities).map(([id, result]) => [id, result.status])) };
      } catch (error) {
        return { ok: false, diagnostics: withHostRecovery(isModelError(error) ? fromModelDiagnostics(error.diagnostics, 'WORKER_ERROR') : [diag('WORKER_ERROR', '$', 'The default evaluation failed.')]), resourceEstimate: report.resourceEstimate };
      } finally { lease?.release(); }
      return report;
    },

    prepare(raw, input, signal) {
      if (disposed) return Promise.resolve(DISPOSED());
      const operationId = input?.operationId;
      return single(operationId, canonicalJSON({ kind: 'prepare', raw: rawFingerprint(raw) }), async () => {
        const checked = await check(raw);
        if (isFailure(checked)) return checked;
        if (disposed) return DISPOSED();
        const { request, resolved, policy, params } = checked;
        if (activities.has(request.activityId)) return failure(diag('CONFLICT', '$.activityId', 'An activity with this ID is already open in this adapter.', 'Dispose it first or use another activity ID.'));
        const created = controller(resolved, policy, instanceFor(request, resolved, policy, params), request.mode);
        const opened = await created.open({ params, operationId: operationId as string, ...(signal ? { signal } : {}) });
        if (opened) { created.dispose(); return opened; }
        if (created.disposed || disposed) return DISPOSED();
        return { ok: true as const, prepared: created.prepared() };
      }) as Promise<{ ok: true; prepared: PreparedActivity } | CommandFailure>;
    },

    getState(activityId, audience) {
      const activity = activities.get(activityId);
      if (!activity) return failure(diag('NOT_FOUND', '$.activityId', 'No open activity has this ID.'));
      if (!['learner', 'tutor', 'teacher', 'host'].includes(audience)) return failure(diag('INVALID_INPUT', '$.audience', 'Unknown audience.'));
      return activity.state(audience);
    },

    summarizeInteraction(activityId, summaryOptions) {
      const activity = activities.get(activityId);
      if (!activity) return failure(diag('NOT_FOUND', '$.activityId', 'No open activity has this ID.'));
      return activity.summary(summaryOptions);
    },

    restore(raw, input, signal) {
      if (disposed) return Promise.resolve(DISPOSED());
      return single(input?.operationId, canonicalJSON({ kind: 'restore', raw: rawFingerprint(raw), hostSessionRevision: input?.hostSessionRevision ?? null }),
        () => restoreArtifact(raw, input, signal)) as Promise<RestoreResult | CommandFailure>;
    },

    dispose(activityId) {
      if (activityId !== undefined) { activities.get(activityId)?.dispose(); return; }
      if (disposed) return;
      disposed = true;
      for (const activity of [...activities.values()]) activity.dispose();
      activities.clear();
      budget.dispose();
    },

    async sample(request, signal) {
      if (disposed) return DISPOSED();
      const activity = activities.get(request?.activityId);
      if (!activity) return failure(diag('NOT_FOUND', '$.activityId', 'No open activity has this ID.'));
      return activity.sample({ parameters: request.parameters, positions: request.positions, audience: request.audience }, signal);
    },

    // Expiry by host time for callers that read the host policy themselves (agent tools; activity-runtime §1).
    policyStanding(policy) {
      const problems = policyDiagnostics(policy);
      if (problems.length) return withHostRecovery([diag('POLICY_DENIED', '$.policy', 'The host policy is not valid.')])[0]!;
      const standing = policyStanding(policy, hostClock.now());
      return standing ? withHostRecovery([standing])[0]! : null;
    },

    getDiagnostics(activityId) {
      if (activityId !== undefined && !activities.has(activityId)) return failure(diag('NOT_FOUND', '$.activityId', 'No open activity has this ID.'));
      return diagnosticsOf(activityId);
    },

    exportDiagnostics(exportOptions) {
      const activityId = exportOptions?.activityId;
      if (activityId !== undefined && !activities.has(activityId)) return failure(diag('NOT_FOUND', '$.activityId', 'No open activity has this ID.'));
      // A plain, bounded value: identities, codes, counts and timings only. The toolkit never sends it anywhere.
      const exported: DiagnosticExport = {
        contract: 'study-harness.diagnostic-export', version: '1.0', redacted: true,
        notice: 'Local diagnostic export: identities, diagnostic codes, counts and timings only. It contains no parameter values, quantities, labels, responses or learner text, and the toolkit never transmits it.',
        monotonicMs: Math.max(0, clock.monotonic() - origin),
        execution: { adapterVersion: ADAPTER_VERSION, runtime: { ...MODEL_RUNTIME }, schemas: Object.entries(SCHEMA_VERSIONS).map(([contract, version]) => ({ contract, version })) },
        diagnostics: diagnosticsOf(activityId),
      };
      return structuredClone(exported);
    },

    inspectDeveloper(activityId) {
      const activity = activities.get(activityId);
      if (!activity) return failure(diag('NOT_FOUND', '$.activityId', 'No open activity has this ID.'));
      return activity.developer();
    },
  };

  /** Host-only operational metrics; answered after disposal too (the budget then reports no workers). */
  function diagnosticsOf(activityId?: string): AdapterDiagnostics {
    const stats = budget.stats();
    return {
      adapterVersion: ADAPTER_VERSION, runtime: { ...MODEL_RUNTIME },
      budget: { maxWorkers, workers: stats.workers, active: stats.active, idle: stats.idle, waiting: stats.waiting, leases: stats.leases.map(lease => ({ ownerId: lease.ownerId, purpose: lease.purpose })) },
      activities: [...activities.values()].filter(activity => activityId === undefined || activity.activityId === activityId).map(activity => activity.diagnostics()),
    };
  }

  /**
   * Restore (activity-runtime §9, report §14): verify integrity and migrate explicitly → exact catalogue content (no
   * substitution) and revocation → current host policy (which may be more restrictive) → saved parameters through the
   * same constraint check as every entry point → re-evaluation of the saved position in the worker → paused, with
   * conservative exposures and no re-emitted reveal or prediction events. Saved claims of context, visibility and
   * approval are never trusted (`restoreClaims`).
   */
  async function restoreArtifact(raw: unknown, input: { operationId: string; hostSessionRevision: number }, signal?: AbortSignal): Promise<RestoreResult | CommandFailure> {
    if (!Number.isSafeInteger(input?.hostSessionRevision) || input.hostSessionRevision < 0) return failure(diag('INVALID_INPUT', '$.hostSessionRevision', 'Provide the current host session revision.'));
    const interrupted = () => disposed ? DISPOSED() : signal?.aborted
      ? failure(diag('CANCELLED', '$', 'The restore was cancelled.', 'Retry the restore when it is needed.')) : null;
    const beforeLoad = interrupted();
    if (beforeLoad) return beforeLoad;
    // Migration is needed only for restore. Keep the public synchronous helper available, but do not send its
    // implementation to a prepare-only learner page until this async operation requests it. No host call precedes it.
    let migrations: typeof import('./migrations.js');
    try { migrations = await import('./migrations.js'); } catch {
      return interrupted() ?? failure(diag('NOT_READY', '$.artifact', 'The installed artifact migration module could not be loaded.',
        'Restore the local migration asset, reload, then retry.'));
    }
    const afterLoad = interrupted();
    if (afterLoad) return afterLoad;
    const migrated = migrations.migrateArtifact(raw);
    if (!migrated.ok) return failure(...migrated.diagnostics);
    const artifact = migrated.artifact;
    const notes: string[] = [...migrated.report];
    if (artifact.kind !== 'backup') return failure(diag('UNSUPPORTED_ARTIFACT', '$.kind', 'A learner snapshot is a read-only record; only a backup restores an activity.', 'Show the learner snapshot read-only with archivalView(artifact, { audience }).'));
    const unloaded = await loadContent(artifact.template);
    if (unloaded) return unloaded;
    const resolved = resolve(artifact.template, { template: artifact.template, model: artifact.model });
    if (isFailure(resolved)) return resolved;
    const revoked = revocationDiagnostic(catalog, resolved.templateRef, resolved.modelRef);
    if (revoked) return failure({ ...revoked, recovery: 'Revoked content is not reopened; show the artifact read-only with archivalView(artifact, { audience }).' });
    const saved = artifact.instance;
    const policy = await fetchPolicy(saved.activityId);
    if (isFailure(policy)) return policy;
    if (disposed) return DISPOSED();
    const standing = policyStanding(policy, hostClock.now()) ?? modeDiagnostic(saved.mode, policy, catalog, resolved.templateRef, resolved.modelRef);
    if (standing) return failure(standing);
    if (activities.has(saved.activityId)) return failure(diag('CONFLICT', '$.instance.activityId', 'An activity with this ID is already open in this adapter.', 'Dispose it before restoring.'));
    const problems = checkParameters(resolved.manifest, artifact.scientific.params);
    if (problems.length) return failure(...fromModelDiagnostics(problems).map(item => ({ ...item, path: `$.scientific${item.path.slice(1)}` })));
    if (!resolved.template.stages.some(stage => stage.id === saved.stage.id)) return failure(diag('UNSUPPORTED_ARTIFACT', '$.instance.stage', 'The saved stage does not exist in the installed template.'));
    // Context, tools and visibility come from the current policy; the artifact's own claims are provenance only.
    const independent = policy.independentTask.active && policy.independentTask.taskRef !== null;
    const context: ActivityInstance['context'] = independent ? { kind: 'independent', taskRef: policy.independentTask.taskRef! } : { kind: 'instructional' };
    const stage = resolved.template.stages.find(item => item.id === saved.stage.id)!;
    const ceiling = new Set(policy.visibleGroups), permitted = new Set(policy.permittedControls);
    const narrowed = Object.keys(stage.visible).some(id => !ceiling.has(id)) || Object.keys(stage.controls).some(id => !permitted.has(id))
      || independent || saved.context.kind === 'independent';
    if (policy.revision !== artifact.policyRef.revision || policy.policyId !== artifact.policyRef.policyId) notes.push('The current host policy differs from the saved policy reference; the current policy governs the restored activity.');
    let restored: 'exact' | 'restricted' | 'read-only' = saved.closed ? 'read-only' : narrowed || migrated.restore === 'restricted' ? 'restricted' : 'exact';
    if (restored === 'restricted' && narrowed) notes.push('The current host policy shows less than the saved stage allowed; the activity is restored restricted.');
    if (migrated.semanticsChanged) { restored = saved.closed ? 'read-only' : 'restricted'; notes.push('The migration changed meaning; the activity is restored restricted.'); }
    if (saved.closed) notes.push('The activity was closed when saved; it is restored read-only.');
    const instance: ActivityInstance = {
      ...structuredClone(saved), hostSessionRevision: input.hostSessionRevision, policy: { policyId: policy.policyId, revision: policy.revision }, context,
      allowedActions: [...(independent ? policy.independentTask.permittedTools : policy.allowedTools)], persistence: 'saved',
    };
    // The artifact's own lineage marks (report §6.4, A19): only grants of the saved current lineage, restored into the
    // same context, may count. A saved independent context (or a pending reopening) is honoured as a restricting claim:
    // restored into instructional work, its grants never count and instructional content waits for reopenInstructional,
    // which records assistance through the host. These marks only ever restrict: an edited backup can drop them, so the
    // controller counts a grant only when, in addition, the host holds the same grant and the host's context lineage
    // counts it, and requires a reopening whenever the host still holds the activity in independent work (`openRestored`).
    // Restore never turns supported work into independent work: the context itself comes from the current policy.
    const lineage = artifact.lineage;
    const ended = new Set(lineage?.endedExposureIds ?? []);
    const savedContext = saved.context;
    const sameTask = savedContext.kind === 'independent' && context.kind === 'independent' && savedContext.taskRef === context.taskRef;
    const reopenRequired = context.kind === 'instructional' && (savedContext.kind === 'independent' || !!lineage?.reopenRequired);
    const counts = (record: { exposureId: string }): boolean => !ended.has(record.exposureId)
      && (context.kind === 'independent' ? lineage !== undefined && sameTask : !reopenRequired);
    const created = controller(resolved, policy, instance, saved.mode);
    const opened = await created.openRestored({
      operationId: input.operationId, ...(signal ? { signal } : {}),
      restored: { artifact, artifactDigest: artifactDigest(artifact), restored, counts, reopenRequired },
    });
    if (opened) { created.dispose(); return opened; }
    if (created.disposed || disposed) return DISPOSED();
    // A preview pending at the save is never committed by a restore; the host may re-offer it.
    const pendingDraft = artifact.pending.kind === 'preview' ? { previewId: artifact.pending.previewId, params: { ...artifact.pending.params }, baseRunId: artifact.pending.baseRunId } : null;
    // The host's records can only make the outcome more restrictive (its stage, revision, closure and grants govern).
    return { ok: true, prepared: created.prepared(), report: { restored: created.restoration(), notes: [...notes, ...created.notes()], ...(pendingDraft ? { pendingDraft } : {}) } };
  }

  return adapter;
}
