/**
 * Constraint enforcement at every activity entry point (report §8.2, A06): request parameters at validate/prepare,
 * exact entry, keyboard and pointer previews, preview commits, scenarios, isolated sampling and restore all apply the
 * model's individual and coupled rules through the same core check, with the same diagnostic codes. Pointer clamping
 * moves single values into their bounds visibly; coupled violations are never clamped.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { artifactIntegrity, LEARNER_MESSAGES, validateTemplateSemantics, type ActivityArtifact } from '@explorable-models/activity';
import {
  authorizeExploration, codesOf, enterExplore, guards, harness, manifest, okOf, op, open, policyFor, rectangleCatalog, rectangleModel, rectanglePolicy, rectangleRequest,
  rectangleTemplate, requestFor, settled, template, until, type Harness,
} from './support/adapter-harness.js';

let current: Harness | null = null;
const make = (...args: Parameters<typeof harness>) => (current = harness(...args));
afterEach(() => { current?.adapter.dispose(); current = null; });

const COUPLED = 'CONSTRAINT_VIOLATION';
async function curvatureStage(h: Harness) {
  const opened = await open(h);
  await enterExplore(h, opened);
  okOf(await opened.control.requestStageTransition({ operationId: op(), expectedActivityRevision: opened.learner.getProjection().activityRevision, expectedPolicyRevision: 1, toStage: 'explore-curvature' }));
  await settled(h);
  return opened;
}

describe('quadratic coupled constraint η·a ≤ 4', () => {
  it('validate and prepare refuse violating request parameters', async () => {
    const h = make();
    const invalid = requestFor({ parameters: { eta: 2, a: 2.5 } });
    expect((await h.adapter.validate(invalid)).diagnostics.map(item => [item.code, item.path])).toEqual([[COUPLED, '$.constraints.multiplier-lower-bound']]);
    expect(codesOf(await h.adapter.prepare(invalid, { operationId: op() }))).toEqual([COUPLED]);
    expect(h.host.calls('registerActivity')).toHaveLength(0);
  });

  it('exact entry, keyboard preview and pointer preview reject the same coupled violation', async () => {
    const h = make();
    const opened = await curvatureStage(h);
    okOf(await opened.learner.commitParameters({ operationId: op(), ...guards(opened.learner), displayValues: { a: 2 } }));
    const run = guards(opened.learner).expectedRunId;
    const exact = await opened.learner.commitParameters({ operationId: op(), ...guards(opened.learner), displayValues: { eta: 2, a: 3 } });
    expect(codesOf(exact)).toEqual([COUPLED]);
    // η and a are both controls of this stage, so the model's own learner-safe text states the coupled limit (G27).
    expect(exact.ok ? null : exact.diagnostics[0]).toMatchObject({ path: '$', message: manifest.constraints[0]!.message, recovery: manifest.constraints[0]!.recovery });
    await authorizeExploration(h, opened, { eta: [0, 2], a: [0.1, 10] });
    for (const gesture of ['keyboard', 'pointer'] as const) {
      const previewId = okOf(opened.learner.beginPreview({ operationId: op(), ...guards(opened.learner), gesture, parameter: 'eta' })).preview!.previewId;
      // Beyond η's own bound: keyboard entry is refused, a pointer value is clamped to η = 2 (η·a = 4 is allowed).
      const beyond = opened.learner.updatePreview({ operationId: op(), previewId, displayValues: { eta: 2.5 } });
      if (gesture === 'keyboard') expect(codesOf(beyond)).toEqual(['OUT_OF_DOMAIN']);
      else expect(okOf(beyond).status.message).toMatch(/adjusted/);
      // Inside both bounds but violating the coupled rule: refused for every gesture, never clamped.
      expect(codesOf(opened.learner.updatePreview({ operationId: op(), previewId, displayValues: { eta: 1.5, a: 3 } }))).toEqual([COUPLED]);
      okOf(opened.learner.cancelPreview({ operationId: op(), previewId, reason: 'escape' }));
    }
    // A pointer gesture beyond a single bound is clamped (visibly) to a value that satisfies every rule.
    const previewId = okOf(opened.learner.beginPreview({ operationId: op(), ...guards(opened.learner), gesture: 'pointer', parameter: 'a' })).preview!.previewId;
    const clamped = okOf(opened.learner.updatePreview({ operationId: op(), previewId, displayValues: { a: -4 } }));
    expect(clamped.status.message).toMatch(/adjusted/);
    await until(() => opened.learner.getProjection().frame?.kind === 'tentative');
    okOf(await opened.learner.commitPreview({ operationId: op(), ...guards(opened.learner), previewId }));
    expect(opened.learner.getProjection().controls.find(control => control.parameter === 'a')!.value).toBe(0.1);
    expect(guards(opened.learner).expectedRunId).not.toBe(run);
  });

  it('exact entry at the coupled boundary: η = 0.4 at a = 10 (η·a = 4) commits, the next double above is refused; a = 0.1 commits, the next double below is refused (report §12.3)', async () => {
    const h = make();
    const opened = await curvatureStage(h);
    const control = (parameter: string) => opened.learner.getProjection().controls.find(item => item.parameter === parameter)!.value;
    okOf(await opened.learner.commitParameters({ operationId: op(), ...guards(opened.learner), displayValues: { a: 10, eta: 0.25 } }));
    const run = guards(opened.learner).expectedRunId;
    const committed = h.host.calls('appendEvents').length;
    // η = 0.4000000000000001 is the next double above 0.4: fl(η·10) = 4.000000000000001 > 4.
    const refused = await opened.learner.commitParameters({ operationId: op(), ...guards(opened.learner), displayValues: { eta: 0.4000000000000001 } });
    expect(codesOf(refused)).toEqual([COUPLED]);
    expect([guards(opened.learner).expectedRunId, control('eta'), control('a')]).toEqual([run, 0.25, 10]);
    // η = 0.4: the exact product of the double 0.4 and 10 exceeds 4, but the declared p = fl(η·a) is exactly 4.
    okOf(await opened.learner.commitParameters({ operationId: op(), ...guards(opened.learner), displayValues: { eta: 0.4 } }));
    await settled(h);
    expect(guards(opened.learner).expectedRunId).not.toBe(run);
    expect([control('eta'), control('a')]).toEqual([0.4, 10]);
    expect(opened.learner.getProjection().frame).toMatchObject({ kind: 'committed', position: { kind: 'index', index: 0 } });
    expect(h.host.calls('appendEvents').length).toBeGreaterThan(committed);
    // The curvature bound: a = 0.09999999999999999 (the double below 0.1) is out of domain; a = 0.1 commits.
    const below = await opened.learner.commitParameters({ operationId: op(), ...guards(opened.learner), displayValues: { a: 0.09999999999999999 } });
    expect(codesOf(below)).toEqual(['OUT_OF_DOMAIN']);
    expect(control('a')).toBe(10);
    okOf(await opened.learner.commitParameters({ operationId: op(), ...guards(opened.learner), displayValues: { a: 0.1 } }));
    expect([control('eta'), control('a')]).toEqual([0.4, 0.1]);
  });

  it('isolated sampling applies the same rule and never touches the learner run', async () => {
    const h = make();
    const opened = await open(h);
    const before = guards(opened.learner);
    const refused = await h.adapter.sample({ activityId: 'act-quadratic-1', parameters: { a: 3, eta: 2, x0: 1 }, positions: [{ kind: 'index', index: 1 }], audience: 'host' });
    expect(codesOf(refused as never)).toEqual([COUPLED]);
    const sampled = await h.adapter.sample({ activityId: 'act-quadratic-1', parameters: { a: 2, eta: 2, x0: 1 }, positions: [{ kind: 'index', index: 0 }, { kind: 'index', index: 3 }], audience: 'host' });
    if (!sampled.ok) throw new Error(JSON.stringify(sampled.diagnostics));
    expect(sampled.frames).toHaveLength(2);
    expect(sampled.provenance.model.digest).toBe(opened.prepared.instance.model.digest);
    expect(guards(opened.learner)).toEqual(before);
    expect(codesOf(await h.adapter.sample({ activityId: 'act-quadratic-1', parameters: { a: 2, eta: 1, x0: 1 }, positions: [{ kind: 'index', index: 0 }], audience: 'learner' as never }) as never)).toEqual(['POLICY_DENIED']);
  });

  it('restore refuses saved parameters that violate the rule, even with a recomputed integrity manifest', async () => {
    const h = make();
    const opened = await open(h);
    await settled(h);
    const saved = await opened.control.save({ operationId: op(), kind: 'backup' });
    if (!saved.ok) throw new Error('save failed');
    h.adapter.dispose('act-quadratic-1');
    const { integrity: _integrity, ...body } = structuredClone(saved.artifact);
    const forged = { ...body, scientific: { ...body.scientific, params: { a: 3, eta: 2, x0: 4 } } } as Omit<ActivityArtifact, 'integrity'>;
    const artifact: ActivityArtifact = { ...forged, integrity: artifactIntegrity(forged) };
    const restored = await h.adapter.restore(artifact, { operationId: op(), hostSessionRevision: 0 });
    expect(codesOf(restored as never)).toEqual([COUPLED]);
    expect(restored.ok ? null : restored.diagnostics[0]!.path).toBe('$.scientific.constraints.multiplier-lower-bound');
  });

  it('scenarios are checked against the same rules when the template is validated', () => {
    const broken = structuredClone(template);
    broken.scenarios[0]!.parameters = { a: 4, eta: 1.5, x0: 4 };
    expect(validateTemplateSemantics(broken, manifest).map(item => item.code)).toContain(COUPLED);
  });
});

describe('learner-safe coupled-constraint text (report §8.2, G27)', () => {
  const LIMIT = manifest.constraints[0]!;

  it('states the η·a ≤ 4 limit and its recovery to learner and tutor bindings when η and a are both shown controls', async () => {
    const h = make();
    const opened = await curvatureStage(h);
    const run = guards(opened.learner).expectedRunId;
    expect(LIMIT.message).toMatch(/η·a\) can be at most 4/);
    for (const binding of [opened.learner, opened.tutor]) {
      const refused = await binding.commitParameters({ operationId: op(), ...guards(binding), displayValues: { eta: 2, a: 3 } });
      expect(refused.ok ? null : refused.diagnostics).toEqual([{ code: COUPLED, path: '$', message: LIMIT.message, recovery: LIMIT.recovery }]);
    }
    // Nothing was committed: the run and the controls are unchanged.
    expect(guards(opened.learner).expectedRunId).toBe(run);
    expect(opened.learner.getProjection().controls.find(control => control.parameter === 'a')!.value).toBe(2);
  });

  it('keeps the fixed vocabulary when a referenced parameter is not a shown control', async () => {
    // The host policy withholds the curvature control; a = 3 was set by the host, so η alone can violate η·a ≤ 4.
    const h = make({ policy: policyFor({ permittedControls: ['eta', 'x0'] }) });
    const opened = await open(h, requestFor({ parameters: { a: 3, eta: 1 } }));
    await enterExplore(h, opened);
    expect(opened.learner.getProjection().controls.map(control => control.parameter)).not.toContain('a');
    for (const binding of [opened.learner, opened.tutor]) {
      const refused = await binding.commitParameters({ operationId: op(), ...guards(binding), displayValues: { eta: 1.5 } });
      expect(refused.ok ? null : refused.diagnostics).toEqual([{ code: COUPLED, path: '$', ...LEARNER_MESSAGES.CONSTRAINT_VIOLATION }]);
      expect(JSON.stringify(refused)).not.toContain(LIMIT.message.slice(0, 30));
    }
  });
});

describe('rectangle coupled constraints w·h ≤ 50 and w/h ≥ 0.1 with display units', () => {
  it('applies the coupled rules after converting display units to canonical units', async () => {
    const h = make({ customCatalog: rectangleCatalog(), policy: rectanglePolicy() });
    const opened = await open(h, rectangleRequest());
    // 800 cm × 7 m = 56 m² > 50 m²: refused although each value is inside its own range.
    expect(codesOf(await opened.learner.commitParameters({ operationId: op(), ...guards(opened.learner), displayValues: { w: 800, h: 7 } }))).toEqual([COUPLED]);
    // 50 cm wide and 6 m high: w/h ≈ 0.083 < 0.1.
    expect(codesOf(await opened.learner.commitParameters({ operationId: op(), ...guards(opened.learner), displayValues: { w: 50, h: 6 } }))).toEqual([COUPLED]);
    okOf(await opened.learner.commitParameters({ operationId: op(), ...guards(opened.learner), displayValues: { w: 700, h: 7 } }));
    okOf(await opened.learner.applyScenario({ operationId: op(), ...guards(opened.learner), scenarioId: 'square' }));
    expect(opened.learner.getProjection().scenarios[0]!.active).toBe(true);
    const broken = structuredClone(rectangleTemplate);
    broken.scenarios[0]!.parameters = { w: 9, h: 9 };
    expect(validateTemplateSemantics(broken, rectangleModel).map(item => item.code)).toContain(COUPLED);
  });
});
