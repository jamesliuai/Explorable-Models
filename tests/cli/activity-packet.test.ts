/**
 * `experiment-kit activity review-packet` and `package` (report §12.6, §15.2, A30, A56): the packet states exact
 * identities, provenance, tolerances, mutation sensitivity, stage captures and alternatives, and leaves the reviewer
 * sign-off empty; the package archive is reproducible and its integrity manifest matches the archived bytes.
 */
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { gunzipSync, unzipSync } from 'fflate';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { modelIdentity } from '@experiment-kit/core/model';
import { createInstalledCatalog, quadraticGradientDescentManifest, quadraticGradientDescentTemplate, QUADRATIC_REFERENCE_SUITE_DIGEST } from '@experiment-kit/catalog';
import { templateRef } from '@experiment-kit/activity';
import { activity, editJson, readJson, temporaryDirectory } from './activity-support';

const sha = (bytes: Uint8Array | string) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;

interface PacketReport { passed: boolean; directory: string; lifecycle: string; reference: { cases: number; failed: number }; mutation: { mutants: number; detected: number }; captures: { stage: string; ok: boolean; png: string | null }[]; signOff: string }
interface PackageReport { passed: boolean; archive: string; sha256: string; bytes: number; manifestDigest: string; excluded: string[]; manifest: { lifecycle: string; template: { templateId: string; digest: string }; model: { digest: string }; scientificRevision: string; files: { path: string; bytes: number; sha256: string }[] } }

