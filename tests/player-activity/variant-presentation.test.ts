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

  it('shows the heading of a contentless card in either variant', async () => {
    const html = await render(fixtureProjection('quadratic', 'preparing'), { variant: 'embedded' });
    expect(html).toMatch(/<div class="ema-heading">/);
    expect(html).not.toContain('data-ema-more');
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
