/**
 * Three.js scene construction from a spatial plan (bounded scientific primitives only). Every geometry and material is
 * registered in a resource group so it is disposed when the content is rebuilt or the renderer is torn down. No
 * textures are created (labels are DOM, nothing is fetched) and no custom shaders beyond Three.js' own line material.
 *
 * Lines are screen-space wide lines (`LineSegments2`) so weight and dash patterns read like the 2D views; arrowheads
 * are cones whose apex sits exactly at the projected tip; points are small glyph solids (sphere, cube, octahedron,
 * tetrahedron, or a 3-axis cross) so marker shape, not only colour, distinguishes series.
 */
import {
  AmbientLight, BoxGeometry, BufferAttribute, BufferGeometry, Color, ConeGeometry, DirectionalLight, DoubleSide, Group, InstancedMesh, Matrix4, Mesh,
  MeshBasicMaterial, MeshLambertMaterial, OctahedronGeometry, Quaternion, SphereGeometry, TetrahedronGeometry, Vector3, type Object3D,
} from 'three';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';
import { LineSegments2 } from 'three/addons/lines/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/addons/lines/LineSegmentsGeometry.js';
import { toWorld, type ViewFrame } from './frame.js';
import type { Glyph, PlannedStyle, SpatialPlan } from './plan.js';
import type { ResourceGroup } from './registry.js';
import { roleColor, type SpatialTheme } from './theme.js';
import { normalize, sub, type Vec3 } from './vec.js';

/** CSS pixel widths per mark weight; a selected mark is drawn 1.6 times wider. */
export const LINE_WIDTH: Readonly<Record<PlannedStyle['weight'], number>> = Object.freeze({ thin: 1.5, regular: 2.25, bold: 3.25 });
/** Dash and gap lengths as fractions of the box radius (world units). */
const DASH: Record<PlannedStyle['dash'], [number, number] | null> = { solid: null, dashed: [0.06, 0.04], dotted: [0.012, 0.035] };
/** Axis line patterns: x solid, y dashed, z dotted (a non-colour distinction). */
export const AXIS_DASH: readonly PlannedStyle['dash'][] = Object.freeze(['solid', 'dashed', 'dotted']);

export interface SharedGeometries { cone: ConeGeometry; sphere: SphereGeometry; box: BoxGeometry; octahedron: OctahedronGeometry; tetrahedron: TetrahedronGeometry }
/** Glyph and arrowhead geometries shared by every build of one renderer (unit size; scaled per object). */
export function createSharedGeometries(resources: ResourceGroup): SharedGeometries {
  // Cone apex at the origin, base one unit below along −y: placing the mesh at a tip puts the apex exactly there.
  const cone = resources.add('geometry', new ConeGeometry(1, 1, 18, 1));
  cone.translate(0, -0.5, 0);
  return {
    cone,
    sphere: resources.add('geometry', new SphereGeometry(1, 16, 12)),
    box: resources.add('geometry', new BoxGeometry(1.6, 1.6, 1.6)),
    octahedron: resources.add('geometry', new OctahedronGeometry(1.35)),
    tetrahedron: resources.add('geometry', new TetrahedronGeometry(1.4)),
  };
}

/** A drawn arrow: its tail and tip (world) and its head, instance `index` of the mark's instanced arrowhead mesh. */
export interface RenderedArrow { markId: string; segmentId: string; tail: Vec3; tip: Vec3; head: { mesh: InstancedMesh; index: number } }
export interface BuiltScene {
  group: Group;
  lineMaterials: LineMaterial[];
  arrows: RenderedArrow[];
  surfaces: { markId: string; mesh: Mesh; wire: LineSegments2 }[];
}

const UP = new Vector3(0, 1, 0);
const color = (value: string): Color => new Color(value);

class Builder {
  readonly group = new Group();
  readonly lineMaterials: LineMaterial[] = [];
  constructor(protected readonly frame: ViewFrame, protected readonly theme: SpatialTheme, protected readonly resources: ResourceGroup, protected readonly shared: SharedGeometries) {}

  get radius(): number { return this.frame.radius; }
  world(point: Vec3): Vec3 { return toWorld(this.frame, point); }

