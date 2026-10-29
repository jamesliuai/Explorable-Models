/**
 * Hand-written learner copy that states sampling resolution (report §8.5, gap G35) must match the kernels' constants,
 * the `sampling` metadata of the frames the learner sees and the table shortening the projection applies. Changing a
 * kernel's sample count, grid or domain without updating the copy fails here.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { templateRef, type LearnerProjection } from '@explorable-models/activity';
import {
  FIELD_GRID, FUNCTION_DERIVATIVE_COPY, FUNCTION_DERIVATIVE_CURVE, SECTION_SAMPLES, SURFACE_GRADIENT_COPY, SURFACE_GRID,
  functionDerivativeKernel, functionDerivativeManifest, functionDerivativeTemplate, quadraticGradientDescentKernel, quadraticGradientDescentManifest,
  quadraticSurfaceGradientKernel, quadraticSurfaceGradientManifest, quadraticSurfaceGradientTemplate,
} from '@explorable-models/catalog';
import { modelIdentity, type GeometryResult, type ModelManifest } from '@explorable-models/core/model';
import { QUADRATIC_CURVE } from '../../packages/catalog/src/kernels/quadratic-gradient-descent';
import { harness, open, policyFor, requestFor, settled, type Harness } from '../activity/support/adapter-harness';

const ORDINALS: Record<string, number> = { second: 2, third: 3, fourth: 4, fifth: 5, sixth: 6, seventh: 7, eighth: 8, ninth: 9, tenth: 10 };
const defaults = (manifest: ModelManifest) => Object.fromEntries(Object.entries(manifest.parameters).map(([id, p]) => [id, p.default]));
const match = (text: string, pattern: RegExp): string => { const found = pattern.exec(text); expect(found, `${pattern} in “${text}”`).not.toBeNull(); return found![1]!; };
const every = (text: string): number => { const word = match(text, /every (\w+) (?:one|sample)/); expect(ORDINALS, word).toHaveProperty(word); return ORDINALS[word]!; };
const sampling = (geometry: GeometryResult | undefined) => geometry && 'sampling' in geometry ? geometry.sampling : undefined;
const decimal = (value: number) => String(Math.round(value * 1e9) / 1e9);

let current: Harness | null = null;
afterEach(() => { current?.adapter.dispose(); current = null; });
async function projectionOf(template: typeof functionDerivativeTemplate, manifest: ModelManifest, activityId: string): Promise<LearnerProjection> {
  const model = { modelId: manifest.modelId, version: manifest.version, digest: modelIdentity(manifest).digest };
  current = harness({ policy: policyFor({ approved: [{ template: templateRef(template), model }], visibleGroups: template.groups.map(group => group.id), permittedControls: template.controls.map(control => control.parameter) }) });
  const opened = await open(current, requestFor({ activityId, template: { templateId: template.templateId, version: template.version } }));
  await settled(current, activityId);
  return opened.learner.getProjection();
}

describe('sampling stated in learner copy equals the installed kernels (G35)', () => {
  it('function and derivative: the sample count, the sampled range and the “every third” table step', async () => {
    const output = functionDerivativeKernel.evaluate({ params: defaults(functionDerivativeManifest), index: 0 });
    for (const id of ['curve', 'derivative-curve']) expect(sampling(output.geometry[id]), id).toEqual({ samples: FUNCTION_DERIVATIVE_CURVE.samples, domain: [...FUNCTION_DERIVATIVE_CURVE.domain] });
    const curveText = FUNCTION_DERIVATIVE_COPY.alternatives.curveTable.description, derivativeText = FUNCTION_DERIVATIVE_COPY.alternatives.derivativeTable.description;
    expect(Number(match(curveText, /The (\d+) samples/))).toBe(FUNCTION_DERIVATIVE_CURVE.samples);
    for (const text of [curveText, derivativeText, FUNCTION_DERIVATIVE_COPY.groups.functionPlot.description]) expect(text).toContain(`from −${-FUNCTION_DERIVATIVE_CURVE.domain[0]} to ${FUNCTION_DERIVATIVE_CURVE.domain[1]}`);
    // The step the copy names is the one the learner projection applies to the table of this many samples.
    const projection = await projectionOf(functionDerivativeTemplate, functionDerivativeManifest, 'act-sampling-fd');
    const table = projection.views.find(view => view.viewId === 'curve-table')!.table!;
    expect(table.totalRows).toBe(FUNCTION_DERIVATIVE_CURVE.samples);
    expect(table.shortened).toEqual({ kind: 'every', step: every(curveText) });
    expect(every(derivativeText)).toBe(every(curveText));
    // “plus both ends”: the first and the last sample are kept.
    expect(table.rows[0]!.key).toBe('s0p0');
    expect(table.rows.at(-1)!.key).toBe(`s0p${FUNCTION_DERIVATIVE_CURVE.samples - 1}`);
  });

  it('quadratic surface: the 41 by 41 grid and its spacing, 81-point cross-sections and the 81-point gradient field', async () => {
    const output = quadraticSurfaceGradientKernel.evaluate({ params: defaults(quadraticSurfaceGradientManifest), index: 0 });
    const grid = output.geometry.surface as Extract<GeometryResult, { kind: 'surface-grid' }>;
    expect(grid.sampling).toEqual({ nx: SURFACE_GRID.n, ny: SURFACE_GRID.n, domain: [SURFACE_GRID.domain[0], SURFACE_GRID.domain[1], SURFACE_GRID.domain[0], SURFACE_GRID.domain[1]] });
    const spacing = decimal((SURFACE_GRID.domain[1] - SURFACE_GRID.domain[0]) / (SURFACE_GRID.n - 1));
    for (const text of [SURFACE_GRADIENT_COPY.groups.surface.description, SURFACE_GRADIENT_COPY.views.surface.description]) {
      expect(match(text, /(\d+) by \d+/)).toBe(String(SURFACE_GRID.n));
      expect(match(text, /\d+ by (\d+)/)).toBe(String(SURFACE_GRID.n));
      expect(match(text, /spacing ([0-9.]+[0-9])/)).toBe(spacing);
    }
    for (const id of ['cross-section-x', 'cross-section-y']) expect(sampling(output.geometry[id]), id).toEqual({ samples: SECTION_SAMPLES.n, domain: [...SECTION_SAMPLES.domain] });
    for (const text of [SURFACE_GRADIENT_COPY.views.sectionX.description, SURFACE_GRADIENT_COPY.views.sectionY.description]) {
      expect(Number(match(text, /sampled at (\d+) points/))).toBe(SECTION_SAMPLES.n);
      expect(text).toContain(`from −${-SECTION_SAMPLES.domain[0]} to ${SECTION_SAMPLES.domain[1]}`);
    }
    for (const text of [SURFACE_GRADIENT_COPY.groups.crossSections.description, SURFACE_GRADIENT_COPY.views.sectionXTable.description, SURFACE_GRADIENT_COPY.views.sectionYTable.description, SURFACE_GRADIENT_COPY.alternatives.sectionTables.description])
      expect(Number(match(text, /(\d+) (?:points|samples)/)), text).toBe(SECTION_SAMPLES.n);
    const field = output.geometry.field as Extract<GeometryResult, { kind: 'vector-field2' }>;
    expect(field.samples).toHaveLength(FIELD_GRID.n * FIELD_GRID.n);
    for (const text of [SURFACE_GRADIENT_COPY.groups.field.description, SURFACE_GRADIENT_COPY.views.fieldTable.description, SURFACE_GRADIENT_COPY.alternatives.fieldTable.description])
      expect(Number(match(text, /(\d+) grid points/)), text).toBe(FIELD_GRID.n * FIELD_GRID.n);
    // “All 81 samples”: the projected cross-section tables are not shortened.
    const projection = await projectionOf(quadraticSurfaceGradientTemplate, quadraticSurfaceGradientManifest, 'act-sampling-surface');
    const sections = projection.views.filter(view => view.viewId === 'section-x-table' || view.viewId === 'section-y-table').map(view => view.table!);
    expect(sections).toHaveLength(2);
    for (const table of sections) expect(table).toMatchObject({ totalRows: SECTION_SAMPLES.n, truncated: false });
  });

  it('quadratic gradient descent: the objective curve frame carries the kernel sampling that the manifest states', () => {
    const output = quadraticGradientDescentKernel.evaluate({ params: defaults(quadraticGradientDescentManifest), index: 0 });
    expect(sampling(output.geometry.curve)).toEqual({ samples: QUADRATIC_CURVE.samples, domain: [...QUADRATIC_CURVE.domain] });
    expect(quadraticGradientDescentManifest.geometry.curve!.description).toContain(`sampled at ${QUADRATIC_CURVE.samples} evenly spaced positions`);
    expect(quadraticGradientDescentManifest.geometry.curve!.maxElements).toBe(QUADRATIC_CURVE.samples);
  });
});
