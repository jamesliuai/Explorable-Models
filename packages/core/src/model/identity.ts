/**
 * Model identity split (report §8.3, A10, §5.2):
 * - `digest` covers the exact canonical manifest.
 * - `scientificRevision` covers everything that changes scientific interpretation: execution (kernel ID/version or
 *   the embedded document's model revision), capabilities, parameter domains/units/admissibility, quantity
 *   shapes/units/meanings/frames/sign conventions, geometry (including declared coordinate units), constraint
 *   expressions and bounds, interpretation (including assumptions), limits, sources, the reference suite, observed
 *   datasets (every cell, unit, meaning, missing-cell reason and the provenance), the declared evaluation behaviour
 *   (determinism class and checkpoint requirement) and the model's explanatory content: the summary, parameter
 *   descriptions and symbols, quantity symbols, geometry and dataset descriptions and constraint messages and
 *   recoveries, and the wording ({@link labelWording}) of the title and of every parameter, quantity, geometry,
 *   dataset and column label. These say what each input, output and drawing means and how a learner reads it — a
 *   quantity label is the learner's readout name — so swapping two parameters' descriptions or symbols, swapping two
 *   readout labels, relabelling a quantity with another quantity's name or redescribing an iteration trace as a
 *   continuous-time solution is a change of meaning even though the numbers are unchanged. A unit change with
 *   unchanged numbers, a flipped sign convention or an altered assumption changes it too. Model reviews bind this
 *   revision (catalogue registry).
 * - `presentationRevision` covers harmless presentation metadata only — the report's "label spelling and display
 *   precision": the exact spelling of the title and labels (so a respelling that keeps the wording changes only this
 *   revision), UI step increments and, for documents, the full document bytes. The embedded document's own labels and
 *   titles stay presentation because no model or activity channel reads them: frames carry values only, and every
 *   learner channel names inputs and outputs from the manifest and the template. Tests list harmless and meaningful
 *   edits explicitly (tests/core/model-identity.test.ts) rather than exempting whole fields.
 * Model ID and version are carried by `ModelRef`, not by either revision.
 */
import type { VisualizationDocument } from '../declarative/types.js';
import { canonicalJSON, digest, sha256 } from '../identity.js';
import { documentExecution, missingDocumentSupport } from './document-support.js';
import type { ModelConstraint, ModelIdentity, ModelManifest, ObservationDataset } from './types.js';

const mapValues = <T, R>(record: Record<string, T>, project: (value: T) => R): Record<string, R> =>
  Object.fromEntries(Object.entries(record).map(([id, value]) => [id, project(value)]));
