/**
 * Terminal outcome, navigation and comparisons as learner content (report §6.2, §6.4, §10.2; activity-runtime §3;
 * A21, A25, A34). The end text of a run says "numerical limit" only where the projection shows the value or drawn gap
 * at the limit, so a hidden trace's outcome (divergence vs convergence) never reaches a learner channel; navigation and
 * playback are content of the groups that carry the position and leave an independent card whose neutral scaffold does
 * not keep them; retained runs stay out of independent work and never claim the same settings when settings differ.
 * Fixture-host results with in-process test workers.
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
  COMPARISON_NAMES, describeProjection, navigationVisibility, numericalLimitShown, PLAYBACK_LIMIT_NOTICE, positionGroupIds, TERMINAL_TEXT, UI_STATUS, VALUE_STATUS_TEXT,
  type ActivityBinding, type HostPolicy, type LearnerProjection,
} from '@experiment-kit/activity';
import {
  ackCurrent, activityGuard, codesOf, enterExplore, guards, harness, manifest, okOf, op, open, requestFor, settled, template, until, type Harness, type Opened,
} from './support/adapter-harness.js';

let current: Harness | null = null;
const make = (...args: Parameters<typeof harness>) => (current = harness(...args));
afterEach(() => { current?.adapter.dispose(); current = null; });

/** Outcome text of a numerical limit in every learner channel (the template's own static copy is the same for every run). */
const LIMIT_TEXTS = [TERMINAL_TEXT['numerical-limit'], PLAYBACK_LIMIT_NOTICE, VALUE_STATUS_TEXT['numerical-limit'], VALUE_STATUS_TEXT.mixed, 'Its last finite value'];
const showsLimit = (text: string): boolean => LIMIT_TEXTS.some(item => text.includes(item));
const DIVERGENT = 2, CONVERGENT = 0.25;

/**
 * Every learner channel of a projection except the parameter controls (whose values legitimately differ between the
 * two runs): status, end of run, navigation, view summaries, readouts, equations, tables, comparisons and the
 * accessible description. Frame identities are left out; they name the run, not its outcome.
 */
function learnerChannels(binding: ActivityBinding) {
  const projection = binding.getProjection();
  const { frameId: _frameId, ...frame } = projection.frame ?? { frameId: null };
  return {
    status: { ui: projection.status.ui, message: projection.status.message, cause: projection.status.cause ?? null },
    frame, navigation: projection.navigation,
    views: projection.views.map(view => ({ id: view.viewId, summary: view.summary, values: view.values.map(value => `${value.quantityId}=${value.text}`), equations: view.equations.map(item => item.plain), rows: view.table?.totalRows ?? null })),
    comparisons: projection.comparisons.map(item => ({ name: item.name, boundary: item.boundary })),
    described: describeProjection({ ...projection, controls: [] }),
  };
}
const allText = (projection: LearnerProjection) => JSON.stringify({ ...projection, controls: [] });

async function freeExplore(eta: number): Promise<Opened> {
  const h = make();
  const opened = await open(h, requestFor({ stageId: 'free-explore', parameters: { a: 2, eta, x0: 4 } }));
  await settled(h);
  return opened;
}
async function navigateTo(opened: Opened, index: number): Promise<void> {
  okOf(await opened.learner.navigate({ operationId: op('nav'), ...guards(opened.learner), position: { kind: 'index', index } }));
  await settled(current!);
}

