import { describe, expect, it } from 'vitest';
import { canonicalJSON, sha256 } from '../../packages/core/src/identity.js';
import type { ModelManifest } from '../../packages/core/src/model/index.js';
import type { ActivityArtifact, ActivityInstance, ActivityTemplate, Diagnostic, DiagnosticCode, HostPolicy } from '../../packages/activity/src/contracts.js';
import { artifactIntegrity, groupContent, groupContentDigest, groupDigests, templateDigest, templateRef } from '../../packages/activity/src/identity.js';
import { timestampMs, validateArtifactSemantics, validateInstanceSemantics, validatePolicySemantics, validateTemplateSemantics } from '../../packages/activity/src/semantic.js';
import {
  approvedPolicy, backupArtifact, independentInstance, independentPolicy, orientationManifest, orientationTemplate, predictInstance, quadraticManifest,
  quadraticTemplate, snapshotArtifact,
} from '../../packages/activity/fixtures-src/exemplars.js';

const template = (edit: (draft: ActivityTemplate) => void = () => {}): ActivityTemplate => { const draft = structuredClone(quadraticTemplate); edit(draft); return draft; };
const manifest = (edit: (draft: ModelManifest) => void = () => {}): ModelManifest => { const draft = structuredClone(quadraticManifest); edit(draft); return draft; };
const codes = (diagnostics: Diagnostic[]): DiagnosticCode[] => diagnostics.map(item => item.code);
const at = (diagnostics: Diagnostic[], code: DiagnosticCode): string[] => diagnostics.filter(item => item.code === code).map(item => item.path);
const view = (draft: ActivityTemplate, id: string) => draft.views.find(item => item.id === id)!;
const mark = (draft: ActivityTemplate, id: string) => draft.views.flatMap(item => item.marks).find(item => item.id === id)!;
const stage = (draft: ActivityTemplate, id: string) => draft.stages.find(item => item.id === id)!;
const group = (draft: ActivityTemplate, id: string) => draft.groups.find(item => item.id === id)!;

