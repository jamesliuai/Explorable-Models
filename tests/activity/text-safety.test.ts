/**
 * Shared hostile-TeX screen (report §10.3, §16; A35): one list of refused commands and one bounded check, used by the
 * learner surface's math renderer and by the agent tools' exploratory-content screen (both tested against it in
 * tests/player-activity/math.test.ts and tests/agent/activity-tools.test.ts).
 */
import { describe, expect, it } from 'vitest';
import katex from 'katex';
import {
  checkTexSource, codePointLength, FORBIDDEN_TEX_COMMANDS, forbiddenTexCommand, manifestTexSources, TEX_RENDER_LIMITS, TEX_SOURCE_LIMIT, TEX_VALUE_FORMS, LIMITS,
  templateTexSources, texParseDiagnostics, texParseOptions, type TexParser,
} from '@explorable-models/activity';
import { INSTALLED_MODELS, INSTALLED_TEMPLATES } from '@explorable-models/catalog';
import { MATH_LIMITS } from '../../packages/player/src/activity/math';

/** The toolkit's bounded parser (as `explorable-models activity validate` runs it): KaTeX with the learner limits, MathML only. */
const parse: TexParser = (source, options) => katex.renderToString(source, { ...options, output: 'mathml' });

describe('hostile-TeX screen', () => {
  it('is frozen, bounded by the template equation limit and covers resources, HTML extensions and macro definition', () => {
    expect(Object.isFrozen(FORBIDDEN_TEX_COMMANDS)).toBe(true);
    expect(TEX_SOURCE_LIMIT).toBe(LIMITS.tex);
    for (const command of ['href', 'url', 'includegraphics', 'input', 'include', 'htmlClass', 'htmlId', 'htmlStyle', 'htmlData', 'html@mathml', 'def', 'gdef', 'edef', 'xdef',
      'let', 'futurelet', 'global', 'expandafter', 'newcommand', 'renewcommand', 'providecommand', 'newenvironment', 'renewenvironment', 'DeclareMathOperator', 'csname', 'endcsname']) {
      expect(FORBIDDEN_TEX_COMMANDS).toContain(command);
    }
  });

  it('finds every refused command as a whole control word and nothing that merely shares a prefix', () => {
    for (const command of FORBIDDEN_TEX_COMMANDS) {
      expect(forbiddenTexCommand(`a + \\${command}{b}`), command).toBe(command);
      expect(forbiddenTexCommand(`a+\\${command}`), command).toBe(command);
      expect(checkTexSource(`\\${command} x`)).toEqual({ ok: false, reason: 'rejected-command', detail: `The command \\${command} is not allowed in learner equations.` });
    }
    expect(forbiddenTexCommand('\\definitely + \\letter + \\urlx + \\inputs + \\html@mathmlx')).toBeNull();
    expect(forbiddenTexCommand('\\frac{a}{2}\\,x^{2} \\cdot \\eta')).toBeNull();
    expect(checkTexSource('\\frac{1}{2}')).toEqual({ ok: true });
  });

  it('checks the length in code points before the pattern runs, and refuses non-text', () => {
    expect(checkTexSource('a'.repeat(TEX_SOURCE_LIMIT))).toEqual({ ok: true });
    expect(checkTexSource('𝑥'.repeat(TEX_SOURCE_LIMIT))).toEqual({ ok: true });
    expect(codePointLength('𝑥'.repeat(3))).toBe(3);
    // Too long wins over a refused command: the pattern never sees an over-limit source.
    expect(checkTexSource(`\\href{x}${'a'.repeat(TEX_SOURCE_LIMIT)}`)).toMatchObject({ ok: false, reason: 'too-long' });
    expect(checkTexSource('a'.repeat(10), 8)).toMatchObject({ ok: false, reason: 'too-long', detail: 'The equation source has 10 characters; the limit is 8.' });
    expect(checkTexSource(42)).toMatchObject({ ok: false, reason: 'not-text' });
  });
});

describe('validate-time TeX parse (report §10.3, §15.2)', () => {
  it('uses the learner renderer\'s bounds and a fresh, prototype-free macro object per parse', () => {
    expect(TEX_RENDER_LIMITS).toEqual({ maxExpand: MATH_LIMITS.maxExpand, maxSize: MATH_LIMITS.maxSize });
    const first = texParseOptions(), second = texParseOptions();
    expect(first).toMatchObject({ trust: false, throwOnError: true, maxExpand: 1000, maxSize: 20, globalGroup: false, displayMode: true });
    expect(first.macros).not.toBe(second.macros);
    expect(Object.getPrototypeOf(first.macros)).toBeNull();
  });

  it('substitutes each value form a placeholder can take, by the quantity\'s declared shape (a status always)', () => {
    const template = { equations: [
      { id: 'plain', tex: 'x^{2}' },
      { id: 'scalar', tex: 'y = {{q:s}}' },
      { id: 'vector', tex: 'v = {{q:v}}' },
      { id: 'category', tex: '\\text{kind: }{{q:c}}' },
    ] };
    const sources = templateTexSources(template, { s: { shape: { kind: 'scalar' } }, v: { shape: { kind: 'vector' } }, c: { shape: { kind: 'category' } } });
    expect(sources.map(source => [source.path, source.form])).toEqual([
      ['$.equations[0].tex', null],
      ['$.equations[1].tex', 'numeral'], ['$.equations[1].tex', 'scientific'], ['$.equations[1].tex', 'status'],
      ['$.equations[2].tex', 'vector'], ['$.equations[2].tex', 'status'],
      ['$.equations[3].tex', 'status'],
    ]);
    expect(sources[1]!.tex).toBe(`y = ${TEX_VALUE_FORMS.numeral}`);
    expect(texParseDiagnostics(sources, parse)).toEqual([]);
  });

  it('reports one diagnostic per failing field without quoting the source, and never parses a refused source', () => {
    const calls: string[] = [];
    const counting: TexParser = (source, options) => { calls.push(source); return parse(source, options); };
    const sources = templateTexSources({ equations: [
      { id: 'open', tex: 'a^{2' },
      { id: 'frac', tex: '\\frac{{q:s}}{2}' },
      { id: 'hostile', tex: '\\href{https://example.invalid}{x}' },
    ] }, { s: { shape: { kind: 'scalar' } } });
    const diagnostics = texParseDiagnostics(sources, counting);
    expect(diagnostics.map(item => [item.path, item.code])).toEqual([['$.equations[0].tex', 'MATH_FALLBACK'], ['$.equations[1].tex', 'MATH_FALLBACK']]);
    expect(diagnostics[1]!.message).toContain('when a value is shown as a status word');
    for (const item of diagnostics) expect(item.message).not.toMatch(/\{\{q:|a\^\{2/);
    expect(calls.some(source => source.includes('href'))).toBe(false);
  });

  it('every installed template\'s equations and every installed model\'s symbols parse in every value form', () => {
    expect(INSTALLED_TEMPLATES.length).toBe(5);
    for (const template of INSTALLED_TEMPLATES) {
      const manifest = INSTALLED_MODELS.find(model => model.modelId === template.model.modelId && model.version === template.model.version)!;
      const sources = templateTexSources(template, manifest.quantities);
      expect(sources.length, template.templateId).toBeGreaterThan(0);
      expect(texParseDiagnostics(sources, parse), template.templateId).toEqual([]);
      expect(texParseDiagnostics(manifestTexSources(manifest), parse), manifest.modelId).toEqual([]);
    }
  });
});
