/**
 * Camera math and orientation presets of the spatial renderer (report §11, §13, A45): right-handed screen orientation
 * for every preset and orbit, bounded keyboard rotation and zoom, and lossless serialization to the activity
 * contract's `Camera3D` (including an anisotropic frame and the straight-down top view).
 */
import { describe, expect, it } from 'vitest';
import {
  CAMERA_LIMITS, CAMERA_PRESETS, cameraToOrbit, defaultOrbit, describeOrbit, ISOMETRIC_ELEVATION, orbitPose, orbitToCamera, presetOrbit, PRESET_ORDER,
  projectPoint, rotateOrbit, sameOrbit, wrapAzimuth, zoomOrbit, type Orbit,
} from '../../packages/player-3d/src/camera';
import { directionToWorld, toWorld, viewFrame } from '../../packages/player-3d/src/frame';
import { cross, dot, type Vec3 } from '../../packages/player-3d/src/vec';
import { view } from './support';

const cube = viewFrame(view([]));
const tall = viewFrame(view([], { bounds3: [-2.5, 2.5, -2.5, 2.5, 0, 24], equalAspect: false }));
const close = (actual: readonly number[], expected: readonly number[], digits = 9) => actual.forEach((value, i) => expect(value).toBeCloseTo(expected[i]!, digits));

/** Screen direction (CSS pixels, y down) of a world axis from the projected origin. */
function screenAxis(orbit: Orbit, axis: Vec3, frame = cube): [number, number] {
  const origin = projectPoint([0, 0, 0], orbit, frame, 400, 300), tip = projectPoint(axis, orbit, frame, 400, 300);
  return [tip[0] - origin[0], tip[1] - origin[1]];
}
/** Positive when the on-screen turn from a to b is counterclockwise as the viewer sees it (screen y flipped up). */
const turn = (a: [number, number], b: [number, number]) => a[0] * -b[1] - -a[1] * b[0];

describe('orientation presets', () => {
  it('top (x–y): x to the right, y up, z toward the viewer', () => {
    const pose = orbitPose(presetOrbit(defaultOrbit(), 'top'), cube);
    close(pose.right, [1, 0, 0]); close(pose.up, [0, 1, 0]); close(pose.forward, [0, 0, -1]);
    const x = screenAxis(presetOrbit(defaultOrbit(), 'top'), [1, 0, 0]), y = screenAxis(presetOrbit(defaultOrbit(), 'top'), [0, 1, 0]);
    expect(x[0]).toBeGreaterThan(0); expect(Math.abs(x[1])).toBeLessThan(1e-6);
    expect(y[1]).toBeLessThan(0); expect(Math.abs(y[0])).toBeLessThan(1e-6);
  });
  it('front (x–z, seen from −y): x to the right, z up', () => {
    const pose = orbitPose(presetOrbit(defaultOrbit(), 'front'), cube);
    close(pose.right, [1, 0, 0]); close(pose.up, [0, 0, 1]); close(pose.forward, [0, 1, 0]);
    expect(pose.position[1]).toBeLessThan(0);
  });
  it('side (y–z, seen from +x): y to the right, z up', () => {
    const pose = orbitPose(presetOrbit(defaultOrbit(), 'side'), cube);
    close(pose.right, [0, 1, 0]); close(pose.up, [0, 0, 1]); close(pose.forward, [-1, 0, 0]);
  });
  it('isometric: looks along −(1, 1, 1) with z up on screen and x, y, z counterclockwise', () => {
    const orbit = presetOrbit(defaultOrbit(), 'isometric');
    expect(orbit).toEqual({ azimuth: 45, elevation: ISOMETRIC_ELEVATION, zoom: 1, projection: 'orthographic', preset: 'isometric' });
    const pose = orbitPose(orbit, cube);
    close(pose.forward, [-1 / Math.sqrt(3), -1 / Math.sqrt(3), -1 / Math.sqrt(3)]);
    const [x, y, z] = ([[1, 0, 0], [0, 1, 0], [0, 0, 1]] as Vec3[]).map(axis => screenAxis(orbit, axis));
    expect(z![1]).toBeLessThan(0);
    expect(turn(x!, y!)).toBeGreaterThan(0); expect(turn(y!, z!)).toBeGreaterThan(0); expect(turn(z!, x!)).toBeGreaterThan(0);
  });
  it('the default view is from the front right and above, orthographic and unzoomed', () => {
    expect(defaultOrbit()).toEqual({ azimuth: -20, elevation: 30, zoom: 1, projection: 'orthographic', preset: null });
    expect(describeOrbit(defaultOrbit())).toBe('Default view from azimuth −20° and elevation 30°; orthographic projection.');
    // The starting vectors of the bundled vector activity and the axes are each at least 30° from the line of sight, and
    // on screen no starting vector runs within 20° of another one or of an axis.
    const forward = orbitPose(defaultOrbit(), cube).forward;
    const starting: Vec3[] = [[2, 1, 0], [1, 2, 2], [2, -4, 3]];
    const axes: Vec3[] = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
    for (const vector of [...starting, ...axes]) expect(Math.acos(Math.abs(dot(forward, vector) / Math.hypot(...vector))) * 180 / Math.PI, String(vector)).toBeGreaterThan(30);
    const heading = (vector: Vec3) => { const [sx, sy] = screenAxis(defaultOrbit(), vector); return Math.atan2(-sy, sx) * 180 / Math.PI; };
    const apart = (a: number, b: number) => { const d = Math.abs(a - b) % 360; return d > 180 ? 360 - d : d; };
    for (const vector of starting) for (const other of [...starting, ...axes]) if (other !== vector) expect(apart(heading(vector), heading(other)), `${vector} vs ${other}`).toBeGreaterThan(20);
    const [x, y, z] = ([[1, 0, 0], [0, 1, 0], [0, 0, 1]] as Vec3[]).map(axis => screenAxis(defaultOrbit(), axis));
    expect(z![1]).toBeLessThan(0);
    expect(turn(x!, y!)).toBeGreaterThan(0);
  });
  it('labels and descriptions name the planes and viewing sides', () => {
    expect(PRESET_ORDER.map(id => CAMERA_PRESETS[id].label)).toEqual(['Isometric', 'Front (x–z)', 'Top (x–y)', 'Side (y–z)']);
    expect(describeOrbit(presetOrbit(defaultOrbit(), 'front'))).toBe('Front (x–z) view: front view of the x–z plane, seen from −y: x to the right, z up; orthographic projection.');
  });
});