describe('terminal outcome text is content of the groups that show the limit (A21; R02)', () => {
  it('declares the iteration index group as the quadratic position group', () => {
    expect(positionGroupIds(template, manifest)).toEqual(['navigation']);
  });

  for (const index of [1000, 700]) {
    it(`a divergent and a convergent run read the same at n = ${index} while the trace and values are hidden`, async () => {
      const texts: ReturnType<typeof learnerChannels>[] = [];
      for (const eta of [DIVERGENT, CONVERGENT]) {
        const opened = await freeExplore(eta);
        expect(opened.learner.getProjection().views.map(view => view.viewId)).not.toContain('trace-plot');
        await navigateTo(opened, index);
        const projection = opened.learner.getProjection();
        // The divergent run's frame is at a numerical limit, but no shown value or drawing carries it.
        expect(showsLimit(allText(projection))).toBe(false);
        texts.push(learnerChannels(opened.learner));
        current!.adapter.dispose();
      }
      expect(texts[0]).toEqual(texts[1]);
      if (index === 1000) expect(texts[0]!.status).toEqual({ ui: 'boundary', message: TERMINAL_TEXT['max-index'], cause: null });
      else expect(texts[0]!.navigation).toMatchObject({ value: 700, terminal: false, canStepForward: true });
    });
  }

  it('states the numerical limit once the trace that reaches it is revealed', async () => {
    const opened = await freeExplore(DIVERGENT);
    await navigateTo(opened, 1000);
    expect(opened.learner.getProjection().status.message).toBe(TERMINAL_TEXT['max-index']);
    okOf(await opened.control.requestReveal({ operationId: op('reveal'), ...activityGuard(opened.learner), groups: ['trace'] }));
    await settled(current!);
    const projection = opened.learner.getProjection();
    expect(projection.status).toMatchObject({ ui: 'boundary', message: TERMINAL_TEXT['numerical-limit'] });
    expect(projection.frame).toMatchObject({ terminal: true, terminalDetail: TERMINAL_TEXT['numerical-limit'] });
    expect(projection.navigation).toMatchObject({ terminal: true, canStepForward: false });
  });

  it('states the numerical limit once the trace that reaches it is revealed (navigation)', async () => {
    const opened = await freeExplore(DIVERGENT);
    await navigateTo(opened, 700);
    expect(opened.learner.getProjection().navigation).toMatchObject({ terminal: false, canStepForward: true });
    okOf(await opened.control.requestReveal({ operationId: op('reveal'), ...activityGuard(opened.learner), groups: ['trace'] }));
    await settled(current!);
    expect(opened.learner.getProjection().navigation).toMatchObject({ terminal: true, canStepForward: false });
  });
  it('states a kept run\'s numerical-limit end only while its limit is shown', async () => {
    const h = make();
    const opened = await open(h);
    await enterExplore(h, opened);
    okOf(await opened.learner.commitParameters({ operationId: op(), ...guards(opened.learner), displayValues: { eta: DIVERGENT } }));
    await navigateTo(opened, 1000);
    okOf(opened.learner.retainComparison({ operationId: op(), ...guards(opened.learner), label: 'Kept run' }));
    okOf(await opened.learner.commitParameters({ operationId: op(), ...guards(opened.learner), displayValues: { eta: CONVERGENT } }));
    await settled(h);
    expect(opened.learner.getProjection().comparisons[0]!.boundary).toContain(TERMINAL_TEXT['numerical-limit']);
    // The host withdraws the trace and the values: the kept run's end is then only its last index.
    const policy = h.host.amendPolicy({ visibleGroups: template.groups.map(group => group.id).filter(id => !['trace', 'observations', 'regime', 'substituted-rule'].includes(id)) });
    okOf(await opened.control.updatePolicy({ operationId: op(), policy }));
    await settled(h);
    const comparison = opened.learner.getProjection().comparisons[0]!;
    expect(comparison.boundary).toBe(`The kept run ends at n = 1000: ${TERMINAL_TEXT['max-index']}`);
    expect(showsLimit(allText(opened.learner.getProjection()))).toBe(false);
  });

  it('judges a shown limit from shown values and drawn gaps only', async () => {
    const opened = await freeExplore(DIVERGENT);
    await navigateTo(opened, 1000);
    const state = current!.adapter.getState('act-quadratic-1', 'host');
    if (!('scientific' in state) || !state.scientific) throw new Error('host state expected');
    const frame = { frameId: 'f', model: template.model, run: { kind: 'committed', runId: 'r' }, params: state.scientific.params, position: state.scientific.position, terminal: { reached: true, event: 'numerical-limit' }, quantities: state.scientific.quantities, geometry: {} } as never;
    const all = Object.fromEntries(template.groups.map(group => [group.id, 'fixed' as const]));
    const none = Object.fromEntries(template.groups.map(group => [group.id, 'absent' as const]));
    expect(numericalLimitShown(template, all, frame)).toBe(true);
    expect(numericalLimitShown(template, { ...none, landscape: 'fixed', start: 'fixed', navigation: 'fixed', regime: 'fixed' }, frame)).toBe(false);
    expect(numericalLimitShown(template, { ...none, observations: 'fixed' }, frame)).toBe(true);
  });
});

