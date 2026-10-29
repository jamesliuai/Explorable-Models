/**
 * A document-kind manifest must agree with its document's own computation (report §8.3, A10; review finding R16), and
 * declared geometry coordinate units must be consistent (R14): dimensions the document computes with, units the document
 * states, explicitly dimensionless versus unspecified dimensions, and the coordinates its series draw.
 */
import { describe, expect, it } from 'vitest';
import type { VisualizationDocument } from '../../packages/core/src/declarative/types';
import { enableDocumentExecution, evaluateRequest, ModelError, validateManifest, type ModelManifest } from '../../packages/core/src/model/index';
import { dropDocument, dropManifest, gapManifest, geometricManifest } from './support/model-fixtures';

enableDocumentExecution();

const problems = (manifest: ModelManifest): string[] => {
  try { validateManifest(manifest); return []; } catch (error) { if (error instanceof ModelError) return error.diagnostics.map(item => `${item.code} ${item.path}`); throw error; }
};
const drop = (edit: (manifest: ModelManifest, document: VisualizationDocument) => void): ModelManifest => {
  const document = dropDocument(), manifest = dropManifest(document);
  edit(manifest, document);
  return manifest;
};

describe('document executions agree with their manifests (R16)', () => {
  it('accepts consistent document manifests, including a unit stated by its label', () => {
    expect(problems(dropManifest())).toEqual([]);
    expect(problems(gapManifest())).toEqual([]);
    expect(dropDocument().parameters.g!.unit).toBe('m/s²');
  });

  it('refuses a quantity the document computes as a time but the manifest declares as a length', () => {
    const manifest = drop(m => { m.quantities.flight = { ...m.quantities.flight!, dimension: 'length', unit: 'm', meaning: 'Distance fallen.' }; });
    expect(problems(manifest)).toContain('UNIT_MISMATCH $.execution.document.quantities.flight.dimension');
    expect(() => evaluateRequest({ manifest, params: { h: 20, g: 10 }, position: { kind: 'time', time: 0 } }, [])).toThrow(ModelError);
  });

  it('refuses a parameter whose manifest dimension contradicts the document', () => {
    expect(problems(drop(m => { m.parameters.h = { ...m.parameters.h!, dimension: 'mass', unit: 'kg' }; }))).toContain('UNIT_MISMATCH $.execution.document.parameters.h.dimension');
  });

  it('refuses a manifest unit other than the unit the document states (document units are never converted)', () => {
    expect(problems(drop(m => { m.parameters.h = { ...m.parameters.h!, unit: 'cm' }; }))).toEqual(['UNIT_MISMATCH $.execution.document.parameters.h.unit']);
    expect(problems(drop((m, d) => { m.quantities.flight = { ...m.quantities.flight!, unit: 'ms' }; d.quantities.flight!.unit = 's'; }))).toEqual(['UNIT_MISMATCH $.execution.document.quantities.flight.unit']);
    // An unstated unit uses the coherent base unit, so a label cannot silently rescale the numbers.
    expect(problems(drop((m, d) => { delete d.parameters.h!.unit; m.parameters.h = { ...m.parameters.h!, unit: 'cm' }; }))).toContain('UNIT_MISMATCH $.execution.document.parameters.h.unit');
  });

  it('infers unstated quantity and coordinate units from the actual document inputs', () => {
    expect(problems(drop(m => { m.quantities.flight!.unit = 'ms'; }))).toContain('UNIT_MISMATCH $.execution.document.quantities.flight.unit');
    expect(problems(drop(m => { m.geometry.fall!.coordinates!.x = 'ms'; }))).toContain('UNIT_MISMATCH $.execution.document.series.fall.x');
    expect(problems(drop((m, d) => {
      d.parameters.h!.unit = 'cm'; m.parameters.h!.unit = 'cm';
      d.quantities.height!.expression = 'h'; m.quantities.height!.unit = 'cm';
      d.quantities.flight!.expression = 2;
      d.series!.fall!.y = 'h*(1-u)'; m.geometry.fall!.unit = 'cm'; m.geometry.fall!.coordinates!.y = 'cm';
    }))).toEqual([]);
  });

  it('refuses mixed scales, misleading output labels and dimensionless ratios with an unstated scale', () => {
    const changed = drop((m, d) => { d.parameters.h!.unit = 'cm'; m.parameters.h!.unit = 'cm'; });
    expect(problems(changed)).toContain('UNIT_MISMATCH $.execution.document.quantities.height.expression');
    const ratio = drop((_m, d) => { d.quantities.height!.unit = 'cm'; });
    expect(problems(ratio)).toContain('UNIT_MISMATCH $.execution.document.quantities.height.unit');
    const ratioOfScales = drop((m, d) => {
      d.parameters.c = { ...d.parameters.h!, unit: 'cm' }; m.parameters.c = { ...m.parameters.h!, unit: 'cm' };
      d.quantities.fraction = { expression: 'c/h', label: 'Ratio', dimension: 'dimensionless' };
      m.quantities.fraction = { ...m.quantities.height!, dimension: 'dimensionless', unit: 'dimensionless' };
    });
    expect(problems(ratioOfScales)).toEqual(['UNIT_MISMATCH $.execution.document.quantities.fraction.unit']);
  });

  it('does not hide a scaled index or overflowing unit scale inside a unitless function', () => {
    for (const expression of ['component([h,h], c/h)', 'sin((h/c)^200)']) {
      const result = problems(drop((m, d) => {
        d.parameters.c = { ...d.parameters.h!, unit: 'cm' }; m.parameters.c = { ...m.parameters.h!, unit: 'cm' };
        d.quantities.extra = { expression, label: 'Extra' };
        m.quantities.extra = { ...m.quantities.height!, dimension: expression.startsWith('component') ? 'length' : 'dimensionless', unit: expression.startsWith('component') ? 'm' : 'dimensionless' };
      }));
      expect(result).toContain('UNIT_MISMATCH $.execution.document.quantities.extra.expression');
    }
  });

  it('treats an unspecified document dimension as unspecified, not dimensionless', () => {
    // Without declared dimensions the document's own checker would accept h + 1 although the manifest says h is a length.
    const unspecified = drop((m, d) => {
      for (const id of ['h', 'g'] as const) delete d.parameters[id]!.dimension;
      for (const id of ['flight', 'height'] as const) delete d.quantities[id]!.dimension;
      d.quantities.height!.expression = 'h + 1';
    });
    expect(problems(unspecified)).toEqual(expect.arrayContaining(['UNIT_MISMATCH $.execution.document.parameters.h.dimension', 'UNIT_MISMATCH $.execution.document.parameters.g.dimension']));
    // Declared, the same expression is a dimension error of the document itself.
    expect(problems(drop((_m, d) => { d.quantities.height!.expression = 'h + 1'; }))).toContain('INVALID_INPUT $.execution.document.quantities.height.expression');
    // Under an explicitly dimensionless manifest parameter, the document's default agrees.
    expect(gapManifest().execution.kind === 'document' && (gapManifest().execution as { document: VisualizationDocument }).document.parameters.c!.dimension).toBeUndefined();
  });

  it('requires a declared dimension for a literal quantity of a dimensional manifest quantity', () => {
    const literal = drop((_m, d) => { d.quantities.flight = { expression: 2, label: 'Flight time' }; d.series!.fall!.y = 'h*(1-u)'; });
    expect(problems(literal)).toContain('UNIT_MISMATCH $.execution.document.quantities.flight.expression');
    const declared = drop((_m, d) => { d.quantities.flight = { expression: 2, label: 'Flight time', dimension: 'time' }; d.series!.fall!.y = 'h*(1-u)'; });
    expect(problems(declared)).toEqual([]);
  });

  it('refuses the iteration dimension, which the document algebra cannot distinguish from a pure number', () => {
    const manifest = gapManifest();
    manifest.parameters.c = { ...manifest.parameters.c!, dimension: 'iteration', unit: 'iteration' };
    expect(problems(manifest)).toContain('UNIT_MISMATCH $.parameters.c.dimension');
  });
});

