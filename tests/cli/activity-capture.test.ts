/**
 * `explorable-models activity capture` (report §15.2, §19, A50): every stage is prepared through the adapter and the
 * fixture host, its solution-bearing groups are authorized by the host, and the learner surface is mounted with the
 * learner projection. Outputs: a PNG of the card, the surface's pure-SVG capture and projection-only companion text.
 * Content a stage does not show is absent from every output; a failed run keeps the previous captures.
 */
import { readFile, readdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { activity, editJson, temporaryDirectory } from './activity-support';

interface CaptureReport {
  passed: boolean;
  directory: string | null;
  stage?: string;
  settings: { width: number; theme: string };
  stages: { stageId: string; ok: boolean; png: string | null; svg: string | null; companion: string | null; svgError: { code: string } | null; revealed: string[]; reviewNotice: string; projectionDigest: string; math: { equations: number; plainText: number } }[];
}
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

describe('activity capture', () => {
  let work: Awaited<ReturnType<typeof temporaryDirectory>>;
  let line: string;
  beforeAll(async () => {
    work = await temporaryDirectory('activity-capture');
    line = path.join(work.path, 'line-capture');
    expect((await activity('scaffold', line)).exitCode).toBe(0);
  });
  afterAll(async () => { await work.dispose(); });

  it('captures every stage with PNG, pure SVG and companion text from the learner projection only', async () => {
    const { report, exitCode } = await activity<CaptureReport>('capture', line, '--all-stages', '--width', '640');
    expect(exitCode).toBe(0);
    expect(report.directory).toBe(path.join(await realpath(line), 'review/captures'));
    expect(report.stages.map(stage => stage.stageId)).toEqual(['predict', 'explore', 'closed']);
    expect(report.stages.every(stage => stage.ok)).toBe(true);
    const files = (await readdir(report.directory!)).sort();
    expect(files).toEqual(['captures.json', 'closed.png', 'closed.txt', 'explore.png', 'explore.svg', 'explore.txt', 'predict.png', 'predict.svg', 'predict.txt']);
    for (const name of files.filter(file => file.endsWith('.png'))) expect((await readFile(path.join(report.directory!, name))).subarray(0, 8).equals(PNG_SIGNATURE)).toBe(true);
    for (const name of files.filter(file => file.endsWith('.svg'))) {
      const svg = await readFile(path.join(report.directory!, name), 'utf8');
      expect(svg.startsWith('<svg')).toBe(true);
      expect(svg).not.toMatch(/foreignObject|<script|https?:\/\/(?!www\.w3\.org)/i);
    }
    const [predict, explore, closed] = report.stages;
    // The prediction stage shows no solution-bearing group: the root is in no output channel.
    expect(predict).toMatchObject({ revealed: [], reviewNotice: 'Exploratory composition — not reviewed', math: { equations: 1, plainText: 0 } });
    const predictText = await readFile(path.join(report.directory!, 'predict.txt'), 'utf8');
    expect(predictText).toContain('Line value at the probe: 3');
    expect(predictText).not.toMatch(/Root|−1|x_r/);
    expect(await readFile(path.join(report.directory!, 'predict.svg'), 'utf8')).not.toMatch(/Root \(x_r|>root</);
    // The exploration stage is entered with the host's authorization of the root groups.
    expect(explore!.revealed).toEqual(['root-point', 'root', 'root-rule']);
    expect(await readFile(path.join(report.directory!, 'explore.txt'), 'utf8')).toMatch(/Root: −1/);
    expect(closed).toMatchObject({ svg: null, svgError: { code: 'NOT_FOUND' } });
    expect(new Set(report.stages.map(stage => stage.projectionDigest)).size).toBe(3);
  });

  it('captures one stage in a dark theme and keeps the previous outputs when a run is refused', async () => {
    const out = path.join(work.path, 'single');
    const { report } = await activity<CaptureReport>('capture', line, '--stage', 'explore', '--theme', 'dark', '--out', out);
    expect(report).toMatchObject({ passed: true, settings: { theme: 'dark' } });
    expect((await readdir(out)).sort()).toEqual(['captures.json', 'explore.png', 'explore.svg', 'explore.txt']);
    expect((await activity('capture', line, '--stage', 'missing')).exitCode).toBe(1);

    const before = await readFile(path.join(out, 'explore.png'));
    await editJson<Record<string, unknown>>(path.join(line, 'template.json'), template => { delete template.stages; });
    const refused = await activity<CaptureReport>('capture', line, '--stage', 'explore', '--out', out);
    expect(refused.exitCode).toBe(1);
    expect(refused.report.stage).toBe('validate');
    expect((await readFile(path.join(out, 'explore.png'))).equals(before)).toBe(true);
  });

  it('captures a 3D template through its 2D projection fallback', async () => {
    const vector = path.join(work.path, 'vector-capture');
    expect((await activity('scaffold', vector, '--from', 'vector-orientation-3d')).exitCode).toBe(0);
    const { report } = await activity<CaptureReport>('capture', vector, '--stage', 'explore-cross');
    expect(report.passed).toBe(true);
    const stage = report.stages[0]!;
    expect(stage.svg).toBe('explore-cross.svg');
    const svg = await readFile(path.join(report.directory!, stage.svg!), 'utf8');
    expect(svg).toMatch(/projection/);
  }, 60_000);
});
