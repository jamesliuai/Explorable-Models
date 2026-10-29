/**
 * Deterministic interaction summaries (activity-runtime §6, report §7.3, A17). A summary reports what the journal
 * records — committed configurations, sampled preview observations, revealed content, comparisons and host response
 * references — through an explicit event cursor, and says what it leaves out. It never interprets the record: the
 * text is assembled from fixed sentence templates over the structured fields and never asserts that a learner
 * understood, mastered, knows or learned anything. Same input → byte-identical JSON (no clock, no randomness).
 */
import type {
  ActivityInstance, ActivityTemplate, Diagnostic, DisplayStatus, ExposureRecord, FramePosition, InteractionEvent, InteractionSummary, JournalLoss, ModelManifest,
  QuantityResult, ResponseRef, SummaryConfiguration, SummaryPreview,
} from './contracts.js';
import { ACTIVITY_SCHEMA_VERSION, CONTRACTS, SUMMARY_LIMITS } from './contracts.js';
import { LIMITS } from './schemas.js';
import { validateRecord } from './validator.js';

export const SUMMARIZER_VERSION = '1.0.0';
/**
 * Assessment vocabulary a summary must never contain, with the inflections of each verb (`learning` as in "learning
 * rate" therefore never reaches a summary either; the noun `learner` names an audience and is not an inflection).
 * Free-text fields that come from authored or recorded labels are replaced by neutral text when they match;
 * identifiers are references and are kept verbatim.
 */
export const FORBIDDEN_SUMMARY_TERMS = /\b(?:understand(?:s|ing)?|understood|master(?:s|ed|ing|y)?|know(?:s|n|ing|ledge)?|knew|learn(?:s|ed|t|ing)?|competen(?:t|ce|cy)|proficien(?:t|cy))\b/i;

export interface SummaryInput {
  /** Acknowledged events (the outbox mirror). */
  events: InteractionEvent[];
  /** Events not yet acknowledged by the host; reported, never counted as complete. */
  pending: InteractionEvent[];
  /** Acknowledged events no longer held locally (outbox `trimmedBefore()`). */
  trimmedBefore: number;
  instance: ActivityInstance;
  template: ActivityTemplate;
  manifest: ModelManifest;
  /** Current exposure records of the activity. */
  exposures: ExposureRecord[];
  audience: InteractionSummary['audience'];
  fromSequence?: number;
  toSequence?: number;
  /** Lower-only overrides of {@link SUMMARY_LIMITS}. */
  limits?: Partial<{ committedConfigurations: number; previewObservations: number; bytes: number }>;
  summarizerVersion?: string;
  /** Presentation changes the outbox coalesced instead of journaling (`OutboxState.coalesced`). */
  coalescedViewChanges?: number;
  /**
   * Events the journal could not record (activity-runtime §5): the adapter's cumulative loss record. Without it, losses
   * recorded in the summarized events (`operation.failed` with `lost`) are reported. Either way the summary is incomplete.
   */
  journalLoss?: JournalLoss;
  /** Host-resolved review notice of the exact template and model (the projection's `reviewNotice`); bounded to 200 characters. */
  reviewNotice?: string;
}

/** Fixed sentence of every exploratory-mode summary (report §5.2): its results are not reviewed assessment content. */
export const EXPLORATORY_SUMMARY_SENTENCE = 'This was an exploratory composition: it is not reviewed, and its results are not reviewed assessment content.';

/** Thrown by {@link summarize} for invalid input; `diagnostics` are learner-safe. */
export class SummaryError extends Error {
  readonly diagnostics: Diagnostic[];
  constructor(diagnostics: Diagnostic[]) { super(diagnostics.map(item => item.message).join(' ')); this.name = 'SummaryError'; this.diagnostics = diagnostics; }
}

