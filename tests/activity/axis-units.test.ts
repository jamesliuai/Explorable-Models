/**
 * Axis units are the canonical units of what the axis draws (report §8.3, A10, A34; review finding R14). View bounds,
 * ticks, coordinates and table cells are canonical model values that no renderer converts, so an axis title naming
 * another unit — even one of the same dimension — would mislabel the numbers. Template validation therefore requires
 * every 2D/3D axis (and every table column drawn from geometry) to name exactly the unit of each coordinate drawn along
 * it: declared geometry coordinates, observed columns, and positional quantity bindings.
 */
import { describe, expect, it } from 'vitest';
import type { ActivityTemplate, Diagnostic } from '../../packages/activity/src/contracts';
import { validateTemplateSemantics } from '../../packages/activity/src/semantic';
import { enableDocumentExecution, geometryCoordinates, modelIdentity, type ModelManifest } from '../../packages/core/src/model/index';
import { INSTALLED_MODELS, INSTALLED_TEMPLATES } from '../../packages/catalog/src/index';
import { linearTransformationManifest, linearTransformationTemplate, quadraticGradientDescentManifest, quadraticGradientDescentTemplate } from '../../packages/catalog/src/index';
import { fallingBallManifest, fallingBallTemplate } from '../../examples/study-harness-observed/content';

enableDocumentExecution();

const mismatches = (diagnostics: Diagnostic[]): string[] => diagnostics.filter(item => item.code === 'UNIT_MISMATCH').map(item => item.path);
const edit = (template: ActivityTemplate, change: (draft: ActivityTemplate) => void): ActivityTemplate => { const draft = structuredClone(template); change(draft); return draft; };
const viewIndex = (template: ActivityTemplate, id: string): number => template.views.findIndex(view => view.id === id);
const view = (draft: ActivityTemplate, id: string) => draft.views[viewIndex(draft, id)]!;
const rebound = (template: ActivityTemplate, manifest: ModelManifest): ActivityTemplate => ({ ...template, model: { ...template.model, digest: modelIdentity(manifest).digest } });

