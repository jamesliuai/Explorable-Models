/**
 * Projection and server-rendered presentation of comparisons, the clipped state, control sections and stage
 * instructions (report §8.4, §10.1, §10.2, §10.4; gaps G29, G42, G44, G46, G58). Real adapter, catalogue and kernels
 * with in-process test workers and the test-only memory host (fixture-host results, server rendering only).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { computeVisibility, plainSymbol, type ActivityRequest, type ActivityTemplate, type HostPolicy, type LearnerProjection } from '../../packages/activity/src/index';
import { createInstalledCatalog, INSTALLED_TEMPLATES, linearTransformationTemplate, quadraticGradientDescentTemplate, vectorOrientationTemplate } from '../../packages/catalog/src/index';
import { StudyActivitySurface } from '../../packages/player/src/activity/index';
import { controlSections, keptRunLabel } from '../../packages/player/src/activity/StudyActivitySurface';
import { activityGuard, ackCurrent, guards, harness, okOf, op, open, policyFor, settled, type Harness, type Opened } from '../activity/support/adapter-harness';

let current: Harness | null = null;
afterEach(() => { current?.adapter.dispose(); current = null; });

/** Stages walked from the initial stage; the last one before `closed` shows every group of the guided flow. */
const PATHS: Record<string, string[]> = {
  'quadratic-gradient-descent': ['explore-step', 'explore-curvature', 'explain'],
  'function-derivative': ['predict', 'explore-slope', 'explore-derivative', 'explain'],
  'linear-transformation': ['predict', 'explore', 'explore-eigen', 'explain'],
  'vector-orientation-3d': ['predict', 'explore-angle', 'explore-cross', 'explain'],
  'quadratic-surface-gradient': ['predict', 'explore-point', 'explore-field', 'explain'],
};

const entryOf = (template: ActivityTemplate) => createInstalledCatalog().listTemplates().find(item => item.template.templateId === template.templateId)!;
function fullPolicy(template: ActivityTemplate, patch: Partial<HostPolicy> = {}): HostPolicy {
  const entry = entryOf(template);
  return policyFor({
    policyId: `policy-${template.templateId}`.slice(0, 64), approved: [{ template: entry.template, model: entry.model }], visibleGroups: template.groups.map(group => group.id),
    permittedControls: template.controls.map(control => control.parameter), ...patch,
  });
}
async function openTemplate(template: ActivityTemplate, options: { policy?: HostPolicy; stageId?: string; parameters?: Record<string, number> } = {}): Promise<{ h: Harness; opened: Opened; activityId: string }> {
  const h = harness({ policy: options.policy ?? fullPolicy(template) });
  current = h;
  const activityId = `act-pres-${template.templateId}`.slice(0, 64);
  const request: ActivityRequest = {
    activityId, objectiveIds: ['obj-1'], hostSessionId: 'session-1', hostSessionRevision: 0, template: { templateId: template.templateId, version: template.version }, mode: 'approved',
    ...(options.stageId ? { stageId: options.stageId } : {}), ...(options.parameters ? { parameters: options.parameters } : {}),
  };
  const opened = await open(h, request);
  await settled(h, activityId);
  return { h, opened, activityId };
}
async function transition(h: Harness, opened: Opened, activityId: string, toStage: string): Promise<LearnerProjection> {
  okOf(await opened.control.requestStageTransition({ operationId: op('stage'), ...activityGuard(opened.learner), toStage }));
  await settled(h, activityId);
  ackCurrent(opened.learner);
  await settled(h, activityId);
  return opened.learner.getProjection();
}
/** Reveals every solution-bearing group of the current stage (host reveal under the full policy). */
async function revealAll(h: Harness, opened: Opened, activityId: string, template: ActivityTemplate): Promise<LearnerProjection> {
  const stage = template.stages.find(item => item.id === opened.learner.getProjection().stage.id)!;
  const groups = template.groups.filter(group => group.solutionBearing && Object.hasOwn(stage.visible, group.id)).map(group => group.id);
  if (groups.length) {
    okOf(await opened.control.requestReveal({ operationId: op('reveal'), ...activityGuard(opened.learner), groups }));
    await settled(h, activityId);
    ackCurrent(opened.learner);
    await settled(h, activityId);
  }
  return opened.learner.getProjection();
}
const render = (opened: Opened): string => renderToString(createElement(StudyActivitySurface, { binding: opened.learner, theme: 'light' })).replace(/<!-- -->/g, '');
const textOf = (html: string): string => html.replace(/<[^>]+>/g, ' ').replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&amp;/g, '&').replace(/\s+/g, ' ');

