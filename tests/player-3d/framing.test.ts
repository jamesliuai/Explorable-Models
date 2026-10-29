/**
 * Default framing of the 3D view and label obstacles (report §10.4, §13; G55): at zoom 1 the camera fits the axes, their
 * names and the drawn data inside the box — not the box's bounding sphere — so small data in a teaching box reads on a
 * narrow card; everything it frames stays in view in every preset and viewport shape; `Whole box` shows the entire
 * box; labels never cover an arrowhead and avoid shafts where they can.
 */
import { describe, expect, it } from 'vitest';
import { CAMERA_PRESETS, defaultOrbit, framingRadius, presetOrbit, projectPoint, wholeBoxZoom, type Orbit } from '../../packages/player-3d/src/camera';
import { toWorld, viewFrame, type ViewFrame } from '../../packages/player-3d/src/frame';
import { capsuleHitsBox, chooseLabelBox, segmentBoxDistance, type Box } from '../../packages/player-3d/src/layout';
import { axisLabels } from '../../packages/player-3d/src/plan';
import type { Vec3 } from '../../packages/player-3d/src/vec';
import { view } from './support';

const cube4 = viewFrame(view([], { bounds3: [-4, 4, -4, 4, -4, 4] }));
const cube6 = viewFrame(view([]));
const U: Vec3 = [2, 1, 0], V: Vec3 = [1, 2, 2];
const framed = (frame: ViewFrame, data: Vec3[]): ViewFrame => ({ ...frame, framing: framingRadius(frame, data) });
const SIZES = [[320, 240], [296, 240], [390, 292], [640, 480], [300, 600]] as const;
function inView(frame: ViewFrame, orbit: Orbit, point: Vec3, w: number, h: number): boolean {
  const [x, y] = projectPoint(toWorld(frame, point), orbit, frame, w, h);
  return x >= 0 && x <= w && y >= 0 && y <= h;
}

describe('default framing (zoom 1)', () => {
  it('fits the axes and their names with a label margin, not the box’s bounding sphere', () => {
    const radius = framingRadius(cube4, [[0, 0, 0], U, V]);
    const axisName = Math.max(...axisLabels(cube4).filter(label => label.kind === 'axis').map(label => Math.hypot(...toWorld(cube4, label.at))));
    expect(radius).toBeCloseTo(axisName * 1.1, 9);
    expect(radius / cube4.radius).toBeLessThan(0.75);
  });
  it('grows to frame data inside the box, and ignores data drawn outside the box', () => {
    const corner: Vec3 = [3.9, 3.9, 3.9];
    expect(framingRadius(cube4, [corner])).toBeCloseTo(Math.hypot(...corner) * 1.1, 9);
    expect(framingRadius(cube4, [[2, -12, 9]])).toBe(framingRadius(cube4, []));
  });
  it('keeps every framed point in view in every preset, both projections and narrow, wide and portrait viewports', () => {
    const data: Vec3[] = [U, V, [2, -4, 3], [0, 0, 0]];
    const frame = framed(cube4, data);
    const axisEnds = [0, 1, 2].flatMap(axis => [-1, 1].map(sign => { const p: Vec3 = [0, 0, 0]; p[axis] = 4 * sign; return p; }));
    const labels = axisLabels(frame).filter(label => label.kind === 'axis').map(label => label.at);
    for (const projection of ['orthographic', 'perspective'] as const)
      for (const orbit of [defaultOrbit(projection), ...Object.keys(CAMERA_PRESETS).map(preset => presetOrbit(defaultOrbit(projection), preset as keyof typeof CAMERA_PRESETS))])
        for (const [w, h] of SIZES) for (const point of [...data, ...axisEnds, ...labels]) expect(inView(frame, orbit, point, w, h), `${projection} ${orbit.preset} ${w}×${h} ${point}`).toBe(true);
  });
  it('draws the default vectors several times larger than the whole-box fit did', () => {
    const frame = framed(cube4, [U, V]);
    const length = (f: ViewFrame, point: Vec3) => { const [x0, y0] = projectPoint(toWorld(f, [0, 0, 0]), defaultOrbit(), f, 296, 240), [x1, y1] = projectPoint(toWorld(f, point), defaultOrbit(), f, 296, 240); return Math.hypot(x1 - x0, y1 - y0); };
    expect(length(frame, V) / length(cube6, V)).toBeGreaterThan(2);
    expect(length(frame, V) / 240).toBeGreaterThan(0.25);
    expect(length(frame, U) / 240).toBeGreaterThan(0.16);
  });
  it('Whole box shows all eight corners of the box again', () => {
    const frame = framed(cube4, [U, V]);
    const orbit = { ...defaultOrbit(), zoom: wholeBoxZoom(frame) };
    expect(orbit.zoom).toBeCloseTo(frame.framing! / frame.radius, 9);
    const b = frame.bounds;
    for (const [w, h] of SIZES) for (const x of [b[0], b[1]]) for (const y of [b[2], b[3]]) for (const z of [b[4], b[5]]) expect(inView(frame, orbit, [x, y, z], w, h)).toBe(true);
  });
});

describe('label obstacles', () => {
  const head = { from: [100, 100] as const, to: [120, 100] as const, radius: 6 };
  const shaft = { from: [20, 100] as const, to: [100, 100] as const, radius: 3 };
  it('measures segment–box distances', () => {
    expect(segmentBoxDistance([0, 0], [10, 0], [2, -1, 4, 1])).toBe(0);
    expect(segmentBoxDistance([0, 5], [10, 5], [2, -1, 4, 1])).toBeCloseTo(4, 9);
    expect(capsuleHitsBox(head, [118, 90, 140, 103])).toBe(true);
    expect(capsuleHitsBox(head, [127, 90, 140, 103])).toBe(false);
  });
  it('never places a label over an arrowhead; avoids shafts and placed labels when it can', () => {
    const onHead: Box = [104, 95, 124, 105], onShaft: Box = [40, 95, 60, 105], free: Box = [40, 60, 60, 70], taken: Box = [38, 58, 62, 72];
    expect(chooseLabelBox([onHead, onShaft, free], [], [head], [shaft])).toEqual(free);
    expect(chooseLabelBox([onHead, onShaft], [], [head], [shaft])).toEqual(onShaft);
    expect(chooseLabelBox([onHead, free, onShaft], [taken], [head], [shaft])).toEqual(onShaft);
    expect(chooseLabelBox([onHead], [], [head], [shaft])).toBeNull();
  });
});
