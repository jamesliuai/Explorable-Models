/** Scientific projection of a normalized schema 2.0 document; shared by opt-in model and document identities. */
import type { MarkSpec, VisualizationDocument } from './types.js';

const mapValues = <T, R>(record: Record<string, T>, project: (value: T) => R): Record<string, R> =>
  Object.fromEntries(Object.entries(record).map(([id, value]) => [id, project(value)]));

export function documentModelProjection(document: VisualizationDocument): unknown {
  const markModel = (mark: MarkSpec): unknown => ({ id: mark.id, type: mark.type, bindings: mark.bindings, series: mark.series, drag: mark.drag, children: mark.children?.map(markModel) });
  return {
    schemaVersion: document.schemaVersion, capabilities: document.capabilities,
    parameters: mapValues(document.parameters, p => ({ value: p.value, min: p.min, max: p.max, integer: p.integer, dimension: p.dimension })),
    quantities: mapValues(document.quantities, q => ({ expression: q.expression, dimension: q.dimension })),
    datasets: mapValues(document.datasets ?? {}, d => ({ columns: d.columns.map(c => ({ id: c.id, unit: c.unit })), rows: d.rows })),
    series: mapValues(document.series ?? {}, s => { const { label: _label, ...model } = s; return model; }),
    time: document.time,
    views: document.views.map(v => ({ id: v.id, type: v.type, marks: v.marks?.map(markModel), quantities: v.quantities, dataset: v.dataset })),
  };
}
