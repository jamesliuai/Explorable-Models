/**
 * Learner-surface outputs that follow the projection (report §5.3, §6.2, §14): captures only under the host policy's
 * `export.capture` (G10), no `0` (or blank) for a non-finite number the surface formats itself (G56), and the archival
 * read-only record component (G20/G69). Fixture-host results with in-process test workers; browser behaviour is covered
 * by tests/browser/study-quadratic.spec.ts and study-lifecycle.spec.ts.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { archivalView, type ArchivalView, type ProjectedView } from '../../packages/activity/src/index';
import { ArchivalRecord, archivalLabels } from '../../packages/player/src/activity/archival';
import { captureRejection } from '../../packages/player/src/activity/capture';
import { checkDraft, formatPosition, formatShown } from '../../packages/player/src/activity/format';
import { coordinateRows } from '../../packages/player/src/activity/project3d';
import { enterExplore, guards, harness, manifest, okOf, op, open, policyFor, settled, template, type Harness } from '../activity/support/adapter-harness';

let current: Harness | null = null;
afterEach(() => { current?.adapter.dispose(); current = null; });

describe('capture follows the host policy (G10)', () => {
  it('refuses with CAPTURE_REJECTED when export.capture is false and allows the same committed state when it is true', async () => {
    current = harness();
    const opened = await open(current);
    await enterExplore(current, opened);
    const denied = captureRejection(opened.learner.getProjection());
    expect(denied).toMatchObject({ code: 'CAPTURE_REJECTED', message: 'The host policy does not allow captures of this activity.' });
    expect(denied!.recovery).toMatch(/host/);
    okOf(await opened.control.updatePolicy({ operationId: op(), policy: current.host.amendPolicy({ export: { learnerSnapshot: true, capture: true, backup: true } }) }));
    expect(captureRejection(opened.learner.getProjection())).toBeNull();
  });

  it('fails closed for a projection without an explicit grant', async () => {
    current = harness({ policy: policyFor({ export: { learnerSnapshot: true, capture: true, backup: true } }) });
    const opened = await open(current);
    const { permissions: _permissions, ...rest } = opened.learner.getProjection();
    expect(captureRejection(rest as never)).toMatchObject({ code: 'CAPTURE_REJECTED' });
  });
});

describe('non-finite numbers the surface formats never read as 0 (G56)', () => {
  it('formatShown names NaN and infinities', () => {
    expect(formatShown(Number.NaN)).toBe('undefined');
    expect(formatShown(Number.POSITIVE_INFINITY)).toBe('∞');
    expect(formatShown(Number.NEGATIVE_INFINITY)).toBe('−∞');
    expect(formatShown(0)).toBe('0');
    expect(formatShown(-2.5)).toBe('−2.5');
  });

  it('time positions, draft range explanations and coordinate tables carry the explicit text', () => {
    expect(formatPosition({ kind: 'time', value: Number.NaN, max: 4 })).toBe('t = undefined of 4');
    expect(formatPosition({ kind: 'time', value: 1, max: Number.POSITIVE_INFINITY })).toBe('t = 1 of ∞');
    const check = checkDraft({ min: 0, max: Number.POSITIVE_INFINITY, integer: false, unitLabel: 'm' }, '-1');
    expect(check).toMatchObject({ ok: false, message: expect.stringContaining('from 0 to ∞ m') });
    const view = { marks: [{ markId: 'p', label: 'P', kind: 'point', at: [Number.NaN, 1, Number.POSITIVE_INFINITY] }] } as unknown as ProjectedView;
    expect(coordinateRows(view)[0]!.cells[0]).toBe('(undefined, 1, ∞)');
    for (const text of [formatPosition({ kind: 'time', value: Number.NaN, max: null }), coordinateRows(view)[0]!.cells[0]!]) expect(text).not.toMatch(/(^|[^0-9.])0([^0-9.]|$)/);
  });
});

/** Visible text of server-rendered HTML (tags removed, entities decoded, whitespace collapsed). */
const visibleText = (html: string): string => html.replace(/<!--[\s\S]*?-->/g, '').replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/\s+/g, ' ').trim();
/** Internal identifiers of a saved record that a learner or tutor record must not show anywhere (report §10.4, R19/R29). */
const internalIds = (view: ArchivalView): string[] => [view.artifact.artifactId, view.template.templateId, view.model.modelId, view.activity.stageId, view.activity.activityId];
/** Text of every parameter row header and every exposure list entry, split into the names it lists. */
function listedNames(html: string): string[] {
  const rows = [...html.matchAll(/<th scope="row">([\s\S]*?)<\/th>/g)].map(match => visibleText(match[1]!));
  const items = [...html.matchAll(/<li>([\s\S]*?)<\/li>/g)].map(match => visibleText(match[1]!).replace(/:[^:]*$/, ''));
  return [...rows, ...items.flatMap(item => item.split(', '))];
}
/** Group and parameter IDs (short words such as `a` or `trace`): never a listed name. */
function expectNoListedIds(html: string, view: ArchivalView, label: string): void {
  const names = listedNames(html);
  for (const id of [...view.exposures.flatMap(item => item.groups), ...(view.parameters ?? []).map(item => item.parameter)]) expect(names, `${label}: ${id}`).not.toContain(id);
}