const invalid = (path: string, message: string, recovery?: string): Diagnostic => ({ code: 'INVALID_INPUT', path, message, ...(recovery ? { recovery } : {}) });
const clean = (text: string, fallback: string): string => FORBIDDEN_SUMMARY_TERMS.test(text) ? fallback : text;
const plural = (count: number, noun: string): string => `${count} ${noun}${count === 1 ? '' : 's'}`;
const sortKeys = <T>(map: Record<string, T>, keep: (key: string) => boolean = () => true): Record<string, T> =>
  Object.fromEntries(Object.keys(map).filter(keep).sort().map(key => [key, structuredClone(map[key]!)]));
const isInteger = (value: unknown, min: number): value is number => typeof value === 'number' && Number.isInteger(value) && value >= min;
const bytes = (value: unknown): number => new TextEncoder().encode(JSON.stringify(value)).length;
const codePoints = (text: string): number => [...text].length;

/** First, last and evenly spaced by order (deterministic); all items when they fit. */
export function representatives<T>(items: readonly T[], count: number): T[] {
  if (items.length <= count) return [...items];
  if (count <= 0) return [];
  if (count === 1) return [items[0]!];
  const picked = new Set<number>();
  for (let index = 0; index < count; index++) picked.add(Math.round(index * (items.length - 1) / (count - 1)));
  return [...picked].sort((a, b) => a - b).map(index => items[index]!);
}

/** Contiguous [start, end] runs of a sorted list of sequences. */
function runsOf(sequences: readonly number[]): [number, number][] {
  const out: [number, number][] = [];
  for (const sequence of sequences) {
    const last = out.at(-1);
    if (last && sequence === last[1] + 1) last[1] = sequence; else out.push([sequence, sequence]);
  }
  return out;
}
/** "3–5, 9", listing at most `max` ranges. */
function rangeText(ranges: readonly [number, number][], max = 12): string {
  const parts = ranges.slice(0, max).map(([start, end]) => start === end ? String(start) : `${start}–${end}`);
  return ranges.length > max ? `${parts.join(', ')} and ${ranges.length - max} further ranges` : parts.join(', ');
}
/** "a, b and 3 more", listing at most `max` items. */
function listText(items: readonly string[], max = 10): string {
  const shown = items.slice(0, max).join(', ');
  return items.length > max ? `${shown} and ${items.length - max} more` : shown;
}

/** Index and time positions compare by index/time; positions of different kinds are not ordered. */
const further = (candidate: FramePosition | null, current: FramePosition | null): boolean => {
  if (!candidate) return false;
  if (!current) return true;
  if (candidate.kind === 'index' && current.kind === 'index') return candidate.index > current.index;
  if (candidate.kind === 'time' && current.kind === 'time') return candidate.time > current.time;
  return false;
};

interface Caps { configurations: number; previews: number; rendered: number; observations: boolean; revealed: number; comparisons: number; responses: number }
interface Track { previewId: string; first: number; observed: InteractionEvent[]; cancelled: boolean; committed: boolean }
type Payload = Record<string, unknown>;
const payload = (event: InteractionEvent): Payload => event.payload;

