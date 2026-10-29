/**
 * Learner projection (activity-runtime §3, report §6.2, D6): the only object the learner surface, learner-scoped
 * tools, learner snapshots and captures receive. It is built from ONE identified frame (the ready tentative frame of
 * the active preview, otherwise the committed frame) and only from what `computeVisibility` marks visible:
 * - values are read only for members of visible quantity groups; a hidden quantity is never formatted;
 * - a mark is omitted unless its group and every quantity/geometry it binds are readable;
 * - an equation is omitted unless its group and every quantity it substitutes are visible;
 * - tables come from readable geometry (or visible quantities) and are capped at 200 rows (a sampled curve keeps an
 *   evenly spaced subset covering its whole domain, other tables their first and last rows);
 * - template content entries (derivations, assumptions, sources) are never projected;
 * - beside observed data (report §8.5) every data mark, readout and table names its origin (`origin`, and a label
 *   ending “(observed)” or “(model)”); observed rows keep missing cells as `Missing: <reason>` and carry their source;
 * - summaries, terminal text and status messages come from the projection or a fixed vocabulary; a numerical-limit end
 *   is stated only where the projection shows a value or drawn gap at the limit (otherwise only the position's own bound),
 *   and the controller's playback crosses a limit that is not shown (`numericalLimitShown`), so its stop does not tell it;
 * - navigation and playback are content of the template's position groups (`navigationVisibility`);
 * - in an independent context the stage instruction is a fixed neutral sentence, no response prompt and no retained run
 *   is projected.
 * `projectionDigest` is sha256 of the canonical projection without `projectionId`, `status.live` and
 * `presentation.revision`.
 */
import { digest } from '@experiment-kit/core';
import {
  convert, isCompatible, observationGeometryIds, positionMode, unitLabel,
  type FramePosition, type GeometryResult, type ModelFrame, type ModelManifest, type ObservationGeometry, type QuantityResult, type UnitId,
} from '@experiment-kit/core/model';
import type {
  DataOrigin, LearnerProjection, ProjectedAlternative, ProjectedComparison, ProjectedControl, ProjectedControlRef, ProjectedEquation, ProjectedMark, ProjectedNavigation,
  ProjectedPermissions, ProjectedScenario, ProjectedStatus, ProjectedTable, ProjectedValue, ProjectedView, ScientificGuard, UiState,
} from './api.js';
import type { ActivityTemplate, ControlSpec, EquationSpec, MarkSpec, PersistenceStatus, PresentationSnapshot, StageSpec, ViewSpec, Visibility } from './contracts.js';
import { BLOCKED_INSTRUCTION, CLOSED_MESSAGE, HOST_SUSPENDED_MESSAGE, INDEPENDENT_INSTRUCTION, TERMINAL_TEXT, UI_STATUS, VALUE_STATUS_TEXT, viewSummary } from './describe.js';
import { formatNumber, formatQuantity } from './format.js';
import { PLACEHOLDER } from './semantic.js';
import { geometryReadable, markVisible, navigationVisibility, visibleQuantityIds } from './visibility.js';

/** Maximum rendered table rows; longer tables keep the first and last half and report the total. */
export const TABLE_ROW_LIMIT = 200;
/** Significant digits for learner-facing numerals (readouts, substituted equations, comparison values). */
export const DISPLAY_PRECISION = 4;
/**
 * Significant digits for geometry table cells (traces, curves, grids). A cell whose value is a safe integer is written
 * with every digit (236,196, not 236,200).
 */
export const TABLE_PRECISION = 6;

/** Operational state that dominates content-derived UI states (activity-runtime §3, report §10.4). */
export interface OperationalStatus {
  /** A dominating state, in precedence order decided by the controller (disposed, unsupported, stale-policy, …). */
  forced: Extract<UiState, 'preparing' | 'disposed' | 'unsupported' | 'stale-policy' | 'suspended' | 'awaiting-persistence' | 'recoverable-failure'> | null;
  persistence: PersistenceStatus;
  restored: boolean;
  closed: boolean;
  /** Additional fixed-vocabulary notice (for example a visible clamp during a pointer preview). */
  notice?: string | null;
  /** Why a `suspended` activity is paused: the host itself (`host`) or the card not being visible. */
  suspension?: 'host' | 'visibility' | null;
  live?: string | null;
  /** Replaces the state's fixed recovery action (`reload` once worker recovery attempts are used up). */
  recovery?: ProjectedStatus['recovery'];
}

export interface ProjectionInput {
  projectionId: string;
  activityId: string;
  activityRevision: number;
  policyRevision: number;
  template: ActivityTemplate;
  manifest: ModelManifest;
  stage: StageSpec;
  context: 'instructional' | 'independent';
  groups: Readonly<Record<string, Visibility>>;
  controls: Readonly<Record<string, 'interactive' | 'fixed'>>;
  /** The one identified frame behind every representation, or null before the first evaluation. */
  frame: ModelFrame | null;
  frameKind: 'committed' | 'tentative';
  /** Committed canonical parameters (control values); tentative values come from the tentative frame itself. */
  committedParams: Readonly<Record<string, number>> | null;
  guards: ScientificGuard;
  /** Identity of the active tentative preview (no values), so a surface can update, commit or cancel it. */
  preview: { previewId: string; parameter: string } | null;
  playing: boolean;
  activeScenarioId: string | null;
  /** Retained runs, oldest first, each with the identified frame at which it was kept (absent only for legacy input). */
  comparisons: readonly { runId: string; label: string; params: Readonly<Record<string, number>>; position: FramePosition; frame?: ModelFrame | null }[];
  presentation: PresentationSnapshot;
  operational: OperationalStatus;
  reviewNotice: string;
  pendingReveal: LearnerProjection['pendingReveal'];
  /** Host-policy permissions for learner-side outputs (capture); absent means none is granted. */
  permissions?: ProjectedPermissions;
}

const present = (groups: Readonly<Record<string, Visibility>>, id: string): boolean => (groups[id] ?? 'absent') !== 'absent';

const GREEK: Readonly<Record<string, string>> = Object.freeze({
  alpha: 'α', beta: 'β', gamma: 'γ', delta: 'δ', epsilon: 'ε', varepsilon: 'ε', zeta: 'ζ', eta: 'η', theta: 'θ', vartheta: 'ϑ', kappa: 'κ', lambda: 'λ',
  mu: 'μ', nu: 'ν', xi: 'ξ', pi: 'π', rho: 'ρ', sigma: 'σ', tau: 'τ', phi: 'φ', varphi: 'φ', chi: 'χ', psi: 'ψ', omega: 'ω',
  Gamma: 'Γ', Delta: 'Δ', Theta: 'Θ', Lambda: 'Λ', Pi: 'Π', Sigma: 'Σ', Phi: 'Φ', Psi: 'Ψ', Omega: 'Ω', cdot: '·', times: '×', prime: '′',
});
const SUBSCRIPT_DIGITS = '₀₁₂₃₄₅₆₇₈₉';
/**
 * Plain-text form of a manifest's TeX-safe symbol for learner text (`\\eta` → `η`, `m_{11}` → `m₁₁`, `x_0` → `x₀`); a
 * subscript that is not all digits keeps the `_` form the templates' plain text uses (`u_x`). Bounded to 64 characters.
 */