describe('archival read-only record component (G20/G69)', () => {
  async function savedBackup(eta = 0.6) {
    current = harness();
    const opened = await open(current);
    await enterExplore(current, opened);
    okOf(await opened.learner.commitParameters({ operationId: op(), ...guards(opened.learner), displayValues: { eta } }));
    await settled(current);
    const saved = await opened.control.save({ operationId: op(), kind: 'backup' });
    if (!saved.ok) throw new Error(JSON.stringify(saved.diagnostics));
    return { opened, artifact: saved.artifact };
  }
  const viewOf = (artifact: unknown, audience: ArchivalView['audience']): ArchivalView => {
    const archived = archivalView(artifact, { audience });
    if (!archived.ok) throw new Error(JSON.stringify(archived.diagnostics));
    return archived.view;
  };

  it('renders the learner view of a backup: no internal identifiers, the saved step, position and exposure history by name, no values or hidden content, only the host return action', async () => {
    const { artifact } = await savedBackup();
    const view = viewOf(artifact, 'learner');
    let selected = 0;
    const html = renderToString(createElement(ArchivalRecord, {
      view, headingLevel: 3, labels: archivalLabels(template), returnAction: { label: 'Return to the session', onSelect: () => { selected++; } },
    }));
    const text = visibleText(html);
    expect(html).toContain('<h3');
    expect(text).toContain(`${template.title} — saved, read-only`);
    expect(text).toContain('Saved step Exploration');
    expect(text).toContain('n = 0 of 1000');
    expect(text).toContain('A saved copy of the activity');
    expect(text).toContain('The saved settings are kept with the record');
    // Exposure history by the template's group names, never by group ID.
    const shownGroup = template.groups.find(group => view.exposures.some(item => item.groups.includes(group.id)))!;
    expect(text).toContain(`${shownGroup.label}`);
    // No raw identifier of any kind: artifact UUID, template, model, stage, activity and group IDs, journal sequence.
    for (const id of internalIds(view)) expect(text, id).not.toContain(id);
    expectNoListedIds(html, view, 'learner');
    expect(text).not.toMatch(/Event \d+|Journal checkpoint|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/);
    expect(text).not.toContain(template.version);
    // The only control is the host's return action.
    expect(html.match(/<(input|select|textarea)\b/g)).toBeNull();
    expect(html.match(/<button\b[^>]*>/g)).toHaveLength(1);
    expect(text).toContain('Return to the session');
    expect(selected).toBe(0);
    expect(text).not.toContain('0.6');
    const hidden = template.groups.filter(group => group.solutionBearing && group.kind === 'quantity').flatMap(group => group.members).map(id => manifest.quantities[id]!.label)
      .filter(label => !['Position', 'Loss', 'Gradient', 'Regime'].includes(label));
    for (const label of [...hidden, ...template.equations.map(equation => equation.label), manifest.constraints[0]!.message.slice(0, 40)]) expect(html, label).not.toContain(label);
    // The host audience lists the saved identities and values (diagnostic detail).
    const host = renderToString(createElement(ArchivalRecord, { view: viewOf(artifact, 'host') }));
    expect(host).toContain('0.6');
    expect(host).toContain(`${template.templateId} ${template.version}`);
    expect(host).toContain(artifact.artifactId);
    expect(host).toContain('explore-step');
  });

  it('without host names a learner or tutor record still shows no identifiers: unnamed content is counted, unnamed values are not listed', async () => {
    const { opened, artifact } = await savedBackup(0.75);
    const saved = await opened.control.save({ operationId: op(), kind: 'learner-snapshot' });
    if (!saved.ok) throw new Error(JSON.stringify(saved.diagnostics));
    for (const audience of ['learner', 'tutor'] as const) {
      // A backup's exposure history without host names: the content is counted, never named by group ID.
      const backup = viewOf(artifact, audience);
      expect(backup.exposures.length).toBeGreaterThan(0);
      const backupHtml = renderToString(createElement(ArchivalRecord, { view: backup }));
      expect(visibleText(backupHtml)).toMatch(/\d+ parts? of the activity: (shown|potentially shown)/);
      expectNoListedIds(backupHtml, backup, `${audience} backup`);
      for (const id of internalIds(backup)) expect(visibleText(backupHtml), `${audience} backup: ${id}`).not.toContain(id);
      const view = viewOf(saved.artifact, audience);
      expect(view.parameters!.length).toBeGreaterThan(0);
      const html = renderToString(createElement(ArchivalRecord, { view }));
      const text = visibleText(html);
      for (const id of internalIds(view)) expect(text, `${audience}: ${id}`).not.toContain(id);
      expectNoListedIds(html, view, audience);
      expect(text).toContain('Saved activity — read-only record');
      expect(text).toMatch(/saved values? (is|are) kept but not listed here, because (its name is|their names are) not available/);
      expect(text).not.toMatch(/Event \d+/);
      // Names for another template version are ignored rather than mislabelling the record.
      const other = visibleText(renderToString(createElement(ArchivalRecord, { view, labels: { ...archivalLabels(template), template: { templateId: template.templateId, version: '9.9.9' } } })));
      expect(other).not.toContain(template.title);
      // With the template's names, the visible values are listed by control label.
      const namedHtml = renderToString(createElement(ArchivalRecord, { view, labels: archivalLabels(template) }));
      const named = visibleText(namedHtml);
      const eta = template.controls.find(control => control.parameter === 'eta')!;
      expect(named).toContain(`${eta.label} 0.75`);
      for (const id of internalIds(view)) expect(named, `${audience} named: ${id}`).not.toContain(id);
      expectNoListedIds(namedHtml, view, `${audience} named`);
    }
  });
});
