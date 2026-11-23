/**
 * 0.3 presentation (`variant`, quiet routine saves, neutral primary action): server-rendered checks that the embedded
 * card keeps its title as the accessible heading, leaves the stage response prompt to the host, gathers secondary
 * tools in one disclosure and still renders every scientific control, value and alternative; and that routine saving
 * is readable by assistive technology but not shown, while an unsaved change stays visible in both variants.
 */
import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import type { ActivityBinding, LearnerProjection } from '../../packages/activity/src/api';
import { fixtureProjection } from '../../examples/study-harness-host/projection-lab.fixtures';
import { CONTRAST_RULES, contrastRatio, DEFAULT_TOKENS, PROSE_FONT_STACK, resolveTheme, tokenVariables } from '../../packages/player/src/activity/theme';

function staticBinding(projection: LearnerProjection): ActivityBinding {
  const forbidden = () => { throw new Error('rendering must not issue commands'); };
  return new Proxy({ activityId: projection.activityId, actor: 'learner', getProjection: () => projection, subscribe: () => () => undefined } as unknown as ActivityBinding, {
    get: (target, key) => key in target ? target[key as keyof ActivityBinding] : forbidden,
  });
}
async function render(projection: LearnerProjection, props: Record<string, unknown> = {}) {
  const { StudyActivitySurface } = await import('../../packages/player/src/activity/index');
  return renderToString(createElement(StudyActivitySurface, { binding: staticBinding(projection), theme: 'dark', ...props }));
}
const text = (markup: string) => markup.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ');

describe('surface variants', () => {
  it('standalone (default) shows the title, the instruction and its tools in place', async () => {
    const projection = fixtureProjection('quadratic', 'ready');
    const html = await render(projection);
    expect(html).toContain('data-variant="standalone"');
    expect(html).toMatch(/<div class="ema-heading">\s*<h2[^>]*class="ema-title"/);
    expect(html).not.toContain('data-ema-more');
    expect(html).toContain('Read current values');
  });

  it('embedded keeps the title accessible, gathers secondary tools and leaves the response prompt to the host', async () => {
    const projection = fixtureProjection('quadratic', 'ready');
    const html = await render(projection, { variant: 'embedded' });
    expect(html).toContain('data-variant="embedded"');
    // The heading is still the card's accessible name, only visually hidden while there is content.
    expect(html).toMatch(/<div class="ema-heading ema-sr">\s*<h2[^>]*class="ema-title"[^>]*>[^<]+<\/h2>/);
    expect(html).toContain('aria-labelledby');
    // The instruction stays visible (compact) and focusable for focus restoration.
    expect(html).toMatch(/<p class="ema-instruction" tabindex="-1">/);
    // Secondary tools are in one disclosure, after the drawing, controls and values.
    const more = html.indexOf('data-ema-more');
    expect(more).toBeGreaterThan(-1);
    expect(html.indexOf('Read current values')).toBeGreaterThan(more);
    for (const control of projection.controls) expect(html).toContain(`data-parameter="${control.parameter}"`);
    expect(html.indexOf('data-parameter=')).toBeLessThan(more);
    // Without a response slot the host owns the prompt; with one, the card renders the prompt beside it.
    const predicting = { ...projection, stage: { ...projection.stage, response: { kind: 'prediction' as const, prompt: 'Predict the next iterate.' } } } as LearnerProjection;
    expect(text(await render(predicting, { variant: 'embedded' }))).not.toContain('Predict the next iterate.');
    expect(text(await render(predicting, { variant: 'embedded', responseSlot: createElement('textarea', { 'aria-label': 'Host composer' }) }))).toContain('Predict the next iterate.');
    expect(text(await render(predicting))).toContain('Predict the next iterate.');
  });

  it('lets the host replace the stage instruction wording, except on an inert card', async () => {
    const projection = fixtureProjection('quadratic', 'ready');
    const html = text(await render(projection, { variant: 'embedded', instruction: 'Test your prediction with a = 3.' }));
    expect(html).toContain('Test your prediction with a = 3.');
    expect(html).not.toContain(projection.stage.instruction);
    const suspended = { ...projection, status: { ...projection.status, ui: 'suspended' as const, message: 'Paused while hidden.' } } as LearnerProjection;
    expect(text(await render(suspended, { variant: 'embedded', instruction: 'Test your prediction with a = 3.' }))).not.toContain('Test your prediction with a = 3.');
  });

  it('shows the heading of a contentless card in either variant', async () => {
    const html = await render(fixtureProjection('quadratic', 'preparing'), { variant: 'embedded' });
    expect(html).toMatch(/<div class="ema-heading">/);
    expect(html).not.toContain('data-ema-more');
  });
});

