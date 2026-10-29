/**
 * Semantic validation of schema-valid records: cross-references, kinds, units, disclosure and integrity. Run after
 * `validateRecord`. Authored scenario values are checked with core's admissibility and coupled-constraint rules (the
 * ones every runtime entry point applies), so a scenario that validates here is never rejected when applied.
 * Diagnostics name IDs and fields only; they never quote learner text, TeX or hidden values.
 */
import { canonicalJSON, sha256 } from '@experiment-kit/core';
import { checkParameters, geometryCoordinates, isAdmissible, isCompatible, modelIdentity, type GeometryCoordinates, type GeometryKind, type ModelManifest, type QuantityShape, type UnitId } from '@experiment-kit/core/model';
import type { ActivityArtifact, ActivityInstance, ActivityTemplate, Diagnostic, DiagnosticCode, EquationSpec, GroupKind, HostPolicy, MarkKind, MarkSpec, StageSpec } from './contracts.js';
import { ACTIVITY_SCHEMA_VERSION, CONTRACTS } from './contracts.js';
import { capabilityDiagnostics } from './capabilities.js';
import { INTEGRITY_FIELDS, memberIds, templateDigest } from './identity.js';

/** Geometry kinds each mark kind can draw. */
export const MARK_GEOMETRY: Readonly<Record<MarkKind, readonly GeometryKind[]>> = Object.freeze({
  // Observed data (`observations2`) are drawn only as unconnected points: no mark kind joins, interpolates or fits them.
  curve: ['polyline2', 'polyline3'], trace: ['polyline2', 'polyline3', 'points2', 'points3'], points: ['points2', 'points3', 'observations2'], point: ['points2', 'points3'],
  segments: ['segments2', 'segments3'], segment: ['segments2', 'segments3'], polygon: ['polygon2'], region: ['polygon2'], surface: ['surface-grid'],
  grid: ['surface-grid'], 'vector-field': ['vector-field2', 'vector-field3'], label: ['points2', 'points3'], arrow: [], angle: [], bar: [],
});
/** Spatial dimensionality of each geometry kind; a surface grid can be drawn in 2D (heat map) or 3D. */
const GEOMETRY_DIMS: Readonly<Record<GeometryKind, 2 | 3 | null>> = {
  polyline2: 2, points2: 2, segments2: 2, polygon2: 2, 'vector-field2': 2, polyline3: 3, points3: 3, segments3: 3, 'vector-field3': 3, 'surface-grid': null,
  observations2: 2,
};
type BindingKey = keyof MarkSpec['bindings'];
/** Alternative minimal binding sets per mark kind (any one set must be complete). */
const REQUIRED_BINDINGS: Readonly<Record<MarkKind, readonly (readonly BindingKey[])[]>> = {
  curve: [['geometry']], trace: [['geometry']], points: [['geometry']], segments: [['geometry']], surface: [['geometry']], grid: [['geometry']],
  'vector-field': [['geometry']], point: [['at'], ['geometry']], arrow: [['vector'], ['from', 'to']], segment: [['from', 'to'], ['geometry']],
  polygon: [['vertices'], ['geometry']], region: [['vertices'], ['geometry']], angle: [['value']], bar: [['value']], label: [],
};
const shapeFits = (key: Exclude<BindingKey, 'geometry'>, shape: QuantityShape, dims: 2 | 3): boolean =>
  key === 'value' ? shape.kind === 'scalar' || shape.kind === 'category'
    : key === 'vertices' ? shape.kind === 'matrix' && shape.columns === dims
      : shape.kind === 'vector' && shape.length === dims;

const GROUP_KINDS: readonly GroupKind[] = ['view', 'mark', 'quantity', 'equation', 'dataset', 'control', 'annotation', 'alternative'];
/** Placeholders substituted with formatted numerals of visible quantities only. */
export const PLACEHOLDER = /\{\{q:([A-Za-z0-9_.:-]{1,128})\}\}/g;
const PLACEHOLDER_START = /\{\{q:/g;
/** TeX commands that define macros, load resources or emit HTML; rejected even though KaTeX runs with trust:false. */
const FORBIDDEN_TEX = /\\(?:def|edef|gdef|xdef|let|futurelet|newcommand|renewcommand|providecommand|DeclareMathOperator|href|url|includegraphics|html[A-Za-z]*|input|include|write|immediate|catcode|csname)(?![A-Za-z])/;
const codePoints = (value: string): number => { let count = 0; for (const _ of value) count++; return count; };
const q = (id: string): string => JSON.stringify(id);
const sameJSON = (a: unknown, b: unknown): boolean => canonicalJSON(a) === canonicalJSON(b);
const hash = (value: unknown): string => 'sha256:' + sha256(canonicalJSON(value));

class Collector {
  readonly items: Diagnostic[] = [];
  add(code: DiagnosticCode, path: string, message: string, recovery?: string): void { this.items.push({ code, path, message, ...(recovery ? { recovery } : {}) }); }
  unique(ids: readonly string[], path: (index: number) => string, what: string): void {
    const seen = new Set<string>();
    ids.forEach((id, index) => { if (seen.has(id)) this.add('DUPLICATE_ID', path(index), `Duplicate ${what} ${q(id)}.`, `Give every ${what} a distinct ID.`); seen.add(id); });
  }
}

/** Parses a contract timestamp to epoch milliseconds (sub-millisecond digits are truncated). */
export function timestampMs(value: string): number {
  const match = /^([0-9]{4})-([0-9]{2})-([0-9]{2})T([0-9]{2}):([0-9]{2}):([0-9]{2})(?:[.]([0-9]{1,9}))?(Z|([+-])([0-9]{2}):([0-9]{2}))$/.exec(value);
  if (!match) return Number.NaN;
  const [, y, mo, d, h, mi, s, fraction = '', zone, sign, oh = '0', om = '0'] = match;
  const offset = zone === 'Z' ? 0 : (sign === '-' ? -1 : 1) * (Number(oh) * 60 + Number(om)) * 60_000;
  return Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s), Number(fraction.padEnd(3, '0').slice(0, 3))) - offset;
}

