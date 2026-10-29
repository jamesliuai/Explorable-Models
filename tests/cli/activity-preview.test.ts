/**
 * Authoring diagnostics, learner-scoped captures and the author/learner preview (report §15.2):
 *
 * - a package with an unused group, a never-visible view, a clipped mark, overlapping labels and a malformed equation
 *   reports each: the two template warnings and the TeX parse warning (`MATH_FALLBACK`) from `validate`, `CLIPPED`,
 *   `LABEL_CALLOUT` (the crowded label drawn as a numbered callout) and `MATH_FALLBACK` from the mounted surface
 *   (`capture`, and the preview's diagnostics panel);
 * - `capture --policy <file>` captures the learner view under a supplied host policy, which is validated and never
 *   widened: solution-bearing groups the stage or the ceiling withholds are absent from every output;
 * - `preview` serves on 127.0.0.1 only and refuses any other address; its page shows the author view and the learner
 *   view, and the learner view's JSON at the prediction stage carries no solution-bearing quantity or group ID; a
 *   package that does not validate gets its diagnostics (orphaned references, missing equivalents, unit mismatches)
 *   and no authored code. The page runs in Chromium here; every request to another origin is recorded and refused.
 */
import { readFile, realpath, writeFile } from 'node:fs/promises';
import { request } from 'node:http';
import path from 'node:path';
import { chromium, type Browser } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ActivityTemplate, HostPolicy, LearnerProjection } from '../../packages/activity/src/index';
import type { ModelManifest } from '../../packages/core/src/model/index';
import { startActivityPreview } from '../../packages/cli/src/activity-preview';
import type { PreviewInput, PreviewState } from '../../packages/cli/src/activity-preview-page';
import { activity, codes, editJson, temporaryDirectory, type Diagnostic } from './activity-support';

interface CaptureReport {
  passed: boolean;
  stage?: string;
  directory: string | null;
  policy: { source: string; policyId?: string; mode?: string; notes?: { groupsOutsideCeiling: string[] } };
  diagnostics?: Diagnostic[];
  error?: { code: string };
  stages: { stageId: string; ok: boolean; revealed: string[]; svg: string | null; companion: string | null; diagnostics: { code: string; message: string }[]; views: { viewId: string }[] }[];
}
/** IDs of the scaffold's solution-bearing groups and of everything they hold or draw. */
const SOLUTION_IDS = ['root-point', 'root', 'root-rule', 'root-marker'];

/** Every string value in a JSON value (keys excluded). */
function strings(value: unknown, out: string[] = []): string[] {
  if (typeof value === 'string') out.push(value);
  else if (Array.isArray(value)) for (const item of value) strings(item, out);
  else if (value && typeof value === 'object') for (const item of Object.values(value)) strings(item, out);
  return out;
}

/** Scaffold edits: an unused group, a view no stage shows, data outside the graph's bounds, a crowded root label and TeX KaTeX cannot parse. */
async function diagnosticPackage(directory: string): Promise<void> {
  expect((await activity('scaffold', directory)).exitCode).toBe(0);
  // The probe sits next to the root: (−0.8, 0.2) and (−1, 0).
  await editJson<ModelManifest>(path.join(directory, 'model.json'), model => { model.parameters.p!.default = -0.8; });
  const digest = (await activity<{ model: { digest: string } }>('validate', directory)).report.model.digest;
  await editJson<ActivityTemplate>(path.join(directory, 'template.json'), template => {
    template.model.digest = digest;
    template.groups.push({ id: 'unused-notes', kind: 'annotation', label: 'Unused notes', description: 'Declared but never assigned.', solutionBearing: false, members: [] });
    template.groups.push({ id: 'hidden-values', kind: 'view', label: 'Hidden values', description: 'A view group no stage shows.', solutionBearing: false, members: ['hidden-values'] });
    template.views.push({ id: 'hidden-values', kind: 'values', group: 'hidden-values', title: 'Hidden values', description: 'Never shown.', equalAspect: false, marks: [], quantities: ['slope'] });
    const graph = template.views[0]!;
    // The line runs from (−5, −4) to (5, 6): both endpoints leave y ∈ [−3, 3].
    graph.bounds = [-5, 5, -3, 3];
    const root = graph.marks.find(mark => mark.id === 'root-marker')!;
    root.text = 'Root of the line where it crosses the horizontal axis, labelled with a deliberately long caption that cannot fit beside the probe point';
    root.placement = { anchor: 'n', offset: [0, -8], leader: false, maxWidthEm: 100 };
    template.equations.find(equation => equation.id === 'rule')!.tex = 'y = {{q:slope}} \\cdot x + \\frac{{{q:intercept}}';
  });
}