describe('embedded card presentation', () => {
  it('leads with the drawing: legend over it, no drawing notes, exact values in place of read-outs, no footer', async () => {
    const projection = fixtureProjection('quadratic', 'ready');
    const standalone = await render(projection);
    const html = await render(projection, { variant: 'embedded' });
    // The standalone card draws its legend under the plot; the embedded card lists it over the drawing (shown on
    // demand) and keeps the drawn copy only for captures, hidden from assistive technology.
    expect(standalone).toMatch(/<g role="list" aria-label="Legend">/);
    expect(html).not.toMatch(/<g role="list" aria-label="Legend">/);
    expect(html).toMatch(/<ul class="ema-key" aria-label="Legend"/);
    expect(html).toMatch(/data-ema-capture-height="\d+"/);
    expect(html).not.toContain('About this drawing');
    expect(html).not.toContain('All drawn values are inside the view.');
    // No footer row: the host states the review status; assistive technology still reads it on the card.
    expect(html).not.toContain('class="ema-footer"');
    expect(html).toMatch(/<p class="ema-review ema-sr">[^<]+<\/p>/);
    // Each exact value sits in its control's head; Apply appears only once a different value is typed.
    for (const control of projection.controls) expect(html).toMatch(new RegExp(`data-parameter="${control.parameter}"[\\s\\S]*?<div class="ema-control-head">[\\s\\S]*?<div class="ema-exact" data-inline="">`));
    expect(text(html)).not.toMatch(/\bApply\b/);
    expect(text(standalone)).toMatch(/\bApply\b/);
    // Hints stay with assistive technology.
    expect(html).toMatch(/class="ema-control-hint ema-sr"/);
    expect(standalone).not.toMatch(/class="ema-control-hint ema-sr"/);
  });

  it('states why controls are fixed once, above them, and keeps each reason on its control for assistive technology', async () => {
    const projection = fixtureProjection('quadratic', 'ready');
    const html = await render(projection, { variant: 'embedded' });
    const fixed = projection.controls.find(control => control.mode === 'fixed')!;
    expect(html).toMatch(new RegExp(`<p class="ema-reason ema-shared-reason" aria-hidden="true">.*?${fixed.disabledReason!.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}</p>`));
    expect(html).toMatch(/<p class="ema-reason ema-sr" id="[^"]+"><span class="ema-glyph" aria-hidden="true">–<\/span>/);
  });

  it('groups control reasons in the controls’ own names', async () => {
    const { sharedControlReasons } = await import('../../packages/player/src/activity/components/Controls');
    const base = fixtureProjection('quadratic', 'ready').controls;
    const fixed = (index: number) => ({ ...base[index]!, mode: 'fixed' as const, disabledReason: 'This value is fixed in this part of the activity.' });
    expect(sharedControlReasons([fixed(0), fixed(1), fixed(2)], null)).toEqual([{ text: 'These values are fixed in this part of the activity.', parameters: ['eta', 'a', 'x0'] }]);
    expect(sharedControlReasons([base[0]!, fixed(1), fixed(2)], null)).toEqual([{ text: 'Curvature a and Starting position x₀ are fixed in this part of the activity.', parameters: ['a', 'x0'] }]);
    expect(sharedControlReasons([base[0]!, fixed(1), base[2]!], null)).toEqual([{ text: 'Curvature a is fixed in this part of the activity.', parameters: ['a'] }]);
    expect(sharedControlReasons([base[0]!, fixed(1)], 'Paused while hidden.')).toEqual([{ text: 'Paused while hidden.', parameters: ['eta', 'a'] }]);
    // A single control keeps its reason under it.
    expect(sharedControlReasons([fixed(1)], null)).toEqual([]);
  });

  it('takes the host wording for the current stage kind and the projection wording for the others', async () => {
    const projection = fixtureProjection('quadratic', 'ready');
    expect(projection.stage.kind).toBe('explore');
    expect(text(await render(projection, { variant: 'embedded', instruction: { explore: 'Change one value at a time.' } }))).toContain('Change one value at a time.');
    const other = text(await render(projection, { variant: 'embedded', instruction: { predict: 'Predict first.' } }));
    expect(other).not.toContain('Predict first.');
    expect(other).toContain(projection.stage.instruction);
  });

  it('draws the leading plot at full width and the next one as a shorter strip', async () => {
    const { plotHeight } = await import('../../packages/player/src/activity/scale');
    const domain: [number, number, number, number] = [-10, 10, 0, 100];
    expect(plotHeight(640, domain, false, 16, 'compact')).toBeLessThan(plotHeight(640, domain, false, 16));
    expect(plotHeight(640, domain, false, 16, 'strip')).toBeLessThan(plotHeight(640, domain, false, 16, 'compact'));
    expect(plotHeight(640, domain, false, 16, 'compact')).toBeLessThanOrEqual(400);
    const html = await render(fixtureProjection('quadratic', 'ready'), { variant: 'embedded' });
    expect(html).toMatch(/<div class="ema-views"><div class="ema-view-cell" data-wide="true">/);
  });
});