export function plainSymbol(tex: string): string {
  const text = tex.slice(0, 256)
    .replace(/\\([A-Za-z]+)/g, (_, name: string) => GREEK[name] ?? name)
    .replace(/_\{([^{}]*)\}|_([A-Za-z0-9])/g, (_, group: string | undefined, single: string | undefined) => {
      const body = (group ?? single ?? '').trim();
      return /^[0-9]+$/.test(body) ? [...body].map(digit => SUBSCRIPT_DIGITS[Number(digit)]).join('') : `_${body}`;
    })
    .replace(/[{}\\$]/g, '').replace(/\s+/g, ' ').trim();
  return [...text].slice(0, 64).join('');
}

/** Camera limits shared with the learner surface (player `CAMERA_LIMITS`), so both compute the same shown range. */
const CAMERA_ZOOM: readonly [number, number] = [1e-6, 1e6];
const CAMERA_CENTER = 1e15;
/**
 * Range a view currently shows in data units: a 3D view's authored `bounds3`; a 2D view's committed camera applied to its
 * authored bounds (the surface's `cameraDomain`), else the authored bounds. The surface may show more along one axis of
 * an equal-aspect view (it expands to fill the plot), never less.
 */
export function shownRange(view: Pick<ViewSpec, 'id' | 'kind' | 'bounds' | 'bounds3'>, presentation: Pick<PresentationSnapshot, 'views'>): readonly number[] | undefined {
  if (view.kind === 'scene3d') return view.bounds3;
  const bounds = view.bounds;
  if (!bounds) return undefined;
  const camera = presentation.views[view.id]?.camera;
  if (camera?.kind !== '2d') return bounds;
  // Same clamps as the surface's `clampCamera`: a non-finite zoom is 1 and a non-finite centre coordinate is 0.
  const zoom = Number.isFinite(camera.zoom) ? Math.min(CAMERA_ZOOM[1], Math.max(CAMERA_ZOOM[0], camera.zoom)) : 1;
  const [cx, cy] = [0, 1].map(axis => { const c = camera.center[axis]!; return Number.isFinite(c) ? Math.min(CAMERA_CENTER, Math.max(-CAMERA_CENTER, c)) : 0; }) as [number, number];
  const halfX = (bounds[1]! - bounds[0]!) / 2 / zoom, halfY = (bounds[3]! - bounds[2]!) / 2 / zoom;
  return [cx - halfX, cx + halfX, cy - halfY, cy + halfY];
}
/** Views that draw marks (the `undefined` UI state is decided from their marks only). */
const GRAPHICAL_VIEWS: ReadonlySet<ViewSpec['kind']> = new Set(['scene2d', 'plot2d', 'scene3d']);

/** Display unit of a control: the presentation choice when it is one of the control's units, else the first. */
export function controlDisplayUnit(control: ControlSpec, presentation: PresentationSnapshot): UnitId {
  const chosen = presentation.displayUnits[control.parameter];
  return chosen !== undefined && control.displayUnits.includes(chosen) ? chosen : control.displayUnits[0]!;
}
const toDisplay = (value: number, from: UnitId, to: UnitId): number => from === to ? value : convert(value, from, to);

/**
 * Display unit of a quantity (report §8.3): the presentation choice when the template lists it in `quantityDisplay`,
 * else the first listed unit, else the canonical unit. Conversion happens only at this output boundary.
 */
export function quantityDisplayUnit(template: ActivityTemplate, presentation: PresentationSnapshot, quantityId: string, canonical: UnitId): UnitId {
  const declared = template.quantityDisplay && Object.hasOwn(template.quantityDisplay, quantityId) ? template.quantityDisplay[quantityId]!.units : null;
  if (!declared?.length) return canonical;
  const chosen = presentation.displayUnits[quantityId];
  return chosen !== undefined && declared.includes(chosen) ? chosen : declared[0]!;
}
/**
 * Unit label appended to a substituted numeral: only for a quantity whose display unit is selectable (template
 * `quantityDisplay`), so a converted value never reads as the canonical one (θ = 45°, θ = 0.7854 rad).
 */
const substitutionUnit = (template: ActivityTemplate, projected: ProjectedValue): string =>
  projected.status === 'valid' && typeof projected.value !== 'string' && template.quantityDisplay && Object.hasOwn(template.quantityDisplay, projected.quantityId) ? projected.unitLabel : '';

/** Label suffix naming the origin of projected data beside observed data (report §8.5). */
export const ORIGIN_LABEL: Readonly<Record<DataOrigin, string>> = Object.freeze({ observed: ' (observed)', model: ' (model)' });
const sentence = (text: string): string => { const trimmed = text.trim(); return !trimmed ? '' : /[.!?]$/.test(trimmed) ? trimmed : `${trimmed}.`; };
/** Learner-visible source line of observed rows: citation, how they were obtained and the licence when known. */
export function observationSource(geometry: ObservationGeometry): string {
  const { citation, description, license } = geometry.provenance;
  return [`Observed data. Source: ${sentence(citation) || 'not cited.'}`, sentence(description), license ? `Licence: ${sentence(license)}` : ''].filter(Boolean).join(' ').slice(0, 1200);
}

/** Geometry the projection reads under `groups`: geometry bound by shown marks of visible views and the rows of visible tables. */
function shownGeometryIds(template: ActivityTemplate, groups: Readonly<Record<string, Visibility>>): Set<string> {
  const quantities = visibleQuantityIds(template, groups);
  const out = new Set<string>();
  for (const view of template.views) {
    if (!present(groups, view.group)) continue;
    for (const mark of view.marks) if (mark.bindings.geometry !== undefined && markVisible(template, groups, mark, quantities)) out.add(mark.bindings.geometry);
    if (view.kind === 'table' && view.rowsFrom !== undefined && geometryReadable(template, groups, view.rowsFrom, view.group)) out.add(view.rowsFrom);
  }
  return out;
}

/**
 * True when the projection under `groups` shows a numerical limit of `frame` (report §6.2, §8.2): a visible quantity whose
 * status is a numerical limit, or a gap in shown geometry that stops at one (a gap carries the reason of the quantity it
 * stops at). A terminal numerical-limit event is content of exactly the groups that show it.
 */
export function numericalLimitShown(template: ActivityTemplate, groups: Readonly<Record<string, Visibility>>, frame: ModelFrame): boolean {
  for (const id of visibleQuantityIds(template, groups)) if (frame.quantities[id]?.status === 'numerical-limit') return true;
  const limits = Object.values(frame.quantities).filter(result => result.status === 'numerical-limit').map(result => result.reason);
  if (!limits.length) return false;
  const atLimit = (reason: string | undefined): boolean => !!reason && limits.some(text => reason === text || reason.endsWith(text));
  for (const id of shownGeometryIds(template, groups)) {
    const geometry = frame.geometry[id];
    if ((geometry?.kind === 'points2' || geometry?.kind === 'points3') && geometry.points.some(point => point.at === null && atLimit(point.reason))) return true;
    if ((geometry?.kind === 'polyline2' || geometry?.kind === 'polyline3') && geometry.gaps.some(gap => atLimit(gap.reason))) return true;
  }
  return false;
}