/** A learner policy for an authored (exploratory) package; `edit` narrows it. */
function learnerPolicy(template: ActivityTemplate, edit: (policy: HostPolicy) => void = () => undefined): HostPolicy {
  const policy: HostPolicy = {
    contract: 'study-harness.host-policy', schemaVersion: '1.0', policyId: 'learner-policy-test', revision: 3, issuedAt: '2026-01-01T00:00:00Z', expiresAt: null, revoked: false,
    mode: 'exploratory', approved: [], allowedTools: ['prepare', 'inspect.learner', 'request-reveal', 'operate.parameters', 'operate.navigation', 'operate.presentation', 'summarize', 'close'],
    visibleGroups: template.groups.map(group => group.id), permittedControls: template.controls.map(control => control.parameter),
    export: { learnerSnapshot: false, capture: true, backup: false }, inspection: { developer: false, tutor: 'learner-visible', teacher: false },
    independentTask: { active: false, taskRef: null, permittedTools: [], neutralScaffold: [] }, sampling: { allowed: false, maxPositions: 0 },
    exploratory: { allowed: true, maxParametersOverride: 0 },
  };
  edit(policy);
  return policy;
}

const hostStatus = (url: string, host: string): Promise<number> => new Promise((resolve, reject) => {
  const target = new URL(url);
  request({ hostname: target.hostname, port: target.port, path: '/', headers: { Host: host } }, response => { response.resume(); resolve(response.statusCode ?? 0); }).on('error', reject).end();
});