// ---------------------------------------------------------------------------------------------
// Template
// ---------------------------------------------------------------------------------------------
export function validateTemplateSemantics(template: ActivityTemplate, manifest: ModelManifest): Diagnostic[] {
  const out = new Collector();
  if (template.model.modelId !== manifest.modelId || template.model.version !== manifest.version)
    out.add('INVALID_REFERENCE', '$.model', 'The template model reference does not match the manifest identity.', 'Reference the installed manifest by its exact model ID and version.');
  else if (template.model.digest !== modelIdentity(manifest).digest)
    out.add('INVALID_REFERENCE', '$.model.digest', 'The template model digest differs from the exact digest of the manifest.', 'Recompute the model reference from the manifest (modelIdentity(manifest).digest).');
  if (template.dimension === '3d' && !template.views.some(view => view.kind === 'scene3d'))
    out.add('KIND_MISMATCH', '$.dimension', 'A 3d template needs at least one scene3d view.');
  // Required capabilities and the spatial-3d@1.0 limits (capabilities.ts, report §13).
  out.items.push(...capabilityDiagnostics(template, manifest));

  const marks = template.views.flatMap((view, v) => view.marks.map((mark, m) => ({ mark, path: `$.views[${v}].marks[${m}]` })));
  out.unique(template.groups.map(group => group.id), i => `$.groups[${i}].id`, 'group');
  out.unique(template.views.map(view => view.id), i => `$.views[${i}].id`, 'view');
  out.unique(marks.map(entry => entry.mark.id), i => `${marks[i]!.path}.id`, 'mark');
  out.unique(template.equations.map(equation => equation.id), i => `$.equations[${i}].id`, 'equation');
  out.unique(template.controls.map(control => control.parameter), i => `$.controls[${i}].parameter`, 'control parameter');
  out.unique(template.scenarios.map(scenario => scenario.id), i => `$.scenarios[${i}].id`, 'scenario');
  out.unique(template.stages.map(stage => stage.id), i => `$.stages[${i}].id`, 'stage');
  out.unique(template.transitions.map(transition => transition.id), i => `$.transitions[${i}].id`, 'transition');
  out.unique(template.alternatives.map(alternative => alternative.id), i => `$.alternatives[${i}].id`, 'alternative');
  out.unique(template.taskFamilies.map(family => family.id), i => `$.taskFamilies[${i}].id`, 'task family');
  out.unique(template.content.map(entry => entry.id), i => `$.content[${i}].id`, 'content reference');

  const groups = new Map(template.groups.map(group => [group.id, group]));
  const available = memberIds(template, manifest);
  template.groups.forEach((group, g) => {
    out.unique(group.members, i => `$.groups[${g}].members[${i}]`, 'group member');
    group.members.forEach((member, m) => {
      if (available[group.kind].has(member)) return;
      const actual = GROUP_KINDS.find(kind => available[kind].has(member));
      if (actual) out.add('KIND_MISMATCH', `$.groups[${g}].members[${m}]`, `Member ${q(member)} is a ${actual}, not a ${group.kind}.`, 'Move the member to a group of its own kind.');
      else out.add('INVALID_REFERENCE', `$.groups[${g}].members[${m}]`, `Member ${q(member)} does not exist in the template or manifest.`);
    });
  });
  const groupExists = (id: string, path: string): void => { if (!groups.has(id)) out.add('INVALID_REFERENCE', path, `Group ${q(id)} does not exist.`, 'Declare the group in `groups`.'); };

  const parameters = manifest.parameters, quantities = manifest.quantities, geometry = manifest.geometry;
  const controls = new Map(template.controls.map(control => [control.parameter, control]));
  const spatial = (kind: string): boolean => kind === 'scene2d' || kind === 'plot2d' || kind === 'scene3d';

  template.views.forEach((view, v) => {
    const at = `$.views[${v}]`;
    const dims: 2 | 3 = view.kind === 'scene3d' ? 3 : 2;
    groupExists(view.group, `${at}.group`);
    if (view.kind === 'scene3d' && template.dimension !== '3d') out.add('KIND_MISMATCH', `${at}.kind`, 'A scene3d view requires a 3d template.');
    if (spatial(view.kind)) {
      const key = dims === 3 ? 'bounds3' : 'bounds';
      const bounds = dims === 3 ? view.bounds3 : view.bounds;
      if (!bounds) out.add('INVALID_INPUT', `${at}.${key}`, `A ${view.kind} view needs authored ${key}.`, 'Author teaching bounds in canonical model units.');
      else for (let i = 0; i < bounds.length; i += 2) if (!(bounds[i]! < bounds[i + 1]!)) out.add('INVALID_INPUT', `${at}.${key}[${i}]`, 'Each bound minimum must be below its maximum.');
    } else if (view.marks.length) out.add('KIND_MISMATCH', `${at}.marks`, `A ${view.kind} view cannot contain marks.`);
    if (view.axes) {
      // Report §8.3, A10, A34: an axis title names the unit of the numbers drawn along it. Bounds, ticks, coordinates
      // and table cells are canonical model values and are never converted, so the axis unit must equal the canonical
      // unit of everything the view draws along it — not merely share its dimension.
      const reported = { x: new Set<string>(), y: new Set<string>(), z: new Set<string>() };
      for (const axis of ['x', 'y', 'z'] as const) {
        const spec = view.axes[axis];
        if (!spec) continue;
        if (axis === 'z' && dims !== 3) out.add('KIND_MISMATCH', `${at}.axes.z`, 'Only scene3d views have a z axis.');
        if (spec.quantity === undefined) continue;
        const definition = quantities[spec.quantity];
        if (!definition) out.add('INVALID_REFERENCE', `${at}.axes.${axis}.quantity`, `Quantity ${q(spec.quantity)} does not exist.`);
        else if (spec.unit !== definition.unit) {
          reported[axis].add(definition.unit);
          out.add('UNIT_MISMATCH', `${at}.axes.${axis}.unit`, `Axis unit ${spec.unit} is not the canonical unit ${definition.unit} of quantity ${q(spec.quantity)}; axis values are never converted.`, 'Use the quantity\'s canonical unit for the axis.');
        }
      }
      const drawn: { what: string; units: GeometryCoordinates }[] = [];
      const everywhere = (unit: UnitId): GeometryCoordinates => ({ x: unit, y: unit, z: unit });
      for (const mark of view.marks) {
        const coordinates = mark.bindings.geometry === undefined ? null : geometryCoordinates(manifest, mark.bindings.geometry);
        if (coordinates) drawn.push({ what: `geometry ${q(mark.bindings.geometry!)}`, units: coordinates });
        for (const key of ['at', 'vector', 'from', 'to', 'origin', 'vertices'] as const) {
          const id = mark.bindings[key];
          if (id !== undefined && quantities[id]) drawn.push({ what: `quantity ${q(id)}`, units: everywhere(quantities[id]!.unit) });
        }
      }
      if (view.kind === 'table' && view.rowsFrom !== undefined) {
        const coordinates = geometryCoordinates(manifest, view.rowsFrom);
        if (coordinates) drawn.push({ what: `geometry ${q(view.rowsFrom)}`, units: coordinates });
      }
      for (const axis of dims === 3 ? ['x', 'y', 'z'] as const : ['x', 'y'] as const) {
        const spec = view.axes[axis];
        if (!spec) continue;
        for (const { what, units } of drawn) {
          const unit = units[axis];
          if (unit === undefined || unit === spec.unit || reported[axis].has(unit)) continue;
          reported[axis].add(unit);
          out.add('UNIT_MISMATCH', `${at}.axes.${axis}.unit`, `Axis ${axis} is labelled ${spec.unit}, but ${what} has ${axis} coordinates in ${unit}; axis values are never converted.`, `Label the axis in ${unit}, or bind ${axis === 'x' ? 'an' : 'a'} ${axis} coordinate whose canonical unit is ${spec.unit}.`);
        }
      }
    }
    if (view.quantities) {
      if (view.kind !== 'values' && view.kind !== 'table') out.add('KIND_MISMATCH', `${at}.quantities`, 'Only values and table views list quantities.');
      view.quantities.forEach((id, i) => { if (!quantities[id]) out.add('INVALID_REFERENCE', `${at}.quantities[${i}]`, `Quantity ${q(id)} does not exist.`); });
    }
    if (view.equations) {
      if (view.kind !== 'equation') out.add('KIND_MISMATCH', `${at}.equations`, 'Only equation views list equations.');
      const known = new Set(template.equations.map(equation => equation.id));
      view.equations.forEach((id, i) => { if (!known.has(id)) out.add('INVALID_REFERENCE', `${at}.equations[${i}]`, `Equation ${q(id)} does not exist.`); });
    }
    if (view.rowsFrom !== undefined) {
      if (view.kind !== 'table') out.add('KIND_MISMATCH', `${at}.rowsFrom`, 'Only table views draw rows from geometry.');
      if (!geometry[view.rowsFrom]) out.add('INVALID_REFERENCE', `${at}.rowsFrom`, `Geometry ${q(view.rowsFrom)} does not exist.`);
    }
    if (view.kind === 'values' && !view.quantities?.length) out.add('INVALID_INPUT', `${at}.quantities`, 'A values view lists at least one quantity.');
    if (view.kind === 'equation' && !view.equations?.length) out.add('INVALID_INPUT', `${at}.equations`, 'An equation view lists at least one equation.');
    if (view.kind === 'table' && view.rowsFrom === undefined && !view.quantities?.length) out.add('INVALID_INPUT', `${at}`, 'A table view needs rowsFrom geometry or quantities.');

    view.marks.forEach((mark, m) => {
      const path = `${at}.marks[${m}]`;
      groupExists(mark.group, `${path}.group`);
      const bindings = mark.bindings;
      if (bindings.geometry !== undefined) {
        const definition = geometry[bindings.geometry];
        if (!definition) out.add('INVALID_REFERENCE', `${path}.bindings.geometry`, `Geometry ${q(bindings.geometry)} does not exist.`);
        // Report §8.5: neither interpolation nor fitting without an explicit model. A curve through observations needs a
        // model series of its own (model geometry the curve mark binds), never a line drawn through the data.
        else if (definition.kind === 'observations2' && mark.kind !== 'points')
          out.add('KIND_MISMATCH', `${path}.bindings.geometry`, `Observed data ${q(bindings.geometry)} are drawn only as separate points; a ${mark.kind} mark would join, interpolate or fit them.`, 'Use a points mark for the observations, and bind any curve to a model series (model geometry) declared by the manifest.');
        else if (!MARK_GEOMETRY[mark.kind].includes(definition.kind)) out.add('KIND_MISMATCH', `${path}.bindings.geometry`, `Geometry kind ${definition.kind} cannot be drawn as a ${mark.kind} mark.`);
        else if (GEOMETRY_DIMS[definition.kind] !== null && GEOMETRY_DIMS[definition.kind] !== dims) out.add('KIND_MISMATCH', `${path}.bindings.geometry`, `Geometry kind ${definition.kind} does not match the ${view.kind} view.`);
      }
      for (const key of ['at', 'vector', 'from', 'to', 'origin', 'vertices', 'value'] as const) {
        const id = bindings[key];
        if (id === undefined) continue;
        const definition = quantities[id];
        if (!definition) out.add('INVALID_REFERENCE', `${path}.bindings.${key}`, `Quantity ${q(id)} does not exist.`);
        else if (!shapeFits(key, definition.shape, dims)) out.add('KIND_MISMATCH', `${path}.bindings.${key}`, `Quantity ${q(id)} has a shape that cannot bind ${key} in a ${dims}D view.`);
      }
      const options = REQUIRED_BINDINGS[mark.kind];
      if (options.length && !options.some(option => option.every(key => bindings[key] !== undefined)))
        out.add('INVALID_INPUT', `${path}.bindings`, `A ${mark.kind} mark needs bindings ${options.map(option => option.join('+')).join(' or ')}.`);
      if (mark.kind === 'label' && mark.text === undefined && bindings.value === undefined) out.add('INVALID_INPUT', `${path}`, 'A label mark needs text or a value binding.');
      if (mark.extent === 'line' && (mark.kind !== 'segment' && mark.kind !== 'segments' || dims !== 2))
        out.add('KIND_MISMATCH', `${path}.extent`, 'Only segment marks of 2D views can depict unbounded lines.', 'Use extent "line" on a segment or segments mark whose segments lie on the lines.');
      if (mark.drag) {
        if (mark.kind !== 'point') out.add('KIND_MISMATCH', `${path}.drag`, 'Only point marks can be dragged.');
        for (const axis of ['x', 'y'] as const) {
          const parameter = mark.drag[axis];
          if (parameter === undefined) continue;
          const control = controls.get(parameter);
          if (!parameters[parameter]) out.add('INVALID_REFERENCE', `${path}.drag.${axis}`, `Parameter ${q(parameter)} does not exist.`);
          else if (!control) out.add('INVALID_REFERENCE', `${path}.drag.${axis}`, `Dragged parameter ${q(parameter)} has no control.`, 'Declare a ControlSpec for every draggable parameter.');
          else if (!control.exact) out.add('MISSING_EQUIVALENT', `${path}.drag.${axis}`, `Dragged parameter ${q(parameter)} has no exact-entry control.`, 'Set exact: true so the drag has an exact keyboard equivalent.');
          const axisUnit = view.axes?.[axis]?.unit;
          const unitRecovery = 'Declare the parameter\'s canonical unit on the axis; select display units on its control.';
          if (parameters[parameter] && axisUnit === undefined)
            out.add('UNIT_MISMATCH', `${path}.drag.${axis}`, `Dragged parameter ${q(parameter)} needs a declared canonical unit on axis ${axis}.`, unitRecovery);
          else if (parameters[parameter] && axisUnit !== undefined && parameters[parameter]!.unit !== axisUnit)
            out.add('UNIT_MISMATCH', `${path}.drag.${axis}`, `Axis ${axis} uses ${axisUnit}; dragged parameter ${q(parameter)} requires ${parameters[parameter]!.unit}.`, unitRecovery);
        }
      }
    });
  });

  template.controls.forEach((control, c) => {
    groupExists(control.group, `$.controls[${c}].group`);
    const definition = parameters[control.parameter];
    if (!definition) { out.add('INVALID_REFERENCE', `$.controls[${c}].parameter`, `Parameter ${q(control.parameter)} does not exist.`); return; }
    out.unique(control.displayUnits, i => `$.controls[${c}].displayUnits[${i}]`, 'display unit');
    control.displayUnits.forEach((unit, u) => {
      if (!isCompatible(unit, definition.unit)) out.add('UNIT_MISMATCH', `$.controls[${c}].displayUnits[${u}]`, `Display unit ${unit} is not compatible with the canonical unit ${definition.unit}.`, 'List only units of the parameter\'s dimension.');
    });
  });
  // Control presentation sections (report §10.2): one section ID names one labelled group, so its label is the same on
  // every control that shares it.
  const sectionLabels = new Map<string, string>();
  template.controls.forEach((control, c) => {
    if (!control.section) return;
    const known = sectionLabels.get(control.section.id);
    if (known === undefined) sectionLabels.set(control.section.id, control.section.label);
    else if (known !== control.section.label) out.add('DUPLICATE_ID', `$.controls[${c}].section.label`, `Section ${q(control.section.id)} has two labels.`, 'Give every control of one section the same section label, or use another section ID.');
  });

  // Per-quantity display units (report §8.3): manifest quantities only, units of the quantity's dimension, and never a
  // key that is also a controlled parameter (setDisplayUnit addresses both by ID).
  for (const [id, display] of Object.entries(template.quantityDisplay ?? {})) {
    const path = `$.quantityDisplay.${id}`;
    const definition = quantities[id];
    if (!definition) { out.add('INVALID_REFERENCE', path, `Quantity ${q(id)} does not exist.`); continue; }
    if (controls.has(id)) out.add('DUPLICATE_ID', path, `${q(id)} is both a displayed quantity and a controlled parameter.`, 'Display units of a controlled parameter belong to its ControlSpec.');
    out.unique(display.units, i => `${path}.units[${i}]`, 'display unit');
    display.units.forEach((unit, u) => {
      if (!isCompatible(unit, definition.unit)) out.add('UNIT_MISMATCH', `${path}.units[${u}]`, `Display unit ${unit} is not compatible with the canonical unit ${definition.unit}.`, 'List only units of the quantity\'s dimension.');
    });
  }

  template.scenarios.forEach((scenario, s) => {
    groupExists(scenario.group, `$.scenarios[${s}].group`);
    for (const [id, value] of Object.entries(scenario.parameters)) {
      const path = `$.scenarios[${s}].parameters.${id}`;
      const definition = parameters[id];
      if (!definition) { out.add('INVALID_REFERENCE', path, `Parameter ${q(id)} does not exist.`); continue; }
      if (value < definition.min || value > definition.max) { out.add('OUT_OF_DOMAIN', path, `The scenario value is outside the parameter range.`, 'Use a value within the manifest minimum and maximum.'); continue; }
      if (!isAdmissible(definition, value)) out.add('CONSTRAINT_VIOLATION', path, 'The scenario value is not an admissible step of the parameter.');
    }
    // Coupled constraints over the values the scenario sets (those it leaves out are not known here).
    for (const item of checkParameters(manifest, scenario.parameters, { partial: true })) {
      if (item.code !== 'CONSTRAINT_VIOLATION') continue;
      const constraint = item.path.startsWith('$.constraints.') ? item.path.slice('$.constraints.'.length) : '';
      out.add('CONSTRAINT_VIOLATION', `$.scenarios[${s}].parameters`, `The scenario values violate model constraint ${q(constraint)}.`, 'Choose scenario values that satisfy every coupled model constraint.');
    }
  });

  const stageIds = new Set(template.stages.map(stage => stage.id));
  const families = new Set(template.taskFamilies.map(family => family.id));
  template.stages.forEach((stage, s) => {
    for (const id of Object.keys(stage.visible)) groupExists(id, `$.stages[${s}].visible.${id}`);
    for (const id of Object.keys(stage.controls)) {
      if (!parameters[id]) out.add('INVALID_REFERENCE', `$.stages[${s}].controls.${id}`, `Parameter ${q(id)} does not exist.`);
      else if (!controls.has(id)) out.add('INVALID_REFERENCE', `$.stages[${s}].controls.${id}`, `Parameter ${q(id)} has no ControlSpec.`);
    }
    if (stage.response && !families.has(stage.response.taskFamily))
      out.add('INVALID_REFERENCE', `$.stages[${s}].response.taskFamily`, `Task family ${q(stage.response.taskFamily)} does not exist.`);
  });
  template.transitions.forEach((transition, t) => {
    if (!stageIds.has(transition.from)) out.add('INVALID_REFERENCE', `$.transitions[${t}].from`, `Stage ${q(transition.from)} does not exist.`);
    if (!stageIds.has(transition.to)) out.add('INVALID_REFERENCE', `$.transitions[${t}].to`, `Stage ${q(transition.to)} does not exist.`);
  });
  if (!stageIds.has(template.initialStage)) out.add('INVALID_REFERENCE', '$.initialStage', `Stage ${q(template.initialStage)} does not exist.`);

  const quantityGroups = (id: string) => template.groups.filter(group => group.kind === 'quantity' && group.members.includes(id));
  template.equations.forEach((equation, e) => {
    const at = `$.equations[${e}]`;
    groupExists(equation.group, `${at}.group`);
    for (const field of ['tex', 'plain'] as const) {
      if (codePoints(equation[field]) > 4096) out.add('RESOURCE_LIMIT', `${at}.${field}`, 'Equation text exceeds 4096 characters.');
      const starts = equation[field].match(PLACEHOLDER_START)?.length ?? 0;
      if (starts !== [...equation[field].matchAll(PLACEHOLDER)].length) out.add('INVALID_INPUT', `${at}.${field}`, 'A quantity placeholder is malformed.', 'Write placeholders as {{q:quantityId}}.');
    }
    if (FORBIDDEN_TEX.test(equation.tex)) out.add('INVALID_INPUT', `${at}.tex`, 'The TeX uses a command that is not permitted (macro definition, link, resource or HTML).');
    const texIds = new Set([...equation.tex.matchAll(PLACEHOLDER)].map(match => match[1]!));
    const plainIds = new Set([...equation.plain.matchAll(PLACEHOLDER)].map(match => match[1]!));
    if (texIds.size !== plainIds.size || [...texIds].some(id => !plainIds.has(id))) out.add('INVALID_INPUT', `${at}.plain`, 'The plain-text equivalent must use the same placeholders as the TeX.');
    const group = groups.get(equation.group);
    for (const id of new Set([...texIds, ...plainIds])) {
      if (!quantities[id]) { out.add('INVALID_REFERENCE', `${at}.tex`, `Placeholder references unknown quantity ${q(id)}.`); continue; }
      const holders = quantityGroups(id);
      if (!holders.length) { out.add('EQUATION_DISCLOSURE', `${at}.tex`, `Quantity ${q(id)} is in no quantity group, so the equation can never be shown with its value.`, 'Add the quantity to a quantity group visible with the equation.'); continue; }
      template.stages.forEach((stage, s) => {
        if (stage.visible[equation.group] && !holders.some(holder => stage.visible[holder.id]))
          out.add('EQUATION_DISCLOSURE', `$.stages[${s}].visible`, `Equation ${q(equation.id)} is visible in stage ${q(stage.id)} but quantity ${q(id)} is not.`, 'Make a group holding the quantity visible wherever the equation is visible.');
      });
      if (group && !group.solutionBearing && holders.every(holder => holder.solutionBearing))
        out.add('EQUATION_DISCLOSURE', `${at}.group`, `Equation ${q(equation.id)} substitutes solution-bearing quantity ${q(id)} from a group that needs no exposure receipt.`, 'Mark the equation group solution-bearing.');
    }
  });

  const coverable = new Set([...template.views.map(view => view.id), ...marks.map(entry => entry.mark.id), ...template.controls.map(control => control.parameter)]);
  template.alternatives.forEach((alternative, a) => {
    groupExists(alternative.group, `$.alternatives[${a}].group`);
    alternative.covers.forEach((id, i) => { if (!coverable.has(id)) out.add('INVALID_REFERENCE', `$.alternatives[${a}].covers[${i}]`, `Covered element ${q(id)} does not exist.`); });
  });
  template.views.forEach((view, v) => {
    if (!spatial(view.kind)) return;
    const equivalents = template.alternatives.filter(alternative => alternative.covers.includes(view.id) && alternative.equivalence !== 'partial');
    if (!equivalents.length) {
      out.add('MISSING_EQUIVALENT', `$.views[${v}]`, `View ${q(view.id)} has no equivalent alternative.`, 'Add an AlternativeSpec with equivalence "equivalent" or "alternative-activity" covering the view.');
      return;
    }
    template.stages.forEach((stage, s) => {
      if (stage.visible[view.group] && !equivalents.some(alternative => stage.visible[alternative.group]))
        out.add('MISSING_EQUIVALENT', `$.stages[${s}].visible`, `View ${q(view.id)} is visible in stage ${q(stage.id)} without a visible equivalent.`, 'Make an equivalent alternative visible wherever the view is visible.');
    });
  });
  return out.items;
}