describe('axis units name the canonical units of what is drawn (R14)', () => {
  it('accepts every installed template and the dimensional observed example as authored', () => {
    for (const template of INSTALLED_TEMPLATES) {
      const manifest = INSTALLED_MODELS.find(model => model.modelId === template.model.modelId)!;
      expect(mismatches(validateTemplateSemantics(template, manifest)), template.templateId).toEqual([]);
    }
    expect(mismatches(validateTemplateSemantics(fallingBallTemplate, fallingBallManifest))).toEqual([]);
  });

  it('declares the iteration index as the horizontal coordinate of the quadratic position trace', () => {
    expect(geometryCoordinates(quadraticGradientDescentManifest, 'trace')).toEqual({ x: 'iteration', y: 'dimensionless' });
    expect(geometryCoordinates(quadraticGradientDescentManifest, 'curve')).toEqual({ x: 'dimensionless', y: 'dimensionless' });
    expect(geometryCoordinates(fallingBallManifest, 'prediction')).toEqual({ x: 's', y: 'm' });
    // Observed data take their columns' units.
    expect(geometryCoordinates(fallingBallManifest, 'measured')).toEqual({ x: 's', y: 'm' });
  });

  it('rejects axes relabelled with units of other dimensions over dimensionless and iteration geometry', () => {
    const template = quadraticGradientDescentTemplate;
    const landscape = viewIndex(template, 'landscape'), trace = viewIndex(template, 'trace-plot');
    const relabelled = edit(template, draft => {
      view(draft, 'landscape').axes = { x: { label: 'Position x', unit: 'm' }, y: { label: 'Loss f(x)', unit: 'kg' } };
      view(draft, 'trace-plot').axes = { x: { label: 'Time', unit: 's' }, y: { label: 'Position x_n', unit: 'N' } };
    });
    expect(mismatches(validateTemplateSemantics(relabelled, quadraticGradientDescentManifest))).toEqual([
      `$.views[${landscape}].axes.x.unit`, `$.views[${landscape}].axes.y.unit`, `$.views[${trace}].axes.x.unit`, `$.views[${trace}].axes.y.unit`,
    ]);
    // An index axis must be an iteration axis: a dimensionless horizontal axis over the trace is refused too, so the
    // comparison alignment keyed on iteration axes cannot be changed by relabelling.
    const dimensionless = edit(template, draft => { view(draft, 'trace-plot').axes!.x.unit = 'dimensionless'; });
    expect(mismatches(validateTemplateSemantics(dimensionless, quadraticGradientDescentManifest))).toEqual([`$.views[${trace}].axes.x.unit`]);
  });

  it('checks table columns drawn from geometry', () => {
    const template = quadraticGradientDescentTemplate;
    const tableIndex = template.views.findIndex(entry => entry.kind === 'table' && entry.rowsFrom === 'trace' && entry.axes);
    expect(tableIndex).toBeGreaterThanOrEqual(0);
    const edited = edit(template, draft => { draft.views[tableIndex]!.axes!.x.unit = 's'; });
    expect(mismatches(validateTemplateSemantics(edited, quadraticGradientDescentManifest))).toEqual([`$.views[${tableIndex}].axes.x.unit`]);
  });

  it('rejects a compatible but different unit (cm over metres, ms over seconds, deg over radians): nothing converts axis values', () => {
    const plot = viewIndex(fallingBallTemplate, 'fall-plot'), table = viewIndex(fallingBallTemplate, 'prediction-table');
    const scaled = edit(fallingBallTemplate, draft => {
      view(draft, 'fall-plot').axes = { x: { label: 'Time t', unit: 'ms' }, y: { label: 'Height h', unit: 'cm' } };
      view(draft, 'prediction-table').axes = { x: { label: 'Time t', unit: 'ms' }, y: { label: 'Height h', unit: 'cm' } };
    });
    expect(mismatches(validateTemplateSemantics(scaled, fallingBallManifest))).toEqual([
      `$.views[${plot}].axes.x.unit`, `$.views[${plot}].axes.y.unit`, `$.views[${table}].axes.x.unit`, `$.views[${table}].axes.y.unit`,
    ]);
    const wrongDimension = edit(fallingBallTemplate, draft => { view(draft, 'fall-plot').axes = { x: { label: 'Time t', unit: 'kg' }, y: { label: 'Height h', unit: 'N' } }; });
    expect(mismatches(validateTemplateSemantics(wrongDimension, fallingBallManifest))).toEqual([`$.views[${plot}].axes.x.unit`, `$.views[${plot}].axes.y.unit`]);
    // A quantity-bound axis must name the quantity's own unit, not merely one of its dimension.
    const bound = edit(fallingBallTemplate, draft => { view(draft, 'fall-plot').axes!.x = { label: 'Time t', unit: 'ms', quantity: 'landing' }; });
    const boundPaths = mismatches(validateTemplateSemantics(bound, fallingBallManifest));
    expect(boundPaths).toEqual([`$.views[${plot}].axes.x.unit`]);
    const exact = edit(fallingBallTemplate, draft => { view(draft, 'fall-plot').axes!.x = { label: 'Time t', unit: 's', quantity: 'landing' }; });
    expect(mismatches(validateTemplateSemantics(exact, fallingBallManifest))).toEqual([]);
    // Degrees over an angle quantity in radians.
    const orientation = INSTALLED_TEMPLATES.find(entry => entry.templateId === 'vector-orientation-3d')!;
    const orientationManifest = INSTALLED_MODELS.find(entry => entry.modelId === 'vector-orientation-3d')!;
    expect(orientationManifest.quantities.angle!.unit).toBe('rad');
    const scene = orientation.views.findIndex(entry => entry.axes);
    const degrees = edit(orientation, draft => { draft.views[scene]!.axes!.y = { label: 'Angle θ', unit: 'deg', quantity: 'angle' }; });
    expect(mismatches(validateTemplateSemantics(degrees, orientationManifest))).toContain(`$.views[${scene}].axes.y.unit`);
  });

  it('holds positional quantity bindings to the axis units too', () => {
    const index = linearTransformationTemplate.views.findIndex(entry => entry.marks.some(item => item.bindings.vector !== undefined) && entry.axes);
    expect(index).toBeGreaterThanOrEqual(0);
    const metres = edit(linearTransformationTemplate, draft => { draft.views[index]!.axes = { x: { label: 'x', unit: 'm' }, y: { label: 'y', unit: 'm' } }; });
    expect(mismatches(validateTemplateSemantics(metres, linearTransformationManifest))).toEqual([`$.views[${index}].axes.x.unit`, `$.views[${index}].axes.y.unit`]);
  });

  it('a quantity in metres under a centimetre axis is refused even when the geometry is relabelled to match the quantity', () => {
    const manifest = structuredClone(quadraticGradientDescentManifest) as ModelManifest;
    manifest.quantities.position = { ...manifest.quantities.position!, dimension: 'length', unit: 'm' };
    manifest.geometry.trace = { ...manifest.geometry.trace!, dimension: 'length', unit: 'm', coordinates: { x: 'iteration', y: 'm' } };
    const trace = viewIndex(quadraticGradientDescentTemplate, 'trace-plot');
    // The trace table draws the same geometry: its columns are in metres too.
    const tables = (draft: ActivityTemplate) => { for (const entry of draft.views) if (entry.rowsFrom === 'trace' && entry.axes) entry.axes.y.unit = 'm'; };
    const centimetres = edit(rebound(quadraticGradientDescentTemplate, manifest), draft => {
      tables(draft);
      view(draft, 'trace-plot').axes = { x: { label: 'Iteration n', unit: 'iteration' }, y: { label: 'Position x_n', unit: 'cm', quantity: 'position' } };
    });
    expect(mismatches(validateTemplateSemantics(centimetres, manifest))).toEqual([`$.views[${trace}].axes.y.unit`]);
    const metres = edit(rebound(quadraticGradientDescentTemplate, manifest), draft => {
      tables(draft);
      view(draft, 'trace-plot').axes = { x: { label: 'Iteration n', unit: 'iteration' }, y: { label: 'Position x_n', unit: 'm', quantity: 'position' } };
    });
    expect(mismatches(validateTemplateSemantics(metres, manifest))).toEqual([]);
  });
});
