import { describe, expect, it } from 'vitest';
import { canonicalJSON, sha256 } from '../../packages/core/src/identity';
import { documentIdentity } from '../../packages/core/src/declarative/identity';
import { createPreset } from '../../packages/core/src/presets';
import {
  documentModelRevision, enableDocumentExecution, isValidatedManifest, labelWording, manifestShapeErrors, ModelError, modelIdentity, MODEL_MANIFEST_SCHEMA, validateManifest, type ModelExecution, type ModelManifest,
} from '../../packages/core/src/model/index';
import { dropDocument, dropManifest, gapManifest, geometricManifest, rectangleManifest } from './support/model-fixtures';

// These tests identify document executions, an opt-in capability (tests/core/document-execution.test.ts covers the default).
enableDocumentExecution();

const identity = (manifest: ModelManifest) => validateManifest(manifest).identity;
const documentOf = (manifest: ModelManifest) => (manifest.execution as Extract<ModelExecution, { kind: 'document' }>).document;
function compare(change: (manifest: ModelManifest) => void, base: () => ModelManifest = geometricManifest) {
  const before = identity(base()), edited = base();
  change(edited);
  const after = identity(edited);
  return { scientific: before.scientificRevision !== after.scientificRevision, presentation: before.presentationRevision !== after.presentationRevision, digest: before.digest !== after.digest };
}
const codes = (run: () => unknown): string[] => { try { run(); } catch (error) { if (error instanceof ModelError) return error.diagnostics.map(item => item.code); throw error; } throw new Error('Expected a ModelError.'); };
const paths = (run: () => unknown): string[] => { try { run(); } catch (error) { if (error instanceof ModelError) return error.diagnostics.map(item => item.path); throw error; } throw new Error('Expected a ModelError.'); };