describe('control sections (G46, report §10.2)', () => {
  it('projects each control’s section and renders every section as one labelled group, in authored order', async () => {
    for (const [template, expected] of [
      [linearTransformationTemplate, [['Matrix M', ['m11', 'm12', 'm21', 'm22']], ['Test vector v', ['vx', 'vy']]]],
      [vectorOrientationTemplate, [['Vector u', ['ux', 'uy', 'uz']], ['Vector v', ['vx', 'vy', 'vz']]]],
    ] as const) {
      const { opened } = await openTemplate(template, { stageId: 'free-explore' });
      const projection = opened.learner.getProjection();
      expect(controlSections(projection.controls).map(section => [section.section?.label, section.controls.map(control => control.parameter)]), template.templateId).toEqual(expected);
      const html = render(opened);
      for (const [label, parameters] of expected) {
        const group = new RegExp(`<div class="ema-control-section" role="group" aria-labelledby="([^"]+)" data-ema-section="[^"]+"><h3 id="\\1" class="ema-section-title">${label}</h3>(.*?)</div></div>(?=<div class="ema-control-section"|<div class="ema-reset|<div class="ema-inline-status|</section>)`);
        const match = group.exec(html);
        expect(match, `${template.templateId}: group ${label}`).not.toBeNull();
        expect([...match![2]!.matchAll(/data-parameter="([^"]+)"/g)].map(item => item[1])).toEqual(parameters);
      }
      current?.adapter.dispose();
      current = null;
    }
  });

  it('keeps unsectioned controls in place and groups a section where its first control is', () => {
    const control = (parameter: string, section?: { id: string; label: string }) => ({ parameter, ...(section ? { section } : {}) }) as unknown as LearnerProjection['controls'][number];
    const a = { id: 'a', label: 'A' }, b = { id: 'b', label: 'B' };
    expect(controlSections([control('x'), control('y', a), control('z'), control('w', a), control('v', b)]).map(group => [group.section?.id ?? null, group.controls.map(item => item.parameter)]))
      .toEqual([[null, ['x']], ['a', ['y', 'w']], [null, ['z']], ['b', ['v']]]);
  });
});

describe('the clipped state reflects the range the view shows (G42, report §10.2)', () => {
  for (const template of INSTALLED_TEMPLATES) {
    it(`${template.templateId}: every stage of the guided walk and free exploration open at default parameters without out-of-view data`, async () => {
      const { h, opened, activityId } = await openTemplate(template);
      const seen: string[] = [];
      const check = (projection: LearnerProjection) => {
        seen.push(projection.stage.id);
        expect(projection.views.filter(view => view.clipped).map(view => view.viewId), `${template.templateId} @ ${projection.stage.id}`).toEqual([]);
        expect(projection.status.ui, `${template.templateId} @ ${projection.stage.id}`).not.toBe('clipped');
      };
      check(opened.learner.getProjection());
      for (const stage of PATHS[template.templateId]!) { await transition(h, opened, activityId, stage); check(await revealAll(h, opened, activityId, template)); }
      current?.adapter.dispose();
      const free = await openTemplate(template, { stageId: 'free-explore' });
      check(await revealAll(free.h, free.opened, free.activityId, template));
      expect(seen.length).toBe(PATHS[template.templateId]!.length + 2);
    });
  }

  it('linear transformation: a zoomed camera clips the transformed plane, Fit to data clears it, and reference content never counts', async () => {
    const { h, opened, activityId } = await openTemplate(linearTransformationTemplate);
    await transition(h, opened, activityId, 'predict');
    // Zoomed so the reference grid (±3), the unit square and e₁, e₂ leave the range: reference content is background.
    const camera = (zoom: number, center: [number, number] = [0, 0]) => okOf(opened.learner.setCamera({ operationId: op('cam'), expectedPresentationRevision: opened.learner.getProjection().presentationRevision, viewId: 'plane', camera: { kind: '2d', center, zoom } }));
    let projection = camera(6, [1.25, 0.75]);
    const plane = () => opened.learner.getProjection().views.find(view => view.viewId === 'plane')!;
    expect(plane().marks.filter(mark => mark.style.role === 'reference').length).toBeGreaterThan(0);
    expect(projection.views.filter(view => view.clipped).map(view => [view.viewId, view.marks.filter(mark => mark.style.role !== 'reference').map(mark => [mark.markId, mark.at, mark.from, mark.to, mark.vector])])).toEqual([]);
    expect(projection.status.ui).not.toBe('clipped');
    await transition(h, opened, activityId, 'explore');
    await revealAll(h, opened, activityId, linearTransformationTemplate);
    // The zoomed camera persists across the stage change: the transformed grid now leaves it.
    expect(opened.learner.getProjection().status.ui).toBe('clipped');
    okOf(opened.learner.resetView({ operationId: op('reset'), expectedPresentationRevision: opened.learner.getProjection().presentationRevision, viewId: 'plane' }));
    expect(opened.learner.getProjection().status.ui).not.toBe('clipped');
    projection = camera(4);
    expect(plane().clipped).toBe(true);
    expect(projection.status.ui).toBe('clipped');
    // Fit to data (the surface's fitCamera over the drawn extent) shows every data point again.
    const points = plane().marks.filter(mark => mark.style.role !== 'reference' && mark.kind !== 'grid' && mark.extent !== 'line').flatMap(mark => {
      const out: number[][] = [];
      if (mark.geometry?.kind === 'segments2') for (const s of mark.geometry.segments) out.push(s.from, s.to);
      if (mark.geometry?.kind === 'polygon2') out.push(...mark.geometry.vertices);
      if (mark.vector) out.push(mark.from ?? [0, 0], [(mark.from ?? [0, 0])[0]! + mark.vector[0]!, (mark.from ?? [0, 0])[1]! + mark.vector[1]!]);
      return out;
    });
    const xs = points.map(p => p[0]!), ys = points.map(p => p[1]!);
    const extent = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
    const bounds = plane().bounds!;
    const zoom = Math.min((bounds[1] - bounds[0]) / ((extent[1]! - extent[0]!) * 1.16), (bounds[3] - bounds[2]) / ((extent[3]! - extent[2]!) * 1.16));
    projection = camera(zoom, [(extent[0]! + extent[1]!) / 2, (extent[2]! + extent[3]!) / 2]);
    expect(plane().clipped).toBeUndefined();
    expect(projection.status.ui).not.toBe('clipped');
  });
});

describe('comparisons (G29, G44, report §8.4, §10.2)', () => {
  /** x_n = x₀·(1 − η·a)ⁿ written out for the test (independent of the kernel's scaled arithmetic). */
  const x = (eta: number, a: number, x0: number, n: number) => x0 * (1 - eta * a) ** n;

  it('quadratic: the kept run is named by symbol, aligned by iteration index, read at the same n from its own points and bounded by where it was kept', async () => {
    const { h, opened, activityId } = await openTemplate(quadraticGradientDescentTemplate);
    await transition(h, opened, activityId, 'explore-step');
    const scenario = async (eta: number) => { okOf(await opened.learner.applyScenario({ operationId: op('scenario'), ...guards(opened.learner), scenarioId: `step-${eta}` })); await settled(h, activityId); };
    const go = async (index: number) => { okOf(await opened.learner.navigate({ operationId: op('nav'), ...guards(opened.learner), position: { kind: 'index', index } })); await settled(h, activityId); };
    await scenario(0.25);
    await go(10);
    okOf(opened.learner.retainComparison({ operationId: op('keep'), ...guards(opened.learner), label: keptRunLabel(opened.learner.getProjection().controls) }));
    await settled(h, activityId);
    expect(opened.learner.getProjection().comparisons[0]!.label).toBe('η = 0.25, a = 2, x₀ = 4');
    await scenario(1.25);
    await go(3);
    let [comparison] = opened.learner.getProjection().comparisons;
    expect(comparison).toMatchObject({
      ordinal: 1, name: 'η = 0.25', alignment: 'index', positionText: 'n = 10', boundary: null,
      parameterDifferences: [{ parameter: 'eta', symbol: 'η', text: '0.25', currentText: '1.25' }],
    });
    expect(comparison!.frameId).toMatch(/./);
    expect(comparison!.domainNote).not.toMatch(/progress/i);
    const aligned = comparison!.aligned.find(row => row.viewId === 'trace-plot')!;
    expect(aligned).toMatchObject({ label: 'Position x_n', at: 3, current: '−13.5'.replace('−', '-'), kept: '0.5' });
    expect(Number(aligned.current)).toBe(x(1.25, 2, 4, 3));
    expect(Number(aligned.kept)).toBe(x(0.25, 2, 4, 3));
    // The kept run's values at its own n; the overlay draws its trace (dashed) in the trace plot.
    expect(comparison!.values.find(row => row.quantityId === 'index')).toMatchObject({ current: { text: '3' }, kept: { text: '10' } });
    // Readouts carry four significant digits (DISPLAY_PRECISION): 4·0.5¹⁰ = 0.00390625 reads 0.003906.
    expect(comparison!.values.find(row => row.quantityId === 'position')!.kept.text).toBe(Number(x(0.25, 2, 4, 10).toPrecision(4)).toString());
    const overlay = comparison!.overlays.find(item => item.viewId === 'trace-plot')!;
    expect(overlay.marks.map(mark => mark.markId)).toEqual(['trace-points']);
    expect(overlay.marks[0]!.geometry?.kind === 'points2' && overlay.marks[0]!.geometry.points.map(point => point.at?.[0])).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    // Beyond the kept position there is nothing to compare, and the panel says why.
    await go(12);
    [comparison] = opened.learner.getProjection().comparisons;
    expect(comparison!.aligned.find(row => row.viewId === 'trace-plot')).toMatchObject({ at: 12, kept: null, reason: 'The kept run was kept at n = 10 and is not computed beyond it.' });
    expect(comparison!.boundary).toBe('The kept run was kept at n = 10 and is not computed beyond it.');
    const html = render(opened);
    expect(textOf(html)).toContain('Kept run 1: η = 0.25');
    expect(textOf(html)).toContain('Position x_n at n = 12');
    expect(html).toContain('data-ema-comparison-frame-id=');
    expect(html).not.toMatch(/progress/i);
    expect(textOf(html)).toContain('Stop comparing with kept run 1');
  });

  it('quadratic: a kept run that reached a numerical limit states it and its last finite index', async () => {
    const { h, opened, activityId } = await openTemplate(quadraticGradientDescentTemplate, { stageId: 'free-explore' });
    await revealAll(h, opened, activityId, quadraticGradientDescentTemplate);
    okOf(await opened.learner.commitParameters({ operationId: op('commit'), ...guards(opened.learner), displayValues: { eta: 2, a: 2, x0: 4 } }));
    await settled(h, activityId);
    okOf(await opened.learner.navigate({ operationId: op('nav'), ...guards(opened.learner), position: { kind: 'index', index: 1000 } }));
    await settled(h, activityId);
    const kept = opened.learner.getProjection();
    expect(kept.frame?.terminal).toBe(true);
    okOf(opened.learner.retainComparison({ operationId: op('keep'), ...guards(opened.learner), label: 'diverging' }));
    okOf(await opened.learner.commitParameters({ operationId: op('commit'), ...guards(opened.learner), displayValues: { eta: 0.5 } }));
    await settled(h, activityId);
    const [comparison] = opened.learner.getProjection().comparisons;
    // |4·(−3)ⁿ| exceeds the largest double from n = 645 on (3^645 ≈ 2.5·10³⁰⁷, times 4 > 1.8·10³⁰⁸).
    expect(comparison!.boundary).toBe('The kept run ends at n = 1000: The next value cannot be represented; this is a numerical limit, not a computed value. Its last finite value is at n = 644.');
    expect(comparison!.name).toBe('η = 2');
  });

  it('respects visibility: with the trace held back nothing of the kept trace, positions or iterates is projected', async () => {
    const held = quadraticGradientDescentTemplate.groups.filter(group => group.solutionBearing).map(group => group.id);
    const { h, opened, activityId } = await openTemplate(quadraticGradientDescentTemplate, { policy: fullPolicy(quadraticGradientDescentTemplate, { visibleGroups: quadraticGradientDescentTemplate.groups.map(group => group.id).filter(id => !held.includes(id)) }) });
    await transition(h, opened, activityId, 'explore-step');
    okOf(await opened.learner.navigate({ operationId: op('nav'), ...guards(opened.learner), position: { kind: 'index', index: 4 } }));
    await settled(h, activityId);
    okOf(opened.learner.retainComparison({ operationId: op('keep'), ...guards(opened.learner), label: 'kept' }));
    okOf(await opened.learner.applyScenario({ operationId: op('scenario'), ...guards(opened.learner), scenarioId: 'step-1.25' }));
    await settled(h, activityId);
    const [comparison] = opened.learner.getProjection().comparisons;
    expect(comparison!.aligned).toEqual([]);
    expect(comparison!.overlays.flatMap(item => item.marks.map(mark => mark.markId)).filter(id => /trace|iterate/.test(id))).toEqual([]);
    expect(comparison!.values.map(row => row.quantityId).filter(id => ['position', 'loss', 'gradient', 'multiplier', 'product', 'regime', 'threshold'].includes(id))).toEqual([]);
    const html = render(opened);
    for (const hidden of ['Position by iteration', 'Update multiplier', 'Iterates (x_k', 'trace-points']) expect(html).not.toContain(hidden);
  });

  it('linear transformation (static): every differing parameter is named by its symbol and nothing speaks of progress', async () => {
    const { h, opened, activityId } = await openTemplate(linearTransformationTemplate, { stageId: 'free-explore' });
    await revealAll(h, opened, activityId, linearTransformationTemplate);
    okOf(opened.learner.retainComparison({ operationId: op('keep'), ...guards(opened.learner), label: keptRunLabel(opened.learner.getProjection().controls) }));
    const before = opened.learner.getProjection().controls;
    okOf(await opened.learner.commitParameters({ operationId: op('commit'), ...guards(opened.learner), displayValues: { m11: 2, m22: -1, vx: 0.5 } }));
    await settled(h, activityId);
    const [comparison] = opened.learner.getProjection().comparisons;
    const keptValue = (parameter: string) => String(before.find(control => control.parameter === parameter)!.value);
    expect(comparison!.name).toBe(`m₁₁ = ${keptValue('m11')}, m₂₂ = ${keptValue('m22')}, v_x = ${keptValue('vx')}`.replace(/-/g, '−'));
    expect(comparison!.parameterDifferences.map(diff => diff.symbol)).toEqual(['m₁₁', 'm₂₂', 'v_x']);
    expect(comparison).toMatchObject({ alignment: 'static', positionText: null, boundary: null, aligned: [] });
    expect(comparison!.values.map(row => row.quantityId)).toContain('determinant');
    expect(comparison!.overlays.find(item => item.viewId === 'plane')!.marks.map(mark => mark.markId)).toEqual(expect.arrayContaining(['image-e1', 'image-vector']));
    const html = render(opened);
    expect(html).not.toMatch(/progress/i);
    expect(textOf(html)).toContain(`Kept run 1: ${comparison!.name}`);
    // Never the garbled “1) = 1.5, 2) = 1” built from the last word of each control label.
    expect(html).toContain(`<span class="ema-comparison-name">${comparison!.name}</span>`);
    expect(comparison!.name).not.toMatch(/\d\) = /);
  });

  it('vector orientation: the name lists every differing component by symbol (never only the first four)', async () => {
    const { h, opened, activityId } = await openTemplate(vectorOrientationTemplate, { stageId: 'free-explore' });
    await revealAll(h, opened, activityId, vectorOrientationTemplate);
    okOf(opened.learner.retainComparison({ operationId: op('keep'), ...guards(opened.learner), label: keptRunLabel(opened.learner.getProjection().controls) }));
    const label = opened.learner.getProjection().comparisons[0]!.label;
    expect(label.split(', ').map(part => part.split(' = ')[0])).toEqual(['u_x', 'u_y', 'u_z', 'v_x', 'v_y', 'v_z']);
    okOf(await opened.learner.commitParameters({ operationId: op('commit'), ...guards(opened.learner), displayValues: { ux: -1, uy: 3, uz: 2.5, vx: -2, vy: -3, vz: -0.5 } }));
    await settled(h, activityId);
    const [comparison] = opened.learner.getProjection().comparisons;
    expect(comparison!.name.split(', ').map(part => part.split(' = ')[0])).toEqual(['u_x', 'u_y', 'u_z', 'v_x', 'v_y', 'v_z']);
  });

  it('plain symbols come from the manifest TeX symbols', () => {
    expect(['\\eta', 'm_{11}', 'x_0', 'u_x', 'p_y', '\\theta', 'a'].map(plainSymbol)).toEqual(['η', 'm₁₁', 'x₀', 'u_x', 'p_y', 'θ', 'a']);
  });
});