  /** Wide line segments from flat world-space pairs [x0,y0,z0,x1,y1,z1, …]: one draw call. */
  lines(pairs: number[], stroke: string, width: number, dash: PlannedStyle['dash'], name: string, opacity = 1): LineSegments2 | null {
    if (pairs.length < 6) return null;
    const geometry = this.resources.add('geometry', new LineSegmentsGeometry());
    geometry.setPositions(pairs);
    const pattern = DASH[dash];
    const material = this.resources.add('material', new LineMaterial({
      color: stroke, linewidth: width, worldUnits: false, dashed: pattern !== null, transparent: opacity < 1, opacity,
      ...(pattern ? { dashSize: pattern[0] * this.radius, gapSize: pattern[1] * this.radius } : {}),
    }));
    const object = new LineSegments2(geometry, material);
    if (pattern) object.computeLineDistances();
    object.name = name;
    this.lineMaterials.push(material);
    this.group.add(object);
    return object;
  }

  basic(fill: string, options: { wireframe?: boolean; opacity?: number } = {}): MeshBasicMaterial {
    return this.resources.add('material', new MeshBasicMaterial({ color: color(fill), wireframe: options.wireframe ?? false, transparent: (options.opacity ?? 1) < 1, opacity: options.opacity ?? 1 }));
  }

  /** Cone head with its apex at `tip`, pointing along tail → tip (world): the axis arrowheads (one mesh each). */
  head(tail: Vec3, tip: Vec3, size: number, material: MeshBasicMaterial, name: string): Mesh | null {
    const direction = normalize(sub(tip, tail));
    if (!direction) return null;
    const mesh = new Mesh(this.shared.cone, material);
    mesh.position.set(tip[0], tip[1], tip[2]);
    mesh.quaternion.setFromUnitVectors(UP, new Vector3(direction[0], direction[1], direction[2]));
    mesh.scale.set(size * HEAD_RADIUS, size, size * HEAD_RADIUS);
    mesh.name = name;
    this.group.add(mesh);
    return mesh;
  }

  /**
   * Cone heads with their apexes at the tips, each pointing along its direction: one instanced mesh (one draw call).
   * The instance matrices are a GPU buffer of their own, so the mesh is registered for disposal.
   */
  heads(heads: readonly { tip: Vec3; direction: Vec3; size: number }[], material: MeshBasicMaterial, name: string): InstancedMesh | null {
    if (!heads.length) return null;
    const mesh = this.resources.add('geometry', new InstancedMesh(this.shared.cone, material, heads.length));
    const matrix = new Matrix4(), rotation = new Quaternion(), position = new Vector3(), size = new Vector3();
    heads.forEach((head, i) => {
      rotation.setFromUnitVectors(UP, new Vector3(...head.direction));
      matrix.compose(position.set(...head.tip), rotation, size.set(head.size * HEAD_RADIUS, head.size, head.size * HEAD_RADIUS));
      mesh.setMatrixAt(i, matrix);
    });
    mesh.name = name;
    this.group.add(mesh);
    return mesh;
  }

  /**
   * A faint copy drawn after everything and without the depth test, so the parts of a data mark hidden behind a
   * sampled surface stay visible (dimmed) instead of disappearing; visible parts look unchanged.
   */
  ghost<T extends Mesh | LineSegments2 | InstancedMesh>(object: T | null): void {
    if (!object) return;
    const source = object.material as MeshBasicMaterial | LineMaterial;
    const material = this.resources.add('material', source.clone());
    Object.assign(material, { depthTest: false, depthWrite: false, transparent: true, opacity: GHOST_OPACITY });
    if (material instanceof LineMaterial) this.lineMaterials.push(material);
    const copy = (object instanceof InstancedMesh ? this.resources.add('geometry', object.clone()) : object.clone()) as T;
    copy.material = material;
    copy.renderOrder = 10;
    copy.name = `ghost:${object.name}`;
    this.group.add(copy);
  }