// ---------------------------------------------------------------------------------------------
// Template authoring warnings
// ---------------------------------------------------------------------------------------------
const MARK_QUANTITY_BINDINGS = ['at', 'vector', 'from', 'to', 'origin', 'vertices', 'value'] as const;
const list = (ids: readonly string[]): string => ids.slice(0, 6).map(q).join(', ') + (ids.length > 6 ? ` and ${ids.length - 6} more` : '');

/**
 * Authoring warnings (report §15.2): content the template declares but its own stages can never show, and declarations
 * nothing refers to. They are warnings, not errors: a template with warnings still validates and prepares, and
 * `validateTemplateSemantics` (which the adapter runs) is unchanged. Each stage is read as the most permissive host
 * would apply it (every group inside the policy ceiling and every solution-bearing group granted), so a warning means
 * that no host policy can make the element reach a learner channel. The visibility rules are the projection's own
 * (`computeVisibility`, `markVisible`, `projectLearnerView`). Orphaned references remain errors of
 * `validateTemplateSemantics`; call this on a template that passes it.
 *
 * - `UNREFERENCED`: a group that holds nothing (no member and no element assigned to it); an equation that no equation
 *   view lists; a control that no stage lists; a quantity of a quantity group that no view, axis, mark or equation
 *   shows; dataset geometry that no mark or table draws.
 * - `NEVER_VISIBLE`: a view whose group no stage shows; any other non-empty group no stage shows; a mark, equation,
 *   control, view quantity or table source whose own group is shown somewhere but never in a stage that also shows
 *   everything it needs (its view, the data it binds, its equation view, its stage control entry).
 */
