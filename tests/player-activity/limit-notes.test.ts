/**
 * Drawing notes of the 2D planner for gaps that are numerical limits (report §8.2: keep reason codes and text for
 * mathematical undefinedness and numerical overflow/underflow limits apart; A11; activity-runtime.md: a numerical limit
 * is never described as not defined; review finding R24). The projection lists which gap reasons of a mark are numerical
 * limits (`limitReasons`); the planner words those as beyond the representable range with their own note kind and keeps
 * `undefined` for mathematical undefinedness. Real quadratic kernel output through the adapter and projection, plus
 * synthetic marks. Fixture-host results with in-process test workers; 3D notes are covered in tests/player-3d.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { ProjectedMark } from '../../packages/activity/src/api';
import { planScene } from '../../packages/player/src/activity/plan';
import { boundsOf, fitFrame } from '../../packages/player/src/activity/scale';
import { ackCurrent, activityGuard, enterExplore, guards, harness, okOf, op, open, settled, template, type Harness } from '../activity/support/adapter-harness';

let current: Harness | null = null;
afterEach(() => { current?.adapter.dispose(); current = null; });
const frame = fitFrame(boundsOf([0, 10, 0, 10]), { x: 40, y: 10, width: 480, height: 320 }, false);
const style = { role: 'primary', dash: 'solid', marker: 'circle', weight: 'regular' } as const;
const mark = (patch: Partial<ProjectedMark>): ProjectedMark => ({ markId: 'm', kind: 'points', label: 'M', style, interactive: false, ...patch }) as ProjectedMark;

describe('2D drawing notes keep numerical limits apart from undefined values (R24)', () => {
  it('points beyond the representable range and undefined points get separate notes with their own kinds and reasons', () => {
    const overflow = 'The position exceeds the largest representable number from n = 644.';
    const undefinedReason = 'Not defined at x = 0.';
    const result = planScene({ marks: [mark({
      markId: 'cloud', label: 'Cloud', limitReasons: [overflow],
      geometry: { kind: 'points2', points: [{ id: 'a', at: [1, 1] }, { id: 'b', at: null, reason: overflow }, { id: 'c', at: null, reason: overflow }, { id: 'd', at: null, reason: undefinedReason }] },
    })] }, frame);
    expect(result.notes.map(note => [note.kind, note.text])).toEqual([
      ['undefined', 'Cloud: 1 point is undefined — Not defined at x = 0. They are not drawn.'],
      ['numerical-limit', 'Cloud: 2 points are beyond the representable range — The position exceeds the largest representable number from n = 644. They are not drawn.'],
    ]);
  });

  it('a mark with nothing to draw because of a numerical limit is noted as beyond the representable range, never as undefined', () => {
    const underflow = 'The loss is nonzero but smaller than the smallest representable number.';
    const result = planScene({ marks: [
      mark({ markId: 'start', kind: 'point', label: 'Start', at: null, undefinedReason: underflow, limitReasons: [underflow] }),
      mark({ markId: 'probe', kind: 'point', label: 'Probe', at: null, undefinedReason: 'the probe is outside the domain' }),
    ] }, frame);
    expect(result.notes).toEqual([
      { markId: 'start', kind: 'numerical-limit', text: 'Start: beyond the representable range — The loss is nonzero but smaller than the smallest representable number. Nothing is drawn for it.' },
      { markId: 'probe', kind: 'undefined', text: 'Probe: undefined — the probe is outside the domain. Nothing is drawn for it.' },
    ]);
  });

  it('the shipped quadratic activity: a diverging trace that overflows is never called undefined in the drawing notes', async () => {
    current = harness();
    const h = current;
    const opened = await open(h);
    await enterExplore(h, opened);
    // η·a = 4: |x_n| doubles every step and overflows near n = 644.
    okOf(await opened.learner.commitParameters({ operationId: op(), ...guards(opened.learner), displayValues: { eta: 2 } }));
    okOf(await opened.learner.navigate({ operationId: op(), ...guards(opened.learner), position: { kind: 'index', index: 700 } }));
    await settled(h);
    // Reveal every solution-bearing group of the stage (host reveal under the full policy) so the trace is drawn too.
    const stage = template.stages.find(item => item.id === opened.learner.getProjection().stage.id)!;
    const groups = template.groups.filter(group => group.solutionBearing && Object.hasOwn(stage.visible, group.id)).map(group => group.id);
    okOf(await opened.control.requestReveal({ operationId: op('reveal'), ...activityGuard(opened.learner), groups }));
    await settled(h);
    ackCurrent(opened.learner);
    await settled(h);
    const projection = opened.learner.getProjection();
    expect(projection.views.flatMap(view => view.marks).some(item => item.markId === 'trace-points'), 'the trace is drawn').toBe(true);
    const graphical = projection.views.filter(view => view.kind === 'scene2d' || view.kind === 'plot2d');
    const notes = graphical.flatMap(view => planScene(view, fitFrame(boundsOf(view.bounds), { x: 40, y: 10, width: 480, height: 320 }, view.equalAspect)).notes);
    const limited = graphical.flatMap(view => view.marks).filter(item => item.limitReasons?.length);
    expect(limited.length, 'the projection classifies the overflow gaps').toBeGreaterThan(0);
    const limitNotes = notes.filter(note => note.kind === 'numerical-limit');
    expect(limitNotes.length).toBeGreaterThan(0);
    for (const note of limitNotes) expect(note.text).toMatch(/beyond the representable range — .*representable/);
    expect(limitNotes.some(note => note.markId === 'trace-points'), 'the overflowed trace points').toBe(true);
    for (const note of notes.filter(item => item.kind === 'undefined')) {
      expect(note.text, 'an overflow is not described as undefined').not.toMatch(/representable/);
    }
  });
});