  /** Glyph solids of one shape at the given points: one instanced mesh (one draw call); crosses are one line object. */
  glyphs(glyph: Glyph, at: readonly Vec3[], size: number, material: MeshBasicMaterial, stroke: string, name: string): InstancedMesh | null {
    if (!at.length) return null;
    if (glyph === 'cross') {
      const pairs: number[] = [];
      for (const point of at) for (let axis = 0; axis < 3; axis++) {
        const a: Vec3 = [...point], b: Vec3 = [...point];
        a[axis] -= size * 1.4; b[axis] += size * 1.4;
        pairs.push(...a, ...b);
      }
      this.lines(pairs, stroke, LINE_WIDTH.regular, 'solid', name);
      return null;
    }
    const geometry = glyph === 'square' ? this.shared.box : glyph === 'diamond' ? this.shared.octahedron : glyph === 'triangle' ? this.shared.tetrahedron : this.shared.sphere;
    const mesh = this.resources.add('geometry', new InstancedMesh(geometry, material, at.length));
    const matrix = new Matrix4();
    at.forEach((point, i) => { matrix.makeScale(size, size, size).setPosition(point[0], point[1], point[2]); mesh.setMatrixAt(i, matrix); });
    mesh.name = name;
    this.group.add(mesh);
    return mesh;
  }
}

/** Opacity of the occlusion ghosts of arrows and points (drawn only when a surface can hide them). */
const GHOST_OPACITY = 0.38;

const widthOf = (style: PlannedStyle): number => LINE_WIDTH[style.weight] * (style.selected ? 1.6 : 1);
/** Arrowhead length: a fraction of the arrow, capped relative to the box so long vectors keep readable heads. */
export const headSize = (length: number, radius: number): number => Math.min(0.25 * length, 0.065 * radius);
/** Cone base radius as a fraction of its length. */
export const HEAD_RADIUS = 0.34;
const pointSize = (style: PlannedStyle, radius: number): number => radius * (style.weight === 'bold' ? 0.022 : style.weight === 'thin' ? 0.014 : 0.018) * (style.selected ? 1.3 : 1);
/** Items grouped by a key, in first-seen order. */
function groupBy<T>(items: readonly T[], key: (item: T) => string): T[][] {
  const groups = new Map<string, T[]>();
  for (const item of items) { const id = key(item); const list = groups.get(id); if (list) list.push(item); else groups.set(id, [item]); }
  return [...groups.values()];
}

/**
 * Draw calls of a built object tree, as the WebGL renderer issues them: one per visible mesh, wide-line object or
 * non-empty instanced mesh, and two for a transparent double-sided mesh (Three.js draws its back faces, then its front
 * faces, unless `forceSinglePass` is set) — the sampled surface.
 */
export function countDrawCalls(root: Object3D): number {
  let calls = 0;
  root.traverseVisible(object => {
    if (object instanceof InstancedMesh) { if (object.count > 0) calls++; return; }
    if (!(object as Mesh).isMesh) return;
    const material = (object as Mesh).material as { transparent?: boolean; side?: number; forceSinglePass?: boolean };
    calls += material.transparent && material.side === DoubleSide && !material.forceSinglePass ? 2 : 1;
  });
  return calls;
}

/**
 * Builds every planned primitive (world coordinates) into one group with a bounded number of draw calls per mark (see
 * `drawCallsOf` in plan.ts, which counts exactly the objects created here): a mark's lines are one wide-line object, its
 * arrow shafts another and its arrowheads one instanced mesh; its glyphs of one shape and fill one instanced mesh.
 */
