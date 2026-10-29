/**
 * Installed entries that fail mechanical validation are never served (report §5.2): they are reported by
 * `problems()`, absent from discovery, and any reference to them resolves as unvouched `authored` content.
 */
import { describe, expect, it, vi } from 'vitest';
import type { ActivityTemplate } from '@experiment-kit/activity';

vi.mock(import('../../packages/catalog/src/templates/index.js'), async importOriginal => {
  const original = await importOriginal();
  const base = original.quadraticGradientDescentTemplate;
  const variant = (templateId: string, edit: (draft: ActivityTemplate) => void): ActivityTemplate => {
    const draft = structuredClone(base) as ActivityTemplate;
    draft.templateId = templateId;
    edit(draft);
    return draft;
  };
  return {
    ...original,
    INSTALLED_TEMPLATES: [
      base,
      // Model reference with a digest that is not the installed manifest's.
      variant('broken-model-digest', draft => { draft.model = { ...draft.model, digest: `sha256:${'0'.repeat(64)}` }; }),
      // Schema violation: an unknown style field.
      variant('broken-schema', draft => { (draft.views[0]!.marks[0]!.style as unknown as Record<string, unknown>).color = '#ff0000'; }),
      // Semantic violation: the scenario's η·a = 2·2.5 = 5 breaks the model's coupled bound η·a ≤ 4.
      variant('broken-scenario', draft => { draft.scenarios[0]!.parameters = { a: 2.5, eta: 2, x0: 4 }; }),
    ],
  };
});

const { createInstalledCatalog } = await import('../../packages/catalog/src/index.js');

describe('installed entries that fail validation', () => {
  it('are not served, are reported with their diagnostics and resolve as authored', () => {
    const catalog = createInstalledCatalog();
    expect(catalog.listTemplates().map(entry => entry.template.templateId)).toEqual(['quadratic-gradient-descent']);
    const problems = Object.fromEntries(catalog.problems().map(problem => [problem.id, problem.diagnostics.map(item => `${item.code} ${item.path}`)]));
    expect(problems).toEqual({
      'broken-model-digest': ['INVALID_REFERENCE $.model.digest'],
      'broken-schema': ['SCHEMA $.views[0].marks[0].style.color'],
      'broken-scenario': ['CONSTRAINT_VIOLATION $.scenarios[0].parameters'],
    });
    for (const templateId of Object.keys(problems)) {
      expect(catalog.getTemplate({ templateId, version: '1.0.0' })).toBeNull();
      expect(catalog.identity({ templateId, version: '1.0.0' })).toBeNull();
      expect(catalog.status({ templateId, version: '1.0.0', digest: `sha256:${'1'.repeat(64)}` })).toEqual({ lifecycle: 'authored', reviews: [], revoked: false });
    }
    expect(catalog.status(catalog.listTemplates()[0]!.template).lifecycle).toBe('reference-checked');
  });
});
