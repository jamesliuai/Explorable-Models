/**
 * Visibility policy (activity-runtime §3, report §6.2). Pure functions over the template, the current stage, the
 * host policy, the exposure grants of the current lineage and the context. Hidden groups are absent from every
 * learner channel because the projection is built only from what these functions mark visible.
 *
 * Gating rules for model data:
 * - A quantity is readable only as a member of a visible `quantity` group. Quantities in no group are never read.
 * - Geometry is readable as a member of a visible `dataset` group. Geometry that belongs to no dataset group is
 *   readable only through a mark of a visible group (the mark, including its bindings, is part of that group's
 *   content digest).
 * - A mark is shown when its own group is visible and every quantity and geometry it binds is readable.
 */
import { positionMode, type ModelManifest, type ModelRef } from '@experiment-kit/core/model';
import type { ActivityTemplate, ContentGroup, ExposureRecord, HostPolicy, MarkSpec, StageSpec, TemplateRef, Visibility } from './contracts.js';

export interface VisibilityContext {
  kind: 'instructional' | 'independent';
  /** Exact content digest of every template group (`groupDigests`). */
  digests: Readonly<Record<string, string>>;
  /** Grants count only when they name the activity's exact template and model. */
  template: TemplateRef;
  model: ModelRef;
}

/** True when a grant record counts for `stage`: stage and exploration grants for their own stage; reveal grants while they are in the current lineage. */
export function grantCounts(record: ExposureRecord, stageId: string): boolean {
  return record.displayStatus !== 'not-displayed' && (record.scope === 'reveal' || record.intendedStage === stageId);
}

const sameRef = (a: { digest: string }, b: { digest: string }): boolean => a.digest === b.digest;

/** True when some counting grant covers the exact `{groupId, contentDigest}`. */
export function groupCovered(groupId: string, exposures: readonly ExposureRecord[], stageId: string, context: VisibilityContext): boolean {
  const digest = context.digests[groupId];
  if (digest === undefined) return false;
  return exposures.some(record => grantCounts(record, stageId) && sameRef(record.template, context.template) && sameRef(record.model, context.model)
    && record.groups.some(group => group.groupId === groupId && group.contentDigest === digest));
}

/**
 * Visibility of every template group (activity-runtime §3): stage ∩ policy ceiling; in an independent context only
 * the policy's neutral scaffold; a solution-bearing group additionally needs a counting grant for its exact digest.
 * Callers pass only the exposure records of the current lineage (reveal grants end when the context becomes
 * independent).
 */
export function computeVisibility(template: ActivityTemplate, stage: StageSpec, policy: HostPolicy, exposures: readonly ExposureRecord[], context: VisibilityContext): Record<string, Visibility> {
  const ceiling = new Set(policy.visibleGroups);
  const scaffold = new Set(policy.independentTask.neutralScaffold);
  const result: Record<string, Visibility> = {};
  for (const group of template.groups) {
    const staged = Object.hasOwn(stage.visible, group.id) ? stage.visible[group.id]! : 'absent';
    let visibility: Visibility = staged;
    if (!ceiling.has(group.id)) visibility = 'absent';
    if (context.kind === 'independent' && !scaffold.has(group.id)) visibility = 'absent';
    if (visibility !== 'absent' && group.solutionBearing && !groupCovered(group.id, exposures, stage.id, context)) visibility = 'absent';
    result[group.id] = visibility;
  }
  return result;
}

/** Control modes (activity-runtime §3 step 5): stage controls ∩ policy.permittedControls, fixed unless both the stage and the control's group are interactive. */
export function computeControlModes(template: ActivityTemplate, stage: StageSpec, policy: HostPolicy, groups: Readonly<Record<string, Visibility>>): Record<string, 'interactive' | 'fixed'> {
  const permitted = new Set(policy.permittedControls);
  const modes: Record<string, 'interactive' | 'fixed'> = {};
  for (const control of template.controls) {
    if (!Object.hasOwn(stage.controls, control.parameter) || !permitted.has(control.parameter)) continue;
    const group = groups[control.group] ?? 'absent';
    if (group === 'absent') continue;
    modes[control.parameter] = stage.controls[control.parameter] === 'interactive' && group === 'interactive' ? 'interactive' : 'fixed';
  }
  return modes;
}

/** Groups of `kind` that list `member`. */
export function memberGroups(template: ActivityTemplate, kind: ContentGroup['kind'], member: string): ContentGroup[] {
  return template.groups.filter(group => group.kind === kind && group.members.includes(member));
}

