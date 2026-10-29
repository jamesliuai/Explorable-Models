/**
 * The on-demand catalogue (`createLazyCatalog`, report §5.2, §18; F1 of docs/study-harness/performance.md): its eager
 * installed index is generated from the installed content and current; before any content is loaded it serves the
 * same references, statuses, model identities and discovery entries as the eager catalogue; `load()` fetches one
 * template's content and serves it only after it reproduces the installed digests; kernels are identified, never
 * loaded, outside the worker. The adapter loads content on demand and reports complete discovery before loading.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { createStudyHarnessAdapter, templateDiscovery, type ReviewRecord } from '@experiment-kit/activity';
import { createInstalledCatalog, createLazyCatalog, INSTALLED_INDEX, INSTALLED_KERNEL_SOURCE, INSTALLED_KERNELS, INSTALLED_TEMPLATES } from '@experiment-kit/catalog';
import { INSTALLED_INDEX_PATH, buildInstalledIndex, renderInstalledIndex } from '../../packages/catalog/scripts/installed-index.js';
import { CONTENT_LOADERS } from '../../packages/catalog/src/content/loaders.js';
import { harness, open, policyFor, requestFor, settled } from '../activity/support/adapter-harness.js';
import { ALL_OPERATIONS, QUADRATIC, dataOf, rig } from '../agent/support/activity-tools.js';

const noWorker = () => { throw new Error('No worker in this test.'); };
const refOf = (templateId: string) => INSTALLED_INDEX.templates.find(entry => entry.ref.templateId === templateId)!.ref;
const plain = <T>(value: T): T => JSON.parse(JSON.stringify(value));

describe('installed index', () => {
  it('is current: regenerating it from the installed content reproduces the committed file', () => {
    expect(readFileSync(INSTALLED_INDEX_PATH, 'utf8')).toBe(renderInstalledIndex(buildInstalledIndex()));
  });
  it('lists exactly the installed templates, models and kernels, and bundles one content chunk per template', () => {
    expect(INSTALLED_INDEX.templates.map(entry => entry.ref.templateId)).toEqual(INSTALLED_TEMPLATES.map(template => template.templateId));
    expect(Object.keys(CONTENT_LOADERS).sort()).toEqual(INSTALLED_TEMPLATES.map(template => `${template.templateId}@${template.version}`).sort());
    expect(INSTALLED_INDEX.kernels).toEqual(INSTALLED_KERNELS.map(kernel => ({ id: kernel.id, version: kernel.version, mode: kernel.mode })));
  });
  it('the worker kernel source names exactly the installed kernels and loads each one on demand', async () => {
    expect(plain(INSTALLED_KERNEL_SOURCE.kernels)).toEqual(INSTALLED_KERNELS.map(kernel => ({ id: kernel.id, version: kernel.version, mode: kernel.mode })));
    for (const kernel of INSTALLED_KERNELS) expect(await INSTALLED_KERNEL_SOURCE.load(kernel.id, kernel.version)).toBe(kernel);
    await expect(INSTALLED_KERNEL_SOURCE.load('quadratic-gradient-descent', '9.9.9')).rejects.toThrow();
  });
});

describe('createLazyCatalog before and after loading', () => {
  const reviews: ReviewRecord[] = [];
  const marks = {
    revocations: [{ kind: 'template' as const, id: 'linear-transformation', version: '1.0.0', reason: 'Withdrawn by the host for this test.' }],
    deprecations: [{ kind: 'model' as const, id: 'function-derivative', version: '1.0.0', reason: 'Superseded in this test.' }],
  };

  it('serves the eager catalogue’s references, statuses, model identities and discovery entries without loading any content', () => {
    const eager = createInstalledCatalog({ workerFactory: noWorker, reviews, ...marks });
    const lazy = createLazyCatalog({ workerFactory: noWorker, reviews, ...marks });
    expect(lazy.listTemplates()).toEqual(eager.listTemplates());
    for (const entry of eager.listTemplates()) {
      expect(lazy.loaded(entry.template)).toBe(false);
      expect(lazy.getTemplate(entry.template)).toBeNull();
      expect(lazy.getModel(entry.model)).toBeNull();
      expect(lazy.status(entry.template)).toEqual(eager.status(entry.template));
      expect(lazy.status(entry.model)).toEqual(eager.status(entry.model));
      expect(lazy.status({ ...entry.template, digest: `sha256:${'1'.repeat(64)}` })).toEqual({ lifecycle: entry.status.revoked ? 'revoked' : 'authored', reviews: [], revoked: entry.status.revoked, ...(entry.status.revoked ? { revocationReason: entry.status.revocationReason } : {}) });
      expect(lazy.describe(entry.template)).toEqual(eager.describe(entry.template));
      expect(lazy.identity(entry.model)).toEqual(eager.identity(entry.model));
      expect(lazy.identity(entry.template)).toBeNull();
    }
    expect(lazy.problems()).toEqual([]);
    expect(lazy.reviewRegistry.records).toEqual([]);
  });

  it('loads one template’s verified content on demand, once, and then serves exactly the installed content', async () => {
    const eager = createInstalledCatalog({ workerFactory: noWorker });
    const lazy = createLazyCatalog({ workerFactory: noWorker });
    const ref = refOf('vector-orientation-3d');
    const [first, second] = await Promise.all([lazy.load(ref), lazy.load(ref)]);
    expect(first).toEqual({ ok: true });
    expect(second).toEqual({ ok: true });
    expect(lazy.loaded(ref)).toBe(true);
    expect(lazy.loaded(refOf('quadratic-gradient-descent'))).toBe(false);
    const template = lazy.getTemplate(ref)!;
    expect(template).toEqual(eager.getTemplate(ref));
    expect(lazy.getModel(template.model)).toEqual(eager.getModel(template.model));
    expect(lazy.identity(ref)).toEqual(eager.identity(ref));
    expect(lazy.describe(ref)).toEqual(templateDiscovery(template, lazy.getModel(template.model)!));
    expect(await lazy.load({ templateId: 'vector-orientation-3d', version: '9.9.9' })).toMatchObject({ ok: false, diagnostics: [{ code: 'NOT_FOUND' }] });
    const all = await lazy.loadAll();
    expect(all.every(result => result.ok)).toBe(true);
    for (const entry of eager.listTemplates()) expect(lazy.getTemplate(entry.template)).toEqual(eager.getTemplate(entry.template));
    expect(lazy.problems()).toEqual([]);
  });

  it('honours include like the eager catalogue and rejects unknown template IDs', async () => {
    const lazy = createLazyCatalog({ workerFactory: noWorker, include: ['linear-transformation'] });
    expect(lazy.listTemplates().map(entry => entry.template.templateId)).toEqual(['linear-transformation']);
    expect(await lazy.load(refOf('function-derivative'))).toMatchObject({ ok: false, diagnostics: [{ code: 'NOT_FOUND' }] });
    expect(() => createLazyCatalog({ include: ['no-such-template'] })).toThrow(RangeError);
  });

});

describe('adapter with the on-demand catalogue', () => {
  it('lists every template before any content is loaded, with the entries it lists after loading', async () => {
    const h = harness({ customCatalog: factory => createLazyCatalog({ workerFactory: factory }) });
    const before = h.adapter.getCapabilities();
    expect(before.templates.map(entry => entry.template.templateId)).toEqual(INSTALLED_TEMPLATES.map(template => template.templateId));
    expect(before.unavailable).toEqual([]);
    await (h.catalog as ReturnType<typeof createLazyCatalog>).loadAll();
    expect(h.adapter.getCapabilities()).toEqual(before);
    h.adapter.dispose();
  });

  it('prepares an activity by loading only its template’s content, then evaluates it in the worker', async () => {
    const h = harness({ customCatalog: factory => createLazyCatalog({ workerFactory: factory }) });
    const catalog = h.catalog as ReturnType<typeof createLazyCatalog>;
    const opened = await open(h, requestFor({ activityId: 'act-lazy-1' }));
    await settled(h, 'act-lazy-1');
    expect(catalog.loaded(refOf('quadratic-gradient-descent'))).toBe(true);
    expect(INSTALLED_INDEX.templates.filter(entry => entry.ref.templateId !== 'quadratic-gradient-descent').every(entry => !catalog.loaded(entry.ref))).toBe(true);
    expect(opened.learner.getProjection().frame?.kind).toBe('committed');
    h.adapter.dispose();
  });

  it('validates through the same on-demand path', async () => {
    const h = harness({ customCatalog: factory => createLazyCatalog({ workerFactory: factory }), policy: policyFor() });
    const report = await h.adapter.validate(requestFor({ activityId: 'act-lazy-2' }));
    expect(report.ok).toBe(true);
    h.adapter.dispose();
  });
});

describe('agent tools with the on-demand catalogue', () => {
  it('describe a template whose content is not loaded yet by loading and verifying it first', async () => {
    const h = harness({ customCatalog: factory => createLazyCatalog({ workerFactory: factory }), policy: policyFor({ allowedTools: ALL_OPERATIONS }) });
    const catalog = h.catalog as ReturnType<typeof createLazyCatalog>;
    const r = rig({ harness: h });
    expect(catalog.loaded(refOf('quadratic-gradient-descent'))).toBe(false);
    const described = dataOf(await r.tools.execute('activity_describe_template', { ...QUADRATIC }));
    expect(described.detail).toBe('learner-safe');
    expect(described.stages.map((stage: { id: string }) => stage.id)).toContain('predict');
    expect(catalog.loaded(refOf('quadratic-gradient-descent'))).toBe(true);
    h.adapter.dispose();
  });
});