const byId = <T extends { id: string }>(items: T[]): T[] => [...items].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/** Ordinary spacing only. Keep invisible U+FEFF and dash-like U+1680 in scientific identity, even at the ends. */
const SPACE = /[\t\n\v\f\r \u00a0\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+/g;
/** Curly and low-9 quotation marks and apostrophes → their straight forms. Primes (′ ″) are notation and are kept. */
const QUOTES = /[\u2018\u2019\u201a\u201b\u201c\u201d\u201e\u201f]/g;
const straight = (mark: string): string => mark <= '\u201b' ? "'" : '"';
/**
 * A hyphen (U+002D, U+2010, U+2011) or en dash joining two ASCII words of three or more letters each: "Step-size",
 * "Cross–section", "two-dimensional". A shorter word on either side may be notation and keeps its hyphen: "x-axis",
 * "x-y" and "ad-bc" (ad − bc, not the product ad·bc).
 */
const COMPOUND = /(?<![A-Za-z0-9])([A-Za-z]{3,})[-\u2010\u2011\u2013](?=[A-Za-z]{3,}(?![A-Za-z0-9]))/g;

/**
 * Wording of a learner-visible label or title (report §8.3): the label with only its certifiably harmless spelling
 * variation removed. Two labels with equal wording say the same words in the same form, so an edit between them is
 * "harmless label spelling" and changes only the presentation revision; every other label edit changes the scientific
 * revision. The rule is deliberately narrow and the same in every engine (explicit character classes, Unicode
 * canonical composition):
 * - Unicode canonical equivalence: the text is compared in NFC, so a composed and a decomposed "é" are equal;
 * - spacing: ordinary white space (including no-break and thin spaces) becomes one space; ordinary end spaces are
 *   trimmed. Invisible U+FEFF and dash-like U+1680 are preserved;
 * - quotation marks: curly and straight quotes and apostrophes are equal ("Newton’s" = "Newton's");
 * - compound hyphenation: a hyphen or en dash joining two words of three or more letters is a space
 *   ("Step-size" = "Step size").
 * Everything else is a change of wording and so of meaning, because no mechanical rule can tell a corrected
 * misspelling from a different word ("Height" → "Weight" is one letter) or a harmless capital from a meaningful one
 * (case names different coefficients, prefixes and units: "a"/"A", "mm"/"Mm", "mrad"/"Mrad"): an added, removed,
 * replaced or reordered word, any changed letter, letter case, digit, symbol or unit, and a hyphen next to a word of
 * one or two letters. Such an edit needs a new review even when it only fixes capitalization or a typing error; that is
 * the conservative side.
 */
export function labelWording(label: string): string {
  return label.normalize('NFC')
    .replace(QUOTES, straight)
    .replace(COMPOUND, '$1 ')
    .replace(SPACE, ' ').replace(/^ +| +$/g, '');
}

/**
 * Synchronous equivalent of `documentIdentity(document).modelRevision` (declarative/identity.ts). Tests assert both
 * functions agree so the projections cannot drift.
 */
export function documentModelRevision(input: VisualizationDocument): string {
  const support = documentExecution('$.execution.document');
  if (!support.modelRevision) missingDocumentSupport('$.execution.document', 'model identity');
  return support.modelRevision(input);
}

/** Constraint inclusivity defaults to inclusive; normalized so `undefined` and `true` are the same science. */
const constraintScience = (c: ModelConstraint) => ({
  id: c.id, expression: c.expression, min: c.min, max: c.max, message: c.message, recovery: c.recovery,
  minInclusive: c.min === undefined ? undefined : c.minInclusive ?? true,
  maxInclusive: c.max === undefined ? undefined : c.maxInclusive ?? true,
});

export function scientificProjection(manifest: ModelManifest): unknown {
  const execution = manifest.execution;
  return {
    contract: manifest.contract, schemaVersion: manifest.schemaVersion,
    execution: execution.kind === 'document'
      ? { kind: 'document', modelRevision: documentModelRevision(execution.document) }
      : execution.mode === 'discrete'
        ? { kind: 'kernel', kernelId: execution.kernelId, kernelVersion: execution.kernelVersion, mode: 'discrete', maxIndex: execution.maxIndex }
        : { kind: 'kernel', kernelId: execution.kernelId, kernelVersion: execution.kernelVersion, mode: 'static' },
    capabilities: [...manifest.capabilities].sort((a, b) => canonicalJSON(a) < canonicalJSON(b) ? -1 : 1),
    summary: manifest.summary,
    // Wording of the title and labels (spelling variants that keep the words are presentation; see labelWording).
    title: labelWording(manifest.title),
    parameters: mapValues(manifest.parameters, p => ({ wording: labelWording(p.label), description: p.description, symbol: p.symbol, dimension: p.dimension, unit: p.unit, min: p.min, max: p.max, default: p.default, admissible: p.step.admissible, role: p.role })),
    quantities: mapValues(manifest.quantities, q => ({ wording: labelWording(q.label), symbol: q.symbol, shape: q.shape, dimension: q.dimension, unit: q.unit, meaning: q.meaning, coordinateFrame: q.coordinateFrame, signConvention: q.signConvention })),
    // Declared coordinate units (absent → omitted, so a manifest without them keeps its revision).
    geometry: mapValues(manifest.geometry, g => ({ wording: labelWording(g.label), kind: g.kind, description: g.description, dimension: g.dimension, unit: g.unit, coordinateFrame: g.coordinateFrame, maxElements: g.maxElements, observations: g.observations, coordinates: g.coordinates })),
    constraints: byId(manifest.constraints).map(constraintScience),
    interpretation: manifest.interpretation,
    limits: manifest.limits,
    sources: byId(manifest.sources),
    referenceSuite: manifest.referenceSuite,
    observations: manifest.observations && mapValues(manifest.observations, observationScience),
    // Declared determinism and checkpoint behaviour (absent → omitted, so manifests without it keep their revision).
    evaluation: manifest.evaluation,
  };
}

/**
 * Scientific content of an observed dataset (report §8.5): every cell, column units/dimensions/meanings, missing-cell
 * reasons (order-independent), provenance, the description of what the dataset holds and the wording of the dataset
 * and column labels (column labels are the learner's table headers). Label spelling is presentation.
 */
const observationScience = (dataset: ObservationDataset) => ({
  wording: labelWording(dataset.label),
  description: dataset.description,
  columns: dataset.columns.map(c => ({ id: c.id, wording: labelWording(c.label), dimension: c.dimension, unit: c.unit, meaning: c.meaning })),
  rows: dataset.rows,
  missing: dataset.missing && [...dataset.missing].sort((a, b) => a.row - b.row || (a.column < b.column ? -1 : a.column > b.column ? 1 : 0)),
  missingReason: dataset.missingReason,
  provenance: dataset.provenance,
});

export function presentationProjection(manifest: ModelManifest): unknown {
  return {
    title: manifest.title,
    parameters: mapValues(manifest.parameters, p => ({ label: p.label, ui: p.step.ui })),
    quantities: mapValues(manifest.quantities, q => ({ label: q.label })),
    geometry: mapValues(manifest.geometry, g => ({ label: g.label })),
    document: manifest.execution.kind === 'document' ? digest(documentExecution('$.execution.document').normalize(manifest.execution.document)) : null,
    observations: manifest.observations && mapValues(manifest.observations, d => ({ label: d.label, columns: d.columns.map(c => ({ id: c.id, label: c.label })) })),
  };
}

/** Identity of an already shape-checked manifest. Throws for an invalid embedded document. */
export function modelIdentity(manifest: ModelManifest): ModelIdentity {
  return {
    digest: 'sha256:' + sha256(canonicalJSON(manifest)),
    scientificRevision: digest(scientificProjection(manifest)),
    presentationRevision: digest(presentationProjection(manifest)),
  };
}