export function buildContent(plan: SpatialPlan, frame: ViewFrame, theme: SpatialTheme, resources: ResourceGroup, shared: SharedGeometries, options: { wireframe: boolean }): BuiltScene {
  const b = new Builder(frame, theme, resources, shared);
  const arrows: RenderedArrow[] = [];
  const surfaces: BuiltScene['surfaces'] = [];
  const materials = new Map<string, MeshBasicMaterial>();
  const fill = (role: string, hollow = false) => {
    const key = `${role}:${hollow}`;
    let material = materials.get(key);
    if (!material) { material = b.basic(roleColor(theme, role), hollow ? { wireframe: true } : {}); materials.set(key, material); }
    return material;
  };

  // Only a sampled surface can hide a data mark; without one no occlusion ghosts are drawn.
  const occluding = plan.surfaces.length > 0;
  for (const surface of plan.surfaces) {
    const positions = new Float32Array(surface.vertices.length * 3);
    surface.vertices.forEach((vertex, i) => positions.set(b.world(vertex), i * 3));
    const geometry = resources.add('geometry', new BufferGeometry());
    geometry.setAttribute('position', new BufferAttribute(positions, 3));
    const index = surface.vertices.length > 65535 ? new Uint32Array(surface.triangles) : new Uint16Array(surface.triangles);
    geometry.setIndex(new BufferAttribute(index, 1));
    geometry.computeVertexNormals();
    const tint = roleColor(theme, surface.style.role);
    const material = resources.add('material', new MeshLambertMaterial({
      color: color(tint), side: DoubleSide, transparent: true, opacity: 0.72, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1,
    }));
    const mesh = new Mesh(geometry, material);
    mesh.name = `surface:${surface.markId}`;
    mesh.visible = !options.wireframe;
    b.group.add(mesh);
    const pairs: number[] = [];
    for (let i = 0; i < surface.edges.length; i += 2) pairs.push(...b.world(surface.vertices[surface.edges[i]!]!), ...b.world(surface.vertices[surface.edges[i + 1]!]!));
    const wire = b.lines(pairs, options.wireframe ? tint : theme.borderStrong, options.wireframe ? 1.25 : 1, 'solid', `surface-wire:${surface.markId}`, options.wireframe ? 1 : 0.8);
    if (wire) surfaces.push({ markId: surface.markId, mesh, wire });
  }

  for (const lines of groupBy(plan.lines, line => line.markId)) {
    const pairs: number[] = [];
    for (const line of lines) for (let i = 1; i < line.points.length; i++) pairs.push(...b.world(line.points[i - 1]!), ...b.world(line.points[i]!));
    const style = lines[0]!.style;
    b.lines(pairs, roleColor(theme, style.role), widthOf(style), style.dash, `lines:${lines[0]!.markId}`);
  }

  for (const marked of groupBy(plan.arrows, arrow => arrow.markId)) {
    const style = marked[0]!.style, markId = marked[0]!.markId;
    const shafts: number[] = [];
    const heads: { tip: Vec3; direction: Vec3; size: number }[] = [];
    for (const planned of marked) {
      const tail = b.world(planned.tail), tip = b.world(planned.tip);
      const size = headSize(Math.hypot(tip[0] - tail[0], tip[1] - tail[1], tip[2] - tail[2]), b.radius);
      const direction = normalize(sub(tip, tail))!;
      // The shaft stops inside the cone so its square end never pokes through the apex.
      shafts.push(...tail, tip[0] - direction[0] * size * 0.8, tip[1] - direction[1] * size * 0.8, tip[2] - direction[2] * size * 0.8);
      heads.push({ tip, direction, size });
    }
    const shaft = b.lines(shafts, roleColor(theme, style.role), widthOf(style), style.dash, `shafts:${markId}`);
    const head = b.heads(heads, fill(style.role), `heads:${markId}`)!;
    marked.forEach((planned, index) => arrows.push({ markId: planned.markId, segmentId: planned.segmentId, tail: b.world(planned.tail), tip: b.world(planned.tip), head: { mesh: head, index } }));
    if (occluding) { b.ghost(shaft); b.ghost(head); }
  }

  for (const group of groupBy(plan.points, point => `${point.markId}\u0000${point.glyph}\u0000${point.hollow}`)) {
    const first = group[0]!;
    const stroke = roleColor(theme, first.style.role);
    const mesh = b.glyphs(first.glyph, group.map(point => b.world(point.at)), pointSize(first.style, b.radius), fill(first.style.role, first.hollow), stroke, `points:${first.markId}:${first.glyph}:${first.hollow}`);
    if (occluding) b.ghost(mesh);
  }

  for (const field of plan.fields) {
    const stroke = roleColor(theme, field.style.role);
    const pairs: number[] = [];
    const heads: { tip: Vec3; direction: Vec3; size: number }[] = [];
    for (const sample of field.arrows) {
      const tail = b.world(sample.at), tip = b.world(sample.tip);
      const direction = normalize(sub(tip, tail));
      if (!direction) continue;
      const size = headSize(Math.hypot(tip[0] - tail[0], tip[1] - tail[1], tip[2] - tail[2]), b.radius) * 0.7;
      pairs.push(...tail, tip[0] - direction[0] * size * 0.8, tip[1] - direction[1] * size * 0.8, tip[2] - direction[2] * size * 0.8);
      heads.push({ tip, direction, size });
    }
    b.lines(pairs, stroke, widthOf(field.style), field.style.dash, `field:${field.key}`);
    b.heads(heads, fill(field.style.role), `field-heads:${field.key}`);
    b.glyphs('circle', field.zero.map(at => b.world(at)), pointSize(field.style, b.radius) * 0.6, fill(field.style.role), stroke, `field-zero:${field.key}`);
  }
  return { group: b.group, lineMaterials: b.lineMaterials, arrows, surfaces };
}