function checkInput(input: SummaryInput): Diagnostic[] {
  const out: Diagnostic[] = [];
  const limits = input.limits ?? {};
  for (const [key, value] of Object.entries(limits)) {
    if (!Object.hasOwn(SUMMARY_LIMITS, key)) { out.push(invalid(`$.limits.${key}`, 'Unknown summary limit.')); continue; }
    const maximum = SUMMARY_LIMITS[key as keyof typeof SUMMARY_LIMITS];
    if (!isInteger(value, key === 'bytes' ? 1 : 0) || value > maximum) out.push(invalid(`$.limits.${key}`, `Summary limits can only be lowered; ${key} must be an integer of at most ${maximum}.`, 'Request a smaller limit or use the default.'));
  }
  if (!isInteger(input.trimmedBefore, 0)) out.push(invalid('$.trimmedBefore', 'trimmedBefore must be a nonnegative integer.'));
  for (const key of ['fromSequence', 'toSequence'] as const) if (input[key] !== undefined && !isInteger(input[key], 0)) out.push(invalid(`$.${key}`, `${key} must be a nonnegative integer.`));
  if (input.coalescedViewChanges !== undefined && !isInteger(input.coalescedViewChanges, 0)) out.push(invalid('$.coalescedViewChanges', 'coalescedViewChanges must be a nonnegative integer.'));
  if (input.reviewNotice !== undefined && (typeof input.reviewNotice !== 'string' || codePoints(input.reviewNotice) > LIMITS.label)) out.push(invalid('$.reviewNotice', `reviewNotice must be a string of at most ${LIMITS.label} characters.`));
  const bySequence = new Map<number, string>();
  for (const [list, name] of [[input.events, 'events'], [input.pending, 'pending']] as const) {
    list.forEach((event, index) => {
      const checked = validateRecord(CONTRACTS.event, event);
      if (!checked.ok) { out.push(invalid(`$.${name}[${index}]`, 'The event does not match the interaction event schema.')); return; }
      if (event.activityId !== input.instance.activityId) out.push(invalid(`$.${name}[${index}].activityId`, 'The event belongs to another activity.'));
      const known = bySequence.get(event.sequence);
      if (known !== undefined && known !== event.eventId) out.push(invalid(`$.${name}[${index}].sequence`, 'Two different events carry the same sequence.'));
      bySequence.set(event.sequence, event.eventId);
    });
  }
  return out;
}

/**
 * Builds the summary or reports why it cannot. Limits default to {@link SUMMARY_LIMITS} and can only be lowered;
 * representative configurations and previews are the first, the last and evenly spaced by sequence. Learner and tutor
 * audiences receive only quantities recorded as visible in each event and only parameters recorded as shown controls in
 * that event (`visibleParameters`; an event recorded before that field existed falls back to the template's controls);
 * teacher and host audiences receive every recorded value. The JSON is shrunk (and marked truncated) to fit `bytes`.
 * The summary states the activity's mode; an exploratory one says in a fixed sentence that it is not reviewed content.
 */