describe('template semantics', () => {
  it('accepts both exemplar templates against their manifests', () => {
    expect(validateTemplateSemantics(quadraticTemplate, quadraticManifest)).toEqual([]);
    expect(validateTemplateSemantics(orientationTemplate, orientationManifest)).toEqual([]);
  });

  it('requires the template model reference to name the manifest identity', () => {
    expect(at(validateTemplateSemantics(template(), manifest(draft => { draft.version = '2.0.0'; })), 'INVALID_REFERENCE')).toEqual(['$.model']);
  });

  it('requires the template model digest to be the exact digest of the manifest', () => {
    // Same ID and version, different content (only presentation text): the reference no longer names this manifest.
    expect(at(validateTemplateSemantics(template(), manifest(draft => { draft.title = 'Retitled'; })), 'INVALID_REFERENCE')).toEqual(['$.model.digest']);
    expect(at(validateTemplateSemantics(template(draft => { draft.model.digest = `sha256:${'0'.repeat(64)}`; }), quadraticManifest), 'INVALID_REFERENCE')).toEqual(['$.model.digest']);
  });

  it('checks authored scenarios with the runtime admissibility and coupled-constraint rules', () => {
    // η·a = 2·2.5 = 5 exceeds the manifest's coupled bound of 4, although each value is inside its own range.
    const coupled = validateTemplateSemantics(template(draft => { draft.scenarios[0]!.parameters = { eta: 2, a: 2.5, x0: 1 }; }), quadraticManifest);
    expect(at(coupled, 'CONSTRAINT_VIOLATION')).toEqual(['$.scenarios[0].parameters']);
    expect(coupled.find(item => item.code === 'CONSTRAINT_VIOLATION')!.message).toContain('"step-product"');
    // A partial scenario that omits a constrained parameter cannot be judged against the coupled rule here.
    expect(at(validateTemplateSemantics(template(draft => { draft.scenarios[0]!.parameters = { eta: 2 }; }), quadraticManifest), 'CONSTRAINT_VIOLATION')).toEqual([]);
    // multipleOf uses core's relative tolerance: binary rounding of decimal steps is admissible, a visible step off is not.
    const tenth = manifest(draft => { draft.parameters.a!.step.admissible = { multipleOf: 0.1 }; });
    expect(at(validateTemplateSemantics(template(draft => { draft.scenarios[0]!.parameters.a = 0.1 + 0.2; }), tenth), 'CONSTRAINT_VIOLATION')).toEqual([]);
    expect(at(validateTemplateSemantics(template(draft => { draft.scenarios[0]!.parameters.a = 0.35; }), tenth), 'CONSTRAINT_VIOLATION')).toEqual(['$.scenarios[0].parameters.a']);
  });

  it('checks unique IDs, group membership and group kinds', () => {
    expect(at(validateTemplateSemantics(template(draft => { view(draft, 'values').id = 'plot'; }), quadraticManifest), 'DUPLICATE_ID')).toContain('$.views[1].id');
    const diagnostics = validateTemplateSemantics(template(draft => { group(draft, 'g-landscape').members.push('plot', 'ghost'); }), quadraticManifest);
    expect(at(diagnostics, 'KIND_MISMATCH')).toEqual(['$.groups[1].members[2]']);
    expect(at(diagnostics, 'INVALID_REFERENCE')).toEqual(['$.groups[1].members[3]']);
    expect(at(validateTemplateSemantics(template(draft => { mark(draft, 'm-curve').group = 'g-missing'; }), quadraticManifest), 'INVALID_REFERENCE')).toEqual(['$.views[0].marks[0].group']);
  });

  it('checks mark bindings against manifest geometry and quantity shapes', () => {
    const diagnostics = validateTemplateSemantics(template(draft => {
      mark(draft, 'm-curve').bindings = { geometry: 'iterates' };
      mark(draft, 'm-point').bindings = { at: 'x' };
      view(draft, 'plot').marks.push({ id: 'm-arrow', kind: 'arrow', group: 'g-trajectory', label: 'Step', bindings: {}, style: { role: 'accent', dash: 'solid', marker: 'none', weight: 'thin' } });
    }), quadraticManifest);
    expect(at(diagnostics, 'KIND_MISMATCH')).toEqual(['$.views[0].marks[0].bindings.geometry', '$.views[0].marks[4].bindings.at']);
    expect(at(diagnostics, 'INVALID_INPUT')).toEqual(['$.views[0].marks[6].bindings']);
    const flat = validateTemplateSemantics(template(draft => { mark(draft, 'm-curve').bindings = { geometry: 'nowhere' }; }), quadraticManifest);
    expect(at(flat, 'INVALID_REFERENCE')).toEqual(['$.views[0].marks[0].bindings.geometry']);
  });

  it('requires an exact-entry control for every draggable parameter', () => {
    expect(at(validateTemplateSemantics(template(draft => { draft.controls[1]!.exact = false; }), quadraticManifest), 'MISSING_EQUIVALENT')).toEqual(['$.views[0].marks[1].drag.x']);
    const missing = validateTemplateSemantics(template(draft => { draft.controls.splice(1, 1); delete stage(draft, 'predict').controls.x0; delete stage(draft, 'explore').controls.x0; group(draft, 'g-controls').members = ['eta', 'a']; }), quadraticManifest);
    expect(at(missing, 'INVALID_REFERENCE')).toEqual(['$.views[0].marks[1].drag.x']);
  });

  it('requires dragged parameters to use the axis canonical unit, including its scale', () => {
    for (const axis of ['x', 'y'] as const) {
      const changed = manifest(draft => { draft.parameters.x0!.dimension = 'length'; draft.parameters.x0!.unit = 'cm'; });
      const draft = template(t => { view(t, 'plot').marks[1]!.drag = { [axis]: 'x0' }; });
      expect(at(validateTemplateSemantics(draft, changed), 'UNIT_MISMATCH')).toContain(`$.views[0].marks[1].drag.${axis}`);
      // Sharing a dimension is insufficient: the drag writes the axis value without conversion.
      changed.parameters.x0!.unit = 'm';
      view(draft, 'plot').axes![axis]!.unit = 'cm';
      expect(at(validateTemplateSemantics(draft, changed), 'UNIT_MISMATCH')).toContain(`$.views[0].marks[1].drag.${axis}`);
      changed.parameters.x0!.unit = 'cm';
      expect(at(validateTemplateSemantics(draft, changed), 'UNIT_MISMATCH')).not.toContain(`$.views[0].marks[1].drag.${axis}`);
    }
  });

  it('requires a declared axis unit for a draggable coordinate', () => {
    const draft = template(t => { delete view(t, 'plot').axes; });
    expect(at(validateTemplateSemantics(draft, quadraticManifest), 'UNIT_MISMATCH')).toContain('$.views[0].marks[1].drag.x');
  });

  it('checks display units against the canonical unit dimension', () => {
    expect(at(validateTemplateSemantics(template(draft => { draft.controls[0]!.displayUnits = ['dimensionless', 'm']; }), quadraticManifest), 'UNIT_MISMATCH')).toEqual(['$.controls[0].displayUnits[1]']);
    const orientation = structuredClone(orientationTemplate);
    orientation.controls[0]!.displayUnits = ['deg', 'rad', 's'];
    expect(at(validateTemplateSemantics(orientation, orientationManifest), 'UNIT_MISMATCH')).toEqual(['$.controls[0].displayUnits[2]']);
    expect(at(validateTemplateSemantics(template(draft => { view(draft, 'plot').axes!.x.unit = 'rad'; }), quadraticManifest), 'UNIT_MISMATCH')).toEqual(['$.views[0].axes.x.unit', '$.views[0].marks[1].drag.x']);
  });

  it('checks stage, transition, control and scenario references', () => {
    const diagnostics = validateTemplateSemantics(template(draft => {
      stage(draft, 'predict').visible['g-ghost'] = 'fixed';
      stage(draft, 'predict').controls.speed = 'interactive';
      draft.transitions[0]!.to = 'review';
      draft.initialStage = 'start';
      draft.controls[0]!.parameter = 'learningRate';
      draft.scenarios[0]!.parameters = { eta: 2.5, ghost: 1 };
    }), quadraticManifest);
    expect(at(diagnostics, 'INVALID_REFERENCE')).toEqual(expect.arrayContaining([
      '$.stages[0].visible.g-ghost', '$.stages[0].controls.speed', '$.transitions[0].to', '$.initialStage', '$.controls[0].parameter', '$.scenarios[0].parameters.ghost',
    ]));
    expect(at(diagnostics, 'OUT_OF_DOMAIN')).toEqual(['$.scenarios[0].parameters.eta']);
    const integer = validateTemplateSemantics(template(draft => { draft.scenarios[0]!.parameters.x0 = 7.5; }), manifest(draft => { draft.parameters.x0!.step.admissible = 'integer'; }));
    expect(at(integer, 'CONSTRAINT_VIOLATION')).toEqual(['$.scenarios[0].parameters.x0']);
  });

  it('checks view kinds, bounds and dimensionality', () => {
    const diagnostics = validateTemplateSemantics(template(draft => {
      view(draft, 'plot').bounds = [10, -10, -5, 55];
      view(draft, 'values').marks.push(structuredClone(mark(draft, 'm-curve')));
      view(draft, 'values').marks[0]!.id = 'm-curve-copy';
      draft.views.push({ id: 'space', kind: 'scene3d', group: 'g-plot', title: 'Space', description: 'A 3D view in a 2D template.', equalAspect: true, marks: [] });
    }), quadraticManifest);
    expect(at(diagnostics, 'INVALID_INPUT')).toEqual(['$.views[0].bounds[0]', '$.views[4].bounds3']);
    expect(at(diagnostics, 'KIND_MISMATCH')).toEqual(['$.views[1].marks', '$.views[4].kind']);
  });

  it('checks equation placeholders, TeX commands and disclosure', () => {
    const base = template(draft => {
      draft.equations[0]!.tex = 'x = {{q:x}} + {{q:ghost}} + {{q:}} \\href{https://example.org}{link}';
      draft.equations[0]!.plain = 'x = {{q:x}}';
    });
    const diagnostics = validateTemplateSemantics(base, quadraticManifest);
    expect(at(diagnostics, 'INVALID_REFERENCE')).toEqual(['$.equations[0].tex']);
    expect(at(diagnostics, 'INVALID_INPUT')).toEqual(['$.equations[0].tex', '$.equations[0].tex', '$.equations[0].plain']);
    for (const diagnostic of diagnostics) expect(diagnostic.message).not.toContain('example.org');

    const early = validateTemplateSemantics(template(draft => { stage(draft, 'predict').visible['g-rule'] = 'fixed'; }), quadraticManifest);
    expect(at(early, 'EQUATION_DISCLOSURE')).toEqual(['$.stages[0].visible', '$.stages[0].visible']);
    const unguarded = validateTemplateSemantics(template(draft => { group(draft, 'g-rule').solutionBearing = false; }), quadraticManifest);
    expect(at(unguarded, 'EQUATION_DISCLOSURE')).toEqual(['$.equations[0].group']);
    const orphan = validateTemplateSemantics(template(draft => { group(draft, 'g-multiplier').members = ['start']; }), quadraticManifest);
    expect(at(orphan, 'EQUATION_DISCLOSURE')).toEqual(['$.equations[0].tex']);
  });

  it('requires an equivalent alternative for every spatial view, visible wherever the view is', () => {
    const none = validateTemplateSemantics(template(draft => { draft.alternatives = draft.alternatives.filter(item => item.id === 'alt-keyboard'); group(draft, 'g-alternatives').members = ['alt-keyboard']; }), quadraticManifest);
    expect(at(none, 'MISSING_EQUIVALENT')).toEqual(['$.views[0]']);
    const partial = validateTemplateSemantics(template(draft => { for (const item of draft.alternatives) item.equivalence = 'partial'; }), quadraticManifest);
    expect(at(partial, 'MISSING_EQUIVALENT')).toEqual(['$.views[0]']);
    const hidden = validateTemplateSemantics(template(draft => { delete stage(draft, 'predict').visible['g-alternatives']; }), quadraticManifest);
    expect(at(hidden, 'MISSING_EQUIVALENT')).toEqual(['$.stages[0].visible']);
    expect(at(validateTemplateSemantics(template(draft => { draft.alternatives[0]!.covers.push('ghost'); }), quadraticManifest), 'INVALID_REFERENCE')).toEqual(['$.alternatives[0].covers[1]']);
  });
});