export function templateWarnings(template: ActivityTemplate, manifest: ModelManifest): Diagnostic[] {
  const out = new Collector();
  const stages = template.stages;
  const shown = (stage: StageSpec, group: string): boolean => Object.hasOwn(stage.visible, group);
  const everShown = (group: string): boolean => stages.some(stage => shown(stage, group));
  const quantityGroups = (id: string): string[] => template.groups.filter(group => group.kind === 'quantity' && group.members.includes(id)).map(group => group.id);
  const datasetGroups = (id: string): string[] => template.groups.filter(group => group.kind === 'dataset' && group.members.includes(id)).map(group => group.id);
  const quantityReadable = (stage: StageSpec, id: string): boolean => quantityGroups(id).some(group => shown(stage, group));
  const geometryReadable = (stage: StageSpec, id: string, ownerGroup: string): boolean => {
    const owners = datasetGroups(id);
    return owners.length ? owners.some(group => shown(stage, group)) : shown(stage, ownerGroup);
  };
  const placeholders = (equation: EquationSpec): string[] => [...new Set([...equation.tex.matchAll(PLACEHOLDER), ...equation.plain.matchAll(PLACEHOLDER)].map(match => match[1]!))];
  const marks = template.views.flatMap((view, v) => view.marks.map((mark, m) => ({ view, mark, path: `$.views[${v}].marks[${m}]` })));

  // ---- groups that hold nothing, and groups no stage shows ------------------------------------------------------
  const assigned = new Map<string, string[]>();
  const assign = (group: string, what: string) => { const items = assigned.get(group) ?? []; items.push(what); assigned.set(group, items); };
  for (const view of template.views) assign(view.group, `view ${q(view.id)}`);
  for (const { mark } of marks) assign(mark.group, `mark ${q(mark.id)}`);
  for (const control of template.controls) assign(control.group, `control ${q(control.parameter)}`);
  for (const equation of template.equations) assign(equation.group, `equation ${q(equation.id)}`);
  for (const scenario of template.scenarios) assign(scenario.group, `scenario ${q(scenario.id)}`);
  for (const alternative of template.alternatives) assign(alternative.group, `alternative ${q(alternative.id)}`);
  const viewGroups = new Set(template.views.map(view => view.group));
  template.groups.forEach((group, g) => {
    const elements = assigned.get(group.id) ?? [];
    if (!group.members.length && !elements.length) {
      out.add('UNREFERENCED', `$.groups[${g}]`, `Group ${q(group.id)} holds nothing: it has no members and no view, mark, control, equation, scenario or alternative is assigned to it.`, 'Assign content to the group or remove it (and its stage entries).');
      return;
    }
    // A view's own group is reported once, on the view.
    if (!everShown(group.id) && !viewGroups.has(group.id)) {
      const content = elements.length ? elements : group.members.map(member => `${group.kind} member ${q(member)}`);
      out.add('NEVER_VISIBLE', `$.groups[${g}]`, `Group ${q(group.id)} is visible in no stage, so ${list(content)} never reach${content.length === 1 ? 'es' : ''} a learner.`, 'List the group in the `visible` map of the stages that should show it, or remove it.');
    }
  });

  // ---- views and what they show ---------------------------------------------------------------------------------
  template.views.forEach((view, v) => {
    const at = `$.views[${v}]`;
    if (!everShown(view.group)) {
      out.add('NEVER_VISIBLE', `${at}.group`, `View ${q(view.id)} is never shown: its group ${q(view.group)} is visible in no stage.`, 'List the view\'s group in the `visible` map of the stages that should show it, or remove the view.');
      return;
    }
    const viewStages = stages.filter(stage => shown(stage, view.group));
    (view.kind === 'values' || view.kind === 'table' ? view.quantities ?? [] : []).forEach((id, i) => {
      if (!viewStages.some(stage => quantityReadable(stage, id)))
        out.add('NEVER_VISIBLE', `${at}.quantities[${i}]`, `Quantity ${q(id)} is never shown in view ${q(view.id)}: no stage that shows the view shows a quantity group holding it.`, 'Add the quantity to a quantity group visible with the view, or remove it from the view.');
    });
    if (view.kind === 'table' && view.rowsFrom !== undefined && !viewStages.some(stage => geometryReadable(stage, view.rowsFrom!, view.group)))
      out.add('NEVER_VISIBLE', `${at}.rowsFrom`, `The rows of table ${q(view.id)} are never shown: no stage that shows the table shows a dataset group holding ${q(view.rowsFrom)}.`, 'Make a dataset group holding the geometry visible with the table.');
  });
  for (const { view, mark, path } of marks) {
    if (!everShown(view.group) || !everShown(mark.group)) continue;
    const visible = stages.some(stage => shown(stage, view.group) && shown(stage, mark.group)
      && (mark.bindings.geometry === undefined || geometryReadable(stage, mark.bindings.geometry, mark.group))
      && MARK_QUANTITY_BINDINGS.every(key => mark.bindings[key] === undefined || quantityReadable(stage, mark.bindings[key]!)));
    if (!visible) out.add('NEVER_VISIBLE', path, `Mark ${q(mark.id)} is never shown: no stage shows it together with view ${q(view.id)} and the groups of the data it binds.`, 'Make the mark\'s group, its view\'s group and the quantity or dataset groups of its bindings visible in the same stage.');
  }

  // ---- equations ------------------------------------------------------------------------------------------------
  template.equations.forEach((equation, e) => {
    const at = `$.equations[${e}]`;
    const views = template.views.filter(view => view.kind === 'equation' && (view.equations ?? []).includes(equation.id));
    if (!views.length) {
      out.add('UNREFERENCED', at, `Equation ${q(equation.id)} is listed by no equation view, so it is never shown.`, 'List it in an equation view, or remove it.');
      return;
    }
    if (!everShown(equation.group) || !views.some(view => everShown(view.group))) return;
    const ids = placeholders(equation);
    if (!stages.some(stage => shown(stage, equation.group) && views.some(view => shown(stage, view.group)) && ids.every(id => quantityReadable(stage, id))))
      out.add('NEVER_VISIBLE', at, `Equation ${q(equation.id)} is never shown: no stage shows its group together with an equation view listing it and the quantities it substitutes.`, 'Make the equation\'s group and an equation view listing it visible in the same stage.');
  });

  // ---- controls -------------------------------------------------------------------------------------------------
  template.controls.forEach((control, c) => {
    const at = `$.controls[${c}]`;
    if (!stages.some(stage => Object.hasOwn(stage.controls, control.parameter))) {
      out.add('UNREFERENCED', at, `Control ${q(control.parameter)} is listed in no stage's controls, so it is never shown.`, 'Add the parameter to the `controls` map of the stages that should offer it, or remove the control.');
      return;
    }
    if (everShown(control.group) && !stages.some(stage => Object.hasOwn(stage.controls, control.parameter) && shown(stage, control.group)))
      out.add('NEVER_VISIBLE', at, `Control ${q(control.parameter)} is never shown: no stage lists it in its controls while its group ${q(control.group)} is visible.`, 'Make the control\'s group visible in the stages that list the control.');
  });

  // ---- quantity and dataset members nothing shows -----------------------------------------------------------------
  const usedQuantities = new Set<string>();
  for (const view of template.views) {
    for (const id of view.quantities ?? []) usedQuantities.add(id);
    for (const axis of [view.axes?.x, view.axes?.y, view.axes?.z]) if (axis?.quantity !== undefined) usedQuantities.add(axis.quantity);
  }
  for (const { mark } of marks) for (const key of MARK_QUANTITY_BINDINGS) if (mark.bindings[key] !== undefined) usedQuantities.add(mark.bindings[key]!);
  for (const equation of template.equations) for (const id of placeholders(equation)) usedQuantities.add(id);
  const usedGeometry = new Set<string>([...marks.flatMap(({ mark }) => mark.bindings.geometry !== undefined ? [mark.bindings.geometry] : []), ...template.views.flatMap(view => view.rowsFrom !== undefined ? [view.rowsFrom] : [])]);
  template.groups.forEach((group, g) => {
    if (group.kind !== 'quantity' && group.kind !== 'dataset') return;
    group.members.forEach((member, m) => {
      if (group.kind === 'quantity' && Object.hasOwn(manifest.quantities, member) && !usedQuantities.has(member))
        out.add('UNREFERENCED', `$.groups[${g}].members[${m}]`, `Quantity ${q(member)} of group ${q(group.id)} is shown by no view, axis, mark or equation.`, 'Show it in a values or table view, bind it in a mark or substitute it in an equation, or remove it from the group.');
      if (group.kind === 'dataset' && Object.hasOwn(manifest.geometry, member) && !usedGeometry.has(member))
        out.add('UNREFERENCED', `$.groups[${g}].members[${m}]`, `Geometry ${q(member)} of group ${q(group.id)} is drawn by no mark and listed by no table.`, 'Bind it in a mark or a table\'s rowsFrom, or remove it from the group.');
    });
  });
  return out.items;
}

