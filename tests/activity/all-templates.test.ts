/**
 * Every installed template end to end through `createStudyHarnessAdapter` in Node: in-process kernel workers and the
 * test-only memory host, so these are fixture-host results and say nothing about the real Study Harness host. Each
 * template is prepared, walked through its stages with host receipts and display acknowledgements from a registered,
 * visible surface, previews and commits a parameter under an authorized exploration scope, reveals a solution-bearing
 * group that the policy ceiling withheld (policy update, then `requestReveal`), saves a learner snapshot and a backup,
 * and restores the backup in a fresh process.
 *
 * Every settled projection is scanned against an expectation computed here from the template alone (stage visibility
 * ∩ policy ceiling; every solution-bearing group in it is granted by the walk): no view, mark, equation, control,
 * scenario, alternative or quantity of an absent group may appear, no hidden label or category value may appear
 * unless visible content carries the same text, and no value of a hidden quantity or hidden geometry may appear unless
 * a visible source (visible quantities and geometry, parameters, visible template text, projection metadata) carries
 * the same number at the displayed precision. Hidden values come from an independent evaluation of the same request.
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
  createStudyHarnessAdapter, formatNumber, TERMINAL_TEXT, UI_STATUS,
  type ActivityArtifact, type ActivityTemplate, type ExposureRecord, type HostPolicy, type LearnerProjection, type StudyHarnessAdapter,
} from '@explorable-models/activity';
import { createInstalledCatalog, INSTALLED_KERNELS, INSTALLED_MODELS, INSTALLED_TEMPLATES } from '@explorable-models/catalog';
import { convert, evaluateRequest, type FramePosition, type ModelManifest, type PositionRequest } from '@explorable-models/core/model';
import { ackCurrent, activityGuard, expectValidEvents, harness, okOf, op, open, policyFor, settled, until, type Harness, type Opened } from './support/adapter-harness.js';
import { MemoryHost } from './support/memory-host.js';

interface Walk {
  /** Stages entered in order from the initial stage, each through a host stage receipt. */
  path: string[];
  /** Stage in which an exploration scope is authorized and `parameter` is previewed at `value`, then committed. */
  explore: { stage: string; parameter: string; value: number };
  /** Solution-bearing group left out of the initial policy ceiling and revealed with `requestReveal` in `stage`. */
  withheld: { group: string; stage: string };
  /** Stage in which a learner snapshot is saved (solution-bearing content still hidden). */
  snapshot: string;
}
const WALKS: Record<string, Walk> = {
  'quadratic-gradient-descent': {
    path: ['explore-step', 'explore-curvature', 'explain', 'closed'], explore: { stage: 'explore-step', parameter: 'eta', value: 0.5 },
    withheld: { group: 'substituted-rule', stage: 'explore-curvature' }, snapshot: 'predict',
  },
  'function-derivative': {
    path: ['predict', 'explore-slope', 'explore-derivative', 'explain', 'closed'], explore: { stage: 'explore-slope', parameter: 'p', value: 2 },
    withheld: { group: 'derivative-rule', stage: 'explore-derivative' }, snapshot: 'predict',
  },
  'linear-transformation': {
    path: ['predict', 'explore', 'explore-eigen', 'explain', 'closed'], explore: { stage: 'explore', parameter: 'm11', value: 2 },
    withheld: { group: 'eigen-values', stage: 'explore-eigen' }, snapshot: 'predict',
  },
  'vector-orientation-3d': {
    path: ['predict', 'explore-angle', 'explore-cross', 'explain', 'closed'], explore: { stage: 'explore-angle', parameter: 'ux', value: 2.5 },
    withheld: { group: 'cross-values', stage: 'explore-cross' }, snapshot: 'predict',
  },
  'quadratic-surface-gradient': {
    path: ['predict', 'explore-point', 'explore-field', 'explain', 'closed'], explore: { stage: 'explore-point', parameter: 'px', value: 1.5 },
    withheld: { group: 'minimum-values', stage: 'explore-field' }, snapshot: 'predict',
  },
};

let disposers: (() => void)[] = [];
afterEach(() => { for (const dispose of disposers) dispose(); disposers = []; });

// ---------------------------------------------------------------------------------------------------------------
// Expectation and leak scan (computed from the template and an independent evaluation, never from the projection)
// ---------------------------------------------------------------------------------------------------------------
interface ScanContext { template: ActivityTemplate; manifest: ModelManifest; stageId: string; ceiling: ReadonlySet<string>; params: Record<string, number>; position: PositionRequest }