describe('activity review packet and package', () => {
  let work: Awaited<ReturnType<typeof temporaryDirectory>>;
  let line: string;
  beforeAll(async () => {
    work = await temporaryDirectory('activity-packet');
    line = path.join(work.path, 'line-packet');
    expect((await activity('scaffold', line)).exitCode).toBe(0);
  });
  afterAll(async () => { await work.dispose(); });

  it('writes a review packet for a package with exact digests, results, captures and an empty sign-off', async () => {
    const { report, exitCode } = await activity<PacketReport>('review-packet', line);
    expect(exitCode).toBe(0);
    expect(report).toMatchObject({ passed: true, lifecycle: 'authored', reference: { cases: 7, failed: 0 }, signOff: expect.stringContaining('cannot sign') });
    expect(report.mutation.detected).toBe(report.mutation.mutants);
    const validation = (await activity<{ template: { digest: string }; modelIdentity: { scientificRevision: string }; referenceSuite: { declared: { digest: string } } }>('validate', line)).report;
    const readme = await readFile(path.join(report.directory, 'README.md'), 'utf8');
    for (const digest of [validation.template.digest, validation.modelIdentity.scientificRevision, validation.referenceSuite.declared.digest]) expect(readme).toContain(digest);
    for (const heading of ['## Exact identity', '## Purpose and task intent', '## Derivation', '## Assumptions', '## Limitations', '## Units and conventions', '## Reference cases', '## Mutation sensitivity', '## Boundary cases', '## Stage-by-stage captures', '## Accessible alternatives', '## Reviewer sign-off'])
      expect(readme).toContain(heading);
    expect(readme).toMatch(/This section is intentionally empty\. An engineering agent cannot sign it\./);
    expect(readme).toContain('| probe-outside-view | m = 3, b = 5, p = 4: m·p + b = 17 is rejected | Hand derivation: 3·4 + 5 = 17 > 10 violates probe-in-view. | exact | pass (rejected as expected) |');
    expect(readme).toContain('![Where a line crosses zero, stage explore](captures/explore.png)');
    expect(readme).not.toMatch(/independently reviewed|has been reviewed|approved for/i);
    const packet = await readJson<{ contract: string; status: { signOff: unknown; lifecycle: string }; captures: { stages: { png: string }[] } }>(path.join(report.directory, 'packet.json'));
    expect(packet).toMatchObject({ contract: 'experiment-kit.review-packet', status: { signOff: null, lifecycle: 'authored' } });
    for (const stage of packet.captures.stages.filter(item => item.png)) expect(existsSync(path.join(report.directory, stage.png))).toBe(true);
  });

  it('writes the installed quadratic packet with catalogue status and the installed reference-suite digest', async () => {
    const out = path.join(work.path, 'installed-quadratic');
    const { report, exitCode } = await activity<PacketReport>('review-packet', '--installed', 'quadratic-gradient-descent', '--out', out, '--index', '4');
    expect(exitCode).toBe(0);
    expect(report).toMatchObject({ lifecycle: 'reference-checked', reference: { cases: 55, failed: 0 } });
    expect(report.captures.map(item => item.stage)).toEqual(quadraticGradientDescentTemplate.stages.map(stage => stage.id));
    const readme = await readFile(path.join(out, 'README.md'), 'utf8');
    expect(readme).toContain(templateRef(quadraticGradientDescentTemplate).digest);
    expect(readme).toContain(modelIdentity(quadraticGradientDescentManifest).scientificRevision);
    expect(readme).toContain(QUADRATIC_REFERENCE_SUITE_DIGEST);
    expect(readme).toContain('| Fixture binding | matches |');
    expect(readme).toContain('tests/reference/activities/quadratic.test.ts');
    expect(readme).toContain('tests/browser/study-quadratic.spec.ts#trace-table-equivalent | yes |');
    // Mutation sensitivity covers every reported quantity: no quantity is without an expectation, and every generic
    // mutant (including those of product, start.position and start.loss) is detected.
    const packet = await readJson<{ mutation: { uncovered: string[]; mutants: { id: string; killed: boolean }[] }; referenceSuite: { suite: { derivedFrom: { conversion: string } } } }>(path.join(out, 'packet.json'));
    expect(packet.mutation.uncovered).toEqual([]);
    expect(packet.mutation.mutants.filter(mutant => !mutant.killed)).toEqual([]);
    expect(packet.mutation.mutants.map(mutant => mutant.id)).toEqual(expect.arrayContaining(['sign:product', 'factor:product', 'sign:start.position', 'factor:start.loss']));
    expect(packet.referenceSuite.suite.derivedFrom.conversion).toMatch(/product is the IEEE-754 double product/);
    expect(readme).not.toContain('Quantities without any expectation in this suite');
  }, 90_000);

  it('packages the exact files reproducibly with an integrity manifest, and refuses an invalid package', async () => {
    const zip = await activity<PackageReport>('package', line, '--out', path.join(work.path, 'one.zip'));
    const again = await activity<PackageReport>('package', line, '--out', path.join(work.path, 'two.zip'));
    expect(zip.exitCode).toBe(0);
    expect(zip.report.sha256).toBe(again.report.sha256);
    const bytes = await readFile(zip.report.archive);
    expect(sha(bytes)).toBe(zip.report.sha256);
    const entries = unzipSync(bytes);
    const root = 'line-packet-0.1.0/';
    const manifest = JSON.parse(new TextDecoder().decode(entries[`${root}package-manifest.json`]!)) as PackageReport['manifest'];
    expect(manifest).toMatchObject({ lifecycle: 'authored', template: { templateId: 'line-packet' } });
    expect(sha(entries[`${root}package-manifest.json`]!)).toBe(zip.report.manifestDigest);
    expect(manifest.files.map(file => file.path)).toEqual(expect.arrayContaining(['model.json', 'template.json', 'kernel.ts', 'checks.ts', 'fixtures/reference.json', 'authoring.json', 'copy.md']));
    for (const file of manifest.files) {
      expect(sha(entries[`${root}${file.path}`]!)).toBe(file.sha256);
      expect(file.sha256).toBe(sha(await readFile(path.join(line, file.path))));
    }
    expect(Object.keys(entries).some(name => name.includes('.experiment-kit'))).toBe(false);

    const tgz = await activity<PackageReport>('package', line, '--format', 'tgz', '--out', path.join(work.path, 'one.tgz'));
    const tgzAgain = await activity<PackageReport>('package', line, '--format', 'tgz', '--out', path.join(work.path, 'two.tgz'));
    expect(tgz.report.sha256).toBe(tgzAgain.report.sha256);
    const tar = gunzipSync(new Uint8Array(await readFile(tgz.report.archive)));
    expect(new TextDecoder().decode(tar.subarray(0, 100)).replace(/\0+$/, '')).toBe(`${root}authoring.json`);
    expect(tgz.report.manifest.files).toEqual(zip.report.manifest.files);

    await editJson<Record<string, unknown>>(path.join(line, 'model.json'), model => { delete model.title; });
    const refused = await activity<PackageReport>('package', line, '--out', path.join(work.path, 'three.zip'));
    expect(refused.exitCode).toBe(1);
    expect(existsSync(path.join(work.path, 'three.zip'))).toBe(false);
  });
});

describe('committed subject-review packets (docs/study-harness/review-packets)', () => {
  // A packet is evidence for the exact digests it names. When a template, model or reference suite changes, the
  // committed packet must be regenerated (review-packets/README.md) rather than left describing other content.
  const catalog = createInstalledCatalog();
  for (const { template: entry } of catalog.listTemplates()) {
    const templateId = entry.templateId;
    it(`${templateId}: the packet pins the installed template, model and scientific revision`, async () => {
      const file = path.join('docs/study-harness/review-packets', templateId, 'packet.json');
      expect(existsSync(file), `${file} is missing`).toBe(true);
      const packet = JSON.parse(await readFile(file, 'utf8')) as { identity: { template: { digest: string }; model: { digest: string }; modelIdentity: { scientificRevision: string } } };
      const identity = catalog.identity({ templateId, version: entry.version });
      if (identity?.kind !== 'template') throw new Error(`${templateId} is not installed`);
      expect(packet.identity.template.digest).toBe(identity.template.digest);
      expect(packet.identity.model.digest).toBe(identity.model.digest);
      expect(packet.identity.modelIdentity.scientificRevision).toBe(identity.modelIdentity.scientificRevision);
    });
  }
});