// ---------------------------------------------------------------------------------------------
// Policy
// ---------------------------------------------------------------------------------------------
export function validatePolicySemantics(policy: HostPolicy): Diagnostic[] {
  const out = new Collector();
  if (policy.expiresAt !== null && !(timestampMs(policy.expiresAt) > timestampMs(policy.issuedAt)))
    out.add('CONSTRAINT_VIOLATION', '$.expiresAt', 'The policy must expire after it is issued.');
  if (policy.mode === 'exploratory' && !policy.exploratory.allowed)
    out.add('CONSTRAINT_VIOLATION', '$.mode', 'Exploratory mode requires exploratory.allowed.');
  if (policy.mode === 'approved' && !policy.approved.length)
    out.add('CONSTRAINT_VIOLATION', '$.approved', 'Approved mode lists at least one approved template and model.');
  out.unique(policy.approved.map(entry => `${entry.template.templateId}@${entry.template.version}`), i => `$.approved[${i}].template`, 'approved template version');
  out.unique(policy.allowedTools, i => `$.allowedTools[${i}]`, 'tool');
  out.unique(policy.visibleGroups, i => `$.visibleGroups[${i}]`, 'visible group');
  out.unique(policy.permittedControls, i => `$.permittedControls[${i}]`, 'permitted control');
  out.unique(policy.independentTask.permittedTools, i => `$.independentTask.permittedTools[${i}]`, 'tool');
  out.unique(policy.independentTask.neutralScaffold, i => `$.independentTask.neutralScaffold[${i}]`, 'scaffold group');
  if (policy.independentTask.active !== (policy.independentTask.taskRef !== null))
    out.add('CONSTRAINT_VIOLATION', '$.independentTask.taskRef', 'An active independent task names its task reference; an inactive one names none.');
  const allowed = new Set(policy.allowedTools);
  policy.independentTask.permittedTools.forEach((tool, i) => {
    if (!allowed.has(tool)) out.add('CONSTRAINT_VIOLATION', `$.independentTask.permittedTools[${i}]`, `Tool ${q(tool)} is not in allowedTools.`, 'Independent-task tools must be a subset of allowed tools.');
  });
  const visible = new Set(policy.visibleGroups);
  policy.independentTask.neutralScaffold.forEach((group, i) => {
    if (!visible.has(group)) out.add('CONSTRAINT_VIOLATION', `$.independentTask.neutralScaffold[${i}]`, `Scaffold group ${q(group)} is not in visibleGroups.`);
  });
  if (policy.sampling.allowed && !allowed.has('sample')) out.add('CONSTRAINT_VIOLATION', '$.sampling.allowed', 'Sampling requires the sample tool in allowedTools.');
  if (policy.exploratory.allowed && policy.mode === 'approved' && !allowed.has('compose.exploratory'))
    out.add('CONSTRAINT_VIOLATION', '$.exploratory.allowed', 'Exploratory composition requires the compose.exploratory tool in allowedTools.');
  return out.items;
}