/** Groups the walk expects visible: the stage's groups under the policy ceiling (the walk grants every solution-bearing one). */
function expectedVisible(template: ActivityTemplate, stageId: string, ceiling: ReadonlySet<string>): Set<string> {
  const stage = template.stages.find(item => item.id === stageId)!;
  return new Set(Object.keys(stage.visible).filter(id => ceiling.has(id)));
}
const membersOf = (template: ActivityTemplate, kind: string, groups: ReadonlySet<string>): Set<string> =>
  new Set(template.groups.filter(group => group.kind === kind && groups.has(group.id)).flatMap(group => group.members));

/** Normalizes a magnitude to the four significant digits the projection displays. */
const norm = (value: number): number => value === 0 ? 0 : Number(Math.abs(value).toPrecision(4));
const NUMERAL = /\d+(?:\.\d+)?/g;
function numeralsOf(text: string, out: Set<number>): void {
  for (const match of text.replace(/(\d),(?=\d{3}(?!\d))/g, '$1').matchAll(NUMERAL)) out.add(norm(Number(match[0])));
}
/** Keys whose values are identities, digests or units: their digits are not displayed values. */
const ID_KEYS = new Set(['projectionId', 'projectionDigest', 'activityId', 'frameId', 'expectedRunId', 'runId', 'previewId', 'viewId', 'markId', 'quantityId', 'equationId',
  'alternativeId', 'scenarioId', 'parameter', 'key', 'id', 'unit', 'unitLabel', 'displayUnit', 'displayUnits']);
function numbersIn(value: unknown, out: Set<number>, skipIds: boolean): Set<number> {
  if (typeof value === 'number') { if (Number.isFinite(value)) out.add(norm(value)); }
  else if (typeof value === 'string') numeralsOf(value, out);
  else if (Array.isArray(value)) { out.add(value.length); for (const item of value) numbersIn(item, out, skipIds); }
  else if (value && typeof value === 'object') for (const [key, item] of Object.entries(value)) { if (!skipIds || !ID_KEYS.has(key)) numbersIn(item, out, skipIds); }
  return out;
}
/** Every value of `key` anywhere in the JSON value. */
function valuesOf(value: unknown, key: string, out: unknown[] = []): unknown[] {
  if (Array.isArray(value)) for (const item of value) valuesOf(item, key, out);
  else if (value && typeof value === 'object') for (const [name, item] of Object.entries(value)) { if (name === key) out.push(item); valuesOf(item, key, out); }
  return out;
}
const toRequest = (position: FramePosition): PositionRequest =>
  position.kind === 'index' ? { kind: 'index', index: position.index } : position.kind === 'time' ? { kind: 'time', time: position.time } : { kind: 'static' };

/** Template elements and manifest definitions the learner may see in this stage (the allowed text and number corpus). */
function visibleContent(context: ScanContext, visible: ReadonlySet<string>): unknown[] {
  const { template, manifest } = context;
  const stage = template.stages.find(item => item.id === context.stageId)!;
  const quantities = membersOf(template, 'quantity', visible);
  return [
    template.title, stage,
    template.groups.filter(group => visible.has(group.id)),
    template.views.filter(view => visible.has(view.group)).map(view => ({ ...view, marks: view.marks.filter(mark => visible.has(mark.group)) })),
    template.equations.filter(equation => visible.has(equation.group)),
    template.controls.filter(control => visible.has(control.group)),
    template.scenarios.filter(scenario => visible.has(scenario.group)),
    template.alternatives.filter(alternative => visible.has(alternative.group)),
    Object.entries(manifest.quantities).filter(([id]) => quantities.has(id)), manifest.parameters,
    UI_STATUS, TERMINAL_TEXT,
  ];
}