/** Playback state a learner channel reaches, with the host's journaled end of playback (host-only, compared as well). */
function playbackOutcome(opened: Opened, play: { ok: boolean; diagnostics?: readonly { code: string; message: string }[] }) {
  const ended = current!.host.events().filter(event => event.type === 'playback.ended').at(-1);
  // The run ID names the run, not its outcome.
  const { runId: _runId, ...end } = (ended?.payload ?? {}) as Record<string, unknown>;
  return { play: play.ok ? 'ok' : play.diagnostics!.map(item => `${item.code}: ${item.message}`), channels: learnerChannels(opened.learner), ended: ended ? end : null };
}
const index = (opened: Opened): number => opened.learner.getProjection().navigation?.value ?? -1;
async function stopped(opened: Opened): Promise<void> {
  await until(() => !opened.learner.getProjection().navigation?.playing, 30_000);
  await settled(current!);
}

describe('playback across a numerical limit the card does not show (A21; R02)', () => {
  it('play from a frame past the hidden limit runs to the last index exactly as a converging run does', async () => {
    const outcomes: ReturnType<typeof playbackOutcome>[] = [];
    for (const eta of [DIVERGENT, CONVERGENT]) {
      const opened = await freeExplore(eta);
      await navigateTo(opened, 994);
      const before = opened.learner.getProjection();
      expect(before.navigation).toMatchObject({ value: 994, terminal: false, allowsPlayback: true, playing: false });
      const play = opened.learner.play({ operationId: op('play'), ...guards(opened.learner) });
      expect(play.ok).toBe(true);
      await stopped(opened);
      expect(showsLimit(allText(opened.learner.getProjection()))).toBe(false);
      outcomes.push(playbackOutcome(opened, play));
      current!.adapter.dispose();
    }
    expect(outcomes[0]).toEqual(outcomes[1]);
    expect(outcomes[0]!.channels.status).toEqual({ ui: 'boundary', message: TERMINAL_TEXT['max-index'], cause: null });
    expect(outcomes[0]!.ended).toMatchObject({ reason: 'terminal', position: { kind: 'index', index: 1000 } });
  });

  it('playback started before the hidden limit runs through it without stopping, notice or refusal', async () => {
    const opened = await freeExplore(DIVERGENT);
    await navigateTo(opened, 642);
    okOf(opened.learner.play({ operationId: op('play'), ...guards(opened.learner) }));
    // The divergent trace leaves the representable range at n = 645 (last finite value at n = 644).
    await until(() => index(opened) >= 648, 30_000);
    const playing = opened.learner.getProjection();
    expect(playing.navigation).toMatchObject({ playing: true, terminal: false });
    expect(playing.status.ui).toBe('playing');
    expect(showsLimit(allText(playing))).toBe(false);
    const state = current!.adapter.getState('act-quadratic-1', 'host');
    if (!('scientific' in state) || !state.scientific) throw new Error('host state expected');
    expect(state.scientific.quantities.position).toMatchObject({ status: 'numerical-limit' });
    okOf(opened.learner.pause({ operationId: op('pause'), ...guards(opened.learner) }));
    await settled(current!);
    expect(opened.learner.getProjection().status).toMatchObject({ ui: 'paused', message: UI_STATUS.paused.message });
    expect(current!.host.events().filter(event => event.type === 'playback.ended')).toEqual([]);
  });

  it('a shown limit still stops playback one step before it with the notice; the notice leaves with the limit and play then crosses it', async () => {
    const opened = await freeExplore(DIVERGENT);
    okOf(await opened.control.requestReveal({ operationId: op('reveal'), ...activityGuard(opened.learner), groups: ['trace'] }));
    await settled(current!);
    await navigateTo(opened, 641);
    okOf(opened.learner.play({ operationId: op('play'), ...guards(opened.learner) }));
    await stopped(opened);
    const shown = opened.learner.getProjection();
    expect(shown.navigation).toMatchObject({ value: 644, playing: false, terminal: false });
    expect(shown.status.message).toContain(PLAYBACK_LIMIT_NOTICE);
    expect(current!.host.events().filter(event => event.type === 'playback.ended').at(-1)!.payload).toMatchObject({ reason: 'numerical-limit', position: { index: 644 } });
    // The host withdraws the trace and the values: the notice described a value no longer shown.
    const policy = current!.host.amendPolicy({ visibleGroups: template.groups.map(group => group.id).filter(id => !['trace', 'observations', 'regime', 'substituted-rule'].includes(id)) });
    okOf(await opened.control.updatePolicy({ operationId: op('policy'), policy }));
    await settled(current!);
    const hidden = opened.learner.getProjection();
    expect(hidden.status).toMatchObject({ ui: 'paused', message: UI_STATUS.paused.message });
    expect(showsLimit(allText(hidden))).toBe(false);
    okOf(opened.learner.play({ operationId: op('play'), ...guards(opened.learner) }));
    await until(() => index(opened) >= 646, 30_000);
    expect(opened.learner.getProjection().navigation?.playing).toBe(true);
    okOf(opened.learner.pause({ operationId: op('pause'), ...guards(opened.learner) }));
  });

  it('a limit that becomes shown while playback crosses it stops playback there, and the end text of that frame says so', async () => {
    const opened = await freeExplore(DIVERGENT);
    await navigateTo(opened, 650);
    okOf(opened.learner.play({ operationId: op('play'), ...guards(opened.learner) }));
    await until(() => index(opened) >= 652, 30_000);
    okOf(await opened.control.requestReveal({ operationId: op('reveal'), ...activityGuard(opened.learner), groups: ['trace'] }));
    await stopped(opened);
    const projection = opened.learner.getProjection();
    expect(projection.navigation!.value).toBeGreaterThanOrEqual(652);
    expect(projection.navigation!.value).toBeLessThan(1000);
    expect(projection.navigation).toMatchObject({ playing: false, terminal: true, canStepForward: false });
    expect(projection.status).toMatchObject({ ui: 'boundary', message: TERMINAL_TEXT['numerical-limit'] });
    expect(current!.host.events().filter(event => event.type === 'playback.ended').at(-1)!.payload).toMatchObject({ reason: 'numerical-limit' });
    // Shown, a frame at the limit is the end of playback for this run.
    expect(codesOf(opened.learner.play({ operationId: op('play'), ...guards(opened.learner) }))).toEqual(['OUT_OF_DOMAIN']);
  });
});