// ---------------------------------------------------------------------------------------------
// Instance
// ---------------------------------------------------------------------------------------------
export function validateInstanceSemantics(instance: ActivityInstance, template: ActivityTemplate): Diagnostic[] {
  const out = new Collector();
  if (instance.template.templateId !== template.templateId || instance.template.version !== template.version)
    out.add('INVALID_REFERENCE', '$.template', 'The instance references a different template ID or version.');
  else if (instance.template.digest !== templateDigest(template))
    out.add('STALE_ACTIVITY_REVISION', '$.template.digest', 'The template digest differs from the installed template.', 'Prepare a new activity against the installed template.');
  if (!sameJSON(instance.model, template.model)) out.add('INVALID_REFERENCE', '$.model', 'The instance model reference differs from the template model reference.');
  const stages = new Set(template.stages.map(stage => stage.id));
  if (!stages.has(instance.stage.id)) out.add('INVALID_REFERENCE', '$.stage.id', `Stage ${q(instance.stage.id)} does not exist in the template.`);
  out.unique(instance.objectiveIds, i => `$.objectiveIds[${i}]`, 'objective');
  out.unique(instance.allowedActions, i => `$.allowedActions[${i}]`, 'action');
  out.unique(instance.responses.map(response => response.responseId), i => `$.responses[${i}].responseId`, 'response');
  const responses = new Set(instance.responses.map(response => response.responseId));
  instance.responses.forEach((response, r) => {
    if (!stages.has(response.stageId)) out.add('INVALID_REFERENCE', `$.responses[${r}].stageId`, `Stage ${q(response.stageId)} does not exist in the template.`);
    if (response.supersededBy !== undefined && (response.supersededBy === response.responseId || !responses.has(response.supersededBy)))
      out.add('INVALID_REFERENCE', `$.responses[${r}].supersededBy`, 'The superseding response is not another response of this activity.');
    if (response.status === 'superseded' && response.supersededBy === undefined)
      out.add('CONSTRAINT_VIOLATION', `$.responses[${r}].supersededBy`, 'A superseded response names the response that supersedes it.');
  });
  return out.items;
}