export function trySummarize(input: SummaryInput): { ok: true; summary: InteractionSummary } | { ok: false; diagnostics: Diagnostic[] } {
  const problems = checkInput(input);
  if (problems.length) return { ok: false, diagnostics: problems };
  const limits = { ...SUMMARY_LIMITS, ...input.limits };
  const restricted = input.audience === 'learner' || input.audience === 'tutor';
  const controlled = new Set(input.template.controls.map(control => control.parameter));
  /** Parameters a restricted audience may read from one event: template controls the event records as shown. */
  const shownIn = (recorded: unknown): ((key: string) => boolean) => {
    const visible = Array.isArray(recorded) ? new Set(recorded.filter((item): item is string => typeof item === 'string')) : null;
    return key => !restricted || controlled.has(key) && (visible === null || visible.has(key));
  };
  const params = (values: Record<string, number>, recorded?: unknown) => sortKeys(values, shownIn(recorded));
  const observed = (values: unknown) => values && typeof values === 'object' ? sortKeys(values as Record<string, QuantityResult>, key => !restricted || Object.hasOwn(input.manifest.quantities, key)) : {};

  // Known events by sequence; an event present in both lists counts as acknowledged.
  const known = new Map<number, { event: InteractionEvent; acknowledged: boolean }>();
  for (const event of input.events) known.set(event.sequence, { event, acknowledged: true });
  for (const event of input.pending) if (!known.has(event.sequence)) known.set(event.sequence, { event, acknowledged: false });
  const sequences = [...known.keys()].sort((a, b) => a - b);
  const maxKnown = sequences.at(-1) ?? 0, minKnown = sequences[0] ?? 0;
  const to = input.toSequence ?? maxKnown;
  const from = input.fromSequence ?? (to > 0 ? 1 : 0);
  if (from > to) return { ok: false, diagnostics: [invalid('$.fromSequence', 'fromSequence must not exceed toSequence.')] };
  const inRange = sequences.filter(sequence => sequence >= from && sequence <= to).map(sequence => known.get(sequence)!);
  const events = inRange.map(item => item.event);
  const later = sequences.filter(sequence => sequence > to).map(sequence => known.get(sequence)!.event);

  // Missing sequences as [start, end] gaps between held events (bounded by the number of held events, not the range).
  const gaps: [number, number][] = [];
  let expected = Math.max(from, 1);
  for (const { event } of inRange) {
    if (event.sequence > expected) gaps.push([expected, event.sequence - 1]);
    expected = Math.max(expected, event.sequence + 1);
  }
  if (to >= expected) gaps.push([expected, to]);
  const missingCount = gaps.reduce((total, [start, end]) => total + end - start + 1, 0);
  const unacknowledged = inRange.filter(item => !item.acknowledged).map(item => item.event.sequence);
  let ackHigh = 0, firstPending = Infinity;
  for (const { event, acknowledged } of known.values()) {
    if (acknowledged) ackHigh = Math.max(ackHigh, event.sequence); else firstPending = Math.min(firstPending, event.sequence);
  }
  const acknowledgedThrough = Math.max(0, Math.min(to, ackHigh, firstPending - 1));

  // ---- committed configurations ----------------------------------------------------------------
  interface Run { config: Omit<SummaryConfiguration, 'furthestPosition' | 'observations'>; furthest: FramePosition | null; values: { position: FramePosition | null; sequence: number; values: Record<string, QuantityResult> } | null }
  const runs: Run[] = [];
  const latestRun = new Map<string, Run>();
  const observe = (run: Run, position: FramePosition | null, sequence: number, values: unknown) => {
    if (further(position, run.furthest)) run.furthest = structuredClone(position);
    if (values === undefined) return;
    if (!run.values || further(position, run.values.position) || !further(run.values.position, position)) run.values = { position, sequence, values: observed(values) };
  };
  for (const event of events) {
    const body = payload(event);
    if (event.type === 'parameters.committed') {
      const run: Run = { config: { runId: body.runId as string, params: params(body.params as Record<string, number>, body.visibleParameters), cause: body.cause as SummaryConfiguration['cause'], sequence: event.sequence }, furthest: null, values: null };
      runs.push(run);
      latestRun.set(run.config.runId, run);
      observe(run, event.frame?.position ?? null, event.sequence, body.visibleQuantities);
    } else if (event.type === 'position.changed') {
      const run = latestRun.get(body.runId as string);
      if (run) observe(run, body.to as FramePosition, event.sequence, body.visibleQuantities);
    } else if (event.type === 'playback.started' || event.type === 'playback.paused' || event.type === 'playback.ended') {
      const run = latestRun.get(body.runId as string);
      if (run) observe(run, body.position as FramePosition, event.sequence, undefined);
    }
  }

  // ---- previews ----------------------------------------------------------------------------------
  const tracks = new Map<string, Track>();
  const track = (previewId: string, sequence: number): Track => {
    let found = tracks.get(previewId);
    if (!found) { found = { previewId, first: sequence, observed: [], cancelled: false, committed: false }; tracks.set(previewId, found); }
    return found;
  };
  for (const event of events) {
    const body = payload(event);
    if (event.type === 'preview.started') track(body.previewId as string, event.sequence);
    else if (event.type === 'preview.observed') track(body.previewId as string, event.sequence).observed.push(event);
    else if (event.type === 'preview.cancelled' && tracks.has(body.previewId as string)) tracks.get(body.previewId as string)!.cancelled = true;
    else if (event.type === 'parameters.committed' && typeof body.previewId === 'string' && tracks.has(body.previewId)) tracks.get(body.previewId)!.committed = true;
  }
  const endsLater = (previewId: string) => later.some(event => (event.type === 'preview.observed' || event.type === 'preview.cancelled' || event.type === 'parameters.committed') && payload(event).previewId === previewId);
  interface PreviewEntry { preview: Omit<SummaryPreview, 'rendered' | 'omitted'>; rendered: SummaryPreview['rendered']; recordedOmitted: number }
  const previews: PreviewEntry[] = [];
  const interrupted: string[] = [], beyond: string[] = [];
  for (const item of [...tracks.values()].sort((a, b) => a.first - b.first)) {
    const last = item.observed.at(-1);
    let outcome: SummaryPreview['outcome'];
    if (last) outcome = payload(last).outcome as SummaryPreview['outcome'];
    else if (item.cancelled) outcome = 'cancelled';
    else if (item.committed) outcome = 'committed';
    else if (endsLater(item.previewId)) { beyond.push(item.previewId); continue; }
    else outcome = 'interrupted';
    if (outcome === 'interrupted') interrupted.push(item.previewId);
    const rendered = item.observed.flatMap(event => (payload(event).rendered as { params: Record<string, number>; frameId: string }[]).map(sample => ({ params: params(sample.params, payload(event).visibleParameters), frameId: sample.frameId })));
    const recordedOmitted = item.observed.reduce((total, event) => total + (payload(event).omitted as number), 0);
    const policy = last ? clean(payload(last).samplingPolicy as string, 'sampled rendered values') : 'no rendered values recorded';
    previews.push({ preview: { previewId: item.previewId, outcome, samplingPolicy: policy }, rendered, recordedOmitted });
  }

  // ---- exposures ---------------------------------------------------------------------------------
  const records = new Map(input.exposures.map(record => [record.exposureId, record]));
  const revealed = new Map<string, { exposureId: string; groups: string[]; displayStatus: DisplayStatus; sequence: number }>();
  for (const event of events) {
    const body = payload(event);
    if (event.type === 'reveal.authorized' || event.type === 'exposure.scope-authorized') {
      const id = body.exposureId as string;
      if (!revealed.has(id)) revealed.set(id, { exposureId: id, groups: (body.groups as { groupId: string }[]).map(group => group.groupId), displayStatus: 'authorized', sequence: event.sequence });
    } else if (event.type === 'stage.changed' || event.type === 'assistance.recorded' || event.type === 'context.instructional-reopened') {
      for (const record of input.exposures) {
        if (record.receiptId === body.receiptId && !revealed.has(record.exposureId)) revealed.set(record.exposureId, { exposureId: record.exposureId, groups: record.groups.map(group => group.groupId), displayStatus: 'authorized', sequence: event.sequence });
      }
    } else if (event.type === 'reveal.displayed') {
      const entry = revealed.get(body.exposureId as string);
      if (entry) entry.displayStatus = 'displayed';
    } else if (event.type === 'reveal.uncertain') {
      const entry = revealed.get(body.exposureId as string);
      if (entry && entry.displayStatus !== 'displayed') entry.displayStatus = 'uncertain';
    }
  }
  // Through the latest event the current record is authoritative (it carries restore-time uncertainty).
  if (to >= maxKnown) for (const entry of revealed.values()) { const record = records.get(entry.exposureId); if (record) entry.displayStatus = record.displayStatus; }
  const unlinked = from <= Math.max(minKnown, 1) && to >= maxKnown ? input.exposures.filter(record => !revealed.has(record.exposureId)).map(record => record.exposureId) : [];
  const revealedList = [...revealed.values()].sort((a, b) => a.sequence - b.sequence);

  // ---- journal losses ----------------------------------------------------------------------------
  const losses: JournalLoss[] = input.journalLoss ? [input.journalLoss]
    : events.filter(event => event.type === 'operation.failed' && payload(event).lost !== undefined).map(event => payload(event).lost as JournalLoss);

  // ---- comparisons and responses ---------------------------------------------------------------
  const retainedLabel = new Map<string, string>();
  const comparisons: InteractionSummary['comparisons'] = [];
  for (const sequence of sequences) {
    const event = known.get(sequence)!.event, body = payload(event);
    if (event.type === 'comparison.retained') retainedLabel.set(body.runId as string, body.label as string);
    if (sequence < from || sequence > to) continue;
    if (event.type === 'comparison.retained' || event.type === 'comparison.removed') {
      const runId = body.runId as string;
      comparisons.push({ runId, label: clean(retainedLabel.get(runId) ?? runId, clean(`Run ${runId}`, 'Comparison')), action: event.type === 'comparison.retained' ? 'retained' : 'removed', sequence });
    }
  }
  const submitted = new Map<string, number>();
  for (const sequence of sequences) {
    const event = known.get(sequence)!.event;
    if (event.type === 'response.submitted') submitted.set((payload(event).response as ResponseRef).responseId, sequence);
  }
  const responses = input.instance.responses.filter(response => { const at = submitted.get(response.responseId); return at === undefined || at <= to; });

  // ---- assembly with size-driven shrinking -------------------------------------------------------
  const build = (caps: Caps, sized: boolean): InteractionSummary => {
    const configurations = representatives(runs, caps.configurations).map((run): SummaryConfiguration => ({
      runId: run.config.runId, params: run.config.params, furthestPosition: run.furthest, cause: run.config.cause, sequence: run.config.sequence,
      observations: caps.observations ? run.values?.values ?? {} : {},
    }));
    let renderedDropped = 0;
    const previewList = representatives(previews, caps.previews).map((entry): SummaryPreview => {
      const rendered = representatives(entry.rendered, caps.rendered);
      renderedDropped += entry.rendered.length - rendered.length;
      return { ...entry.preview, rendered, omitted: entry.recordedOmitted + entry.rendered.length - rendered.length };
    });
    const revealedShown = representatives(revealedList, caps.revealed);
    const comparisonsShown = representatives(comparisons, caps.comparisons);
    const responsesShown = representatives(responses, caps.responses);
    const omitted = { committedConfigurations: runs.length - configurations.length, previewObservations: previews.length - previewList.length, events: missingCount };
    const observationsDropped = !caps.observations && runs.some(run => run.values && Object.keys(run.values.values).length);

    const limitations: string[] = [];
    const ids = (items: readonly string[]) => listText(items.map(id => clean(id, 'record')));
    if (missingCount) limitations.push(`Events ${rangeText(gaps)} are not held locally${input.trimmedBefore ? ` (${input.trimmedBefore} acknowledged events were trimmed from local history)` : ''}; the host journal holds the full record.`);
    if (unacknowledged.length) limitations.push(`Events ${rangeText(runsOf(unacknowledged))} are not yet acknowledged by the host.`);
    for (const loss of losses) limitations.push(`${plural(loss.count, 'event')}${loss.types.length ? ` (${loss.types.join(', ')})` : ''} after event ${loss.afterSequence} could not be recorded in the journal, so the record is incomplete.`);
    if (input.coalescedViewChanges) limitations.push(`${plural(input.coalescedViewChanges, 'presentation change')} coalesced into later presentation state ${input.coalescedViewChanges === 1 ? 'was' : 'were'} not journaled individually.`);
    if (interrupted.length) limitations.push(`${interrupted.length === 1 ? 'Preview' : 'Previews'} ${ids(interrupted)} ${interrupted.length === 1 ? 'has' : 'have'} no recorded end (interrupted or still active), so the recorded observations are incomplete.`);
    if (beyond.length) limitations.push(`${beyond.length === 1 ? 'Preview' : 'Previews'} ${ids(beyond)} ${beyond.length === 1 ? 'ends' : 'end'} after event ${to}, outside this summary.`);
    if (previews.length) limitations.push('Preview observations are samples of rendered values (first, last and evenly spaced); they do not enumerate every value tried.');
    const uncertain = revealedShown.filter(entry => entry.displayStatus === 'uncertain').map(entry => {
      const reason = records.get(entry.exposureId)?.uncertainty?.code;
      return `${clean(entry.exposureId, 'record')}${reason ? ` (${reason})` : ''}`;
    });
    if (uncertain.length) limitations.push(`${uncertain.length === 1 ? 'Exposure' : 'Exposures'} ${listText(uncertain)} ${uncertain.length === 1 ? 'is' : 'are'} uncertain and counted as potentially seen.`);
    const authorized = revealedShown.filter(entry => entry.displayStatus === 'authorized').map(entry => entry.exposureId);
    if (authorized.length) limitations.push(`${authorized.length === 1 ? 'Exposure' : 'Exposures'} ${ids(authorized)} ${authorized.length === 1 ? 'was' : 'were'} authorized without an acknowledged display and ${authorized.length === 1 ? 'is' : 'are'} counted as potentially seen.`);
    if (unlinked.length) limitations.push(`${unlinked.length === 1 ? 'Exposure record' : 'Exposure records'} ${ids(unlinked)} ${unlinked.length === 1 ? 'has' : 'have'} no authorizing event in the local journal; see the host exposure records.`);
    if (omitted.committedConfigurations) limitations.push(`Showing ${configurations.length} of ${runs.length} committed configurations: the first, the last and evenly spaced by sequence.`);
    if (omitted.previewObservations) limitations.push(`Showing ${previewList.length} of ${previews.length} previews: the first, the last and evenly spaced by sequence.`);
    if (renderedDropped) limitations.push(`${plural(renderedDropped, 'recorded preview sample')} were left out of this summary.`);
    if (observationsDropped) limitations.push('Recorded values were left out of the committed configurations to fit the size limit.');
    if (revealedShown.length < revealedList.length) limitations.push(`Showing ${revealedShown.length} of ${revealedList.length} exposures.`);
    if (comparisonsShown.length < comparisons.length) limitations.push(`Showing ${comparisonsShown.length} of ${comparisons.length} comparison changes.`);
    if (responsesShown.length < responses.length) limitations.push(`Showing ${responsesShown.length} of ${responses.length} host response references.`);
    if (sized) limitations.push(`The summary was reduced to fit the ${limits.bytes}-byte limit.`);
    if (limitations.length > LIMITS.summaryLimitations) limitations.splice(LIMITS.summaryLimitations - 1, Infinity, `${limitations.length - LIMITS.summaryLimitations + 1} further limitations are not listed.`);

    const truncated = omitted.committedConfigurations > 0 || omitted.previewObservations > 0 || renderedDropped > 0 || observationsDropped || sized
      || revealedShown.length < revealedList.length || comparisonsShown.length < comparisons.length || responsesShown.length < responses.length;
    const complete = !missingCount && !unacknowledged.length && !unlinked.length && !truncated && !losses.length;

    // ---- fixed-template text --------------------------------------------------------------------
    const counts = { committed: 0, cancelled: 0, interrupted: 0 };
    for (const entry of previews) counts[entry.preview.outcome]++;
    const groupLabels: string[] = [];
    for (const entry of revealedShown) for (const groupId of entry.groups) {
      const group = input.template.groups.find(candidate => candidate.id === groupId);
      const label = clean(group?.label ?? groupId, clean(groupId, 'a content group'));
      if (!groupLabels.includes(label)) groupLabels.push(label);
    }
    const shownLabels = groupLabels.slice(0, 8);
    const unconfirmed = revealedShown.filter(entry => entry.displayStatus !== 'displayed').length;
    const ref = (value: string, fallback: string) => clean(value, fallback);
    const sentences = [
      to > 0 ? `Summary of events ${from}–${to} for activity ${ref(input.instance.activityId, '(activity)')}, template ${ref(input.instance.template.templateId, '(template)')} ${input.instance.template.version}, model ${ref(input.instance.model.modelId, '(model)')} ${input.instance.model.version}.`
        : `No events are recorded for activity ${ref(input.instance.activityId, '(activity)')}.`,
      input.instance.mode === 'exploratory' ? EXPLORATORY_SUMMARY_SENTENCE : '',
      `Recorded ${plural(runs.length, 'committed configuration')}${omitted.committedConfigurations ? `, of which ${configurations.length} are listed` : ''}.`,
      previews.length ? `Recorded ${plural(previews.length, 'preview')} (${counts.committed} committed, ${counts.cancelled} cancelled, ${counts.interrupted} interrupted); rendered values are samples, not every value tried.` : 'No previews were recorded.',
      revealedList.length ? `Revealed content groups: ${shownLabels.join(', ')}${groupLabels.length > shownLabels.length ? ` and ${groupLabels.length - shownLabels.length} more` : ''}.` : 'No content was revealed in this range.',
      unconfirmed ? `${plural(unconfirmed, 'exposure')} not confirmed as displayed ${unconfirmed === 1 ? 'is' : 'are'} counted as potentially seen.` : '',
      comparisons.length ? `Comparisons: ${comparisons.filter(item => item.action === 'retained').length} retained, ${comparisons.filter(item => item.action === 'removed').length} removed.` : '',
      responses.length ? `Host response references: ${responses.length}.` : '',
      complete ? `The record is complete through event ${to}.` : `The record is incomplete through event ${to}; see the limitations.`,
    ];
    let text = sentences.filter(Boolean).join(' ');
    if (codePoints(text) > LIMITS.text) text = [...text].slice(0, LIMITS.text - 1).join('') + '…';

    return {
      contract: CONTRACTS.summary, schemaVersion: ACTIVITY_SCHEMA_VERSION, summarizerVersion: input.summarizerVersion ?? SUMMARIZER_VERSION,
      activityId: input.instance.activityId, audience: input.audience, template: structuredClone(input.instance.template), model: structuredClone(input.instance.model),
      cursor: { fromSequence: from, toSequence: to, acknowledgedThrough }, complete,
      committedConfigurations: configurations, previewObservations: previewList, revealed: revealedShown.map(entry => ({ ...entry, groups: [...entry.groups] })),
      comparisons: comparisonsShown, responses: structuredClone(responsesShown), omitted, limitations, text,
      mode: input.instance.mode, ...(input.reviewNotice !== undefined ? { reviewNotice: clean(input.reviewNotice, 'Review status is recorded by the host.') } : {}),
    };
  };

  const caps: Caps = {
    configurations: limits.committedConfigurations, previews: limits.previewObservations, rendered: LIMITS.renderedSamples, observations: true,
    revealed: LIMITS.revealed, comparisons: LIMITS.summaryComparisons, responses: LIMITS.responses,
  };
  let summary = build(caps, false);
  // Deterministic shrink order: representative sets, then recorded values, then samples, then reference lists.
  for (let step = 0; bytes(summary) > limits.bytes; step++) {
    if (step > 200) return { ok: false, diagnostics: [{ code: 'RESOURCE_LIMIT', path: '$.limits.bytes', message: `The summary cannot fit within ${limits.bytes} bytes.`, recovery: 'Use a larger byte limit or a narrower sequence range.' }] };
    const halve = (value: number) => Math.floor(value / 2);
    if (caps.configurations > 1 || caps.previews > 1) {
      if (caps.configurations >= caps.previews) caps.configurations = halve(caps.configurations); else caps.previews = halve(caps.previews);
    } else if (caps.observations) caps.observations = false;
    else if (caps.rendered > 2) caps.rendered = halve(caps.rendered);
    else if (Math.max(caps.revealed, caps.comparisons, caps.responses) > 1) {
      const largest = (['responses', 'comparisons', 'revealed'] as const).reduce((best, key) => caps[key] > caps[best] ? key : best, 'responses' as 'responses' | 'comparisons' | 'revealed');
      caps[largest] = halve(caps[largest]);
    } else if (caps.configurations || caps.previews || caps.rendered || caps.revealed || caps.comparisons || caps.responses) {
      caps.configurations = caps.previews = caps.rendered = caps.revealed = caps.comparisons = caps.responses = 0;
    } else return { ok: false, diagnostics: [{ code: 'RESOURCE_LIMIT', path: '$.limits.bytes', message: `The summary cannot fit within ${limits.bytes} bytes.`, recovery: 'Use a larger byte limit or a narrower sequence range.' }] };
    summary = build(caps, true);
  }
  const checked = validateRecord(CONTRACTS.summary, summary);
  if (!checked.ok) return { ok: false, diagnostics: checked.diagnostics };
  return { ok: true, summary };
}

/** {@link trySummarize} that throws {@link SummaryError} instead of returning diagnostics. */
export function summarize(input: SummaryInput): InteractionSummary {
  const result = trySummarize(input);
  if (!result.ok) throw new SummaryError(result.diagnostics);
  return result.summary;
}