type TerminalEvent = NonNullable<ModelFrame['terminal']['event']>;
/**
 * The terminal state a learner channel may state for `frame` (report §6.2, A21): a numerical-limit end only when the
 * projection shows the limit (`limitShown`); otherwise only the position's own bound — the last index or the end time —
 * and only where the position is shown. Anything else reads as not terminal, so the end text never tells a hidden outcome
 * (for example a diverging trace that is not shown) from another.
 */
function learnerTerminal(frame: ModelFrame, limitShown: boolean, positionShown: boolean): { reached: boolean; event?: TerminalEvent } {
  const { reached, event } = frame.terminal;
  if (!reached) return { reached: false };
  if (event === 'numerical-limit' && limitShown) return { reached: true, event };
  if (!positionShown) return { reached: false };
  if (event !== 'numerical-limit') return event ? { reached: true, event } : { reached: true };
  const position = frame.position;
  if (position.kind === 'index' && position.index === position.maxIndex) return { reached: true, event: 'max-index' };
  if (position.kind === 'time' && position.endTime !== null && position.time === position.endTime) return { reached: true, event: 'end-time' };
  return { reached: false };
}

/** Comparison names (report §10.2, A34): parameter differences that are not shown are stated without their values. */
export const COMPARISON_NAMES = Object.freeze({
  same: 'same settings as the current run',
  hiddenOnly: 'settings not shown here differ from the current run',
  hiddenAlso: 'and settings not shown here',
});

