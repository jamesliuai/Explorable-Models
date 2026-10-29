/**
 * The on-demand catalogue serves loaded content only when it reproduces the installed digests (report §5.2, A07, A49;
 * F1): tampered content is refused with INTEGRITY_FAILURE, withdrawn and reported, and every reference to it resolves
 * as unvouched `authored` content — nothing else is substituted. A chunk that cannot be fetched is reported as NOT_READY
 * without withdrawing the entry. The adapter returns these failures from prepare.
 */
import { describe, expect, it, vi } from 'vitest';
import type { ActivityTemplate } from '@experiment-kit/activity';

vi.mock(import('../../packages/catalog/src/content/linear-transformation.js'), async importOriginal => {
  const original = await importOriginal();
  // Same template ID, version and model, one changed word of learner copy: a different template digest.
  const template = structuredClone(original.content.template) as ActivityTemplate;
  template.title = `${template.title} (edited)`;
  return { content: { template, manifest: original.content.manifest } };
});
vi.mock(import('../../packages/catalog/src/content/function-derivative.js'), async importOriginal => {
  const original = await importOriginal();
  // Same template, model manifest with one changed bound: a different model digest than the installed one.
  const manifest = structuredClone(original.content.manifest);
  manifest.parameters.A!.max = 3;
  return { content: { template: original.content.template, manifest } };
});
vi.mock(import('../../packages/catalog/src/content/vector-orientation-3d.js'), () => { throw new Error('chunk unavailable'); });

const { createLazyCatalog, INSTALLED_INDEX } = await import('../../packages/catalog/src/index.js');
const { harness, op, requestFor } = await import('../activity/support/adapter-harness.js');
const refOf = (templateId: string) => INSTALLED_INDEX.templates.find(entry => entry.ref.templateId === templateId)!.ref;
const noWorker = () => { throw new Error('No worker in this test.'); };

describe('loaded content that does not reproduce the installed digests', () => {
  it('is refused, withdrawn and reported; references to it resolve as authored', async () => {
    const catalog = createLazyCatalog({ workerFactory: noWorker });
    const linear = refOf('linear-transformation'), derivative = refOf('function-derivative');
    expect(catalog.status(linear).lifecycle).toBe('reference-checked');
    expect(await catalog.load(linear)).toMatchObject({ ok: false, diagnostics: [{ code: 'INTEGRITY_FAILURE', path: '$.template.digest' }] });
    expect(await catalog.load(derivative)).toMatchObject({ ok: false, diagnostics: [{ code: 'INTEGRITY_FAILURE', path: '$.model' }] });
    for (const ref of [linear, derivative]) {
      expect(catalog.getTemplate(ref)).toBeNull();
      expect(catalog.loaded(ref)).toBe(false);
      expect(catalog.describe(ref)).toBeNull();
      expect(catalog.status(ref)).toEqual({ lifecycle: 'authored', reviews: [], revoked: false });
    }
    expect(catalog.listTemplates().map(entry => entry.template.templateId)).toEqual(['quadratic-gradient-descent', 'vector-orientation-3d', 'quadratic-surface-gradient']);
    expect(catalog.problems().map(problem => `${problem.id} ${problem.diagnostics.map(item => item.code).join(',')}`)).toEqual(['linear-transformation INTEGRITY_FAILURE', 'function-derivative INTEGRITY_FAILURE']);
    expect(await catalog.load(linear)).toMatchObject({ ok: false, diagnostics: [{ code: 'NOT_FOUND' }] });
  });

  it('reports a chunk that cannot be fetched as NOT_READY without withdrawing the entry', async () => {
    const catalog = createLazyCatalog({ workerFactory: noWorker });
    const ref = refOf('vector-orientation-3d');
    expect(await catalog.load(ref)).toMatchObject({ ok: false, diagnostics: [{ code: 'NOT_READY' }] });
    expect(catalog.listTemplates().some(entry => entry.template.templateId === 'vector-orientation-3d')).toBe(true);
    expect(catalog.problems()).toEqual([]);
  });

  it('makes the adapter refuse prepare with the integrity diagnostic, never another template', async () => {
    const h = harness({ customCatalog: factory => createLazyCatalog({ workerFactory: factory }) });
    const result = await h.adapter.prepare(requestFor({ activityId: 'act-tampered', template: { templateId: 'linear-transformation', version: '1.0.0' } }), { operationId: op('prepare') });
    expect(result).toMatchObject({ ok: false, diagnostics: [{ code: 'INTEGRITY_FAILURE' }] });
    const unreachable = await h.adapter.prepare(requestFor({ activityId: 'act-unreachable', template: { templateId: 'vector-orientation-3d', version: '1.0.0' } }), { operationId: op('prepare') });
    expect(unreachable).toMatchObject({ ok: false, diagnostics: [{ code: 'NOT_READY' }] });
    h.adapter.dispose();
  });
});