/** Geometry readable in this stage under the documented gating rules (visibility.ts module comment), and geometry referenced only by absent content. */
function geometrySplit(template: ActivityTemplate, visible: ReadonlySet<string>): { readable: Set<string>; hidden: Set<string> } {
  const quantities = membersOf(template, 'quantity', visible);
  const owners = (id: string) => template.groups.filter(group => group.kind === 'dataset' && group.members.includes(id));
  const readableVia = (id: string, group: string) => owners(id).length ? owners(id).some(owner => visible.has(owner.id)) : visible.has(group);
  const readable = new Set<string>(), referenced = new Set<string>(membersOf(template, 'dataset', new Set(template.groups.map(group => group.id))));
  for (const id of membersOf(template, 'dataset', visible)) readable.add(id);
  for (const view of template.views) {
    if (view.rowsFrom !== undefined) { referenced.add(view.rowsFrom); if (visible.has(view.group) && readableVia(view.rowsFrom, view.group)) readable.add(view.rowsFrom); }
    for (const mark of view.marks) {
      const geometry = mark.bindings.geometry;
      if (geometry === undefined) continue;
      referenced.add(geometry);
      const bound = (['at', 'vector', 'from', 'to', 'vertices', 'value', 'origin'] as const).every(key => mark.bindings[key] === undefined || quantities.has(mark.bindings[key]!));
      if (visible.has(view.group) && visible.has(mark.group) && bound && readableVia(geometry, mark.group)) readable.add(geometry);
    }
  }
  return { readable, hidden: new Set([...referenced].filter(id => !readable.has(id))) };
}

/**
 * Scans one settled learner-facing object (a projection plus its describeCurrentValues text) for content of absent
 * groups. Returns the leaks found (empty when clean) so failures name every offending item at once.
 */
function scanProjection(projection: LearnerProjection, described: string, context: ScanContext): string[] {
  const { template, manifest } = context;
  const visible = expectedVisible(template, context.stageId, context.ceiling);
  const absent = new Set(template.groups.map(group => group.id).filter(id => !visible.has(id)));
  const leaks: string[] = [];
  expect(projection.pendingReveal?.state ?? 'none', 'scan only settled projections').not.toBe('requesting');

  // Structure: exactly the views of visible groups; nothing else of absent groups.
  expect(projection.views.map(view => view.viewId).sort()).toEqual(template.views.filter(view => visible.has(view.group)).map(view => view.id).sort());
  const allowedMarks = new Set(template.views.flatMap(view => view.marks.filter(mark => visible.has(mark.group)).map(mark => mark.id)));
  for (const view of projection.views) for (const mark of view.marks) if (!allowedMarks.has(mark.markId)) leaks.push(`mark ${mark.markId}`);
  const allowedEquations = new Set(template.equations.filter(equation => visible.has(equation.group)).map(equation => equation.id));
  for (const view of projection.views) for (const equation of view.equations) if (!allowedEquations.has(equation.equationId)) leaks.push(`equation ${equation.equationId}`);
  const allowedControls = new Set(template.controls.filter(control => visible.has(control.group)).map(control => control.parameter));
  for (const control of projection.controls) if (!allowedControls.has(control.parameter)) leaks.push(`control ${control.parameter}`);
  for (const scenario of projection.scenarios) if (absent.has(template.scenarios.find(item => item.id === scenario.scenarioId)!.group)) leaks.push(`scenario ${scenario.scenarioId}`);
  for (const alternative of projection.alternatives) if (absent.has(template.alternatives.find(item => item.id === alternative.alternativeId)!.group)) leaks.push(`alternative ${alternative.alternativeId}`);
  const visibleQuantities = membersOf(template, 'quantity', visible);
  const hiddenQuantities = [...membersOf(template, 'quantity', absent)].filter(id => !visibleQuantities.has(id));
  for (const id of valuesOf(projection, 'quantityId')) if (!visibleQuantities.has(id as string)) leaks.push(`quantity ${String(id)}`);
  // Every table is rectangular: one cell per column in every row (segment and vector-field rows included).
  for (const view of projection.views) if (view.table)
    for (const row of view.table.rows) expect(row.cells.length, `${view.viewId} row ${row.key}`).toBe(view.table.columns.length);

  // Independent evaluation of the same request: hidden values are known here without reading the projection.
  const data = evaluateRequest({ manifest, params: context.params, position: context.position }, INSTALLED_KERNELS);
  const geometry = geometrySplit(template, visible);

  // Text: hidden labels and category values appear only when visible content carries the same text.
  const text = JSON.stringify(projection) + described;
  const corpus = JSON.stringify(visibleContent(context, visible)) + JSON.stringify(projection.reviewNotice);
  const shown = (phrase: string) => { const encoded = JSON.stringify(phrase).slice(1, -1); return phrase.length >= 4 && text.includes(encoded) && !corpus.includes(encoded); };
  const hiddenText: [string, string][] = [
    ...hiddenQuantities.map(id => [`quantity label ${id}`, manifest.quantities[id]!.label] as [string, string]),
    ...template.views.filter(view => absent.has(view.group)).flatMap(view => [[`view title ${view.id}`, view.title], [`view description ${view.id}`, view.description]] as [string, string][]),
    ...template.views.flatMap(view => view.marks).filter(mark => absent.has(mark.group)).map(mark => [`mark label ${mark.id}`, mark.label] as [string, string]),
    ...template.equations.filter(equation => absent.has(equation.group)).flatMap(equation => [[`equation label ${equation.id}`, equation.label], [`equation ${equation.id}`, equation.plain.split('{{')[0]!.trim()]] as [string, string][]),
    ...template.groups.filter(group => absent.has(group.id)).map(group => [`group description ${group.id}`, group.description] as [string, string]),
    ...template.content.filter(entry => entry.kind !== 'learner-copy').map(entry => [`content ${entry.id}`, entry.text] as [string, string]),
  ];
  for (const id of hiddenQuantities) {
    const result = data.quantities[id];
    if (result?.status === 'valid' && typeof result.value === 'string') hiddenText.push([`category ${id}`, result.value], [`category ${id}`, result.value.replace(/-/g, ' ')]);
  }
  for (const [what, phrase] of hiddenText) if (shown(phrase)) leaks.push(`${what}: ${JSON.stringify(phrase)}`);

  // Numbers: a hidden value may appear only when a visible source has the same displayed magnitude.
  const visibleNumbers = new Set<number>();
  numbersIn(visibleContent(context, visible), visibleNumbers, false);
  numbersIn(context.params, visibleNumbers, false);
  numbersIn([...visibleQuantities].map(id => data.quantities[id]), visibleNumbers, false);
  numbersIn([...geometry.readable].map(id => data.geometry[id]), visibleNumbers, false);
  numbersIn([projection.activityRevision, projection.policyRevision, projection.presentationRevision, projection.guards.expectedScientificVersion, projection.frame, projection.navigation,
    projection.presentation, projection.reviewNotice, projection.views.map(view => view.table && [view.table.totalRows, view.table.rows.length])], visibleNumbers, false);
  for (const value of [...visibleNumbers]) visibleNumbers.add(norm(Number(formatNumber(value, { precision: 4, locale: 'en' }).replace(/,/g, ''))));
  const projectionNumbers = numbersIn(projection, new Set<number>(), true);
  numeralsOf(described, projectionNumbers);
  const hiddenNumbers = new Map<number, string>();
  for (const id of hiddenQuantities) for (const n of numbersIn(data.quantities[id], new Set(), false)) hiddenNumbers.set(n, `quantity ${id}`);
  for (const id of geometry.hidden) if (data.geometry[id]) for (const n of numbersIn(data.geometry[id], new Set(), false)) if (!hiddenNumbers.has(n)) hiddenNumbers.set(n, `geometry ${id}`);
  for (const [n, source] of hiddenNumbers) if (n !== 0 && projectionNumbers.has(n) && !visibleNumbers.has(n)) leaks.push(`${source} value ${n}`);
  return leaks;
}

