import { digest } from '../identity.js';
import { normalizeDocument } from './validation.js';
import type { DocumentIdentity, VisualizationDocument } from './types.js';
import { documentModelProjection } from './model-projection.js';
/** Model identity includes scientific bindings; cosmetic/metadata changes preserve the scientific run. */
export async function documentIdentity(input: VisualizationDocument): Promise<DocumentIdentity> {
    const document = normalizeDocument(input);
    const model = documentModelProjection(document);
    return { documentRevision: digest(document), modelRevision: digest(model), presentationRevision: digest({ title: document.title, description: document.description, presentation: document.presentation, views: document.views, parameterLabels: Object.fromEntries(Object.entries(document.parameters).map(([id, p]) => [id, { label: p.label, unit: p.unit }])), quantityLabels: Object.fromEntries(Object.entries(document.quantities).map(([id, q]) => [id, { label: q.label, unit: q.unit, description: q.description }])), seriesLabels: Object.fromEntries(Object.entries(document.series ?? {}).map(([id, s]) => [id, s.label])) }) };
}