describe('quiet routine persistence', () => {
  it('keeps a routine save readable by assistive technology but not shown; an unsaved change stays visible', async () => {
    const saved = await render(fixtureProjection('quadratic', 'ready'));
    expect(saved).toMatch(/class="ema-chip ema-sr"[^>]*data-persistence="saved"/);
    const pending = fixtureProjection('quadratic', 'ready');
    pending.status = { ...pending.status, persistence: 'pending-recovery' };
    for (const variant of ['standalone', 'embedded']) {
      const html = await render(pending, { variant });
      expect(html, variant).toMatch(/class="ema-chip"[^>]*data-persistence="pending-recovery"/);
      expect(html, variant).toContain('Retry saving');
      expect(html, variant).not.toMatch(/class="ema-header ema-sr"/);
    }
  });
});

describe('warm-neutral palettes', () => {
  it('keep every contrast rule, a neutral primary action distinct from the data colour, and the prose serif', () => {
    for (const mode of ['light', 'dark'] as const) {
      const tokens = DEFAULT_TOKENS[mode];
      for (const rule of CONTRAST_RULES) for (const other of rule.against) expect(contrastRatio(tokens[rule.token], tokens[other]), `${mode} ${rule.token}/${other}`).toBeGreaterThanOrEqual(rule.min);
      expect(tokens.action).not.toBe(tokens.primary);
      expect(contrastRatio(tokens.onAction, tokens.action)).toBeGreaterThanOrEqual(4.5);
      expect(tokens.proseFamily).toBe(PROSE_FONT_STACK);
      expect(tokenVariables(tokens)['--ema-prose-family']).toBe(PROSE_FONT_STACK);
    }
    // Hosts may override the new tokens under the same validation as every other token.
    const { tokens, rejected } = resolveTheme('dark', { action: '#ffffff', onAction: '#ffffff', proseFamily: 'Charter; } x', ...({} as object) });
    expect(tokens.action).toBe('#ffffff');
    expect(tokens.onAction).toBe(DEFAULT_TOKENS.dark.onAction);
    expect(tokens.proseFamily).toBe(DEFAULT_TOKENS.dark.proseFamily);
    expect(rejected.map(item => item.token).sort()).toEqual(['onAction', 'proseFamily']);
  });
});