export interface BuiltAxes { group: Group; lineMaterials: LineMaterial[]; tips: Vec3[] }
/**
 * Axes through the crossing point, each with an arrowhead at its positive end, tick marks and its own line pattern
 * (x solid, y dashed, z dotted), plus a faint floor grid in the horizontal plane through the crossing point.
 */
export function buildAxes(frame: ViewFrame, theme: SpatialTheme, resources: ResourceGroup, shared: SharedGeometries): BuiltAxes {
  const b = new Builder(frame, theme, resources, shared);
  const { bounds, axisOrigin, ticks } = frame;
  const tips: Vec3[] = [];
  const tick = frame.radius * 0.025;
  for (let axis = 0; axis < 3; axis++) {
    const start: Vec3 = [...axisOrigin], end: Vec3 = [...axisOrigin];
    start[axis] = bounds[axis * 2]!; end[axis] = bounds[axis * 2 + 1]!;
    const tail = b.world(start), tip = b.world(end);
    const extended: Vec3 = [...tip];
    extended[axis] += frame.radius * 0.06;
    const stroke = theme.axes[axis]!;
    const size = frame.radius * 0.05;
    const direction: Vec3 = [0, 0, 0];
    direction[axis] = 1;
    b.lines([...tail, extended[0] - direction[0] * size * 0.8, extended[1] - direction[1] * size * 0.8, extended[2] - direction[2] * size * 0.8], stroke, 1.75, AXIS_DASH[axis]!, `axis:${axis}`);
    b.head(tail, extended, size, b.basic(stroke), `axis-head:${axis}`);
    tips.push(extended);
    // Tick marks perpendicular to the axis (along y for x and z, along x for y).
    const across = axis === 1 ? 0 : 1;
    const pairs: number[] = [];
    for (const value of ticks[axis]!.values) {
      const at: Vec3 = [...axisOrigin];
      at[axis] = value;
      const w = b.world(at);
      const a: Vec3 = [...w], c: Vec3 = [...w];
      a[across] -= tick; c[across] += tick;
      pairs.push(...a, ...c);
    }
    b.lines(pairs, stroke, 1.25, 'solid', `ticks:${axis}`);
  }
  // Outline of the authored box (a depth cue; the box is the teaching frame, never rescaled to the data).
  const box: number[] = [];
  const corner = (i: number, j: number, k: number): number[] => b.world([bounds[i]!, bounds[2 + j]!, bounds[4 + k]!]);
  for (const [j, k] of [[0, 0], [1, 0], [0, 1], [1, 1]] as const) box.push(...corner(0, j, k), ...corner(1, j, k));
  for (const [i, k] of [[0, 0], [1, 0], [0, 1], [1, 1]] as const) box.push(...corner(i, 0, k), ...corner(i, 1, k));
  for (const [i, j] of [[0, 0], [1, 0], [0, 1], [1, 1]] as const) box.push(...corner(i, j, 0), ...corner(i, j, 1));
  b.lines(box, theme.border, 1, 'solid', 'box');
  // Floor grid at the crossing height, one line per x and y tick.
  const floor: number[] = [];
  const z = axisOrigin[2];
  // Lines that would coincide with an axis or a box edge are left out (coincident lines flicker in the depth test).
  const free = (value: number, axis: 0 | 1) => value !== axisOrigin[axis] && value !== bounds[axis * 2] && value !== bounds[axis * 2 + 1];
  for (const x of ticks[0].values.filter(value => free(value, 0))) floor.push(...b.world([x, bounds[2], z]), ...b.world([x, bounds[3], z]));
  for (const y of ticks[1].values.filter(value => free(value, 1))) floor.push(...b.world([bounds[0], y, z]), ...b.world([bounds[1], y, z]));
  b.lines(floor, theme.border, 1, 'solid', 'floor-grid', 0.8);
  return { group: b.group, lineMaterials: b.lineMaterials, tips };
}

/** Ambient plus a camera-attached directional light (shading follows the view, so the surface shape stays legible). */
export function createLights(): { ambient: AmbientLight; key: DirectionalLight } {
  const ambient = new AmbientLight(0xffffff, 1.6);
  const key = new DirectionalLight(0xffffff, 1.4);
  key.position.set(0.4, 0.8, 1);
  return { ambient, key };
}
