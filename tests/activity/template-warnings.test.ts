/**
 * Authoring warnings (report §15.2): `templateWarnings` reports content a template declares that its own stages can
 * never show (`NEVER_VISIBLE`) and declarations nothing refers to (`UNREFERENCED`). They are warnings, not errors:
 * `validateTemplateSemantics` (which the adapter runs) is unchanged, and orphaned references remain its errors. The
 * five installed templates produce none. Fixtures are edits of the CLI scaffold template (packages/cli/templates).
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { modelIdentity, type ModelManifest } from '../../packages/core/src/model/index';
import {
  DIAGNOSTIC_CODES, LEARNER_MESSAGES, templateWarnings, validateTemplateSemantics, type ActivityTemplate,
} from '../../packages/activity/src/index';
import { createInstalledCatalog } from '../../packages/catalog/src/index';

const read = <T>(file: string): T => JSON.parse(readFileSync(new URL(`../../packages/cli/templates/activity/${file}`, import.meta.url), 'utf8')) as T;
const manifest = read<ModelManifest>('model.json');
const base = (): ActivityTemplate => {
  const template = read<ActivityTemplate>('template.json');
  template.model.digest = modelIdentity(manifest).digest;
  return template;
};
/** Applies `edit` to the scaffold template; the result must still be free of semantic errors. */
function warningsAfter(edit: (template: ActivityTemplate) => void): [string, string][] {
  const template = base();
  edit(template);
  expect(validateTemplateSemantics(template, manifest), 'the edited fixture must stay semantically valid').toEqual([]);
  return templateWarnings(template, manifest).map(item => [item.code, item.path]);
}
const groupIndex = (template: ActivityTemplate, id: string) => template.groups.findIndex(group => group.id === id);
const stage = (template: ActivityTemplate, id: string) => template.stages.find(item => item.id === id)!;

describe('templateWarnings', () => {
  it('reports nothing for the scaffold template and for every installed template', () => {
    expect(warningsAfter(() => undefined)).toEqual([]);
    const catalog = createInstalledCatalog();
    const entries = catalog.listTemplates();
    expect(entries.map(entry => entry.template.templateId).sort()).toEqual(['function-derivative', 'linear-transformation', 'quadratic-gradient-descent', 'quadratic-surface-gradient', 'vector-orientation-3d']);
    for (const entry of entries) {
      const template = catalog.getTemplate(entry.template)!, model = catalog.getModel(entry.model)!;
      expect(validateTemplateSemantics(template, model), template.templateId).toEqual([]);
      expect(templateWarnings(template, model), template.templateId).toEqual([]);
    }
  });

  it('UNREFERENCED: a group that holds nothing', () => {
    expect(warningsAfter(template => { template.groups.push({ id: 'notes', kind: 'annotation', label: 'Notes', description: 'Unused.', solutionBearing: false, members: [] }); }))
      .toEqual([['UNREFERENCED', '$.groups[12]']]);
  });

  it('NEVER_VISIBLE: a non-empty group no stage shows, reported once', () => {
    expect(warningsAfter(template => { template.groups.push({ id: 'more-values', kind: 'quantity', label: 'More values', description: 'Never listed by a stage.', solutionBearing: false, members: ['slope'] }); }))
      .toEqual([['NEVER_VISIBLE', '$.groups[12]']]);
  });

  it('NEVER_VISIBLE: a view whose group no stage shows is reported on the view, not again on its group', () => {
    expect(warningsAfter(template => {
      template.groups.push({ id: 'hidden-values', kind: 'view', label: 'Hidden values', description: 'Never shown.', solutionBearing: false, members: ['hidden-values'] });
      template.views.push({ id: 'hidden-values', kind: 'values', group: 'hidden-values', title: 'Hidden values', description: 'Never shown.', equalAspect: false, marks: [], quantities: ['slope'] });
    })).toEqual([['NEVER_VISIBLE', '$.views[3].group']]);
  });

  it('NEVER_VISIBLE: a view quantity no stage that shows the view can read', () => {
    // The root and its rule are shown nowhere: their groups, and the values view's root entry, are reported.
    expect(warningsAfter(template => { const explore = stage(template, 'explore'); delete explore.visible.root; delete explore.visible['root-rule']; }).sort())
      .toEqual([['NEVER_VISIBLE', `$.groups[${groupIndex(base(), 'root')}]`], ['NEVER_VISIBLE', `$.groups[${groupIndex(base(), 'root-rule')}]`], ['NEVER_VISIBLE', '$.views[1].quantities[4]']].sort());
  });

  it('NEVER_VISIBLE: a mark never shown together with the data it binds', () => {
    expect(warningsAfter(template => {
      template.groups.push({ id: 'root-mark', kind: 'mark', label: 'Root mark', description: 'Shown only before the root data is.', solutionBearing: false, members: ['root-marker'] });
      template.views[0]!.marks.find(mark => mark.id === 'root-marker')!.group = 'root-mark';
      stage(template, 'predict').visible['root-mark'] = 'fixed';
    })).toEqual([['NEVER_VISIBLE', '$.views[0].marks[2]']]);
  });

  it('UNREFERENCED: an equation no equation view lists', () => {
    expect(warningsAfter(template => { template.views[2]!.equations = ['rule']; })).toEqual([['UNREFERENCED', '$.equations[1]']]);
  });

  it('UNREFERENCED and NEVER_VISIBLE: controls no stage lists, or lists only while their group is hidden', () => {
    expect(warningsAfter(template => { for (const item of template.stages) delete item.controls.p; })).toEqual([['UNREFERENCED', '$.controls[2]']]);
    expect(warningsAfter(template => { delete stage(template, 'predict').controls.p; delete stage(template, 'explore').visible['probe-control']; }))
      .toEqual([['NEVER_VISIBLE', '$.controls[2]']]);
  });

  it('UNREFERENCED: quantity and dataset members nothing shows', () => {
    expect(warningsAfter(template => { template.views[1]!.quantities = template.views[1]!.quantities!.filter(id => id !== 'probe.x'); }))
      .toEqual([['UNREFERENCED', `$.groups[${groupIndex(base(), 'probe-values')}].members[0]`]]);
    expect(warningsAfter(template => {
      template.views[0]!.marks = template.views[0]!.marks.filter(mark => mark.id !== 'probe-marker');
      for (const alternative of template.alternatives) alternative.covers = alternative.covers.filter(id => id !== 'probe-marker');
    })).toEqual([['UNREFERENCED', `$.groups[${groupIndex(base(), 'line')}].members[1]`]]);
  });

  it('orphaned references stay errors of validateTemplateSemantics', () => {
    const template = base();
    stage(template, 'predict').visible['no-such-group'] = 'fixed';
    expect(validateTemplateSemantics(template, manifest).map(item => item.code)).toContain('INVALID_REFERENCE');
  });

  it('the new codes are stable vocabulary with learner-safe descriptions', () => {
    for (const code of ['NEVER_VISIBLE', 'UNREFERENCED'] as const) {
      expect(DIAGNOSTIC_CODES).toContain(code);
      expect(LEARNER_MESSAGES[code].message).toMatch(/\S/);
    }
  });
});
