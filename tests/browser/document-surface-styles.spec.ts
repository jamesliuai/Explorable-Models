/**
 * The schema 2.0 document surface under a strict content security policy (report §16; F5 of
 * docs/study-harness/performance.md): its stylesheet is adopted as a constructable stylesheet into the document or
 * shadow root that holds it — no `<style>` element and no style attribute — so it needs no `style-src 'unsafe-inline'`.
 * The production policy itself is exercised by scripts/study-harness/benchmark.mjs (document-path workloads under
 * `style-src 'self'`) and scripts/verify-packages.mjs (packed consumer, `style-src 'self'`, console errors fail it).
 */
import { expect, test } from '@playwright/test';

interface Studio { session: unknown }

test('a surface detached before its layout effect safely adopts and releases its owner document stylesheet', async ({ page }) => {
  await page.goto('/agent.html');
  const result = await page.evaluate(async () => {
    const source = '/packages/player/src/embedding/stylesheet.ts';
    const { adoptSurfaceStyles } = await import(source);
    const before = document.adoptedStyleSheets.length;
    const detached = document.createElement('div');
    const first = adoptSurfaceStyles(detached.getRootNode());
    const fragment = document.createDocumentFragment();
    fragment.append(detached);
    const second = adoptSurfaceStyles(detached.getRootNode());
    const shared = document.adoptedStyleSheets.length;
    document.body.append(fragment);
    first.release();
    const retained = document.adoptedStyleSheets.length;
    second.release(); second.release();
    detached.remove();
    return { ok: first.ok && second.ok, added: shared - before, retained: retained === shared, released: document.adoptedStyleSheets.length === before };
  });
  expect(result).toEqual({ ok: true, added: 1, retained: true, released: true });
});

test('the document surface adopts its stylesheet (no style element) in the page and inside a shadow root, shared and released per root', async ({ page }) => {
  await page.goto('/agent.html');
  await page.getByRole('combobox').selectOption('triangle');
  await expect(page.getByRole('status').first()).toContainText('Editable composition loaded');
  const inDocument = await page.evaluate(() => {
    const surface = document.querySelector<HTMLElement>('[data-ek-surface]')!;
    const sheets = document.adoptedStyleSheets.filter(sheet => [...sheet.cssRules].some(rule => rule.cssText.startsWith('[data-ek-surface]')));
    const button = surface.querySelector('button')!;
    return { styleElements: surface.querySelectorAll('style').length + (surface.parentElement?.querySelectorAll(':scope > style').length ?? 0), sheets: sheets.length, minHeight: getComputedStyle(button).minHeight, background: getComputedStyle(surface).backgroundColor };
  });
  expect(inDocument).toEqual({ styleElements: 0, sheets: 1, minHeight: '36px', background: 'rgb(255, 255, 255)' });

  const inShadow = await page.evaluate(async () => {
    const path = '/packages/player/src/public.ts';
    const { mountVisualization } = await import(path) as { mountVisualization(container: HTMLElement, options: { session: unknown }): { element: HTMLElement; dispose(): void } };
    const studio = (window as unknown as { __COMPOSITION_STUDIO__: Studio }).__COMPOSITION_STUDIO__;
    const host = document.createElement('div');
    document.body.append(host);
    const first = mountVisualization(host, { session: studio.session });
    const second = mountVisualization(host, { session: studio.session });
    const shadow = first.element.shadowRoot!;
    const surfaceRules = (root: ShadowRoot) => root.adoptedStyleSheets.filter(sheet => [...sheet.cssRules].some(rule => rule.cssText.startsWith('[data-ek-surface]'))).length;
    const button = shadow.querySelector('[data-ek-surface] button')!;
    const result = {
      styleElements: shadow.querySelectorAll('style').length, sheets: surfaceRules(shadow), secondSheets: surfaceRules(second.element.shadowRoot!),
      sameSheet: shadow.adoptedStyleSheets[0] === second.element.shadowRoot!.adoptedStyleSheets[0], minHeight: getComputedStyle(button).minHeight,
      documentSheets: document.adoptedStyleSheets.filter(sheet => [...sheet.cssRules].some(rule => rule.cssText.startsWith('[data-ek-surface]'))).length,
    };
    first.dispose(); second.dispose(); host.remove();
    return { ...result, afterDispose: surfaceRules(shadow) };
  });
  expect(inShadow).toEqual({ styleElements: 0, sheets: 1, secondSheets: 1, sameSheet: true, minHeight: '36px', documentSheets: 1, afterDispose: 0 });
});