describe('model identity (report §8.3, A10)', () => {
  it('preserves captured document model hashes across the optional identity boundary refactor', async () => {
    // Contract regression vectors captured from the prior synchronous implementation, not scientific references.
    const vectors = [
      [dropDocument(), 'sha256:770cd7893e0635bae28dac24c72b00874a7889065e731d86b9786b61db93c79a'],
      [createPreset('wave'), 'sha256:dfe16ea10d9b3509e2672faa8f85380b3b7947b23b4e7f935646ddece3009f86'],
      [createPreset('projectile'), 'sha256:09ad1442d07d40e6177a8172f938755e755e26682ca7e6d4bf48a837f25b97d5'],
    ] as const;
    for (const [document, expected] of vectors) {
      expect(documentModelRevision(document)).toBe(expected);
      expect((await documentIdentity(document)).modelRevision).toBe(expected);
    }
  });

  it('digests the exact canonical manifest and splits scientific from presentation revisions', () => {
    const manifest = geometricManifest();
    const id = modelIdentity(manifest);
    expect(id.digest).toBe('sha256:' + sha256(canonicalJSON(manifest)));
    expect(id.scientificRevision).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(id.presentationRevision).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(validateManifest(manifest).identity).toEqual(id);
    // Key order is irrelevant to identity.
    const reordered = JSON.parse(JSON.stringify(manifest, Object.keys(manifest).reverse()));
    expect(modelIdentity({ ...reordered, ...manifest }).digest).toBe(id.digest);
  });

  // Report §8.3: "Harmless label spelling and display precision remain presentation changes. Encode this distinction in
  // tests rather than relying on a generic metadata exemption." Each case below is classified on its own: a respelling
  // that keeps the label's wording is presentation, every change of wording is scientific (R38).
  const labelled = (labels: { eta?: string; position?: string; trace?: string; title?: string }) => () => {
    const m = geometricManifest();
    if (labels.eta !== undefined) m.parameters.eta.label = labels.eta;
    if (labels.position !== undefined) m.quantities.position.label = labels.position;
    if (labels.trace !== undefined) m.geometry.trace.label = labels.trace;
    if (labels.title !== undefined) m.title = labels.title;
    return m;
  };
  it('treats harmless label spelling and UI step increments as presentation only', () => {
    const harmless: [string, (m: ModelManifest) => void, (() => ModelManifest)?][] = [
      ['compound hyphenation', m => { m.parameters.eta.label = 'Step-size'; }],
      ['non-breaking hyphen', m => { m.parameters.eta.label = 'Step\u2011size'; }],
      ['en dash in a compound', m => { m.geometry.trace.label = 'Iterate\u2013trace'; }, labelled({ trace: 'Iterate trace' })],
      ['spacing and no-break space', m => { m.parameters.eta.label = '  Step\u00a0 size '; }],
      ['title spacing', m => { m.title = 'Geometric  descent\u2009(test)'; }],
      ['quotation marks', m => { m.quantities.position.label = 'Newton\u2019s position'; }, labelled({ position: "Newton's position" })],
      ['double quotation marks', m => { m.geometry.trace.label = '\u201cTrace\u201d'; }, labelled({ trace: '"Trace"' })],
      ['Unicode composition', m => { m.quantities.position.label = 'E\u0301cart'; }, labelled({ position: '\u00c9cart' })],
      ['UI step increment', m => { m.parameters.eta.step.ui = 0.01; }],
    ];
    for (const [name, change, base] of harmless) expect(compare(change, base), name).toEqual({ scientific: false, presentation: true, digest: true });
  });

  it('binds the wording of the title and of every label to the scientific revision (R38)', () => {
    const swap = <T extends { label: string }>(a: T, b: T) => { [a.label, b.label] = [b.label, a.label]; };
    const meaningful: [string, (m: ModelManifest) => void, (() => ModelManifest)?][] = [
      ['parameter labels swapped (curvature ↔ step size)', m => swap(m.parameters.a, m.parameters.eta)],
      ['readout labels swapped (position ↔ multiplier)', m => swap(m.quantities.position, m.quantities.multiplier)],
      ["quantity relabelled with another quantity's name", m => { m.quantities.position.label = 'Ratio to start'; }],
      ['readout label reworded', m => { m.quantities.position.label = 'Current position'; }],
      ['geometry label reworded', m => { m.geometry.trace.label = 'Trace of iterates'; }],
      ['title reworded', m => { m.title = 'Geometric descent'; }],
      ['title with another meaning', m => { m.title = 'Exponential growth (test)'; }],
      ['one changed letter', m => { m.parameters.h.label = 'Weight'; }, rectangleManifest],
      ['capitalization', m => { m.parameters.eta.label = 'Step Size'; }],
      ['case of a single letter', m => { m.quantities.position.label = 'Coefficient A'; }, labelled({ position: 'Coefficient a' })],
      ['case of a unit prefix', m => { m.quantities.position.label = 'Length (Mm)'; }, labelled({ position: 'Length (mm)' })],
      ['hyphen between single letters', m => { m.geometry.trace.label = 'x y plane'; }, labelled({ trace: 'x-y plane' })],
      ['hyphen next to a two-letter word (ad \u2212 bc vs ad·bc)', m => { m.quantities.position.label = 'Determinant ad bc'; }, labelled({ position: 'Determinant ad-bc' })],
      ['hyphen dropped from a compound', m => { m.parameters.eta.label = 'Stepsize'; }],
      ['prime instead of an apostrophe', m => { m.quantities.position.label = 'f\u2032 position'; }, labelled({ position: "f' position" })],
    ];
    for (const [name, change, base] of meaningful) expect(compare(change, base), name).toEqual({ scientific: true, presentation: true, digest: true });
  });

  it('computes label wording by the documented rule only (labelWording)', () => {
    for (const [a, b] of [
      ['Step size', 'Step-size'], ['Step size', 'Step\u2010size'], ['Step size', 'Step\u2011size'], ['Cross section', 'Cross\u2013section'],
      ['mass spring damper', 'mass-spring-damper'], ['Step size', ' Step\u00a0\u2009size\n'], ["Newton's law", 'Newton\u2019s law'],
      ['"Trace"', '\u201cTrace\u201d'], ['\u00c9cart', 'E\u0301cart'],
    ]) expect(labelWording(a!), `${a} = ${b}`).toBe(labelWording(b!));
    for (const [a, b] of [
      ['Step size', 'Step Size'], ['Step size', 'Stepsize'], ['Height', 'Weight'], ['Coefficient a', 'Coefficient A'], ['Length (mm)', 'Length (Mm)'],
      ['x-y plane', 'x y plane'], ['Point x-coordinate', 'Point x coordinate'], ['ad-bc', 'ad bc'], ['Step\u2014size', 'Step size'],
      ["f'", 'f\u2032'], ['x\u2212y', 'x-y'], ['Position', 'Current position'], ['Height at the point', 'Length of the gradient'],
    ]) expect(labelWording(a!), `${a} ≠ ${b}`).not.toBe(labelWording(b!));
  });

  it('keeps invisible and dash-like insertions in scientific label identity, including at the ends', () => {
    for (const character of ['\ufeff', '\u1680', '\u200b', '\u2060', '\u00ad', '\u2012', '\u2014', '\u2212']) {
      for (const label of [`${character}Step size`, `Step${character} size`, `Step size${character}`]) {
        expect(labelWording(label)).not.toBe(labelWording('Step size'));
        expect(compare(m => { m.parameters.eta.label = label; })).toEqual({ scientific: true, presentation: true, digest: true });
      }
    }
  });

  it('binds what a parameter, quantity or drawing means and how it is read to the scientific revision (R38)', () => {
    for (const change of [
      // Swapping two parameters' labels, symbols and descriptions: curvature and step size trade meanings.
      (m: ModelManifest) => {
        const a = m.parameters.a as unknown as Record<string, unknown>, eta = m.parameters.eta as unknown as Record<string, unknown>;
        const put = (target: Record<string, unknown>, key: string, value: unknown) => { if (value === undefined) delete target[key]; else target[key] = value; };
        for (const key of ['label', 'symbol', 'description']) { const held = a[key]; put(a, key, eta[key]); put(eta, key, held); }
      },
      (m: ModelManifest) => { m.parameters.a.description = 'Step size of each update.'; },
      (m: ModelManifest) => { m.parameters.a.description = 'Curvature (second derivative).'; },
      (m: ModelManifest) => { m.parameters.eta.symbol = '\\alpha'; },
      (m: ModelManifest) => { m.quantities.position.symbol = 'x_{n-1}'; },
      // Redescribing the iteration trace as a continuous-time solution changes what its coordinates mean.
      (m: ModelManifest) => { m.geometry.trace.description = 'Points (t, x(t)) sampled in continuous time t (seconds); the curve between them is the exact solution.'; },
      (m: ModelManifest) => { m.geometry.trace.coordinates = { x: 'iteration', y: 'm' }; },
      (m: ModelManifest) => { m.constraints[0].message = 'Step too large.'; },
      (m: ModelManifest) => { m.constraints[0].recovery = 'Use a smaller step.'; },
      (m: ModelManifest) => { m.summary = 'Updated summary.'; },
    ]) {
      const result = compare(change);
      expect(result.scientific).toBe(true);
      expect(result.digest).toBe(true);
    }
  });

  it('binds units, sign/coordinate conventions, assumptions and constraint bounds to the scientific revision', () => {
    const scientific = [
      (m: ModelManifest) => { m.parameters.x0.unit = 'cm'; }, // metres → centimetres with unchanged numbers
      (m: ModelManifest) => { m.quantities.position.unit = 'cm'; },
      (m: ModelManifest) => { m.quantities.position.signConvention = 'Positive to the left of the minimum.'; },
      (m: ModelManifest) => { m.quantities.position.coordinateFrame = 'x axis through the start'; },
      (m: ModelManifest) => { m.quantities.position.meaning = 'Previous iterate x_{n-1}.'; },
      (m: ModelManifest) => { m.interpretation.coordinateConvention = 'x is measured from the start.'; },
      (m: ModelManifest) => { m.interpretation.handedness = 'left'; },
      (m: ModelManifest) => { m.interpretation.angleConvention = 'Counter-clockwise radians.'; },
      (m: ModelManifest) => { m.interpretation.assumptions = ['Iterates are rounded to two decimals.']; },
      (m: ModelManifest) => { m.interpretation.limitations.push('Only small steps.'); },
      (m: ModelManifest) => { m.constraints[0].max = 2.4; },
      (m: ModelManifest) => { m.constraints[0].maxInclusive = false; },
      (m: ModelManifest) => { m.constraints[0].expression = 'eta*a*1.0'; },
      (m: ModelManifest) => { m.parameters.eta.max = 0.9; },
      (m: ModelManifest) => { m.parameters.eta.default = 0.3; },
      (m: ModelManifest) => { m.parameters.eta.step.admissible = { multipleOf: 0.05 }; },
      (m: ModelManifest) => { (m.execution as { kernelVersion: string }).kernelVersion = '1.0.1'; },
      (m: ModelManifest) => { m.sources[0].citation = 'A different derivation.'; },
      (m: ModelManifest) => { m.referenceSuite = { suiteId: 'suite', digest: 'sha256:' + '0'.repeat(64) }; },
      (m: ModelManifest) => { m.geometry.trace.coordinateFrame = 'x horizontal, n vertical'; },
    ];
    for (const change of scientific) expect(compare(change).scientific).toBe(true);
  });

  it('normalizes semantically equal constraint declarations', () => {
    expect(compare(m => { m.constraints[0].maxInclusive = true; }).scientific).toBe(false);
    const swapped = compare(m => { m.constraints.reverse(); }, () => {
      const m = rectangleManifest();
      return m;
    });
    expect(swapped.scientific).toBe(false);
    expect(swapped.digest).toBe(true);
  });

  it('uses the exact document model revision for document executions', async () => {
    for (const document of [dropDocument(), createPreset('projectile'), createPreset('riemann-sums'), createPreset('linear-map')]) {
      expect(documentModelRevision(document)).toBe((await documentIdentity(document)).modelRevision);
    }
    const relabel = compare(m => { documentOf(m).parameters.h.label = 'Release height'; }, dropManifest);
    expect(relabel).toEqual({ scientific: false, presentation: true, digest: true });
    const physics = compare(m => { documentOf(m).quantities.height.expression = 'h-g*time*time/3'; }, dropManifest);
    expect(physics.scientific).toBe(true);
  });
});