/** Builds the learner projection; deterministic for identical input. */
export function projectLearnerView(input: ProjectionInput): LearnerProjection {
  const { template, manifest, groups, frame, presentation } = input;
  const locale = presentation.locale;
  const quantities = visibleQuantityIds(template, groups);
  const valueCache = new Map<string, ProjectedValue>();
  // Observed data beside model output (report §8.5): when the model declares observed geometry, every projected mark,
  // readout and table names its origin in its label, so no channel can present a prediction as data or the reverse.
  const observedGeometry = new Set(observationGeometryIds(manifest));
  const labelled = (label: string, origin: DataOrigin | undefined): string => origin ? `${label}${ORIGIN_LABEL[origin]}` : label;
  const markOrigin = (mark: MarkSpec): DataOrigin | undefined => !observedGeometry.size ? undefined
    : mark.bindings.geometry !== undefined && observedGeometry.has(mark.bindings.geometry) ? 'observed'
      : Object.values(mark.bindings).some(binding => binding !== undefined) ? 'model' : undefined;
  const valueOrigin: DataOrigin | undefined = observedGeometry.size ? 'model' : undefined;
  const categoryLabels = (id: string): Record<string, string> | undefined => {
    const shape = manifest.quantities[id]?.shape;
    return shape?.kind === 'category' ? Object.fromEntries(shape.values.map(value => [value, value.replace(/-/g, ' ')])) : undefined;
  };
  /**
   * Formats a visible quantity of the identified frame in its display unit (`canonical`: in the model unit, for
   * coordinates that position marks in the view's axis units); never called for a hidden quantity.
   */
  const value = (id: string, canonical = false, source: ModelFrame | null = frame): ProjectedValue | null => {
    if (!quantities.has(id) || !source) return null;
    const key = `${source === frame ? '' : `${source.frameId}:`}${canonical ? 'c' : 'd'}:${id}`;
    const cached = valueCache.get(key);
    if (cached) return cached;
    const definition = manifest.quantities[id];
    if (!definition) return null;
    const unit = canonical ? definition.unit : quantityDisplayUnit(template, presentation, id, definition.unit);
    const declared = template.quantityDisplay?.[id]?.units;
    const result: QuantityResult = source.quantities[id] ?? { status: 'undefined', code: 'NOT_EVALUATED', reason: 'This value was not computed for the current frame.' };
    const formatted = formatQuantity(result, { unit: definition.unit, displayUnit: unit, precision: DISPLAY_PRECISION, locale, categoryLabels: categoryLabels(id) });
    const projected: ProjectedValue = {
      quantityId: id, label: labelled(definition.label, valueOrigin), ...(valueOrigin ? { origin: valueOrigin } : {}), ...(definition.symbol !== undefined ? { symbol: definition.symbol } : {}), text: formatted.text,
      status: formatted.status, approximate: formatted.approximate, ...(formatted.value !== undefined ? { value: formatted.value } : {}),
      unit, unitLabel: formatted.unitLabel,
      ...(result.status !== 'valid' ? { reason: result.reason } : formatted.status !== 'valid' ? { reason: formatted.reason! } : result.approximation ? { reason: result.approximation.reason } : {}),
      ...(!canonical && declared && declared.length > 1 ? { displayUnits: [...declared] } : {}),
    };
    valueCache.set(key, projected);
    return projected;
  };

  // ---- marks --------------------------------------------------------------------------------------------------
  const controlRef = (parameter: string | undefined): ProjectedControlRef | null => {
    if (parameter === undefined || input.controls[parameter] !== 'interactive' || !input.stage.allowsPreview) return null;
    const control = template.controls.find(item => item.parameter === parameter);
    const definition = manifest.parameters[parameter];
    if (!control || !definition) return null;
    const unit = controlDisplayUnit(control, presentation);
    return { parameter, min: toDisplay(definition.min, definition.unit, unit), max: toDisplay(definition.max, definition.unit, unit) };
  };
  // What each drawn gap is (report §8.2, A11): the `undefined` UI state names mathematical undefinedness and numerical
  // limits apart. A geometry gap carries only its reason, which is the reason of the frame quantity it stops at, so it is
  // classified by that quantity's status (an unmatched gap counts as undefined). The class sets the status cause, and each
  // mark lists the reasons of its numerical-limit gaps (`limitReasons`) so that renderers word them apart from undefined.
  type GapStatus = 'undefined' | 'numerical-limit';
  const reasonStatus = new Map<ModelFrame, Map<string, GapStatus>>();
  const gapStatus = (reason: string | undefined, source: ModelFrame): GapStatus => {
    let known = reasonStatus.get(source);
    if (!known) {
      known = new Map();
      for (const result of Object.values(source.quantities)) if (result.status !== 'valid' && !known.has(result.reason)) known.set(result.reason, result.status);
      reasonStatus.set(source, known);
    }
    if (reason) for (const [text, status] of known) if (reason === text || reason.endsWith(text)) return status;
    return 'undefined';
  };
  const markStatuses = new Map<ProjectedMark, Set<GapStatus>>();
  const vectorOf = (id: string | undefined, source: ModelFrame | null = frame): { coordinates: number[] | null; reason?: string; status?: GapStatus } | undefined => {
    if (id === undefined) return undefined;
    const projected = value(id, true, source);
    if (!projected) return { coordinates: null, reason: 'Not available.', status: 'undefined' };
    if (projected.status === 'valid' && Array.isArray(projected.value)) return { coordinates: [...projected.value] };
    return { coordinates: null, reason: projected.reason ?? projected.text, status: projected.status === 'numerical-limit' ? 'numerical-limit' : 'undefined' };
  };
  function projectMark(mark: MarkSpec, viewVisibility: Visibility, source: ModelFrame | null = frame): ProjectedMark {
    const markVisibility = groups[mark.group] ?? 'absent';
    const origin = markOrigin(mark);
    const out: ProjectedMark = { markId: mark.id, kind: mark.kind, label: labelled(mark.label, origin), style: { ...mark.style }, interactive: false, ...(origin ? { origin } : {}) };
    if (mark.placement) out.placement = structuredClone(mark.placement);
    if (mark.text !== undefined) out.text = mark.text;
    if (mark.extent !== undefined) out.extent = mark.extent;
    const reasons: string[] = [];
    const statuses = new Set<GapStatus>();
    markStatuses.set(out, statuses);
    const limits = new Set<string>();
    if (mark.bindings.geometry !== undefined && source) {
      const geometry = source.geometry[mark.bindings.geometry];
      if (geometry) {
        out.geometry = geometry;
        const gapReasons = geometry.kind === 'points2' || geometry.kind === 'points3' ? geometry.points.flatMap(point => point.at || !point.reason ? [] : [point.reason])
          : geometry.kind === 'polyline2' || geometry.kind === 'polyline3' ? geometry.gaps.map(gap => gap.reason) : [];
        for (const reason of gapReasons) if (gapStatus(reason, source) === 'numerical-limit') limits.add(reason);
        if ((mark.kind === 'point' || mark.kind === 'label') && (geometry.kind === 'points2' || geometry.kind === 'points3') && geometry.points.length === 1) {
          const point = geometry.points[0]!;
          out.at = point.at ? [...point.at] : null;
          if (!point.at) { reasons.push(point.reason ?? 'Not available.'); statuses.add(gapStatus(point.reason, source)); }
        }
      }
    }
    for (const key of ['at', 'vector', 'from', 'to'] as const) {
      const resolved = vectorOf(mark.bindings[key], source);
      if (!resolved) continue;
      out[key] = resolved.coordinates;
      if (resolved.reason) reasons.push(resolved.reason);
      if (resolved.status) statuses.add(resolved.status);
      if (resolved.reason && resolved.status === 'numerical-limit') limits.add(resolved.reason);
    }
    if (mark.bindings.value !== undefined) {
      const projected = value(mark.bindings.value, false, source);
      if (projected) {
        out.value = projected;
        if (projected.status !== 'valid') { reasons.push(projected.reason ?? projected.text); statuses.add(projected.status); }
        if (projected.status === 'numerical-limit') limits.add(projected.reason ?? projected.text);
      }
    }
    if (reasons.length) out.undefinedReason = reasons[0]!.slice(0, 400);
    if (out.undefinedReason !== undefined && limits.has(reasons[0]!)) limits.add(out.undefinedReason);
    if (limits.size) out.limitReasons = [...limits];
    if (mark.drag) {
      const x = controlRef(mark.drag.x), y = controlRef(mark.drag.y);
      if (x || y) out.draggable = { ...(x ? { x } : {}), ...(y ? { y } : {}) };
    }
    out.interactive = markVisibility === 'interactive' && viewVisibility === 'interactive' && out.draggable !== undefined;
    return out;
  }

  // ---- equations ----------------------------------------------------------------------------------------------
  const texText = (text: string): string => `\\text{${text.replace(/[\\{}$&#^_%~]/g, '')}}`;
  /** TeX for a substituted value: numerals from the projected value only, statuses as escaped text. */
  const texValue = (projected: ProjectedValue): string => {
    // A status reads as one short word in typeset math (its reason is in the plain form, the readouts and the summary),
    // so a long reason never pushes the formula out of its box.
    if (projected.status === 'undefined') return texText('undefined');
    if (projected.status === 'numerical-limit') return texText('beyond numerical range');
    if (projected.value === undefined || typeof projected.value === 'string') return texText(projected.text);
    const numeral = (n: number) => formatNumber(n, { precision: DISPLAY_PRECISION, locale, notation: 'tex' });
    const body = typeof projected.value === 'number' ? numeral(projected.value) : `\\left(${projected.value.map(numeral).join(',\\,')}\\right)`;
    return projected.approximate ? `\\approx ${body}` : body;
  };
  function projectEquation(equation: EquationSpec): ProjectedEquation | null {
    if (!present(groups, equation.group)) return null;
    const ids = new Set([...equation.tex.matchAll(PLACEHOLDER), ...equation.plain.matchAll(PLACEHOLDER)].map(match => match[1]!));
    const values = new Map<string, ProjectedValue>();
    for (const id of ids) { const projected = value(id); if (!projected) return null; values.set(id, projected); }
    // Numerals carry their unit label when it is not a pure number, so a converted value (θ = 45°) is never ambiguous.
    const texUnit = (projected: ProjectedValue): string => {
      const label = substitutionUnit(template, projected);
      return !label ? '' : projected.unit === 'deg' ? '^{\\circ}' : `\\,${texText(label)}`;
    };
    const plainUnit = (projected: ProjectedValue): string => {
      const label = substitutionUnit(template, projected);
      return !label ? '' : projected.unit === 'deg' ? '°' : ` ${label}`;
    };
    const substitute = (source: string, tex: boolean) => source.replace(PLACEHOLDER, (_, id: string) => {
      const projected = values.get(id)!;
      return tex ? `${texValue(projected)}${texUnit(projected)}` : `${projected.text}${plainUnit(projected)}`;
    });
    return { equationId: equation.id, label: equation.label, tex: substitute(equation.tex, true), plain: substitute(equation.plain, false) };
  }

  // ---- tables -------------------------------------------------------------------------------------------------
  const num = (n: number) => formatNumber(n, { precision: DISPLAY_PRECISION, locale });
  /** Table cell numeral: every digit of a safe integer, otherwise {@link TABLE_PRECISION} significant digits. */
  const cell = (n: number) => formatNumber(n, { precision: TABLE_PRECISION, locale, exactIntegers: true });
  /** One row per geometry element; every row has exactly one cell per column of {@link geometryColumns}. */
  function geometryRows(geometry: GeometryResult): { key: string; cells: string[] }[] {
    const coords = (point: readonly number[]) => point.map(cell);
    switch (geometry.kind) {
      case 'points2': case 'points3': {
        const width = geometry.kind === 'points3' ? 3 : 2;
        return geometry.points.map(point => ({
          key: point.id, cells: point.at ? coords(point.at) : [`Not available: ${(point.reason ?? 'no value').slice(0, 200)}`, ...Array<string>(width - 1).fill('Not available')],
        }));
      }
      case 'polyline2': case 'polyline3':
        return geometry.segments.flatMap((segment, s) => (segment.points as readonly (readonly number[])[]).map((point, p) => ({ key: `s${s}p${p}`, cells: coords(point) })));
      case 'segments2': case 'segments3':
        return geometry.segments.map(segment => ({ key: segment.id, cells: [segment.id, ...coords(segment.from), ...coords(segment.to)] }));
      case 'polygon2':
        return geometry.vertices.map((vertex, v) => ({ key: `v${v}`, cells: coords(vertex) }));
      case 'vector-field2': case 'vector-field3':
        return geometry.samples.map((sample, s) => ({ key: `f${s}`, cells: [...coords(sample.at), ...coords(sample.vector)] }));
      case 'surface-grid':
        return geometry.z.map((z, i) => ({ key: `g${i}`, cells: [cell(geometry.xs[i % geometry.xs.length]!), cell(geometry.ys[Math.floor(i / geometry.xs.length)]!), z === null ? 'Not available' : cell(z)] }));
      // Every observed row in dataset order, numbered from 1; a missing cell says so with its reason (never 0, never filled in).
      case 'observations2':
        return geometry.points.map(point => ({
          key: `o${point.row}`, cells: [String(point.row + 1), ...point.values.map(v => v === null ? `Missing: ${(point.reason ?? 'not recorded').slice(0, 200)}` : cell(v))],
        }));
    }
  }
  /**
   * Columns matching {@link geometryRows}: coordinates take the view's axis labels and units; segments add a leading
   * segment ID column and start/end coordinates; vector fields add one component column per axis. Component columns
   * carry no unit label because the geometry contract declares none for vectors.
   */
  function geometryColumns(view: ViewSpec, geometry: GeometryResult): ProjectedTable['columns'] {
    const axis = (key: 'x' | 'y' | 'z') => view.axes?.[key] ? { id: key, label: view.axes[key]!.label, unitLabel: unitLabel(view.axes[key]!.unit) } : { id: key, label: key, unitLabel: '' };
    const keys: ('x' | 'y' | 'z')[] = ['points3', 'polyline3', 'segments3', 'vector-field3', 'surface-grid'].includes(geometry.kind) ? ['x', 'y', 'z'] : ['x', 'y'];
    // Beside observed data, model rows say they are model output.
    const coordinates = keys.map(axis).map(column => observedGeometry.size ? { ...column, label: labelled(column.label, 'model') } : column);
    switch (geometry.kind) {
      case 'observations2': {
        // Observed columns carry the dataset's own labels and canonical units.
        const columns = manifest.observations?.[geometry.dataset]?.columns ?? [];
        const column = (id: string) => { const found = columns.find(item => item.id === id); return { id: `observed-${id}`, label: labelled(found?.label ?? id, 'observed'), unitLabel: found ? unitLabel(found.unit) : '' }; };
        return [{ id: 'observation', label: 'Observation', unitLabel: '' }, column(geometry.columns[0]), column(geometry.columns[1])];
      }
      case 'segments2': case 'segments3':
        return [
          { id: 'segment', label: 'Segment', unitLabel: '' },
          ...coordinates.map(column => ({ ...column, id: `start-${column.id}`, label: `Start ${column.label}` })),
          ...coordinates.map(column => ({ ...column, id: `end-${column.id}`, label: `End ${column.label}` })),
        ];
      case 'vector-field2': case 'vector-field3':
        return [...coordinates, ...coordinates.map(column => ({ id: `vector-${column.id}`, label: `Vector component along ${column.label}`, unitLabel: '' }))];
      default:
        return coordinates;
    }
  }
  /**
   * Caps rows at {@link TABLE_ROW_LIMIT}. A sampled curve keeps every `step`-th sample and the last one (the whole domain
   * stays covered at a coarser spacing); other tables keep the first and last half (start and current end of a trace).
   */
  const capRows = (rows: { key: string; cells: string[] }[], curve = false): Pick<ProjectedTable, 'rows' | 'truncated' | 'totalRows' | 'shortened'> => {
    if (rows.length <= TABLE_ROW_LIMIT) return { rows, truncated: false, totalRows: rows.length };
    if (curve) {
      const step = Math.ceil((rows.length - 1) / (TABLE_ROW_LIMIT - 1));
      const kept = rows.filter((_, index) => index % step === 0 || index === rows.length - 1);
      return { rows: kept, truncated: true, totalRows: rows.length, shortened: { kind: 'every', step } };
    }
    return { rows: [...rows.slice(0, TABLE_ROW_LIMIT / 2), ...rows.slice(rows.length - TABLE_ROW_LIMIT / 2)], truncated: true, totalRows: rows.length, shortened: { kind: 'ends' } };
  };
  function projectTable(view: ViewSpec): ProjectedTable | undefined {
    if (view.kind !== 'table') return undefined;
    if (view.rowsFrom !== undefined) {
      if (!frame || !geometryReadable(template, groups, view.rowsFrom, view.group)) return undefined;
      const geometry = frame.geometry[view.rowsFrom];
      if (!geometry) return undefined;
      const origin: DataOrigin | undefined = geometry.kind === 'observations2' ? 'observed' : observedGeometry.size ? 'model' : undefined;
      return {
        caption: view.title, columns: geometryColumns(view, geometry), ...capRows(geometryRows(geometry), geometry.kind === 'polyline2' || geometry.kind === 'polyline3'),
        ...(origin ? { origin } : {}), ...(geometry.kind === 'observations2' ? { source: observationSource(geometry) } : {}),
      };
    }
    const rows = (view.quantities ?? []).map(id => value(id)).filter((item): item is ProjectedValue => item !== null).map(item => ({ key: item.quantityId, cells: [item.label, item.text, item.status === 'valid' ? item.unitLabel : ''] }));
    return { caption: view.title, columns: [{ id: 'quantity', label: 'Quantity', unitLabel: '' }, { id: 'value', label: 'Value', unitLabel: '' }, { id: 'unit', label: 'Unit', unitLabel: '' }], ...capRows(rows) };
  }

  // ---- views --------------------------------------------------------------------------------------------------
  // Out-of-range data (report §10.2), judged like the surface's plan: the same points (arrow tips and scaled field tips
  // included) against the range the view shows now, with the same relative tolerance. Reference-role marks, `grid`
  // marks and unbounded lines are background and never count.
  const outside = (point: readonly number[] | null | undefined, bounds: readonly number[]): boolean =>
    !!point && point.some((coordinate, axis) => {
      if (axis * 2 + 1 >= bounds.length || !Number.isFinite(coordinate)) return false;
      const lo = bounds[axis * 2]!, hi = bounds[axis * 2 + 1]!, tolerance = 1e-9 * (hi - lo);
      return coordinate < lo - tolerance || coordinate > hi + tolerance;
    });
  const tip = (at: readonly number[], vector: readonly number[], factor = 1): number[] => at.map((c, i) => c + (vector[i] ?? 0) * factor);
  function geometryOutside(geometry: GeometryResult, bounds: readonly number[]): boolean {
    switch (geometry.kind) {
      case 'points2': case 'points3': return geometry.points.some(point => outside(point.at, bounds));
      case 'polyline2': case 'polyline3': return geometry.segments.some(segment => (segment.points as readonly (readonly number[])[]).some(point => outside(point, bounds)));
      case 'segments2': case 'segments3': return geometry.segments.some(segment => outside(segment.from, bounds) || outside(segment.to, bounds));
      case 'polygon2': return geometry.vertices.some(vertex => outside(vertex, bounds));
      case 'vector-field2': case 'vector-field3': return geometry.samples.some(sample => outside(sample.at, bounds) || outside(tip(sample.at, sample.vector, geometry.scale.factor), bounds));
      case 'surface-grid': return geometry.z.some((z, i) => z !== null && outside([geometry.xs[i % geometry.xs.length]!, geometry.ys[Math.floor(i / geometry.xs.length)]!, z], bounds));
      case 'observations2': return geometry.points.some(point => point.values[0] !== null && point.values[1] !== null && outside(point.values as readonly number[], bounds));
      default: return false;
    }
  }
  /** Background marks: never data, so never reported as clipped. */
  const background = (mark: Pick<ProjectedMark, 'kind' | 'style' | 'extent'>): boolean => mark.kind === 'grid' || mark.style.role === 'reference' || mark.extent === 'line';
  function markOutside(mark: ProjectedMark, bounds: readonly number[]): boolean {
    if (background(mark)) return false;
    if (mark.geometry && geometryOutside(mark.geometry, bounds)) return true;
    const tail = mark.from ?? mark.at;
    const head = mark.to ?? (mark.vector ? tip(tail ?? mark.vector.map(() => 0), mark.vector) : null);
    return [mark.at, mark.from, mark.to, head].some(point => outside(point, bounds));
  }
  const views: ProjectedView[] = [];
  /** Visible mark specifications per view (the kept-run overlays of comparisons re-project exactly these). */
  const visibleSpecs = new Map<string, { specs: MarkSpec[]; visibility: Visibility }>();
  for (const view of template.views) {
    const visibility = groups[view.group] ?? 'absent';
    if (visibility === 'absent') continue;
    const specs = view.marks.filter(mark => markVisible(template, groups, mark, quantities));
    visibleSpecs.set(view.id, { specs, visibility });
    const marks = specs.map(mark => projectMark(mark, visibility));
    const values = view.kind === 'values' ? (view.quantities ?? []).map(id => value(id)).filter((item): item is ProjectedValue => item !== null) : [];
    const equationIds = new Set(view.kind === 'equation' ? view.equations ?? [] : []);
    const equations = template.equations.filter(equation => equationIds.has(equation.id)).map(projectEquation).filter((item): item is ProjectedEquation => item !== null);
    const table = projectTable(view);
    const range = GRAPHICAL_VIEWS.has(view.kind) ? shownRange(view, presentation) : undefined;
    const viewClipped = !!range && marks.some(mark => markOutside(mark, range));
    const axes = view.axes ? {
      x: { label: view.axes.x.label, unitLabel: unitLabel(view.axes.x.unit) }, y: { label: view.axes.y.label, unitLabel: unitLabel(view.axes.y.unit) },
      ...(view.axes.z ? { z: { label: view.axes.z.label, unitLabel: unitLabel(view.axes.z.unit) } } : {}),
    } : undefined;
    const projected: Omit<ProjectedView, 'summary'> = {
      viewId: view.id, kind: view.kind, title: view.title, description: view.description, visibility,
      ...(view.bounds ? { bounds: [...view.bounds] as [number, number, number, number] } : {}),
      ...(view.bounds3 ? { bounds3: [...view.bounds3] as [number, number, number, number, number, number] } : {}),
      equalAspect: view.equalAspect, ...(axes ? { axes } : {}), marks, values, equations, ...(table ? { table } : {}), ...(viewClipped ? { clipped: true } : {}),
    };
    views.push({ ...projected, summary: viewSummary(projected) });
  }

  // ---- controls, scenarios, navigation, comparisons, alternatives ---------------------------------------------
  const tentative = input.frameKind === 'tentative' && frame !== null;
  const parameterSymbol = (id: string): string | undefined => { const symbol = manifest.parameters[id]?.symbol; return symbol ? plainSymbol(symbol) || undefined : undefined; };
  const controls: ProjectedControl[] = [];
  for (const control of template.controls) {
    const mode = input.controls[control.parameter];
    const definition = manifest.parameters[control.parameter];
    if (!mode || !definition || !input.committedParams) continue;
    const unit = controlDisplayUnit(control, presentation);
    const committed = input.committedParams[control.parameter]!;
    const projected: ProjectedControl = {
      parameter: control.parameter, label: control.label, description: control.description, mode,
      ...(mode === 'fixed' ? { disabledReason: input.context === 'independent' ? 'This value is fixed during independent work.' : 'This value is fixed in this part of the activity.' } : {}),
      value: toDisplay(committed, definition.unit, unit),
      ...(tentative && frame.params[control.parameter] !== committed ? { previewValue: toDisplay(frame.params[control.parameter]!, definition.unit, unit) } : {}),
      min: toDisplay(definition.min, definition.unit, unit), max: toDisplay(definition.max, definition.unit, unit),
      step: unit === control.displayUnits[0] || !isCompatible(unit, control.displayUnits[0]!) ? control.step : Math.abs(convert(control.step, control.displayUnits[0]!, unit)),
      integer: definition.step.admissible === 'integer', slider: control.slider, exact: control.exact, displayUnit: unit, displayUnits: [...control.displayUnits], unitLabel: unitLabel(unit),
      ...(parameterSymbol(control.parameter) ? { symbol: parameterSymbol(control.parameter) } : {}),
      ...(control.section ? { section: { id: control.section.id, label: control.section.label } } : {}),
    };
    controls.push(projected);
  }
  const scenarios: ProjectedScenario[] = template.scenarios.filter(scenario => present(groups, scenario.group)).map(scenario => ({
    scenarioId: scenario.id, label: scenario.label, description: scenario.description,
    active: input.activeScenarioId === scenario.id && !!input.committedParams && Object.entries(scenario.parameters).every(([id, v]) => input.committedParams![id] === v),
  }));
  const mode = positionMode(manifest);
  let navigation: ProjectedNavigation | null = null;
  // A blocked activity (stale policy, unsupported content) shows nothing to navigate (report §10.4): no navigation.
  const navigable = input.operational.forced !== 'stale-policy' && input.operational.forced !== 'unsupported';
  // Navigation and playback are content of the groups that carry the position (activity-runtime §3): in an independent
  // context they remain only when the neutral scaffold keeps such a group, and a fixed group shows the position only.
  const navigationMode = navigationVisibility(template, manifest, groups, input.context);
  const positionShown = !!frame && navigable && mode !== 'static' && (input.stage.allowsNavigation || input.stage.allowsPlayback) && navigationMode !== 'absent';
  // The end of the run as the learner may see it: a numerical limit only where the projection shows it (report §6.2).
  const terminal = frame ? learnerTerminal(frame, numericalLimitShown(template, groups, frame), positionShown) : { reached: false };
  if (frame && positionShown) {
    const position = frame.position;
    const current = position.kind === 'index' ? position.index : position.kind === 'time' ? position.time : 0;
    const max = position.kind === 'index' ? position.maxIndex : position.kind === 'time' ? position.endTime : null;
    const steps = input.stage.allowsNavigation && navigationMode === 'interactive' && !tentative;
    navigation = {
      kind: mode as ProjectedNavigation['kind'], value: current, max, terminal: terminal.reached,
      canStepBack: steps && current > 0, canStepForward: steps && !terminal.reached,
      playing: input.playing, allowsPlayback: input.stage.allowsPlayback && navigationMode === 'interactive', interpolated: false,
    };
  }
  // Retained runs belong to instructional work: an independent context shows none of them (report §6.4, A25).
  const comparisons = input.context === 'independent' ? [] : projectComparisons();
  const alternatives: ProjectedAlternative[] = template.alternatives.filter(alternative => present(groups, alternative.group)).map(alternative => ({
    alternativeId: alternative.id, kind: alternative.kind, label: alternative.label, description: alternative.description, equivalence: alternative.equivalence,
  }));

  /**
   * Retained runs (report §8.4, §10.2): parameter differences by symbol, how the runs line up, each run's own domain
   * boundary, and the kept run's values, aligned observations and drawn data, all from the kept run's identified frame
   * under the current visibility (a hidden quantity or mark of the current run is hidden for the kept run too).
   */
  function projectComparisons(): ProjectedComparison[] {
    const controlByParameter = new Map(template.controls.map(control => [control.parameter, control]));
    const alignment: ProjectedComparison['alignment'] = mode === 'index' ? 'index' : mode === 'time' ? 'time' : 'static';
    const positionText = (position: FramePosition): string | null =>
      position.kind === 'index' ? `n = ${position.index}` : position.kind === 'time' ? `t = ${num(position.time)}` : null;
    const domainNote = alignment === 'index'
      ? 'Aligned by iteration index n: plots against n show both runs at the same n. Each run keeps its own range of steps.'
      : alignment === 'time' ? 'Aligned by time: both runs are shown at the same time. Each run keeps its own time domain.'
        : 'Both runs are single states with no steps or time, so they are compared as they are.';
    const indexAxis = new Set(template.views.filter(view => view.axes?.x.unit === 'iteration').map(view => view.id));
    const currentValues = new Map<string, ProjectedValue>();
    for (const view of views) for (const item of view.values) if (!currentValues.has(item.quantityId)) currentValues.set(item.quantityId, item);
    const located = (mark: ProjectedMark | undefined, n: number): { at: number[] | null; reason?: string } | undefined => {
      if (mark?.geometry?.kind !== 'points2') return undefined;
      const match = mark.geometry.points.find(point => point.at ? point.at[0] === n : point.id === `n${n}`);
      return match ? { at: match.at ? [...match.at] : null, ...(match.reason ? { reason: match.reason } : {}) } : undefined;
    };
    const sameDrawing = (a: ProjectedMark, b: ProjectedMark | undefined): boolean =>
      !!b && JSON.stringify([a.geometry, a.at, a.from, a.to, a.vector]) === JSON.stringify([b.geometry, b.at, b.from, b.to, b.vector]);
    return input.comparisons.map((comparison, index) => {
      const kept = comparison.frame ?? null;
      // Every differing parameter counts (report §10.2, A34); only shown controls are named with their values, and any
      // other difference is stated without them, so a kept run is never called the same when it is not.
      const differing = Object.keys(comparison.params).filter(id => input.committedParams && comparison.params[id] !== input.committedParams[id]);
      const hiddenDifferences = differing.some(id => !input.controls[id] || !controlByParameter.has(id) || !manifest.parameters[id]);
      const parameterDifferences = differing.filter(id => input.controls[id] && controlByParameter.has(id) && manifest.parameters[id]).map(id => {
        const control = controlByParameter.get(id)!, definition = manifest.parameters[id]!, unit = controlDisplayUnit(control, presentation);
        const label = unitLabel(unit);
        const shown = (canonical: number) => `${num(toDisplay(canonical, definition.unit, unit))}${!label ? '' : unit === 'deg' ? '°' : ` ${label}`}`;
        const symbol = parameterSymbol(id);
        return { parameter: id, label: control.label, ...(symbol ? { symbol } : {}), text: shown(comparison.params[id]!), currentText: shown(input.committedParams![id]!) };
      });
      const named = parameterDifferences.map(diff => `${diff.symbol ?? diff.label} = ${diff.text}`).join(', ');
      const shortened = [...named].length > 160 ? `${[...named].slice(0, 159).join('')}…` : named;
      const name = !named ? (hiddenDifferences ? COMPARISON_NAMES.hiddenOnly : COMPARISON_NAMES.same) : hiddenDifferences ? `${shortened}, ${COMPARISON_NAMES.hiddenAlso}`
        : [...named].length > 200 ? `${[...named].slice(0, 199).join('')}…` : named;
      const position = kept ? structuredClone(kept.position) : structuredClone(comparison.position);
      // Each run's own domain: a terminal event of the kept run, or the step/time it was kept at when the current run
      // has moved past it (the kept run is never computed further). The kept run's end is stated like the current
      // run's: a numerical limit only where the projection shows it.
      let boundary: string | null = null;
      const keptEnd = kept ? learnerTerminal(kept, numericalLimitShown(template, groups, kept), positionShown) : { reached: false };
      if (kept && keptEnd.reached && keptEnd.event) {
        const last = keptEnd.event !== 'numerical-limit' ? undefined : [...quantities].map(id => kept.quantities[id]).find((result): result is Extract<QuantityResult, { status: 'numerical-limit' }> =>
          result?.status === 'numerical-limit' && typeof result.lastFiniteIndex === 'number');
        boundary = `The kept run ends at ${positionText(kept.position) ?? 'its last state'}: ${TERMINAL_TEXT[keptEnd.event]}${last ? ` Its last finite value is at n = ${last.lastFiniteIndex}.` : ''}`;
      } else if (frame && kept && (frame.position.kind === 'index' && kept.position.kind === 'index' && frame.position.index > kept.position.index
        || frame.position.kind === 'time' && kept.position.kind === 'time' && frame.position.time > kept.position.time)) {
        boundary = `The kept run was kept at ${positionText(kept.position)} and is not computed beyond it.`;
      }
      // Values that differ (the current run at its position, the kept run at its own).
      const values: ProjectedComparison['values'] = [];
      let sameValues = 0;
      if (kept) for (const [id, current] of currentValues) {
        const keptValue = value(id, false, kept);
        if (!keptValue) continue;
        if (keptValue.text === current.text && keptValue.status === current.status) sameValues++;
        else values.push({ quantityId: id, label: current.label, current, kept: keptValue });
      }
      // The kept run's version of each visible data mark that differs from the current drawing (2D views only).
      const overlays: ProjectedComparison['overlays'] = [];
      const aligned: ProjectedComparison['aligned'] = [];
      if (kept) for (const view of views) {
        if (view.kind !== 'plot2d' && view.kind !== 'scene2d') continue;
        const entry = visibleSpecs.get(view.viewId);
        if (!entry) continue;
        const marks: ProjectedMark[] = [];
        for (const spec of entry.specs) {
          if (spec.kind === 'grid' || spec.kind === 'label' || spec.kind === 'angle' || spec.style.role === 'reference' || spec.style.role === 'muted' || spec.extent === 'line') continue;
          const projected = projectMark(spec, entry.visibility, kept);
          const { text: _text, placement: _placement, draggable: _draggable, ...rest } = projected;
          const overlay: ProjectedMark = { ...rest, interactive: false };
          const currentMark = view.marks.find(mark => mark.markId === spec.id);
          if (!sameDrawing(overlay, currentMark)) marks.push(overlay);
          // Same-n observations in plots against the iteration index.
          if (indexAxis.has(view.viewId) && frame?.position.kind === 'index') {
            const n = frame.position.index;
            const keptPoint = located(overlay, n), currentPoint = located(currentMark, n);
            if (keptPoint === undefined && currentPoint === undefined) continue;
            const text = (point: { at: number[] | null } | undefined) => point?.at && Number.isFinite(point.at[1]) ? num(point.at[1]!) : null;
            const reason = keptPoint?.at ? undefined : keptPoint?.reason
              ?? (kept.position.kind === 'index' && kept.position.index < n ? `The kept run was kept at n = ${kept.position.index} and is not computed beyond it.` : `The kept run has no value at n = ${n}.`);
            aligned.push({ viewId: view.viewId, label: view.axes?.y.label ?? spec.label, at: n, current: text(currentPoint), kept: text(keptPoint), ...(reason ? { reason: reason.slice(0, 400) } : {}) });
          }
        }
        if (marks.length) overlays.push({ viewId: view.viewId, marks });
      }
      return {
        runId: comparison.runId, label: comparison.label, ordinal: index + 1, name, parameterDifferences, ...(hiddenDifferences ? { hiddenDifferences: true as const } : {}), alignment, domainNote,
        frameId: kept?.frameId ?? null, position, positionText: positionText(position), boundary, values, sameValues, aligned, overlays,
      };
    });
  }

  // ---- status -------------------------------------------------------------------------------------------------
  // The `undefined` state is raised only when the drawing itself is affected: a visible scene/plot mark whose bound
  // quantity or primary geometry has no value. A value that is legitimately conditional and appears only in readouts or
  // tables (for example the collapse direction of a full-rank matrix) is shown inline with its reason instead.
  const drawnGaps = new Set<'undefined' | 'numerical-limit'>();
  for (const view of views) if (GRAPHICAL_VIEWS.has(view.kind)) for (const mark of view.marks) {
    if (mark.undefinedReason === undefined && (mark.value?.status === undefined || mark.value.status === 'valid')) continue;
    const found = markStatuses.get(mark);
    if (found?.size) for (const status of found) drawnGaps.add(status); else drawnGaps.add('undefined');
  }
  const undefinedShown = drawnGaps.size > 0;
  const cause: NonNullable<ProjectedStatus['cause']> = drawnGaps.size > 1 ? 'mixed' : drawnGaps.has('numerical-limit') ? 'numerical-limit' : 'undefined';
  const op = input.operational;
  const blocked = op.forced === 'stale-policy' || op.forced === 'unsupported' ? op.forced : null;
  const ui: UiState = op.forced ?? (tentative ? 'tentative-preview' : input.playing ? 'playing' : op.closed || !views.length ? 'empty' : op.restored ? 'restored'
    : terminal.reached && navigation ? 'boundary' : undefinedShown ? 'undefined' : views.some(view => view.clipped) ? 'clipped'
      : navigation?.allowsPlayback && navigation.value > 0 ? 'paused' : 'ready');
  const fixed = UI_STATUS[ui];
  const message = op.closed && ui === 'empty' ? CLOSED_MESSAGE : ui === 'boundary' && terminal.event ? TERMINAL_TEXT[terminal.event]
    : ui === 'suspended' && op.suspension === 'host' ? HOST_SUSPENDED_MESSAGE : ui === 'undefined' ? VALUE_STATUS_TEXT[cause] : fixed.message;
  // The cause says what the message says (activity-runtime §3): the drawn values' class in the `undefined` state, and
  // `numerical-limit` at a numerical-limit end, whose message states that limit (only when the projection shows it).
  const statusCause: ProjectedStatus['cause'] | null = ui === 'undefined' ? cause : ui === 'boundary' && terminal.event === 'numerical-limit' ? 'numerical-limit' : null;
  const status: ProjectedStatus = {
    ui, message: op.notice ? `${message ? `${message} ` : ''}${op.notice}` : message, recovery: op.recovery !== undefined ? op.recovery && { ...op.recovery } : fixed.recovery ? { ...fixed.recovery } : null,
    persistence: op.persistence, live: op.live ?? null, ...(statusCause ? { cause: statusCause } : {}),
  };

  // The presentation state a learner channel receives (report §6.2): cameras and layers of visible views only, display
  // units of shown controls and visible quantities only, and a selection only when its target is shown. The controller
  // keeps the full snapshot for restore; nothing here names a hidden view, mark, control or quantity.
  const shownViews = new Set(views.map(view => view.viewId));
  const shownControls = new Set(controls.map(control => control.parameter));
  const selectable = new Set<string>([...shownViews, ...shownControls, ...quantities, ...views.flatMap(view => view.marks.map(mark => mark.markId))]);
  const learnerPresentation: PresentationSnapshot = {
    ...structuredClone(presentation),
    views: Object.fromEntries(Object.entries(presentation.views).filter(([viewId]) => shownViews.has(viewId)).map(([viewId, view]) => [viewId, structuredClone(view)])),
    displayUnits: Object.fromEntries(Object.entries(presentation.displayUnits).filter(([id]) => shownControls.has(id) || quantities.has(id))),
    selection: presentation.selection !== null && selectable.has(presentation.selection) ? presentation.selection : null,
  };

  const projection: LearnerProjection = {
    projectionId: input.projectionId, projectionDigest: '', activityId: input.activityId, activityRevision: input.activityRevision, policyRevision: input.policyRevision,
    presentationRevision: presentation.revision, guards: { ...input.guards }, preview: input.preview ? { ...input.preview } : null, title: template.title,
    // A stale policy or unsupported content blocks the activity (report §5.3, §10.4): a fixed neutral instruction, no
    // response prompt. In an independent context the teaching stage's instruction and response prompt are instructional
    // output: the host owns the independent task's prompt, so the card shows only a fixed neutral instruction.
    stage: blocked ? { id: input.stage.id, kind: input.stage.kind, instruction: BLOCKED_INSTRUCTION[blocked] }
      : input.context === 'independent' ? { id: input.stage.id, kind: input.stage.kind, instruction: INDEPENDENT_INSTRUCTION }
      : { id: input.stage.id, kind: input.stage.kind, instruction: input.stage.instruction, ...(input.stage.response ? { response: { kind: input.stage.response.kind, prompt: input.stage.response.prompt } } : {}) },
    context: input.context,
    frame: frame ? {
      frameId: frame.frameId, kind: tentative ? 'tentative' : 'committed', position: structuredClone(frame.position), terminal: terminal.reached,
      ...(terminal.reached && terminal.event ? { terminalDetail: TERMINAL_TEXT[terminal.event] } : {}),
    } : null,
    views, controls, scenarios, navigation, comparisons, alternatives, presentation: learnerPresentation, status, reviewNotice: input.reviewNotice,
    // A blocked activity promises nothing: a pending reveal is not presented until the host re-authorizes the activity.
    pendingReveal: input.pendingReveal && !blocked ? { labels: [...input.pendingReveal.labels], state: input.pendingReveal.state } : null,
    permissions: { capture: input.permissions?.capture === true },
  };
  projection.projectionDigest = projectionDigest(projection);
  return projection;
}

/** sha256 of the canonical projection without `projectionId`, `projectionDigest`, `status.live` and `presentation.revision`. */
export function projectionDigest(projection: LearnerProjection): string {
  const { projectionId: _id, projectionDigest: _digest, status, presentation, ...rest } = projection;
  const { live: _live, ...stable } = status;
  const { revision: _revision, ...view } = presentation;
  return digest({ ...rest, status: stable, presentation: view });
}

/** Visible group IDs of a projection input (recorded with each published projection for display acknowledgement). */
export const visibleGroupIds = (groups: Readonly<Record<string, Visibility>>): string[] => Object.keys(groups).filter(id => present(groups, id)).sort();