// ---------------------------------------------------------------------------------------------------------------
// Walk helpers
// ---------------------------------------------------------------------------------------------------------------
/** Host policy approving the exact installed refs, with every control permitted and `ceiling` as the visible groups. */
function policyForTemplate(template: ActivityTemplate, approved: HostPolicy['approved'][number], ceiling: readonly string[]): HostPolicy {
  return policyFor({
    policyId: `policy-${template.templateId}`.slice(0, 64), approved: [approved], visibleGroups: [...ceiling],
    permittedControls: template.controls.map(control => control.parameter), sampling: { allowed: false, maxPositions: 0 },
    allowedTools: ['discover', 'prepare', 'inspect.learner', 'request-reveal', 'operate.parameters', 'operate.navigation', 'operate.playback', 'operate.presentation', 'summarize', 'save', 'restore', 'close'],
  });
}

interface Run {
  h: Harness; opened: Opened; template: ActivityTemplate; manifest: ModelManifest; activityId: string; ceiling: Set<string>;
}

/** Host-side params of the committed run (host audience; full inspection). */
function committedParams(h: Harness, activityId: string): Record<string, number> {
  const state = h.adapter.getState(activityId, 'host') as { scientific?: { params: Record<string, number> } };
  return { ...state.scientific!.params };
}
function scanNow(run: Run, label: string, projection = run.opened.learner.getProjection(), params = committedParams(run.h, run.activityId)): void {
  const context: ScanContext = { template: run.template, manifest: run.manifest, stageId: projection.stage.id, ceiling: run.ceiling, params, position: toRequest(projection.frame!.position) };
  expect(scanProjection(projection, run.opened.learner.describeCurrentValues(), context), `${run.template.templateId} @ ${label}`).toEqual([]);
}
const solutionIn = (template: ActivityTemplate, groups: ReadonlySet<string>): string[] => template.groups.filter(group => group.solutionBearing && groups.has(group.id)).map(group => group.id);
const displayed = (records: ExposureRecord[], group: string): boolean => records.some(record => record.displayStatus === 'displayed' && record.groups.some(item => item.groupId === group));