describe('activity authoring diagnostics, learner captures and preview', () => {
  let work: Awaited<ReturnType<typeof temporaryDirectory>>;
  let line: string, diag: string, template: ActivityTemplate;
  beforeAll(async () => {
    work = await temporaryDirectory('activity-preview');
    line = path.join(work.path, 'line-preview');
    diag = path.join(work.path, 'diagnostic-preview');
    expect((await activity('scaffold', line)).exitCode).toBe(0);
    await diagnosticPackage(diag);
    template = JSON.parse(await readFile(path.join(line, 'template.json'), 'utf8')) as ActivityTemplate;
  });
  afterAll(async () => { await work.dispose(); });

  it('reports the unused group and the never-visible view (validate), and the clipped mark, overlapping labels and math error (capture)', async () => {
    const plain = await activity<{ ok: boolean; diagnostics: Diagnostic[] }>('validate', line);
    expect(plain.report.diagnostics).toEqual([]);
    const { report, exitCode } = await activity<{ ok: boolean; diagnostics: Diagnostic[] }>('validate', diag);
    // Warnings, not errors: the package still validates.
    expect(exitCode).toBe(0);
    expect(report.ok).toBe(true);
    // The malformed equation is reported by validate itself (S8: a TeX parse at validate time), before capture shows it.
    const equation = JSON.parse(await readFile(path.join(diag, 'template.json'), 'utf8')).equations.findIndex((item: { id: string }) => item.id === 'rule');
    expect(report.diagnostics.map(item => [item.severity, item.code, item.file, item.path])).toEqual([
      ['warning', 'MATH_FALLBACK', 'template.json', `$.equations[${equation}].tex`],
      ['warning', 'UNREFERENCED', 'template.json', '$.groups[12]'],
      ['warning', 'NEVER_VISIBLE', 'template.json', '$.views[3].group'],
    ]);

    const captured = await activity<CaptureReport>('capture', diag, '--stage', 'explore', '--out', path.join(work.path, 'diag-captures'));
    expect(captured.report.passed).toBe(true);
    const surface = captured.report.stages[0]!.diagnostics;
    expect(surface.filter(item => item.code === 'CLIPPED').map(item => item.message)).toEqual([expect.stringMatching(/^2 drawn coordinates of “Line y = m·x \+ b” lie outside the authored view bounds/)]);
    // The long root label has no free place beside the probe: it is drawn as a numbered callout with its full text in
    // the figure's label key (S5, report §10.2, §10.3) and reported to the author as a label collision; nothing overlaps.
    expect(surface.filter(item => item.code === 'LABEL_CALLOUT').map(item => item.message)).toEqual([expect.stringMatching(/^Label “Root of the line.*callout 1/)]);
    expect(surface.filter(item => item.code === 'LABEL_OVERLAP')).toEqual([]);
    expect(surface.filter(item => item.code === 'MATH_FALLBACK').map(item => item.message)).toEqual([expect.stringMatching(/^Equation “Line” is shown as plain text: KaTeX parse error/)]);
    // The unedited scaffold reports neither.
    const clean = await activity<CaptureReport>('capture', line, '--stage', 'explore', '--out', path.join(work.path, 'line-captures'));
    expect(clean.report.stages[0]!.diagnostics.map(item => item.code)).toEqual([]);
  });

  it('captures the learner view under a supplied policy and never shows what the stage or the ceiling withholds', async () => {
    const full = path.join(work.path, 'learner-policy.json');
    await writeFile(full, JSON.stringify(learnerPolicy(template)));
    const predict = await activity<CaptureReport>('capture', line, '--stage', 'predict', '--policy', full);
    expect(predict.exitCode).toBe(0);
    expect(predict.report).toMatchObject({ passed: true, directory: path.join(await realpath(line), 'review/learner-captures'), policy: { source: 'supplied', policyId: 'learner-policy-test', mode: 'exploratory' } });
    expect(predict.report.stages[0]!.revealed).toEqual([]);
    const predictText = await readFile(path.join(predict.report.directory!, 'predict.txt'), 'utf8');
    expect(predictText).toContain('Line value at the probe: 3');
    expect(predictText).not.toMatch(/Root|x_r/);
    expect(await readFile(path.join(predict.report.directory!, 'predict.svg'), 'utf8')).not.toMatch(/Root \(x_r|>root</);

    // A ceiling without the root groups withholds them even in the stage that shows them; the author preview reveals them.
    const narrow = path.join(work.path, 'narrow-policy.json');
    await writeFile(narrow, JSON.stringify(learnerPolicy(template, policy => { policy.visibleGroups = policy.visibleGroups.filter(id => !SOLUTION_IDS.includes(id)); })));
    const learner = await activity<CaptureReport>('capture', line, '--stage', 'explore', '--policy', narrow, '--out', path.join(work.path, 'narrow'));
    expect(learner.report).toMatchObject({ passed: true, policy: { source: 'supplied', notes: { groupsOutsideCeiling: ['root-point', 'root', 'root-rule'] } } });
    expect(learner.report.stages[0]!.revealed).toEqual([]);
    const exploreText = await readFile(path.join(work.path, 'narrow/explore.txt'), 'utf8');
    expect(exploreText).toContain('Line value at the probe: 3');
    expect(exploreText).not.toMatch(/Root|x_r/);
    const author = await activity<CaptureReport>('capture', line, '--stage', 'explore', '--out', path.join(work.path, 'author'));
    expect(author.report).toMatchObject({ passed: true, policy: { source: 'author-preview' } });
    expect(author.report.stages[0]!.revealed).toEqual(['root-point', 'root', 'root-rule']);
    expect(await readFile(path.join(work.path, 'author/explore.txt'), 'utf8')).toMatch(/Root: −1/);

    // An active independent task: the host enters it, so only the neutral scaffold shows.
    const independent = path.join(work.path, 'independent-policy.json');
    await writeFile(independent, JSON.stringify(learnerPolicy(template, policy => {
      policy.independentTask = { active: true, taskRef: 'task-independent-1', permittedTools: ['prepare', 'inspect.learner', 'close'], neutralScaffold: ['graph', 'line'] };
    })));
    const task = await activity<CaptureReport>('capture', line, '--stage', 'explore', '--policy', independent, '--out', path.join(work.path, 'independent'));
    expect(task.report.passed).toBe(true);
    expect(task.report.stages[0]!).toMatchObject({ revealed: [], views: [{ viewId: 'graph' }] });
    expect(await readFile(path.join(work.path, 'independent/explore.txt'), 'utf8')).not.toMatch(/Root|Line value at the probe/);
  });

  it('refuses policies that are not valid, deny exploratory work or have expired', async () => {
    const cases: [string, unknown, string][] = [
      ['not-json.json', null, 'SCHEMA'],
      ['schema.json', { ...learnerPolicy(template), visibleGroups: 'all' }, 'SCHEMA'],
      // Approves only an installed template: an authored package (always exploratory) is denied.
      ['denied.json', learnerPolicy(template, policy => {
        policy.exploratory.allowed = false; policy.mode = 'approved';
        policy.approved = [{ template: { templateId: 'quadratic-gradient-descent', version: '1.0.0', digest: `sha256:${'1'.repeat(64)}` }, model: { modelId: 'quadratic-gradient-descent', version: '1.0.0', digest: `sha256:${'2'.repeat(64)}` } }];
      }), 'POLICY_DENIED'],
      ['expired.json', learnerPolicy(template, policy => { policy.expiresAt = '2026-01-02T00:00:00Z'; }), 'POLICY_EXPIRED'],
    ];
    for (const [name, value, code] of cases) {
      const file = path.join(work.path, name);
      await writeFile(file, value === null ? '{ not json' : JSON.stringify(value));
      for (const command of ['capture', 'preview']) {
        const { report, exitCode } = await activity<CaptureReport>(command, line, '--stage', 'predict', '--policy', file, '--no-open');
        expect(exitCode, `${command} ${name}`).toBe(1);
        expect(report, `${command} ${name}`).toMatchObject({ passed: false, stage: 'policy' });
        expect(report.diagnostics!.map(item => item.code), `${command} ${name}`).toContain(code);
      }
    }
    const missing = await activity<CaptureReport>('capture', line, '--policy', path.join(work.path, 'absent.json'));
    expect(missing).toMatchObject({ exitCode: 1, report: { error: { code: 'NOT_FOUND' } } });
  });

  it('serves the preview on 127.0.0.1 only', async () => {
    for (const host of ['0.0.0.0', '::', '192.168.1.20', 'example.test']) {
      const { report, exitCode } = await activity<CaptureReport>('preview', line, '--host', host, '--no-open');
      expect(exitCode, host).toBe(1);
      expect(report.error, host).toMatchObject({ code: 'INVALID_PARAMETER' });
    }
    await expect(startActivityPreview({ directory: line, host: '0.0.0.0' })).rejects.toMatchObject({ code: 'INVALID_PARAMETER' });
  });

  it('shows only the diagnostics of a package that does not validate, without loading its authored code', async () => {
    const broken = path.join(work.path, 'broken-preview');
    expect((await activity('scaffold', broken)).exitCode).toBe(0);
    await editJson<ActivityTemplate>(path.join(broken, 'template.json'), value => {
      value.stages.find(stage => stage.id === 'predict')!.visible['no-such-group'] = 'fixed';
      value.alternatives.find(alternative => alternative.id === 'values-description')!.equivalence = 'partial';
      value.controls[0]!.displayUnits = ['m'];
    });
    const errors = ['INVALID_REFERENCE', 'MISSING_EQUIVALENT', 'UNIT_MISMATCH'];
    expect(codes((await activity<{ diagnostics: Diagnostic[] }>('validate', broken)).report.diagnostics).sort()).toEqual(errors);
    const started = await startActivityPreview({ directory: broken });
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    const { session } = started;
    let browser: Browser | undefined;
    try {
      expect(session.report).toMatchObject({ passed: false, stage: 'validate', host: '127.0.0.1', summary: { errors: 3, warnings: 0 } });
      expect(session.input.status).toBe('blocked');
      // No activity can be prepared, so the bundle carries no authored kernel.
      expect(await (await fetch(new URL('worker-model.js', session.url))).text()).not.toContain('EVERY_X_IS_A_ROOT');
      browser = await chromium.launch({ headless: true });
      const tab = await browser.newPage();
      await tab.goto(session.url);
      await tab.waitForFunction(() => window.__activityPreview?.ready === true, undefined, { timeout: 30_000 });
      expect(await tab.evaluate(() => window.__activityPreview!.state().blocked)).toBe(true);
      expect(await tab.locator('[data-preview="blocked"]').textContent()).toMatch(/does not validate \(3 errors\)/);
      const panel = await tab.locator('[data-preview="diagnostics"] li[data-code]').evaluateAll(items => items.map(item => item.getAttribute('data-code')));
      expect(panel.sort()).toEqual(errors);
      expect(await tab.locator('[data-explorable-models-activity]').count()).toBe(0);
    } finally {
      await browser?.close();
      await session.close();
    }
  });

  it('shows the author view and the learner view; the learner JSON at the prediction stage has no solution-bearing IDs', async () => {
    const started = await startActivityPreview({ directory: diag });
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    const { session } = started;
    let browser: Browser | undefined;
    try {
      expect(session.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/$/);
      expect(session.report).toMatchObject({
        command: 'preview', passed: true, host: '127.0.0.1', stages: ['predict', 'explore', 'closed'], initialStage: 'predict',
        learnerPolicy: { source: 'derived', mode: 'exploratory', notes: { groupsOutsideCeiling: [] } }, summary: { errors: 0, warnings: 3 },
      });
      const page = await fetch(session.url);
      expect(page.headers.get('content-security-policy')).toMatch(/default-src 'self'; script-src 'self'/);
      expect(await page.text()).toContain('<script type="module" src="./preview.js">');
      // DNS-rebinding guard: another Host header is refused.
      expect(await hostStatus(session.url, 'attacker.example')).toBe(403);
      const input = await (await fetch(new URL('preview-input.json', session.url))).json() as PreviewInput;
      expect(input.learner.policy.visibleGroups).toEqual(input.template.groups.map(group => group.id));
      for (const stage of input.author.template.stages) expect(Object.keys(stage.visible).sort()).toEqual(input.template.groups.map(group => group.id).sort());
      expect(input.template.stages.find(stage => stage.id === 'predict')!.visible).not.toHaveProperty('root');

      browser = await chromium.launch({ headless: true });
      const context = await browser.newContext({ viewport: { width: 1280, height: 2400 } });
      const blocked: string[] = [];
      await context.route('**/*', route => {
        if (new URL(route.request().url()).origin === new URL(session.url).origin) return route.continue();
        blocked.push(route.request().url());
        return route.abort('blockedbyclient');
      });
      const tab = await context.newPage();
      const pageErrors: string[] = [];
      tab.on('pageerror', error => pageErrors.push(error.message));
      await tab.goto(session.url);
      await tab.waitForFunction(() => window.__activityPreview?.ready === true, undefined, { timeout: 30_000 });

      const learnerText = (await tab.locator('[data-preview="learner-json"]').textContent())!;
      const predict = JSON.parse(learnerText) as LearnerProjection;
      expect(predict.stage.id).toBe('predict');
      expect(strings(predict).filter(value => SOLUTION_IDS.includes(value))).toEqual([]);
      let state = await tab.evaluate(() => window.__activityPreview!.state()) as PreviewState;
      expect(state).toMatchObject({ ready: true, error: null, stageId: 'predict', learner: { stageId: 'predict', failures: [] }, author: { stageId: 'predict', failures: [] } });
      // The author view shows every group, the root groups revealed by its fixture host at stage entry.
      expect(strings(state.author.projection).filter(value => SOLUTION_IDS.includes(value)).sort()).toEqual(expect.arrayContaining(['root', 'root-marker', 'root-rule']));
      expect(state.author.route.map(step => step.kind)).toEqual(['prepared', 'reveal']);
      expect(state.groups.find(group => group.groupId === 'root')).toMatchObject({ solutionBearing: true, staged: 'absent', learner: 'absent', reason: 'not in this stage' });
      expect(await tab.locator('[data-preview="author-surface"] [data-explorable-models-activity]').count()).toBe(1);
      expect(await tab.locator('[data-preview="learner-surface"] [data-explorable-models-activity]').count()).toBe(1);

      // The stage selector moves both lanes through host-authorized transitions with receipts.
      state = await tab.evaluate(() => window.__activityPreview!.selectStage('explore')) as PreviewState;
      expect(state.learner.route).toEqual([expect.objectContaining({ kind: 'transition', from: 'predict', stage: 'explore', transitionId: 'show-root', ok: true, receiptId: expect.stringMatching(/\S/) })]);
      expect(state.author.route).toEqual([expect.objectContaining({ kind: 'transition', transitionId: 'show-root', ok: true })]);
      const explore = JSON.parse((await tab.locator('[data-preview="learner-json"]').textContent())!) as LearnerProjection;
      expect(explore.stage.id).toBe('explore');
      expect(strings(explore)).toEqual(expect.arrayContaining(['root', 'root-marker']));
      expect(state.groups.find(group => group.groupId === 'root')).toMatchObject({ learner: 'fixed', reason: null });

      // The diagnostics panel lists the template warnings and both surfaces' diagnostics for this stage. KaTeX loads only
      // for equations in view, so each lane's equations are scrolled into view first.
      for (const lane of ['author', 'learner']) await tab.locator(`[data-preview="${lane}-surface"] .ema-equations`).scrollIntoViewIfNeeded();
      await expect.poll(async () => (await tab.evaluate(() => window.__activityPreview!.state()) as PreviewState).diagnostics.learner.map(item => item.code).sort(), { timeout: 10_000 })
        .toEqual(['CLIPPED', 'LABEL_CALLOUT', 'MATH_FALLBACK']);
      await expect.poll(async () => (await tab.evaluate(() => window.__activityPreview!.state()) as PreviewState).diagnostics.author.map(item => item.code).sort(), { timeout: 10_000 })
        .toEqual(['CLIPPED', 'LABEL_CALLOUT', 'MATH_FALLBACK']);
      const panel = await tab.locator('[data-preview="diagnostics"] li[data-code]').evaluateAll(items => items.map(item => item.getAttribute('data-code')));
      expect(new Set(panel)).toEqual(new Set(['UNREFERENCED', 'NEVER_VISIBLE', 'CLIPPED', 'LABEL_CALLOUT', 'MATH_FALLBACK']));
      expect(blocked).toEqual([]);
      expect(pageErrors).toEqual([]);
    } finally {
      await browser?.close();
      await session.close();
    }
    await expect(fetch(session.url)).rejects.toThrow();
  });

  it('previews an installed template under the derived approved learner policy with no warnings', async () => {
    const started = await startActivityPreview({ installed: 'quadratic-gradient-descent' });
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    try {
      expect(started.session.report).toMatchObject({ passed: true, installed: 'quadratic-gradient-descent', learnerPolicy: { source: 'derived', mode: 'approved' }, diagnostics: [], summary: { errors: 0, warnings: 0 } });
      const input = started.session.input;
      expect(input.status).toBe('ready');
      if (input.status !== 'ready') return;
      expect(input.learner.policy.approved).toEqual([{ template: input.identity.template, model: input.identity.model }]);
    } finally { await started.session.close(); }
  });
});