// ---------------------------------------------------------------------------------------------
// Artifact
// ---------------------------------------------------------------------------------------------
export function validateArtifactSemantics(artifact: ActivityArtifact): Diagnostic[] {
  const out = new Collector();
  const fields = artifact as unknown as Record<string, unknown>;
  const { entries } = artifact.integrity;
  out.unique(entries.map(entry => entry.path), i => `$.integrity.entries[${i}].path`, 'integrity entry');
  const named = new Set(entries.map(entry => entry.path));
  for (const field of INTEGRITY_FIELDS) {
    if (fields[field] !== undefined && !named.has(field)) out.add('INTEGRITY_FAILURE', '$.integrity.entries', `Field ${q(field)} is not covered by the integrity manifest.`, 'Recompute the integrity manifest over every top-level field.');
  }
  entries.forEach((entry, i) => {
    if (fields[entry.path] === undefined) out.add('INTEGRITY_FAILURE', `$.integrity.entries[${i}].path`, `Integrity entry names absent field ${q(entry.path)}.`);
    else if (hash(fields[entry.path]) !== entry.digest) out.add('INTEGRITY_FAILURE', `$.integrity.entries[${i}].digest`, `Field ${q(entry.path)} does not match its integrity digest.`, 'Keep the original bytes; the artifact was altered or corrupted.');
  });
  if (hash(entries) !== artifact.integrity.digest) out.add('INTEGRITY_FAILURE', '$.integrity.digest', 'The integrity digest does not match its entries.', 'Keep the original bytes; the artifact was altered or corrupted.');
  // The manifest is canonical, exactly as `artifactIntegrity` computes it: one entry per present field, in INTEGRITY_FIELDS
  // order. The Rust reference host verifies the same ordered list, so both accept and refuse the same artifacts (A02).
  const canonical = INTEGRITY_FIELDS.filter(field => fields[field] !== undefined);
  const paths = entries.map(entry => entry.path);
  if (paths.length === canonical.length && canonical.every(field => paths.includes(field)) && paths.some((path, i) => path !== canonical[i]))
    out.add('INTEGRITY_FAILURE', '$.integrity.entries', 'The integrity entries are not in the canonical field order.', 'Recompute the integrity manifest with artifactIntegrity; entries follow INTEGRITY_FIELDS order.');

  const { instance } = artifact;
  if (!sameJSON(artifact.template, instance.template)) out.add('INVALID_REFERENCE', '$.template', 'The artifact template differs from the instance template.');
  if (!sameJSON(artifact.model, instance.model)) out.add('INVALID_REFERENCE', '$.model', 'The artifact model differs from the instance model.');
  if (!sameJSON(artifact.model, artifact.scientific.model)) out.add('INVALID_REFERENCE', '$.scientific.model', 'The scientific snapshot model differs from the artifact model.');
  if (!sameJSON(artifact.policyRef, instance.policy)) out.add('INVALID_REFERENCE', '$.policyRef', 'The policy reference differs from the instance policy.');
  if (artifact.journal.cursor.activityId !== instance.activityId) out.add('INVALID_REFERENCE', '$.journal.cursor.activityId', 'The journal cursor belongs to another activity.');
  out.unique(artifact.journal.pendingEventIds, i => `$.journal.pendingEventIds[${i}]`, 'pending event');
  // Carried pending events (additive in 1.0): a contiguous prefix of the pending IDs, in order, continuing the checkpoint.
  (artifact.journal.pendingEvents ?? []).forEach((event, i) => {
    if (event.activityId !== instance.activityId) out.add('INVALID_REFERENCE', `$.journal.pendingEvents[${i}].activityId`, 'The carried event belongs to another activity.');
    if (event.eventId !== artifact.journal.pendingEventIds[i]) out.add('INVALID_REFERENCE', `$.journal.pendingEvents[${i}].eventId`, 'Carried pending events are the pending event IDs in order.');
    if (event.sequence !== artifact.journal.cursor.lastSequence + 1 + i) out.add('INVALID_REFERENCE', `$.journal.pendingEvents[${i}].sequence`, 'Carried pending events continue the checkpoint cursor without gaps.');
  });
  if (artifact.journal.lost && artifact.journal.lost.afterSequence > artifact.journal.cursor.lastSequence + artifact.journal.pendingEventIds.length)
    out.add('INVALID_REFERENCE', '$.journal.lost.afterSequence', 'A journal loss follows an event at or before the end of the checkpoint.');
  const exposureIds = new Set(artifact.exposures.map(exposure => exposure.exposureId));
  (artifact.lineage?.endedExposureIds ?? []).forEach((id, i) => {
    if (!exposureIds.has(id)) out.add('INVALID_REFERENCE', `$.lineage.endedExposureIds[${i}]`, 'An ended lineage names an exposure record of the artifact.');
  });
  if (artifact.lineage) out.unique(artifact.lineage.endedExposureIds, i => `$.lineage.endedExposureIds[${i}]`, 'ended exposure');
  out.unique(artifact.exposures.map(exposure => exposure.exposureId), i => `$.exposures[${i}].exposureId`, 'exposure');
  artifact.exposures.forEach((exposure, e) => {
    if (exposure.activityId !== instance.activityId) out.add('INVALID_REFERENCE', `$.exposures[${e}].activityId`, 'The exposure belongs to another activity.');
    if (!sameJSON(exposure.template, artifact.template) || !sameJSON(exposure.model, artifact.model)) out.add('INVALID_REFERENCE', `$.exposures[${e}]`, 'The exposure references another template or model.');
  });
  if (artifact.pending.kind === 'preview' && artifact.pending.baseRunId !== artifact.scientific.runId)
    out.add('INVALID_REFERENCE', '$.pending.baseRunId', 'The pending preview is not based on the saved committed run.');
  // Assistance references: one per receipt, and a grant summary that names exactly the exposure record the same receipt
  // created. Sequences are not bounded by the checkpoint: after a restore onto a host journal that ends earlier, earlier
  // assistance keeps the sequence of the journal it was recorded in.
  const assistance = artifact.assistance ?? [];
  out.unique(assistance.map(item => item.receiptId), i => `$.assistance[${i}].receiptId`, 'assistance receipt');
  assistance.forEach((item, i) => {
    if (!item.grant) return;
    const exposure = artifact.exposures.find(record => record.exposureId === item.grant!.exposureId);
    if (!exposure || exposure.receiptId !== item.receiptId || !sameJSON([...item.grant.groups].sort(), exposure.groups.map(group => group.groupId).sort()))
      out.add('INVALID_REFERENCE', `$.assistance[${i}].grant`, 'The grant summary does not match an exposure record of the same receipt.');
  });
  out.unique(artifact.schemas.map(entry => entry.contract), i => `$.schemas[${i}].contract`, 'schema contract');
  const required = [CONTRACTS.artifact, CONTRACTS.instance, CONTRACTS.scientific, CONTRACTS.presentation, ...(artifact.exposures.length ? [CONTRACTS.exposure] : []),
    ...(artifact.journal.pendingEvents?.length ? [CONTRACTS.event] : [])];
  for (const contract of required) {
    if (!artifact.schemas.some(entry => entry.contract === contract && entry.version === ACTIVITY_SCHEMA_VERSION))
      out.add('INVALID_REFERENCE', '$.schemas', `The schema list omits ${contract} ${ACTIVITY_SCHEMA_VERSION}.`);
  }
  return out.items;
}