describe('handedness for any orbit', () => {
  const orbits: Orbit[] = [];
  for (let azimuth = -165; azimuth <= 180; azimuth += 15) for (const elevation of [-90, -60, -15, 0, 15, 35, 60, 90]) orbits.push({ ...defaultOrbit(), azimuth, elevation, preset: null });

  it('screen right × screen up = toward the viewer (the camera never mirrors or rolls the frame)', () => {
    for (const orbit of orbits) {
      const pose = orbitPose(orbit, cube);
      expect(dot(cross(pose.right, pose.up), pose.forward), JSON.stringify(orbit)).toBeCloseTo(-1, 9);
      expect(pose.right[2]).toBe(0);
    }
  });
  it('from above (ε > 0) the turn from x to y appears counterclockwise, from below clockwise, in both projections', () => {
    for (const projection of ['orthographic', 'perspective'] as const) for (const orbit of orbits) {
      if (orbit.elevation === 0) continue; // x and y may project onto one line when seen edge-on
      const o = { ...orbit, projection };
      const sign = Math.sign(turn(screenAxis(o, [1, 0, 0]), screenAxis(o, [0, 1, 0])));
      expect(sign, JSON.stringify(o)).toBe(orbit.elevation > 0 ? 1 : -1);
    }
  });
  it('an anisotropic frame keeps positive scales (no mirrored axis)', () => {
    expect(tall.scale.every(value => value > 0)).toBe(true);
    expect(tall.scale[2]).toBeCloseTo((0.75 * 5) / 24, 12);
    expect(tall.aspectNote).toBe('The vertical axis z is drawn at its own scale: one unit along it is drawn 0.16 times as long as one unit along x and y.');
  });
});