describe('manifest validation (report §5.1)', () => {
  it('accepts the fixtures and returns deep-frozen detached copies', () => {
    for (const make of [geometricManifest, rectangleManifest, dropManifest, gapManifest]) {
      const input = make();
      const { manifest } = validateManifest(input);
      expect(manifest).toEqual(input);
      expect(manifest).not.toBe(input);
      expect(Object.isFrozen(manifest.parameters)).toBe(true);
      expect(isValidatedManifest(manifest)).toBe(true);
      expect(isValidatedManifest(input)).toBe(false);
      expect(() => { (manifest as { title: string }).title = 'changed'; }).toThrow();
    }
  });

  it('rejects unknown fields, oversized collections and long text at every level', () => {
    expect(manifestShapeErrors({ ...geometricManifest(), sourceScript: 'x' })[0]).toMatchObject({ code: 'SCHEMA', path: '$.sourceScript' });
    const nested = geometricManifest() as unknown as { parameters: { a: Record<string, unknown> } };
    nested.parameters.a.url = 'javascript:alert(1)';
    expect(manifestShapeErrors(nested)[0].path).toBe('$.parameters.a.url');
    const many = geometricManifest();
    for (let i = 0; i < 65; i++) many.parameters[`p${i}`] = { ...many.parameters.eta };
    expect(manifestShapeErrors(many)[0].message).toMatch(/entry limit/);
    const longExpression = geometricManifest();
    longExpression.constraints[0].expression = 'a+'.repeat(1100) + 'a';
    expect(manifestShapeErrors(longExpression).length).toBeGreaterThan(0);
    const longLabel = geometricManifest();
    longLabel.parameters.a.label = 'x'.repeat(201);
    expect(manifestShapeErrors(longLabel)[0].path).toBe('$.parameters.a.label');
    const constraints = geometricManifest();
    constraints.constraints = Array.from({ length: 33 }, (_, i) => ({ ...constraints.constraints[0], id: `c${i}` }));
    expect(manifestShapeErrors(constraints)[0].path).toBe('$.constraints');
    // Accessors, prototypes and cycles are rejected without being invoked.
    let touched = false;
    const getter = geometricManifest() as unknown as Record<string, unknown>;
    Object.defineProperty(getter, 'title', { enumerable: true, get() { touched = true; return 'x'; } });
    expect(manifestShapeErrors(getter)[0].message).toMatch(/Accessors/);
    expect(touched).toBe(false);
    expect(manifestShapeErrors(JSON.parse('{"__proto__": {"polluted": true}}'))[0].message).toMatch(/Reserved/);
    expect(MODEL_MANIFEST_SCHEMA.additionalProperties).toBe(false);
  });

  it('accepts the three execution shapes only', () => {
    const wrong = geometricManifest() as unknown as { execution: Record<string, unknown> };
    wrong.execution.mode = 'continuous';
    expect(manifestShapeErrors(wrong)[0].path).toBe('$.execution');
    const extra = geometricManifest() as unknown as { execution: Record<string, unknown> };
    extra.execution.source = 'export default () => 1';
    expect(manifestShapeErrors(extra).length).toBeGreaterThan(0);
    expect(manifestShapeErrors(dropManifest())).toEqual([]);
    expect(manifestShapeErrors(rectangleManifest())).toEqual([]);
  });

  it('enforces semantic rules with scoped diagnostics', () => {
    const bounds = geometricManifest(); bounds.parameters.eta.min = 1; bounds.parameters.eta.max = 1;
    expect(codes(() => validateManifest(bounds))).toContain('INVALID_INPUT');
    const outside = geometricManifest(); outside.parameters.eta.default = 2;
    expect(paths(() => validateManifest(outside))).toContain('$.parameters.eta.default');
    const inadmissible = geometricManifest(); inadmissible.parameters.x0.default = 1.5;
    expect(paths(() => validateManifest(inadmissible))).toContain('$.parameters.x0.default');
    const coupled = geometricManifest(); coupled.parameters.eta.default = 1; coupled.parameters.a.default = 3;
    expect(codes(() => validateManifest(coupled))).toEqual(['CONSTRAINT_VIOLATION']);
    const reference = geometricManifest(); reference.constraints[0].expression = 'eta*position';
    expect(codes(() => validateManifest(reference))).toContain('INVALID_REFERENCE');
    const parse = geometricManifest(); parse.constraints[0].expression = 'eta*(a';
    expect(paths(() => validateManifest(parse))).toContain('$.constraints[0].expression');
    const unbounded = geometricManifest(); delete unbounded.constraints[0].max;
    expect(paths(() => validateManifest(unbounded))).toContain('$.constraints[0]');
    const empty = geometricManifest(); empty.constraints[0].min = 2.5; empty.constraints[0].maxInclusive = false;
    expect(codes(() => validateManifest(empty))).toContain('INVALID_INPUT');
    const duplicate = rectangleManifest(); duplicate.constraints[1].id = duplicate.constraints[0].id;
    expect(paths(() => validateManifest(duplicate))).toContain('$.constraints[1].id');
    const reserved = geometricManifest(); reserved.parameters.pi = reserved.parameters.eta;
    expect(paths(() => validateManifest(reserved))).toContain('$.parameters.pi');
    const index = geometricManifest(); index.limits.maxIndex = 11;
    expect(paths(() => validateManifest(index))).toContain('$.limits.maxIndex');
    const staticIndex = rectangleManifest(); staticIndex.limits.maxIndex = 3;
    expect(paths(() => validateManifest(staticIndex))).toContain('$.limits.maxIndex');
    const elements = geometricManifest(); elements.geometry.trace.maxElements = 14;
    expect(codes(() => validateManifest(elements))).toContain('RESOURCE_LIMIT');
    const categories = geometricManifest(); (categories.quantities.regime.shape as { values: string[] }).values.push('monotone');
    expect(paths(() => validateManifest(categories))).toContain('$.quantities.regime.shape.values');
  });

  it('requires document executions to agree with the manifest', () => {
    const doc = dropManifest(); documentOf(doc).parameters.h.max = 50;
    expect(paths(() => validateManifest(doc))).toContain('$.execution.document.parameters.h');
    const missingGeometry = dropManifest(); missingGeometry.geometry = {};
    expect(codes(() => validateManifest(missingGeometry))).toContain('INVALID_REFERENCE');
    const kind = dropManifest(); kind.geometry.fall.kind = 'points2';
    expect(paths(() => validateManifest(kind))).toContain('$.geometry.fall.kind');
    const extraQuantity = dropManifest(); extraQuantity.quantities.speed = { ...extraQuantity.quantities.height };
    expect(paths(() => validateManifest(extraQuantity))).toContain('$.execution.document.quantities');
    const shape = dropManifest(); shape.quantities.height.shape = { kind: 'vector', length: 2 };
    expect(paths(() => validateManifest(shape))).toContain('$.quantities.height.shape');
    const samples = dropManifest(); samples.geometry.fall.maxElements = 50;
    expect(codes(() => validateManifest(samples))).toContain('RESOURCE_LIMIT');
    const broken = dropManifest(); documentOf(broken).quantities.height.expression = 'h-unknown';
    expect(paths(() => validateManifest(broken)).some(path => path.startsWith('$.execution.document.quantities.height'))).toBe(true);
  });
});
