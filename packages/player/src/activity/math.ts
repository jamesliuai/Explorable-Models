/**
 * Bounded mathematical notation (report §10.3, D12, native.md N5). Equations arrive as projection text whose
 * `{{q:id}}` placeholders the projection already replaced with formatted numerals of visible quantities; the surface
 * never interpolates or evaluates anything. Rendering:
 *
 * - source length ≤ `MATH_LIMITS.source` code points is checked before KaTeX is called;
 * - definitional, resource and HTML-extension commands are rejected before KaTeX (defence in depth on top of
 *   `trust: false`), so hostile TeX cannot create links, images, classes or global macros; the list and the bounded
 *   screen are `@explorable-models/activity`'s `FORBIDDEN_TEX_COMMANDS` / `checkTexSource`, shared with the agent tools;
 * - KaTeX runs with `trust:false, maxExpand:1000, maxSize:20, throwOnError:true, strict:'ignore',
 *   output:'htmlAndMathml'` and a fresh macro object per render (no shared macro state between equations or activities);
 * - it renders with `katex.render` into a DOM node (never `renderToString` + `innerHTML`), so the output survives a
 *   `style-src 'self'` policy; any error leaves the plain-text form in place.
 */
import { checkTexSource, FORBIDDEN_TEX_COMMANDS, TEX_RENDER_LIMITS, TEX_SOURCE_LIMIT } from '@explorable-models/activity';

export { codePointLength } from '@explorable-models/activity';

/** The bounds of the shared TeX screen and of validation's KaTeX parse (`TEX_RENDER_LIMITS`), so both agree. */
export const MATH_LIMITS = Object.freeze({ source: TEX_SOURCE_LIMIT, maxExpand: TEX_RENDER_LIMITS.maxExpand, maxSize: TEX_RENDER_LIMITS.maxSize });

export interface KatexRenderOptions {
  displayMode: boolean;
  trust: false;
  maxExpand: number;
  maxSize: number;
  throwOnError: true;
  strict: 'ignore';
  output: 'htmlAndMathml';
  macros: Record<string, string>;
  globalGroup: false;
}
/** The subset of the KaTeX module the surface uses (compatible with `katex` 0.19). */
export interface KatexModule {
  render(tex: string, element: HTMLElement, options: KatexRenderOptions): void;
  readonly version?: string;
}

/** Commands that define macros or reach resources/HTML; rejected before KaTeX sees the source (the shared activity list). */
export const REJECTED_TEX_COMMANDS: readonly string[] = FORBIDDEN_TEX_COMMANDS;

export type MathCheck =
  | { ok: true; options: KatexRenderOptions }
  | { ok: false; reason: 'not-text' | 'too-long' | 'rejected-command'; detail: string };

/** Validates a TeX source and returns fresh, bounded KaTeX options; nothing here calls KaTeX. */
export function prepareMath(source: unknown, displayMode = true): MathCheck {
  const screened = checkTexSource(source, MATH_LIMITS.source);
  if (!screened.ok) return screened;
  return {
    ok: true,
    options: {
      displayMode, trust: false, maxExpand: MATH_LIMITS.maxExpand, maxSize: MATH_LIMITS.maxSize, throwOnError: true,
      strict: 'ignore', output: 'htmlAndMathml', macros: Object.create(null) as Record<string, string>, globalGroup: false,
    },
  };
}

export type MathRender = { ok: true } | { ok: false; reason: 'not-text' | 'too-long' | 'rejected-command' | 'katex-error'; detail: string };

/**
 * Renders `source` into `element` with KaTeX's DOM API. On any rejection or KaTeX error the element is emptied and
 * the caller keeps showing the plain-text form; KaTeX's own error markup (which needs style attributes) is never used.
 */
export function renderMathInto(katex: KatexModule, element: HTMLElement, source: string, displayMode = true): MathRender {
  const check = prepareMath(source, displayMode);
  if (!check.ok) { element.textContent = ''; return { ok: false, reason: check.reason, detail: check.detail }; }
  try {
    katex.render(source, element, check.options);
    return { ok: true };
  } catch (error) {
    element.textContent = '';
    const message = error instanceof Error ? error.message.replace(/\s+/g, ' ').slice(0, 200) : 'KaTeX could not render the source.';
    return { ok: false, reason: 'katex-error', detail: message };
  }
}

/** Default lazy loader: KaTeX is a separate chunk loaded only when an equation becomes visible. */
export const defaultMathLoader = (): Promise<KatexModule> =>
  import('katex').then(module => ((module as { default?: unknown }).default ?? module) as KatexModule);
