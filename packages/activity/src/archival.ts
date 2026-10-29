/**
 * Archival read-only representation of a saved activity (report §14, A49; activity-runtime §9). When a verified
 * artifact cannot be reopened — the exact template or model is not installed, the content is revoked, re-evaluation
 * does not reproduce the saved state, or the artifact is a learner snapshot — the host can still show what was saved:
 * `archivalView(artifact, { audience })` verifies integrity (and applies registered, explicit migrations), then
 * describes the artifact's own records. It never evaluates a model, never consults the catalogue and never substitutes
 * a similar template or model, so the description is the saved record, not a recomputation.
 *
 * Audience filtering follows the restricted summaries (activity-runtime §6): learner and tutor views receive identities,
 * the saved stage and position, the exposure history of content that was shown or potentially shown, and only the
 * parameter values a learner snapshot recorded as visible. A backup's full parameter set, comparison parameters,
 * receipts, digests, task references and migration notes are listed for the teacher and host audiences only.
 */
import type { ArchivalAudience, ArchivalView } from './api.js';
import type { ActivityArtifact, Diagnostic, FramePosition } from './contracts.js';
import { withHostRecovery } from './describe.js';
import { artifactDigest } from './identity.js';
import { migrateArtifact } from './migrations.js';

const AUDIENCES: readonly ArchivalAudience[] = ['learner', 'tutor', 'teacher', 'host'];
const MAX_LINES = 64;

const positionText = (position: FramePosition): string =>
  position.kind === 'index' ? `n = ${position.index} of ${position.maxIndex}` : position.kind === 'time' ? `t = ${position.time}${position.endTime !== null ? ` of ${position.endTime}` : ''}` : 'a single static state';
const valuesText = (values: readonly { parameter: string; value: number }[]): string => values.map(item => `${item.parameter} = ${item.value}`).join(', ');
const sorted = (values: Readonly<Record<string, number>>) => Object.keys(values).sort().map(parameter => ({ parameter, value: values[parameter]! }));

/**
 * Archival view of a saved activity artifact (bytes, text or a parsed value). Fails with the verification diagnostics
 * (integrity, schema, unknown version, legacy record) when the artifact cannot be verified as an activity artifact; a
 * record this release cannot read is never interpreted.
 */
export function archivalView(raw: unknown, options: { audience: ArchivalAudience }): { ok: true; view: ArchivalView } | { ok: false; diagnostics: Diagnostic[] } {
  const audience = options?.audience;
  if (!AUDIENCES.includes(audience)) return { ok: false, diagnostics: withHostRecovery([{ code: 'INVALID_INPUT', path: '$.audience', message: 'Unknown audience.' }]) };
  const migrated = migrateArtifact(raw);
  if (!migrated.ok) return { ok: false, diagnostics: withHostRecovery(migrated.diagnostics) };
  return { ok: true, view: describeArtifact(migrated.artifact, audience, migrated.report) };
}

function describeArtifact(artifact: ActivityArtifact, audience: ArchivalAudience, report: readonly string[]): ArchivalView {
  const full = audience === 'teacher' || audience === 'host';
  const snapshot = artifact.kind === 'learner-snapshot';
  const { instance, scientific } = artifact;
  // A learner snapshot already holds only the parameters the learner projection showed; a backup holds every parameter.
  const parameters = full || snapshot ? sorted(scientific.params) : null;
  const comparisons = scientific.comparisons.map(item => ({ label: item.label, parameters: full || snapshot ? sorted(item.params) : null, position: structuredClone(item.position) }));
  const exposures = artifact.exposures
    .filter(record => full || record.displayStatus !== 'not-displayed')
    .map(record => ({ scope: record.scope, groups: record.groups.map(group => group.groupId), displayStatus: record.displayStatus, uncertainty: full ? record.uncertainty?.code ?? null : null }));
  const migratedFrom = artifact.migratedFrom ? { contract: artifact.migratedFrom.contract, version: artifact.migratedFrom.version } : null;

  const lines: string[] = [
    'Saved activity, shown as a read-only record. Nothing is evaluated again and no other template or model is substituted.',
    `Template ${artifact.template.templateId} ${artifact.template.version}; model ${artifact.model.modelId} ${artifact.model.version}.`,
    `Saved at stage ${instance.stage.id}${instance.closed ? ' (the activity was closed)' : ''}, ${instance.context.kind === 'independent' ? 'independent' : 'instructional'} context, ${instance.mode} mode.`,
    `Position: ${positionText(scientific.position)}${scientific.terminal ? ' (the last available position)' : ''}.`,
    parameters ? (parameters.length ? `Saved values (model units): ${valuesText(parameters)}.` : 'No parameter values were saved for this audience.')
      : 'Saved parameter values are listed for the host; a learner snapshot carries the values that were visible.',
    ...comparisons.map(item => `Comparison "${item.label}"${item.parameters ? `: ${valuesText(item.parameters)}` : ''} at ${positionText(item.position)}.`),
    exposures.length ? `Content shown or potentially shown: ${exposures.map(item => `${item.groups.join(', ')} (${item.displayStatus})`).join('; ')}.` : 'No exposure records are listed.',
    `Journal checkpoint: event ${artifact.journal.cursor.lastSequence}${artifact.journal.pendingEventIds.length ? `; ${artifact.journal.pendingEventIds.length} events were not yet acknowledged when it was saved` : ''}.`,
  ];
  if (migratedFrom) lines.push(`Converted from ${migratedFrom.contract} ${migratedFrom.version} by a registered migration.`);
  const notes = full ? [...report] : [];
  if (full && instance.context.kind === 'independent') notes.push(`Independent task reference: ${instance.context.taskRef}.`);
  return {
    kind: 'archival-view', version: '1.0', audience, readOnly: true,
    artifact: { artifactId: artifact.artifactId, kind: artifact.kind, digest: artifactDigest(artifact), migratedFrom },
    template: { ...artifact.template }, model: { ...artifact.model }, runtime: { ...artifact.runtime },
    activity: { activityId: instance.activityId, mode: instance.mode, stageId: instance.stage.id, context: instance.context.kind, closed: instance.closed, activityRevision: instance.activityRevision },
    position: structuredClone(scientific.position), terminal: scientific.terminal, parameters, comparisons, exposures,
    journal: { lastSequence: artifact.journal.cursor.lastSequence, pendingEvents: artifact.journal.pendingEventIds.length },
    lines: lines.slice(0, MAX_LINES), notes,
  };
}
