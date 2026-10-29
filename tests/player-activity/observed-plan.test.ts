/**
 * 2D rendering of observed data and sampling disclosure (report §8.5, A13, A34): observed rows are separate markers with
 * missing rows left out and explained, never a connecting path; a sampled polyline states its sampling. The SSR part
 * renders the example observed-data activity through the real adapter, controller, projection and model worker
 * protocol (in-process test workers; fixture-host results only).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { templateRef, type ActivityCatalog, type CatalogEntryStatus, type ProjectedMark } from '../../packages/activity/src/index';
import type { ObservationGeometry } from '../../packages/core/src/model/index';
import { modelIdentity } from '../../packages/core/src/model/index';
import { StudyActivitySurface } from '../../packages/player/src/activity/index';
import { companionText } from '../../packages/player/src/activity/capture';
import { selectCaptureView } from '../../packages/player/src/activity/capture-renderer';
import { planScene, samplingNote } from '../../packages/player/src/activity/plan';
import { boundsOf, fitFrame } from '../../packages/player/src/activity/scale';
import { fallingBallManifest as manifest, fallingBallTemplate as template, OBSERVED_TEMPLATE_ID } from '../../examples/study-harness-observed/content';
import { activityGuard, harness, okOf, op, open, policyFor, requestFor, settled, type Harness } from '../activity/support/adapter-harness';

const style = { role: 'secondary' as const, dash: 'solid' as const, marker: 'diamond' as const, weight: 'regular' as const };
const frame = fitFrame([-1, 3, -2, 22], { x: 40, y: 10, width: 400, height: 300 }, false);
const observed: ObservationGeometry = {
  kind: 'observations2', dataset: 'drops', columns: ['t', 'h'],
  provenance: { sourceId: 'log', citation: 'Test log.', description: 'Test values.' },
  points: [
    { row: 0, values: [0, 20] }, { row: 1, values: [0.5, 18.8] }, { row: 2, values: [1, null], reason: 'Hidden behind the stand.' },
    { row: 3, values: [null, 12.4], reason: 'Timestamp not recorded.' }, { row: 4, values: [1.5, 9] }, { row: 5, values: [2, 0.4] },
  ],
};
const observedMark: ProjectedMark = { markId: 'recorded', kind: 'points', label: 'Recorded heights (observed)', style, interactive: false, origin: 'observed', geometry: observed };

describe('scene planning of observed data (§8.5, A13)', () => {
  it('draws one marker per complete row, no path between them, and explains the missing rows', () => {
    const plan = planScene({ marks: [observedMark] }, frame);
    const shapes = plan.marks[0]!.primitives.map(primitive => primitive.shape);
    expect(shapes.map(shape => shape.type)).toEqual(['marker', 'marker', 'marker', 'marker']);
    expect(shapes.every(shape => shape.type === 'marker' && shape.glyph === 'diamond')).toBe(true);
    // Markers sit exactly at the complete rows: nothing is placed at a missing row or between rows.
    expect(shapes.map(shape => shape.type === 'marker' ? frame.fromScreen(shape.x, shape.y).map(v => Math.round(v * 10) / 10) : null))
      .toEqual([[0, 20], [0.5, 18.8], [1.5, 9], [2, 0.4]]);
    expect(plan.notes).toEqual([
      { markId: 'recorded', kind: 'observed', text: 'Recorded heights (observed): 4 observed points are drawn separately; no line joins, interpolates or fits them.' },
      { markId: 'recorded', kind: 'missing', text: 'Recorded heights (observed): 2 of 6 observations have a missing value — Hidden behind the stand; Timestamp not recorded. They are not drawn.' },
    ]);
    expect(plan.extent).toEqual([0, 2, 0.4, 20]);
  });

  it('counts observed points outside the view for the clipped indicator', () => {
    const narrow = fitFrame([0, 1, 0, 30], { x: 40, y: 10, width: 400, height: 300 }, false);
    const plan = planScene({ marks: [observedMark] }, narrow);
    expect(plan.clipped).toEqual([{ markId: 'recorded', label: 'Recorded heights (observed)', count: 2 }]);
  });
});

describe('sampling disclosure of 2D polylines (§8.5, G35)', () => {
  const curve = (kind: ProjectedMark['kind'], sampling?: { samples: number; domain: [number, number] }): ProjectedMark => ({
    markId: 'f', kind, label: 'Graph of f', style: { ...style, role: 'primary', marker: 'none' }, interactive: false,
    geometry: { kind: 'polyline2', segments: [{ points: [[-5, 25], [0, 0], [5, 25]], start: 'none', end: 'none' }], gaps: [], ...(sampling ? { sampling } : {}) },
  });
  it('names the sample count, range and spacing of a sampled curve', () => {
    const plan = planScene({ marks: [curve('curve', { samples: 401, domain: [-5, 5] })] }, fitFrame([-6, 6, -1, 30], { x: 0, y: 0, width: 300, height: 300 }, false));
    expect(plan.notes).toEqual([{ markId: 'f', kind: 'sampling', text: 'Graph of f: 401 samples of its sampling variable from −5 to 5 (spacing 0.025); straight lines join neighbouring samples, so the drawing does not show values between them or features narrower than the spacing.' }]);
  });
  it('says only the samples are drawn for a points mark, and adds no note without sampling metadata', () => {
    expect(samplingNote('S', { samples: 81, domain: [-2, 2] }, false)).toBe('S: 81 samples of its sampling variable from −2 to 2 (spacing 0.05); only the samples are drawn.');
    expect(planScene({ marks: [curve('points', { samples: 3, domain: [-5, 5] })] }, frame).notes.map(note => note.text)).toEqual(['Graph of f: 3 samples of its sampling variable from −5 to 5 (spacing 5); only the samples are drawn.']);
    expect(planScene({ marks: [curve('curve')] }, frame).notes).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------
// The example activity through the real adapter and surface (server render)
// ---------------------------------------------------------------------------------------------
const MODEL = { modelId: manifest.modelId, version: manifest.version, digest: modelIdentity(manifest).digest };
const ACTIVITY = 'act-observed-ssr';
let current: Harness | null = null;
afterEach(() => { current?.adapter.dispose(); current = null; });
const catalog = (createWorker: () => Worker): ActivityCatalog => {
  const ref = templateRef(template);
  const status = (): CatalogEntryStatus => ({ lifecycle: 'validated', reviews: [], revoked: false });
  return {
    listTemplates: () => [{ template: ref, model: MODEL, title: template.title, dimension: '2d', status: status() }],
    getTemplate: request => request.templateId === template.templateId && request.version === template.version ? structuredClone(template) : null,
    getModel: request => request.modelId === manifest.modelId && request.version === manifest.version ? structuredClone(manifest) : null,
    status, createWorker,
  };
};
/** The `<g class="eka-marks">` groups of a rendered figure: every drawn data primitive of the plot. */
const markGroups = (html: string, viewId: string): string => {
  const figure = html.slice(html.indexOf(`data-eka-figure="${viewId}"`));
  return [...figure.slice(0, figure.indexOf('</figure>')).matchAll(/<g class="eka-marks"[^>]*>([\s\S]*?)<\/g>/g)].map(match => match[1]).join('');
};

