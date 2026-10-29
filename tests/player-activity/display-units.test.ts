/**
 * Per-quantity display units (report §8.3, A10): the vector-orientation template evaluates θ in radians and shows it in
 * degrees by default. Conversion happens only at the projection's output boundary (readouts, equations, read-out text,
 * the surface), the unit choice is presentation state (no new run), and incompatible or undeclared units are refused.
 * Real adapter, catalogue and kernel with in-process test workers and the test-only memory host (fixture-host results).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { describeProjection, validateRecord, validateTemplateSemantics, type ActivityBinding, type ActivityTemplate, type LearnerProjection, type ProjectedValue } from '../../packages/activity/src/index';
import { createInstalledCatalog, vectorOrientationManifest as manifest, vectorOrientationTemplate as template } from '../../packages/catalog/src/index';
import { StudyActivitySurface } from '../../packages/player/src/activity/index';
import { valueDisplay } from '../../packages/player/src/activity/format';
import { ackCurrent, activityGuard, codesOf, harness, okOf, op, open, policyFor, presentationGuard, settled, type Harness, type Opened } from '../activity/support/adapter-harness';

let current: Harness | null = null;
afterEach(() => { current?.adapter.dispose(); current = null; });
const ACTIVITY = 'act-units-orientation';

async function openAngle(parameters: Record<string, number> = { ux: 1, uy: 0, uz: 0, vx: 1, vy: 1, vz: 0 }): Promise<{ h: Harness; opened: Opened }> {
  const entry = createInstalledCatalog().listTemplates().find(item => item.template.templateId === template.templateId)!;
  const h = harness({ policy: policyFor({
    policyId: 'policy-units', approved: [{ template: entry.template, model: entry.model }], visibleGroups: template.groups.map(group => group.id),
    permittedControls: template.controls.map(control => control.parameter),
  }) });
  current = h;
  const opened = await open(h, { activityId: ACTIVITY, objectiveIds: ['obj-1'], hostSessionId: 'session-1', hostSessionRevision: 0, template: { templateId: template.templateId, version: template.version }, parameters, mode: 'approved' });
  await settled(h, ACTIVITY);
  for (const stage of ['predict', 'explore-angle']) {
    okOf(await opened.control.requestStageTransition({ operationId: op('stage'), ...activityGuard(opened.learner), toStage: stage }));
    await settled(h, ACTIVITY);
    ackCurrent(opened.learner);
    await settled(h, ACTIVITY);
  }
  return { h, opened };
}
const angleOf = (projection: LearnerProjection): ProjectedValue => projection.views.flatMap(view => view.values).find(value => value.quantityId === 'angle')!;
const equation = (projection: LearnerProjection, id: string) => projection.views.flatMap(view => view.equations).find(item => item.equationId === id)!;
const setUnit = (binding: ActivityBinding, parameter: string, unit: string) =>
  binding.setDisplayUnit({ operationId: op('unit'), ...presentationGuard(binding), parameter, unit: unit as 'deg' });

describe('per-quantity display units (vector-orientation-3d angle)', () => {
  it('declares degrees (default) and radians for the radian-valued angle, and the template validates', () => {
    expect(manifest.quantities.angle!.unit).toBe('rad');
    expect(template.quantityDisplay).toEqual({ angle: { units: ['deg', 'rad'] } });
    expect(validateTemplateSemantics(template, manifest)).toEqual([]);
    expect(validateRecord('study-harness.activity-template', template).ok).toBe(true);
  });

  it('shows degrees by default, converts at the output boundary and round-trips deg → rad → deg as presentation only', async () => {
    const { h, opened } = await openAngle();
    const before = opened.learner.getProjection();
    const angle = angleOf(before);
    expect(angle).toMatchObject({ status: 'valid', unit: 'deg', unitLabel: '°', displayUnits: ['deg', 'rad'], text: '45' });
    expect(angle.value).toBeCloseTo(45, 12);
    expect(valueDisplay(angle)).toMatchObject({ text: '45°', unit: '' });
    expect(equation(before, 'angle-value')).toMatchObject({ plain: 'θ = 45°', tex: '\\theta = 45^{\\circ}' });
    expect(describeProjection(before)).toContain('Angle between u and v: 45°.');
    expect(opened.learner.describeCurrentValues()).toContain('45°');
    const html = renderToString(createElement(StudyActivitySurface, { binding: opened.learner, theme: 'light' }));
    expect(html).toContain('aria-label="Unit for Angle between u and v"');
    expect(html).toContain('45°');

    const events = h.host.events(ACTIVITY).length;
    const radians = okOf(setUnit(opened.learner, 'angle', 'rad'));
    await settled(h, ACTIVITY);
    expect(angleOf(radians)).toMatchObject({ unit: 'rad', unitLabel: 'rad', text: '0.7854' });
    expect(angleOf(radians).value).toBeCloseTo(Math.PI / 4, 15);
    expect(equation(radians, 'angle-value')).toMatchObject({ plain: 'θ = 0.7854 rad', tex: '\\theta = 0.7854\\,\\text{rad}' });
    // Presentation only: same frame, run and scientific version; the presentation revision advances.
    expect(radians.frame!.frameId).toBe(before.frame!.frameId);
    expect(radians.guards).toEqual(before.guards);
    expect(radians.presentationRevision).toBe(before.presentationRevision + 1);
    expect(radians.activityRevision).toBe(before.activityRevision);
    const added = h.host.events(ACTIVITY).slice(events);
    expect(added.map(event => event.type)).toEqual(['view.changed']);
    expect(added[0]!.payload).toMatchObject({ change: 'display-unit', parameter: 'angle', unit: 'rad' });

    const degrees = okOf(setUnit(opened.learner, 'angle', 'deg'));
    expect(angleOf(degrees)).toMatchObject({ unit: 'deg', text: '45' });
    expect(degrees.frame!.frameId).toBe(before.frame!.frameId);
    expect(degrees.guards).toEqual(before.guards);
  });

  it('refuses incompatible, undeclared and hidden display-unit targets without changing anything', async () => {
    const { opened } = await openAngle();
    const before = opened.learner.getProjection();
    expect(codesOf(setUnit(opened.learner, 'angle', 'm'))).toEqual(['UNIT_MISMATCH']);
    expect(codesOf(setUnit(opened.learner, 'angle', 'dimensionless'))).toEqual(['UNIT_MISMATCH']);
    // A visible quantity without declared display units, a hidden quantity and an unknown ID are not unit targets.
    expect(codesOf(setUnit(opened.learner, 'dot', 'dimensionless'))).toEqual(['NOT_FOUND']);
    expect(codesOf(setUnit(opened.learner, 'cross.norm', 'dimensionless'))).toEqual(['NOT_FOUND']);
    expect(codesOf(setUnit(opened.learner, 'no-such-quantity', 'deg'))).toEqual(['NOT_FOUND']);
    const after = opened.learner.getProjection();
    expect(after.presentationRevision).toBe(before.presentationRevision);
    expect(angleOf(after)).toMatchObject({ unit: 'deg', text: '45' });
  });

  it('keeps the chosen unit in learner snapshots and never exposes a hidden quantity unit', async () => {
    const { h, opened } = await openAngle({ ux: 0, uy: 0, uz: 0, vx: 1, vy: 0, vz: 0 });
    // A zero vector: the angle is undefined with a reason in every unit, never 0° or 0 rad.
    expect(angleOf(opened.learner.getProjection())).toMatchObject({ status: 'undefined', unit: 'deg' });
    expect(angleOf(opened.learner.getProjection()).text).toMatch(/^Undefined/);
    okOf(setUnit(opened.learner, 'angle', 'rad'));
    expect(angleOf(opened.learner.getProjection())).toMatchObject({ status: 'undefined', unit: 'rad' });
    await settled(h, ACTIVITY);
    const saved = await opened.control.save({ operationId: op('save'), kind: 'learner-snapshot' });
    expect(saved.ok).toBe(true);
    if (saved.ok) expect(saved.artifact.presentation.displayUnits).toEqual({ angle: 'rad' });
    // A backup restores the declared quantity unit exactly (it is not treated as a narrowed presentation).
    const backup = await opened.control.save({ operationId: op('save'), kind: 'backup' });
    expect(backup.ok).toBe(true);
    if (!backup.ok) return;
    h.adapter.dispose(ACTIVITY);
    const restored = await h.adapter.restore(backup.artifact, { operationId: op('restore'), hostSessionRevision: 0 });
    expect(restored.ok).toBe(true);
    if (!restored.ok) return;
    expect(restored.report.restored).toBe('exact');
    const learner = restored.prepared.binding('learner', 'surface-restored');
    expect(learner.getProjection().presentation.displayUnits).toEqual({ angle: 'rad' });
    expect(angleOf(learner.getProjection())).toMatchObject({ status: 'undefined', unit: 'rad' });
  });

  it('validates declarations: manifest quantities only, compatible units, no clash with a controlled parameter', () => {
    const variant = (quantityDisplay: ActivityTemplate['quantityDisplay']): ActivityTemplate => ({ ...structuredClone(template), quantityDisplay });
    const codes = (candidate: ActivityTemplate) => validateTemplateSemantics(candidate, manifest).map(item => `${item.code} ${item.path}`);
    expect(codes(variant({ angle: { units: ['m'] } }))).toEqual(['UNIT_MISMATCH $.quantityDisplay.angle.units[0]']);
    expect(codes(variant({ missing: { units: ['deg'] } }))).toEqual(['INVALID_REFERENCE $.quantityDisplay.missing']);
    expect(codes(variant({ angle: { units: ['deg', 'deg'] } }))).toEqual(['DUPLICATE_ID $.quantityDisplay.angle.units[1]']);
    // A quantity ID that is also a controlled parameter would make `setDisplayUnit` ambiguous.
    const clashing = structuredClone(manifest);
    clashing.quantities.ux = structuredClone(manifest.quantities.dot!);
    expect(validateTemplateSemantics(variant({ ux: { units: ['dimensionless'] } }), clashing).filter(item => item.path.startsWith('$.quantityDisplay')).map(item => `${item.code} ${item.path}`))
      .toEqual(['DUPLICATE_ID $.quantityDisplay.ux']);
    expect(validateRecord('study-harness.activity-template', variant({ angle: { units: ['grad' as 'deg'] } })).ok).toBe(false);
    expect(validateRecord('study-harness.activity-template', variant({ angle: { units: [] } })).ok).toBe(false);
  });
});