describe('content identity', () => {
  const digestOf = (draft: ActivityTemplate, id: string, model: ModelManifest = quadraticManifest) => groupContentDigest(draft, model, id);
  it('is the canonical sha256 and independent of key order', () => {
    expect(templateDigest(quadraticTemplate)).toBe('sha256:' + sha256(canonicalJSON(quadraticTemplate)));
    expect(templateRef(quadraticTemplate)).toEqual({ templateId: quadraticTemplate.templateId, version: quadraticTemplate.version, digest: templateDigest(quadraticTemplate) });
    const reordered = Object.fromEntries(Object.entries(structuredClone(quadraticTemplate)).reverse()) as unknown as ActivityTemplate;
    expect(templateDigest(reordered)).toBe(templateDigest(quadraticTemplate));
    expect(digestOf(reordered, 'g-trajectory')).toBe(digestOf(quadraticTemplate, 'g-trajectory'));
    expect(groupDigests(quadraticTemplate, quadraticManifest).map(item => item.groupId)).toEqual(quadraticTemplate.groups.map(item => item.id));
  });

  it('binds every learner-visible text of the group and nothing outside it', () => {
    const base = digestOf(quadraticTemplate, 'g-trajectory');
    expect(digestOf(template(draft => { mark(draft, 'm-point').label = 'Now'; }), 'g-trajectory')).not.toBe(base);
    expect(digestOf(template(draft => { mark(draft, 'm-label').text = 'x_k'; }), 'g-trajectory')).not.toBe(base);
    expect(digestOf(template(draft => { group(draft, 'g-trajectory').description = 'Path.'; }), 'g-trajectory')).not.toBe(base);
    expect(digestOf(template(draft => { mark(draft, 'm-curve').label = 'Curve'; }), 'g-trajectory')).toBe(base);
    expect(digestOf(template(draft => { view(draft, 'plot').description = 'Changed accessible text.'; }), 'g-plot')).not.toBe(digestOf(quadraticTemplate, 'g-plot'));
    expect(digestOf(template(draft => { view(draft, 'plot').description = 'Changed accessible text.'; }), 'g-trajectory')).toBe(base);
    const position = digestOf(quadraticTemplate, 'g-position');
    expect(digestOf(quadraticTemplate, 'g-position', manifest(draft => { draft.quantities.x!.meaning = 'Another meaning.'; }))).not.toBe(position);
    expect(digestOf(quadraticTemplate, 'g-position', manifest(draft => { draft.quantities.multiplier!.meaning = 'Another meaning.'; }))).toBe(position);
    const controls = digestOf(quadraticTemplate, 'g-controls');
    expect(digestOf(quadraticTemplate, 'g-controls', manifest(draft => { draft.parameters.eta!.description = 'Different.'; }))).not.toBe(controls);
    expect(digestOf(template(draft => { draft.scenarios[0]!.label = 'Tiny steps'; }), 'g-controls')).not.toBe(controls);
    expect(digestOf(template(draft => { draft.content[0]!.text = 'Other derivation.'; }), 'g-notes')).not.toBe(digestOf(quadraticTemplate, 'g-notes'));
    expect(digestOf(template(draft => { draft.alternatives[0]!.description = 'Other.'; }), 'g-alternatives')).not.toBe(digestOf(quadraticTemplate, 'g-alternatives'));
    expect(digestOf(template(draft => { draft.equations[0]!.plain = 'x next = r·x'; }), 'g-rule')).not.toBe(digestOf(quadraticTemplate, 'g-rule'));
  });

  it('records unresolved members and rejects unknown groups', () => {
    const ghost = template(draft => { group(draft, 'g-position').members.push('ghost'); });
    expect(groupContent(ghost, quadraticManifest, 'g-position').missing).toEqual(['ghost']);
    expect(digestOf(ghost, 'g-position')).not.toBe(digestOf(quadraticTemplate, 'g-position'));
    expect(() => digestOf(quadraticTemplate, 'g-nowhere')).toThrow(RangeError);
  });
});