describe('server render of observed data through the real adapter (§8.5, A13)', () => {
  it('renders the recorded heights as separate markers with no connecting path, labelled and explained', async () => {
    current = harness({ customCatalog: catalog, policy: policyFor({ approved: [{ template: templateRef(template), model: MODEL }], visibleGroups: template.groups.map(group => group.id), permittedControls: ['h0', 'g'] }) });
    const opened = await open(current, requestFor({ activityId: ACTIVITY, template: { templateId: OBSERVED_TEMPLATE_ID, version: template.version } }));
    await settled(current, ACTIVITY);
    let html = renderToString(createElement(StudyActivitySurface, { binding: opened.learner, theme: 'light' }));
    let marks = markGroups(html, 'fall-plot');
    // Observe stage: only the observations are drawn — 8 diamond markers (11 rows, 3 with a missing value), no stroke.
    expect(marks.match(/<path class="eka-role-secondary eka-fill"/g)).toHaveLength(8);
    expect(marks).not.toMatch(/eka-stroke/);
    expect(html).toContain('Recorded heights (observed): 8 observed points are drawn separately; no line joins, interpolates or fits them.');
    expect(html).toContain('Recorded heights (observed): 3 of 11 observations have a missing value — The ball was hidden behind the stand in this frame; Motion blur: no height could be read in this frame; The frame timestamp was not recorded. They are not drawn.');
    // The table is offered as the equivalent alternative (its rows and source line are checked through the capture text below).
    expect(html).toContain('Tables of recorded and predicted heights');
    expect(html).not.toContain('Predicted height');
    // Every y tick label fits left of the plot: the margin follows the fitted ticks (17.5 needs more room than 20).
    const yTicks = [...html.slice(html.indexOf('data-eka-figure="fall-plot"')).matchAll(/<text class="eka-tick" x="([0-9.]+)"[^>]*text-anchor="end">([^<]+)<\/text>/g)].map(match => ({ x: Number(match[1]), text: match[2]! }));
    expect(yTicks.map(tick => tick.text)).toContain('17.5');
    for (const tick of yTicks) expect(tick.x, tick.text).toBeGreaterThanOrEqual([...tick.text].length * 15 * 0.75 * 0.58);

    // Compare stage: the model curve is the only stroke; the observations stay unconnected markers; the legend says which is which.
    okOf(await opened.control.requestStageTransition({ operationId: op('stage'), ...activityGuard(opened.learner), toStage: 'compare' }));
    await settled(current, ACTIVITY);
    html = renderToString(createElement(StudyActivitySurface, { binding: opened.learner, theme: 'light' }));
    marks = markGroups(html, 'fall-plot');
    expect(marks.match(/<path class="eka-role-secondary eka-fill"/g)).toHaveLength(8);
    expect(marks.match(/eka-role-secondary eka-stroke/g)).toBeNull();
    expect(marks.match(/<path class="eka-role-primary eka-stroke"/g)).toHaveLength(1);
    expect(html).toMatch(/Recorded heights \(observed\)<\/tspan>/);
    expect(html).toMatch(/Predicted height \(model\)<\/tspan>/);
    expect(html).toContain('Predicted height (model): 101 samples of its sampling variable from 0 to 1 (spacing 0.01); straight lines join neighbouring samples');
    expect(html).toContain('Landing time (model)');

    const projection = opened.learner.getProjection();
    const capture = companionText(projection, selectCaptureView(projection, 'fall-plot'));
    expect(capture).toContain('Recorded heights (observed): 11 observations, 3 with a missing value (not drawn), drawn as separate points; Predicted height (model).');
    expect(companionText(projection, selectCaptureView(projection, 'recorded-table'))).toMatch(/Observation\tTime \(observed\) \(s\)\tHeight \(observed\) \(m\)[\s\S]*4\t0\.6\tMissing: The ball was hidden behind the stand in this frame\.[\s\S]*Observed data\. Source:/);
  });
});