async function enterStage(run: Run, to: string): Promise<void> {
  const { h, opened, template, activityId } = run;
  await settled(h, activityId);
  const projection = okOf(await opened.control.requestStageTransition({ operationId: op('stage'), ...activityGuard(opened.learner), toStage: to }));
  expect(projection.stage.id).toBe(to);
  const granted = solutionIn(template, expectedVisible(template, to, run.ceiling));
  // Groups already revealed (reveal scope persists across stages) need no new stage grant.
  const needed = granted.filter(id => !h.host.exposures(activityId).some(record => record.scope === 'reveal' && record.groups.some(item => item.groupId === id)));
  const stageReceipt = h.host.receipts(activityId).at(-1) as { toStage?: string; grant: { groups: { groupId: string }[] } | null };
  expect(stageReceipt.toStage).toBe(to);
  expect(stageReceipt.grant?.groups.map(group => group.groupId).sort() ?? []).toEqual(needed.sort());
  // Persist-before-reveal: the receipt is in, the content is published and waits for this surface's acknowledgement.
  if (needed.length) expect(opened.learner.getProjection().pendingReveal?.state).toBe('awaiting-display');
  await settled(h, activityId);
  ackCurrent(opened.learner);
  await settled(h, activityId);
  expect(opened.learner.getProjection().pendingReveal).toBeNull();
  for (const group of granted) expect(displayed(h.host.exposures(activityId), group), `${template.templateId}: ${group} displayed in ${to}`).toBe(true);
}

async function explore(run: Run, walk: Walk): Promise<void> {
  const { h, opened, template, activityId, manifest } = run;
  const { parameter, value } = walk.explore;
  const control = template.controls.find(item => item.parameter === parameter)!;
  const definition = manifest.parameters[parameter]!;
  expect(value, `${template.templateId}: preview value differs from the committed value`).not.toBe(committedParams(h, activityId)[parameter]);
  // Without an exploration scope a live preview is refused (pointer moves never call the host).
  const before = opened.learner.getProjection();
  const refused = opened.learner.beginPreview({ operationId: op(), ...before.guards, gesture: 'keyboard', parameter });
  expect(refused.ok ? [] : refused.diagnostics.map(item => item.code)).toEqual(['POLICY_DENIED']);
  const groups = [control.group, ...solutionIn(template, expectedVisible(template, walk.explore.stage, run.ceiling))];
  okOf(await opened.control.requestExplorationScope({ operationId: op('scope'), ...activityGuard(opened.learner), groups, parameterDomain: { [parameter]: [definition.min, definition.max] } }));
  await settled(h, activityId);
  const started = okOf(opened.learner.beginPreview({ operationId: op(), ...opened.learner.getProjection().guards, gesture: 'keyboard', parameter }));
  const previewId = started.preview!.previewId;
  expect(started.preview).toEqual({ previewId, parameter });
  const displayUnit = started.controls.find(item => item.parameter === parameter)!.displayUnit;
  const displayValue = displayUnit === definition.unit ? value : convert(value, definition.unit, displayUnit);
  okOf(opened.learner.updatePreview({ operationId: op(), previewId, displayValues: { [parameter]: displayValue } }));
  await until(() => opened.learner.getProjection().frame?.kind === 'tentative');
  const tentative = opened.learner.getProjection();
  expect(tentative.status.ui).toBe('tentative-preview');
  expect(tentative.controls.find(item => item.parameter === parameter)).toMatchObject({ value: before.controls.find(item => item.parameter === parameter)!.value, previewValue: displayValue });
  // The tentative frame is scanned with its own (uncommitted) parameters; the surface acknowledges what it rendered,
  // which marks the exploration scope displayed (a preview exposes what it shows even if it is later cancelled).
  scanNow(run, `${walk.explore.stage} preview`, tentative, { ...committedParams(h, activityId), [parameter]: value });
  const scope = h.host.exposures(activityId).find(record => record.scope === 'exploration' && record.intendedStage === walk.explore.stage)!;
  expect(scope.displayStatus).toBe('authorized');
  ackCurrent(opened.learner);
  await settled(h, activityId);
  expect(h.host.exposures(activityId).find(record => record.exposureId === scope.exposureId)!.displayStatus).toBe('displayed');
  const committed = okOf(await opened.learner.commitPreview({ operationId: op(), ...tentative.guards, previewId }));
  expect(committed.preview).toBeNull();
  expect(committed.frame!.kind).toBe('committed');
  expect(committed.guards.expectedRunId).not.toBe(before.guards.expectedRunId);
  expect(committed.controls.find(item => item.parameter === parameter)!.value).toBe(displayValue);
  expect(committedParams(h, activityId)[parameter]).toBe(value);
  await settled(h, activityId);
  const types = h.host.events(activityId).map(event => event.type);
  for (const type of ['exposure.scope-authorized', 'preview.started', 'preview.observed', 'parameters.committed'] as const) expect(types, `${template.templateId}: ${type}`).toContain(type);
  scanNow(run, `${walk.explore.stage} committed`);
}

