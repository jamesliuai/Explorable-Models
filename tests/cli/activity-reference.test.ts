/**
 * `explorable-models activity reference` and `boundaries` (report §12.6, §15.2, A30): external reference fixtures run
 * against frames evaluated in the browser worker with declared tolerances, per-case results keep their provenance,
 * and boundary cases are classified as valid / undefined / numerical-limit / out-of-domain.
 */
import { copyFile, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { activity, editJson, temporaryDirectory } from './activity-support';

interface ReferenceReport {
  passed: boolean;
  suite: { suiteId: string; digest: string; external: boolean; binding: string; derivedFrom: { path: string } | null; notCovered: string[] };
  summary: { cases: number; passed: number; failed: number };
  cases: { id: string; provenance: string; tolerance: { absolute: number; relative: number }; passed: boolean; problems: string[]; kind: string; points: number }[];
  uncovered: string[];
}
interface BoundaryReport {
  passed: boolean;
  summary: { cases: number; declared: number; outcomes: Record<string, number>; unmetExpectations: number };
  cases: { id: string; source: string; outcome: string; statuses: Record<string, string>; matches: boolean; mismatches: string[]; rejection: { code: string }[] | null }[];
}

describe('activity reference and boundaries', () => {
  let work: Awaited<ReturnType<typeof temporaryDirectory>>;
  let quad: string;
  beforeAll(async () => {
    work = await temporaryDirectory('activity-reference');
    quad = path.join(work.path, 'quad-reference');
    expect((await activity('scaffold', quad, '--from', 'quadratic-gradient-descent')).exitCode).toBe(0);
  });
  afterAll(async () => { await work.dispose(); });

  it('runs the converted quadratic suite in the worker: every report §12.3 case agrees and provenance is kept', async () => {
    const { report, exitCode } = await activity<ReferenceReport>('reference', quad);
    expect(exitCode).toBe(0);
    expect(report.summary).toEqual({ cases: 55, passed: 55, failed: 0 });
    expect(report.suite).toMatchObject({ suiteId: 'quad-reference:0.1.0', external: false, binding: 'matches', derivedFrom: { path: 'tests/reference/fixtures/activities/quadratic-gradient-descent.json' } });
    expect(report.suite.notCovered.join(' ')).toMatch(/tests\/reference\/activities\/quadratic\.test\.ts/);
    const first = report.cases.find(item => item.id === 'report-eta-0.25')!;
    expect(first).toMatchObject({ passed: true, points: 4, tolerance: { absolute: 0, relative: 0 } });
    expect(first.provenance).toMatch(/report §12\.3/);
    // Every reported quantity has an expectation (report §12.6): start.position, start.loss and product are restated from
    // each case (derivedFrom.conversion says how), so a fault in any of them can be detected by this suite.
    expect(report.uncovered).toEqual([]);
  });

  it('reports a failing case from external fixtures with its provenance, and a kernel fault fails the package suite', async () => {
    const external = path.join(work.path, 'external-fixtures.json');
    await copyFile(path.join(quad, 'fixtures/reference.json'), external);
    await editJson<{ cases: { id: string; points?: { expect: Record<string, unknown> }[] }[] }>(external, suite => {
      const entry = suite.cases.find(item => item.id === 'report-eta-0.25')!;
      entry.points![1]!.expect.position = 2.5;
    });
    const { report, exitCode } = await activity<ReferenceReport>('reference', quad, '--fixtures', external);
    expect(exitCode).toBe(1);
    expect(report.suite).toMatchObject({ external: true, binding: 'differs' });
    expect(report.summary).toEqual({ cases: 55, passed: 54, failed: 1 });
    const failed = report.cases.find(item => !item.passed)!;
    expect(failed.id).toBe('report-eta-0.25');
    expect(failed.problems).toEqual(['n=1: position: 2, expected 2.5 (absolute 0, relative 0)']);
    expect(failed.provenance).toMatch(/report §12\.3/);

    // A wrong sign in the authored kernel is caught by the package's own suite.
    const kernel = await readFile(path.join(quad, 'kernel.ts'), 'utf8');
    await writeFile(path.join(quad, 'kernel.ts'), kernel.replace('evaluate: quadraticGradientDescentKernel.evaluate', "evaluate: (input: KernelInput) => { const output = quadraticGradientDescentKernel.evaluate(input); const g = output.quantities.gradient; if (g && g.status === 'valid' && typeof g.value === 'number') output.quantities.gradient = { ...g, value: -g.value }; return output; }"));
    const faulty = await activity<ReferenceReport>('reference', quad);
    expect(faulty.exitCode).toBe(1);
    expect(faulty.report.summary.failed).toBeGreaterThan(30);
    expect(faulty.report.cases.find(item => item.id === 'report-eta-0.25')!.problems[0]).toMatch(/gradient: -8, expected 8/);
    await writeFile(path.join(quad, 'kernel.ts'), kernel);
  });

  it('classifies declared boundary cases and generated domain probes without fabricating zeros', async () => {
    const line = path.join(work.path, 'line-boundaries');
    expect((await activity('scaffold', line)).exitCode).toBe(0);
    const { report, exitCode } = await activity<BoundaryReport>('boundaries', line);
    expect(exitCode).toBe(0);
    expect(report.summary).toMatchObject({ declared: 4, unmetExpectations: 0 });
    const byId = Object.fromEntries(report.cases.map(item => [item.id, item]));
    expect(byId['zero-slope']).toMatchObject({ source: 'declared', outcome: 'undefined', statuses: { root: 'undefined:NO_ROOT' }, matches: true });
    expect(byId['constraint-edge']).toMatchObject({ outcome: 'valid', matches: true });
    expect(byId['constraint-beyond']).toMatchObject({ outcome: 'out-of-domain', rejection: [expect.objectContaining({ code: 'CONSTRAINT_VIOLATION' })] });
    expect(byId['generated.m.above']).toMatchObject({ source: 'generated', outcome: 'out-of-domain', matches: true });

    const quadBoundaries = await activity<BoundaryReport>('boundaries', quad);
    expect(quadBoundaries.report.passed).toBe(true);
    expect(quadBoundaries.report.summary.outcomes['numerical-limit']).toBeGreaterThan(0);
    expect(quadBoundaries.report.cases.find(item => item.id === 'generated.index.beyond')).toMatchObject({ outcome: 'out-of-domain' });

    // A declared expectation the model does not meet fails the command.
    await editJson<{ cases: { id: string; expect?: { outcome?: string } }[] }>(path.join(line, 'fixtures/boundaries.json'), set => { set.cases[0]!.expect = { outcome: 'valid' }; });
    const unmet = await activity<BoundaryReport>('boundaries', line);
    expect(unmet.exitCode).toBe(1);
    expect(unmet.report.cases.find(item => item.id === 'zero-slope')).toMatchObject({ matches: false, mismatches: ['outcome undefined, expected valid'] });
  }, 60_000);
});
