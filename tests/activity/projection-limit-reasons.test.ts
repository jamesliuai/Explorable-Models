/**
 * The projection classifies every drawn gap (report §8.2, A11; review finding R24): a mark lists the reasons of its
 * missing geometry points, geometry gaps and undefined coordinates whose frame quantity is a numerical limit
 * (`limitReasons`), so renderers word them as beyond the representable range and never as undefined; reasons of
 * mathematically undefined values are not listed. Fixture-host results with in-process test workers.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { projectLearnerView, TERMINAL_TEXT, type ProjectedMark, type Visibility } from '@experiment-kit/activity';
import { modelIdentity, type ModelFrame } from '@experiment-kit/core/model';
import { enterExplore, guards, harness, okOf, op, open, rectangleModel, rectangleTemplate, requestFor, type Harness } from './support/adapter-harness.js';

let current: Harness | null = null;
afterEach(() => { current?.adapter.dispose(); current = null; });

const gapReasons = (mark: ProjectedMark): string[] => {
  const geometry = mark.geometry;
  if (geometry?.kind === 'points2' || geometry?.kind === 'points3') return geometry.points.flatMap(point => point.at || !point.reason ? [] : [point.reason]);
  if (geometry?.kind === 'polyline2' || geometry?.kind === 'polyline3') return geometry.gaps.map(gap => gap.reason);
  return [];
};

describe('limitReasons on projected marks (R24)', () => {
  it('a diverging run lists the overflow gaps of its drawn iterates as numerical limits (a = 10, η = 0.4, x₀ = 10 at n = 700)', async () => {
    current = harness();
    const opened = await open(current, requestFor({ parameters: { a: 10, eta: 0.4, x0: 10 } }));
    await enterExplore(current, opened);
    okOf(await opened.learner.navigate({ operationId: op(), ...guards(opened.learner), position: { kind: 'index', index: 700 } }));
    const marks = opened.learner.getProjection().views.flatMap(view => view.marks);
    const gapped = marks.filter(mark => gapReasons(mark).length);
    expect(gapped.length).toBeGreaterThan(0);
    for (const mark of gapped) {
      for (const reason of gapReasons(mark)) {
        expect(reason, mark.markId).toMatch(/largest representable number/);
        expect(mark.limitReasons, mark.markId).toContain(reason);
      }
    }
    // A mark whose undefined coordinates are a numerical limit lists its `undefinedReason` too.
    for (const mark of marks.filter(item => item.undefinedReason !== undefined && /representable/.test(item.undefinedReason))) expect(mark.limitReasons, mark.markId).toContain(mark.undefinedReason);
  });

  it('classifies each gap by the status of the frame quantity whose reason it carries; undefined ones are not listed', () => {
    const groups: Record<string, Visibility> = Object.fromEntries(rectangleTemplate.groups.map(group => [group.id, 'fixed' as Visibility]));
    const withCorner: typeof rectangleTemplate = {
      ...rectangleTemplate,
      views: rectangleTemplate.views.map(view => view.id !== 'outline' ? view : {
        ...view, marks: [...view.marks, { id: 'corner-point', kind: 'point', group: 'outline-view', label: 'First corner', bindings: { geometry: 'corners' }, style: view.marks[0]!.style }],
      }),
    };
    const limitReason = 'Corner beyond range: the width exceeds the largest representable number.';
    const frame = (extra: ModelFrame['quantities']): ModelFrame => ({
      frameId: 'sha256:' + '1'.repeat(64), model: { modelId: rectangleModel.modelId, version: rectangleModel.version, digest: modelIdentity(rectangleModel).digest },
      run: { kind: 'committed', runId: 'run-1' }, params: { w: 3, h: 4 }, position: { kind: 'static' }, terminal: { reached: false },
      quantities: { perimeter: { status: 'valid', value: 14 }, slope: { status: 'valid', value: 1.3 }, shape: { status: 'valid', value: 'rectangle' }, scale: { status: 'valid', value: [1, 0, 0, 1] }, diagonal: { status: 'valid', value: [3, 4] }, ...extra },
      geometry: { outline: { kind: 'polygon2', vertices: [[0, 0], [3, 0], [3, 4], [0, 4]], degenerate: false }, corners: { kind: 'points2', points: [{ id: 'A', at: null, reason: limitReason }] } },
    });
    const corner = (input: ModelFrame) => projectLearnerView({
      projectionId: 'p-1', activityId: 'act-1', activityRevision: 0, policyRevision: 1, template: withCorner, manifest: rectangleModel, stage: withCorner.stages[0]!,
      context: 'instructional', groups, controls: { w: 'interactive', h: 'interactive' }, frame: input, frameKind: 'committed', committedParams: { w: 3, h: 4 },
      guards: { expectedScientificVersion: 1, expectedRunId: 'run-1' }, preview: null, playing: false, activeScenarioId: null, comparisons: [],
      presentation: { contract: 'study-harness.presentation-snapshot', schemaVersion: '1.0', revision: 0, views: {}, selection: null, layout: 'auto', displayUnits: {}, locale: 'en', formatVersion: '1.0' },
      operational: { forced: null, persistence: 'saved', restored: false, closed: false }, reviewNotice: 'Test', pendingReveal: null,
    }).views.flatMap(view => view.marks).find(mark => mark.markId === 'corner-point')!;
    const limited = corner(frame({ width: { status: 'numerical-limit', code: 'OVERFLOW', reason: 'the width exceeds the largest representable number.' } }));
    expect(limited.at).toBeNull();
    expect(limited.undefinedReason).toBe(limitReason);
    expect(limited.limitReasons).toEqual([limitReason]);
    const undefinedWidth = corner(frame({ width: { status: 'undefined', code: 'NO_WIDTH', reason: 'the width exceeds the largest representable number.' } }));
    expect(undefinedWidth.undefinedReason).toBe(limitReason);
    expect(undefinedWidth).not.toHaveProperty('limitReasons');
    // An unmatched gap counts as undefined (the class the status cause also uses).
    expect(corner(frame({}))).not.toHaveProperty('limitReasons');
  });
});

describe('status cause at a numerical-limit end (activity-runtime §3)', () => {
  it('a boundary at a shown numerical limit carries cause numerical-limit, as its message says (a = 10, η = 0.4, x₀ = 10 at n = 700)', async () => {
    current = harness();
    const opened = await open(current, requestFor({ parameters: { a: 10, eta: 0.4, x0: 10 } }));
    await enterExplore(current, opened);
    okOf(await opened.learner.navigate({ operationId: op(), ...guards(opened.learner), position: { kind: 'index', index: 700 } }));
    const { status } = opened.learner.getProjection();
    expect(status).toMatchObject({ ui: 'boundary', message: TERMINAL_TEXT['numerical-limit'], cause: 'numerical-limit' });
  });

  it('a boundary at the last available step carries no cause; neither does a frame inside the run', async () => {
    current = harness();
    const opened = await open(current);
    await enterExplore(current, opened);
    const max = opened.learner.getProjection().navigation!.max!;
    okOf(await opened.learner.navigate({ operationId: op(), ...guards(opened.learner), position: { kind: 'index', index: max } }));
    const atEnd = opened.learner.getProjection().status;
    expect(atEnd).toMatchObject({ ui: 'boundary', message: TERMINAL_TEXT['max-index'] });
    expect(atEnd).not.toHaveProperty('cause');
    okOf(await opened.learner.navigate({ operationId: op(), ...guards(opened.learner), position: { kind: 'index', index: 1 } }));
    expect(opened.learner.getProjection().status).not.toHaveProperty('cause');
  });
});