describe('policy semantics', () => {
  const policy = (edit: (draft: HostPolicy) => void): HostPolicy => { const draft = structuredClone(approvedPolicy); edit(draft); return draft; };
  it('accepts the exemplars and compares offset timestamps exactly', () => {
    expect(validatePolicySemantics(approvedPolicy)).toEqual([]);
    expect(validatePolicySemantics(independentPolicy)).toEqual([]);
    expect(timestampMs('2026-10-26T10:00:00+02:00')).toBe(timestampMs('2026-10-26T08:00:00Z'));
    expect(timestampMs('2026-10-26T08:00:00.123456789Z') - timestampMs('2026-10-26T08:00:00Z')).toBe(123);
    expect(validatePolicySemantics(policy(draft => { draft.issuedAt = '2026-10-26T10:00:00+02:00'; draft.expiresAt = '2026-10-26T09:00:00Z'; }))).toEqual([]);
    expect(at(validatePolicySemantics(policy(draft => { draft.issuedAt = '2026-10-26T10:00:00-02:00'; draft.expiresAt = '2026-10-26T09:00:00Z'; })), 'CONSTRAINT_VIOLATION')).toEqual(['$.expiresAt']);
  });
  it('rejects inconsistent modes, duplicates and authority widening', () => {
    const diagnostics = validatePolicySemantics(policy(draft => {
      draft.mode = 'exploratory';
      draft.allowedTools.push('discover');
      draft.independentTask = { active: true, taskRef: null, permittedTools: ['sample'], neutralScaffold: ['g-ghost'] };
      draft.sampling = { allowed: true, maxPositions: 10 };
    }));
    expect(codes(diagnostics).sort()).toEqual(['CONSTRAINT_VIOLATION', 'CONSTRAINT_VIOLATION', 'CONSTRAINT_VIOLATION', 'CONSTRAINT_VIOLATION', 'CONSTRAINT_VIOLATION', 'DUPLICATE_ID']);
    expect(at(validatePolicySemantics(policy(draft => { draft.approved = []; })), 'CONSTRAINT_VIOLATION')).toEqual(['$.approved']);
  });
});

