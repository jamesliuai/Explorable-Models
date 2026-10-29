/**
 * Activity identities: exact template digest and per-group content digests used by exposure grants.
 * A digest establishes identity, not correctness or review status.
 */
import { canonicalJSON, sha256 } from '@experiment-kit/core';
import type { ModelManifest } from '@experiment-kit/core/model';
import type { ActivityArtifact, ActivityTemplate, GroupDigest, GroupKind, TemplateRef } from './contracts.js';

const hash = (value: unknown): string => 'sha256:' + sha256(canonicalJSON(value));

/** Exact template identity: sha256 over the canonical JSON of the whole template. */
export function templateDigest(template: ActivityTemplate): string { return hash(template); }

export function templateRef(template: ActivityTemplate): TemplateRef {
  return { templateId: template.templateId, version: template.version, digest: templateDigest(template) };
}

/** IDs a member of each group kind may name (template element IDs or manifest keys). */
export function memberIds(template: ActivityTemplate, manifest: ModelManifest): Record<GroupKind, Set<string>> {
  return {
    view: new Set(template.views.map(view => view.id)),
    mark: new Set(template.views.flatMap(view => view.marks.map(mark => mark.id))),
    quantity: new Set(Object.keys(manifest.quantities)),
    equation: new Set(template.equations.map(equation => equation.id)),
    dataset: new Set(Object.keys(manifest.geometry)),
    control: new Set(template.controls.map(control => control.parameter)),
    annotation: new Set(template.content.map(entry => entry.id)),
    alternative: new Set(template.alternatives.map(alternative => alternative.id)),
  };
}

/**
 * Canonical content of one group (activity-runtime §3): the group record; every template element named by its
 * members or assigned to it through its `group` field (views list their marks by ID, each mark is digested with
 * its own group); scenarios of the group; and the manifest definitions of member quantities, dataset geometry (with
 * the observed datasets it plots) and controlled parameters. All learner text, including accessible text, is included. Unresolvable member IDs are
 * listed under `missing`, so the digest is total and changes once they resolve.
 */
export function groupContent(template: ActivityTemplate, manifest: ModelManifest, groupId: string): Record<string, unknown> {
  const group = template.groups.find(candidate => candidate.id === groupId);
  if (!group) throw new RangeError(`Unknown content group ${JSON.stringify(groupId)}.`);
  const members = new Set(group.members);
  const named = (kind: GroupKind, id: string): boolean => group.kind === kind && members.has(id);
  const assigned = <T extends { group: string }>(items: T[], kind: GroupKind, key: (item: T) => string): T[] =>
    items.filter(item => item.group === groupId || named(kind, key(item)));
  const definitions = <T>(source: Record<string, T>, ids: string[]): Record<string, T> =>
    Object.fromEntries(ids.filter(id => Object.hasOwn(source, id)).map(id => [id, source[id]!]));
  const controls = assigned(template.controls, 'control', control => control.parameter);
  const content: Record<string, unknown> = {
    group,
    views: assigned(template.views, 'view', view => view.id).map(view => ({ ...view, marks: view.marks.map(mark => mark.id) })),
    marks: assigned(template.views.flatMap(view => view.marks), 'mark', mark => mark.id),
    equations: assigned(template.equations, 'equation', equation => equation.id),
    controls,
    scenarios: template.scenarios.filter(scenario => scenario.group === groupId),
    alternatives: assigned(template.alternatives, 'alternative', alternative => alternative.id),
    annotations: template.content.filter(entry => named('annotation', entry.id)),
    quantities: group.kind === 'quantity' ? definitions(manifest.quantities, group.members) : {},
    geometry: group.kind === 'dataset' ? definitions(manifest.geometry, group.members) : {},
    // Observed data a member geometry plots (report §8.5): every cell and its provenance is content the group shows.
    ...observedContent(manifest, group.kind === 'dataset' ? group.members : []),
    parameters: definitions(manifest.parameters, controls.map(control => control.parameter)),
  };
  const available = memberIds(template, manifest)[group.kind];
  const missing = group.members.filter(id => !available.has(id));
  if (missing.length) content.missing = missing;
  return content;
}

/** The observed datasets plotted by `geometryIds` (only present when there are any, so other digests are unchanged). */
function observedContent(manifest: ModelManifest, geometryIds: readonly string[]): { observations?: Record<string, unknown> } {
  const ids = [...new Set(geometryIds.flatMap(id => {
    const dataset = Object.hasOwn(manifest.geometry, id) ? manifest.geometry[id]!.observations?.dataset : undefined;
    return dataset !== undefined && manifest.observations && Object.hasOwn(manifest.observations, dataset) ? [dataset] : [];
  }))].sort();
  return ids.length ? { observations: Object.fromEntries(ids.map(id => [id, manifest.observations![id]!])) } : {};
}

/** `sha256:` digest of {@link groupContent}; the value carried in `GroupDigest.contentDigest`. */
export function groupContentDigest(template: ActivityTemplate, manifest: ModelManifest, groupId: string): string {
  return hash(groupContent(template, manifest, groupId));
}

/** Digests of every group, in template order. */
export function groupDigests(template: ActivityTemplate, manifest: ModelManifest): GroupDigest[] {
  return template.groups.map(group => ({ groupId: group.id, contentDigest: groupContentDigest(template, manifest, group.id) }));
}

/**
 * Top-level artifact fields protected by the integrity manifest, in entry order (everything except `integrity`). Fields
 * added later are appended, so the manifest of an artifact without them is unchanged.
 */
export const INTEGRITY_FIELDS = ['contract', 'schemaVersion', 'artifactId', 'kind', 'schemas', 'runtime', 'template', 'model', 'policyRef', 'instance',
  'scientific', 'presentation', 'exposures', 'journal', 'pending', 'contentRefs', 'reviewRefs', 'migratedFrom', 'assistance', 'lineage'] as const satisfies readonly Exclude<keyof ActivityArtifact, 'integrity'>[];

/**
 * Integrity manifest for an artifact: one entry per present top-level field (sha256 of its canonical JSON) and
 * `digest` = sha256 of the canonical entries array. Verified by `validateArtifactSemantics`.
 */
export function artifactIntegrity(artifact: Omit<ActivityArtifact, 'integrity'>): ActivityArtifact['integrity'] {
  const entries = INTEGRITY_FIELDS.filter(path => artifact[path] !== undefined).map(path => ({ path, digest: hash(artifact[path]) }));
  return { algorithm: 'sha256', entries, digest: hash(entries) };
}

/** Exact artifact identity (canonical JSON of the whole artifact including its integrity manifest). */
export function artifactDigest(artifact: ActivityArtifact): string { return hash(artifact); }
