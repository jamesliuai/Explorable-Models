/**
 * `experiment-kit activity scaffold` and `validate` (report §15.2, A08, A56): data-only validation of authoring
 * packages, the distinction between a new exploratory composition and an edit of an installed template, and the
 * import allowlist checked by parsing (never by running) authored code.
 */
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { modelIdentity } from '@experiment-kit/core/model';
import { quadraticGradientDescentManifest, quadraticGradientDescentTemplate } from '@experiment-kit/catalog';
import { templateRef } from '@experiment-kit/activity';
import { activity, codes, editJson, readJson, temporaryDirectory, type Diagnostic } from './activity-support';

type Validation = { ok: boolean; diagnostics: Diagnostic[]; relation: { kind: string; of?: { templateId: string }; derivedFrom?: unknown }; recordedRelation: { kind: string; derivedFrom: unknown; kernel: string } | null; lifecycle: string; referenceSuite: { binding: string; fixture: { digest: string } | null }; execution: { source: string; kernelId?: string }; model: { modelId: string; digest: string }; codeExecuted: boolean };
const installedFixture = path.resolve('tests/reference/fixtures/activities/quadratic-gradient-descent.json');

describe('activity scaffold and validate', () => {
  let work: Awaited<ReturnType<typeof temporaryDirectory>>;
  beforeAll(async () => { work = await temporaryDirectory('activity-validate'); });
  afterAll(async () => { await work.dispose(); });

  it('scaffolds the example package, which validates as a new authored composition', async () => {
    const directory = path.join(work.path, 'line-example');
    const scaffold = await activity<{ templateId: string; kernel: string; files: string[] }>('scaffold', directory);
    expect(scaffold.exitCode).toBe(0);
    expect(scaffold.report).toMatchObject({ templateId: 'line-example', kernel: 'authored', lifecycle: 'authored' });
    expect(scaffold.report.files).toEqual(expect.arrayContaining(['model.json', 'template.json', 'kernel.ts', 'checks.ts', 'copy.md', 'authoring.json', 'fixtures/reference.json', 'fixtures/boundaries.json']));
    const { report, exitCode } = await activity<Validation>('validate', directory);
    expect(exitCode).toBe(0);
    expect(report).toMatchObject({ ok: true, lifecycle: 'authored', codeExecuted: false, relation: { kind: 'new-composition' }, execution: { source: 'authored-kernel', kernelId: 'line-example' }, referenceSuite: { binding: 'matches' } });
    expect(codes(report.diagnostics)).toEqual([]);
    // Existing work is never overwritten.
    expect((await activity('scaffold', directory)).exitCode).not.toBe(0);
  });

  it('copies an installed package under a new template ID and records the exact source; installed IDs are refused', async () => {
    const refused = await activity('scaffold', path.join(work.path, 'quadratic-gradient-descent'));
    expect(refused.exitCode).not.toBe(0);
    const directory = path.join(work.path, 'quad-copy');
    const scaffold = await activity<{ templateId: string; from: unknown; kernel: string }>('scaffold', directory, '--from', 'quadratic-gradient-descent');
    expect(scaffold.exitCode).toBe(0);
    expect(scaffold.report).toMatchObject({ templateId: 'quad-copy', kernel: 'copied-from-installed', from: templateRef(quadraticGradientDescentTemplate) });
    const authoring = await readJson<{ lifecycle: string; relation: { kind: string; derivedFrom: unknown; kernel: string } }>(path.join(directory, 'authoring.json'));
    expect(authoring).toMatchObject({ lifecycle: 'authored', relation: { kind: 'new-composition', derivedFrom: templateRef(quadraticGradientDescentTemplate), kernel: 'copied-from-installed' } });
    const kernel = await readFile(path.join(directory, 'kernel.ts'), 'utf8');
    expect(kernel).toContain("export const kernel: ModelKernel = Object.freeze({ id: \"quad-copy\", version: '0.1.0'");
    const fixture = await readJson<{ derivedFrom: { digest: string; path: string }; model: { modelId: string } }>(path.join(directory, 'fixtures/reference.json'));
    expect(fixture.derivedFrom.digest).toBe(`sha256:${createHash('sha256').update(await readFile(installedFixture)).digest('hex')}`);
    expect(fixture.derivedFrom.path).toBe('tests/reference/fixtures/activities/quadratic-gradient-descent.json');
    expect(fixture.model.modelId).toBe('quad-copy');
    const { report } = await activity<Validation>('validate', directory);
    expect(report).toMatchObject({ ok: true, relation: { kind: 'new-composition' }, recordedRelation: { kind: 'new-composition', kernel: 'copied-from-installed' }, execution: { source: 'authored-kernel', kernelId: 'quad-copy' }, referenceSuite: { binding: 'matches' } });
    const template = await readJson<{ templateId: string; version: string; model: { digest: string } }>(path.join(directory, 'template.json'));
    expect(template.templateId).toBe('quad-copy');
    expect(template.model.digest).toBe(report.model.digest);
  });

  it('can keep the exact installed model and kernel; the copied fixture is then derived from the bound suite', async () => {
    const directory = path.join(work.path, 'quad-installed');
    expect((await activity('scaffold', directory, '--from', 'quadratic-gradient-descent', '--kernel', 'installed')).exitCode).toBe(0);
    expect(existsSync(path.join(directory, 'kernel.ts'))).toBe(false);
    const { report } = await activity<Validation>('validate', directory);
    expect(report).toMatchObject({ ok: true, execution: { source: 'installed-kernel', kernelId: 'quadratic-gradient-descent' }, referenceSuite: { binding: 'derived-from' } });
    expect(report.model.digest).toBe(modelIdentity(quadraticGradientDescentManifest).digest);
  });

  it('reports schema errors, missing equivalents and scenario constraint violations with file and path', async () => {
    const directory = path.join(work.path, 'broken');
    await activity('scaffold', directory, '--from', 'quadratic-gradient-descent');
    await editJson<Record<string, unknown>>(path.join(directory, 'template.json'), template => { delete template.title; });
    let report = (await activity<Validation>('validate', directory)).report;
    expect(report.ok).toBe(false);
    expect(report.diagnostics).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'SCHEMA', file: 'template.json', path: '$.title' })]));

    await editJson<Record<string, unknown>>(path.join(directory, 'template.json'), template => {
      template.title = 'Step size in gradient descent';
      template.alternatives = (template.alternatives as { id: string }[]).filter(alternative => alternative.id !== 'landscape-equation-values');
      (template.scenarios as { parameters: Record<string, number> }[])[0]!.parameters = { a: 10, eta: 2, x0: 4 };
    });
    const run = await activity<Validation>('validate', directory);
    expect(run.exitCode).toBe(1);
    expect(codes(run.report.diagnostics)).toEqual(expect.arrayContaining(['MISSING_EQUIVALENT', 'CONSTRAINT_VIOLATION']));
    expect(run.report.diagnostics.find(item => item.code === 'MISSING_EQUIVALENT')).toMatchObject({ file: 'template.json' });
    expect(run.report.diagnostics.find(item => item.code === 'CONSTRAINT_VIOLATION')).toMatchObject({ file: 'template.json', path: expect.stringMatching(/^\$\.scenarios\[0\]/) });
  });

  it('parses equation TeX and declared symbols at validate time with the bounded KaTeX for every value form, reported as MATH_FALLBACK warnings (report §10.3, §15.2)', async () => {
    const directory = path.join(work.path, 'tex');
    await activity('scaffold', directory, '--from', 'quadratic-gradient-descent');
    type Equation = { id: string; tex: string };
    const setTex = (edit: (equations: Equation[]) => void) => editJson<Record<string, unknown>>(path.join(directory, 'template.json'), template => { edit(template.equations as Equation[]); });
    // Unbalanced braces: reported by validate, before any capture or preview shows MATH_FALLBACK. A warning: learners
    // would see the equation's plain-text form, which the contract requires, so the package still validates.
    await setTex(equations => { equations[0]!.tex = 'f(x) = \\tfrac{a}{2}\\,x^{2'; });
    let run = await activity<Validation>('validate', directory);
    expect(run.exitCode).toBe(0);
    expect(run.report.diagnostics).toEqual(expect.arrayContaining([expect.objectContaining({ severity: 'warning', code: 'MATH_FALLBACK', file: 'template.json', path: '$.equations[0].tex', message: expect.stringMatching(/^The TeX of equation "objective" does not parse: Expected '\}', got 'EOF'.*plain-text form/) })]));
    // An unknown command and a mismatched environment are parse errors too (nothing is executed).
    await setTex(equations => { equations[0]!.tex = '\\unknowncommand{x}'; equations[1]!.tex = '\\begin{pmatrix}1\\end{bmatrix}'; });
    run = await activity<Validation>('validate', directory);
    expect(run.report.diagnostics.filter(item => /does not parse/.test(item.message)).map(item => item.path)).toEqual(['$.equations[0].tex', '$.equations[1].tex']);
    // A placeholder that TeX takes apart: with a numeral \frac-1.25{2} still parses, but a status word cannot.
    await setTex(equations => {
      equations[0]!.tex = 'f(x) = \\tfrac{a}{2}\\,x^{2}'; equations[1]!.tex = 'x_{n+1} = (1 - \\eta a)\\,x_{n}';
      equations[2]!.tex = 'x_{n+1} = \\frac{{q:multiplier}}{1}\\,x_{n} + {{q:product}}';
    });
    run = await activity<Validation>('validate', directory);
    const placeholder = run.report.diagnostics.find(item => item.path === '$.equations[2].tex')!;
    expect(placeholder).toMatchObject({ severity: 'warning', code: 'MATH_FALLBACK', message: expect.stringContaining('when a value is shown as a status word') });
    expect((placeholder as Diagnostic & { recovery?: string }).recovery).toContain('wrap each {{q:…}} placeholder in braces');
    expect(placeholder.message).not.toContain('{{q:multiplier}}');
    // Braced, the same equation parses in every form.
    await setTex(equations => { equations[2]!.tex = 'x_{n+1} = \\frac{{{q:multiplier}}}{1}\\,x_{n} + {{q:product}}'; });
    run = await activity<Validation>('validate', directory);
    expect(run.report.ok).toBe(true);
    expect(run.report.diagnostics.filter(item => /TeX/.test(item.message))).toEqual([]);
    // A declared parameter symbol that does not parse is a warning on model.json (symbols are shown in plain form).
    await editJson<{ parameters: Record<string, { symbol: string }> }>(path.join(directory, 'model.json'), model => { model.parameters.eta!.symbol = '\\eta_{'; });
    run = await activity<Validation>('validate', directory);
    expect(run.report.diagnostics).toEqual(expect.arrayContaining([expect.objectContaining({ severity: 'warning', code: 'MATH_FALLBACK', file: 'model.json', path: '$.parameters.eta.symbol', message: expect.stringMatching(/^The TeX of the symbol of parameter "eta" does not parse/) })]));
  });

  it('refuses an altered installed template under the installed identity and marks a versioned edit as needing new review (A08)', async () => {
    const directory = path.join(work.path, 'identity');
    await activity('scaffold', directory, '--from', 'quadratic-gradient-descent', '--kernel', 'installed');
    await editJson<Record<string, unknown>>(path.join(directory, 'template.json'), template => ({ ...template, templateId: 'quadratic-gradient-descent', version: '1.0.0', title: 'Changed title' }));
    let report = (await activity<Validation>('validate', directory)).report;
    expect(report.ok).toBe(false);
    expect(report.diagnostics).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'CONFLICT', file: 'template.json', path: '$.version' })]));
    await editJson<Record<string, unknown>>(path.join(directory, 'template.json'), template => ({ ...template, version: '1.1.0' }));
    report = (await activity<Validation>('validate', directory)).report;
    expect(report.ok).toBe(true);
    expect(report.relation).toMatchObject({ kind: 'template-edit', of: { templateId: 'quadratic-gradient-descent' } });
    expect(codes(report.diagnostics, 'warning')).toEqual(expect.arrayContaining(['REVIEW_UNVERIFIED', 'CONFLICT']));
    // A package can never declare its own review status.
    await editJson<Record<string, unknown>>(path.join(directory, 'authoring.json'), record => ({ ...record, lifecycle: 'reviewed' }));
    report = (await activity<Validation>('validate', directory)).report;
    expect(report.diagnostics).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'REVIEW_UNVERIFIED', file: 'authoring.json', severity: 'error' })]));
  });

  it('rejects forbidden imports by parsing, binds the reference suite digest and never runs authored code', async () => {
    const directory = path.join(work.path, 'imports');
    await activity('scaffold', directory);
    const marker = path.join(work.path, 'validate-marker.txt');
    const kernel = await readFile(path.join(directory, 'kernel.ts'), 'utf8');
    await writeFile(path.join(directory, 'kernel.ts'), `import { writeFileSync } from 'node:fs';\nimport { checkParameters } from '@experiment-kit/core/model';\nwriteFileSync(${JSON.stringify(marker)}, 'ran');\nvoid checkParameters;\nvoid import('./model.json');\n${kernel}`);
    await editJson<{ cases: { points?: { expect: Record<string, unknown> }[] }[] }>(path.join(directory, 'fixtures/reference.json'), suite => { suite.cases[0]!.points![0]!.expect['probe.value'] = 4; });
    const { report, exitCode } = await activity<Validation>('validate', directory);
    expect(exitCode).toBe(1);
    const imports = report.diagnostics.filter(item => item.code === 'INVALID_IMPORT');
    expect(imports.map(item => item.message).join('\n')).toMatch(/node:fs/);
    expect(imports.map(item => item.message).join('\n')).toMatch(/type-only/);
    expect(imports.map(item => item.message).join('\n')).toMatch(/Dynamic import/);
    expect(report.diagnostics).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'INVALID_REFERENCE', file: 'model.json', path: '$.referenceSuite.digest' })]));
    expect(report.referenceSuite.binding).toBe('differs');
    expect(existsSync(marker)).toBe(false);
  });
});