describe('instance semantics', () => {
  const instance = (edit: (draft: ActivityInstance) => void): ActivityInstance => { const draft = structuredClone(independentInstance); edit(draft); return draft; };
  it('accepts the exemplars', () => {
    expect(validateInstanceSemantics(predictInstance, quadraticTemplate)).toEqual([]);
    expect(validateInstanceSemantics(independentInstance, quadraticTemplate)).toEqual([]);
  });
  it('detects stale templates, foreign references and broken response chains', () => {
    expect(at(validateInstanceSemantics(predictInstance, template(draft => { draft.purpose = 'Edited purpose.'; })), 'STALE_ACTIVITY_REVISION')).toEqual(['$.template.digest']);
    expect(at(validateInstanceSemantics(predictInstance, template(draft => { draft.version = '1.0.1'; })), 'INVALID_REFERENCE')).toEqual(['$.template']);
    const diagnostics = validateInstanceSemantics(instance(draft => {
      draft.model = { ...draft.model, version: '9.9.9' };
      draft.stage.id = 'review';
      draft.responses[1]!.responseId = 'resp-1';
      draft.responses[2]!.supersededBy = 'resp-9';
      draft.responses[2]!.status = 'superseded';
      draft.responses.push({ ...draft.responses[0]!, responseId: 'resp-4', supersededBy: undefined });
    }), quadraticTemplate);
    // Renaming resp-2 also orphans resp-1's supersededBy link.
    expect(at(diagnostics, 'INVALID_REFERENCE')).toEqual(['$.model', '$.stage.id', '$.responses[0].supersededBy', '$.responses[2].supersededBy']);
    expect(at(diagnostics, 'DUPLICATE_ID')).toEqual(['$.responses[1].responseId']);
    expect(at(diagnostics, 'CONSTRAINT_VIOLATION')).toEqual(['$.responses[3].supersededBy']);
  });
});