async function revealWithheld(run: Run, walk: Walk): Promise<void> {
  const { h, opened, template, activityId } = run;
  const group = walk.withheld.group;
  expect(template.groups.find(item => item.id === group)!.solutionBearing).toBe(true);
  // While the ceiling withholds the group it stays absent, and requestReveal refuses it.
  const refused = await opened.control.requestReveal({ operationId: op('reveal'), ...activityGuard(opened.learner), groups: [group] });
  expect(refused.ok ? [] : refused.diagnostics.map(item => item.code)).toEqual(['POLICY_DENIED']);
  // The host widens its policy; the adapter takes the new revision; the reveal then goes through a receipt.
  run.ceiling.add(group);
  const policy = h.host.amendPolicy({ visibleGroups: [...run.ceiling] });
  okOf(await opened.control.updatePolicy({ operationId: op('policy'), policy }));
  const stillHidden = opened.learner.getProjection();
  expect(stillHidden.policyRevision).toBe(policy.revision);
  const pendingContext = { ...run, ceiling: new Set([...run.ceiling].filter(id => id !== group)) };
  scanNow(pendingContext, `${walk.withheld.stage} before reveal`, stillHidden);
  const revealed = okOf(await opened.control.requestReveal({ operationId: op('reveal'), ...activityGuard(opened.learner), groups: [group] }));
  expect(revealed.pendingReveal).toMatchObject({ state: 'awaiting-display', labels: [template.groups.find(item => item.id === group)!.label] });
  const record = h.host.exposures(activityId).at(-1)!;
  expect(record).toMatchObject({ scope: 'reveal', displayStatus: 'authorized', groups: [{ groupId: group }] });
  // A surface that is not registered cannot acknowledge; the registered, visible surface can.
  opened.learner.acknowledgeDisplay({ projectionId: revealed.projectionId, projectionDigest: revealed.projectionDigest, surfaceId: 'surface-unregistered' });
  await settled(h, activityId);
  expect(displayed(h.host.exposures(activityId), group)).toBe(false);
  ackCurrent(opened.learner);
  await settled(h, activityId);
  expect(displayed(h.host.exposures(activityId), group)).toBe(true);
  expect(h.host.events(activityId).filter(event => event.type === 'reveal.displayed').some(event => JSON.stringify(event.payload).includes(record.exposureId))).toBe(true);
  scanNow(run, `${walk.withheld.stage} after reveal`);
}