/** IDs whose groups of `kind` are visible (members of visible groups only). */
function visibleMembers(template: ActivityTemplate, groups: Readonly<Record<string, Visibility>>, kind: ContentGroup['kind']): Set<string> {
  const out = new Set<string>();
  for (const group of template.groups) if (group.kind === kind && (groups[group.id] ?? 'absent') !== 'absent') for (const member of group.members) out.add(member);
  return out;
}
/** Quantities readable in the projection: members of visible quantity groups. */
export const visibleQuantityIds = (template: ActivityTemplate, groups: Readonly<Record<string, Visibility>>): Set<string> => visibleMembers(template, groups, 'quantity');

/** Geometry readable through a mark of a visible group (see module comment). */
export function geometryReadable(template: ActivityTemplate, groups: Readonly<Record<string, Visibility>>, geometryId: string, markGroup: string | null): boolean {
  const owners = memberGroups(template, 'dataset', geometryId);
  if (owners.length) return owners.some(group => (groups[group.id] ?? 'absent') !== 'absent');
  return markGroup !== null && (groups[markGroup] ?? 'absent') !== 'absent';
}

const QUANTITY_BINDINGS = ['at', 'vector', 'from', 'to', 'vertices', 'value', 'origin'] as const;
/** A mark is shown when its own group is visible and every quantity and geometry it binds is readable. */
export function markVisible(template: ActivityTemplate, groups: Readonly<Record<string, Visibility>>, mark: MarkSpec, quantities: ReadonlySet<string>): boolean {
  if ((groups[mark.group] ?? 'absent') === 'absent') return false;
  if (mark.bindings.geometry !== undefined && !geometryReadable(template, groups, mark.bindings.geometry, mark.group)) return false;
  return QUANTITY_BINDINGS.every(key => mark.bindings[key] === undefined || quantities.has(mark.bindings[key]!));
}

/**
 * Quantities that state the run's position (activity-runtime §3): scalar quantities of the position's dimension —
 * `iteration` for a discrete model (the iteration index n), `time` for a time document. Static models have none.
 */
export function positionQuantityIds(manifest: ModelManifest): Set<string> {
  const mode = positionMode(manifest);
  const dimension = mode === 'index' ? 'iteration' : mode === 'time' ? 'time' : null;
  return new Set(dimension === null ? [] : Object.entries(manifest.quantities).filter(([, quantity]) => quantity.dimension === dimension && quantity.shape.kind === 'scalar').map(([id]) => id));
}

/** Quantity groups that list a position quantity: the run's position, navigation and playback are their content. */
export function positionGroupIds(template: ActivityTemplate, manifest: ModelManifest): string[] {
  const position = positionQuantityIds(manifest);
  return template.groups.filter(group => group.kind === 'quantity' && group.members.some(member => position.has(member))).map(group => group.id);
}

const RANK: Readonly<Record<Visibility, number>> = { absent: 0, fixed: 1, interactive: 2 };
/**
 * Visibility of navigation and playback (activity-runtime §3, report §6.2, §6.4): the most visible position group. A
 * template that declares no position group keeps the stage's navigation in instructional work; in an independent context
 * it has none, because only neutral-scaffold groups may remain and none of them carries the position. Navigation is
 * projected (position, step and go-to, playback) only when this is not `absent`, and accepts commands only when it is
 * `interactive`.
 */
export function navigationVisibility(template: ActivityTemplate, manifest: ModelManifest, groups: Readonly<Record<string, Visibility>>, context: 'instructional' | 'independent'): Visibility {
  const ids = positionGroupIds(template, manifest);
  if (!ids.length) return context === 'independent' ? 'absent' : 'interactive';
  return ids.map(id => groups[id] ?? 'absent').reduce<Visibility>((best, next) => RANK[next] > RANK[best] ? next : best, 'absent');
}

/** Solution-bearing groups the stage would show under the policy ceiling (and the scaffold in an independent context); these need a grant. */
export function solutionGroupsFor(template: ActivityTemplate, stage: StageSpec, policy: HostPolicy, context: 'instructional' | 'independent'): ContentGroup[] {
  const ceiling = new Set(policy.visibleGroups), scaffold = new Set(policy.independentTask.neutralScaffold);
  return template.groups.filter(group => group.solutionBearing && Object.hasOwn(stage.visible, group.id) && ceiling.has(group.id)
    && (context === 'instructional' || scaffold.has(group.id)));
}