describe('navigation and playback follow the position groups (A25; R02)', () => {
  function independentPolicy(h: Harness, neutralScaffold: string[], permittedTools: HostPolicy['allowedTools'] = ['inspect.learner']): HostPolicy {
    return h.host.amendPolicy({ independentTask: { active: true, taskRef: 'task-new-curvature', permittedTools, neutralScaffold } });
  }

  it('an independent card whose neutral scaffold has no position group shows no navigation and accepts no navigation command', async () => {
    const h = make();
    const opened = await open(h);
    await enterExplore(h, opened);
    okOf(await opened.learner.commitParameters({ operationId: op(), ...guards(opened.learner), displayValues: { eta: DIVERGENT } }));
    await settled(h);
    okOf(await opened.control.enterIndependentTask({ operationId: op(), taskRef: 'task-new-curvature', policy: independentPolicy(h, ['landscape', 'start', 'step-control'], ['inspect.learner', 'operate.navigation', 'operate.playback']) }));
    await settled(h);
    const projection = opened.learner.getProjection();
    expect(projection.navigation).toBeNull();
    expect(navigationVisibility(template, manifest, Object.fromEntries(template.groups.map(group => [group.id, ['landscape', 'start', 'step-control'].includes(group.id) ? 'fixed' as const : 'absent' as const])), 'independent')).toBe('absent');
    expect(opened.learner.describeCurrentValues()).not.toMatch(/Step \d/);
    for (const binding of [opened.learner, opened.tutor]) {
      expect(codesOf(await binding.navigate({ operationId: op(), ...guards(binding), position: { kind: 'index', index: 1000 } }))).toEqual(['INDEPENDENT_CONTEXT']);
      expect(codesOf(await binding.step({ operationId: op(), ...guards(binding), delta: 1 }))).toEqual(['INDEPENDENT_CONTEXT']);
      expect(codesOf(await binding.restartPlayback({ operationId: op(), ...guards(binding) }))).toEqual(['INDEPENDENT_CONTEXT']);
      expect(codesOf(binding.play({ operationId: op(), ...guards(binding) }))).toEqual(['INDEPENDENT_CONTEXT']);
    }
    await settled(h);
    expect(h.host.events().filter(event => event.type === 'position.changed' || event.type === 'playback.started')
      .filter(event => event.sequence > h.host.events().find(item => item.type === 'context.independent-entered')!.sequence)).toEqual([]);
  });

  it('a scaffold that keeps the position group keeps navigation, and a divergent and a convergent run still read the same', async () => {
    const texts: ReturnType<typeof learnerChannels>[] = [];
    for (const eta of [DIVERGENT, CONVERGENT]) {
      const h = make();
      const opened = await open(h);
      await enterExplore(h, opened);
      okOf(await opened.control.enterIndependentTask({ operationId: op(), taskRef: 'task-new-curvature', policy: independentPolicy(h, ['landscape', 'start', 'navigation', 'step-control']) }));
      await settled(h);
      okOf(await opened.learner.commitParameters({ operationId: op(), ...guards(opened.learner), displayValues: { eta } }));
      expect(opened.learner.getProjection().navigation).toMatchObject({ canStepForward: true, allowsPlayback: true });
      await navigateTo(opened, 1000);
      expect(showsLimit(allText(opened.learner.getProjection()))).toBe(false);
      texts.push(learnerChannels(opened.learner));
      h.adapter.dispose();
    }
    expect(texts[0]).toEqual(texts[1]);
  });

  it('a stage that lists the position group only as fixed shows the position without stepping or playback', async () => {
    const fixedNavigation = { ...template, stages: template.stages.map(stage => stage.id === 'free-explore' ? { ...stage, visible: { ...stage.visible, navigation: 'fixed' as const } } : stage) };
    const groups = Object.fromEntries(fixedNavigation.groups.map(group => [group.id, fixedNavigation.stages.find(stage => stage.id === 'free-explore')!.visible[group.id] ?? 'absent' as const]));
    expect(navigationVisibility(fixedNavigation, manifest, groups, 'instructional')).toBe('fixed');
    expect(navigationVisibility(fixedNavigation, manifest, { ...groups, navigation: 'absent' }, 'instructional')).toBe('absent');
    // A template without a position group keeps the stage's navigation in instructional work only.
    const undeclared = { ...template, groups: template.groups.filter(group => group.id !== 'navigation') };
    expect(navigationVisibility(undeclared, manifest, groups, 'instructional')).toBe('interactive');
    expect(navigationVisibility(undeclared, manifest, groups, 'independent')).toBe('absent');
  });
});