async function saveLearnerSnapshot(run: Run): Promise<void> {
  const { h, opened, template, activityId } = run;
  await settled(h, activityId);
  const saved = await opened.control.save({ operationId: op('snapshot'), kind: 'learner-snapshot' });
  if (!saved.ok) throw new Error(JSON.stringify(saved.diagnostics));
  const artifact = saved.artifact;
  const stageId = opened.learner.getProjection().stage.id;
  const visible = expectedVisible(template, stageId, run.ceiling);
  const controls = new Set(opened.learner.getProjection().controls.map(control => control.parameter));
  expect(Object.keys(artifact.scientific.params).every(id => controls.has(id))).toBe(true);
  expect(Object.keys(artifact.presentation.views).every(id => visible.has(template.views.find(view => view.id === id)!.group))).toBe(true);
  expect([artifact.exposures, artifact.reviewRefs, artifact.instance.responses]).toEqual([[], [], []]);
  const annotations = membersOf(template, 'annotation', visible);
  expect(artifact.contentRefs.every(ref => annotations.has(ref))).toBe(true);
  const text = JSON.stringify(artifact);
  const absent = template.groups.filter(group => !visible.has(group.id));
  const hidden = [...absent.flatMap(group => [group.label, group.description]), ...template.content.filter(entry => entry.kind !== 'learner-copy').map(entry => entry.text)];
  expect(hidden.filter(phrase => phrase.length >= 4 && text.includes(JSON.stringify(phrase).slice(1, -1))), `${template.templateId} learner snapshot`).toEqual([]);
}

async function backupAndRestore(run: Run): Promise<void> {
  const { h, opened, template, activityId } = run;
  await settled(h, activityId);
  const saved = await opened.control.save({ operationId: op('save'), kind: 'backup' });
  if (!saved.ok) throw new Error(JSON.stringify(saved.diagnostics));
  const artifact: ActivityArtifact = saved.artifact;
  await settled(h, activityId);
  const original = opened.learner.getProjection();
  const savedEvents = h.host.events(activityId).length;
  // Fresh process: a new host from the durable tables and a new adapter over the same installed catalogue.
  const host = h.host.restoreInto(new MemoryHost({ policy: h.host.policy() }));
  const adapter: StudyHarnessAdapter = createStudyHarnessAdapter({ catalog: h.catalog, host });
  disposers.push(() => adapter.dispose());
  const result = await adapter.restore(JSON.stringify(artifact), { operationId: op('restore'), hostSessionRevision: 0 });
  if (!result.ok) throw new Error(`${template.templateId} restore: ${JSON.stringify(result.diagnostics)}`);
  expect(result.report.restored).toBe('exact');
  const learner = result.prepared.binding('learner', 'surface-restored');
  learner.registerSurface('surface-restored');
  const restored = learner.getProjection();
  expect(restored.status.ui).toBe('restored');
  expect([restored.stage.id, restored.activityRevision, restored.frame!.position, restored.frame!.kind]).toEqual([original.stage.id, original.activityRevision, original.frame!.position, 'committed']);
  expect(restored.controls.map(control => [control.parameter, control.value, control.mode])).toEqual(original.controls.map(control => [control.parameter, control.value, control.mode]));
  expect(restored.views.map(view => [view.viewId, view.marks.map(mark => mark.markId), view.values.map(item => [item.quantityId, item.text]), view.equations.map(item => item.plain)]))
    .toEqual(original.views.map(view => [view.viewId, view.marks.map(mark => mark.markId), view.values.map(item => [item.quantityId, item.text]), view.equations.map(item => item.plain)]));
  const state = adapter.getState(activityId, 'host') as { scientific: { params: Record<string, number> }; exposures: ExposureRecord[] };
  expect(state.scientific.params).toEqual(artifact.scientific.params);
  expect(state.exposures.map(record => [record.exposureId, record.displayStatus])).toEqual(artifact.exposures.map(record => [record.exposureId, record.displayStatus]));
  const context: ScanContext = { template, manifest: run.manifest, stageId: restored.stage.id, ceiling: run.ceiling, params: state.scientific.params, position: toRequest(restored.frame!.position) };
  expect(scanProjection(restored, learner.describeCurrentValues(), context), `${template.templateId} restored`).toEqual([]);
  // Restore re-emits no reveal or prediction events; it appends exactly one artifact.restored.
  await until(() => host.events(activityId).length > savedEvents);
  const appended = host.events(activityId).slice(savedEvents).map(event => event.type);
  expect(appended).toEqual(['artifact.restored']);
  expectValidEvents(host.events(activityId));
  adapter.dispose(activityId);
}