describe('bounded rotation and zoom', () => {
  it('rotates in the requested steps, wraps azimuth and clamps elevation to ±90°', () => {
    let orbit = defaultOrbit();
    orbit = rotateOrbit(orbit, CAMERA_LIMITS.rotateStep, 0);
    expect(orbit.azimuth).toBe(-5);
    expect(orbit.preset).toBeNull();
    for (let i = 0; i < 20; i++) orbit = rotateOrbit(orbit, CAMERA_LIMITS.rotateStep, CAMERA_LIMITS.rotateStep);
    expect(orbit.elevation).toBe(90);
    expect(orbit.azimuth).toBeGreaterThan(-180); expect(orbit.azimuth).toBeLessThanOrEqual(180);
    expect(wrapAzimuth(181)).toBe(-179); expect(wrapAzimuth(-180)).toBe(180); expect(wrapAzimuth(360)).toBe(0);
    for (let i = 0; i < 20; i++) orbit = rotateOrbit(orbit, 0, -CAMERA_LIMITS.rotateStep);
    expect(orbit.elevation).toBe(-90);
  });
  it('zooms by 1.25 per step within 0.25×–4×', () => {
    let orbit = defaultOrbit();
    orbit = zoomOrbit(orbit, CAMERA_LIMITS.zoomStep);
    expect(orbit.zoom).toBe(1.25);
    for (let i = 0; i < 20; i++) orbit = zoomOrbit(orbit, CAMERA_LIMITS.zoomStep);
    expect(orbit.zoom).toBe(4);
    for (let i = 0; i < 40; i++) orbit = zoomOrbit(orbit, 1 / CAMERA_LIMITS.zoomStep);
    expect(orbit.zoom).toBe(0.25);
  });
  it('the default view fits the whole box (all eight corners inside the viewport) in both projections and narrow viewports', () => {
    for (const frame of [cube, tall]) for (const projection of ['orthographic', 'perspective'] as const) for (const [w, h] of [[640, 480], [358, 268], [300, 600]]) {
      const b = frame.bounds;
      for (const x of [b[0], b[1]]) for (const y of [b[2], b[3]]) for (const z of [b[4], b[5]]) {
        const [sx, sy] = projectPoint(toWorld(frame, [x, y, z]), { ...defaultOrbit(), projection }, frame, w!, h!);
        expect(sx).toBeGreaterThanOrEqual(0); expect(sx).toBeLessThanOrEqual(w!);
        expect(sy).toBeGreaterThanOrEqual(0); expect(sy).toBeLessThanOrEqual(h!);
      }
    }
  });
});

describe('serialization (Camera3D)', () => {
  it('round-trips orbits through model coordinates, also for an anisotropic frame', () => {
    for (const frame of [cube, tall]) for (const orbit of [defaultOrbit(), rotateOrbit(zoomOrbit(defaultOrbit('perspective'), 1.25), -30, 15), presetOrbit(defaultOrbit(), 'top'), { ...defaultOrbit(), azimuth: 170, elevation: -45, preset: null }]) {
      const camera = orbitToCamera(orbit, frame);
      expect(camera.kind).toBe('3d');
      const back = cameraToOrbit(camera, frame);
      expect(back && sameOrbit(back, orbit), `${JSON.stringify(orbit)} → ${JSON.stringify(camera)} → ${JSON.stringify(back)}`).toBe(true);
    }
  });
  it('stores the target at the box centre in canonical units and the up direction as a unit model vector', () => {
    const camera = orbitToCamera(presetOrbit(defaultOrbit(), 'front'), tall);
    expect(camera.target).toEqual([0, 0, 12]);
    expect(camera.up).toEqual([0, 0, 1]);
    expect(camera.preset).toBe('front');
    expect(camera.position[1]).toBeLessThan(0);
  });
  it('restores the straight-down view from `up` when no preset name is given', () => {
    const camera = { ...orbitToCamera(presetOrbit(defaultOrbit(), 'top'), cube), preset: null };
    const orbit = cameraToOrbit(camera, cube)!;
    expect(orbit.elevation).toBe(90);
    expect(orbit.azimuth).toBeCloseTo(-90, 6);
    close(orbitPose(orbit, cube).up, [0, 1, 0], 6);
  });
  it('rejects malformed cameras instead of guessing (the default view is used)', () => {
    const good = orbitToCamera(defaultOrbit(), cube);
    for (const bad of [null, {}, { ...good, kind: '2d' }, { ...good, projection: 'fisheye' }, { ...good, position: [NaN, 0, 0] }, { ...good, position: good.target }, { ...good, up: [0, 0] }])
      expect(cameraToOrbit(bad, cube), JSON.stringify(bad)).toBeNull();
  });
  it('clamps an out-of-range restored zoom to the bounds', () => {
    const far = { ...orbitToCamera(defaultOrbit(), cube), position: [1000, 1000, 1000] as [number, number, number], preset: null };
    expect(cameraToOrbit(far, cube)!.zoom).toBe(CAMERA_LIMITS.minZoom);
  });
  it('maps directions with the frame scale (world ↔ model)', () => {
    close(directionToWorld(tall, [0, 0, 24]), [0, 0, 3.75]);
  });
});
