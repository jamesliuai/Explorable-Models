/**
 * `getCapabilities` never drops an installed entry silently (report §5.3, docs/embedding.md; R44): an entry the
 * catalogue excluded — here on-demand content that does not reproduce its installed digest, which withdraws it from
 * `listTemplates` — is reported under `unavailable` with the catalogue's diagnostics (`ActivityCatalog.problems`).
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../packages/catalog/src/content/loaders.ts', async () => {
  const actual = await vi.importActual<typeof import('../../packages/catalog/src/content/loaders.ts')>('../../packages/catalog/src/content/loaders.ts');
  return {
    CONTENT_LOADERS: {
      ...actual.CONTENT_LOADERS,
      // A tampered content chunk: the same template with an edited title no longer matches its installed digest.
      'function-derivative@1.0.0': async () => {
        const real = await actual.CONTENT_LOADERS['function-derivative@1.0.0']!();
        const template = structuredClone(real.content.template) as { title: string };
        template.title = `${template.title} (tampered)`;
        return { content: { template, manifest: real.content.manifest } };
      },
    },
  };
});

import { createStudyHarnessAdapter, type ActivityCatalog } from '@experiment-kit/activity';
import { createLazyCatalog } from '../../packages/catalog/src/lazy.js';
import { policyFor } from './support/adapter-harness.js';
import { MemoryHost } from './support/memory-host.js';

const noWorker = (): Worker => { throw new Error('no worker is needed for discovery'); };

describe('excluded catalogue entries are reported, never dropped (R44)', () => {
  it('a template withdrawn after its on-demand content failed verification is listed under unavailable with the reason', async () => {
    const catalog = createLazyCatalog({ workerFactory: noWorker });
    const adapter = createStudyHarnessAdapter({ catalog, host: new MemoryHost({ policy: policyFor() }) });
    const id = 'function-derivative';
    expect(adapter.getCapabilities().templates.some(entry => entry.template.templateId === id)).toBe(true);
    const loaded = await catalog.load({ templateId: id, version: '1.0.0' });
    expect(loaded.ok).toBe(false);
    const after = adapter.getCapabilities();
    expect(after.templates.some(entry => entry.template.templateId === id)).toBe(false);
    const unavailable = after.unavailable.filter(entry => entry.template.templateId === id);
    expect(unavailable).toEqual([{ template: { templateId: id, version: '1.0.0' }, diagnostics: [expect.objectContaining({ code: 'INTEGRITY_FAILURE', recovery: expect.any(String) })] }]);
    // Every other installed template is still offered.
    expect(after.templates.length + after.unavailable.length).toBe(catalog.listTemplates().length + 1);
    adapter.dispose();
  });

  it('reports every template problem of a catalogue once, and ignores model problems and malformed entries', () => {
    const problems = [
      { kind: 'template' as const, id: 'broken-template', version: '2.0.0', diagnostics: [{ code: 'SCHEMA' as const, path: '$.views', message: 'Invalid view.' }] },
      { kind: 'template' as const, id: 'broken-template', version: '2.0.0', diagnostics: [] },
      { kind: 'model' as const, id: 'broken-model', version: '1.0.0', diagnostics: [{ code: 'SCHEMA' as const, path: '$', message: 'Invalid model.' }] },
      { kind: 'template' as const, id: 42 as unknown as string, version: '1.0.0', diagnostics: [] },
    ];
    const catalog: ActivityCatalog = {
      listTemplates: () => [], getTemplate: () => null, getModel: () => null, createWorker: noWorker,
      status: () => ({ lifecycle: 'authored', reviews: [], revoked: false }), problems: () => problems,
    };
    const adapter = createStudyHarnessAdapter({ catalog, host: new MemoryHost({ policy: policyFor() }) });
    const report = adapter.getCapabilities();
    expect(report.templates).toEqual([]);
    expect(report.unavailable).toEqual([{ template: { templateId: 'broken-template', version: '2.0.0' }, diagnostics: [expect.objectContaining({ code: 'SCHEMA', path: '$.views', recovery: expect.any(String) })] }]);
    adapter.dispose();
  });
});