describe('artifact semantics', () => {
  const artifact = (edit: (draft: ActivityArtifact) => void, base: ActivityArtifact = backupArtifact): ActivityArtifact => { const draft = structuredClone(base); edit(draft); return draft; };
  it('accepts the exemplars and recomputes the integrity manifest', () => {
    expect(validateArtifactSemantics(backupArtifact)).toEqual([]);
    expect(validateArtifactSemantics(snapshotArtifact)).toEqual([]);
    const { integrity, ...body } = backupArtifact;
    expect(artifactIntegrity(body)).toEqual(integrity);
    expect(integrity.digest).toBe('sha256:' + sha256(canonicalJSON(integrity.entries)));
  });
  it('detects tampering, uncovered fields and forged manifests', () => {
    expect(at(validateArtifactSemantics(artifact(draft => { draft.scientific.params.eta = 0.1; })), 'INTEGRITY_FAILURE')).toEqual([`$.integrity.entries[${backupArtifact.integrity.entries.findIndex(entry => entry.path === 'scientific')}].digest`]);
    expect(at(validateArtifactSemantics(artifact(draft => { draft.integrity.entries = draft.integrity.entries.filter(entry => entry.path !== 'exposures'); })), 'INTEGRITY_FAILURE')).toEqual(['$.integrity.entries', '$.integrity.digest']);
    expect(at(validateArtifactSemantics(artifact(draft => { draft.integrity.digest = 'sha256:' + '0'.repeat(64); })), 'INTEGRITY_FAILURE')).toEqual(['$.integrity.digest']);
    const forged = artifact(draft => { draft.integrity.entries.push({ path: 'migratedFrom', digest: draft.integrity.digest }); });
    expect(at(validateArtifactSemantics(forged), 'INTEGRITY_FAILURE')).toContain(`$.integrity.entries[${forged.integrity.entries.length - 1}].path`);
  });
  it('checks cross-references even when the integrity manifest is recomputed', () => {
    const rebuilt = (edit: (draft: ActivityArtifact) => void, base: ActivityArtifact = backupArtifact) => {
      const draft = artifact(edit, base);
      const { integrity: _ignored, ...body } = draft;
      return { ...body, integrity: artifactIntegrity(body) } as ActivityArtifact;
    };
    expect(at(validateArtifactSemantics(rebuilt(draft => { draft.instance.template = { ...draft.instance.template, version: '1.0.1' }; })), 'INVALID_REFERENCE')).toEqual(['$.template']);
    expect(at(validateArtifactSemantics(rebuilt(draft => { draft.exposures[0]!.activityId = 'act-other'; })), 'INVALID_REFERENCE')).toEqual(['$.exposures[0].activityId']);
    expect(at(validateArtifactSemantics(rebuilt(draft => { draft.schemas = draft.schemas.filter(entry => entry.contract !== 'study-harness.exposure-record'); })), 'INVALID_REFERENCE')).toEqual(['$.schemas']);
    expect(at(validateArtifactSemantics(rebuilt(draft => { if (draft.pending.kind === 'preview') draft.pending.baseRunId = 'run-0001'; }, snapshotArtifact)), 'INVALID_REFERENCE')).toEqual(['$.pending.baseRunId']);
    expect(at(validateArtifactSemantics(rebuilt(draft => { draft.policyRef = { ...draft.policyRef, revision: 9 }; })), 'INVALID_REFERENCE')).toEqual(['$.policyRef']);
  });
});