// ---------------------------------------------------------------------------------------------------------------
describe('every installed template through the activity adapter (Node, fixture host)', () => {
  it('covers exactly the installed templates', () => {
    expect(Object.keys(WALKS).sort()).toEqual(INSTALLED_TEMPLATES.map(template => template.templateId).sort());
    for (const template of INSTALLED_TEMPLATES) {
      const walk = WALKS[template.templateId]!;
      const reachable = [template.initialStage, ...walk.path];
      for (let index = 1; index < reachable.length; index++)
        expect(template.transitions.some(item => item.from === reachable[index - 1] && item.to === reachable[index]), `${template.templateId}: ${reachable[index - 1]} → ${reachable[index]}`).toBe(true);
      expect(reachable).toContain(walk.explore.stage);
      expect(reachable).toContain(walk.withheld.stage);
      expect(reachable).toContain(walk.snapshot);
      expect(template.stages.find(stage => stage.id === walk.withheld.stage)!.visible[walk.withheld.group]).toBeDefined();
    }
  });

  it('reports every installed template in getCapabilities with its dimension, controls and rendering needs', () => {
    const h = harness();
    disposers.push(() => h.adapter.dispose());
    const report = h.adapter.getCapabilities();
    expect(report.templates.map(entry => [entry.template.templateId, entry.dimension, entry.lifecycle])).toEqual(INSTALLED_TEMPLATES.map(template => [template.templateId, template.dimension, 'reference-checked']));
    for (const entry of report.templates) {
      const template = INSTALLED_TEMPLATES.find(item => item.templateId === entry.template.templateId)!;
      expect(entry.controls.map(control => control.parameter)).toEqual(template.controls.map(control => control.parameter));
      expect(entry.stages.map(stage => stage.id)).toEqual(template.stages.map(stage => stage.id));
      expect(entry.renderingRequirements.some(item => item.startsWith('webgl'))).toBe(template.dimension === '3d');
    }
  });

  for (const template of INSTALLED_TEMPLATES) {
    it(`${template.templateId}: prepare, stages, preview and commit, reveal, snapshot, backup and restore without hidden content`, async () => {
      const walk = WALKS[template.templateId]!;
      const manifest = INSTALLED_MODELS.find(model => model.modelId === template.model.modelId && model.version === template.model.version)!;
      const ceiling = new Set(template.groups.map(group => group.id).filter(id => id !== walk.withheld.group));
      // The policy approves the exact installed refs (computed from content by the catalogue, never written by hand).
      const entry = createInstalledCatalog().listTemplates().find(item => item.template.templateId === template.templateId)!;
      const h = harness({ policy: policyForTemplate(template, { template: entry.template, model: entry.model }, [...ceiling]) });
      disposers.push(() => h.adapter.dispose());
      const activityId = `act-${template.templateId}`.slice(0, 64);
      const validation = await h.adapter.validate({ activityId, objectiveIds: ['obj-1'], hostSessionId: 'session-1', hostSessionRevision: 0, template: { templateId: template.templateId, version: template.version }, mode: 'approved' });
      expect(validation.diagnostics).toEqual([]);
      expect(validation.ok).toBe(true);
      const opened = await open(h, { activityId, objectiveIds: ['obj-1'], hostSessionId: 'session-1', hostSessionRevision: 0, template: { templateId: template.templateId, version: template.version }, mode: 'approved' });
      const run: Run = { h, opened, template, manifest, activityId, ceiling };
      await settled(h, activityId);
      const first = opened.learner.getProjection();
      expect(first.stage.id).toBe(template.initialStage);
      expect(first.frame?.kind).toBe('committed');
      expect(first.reviewNotice.length).toBeGreaterThan(0);
      scanNow(run, template.initialStage);
      if (walk.snapshot === template.initialStage) await saveLearnerSnapshot(run);

      for (const stage of walk.path) {
        if (stage === 'closed') {
          await backupAndRestore(run);
          await enterStage(run, stage);
          const closed = opened.learner.getProjection();
          expect([closed.views, closed.controls, closed.scenarios, closed.alternatives]).toEqual([[], [], [], []]);
          continue;
        }
        await enterStage(run, stage);
        scanNow(run, stage);
        if (stage === walk.snapshot) await saveLearnerSnapshot(run);
        if (stage === walk.explore.stage) await explore(run, walk);
        if (stage === walk.withheld.stage) await revealWithheld(run, walk);
      }
      await settled(h, activityId);
      const events = h.host.events(activityId);
      expectValidEvents(events);
      expect(events.filter(event => event.type === 'stage.changed')).toHaveLength(walk.path.length);
      expect(events.filter(event => event.type === 'reveal.displayed').length).toBeGreaterThan(0);
      expect(events.some(event => event.actor.kind === 'learner' && event.type === 'parameters.committed')).toBe(true);
    });
  }
});