describe('stage instructions never assert content the projection omits (G58, report §10.1)', () => {
  /** Positive visibility assertions (“… is now shown”, “… are shown”, “shown as well”) outside a conditional sentence. */
  const assertions = (instruction: string): string[] => instruction.split(/(?<=\.)\s+/).filter(sentence =>
    /\b(?:is|are)\s+(?:now\s+)?shown\b|\bshown\s+as\s+well\b|\bnow\s+shows?\b/i.test(sentence)
    && !/^(?:when|once|before|after|if|until)\b/i.test(sentence.trim()) && !/\bnot\b/i.test(sentence));

  for (const template of INSTALLED_TEMPLATES) {
    it(`${template.templateId}: under the held policy every stage's instruction is consistent with what is visible at stage entry`, () => {
      const entry = entryOf(template);
      const solution = new Set(template.groups.filter(group => group.solutionBearing).map(group => group.id));
      const held = fullPolicy(template, { visibleGroups: template.groups.map(group => group.id).filter(id => !solution.has(id)) });
      for (const stage of template.stages) {
        // At stage entry no exposure covers anything yet (a host can enter any stage directly).
        const groups = computeVisibility(template, stage, held, [], { kind: 'instructional', digests: {}, template: entry.template, model: entry.model });
        const absentAtEntry = Object.keys(stage.visible).filter(id => groups[id] === 'absent');
        expect(absentAtEntry.every(id => solution.has(id)), `${stage.id}: only held solution groups are absent`).toBe(true);
        if (absentAtEntry.length) expect(assertions(stage.instruction), `${template.templateId} @ ${stage.id}: ${stage.instruction}`).toEqual([]);
      }
    });
  }
});