describe('declared geometry coordinates (R14)', () => {
  it('requires a time-against-height document series to declare its horizontal unit', () => {
    const undeclared = drop(m => { delete m.geometry.fall!.coordinates; });
    expect(problems(undeclared)).toEqual(['UNIT_MISMATCH $.execution.document.series.fall.x']);
    expect(problems(drop(m => { m.geometry.fall!.coordinates = { x: 'm', y: 'm' }; }))).toEqual(['UNIT_MISMATCH $.execution.document.series.fall.x']);
    expect(problems(drop(m => { m.geometry.fall!.coordinates = { x: 'kg', y: 'm' }; }))).toEqual(['UNIT_MISMATCH $.execution.document.series.fall.x']);
  });

  it('binds the dependent coordinate to the geometry unit and fits z to the kind', () => {
    const geometric = geometricManifest();
    geometric.geometry.trace!.coordinates = { x: 'iteration', y: 'm' };
    expect(problems(geometric)).toEqual([]);
    geometric.geometry.trace!.coordinates = { x: 'iteration', y: 'cm' };
    expect(problems(geometric)).toEqual(['UNIT_MISMATCH $.geometry.trace.coordinates.y']);
    geometric.geometry.trace!.coordinates = { x: 'iteration', y: 'm', z: 'm' };
    expect(problems(geometric)).toEqual(['INVALID_INPUT $.geometry.trace.coordinates.z']);
    const spatial = geometricManifest();
    spatial.geometry.trace = { ...spatial.geometry.trace!, kind: 'polyline3', coordinates: { x: 'm', y: 'm' } };
    expect(problems(spatial)).toEqual(['INVALID_INPUT $.geometry.trace.coordinates.z']);
  });

  it('keeps manifests without declared coordinates at their scientific revision, and binds declared ones to it', () => {
    const plain = validateManifest(geometricManifest()).identity;
    const declared = geometricManifest();
    declared.geometry.trace!.coordinates = { x: 'iteration', y: 'm' };
    expect(validateManifest(declared).identity.scientificRevision).not.toBe(plain.scientificRevision);
  });
});
