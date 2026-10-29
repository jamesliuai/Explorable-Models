import { describe, expect, it } from 'vitest';
import katex from 'katex';
import { codePointLength, MATH_LIMITS, prepareMath, REJECTED_TEX_COMMANDS, renderMathInto, type KatexModule, type KatexRenderOptions } from '../../packages/player/src/activity/math';

/** Records calls; stands in for the DOM element the real renderer writes into. */
const fakeElement = () => ({ textContent: 'stale' } as unknown as HTMLElement);
const recordingKatex = (behaviour?: (tex: string) => void) => {
  const calls: { tex: string; options: KatexRenderOptions }[] = [];
  const module: KatexModule = { render(tex, _element, options) { calls.push({ tex, options }); behaviour?.(tex); } };
  return { module, calls };
};
/** Real KaTeX with exactly the surface's options (string output only for inspection in Node). */
const surfaceOptions = (): KatexRenderOptions => { const check = prepareMath('x'); if (!check.ok) throw new Error('expected ok'); return check.options; };
const renderWithSurfaceOptions = (tex: string) => katex.renderToString(tex, surfaceOptions());

describe('bounded math notation (report §10.3, D12, A35)', () => {
  it('exposes the engineering limits as a frozen, discoverable constant', () => {
    expect(MATH_LIMITS).toEqual({ source: 4096, maxExpand: 1000, maxSize: 20 });
    expect(Object.isFrozen(MATH_LIMITS)).toBe(true);
  });

  it('builds the exact KaTeX options with a fresh, prototype-free macro object for every render', () => {
    const a = prepareMath('x^2'), b = prepareMath('x^2', false);
    if (!a.ok || !b.ok) throw new Error('expected ok');
    expect(a.options).toEqual({ displayMode: true, trust: false, maxExpand: 1000, maxSize: 20, throwOnError: true, strict: 'ignore', output: 'htmlAndMathml', macros: {}, globalGroup: false });
    expect(b.options.displayMode).toBe(false);
    expect(a.options.macros).not.toBe(b.options.macros);
    expect(Object.getPrototypeOf(a.options.macros)).toBeNull();
  });

  it('checks the source length in code points before KaTeX is called', () => {
    expect(prepareMath('a'.repeat(4096)).ok).toBe(true);
    expect(prepareMath('a'.repeat(4097))).toMatchObject({ ok: false, reason: 'too-long' });
    expect(codePointLength('𝑥'.repeat(10))).toBe(10);
    expect(prepareMath('𝑥'.repeat(4096)).ok).toBe(true);
    expect(prepareMath(42 as unknown as string)).toMatchObject({ ok: false, reason: 'not-text' });
    const { module, calls } = recordingKatex();
    const element = fakeElement();
    expect(renderMathInto(module, element, 'x'.repeat(5000))).toMatchObject({ ok: false, reason: 'too-long' });
    expect(calls).toHaveLength(0);
    expect(element.textContent).toBe('');
  });

  it('rejects macro-definition, resource and HTML-extension commands before KaTeX sees them', () => {
    const hostile = [
      '\\def\\a{\\a\\a}\\a', '\\gdef\\x{1}', '\\edef\\y{2}', '\\let\\z=\\x', '\\newcommand{\\loop}{\\loop}\\loop', '\\renewcommand{\\frac}{x}',
      '\\href{https://example.invalid}{click}', '\\url{https://example.invalid}', '\\includegraphics{https://example.invalid/x.png}',
      '\\htmlClass{x}{y}', '\\htmlId{x}{y}', '\\htmlStyle{color:red}{y}', '\\htmlData{a=b}{y}', '\\expandafter\\a\\b', '\\global\\def\\q{1}',
    ];
    const { module, calls } = recordingKatex();
    for (const source of hostile) {
      expect(prepareMath(source)).toMatchObject({ ok: false, reason: 'rejected-command' });
      expect(renderMathInto(module, fakeElement(), source).ok).toBe(false);
    }
    expect(calls).toHaveLength(0);
    // Ordinary commands that merely share a prefix are not rejected.
    expect(prepareMath('\\definitelynot + \\letter + \\urlx').ok).toBe(true);
    expect(prepareMath('\\frac{a}{2}\\,x^{2} \\cdot \\eta \\Delta').ok).toBe(true);
    expect(REJECTED_TEX_COMMANDS).toContain('href');
  });

  it('renders through katex.render with the bounded options and falls back to plain text on errors', () => {
    const ok = recordingKatex();
    expect(renderMathInto(ok.module, fakeElement(), 'x_{n+1} = (1 - \\eta a)\\,x_{n}')).toEqual({ ok: true });
    expect(ok.calls[0].options).toMatchObject({ trust: false, maxExpand: 1000, maxSize: 20, throwOnError: true });
    const failing = recordingKatex(() => { throw new Error('KaTeX parse error: Undefined control sequence'); });
    const element = fakeElement();
    expect(renderMathInto(failing.module, element, '\\nonsense')).toMatchObject({ ok: false, reason: 'katex-error' });
    expect(element.textContent).toBe('');
  });

  it('with the surface options, real KaTeX produces no links or images even for commands that bypassed the screen', () => {
    for (const source of ['\\href{https://example.invalid}{a}', '\\url{https://example.invalid}', '\\includegraphics{https://example.invalid/x.png}', '\\htmlClass{evil}{a}']) {
      const html = renderWithSurfaceOptions(source);
      expect(html).not.toMatch(/<a\b|href=|<img\b|src=|class="evil"/);
    }
  });

  it('with the surface options, real KaTeX stops expansion loops and oversized rules', () => {
    expect(() => renderWithSurfaceOptions('\\def\\a{\\a\\a}\\a')).toThrow(/Too many expansions/);
    expect(() => renderWithSurfaceOptions('\\newcommand{\\b}{\\b}\\b')).toThrow(/Too many expansions/);
    // maxSize clamps the visible (HTML) layout; KaTeX's visually hidden MathML keeps the authored size attribute.
    const output = renderWithSurfaceOptions('\\rule{1000em}{1000em}');
    const visible = output.slice(output.indexOf('class="katex-html"'));
    expect(visible).not.toMatch(/1000em/);
    expect(visible).toMatch(/20em/);
  });

  it('isolates macro state between renders', () => {
    const first = prepareMath('x'), second = prepareMath('y');
    if (!first.ok || !second.ok) throw new Error('expected ok');
    katex.renderToString('\\gdef\\leak{LEAKED}', first.options);
    expect(Object.keys(second.options.macros)).toEqual([]);
    expect(() => katex.renderToString('\\leak', second.options)).toThrow(/Undefined control sequence/);
  });

  it('renders accessible MathML alongside the HTML output', () => {
    expect(renderWithSurfaceOptions('f(x) = \\tfrac{a}{2}\\,x^{2}')).toContain('<math');
  });
});