describe('retained comparisons (A25, A34; R10)', () => {
  async function keptThenChanged(h: Harness): Promise<Opened> {
    const opened = await open(h);
    await enterExplore(h, opened);
    okOf(await opened.learner.commitParameters({ operationId: op(), ...guards(opened.learner), displayValues: { eta: 1.25 } }));
    await navigateTo(opened, 6);
    okOf(opened.learner.retainComparison({ operationId: op(), ...guards(opened.learner), label: 'Kept run' }));
    okOf(await opened.learner.commitParameters({ operationId: op(), ...guards(opened.learner), displayValues: { eta: CONVERGENT } }));
    await settled(h);
    return opened;
  }

  it('names a difference in a parameter that is not shown instead of calling the runs the same', async () => {
    const h = make();
    const opened = await keptThenChanged(h);
    expect(opened.learner.getProjection().comparisons[0]).toMatchObject({ name: 'η = 1.25', parameterDifferences: [{ parameter: 'eta' }] });
    expect(opened.learner.getProjection().comparisons[0]).not.toHaveProperty('hiddenDifferences');
    const policy = h.host.amendPolicy({ permittedControls: ['a', 'x0'] });
    okOf(await opened.control.updatePolicy({ operationId: op(), policy }));
    const comparison = opened.learner.getProjection().comparisons[0]!;
    expect(comparison).toMatchObject({ name: COMPARISON_NAMES.hiddenOnly, parameterDifferences: [], hiddenDifferences: true });
    expect(JSON.stringify(comparison)).not.toContain('1.25');
    expect(JSON.stringify(comparison)).not.toContain(COMPARISON_NAMES.same);
  });

  it('names shown differences and adds that settings not shown also differ', async () => {
    const h = make();
    const opened = await keptThenChanged(h);
    okOf(await opened.control.requestStageTransition({ operationId: op(), ...activityGuard(opened.learner), toStage: 'explore-curvature' }));
    await settled(h);
    ackCurrent(opened.learner);
    okOf(await opened.learner.commitParameters({ operationId: op(), ...guards(opened.learner), displayValues: { a: 3 } }));
    okOf(await opened.control.updatePolicy({ operationId: op(), policy: h.host.amendPolicy({ permittedControls: ['a', 'x0'] }) }));
    const comparison = opened.learner.getProjection().comparisons[0]!;
    expect(comparison.parameterDifferences.map(item => item.parameter)).toEqual(['a']);
    expect(comparison).toMatchObject({ name: `a = 2, ${COMPARISON_NAMES.hiddenAlso}`, hiddenDifferences: true });
  });

  it('withholds retained runs in independent work, in the projection and the learner snapshot, and shows them again after reopening', async () => {
    const h = make();
    const opened = await keptThenChanged(h);
    expect(opened.learner.getProjection().comparisons).toHaveLength(1);
    const policy = h.host.amendPolicy({ independentTask: { active: true, taskRef: 'task-new-curvature', permittedTools: ['inspect.learner'], neutralScaffold: ['landscape', 'start'] } });
    okOf(await opened.control.enterIndependentTask({ operationId: op(), taskRef: 'task-new-curvature', policy }));
    await settled(h);
    expect(opened.learner.getProjection().comparisons).toEqual([]);
    expect(allText(opened.learner.getProjection())).not.toMatch(/same settings|Kept run/);
    const snapshot = await opened.control.save({ operationId: op(), kind: 'learner-snapshot' });
    if (!snapshot.ok) throw new Error(JSON.stringify(snapshot.diagnostics));
    expect(snapshot.artifact.scientific.comparisons).toEqual([]);
    okOf(await opened.control.reopenInstructional({ operationId: op(), ...activityGuard(opened.learner) }));
    await settled(h);
    expect(opened.learner.getProjection().comparisons).toHaveLength(1);
  });
});
