import type { ParameterSpec, QuantitySpec, VisualizationDocument } from '@explorable-models/core/declarative';

const p = (label: string, value: number, min: number, max: number, step: number, unit = '', dimension?: string): ParameterSpec => ({ label, value, min, max, step, unit, ...(dimension ? { dimension } : {}) });
const q = (expression: QuantitySpec['expression'], label: string, unit = '', dimension?: string): QuantitySpec => ({ expression, label, unit, ...(dimension ? { dimension } : {}) });
const base = { schemaVersion: '2.0' as const, provenance: { review: 'unreviewed' as const, checks: 'author' as const, authoredBy: 'Explorable Models showcase' } };

export const projectile: VisualizationDocument = {
  ...base, id: 'showcase-projectile', title: 'One launch. Every moment.',
  description: 'An analytical projectile with a finite flight domain and an exact ground-impact endpoint.',
  parameters: { angle: p('Launch angle', 50, 10, 80, .1, '°'), speed: p('Launch speed', 18, 5, 30, .1, 'm/s', 'velocity'), height: p('Launch height', 1, 0, 10, .1, 'm', 'length') },
  quantities: {
    g: q(9.81, 'Gravity', 'm/s²', 'acceleration'), theta: q('angle*pi/180', 'Launch angle in radians', 'rad'),
    vx: q('speed*cos(theta)', 'Horizontal velocity', 'm/s', 'velocity'), vy0: q('speed*sin(theta)', 'Initial vertical velocity', 'm/s', 'velocity'),
    flight: q('(vy0+sqrt(vy0^2+2*g*height))/g', 'Flight time', 's', 'time'),
    range: q('vx*flight', 'Range', 'm', 'length'), apex: q('height+vy0^2/(2*g)', 'Apex height', 'm', 'length'),
    x: q('vx*time', 'Horizontal position', 'm', 'length'), y: q('max(0,height+vy0*time-g*time^2/2)', 'Height', 'm', 'length'),
    position: q('[x,y]', 'Projectile position', 'm', 'length'), velocity: q('[vx,vy0-g*time]', 'Velocity', 'm/s', 'velocity'),
    apexPoint: q('[vx*vy0/g,apex]', 'Apex position', 'm', 'length'), landing: q('[range,0]', 'Landing position', 'm', 'length'),
  },
  time: { end: 'flight', step: 1 / 30 },
  series: { trajectory: { label: 'Predicted flight', variable: 'u', x: 'vx*u*flight', y: 'max(0,height+vy0*u*flight-g*(u*flight)^2/2)', domain: [0, 1], samples: 241, kind: 'model' } },
  views: [{ id: 'trajectory', type: 'plot', title: 'Flight', marks: [{ id: 'flight-path', type: 'line', label: 'Trajectory', series: 'trajectory' }] }, { id: 'values', type: 'values', title: 'Flight summary', quantities: ['range', 'apex', 'flight', 'x', 'y'] }],
  assumptions: ['Point projectile, uniform gravity 9.81 m/s², no air resistance.', 'Flat ground at y = 0; height is measured from ground.'],
  limitations: ['Playback ends exactly at impact; terminal velocity is the pre-collision velocity.', 'No bounce, drag, wind, or finite projectile size.', 'Position uses equal axis scales. Velocity arrows use a separate fixed illustrative scale.'],
};

export const forces: VisualizationDocument = {
  ...base, id: 'showcase-forces', title: 'What keeps the block still?', description: 'Resolve gravity, contact force and friction on an inclined plane.',
  parameters: { angle: p('Ramp angle', 25, 0, 50, .1, '°'), mass: p('Block mass', 4, 1, 8, .1, 'kg', 'mass'), friction: p('Friction coefficient', .25, 0, .8, .01, 'μ') },
  quantities: {
    g: q(9.81, 'Gravity', 'm/s²', 'acceleration'), theta: q('angle*pi/180', 'Ramp angle', 'rad'),
    weight: q('mass*g', 'Weight', 'N', 'force'), normal: q('weight*cos(theta)', 'Normal force', 'N', 'force'),
    downhill: q('weight*sin(theta)', 'Down-slope gravity', 'N', 'force'), capacity: q('friction*normal', 'Friction limit', 'N', 'force'),
    resistance: q('min(downhill,capacity)', 'Friction force', 'N', 'force'), net: q('max(0,downhill-capacity)', 'Net down-slope force', 'N', 'force'),
    acceleration: q('net/mass', 'Down-slope acceleration', 'm/s²', 'acceleration'),
    tangent: q('[cos(theta),sin(theta)]', 'Up-slope unit vector'), perpendicular: q('[-sin(theta),cos(theta)]', 'Outward normal unit vector'),
    weightVector: q('[0,-weight]', 'Weight vector', 'N', 'force'), normalVector: q('normal*perpendicular', 'Normal vector', 'N', 'force'), frictionVector: q('resistance*tangent', 'Friction vector', 'N', 'force'),
    netVector: q('-net*tangent', 'Net force vector', 'N', 'force'),
    rampEnd: q('4*tangent', 'Ramp end in schematic coordinates'),
    blockA: q('1.5*tangent', 'Block lower-left'), blockB: q('2.5*tangent', 'Block lower-right'),
    blockC: q('2.5*tangent+.65*perpendicular', 'Block upper-right'), blockD: q('1.5*tangent+.65*perpendicular', 'Block upper-left'),
  },
  views: [{ id: 'values', type: 'values', title: 'Forces and motion', quantities: ['weight', 'normal', 'resistance', 'net', 'acceleration'] }],
  assumptions: ['Rigid block on a fixed plane, released from rest.', 'One coefficient μ represents both the static limit and kinetic friction.', 'At rest, friction matches down-slope gravity up to μN; once it slips, friction equals μN.'],
  limitations: ['This is a force-balance snapshot, not a sliding time simulation.', 'Real static and kinetic coefficients usually differ.', 'The ramp is a schematic; force arrow lengths share a fixed scale of 1.4 SVG units/N.'],
};

export const waves: VisualizationDocument = {
  ...base, id: 'showcase-waves', title: 'Two waves. One surprising sum.', description: 'See constructive and destructive interference of equal-wavelength waves.',
  parameters: { phase: p('Relative phase', 120, 0, 360, 1, '°'), a: p('Wave A amplitude', 1, 0, 1.5, .01, 'cm'), b: p('Wave B amplitude', 1, 0, 1.5, .01, 'cm') },
  quantities: { phi: q('phase*pi/180', 'Phase in radians', 'rad'), resultant: q('sqrt(max(0,a*a+b*b+2*a*b*cos(phi)))', 'Resultant amplitude', 'cm'), aligned: q('a+b', 'Aligned amplitude', 'cm'), fraction: q('100*resultant/(a+b)', 'Fraction of aligned amplitude', '%'), phaseDegrees: q('phase', 'Relative phase', '°') },
  series: {
    a: { label: 'Wave A', x: 'u', y: 'a*sin(2*pi*u)', variable: 'u', domain: [0, 3], samples: 361, kind: 'model' },
    b: { label: 'Wave B', x: 'u', y: 'b*sin(2*pi*u+phi)', variable: 'u', domain: [0, 3], samples: 361, kind: 'model' },
    sum: { label: 'Superposition', x: 'u', y: 'a*sin(2*pi*u)+b*sin(2*pi*u+phi)', variable: 'u', domain: [0, 3], samples: 361, kind: 'model' },
  },
  views: [{ id: 'plot', type: 'plot', title: 'Superposition', marks: [{ id: 'a', type: 'line', label: 'Wave A', series: 'a' }, { id: 'b', type: 'line', label: 'Wave B', series: 'b' }, { id: 'sum', type: 'line', label: 'Sum', series: 'sum' }] }, { id: 'values', type: 'values', title: 'Result', quantities: ['resultant', 'fraction'] }],
  assumptions: ['Two sinusoidal displacement waves with identical wavelength and frequency.', 'Linear superposition; x is measured in wavelengths and displacement in centimetres.'],
  limitations: ['A spatial snapshot; changing phase is not a simulation of propagation.', 'Relative amplitude is undefined when both input amplitudes are zero.', 'Component and sum panels deliberately use different labeled vertical scales.'],
};

export const light: VisualizationDocument = {
  ...base, id: 'showcase-light', title: 'Where does the light go?', description: 'Explore Snell’s law and the boundary where refraction becomes total internal reflection.',
  parameters: { angle: p('Incident angle', 42, 0, 80, .1, '°'), n1: p('Upper refractive index', 1, 1, 2.4, .01, 'n₁'), n2: p('Lower refractive index', 1.5, 1, 2.4, .01, 'n₂') },
  quantities: {
    theta: q('angle*pi/180', 'Incident angle', 'rad'), ratio: q('n1/n2', 'Speed ratio v₂/v₁'), sine: q('ratio*sin(theta)', 'Transmitted sine'),
    transmitted: q('asin(sine)*180/pi', 'Refracted angle', '°'), incident: q('[-sin(theta),cos(theta)]', 'Incident start direction'),
    reflected: q('[sin(theta),cos(theta)]', 'Reflected direction'), refracted: q('[sine,-sqrt(1-sine*sine)]', 'Refracted direction'),
  },
  views: [{ id: 'values', type: 'values', title: 'Snell’s law', quantities: ['transmitted', 'ratio', 'sine'] }],
  assumptions: ['A ray at a flat interface between transparent, isotropic media.', 'Angles are measured from the interface normal; n₁ sin θ₁ = n₂ sin θ₂.'],
  limitations: ['Ray directions only; no Fresnel intensity, polarization, dispersion, or wave effects.', 'When n₁ sin θ₁/n₂ > 1 there is no propagating refracted ray; its direction and angle are explicitly undefined.', 'A reflected ray is shown even below the critical angle; stroke opacity does not encode intensity.'],
};

const matrixQuantities: Record<string, QuantitySpec> = {
  origin: q([0, 0], 'Origin'), e1: q('[stretch,0]', 'Image of the x basis vector'), e2: q('[shear,vertical]', 'Image of the y basis vector'),
  corner: q('[stretch+shear,vertical]', 'Image of (1,1)'), determinant: q('stretch*vertical', 'Signed determinant'), area: q('abs(determinant)', 'Transformed unit-square area'),
};
// Authoring creates bounded expression strings, never evaluates model mathematics in Node.
for (let i = -3; i <= 3; i++) {
  matrixQuantities[`gridX${i + 3}a`] = q(`[stretch*${i}-3*shear,-3*vertical]`, 'Transformed grid endpoint');
  matrixQuantities[`gridX${i + 3}b`] = q(`[stretch*${i}+3*shear,3*vertical]`, 'Transformed grid endpoint');
  matrixQuantities[`gridY${i + 3}a`] = q(`[-3*stretch+shear*${i},vertical*${i}]`, 'Transformed grid endpoint');
  matrixQuantities[`gridY${i + 3}b`] = q(`[3*stretch+shear*${i},vertical*${i}]`, 'Transformed grid endpoint');
}
export const matrix: VisualizationDocument = {
  ...base, id: 'showcase-matrix', title: 'A matrix you can move.', description: 'Stretch, shear, reverse, or collapse a plane with one linear map.',
  parameters: { stretch: p('Horizontal stretch', 1.4, -1.5, 2, .01, 'sₓ'), shear: p('Shear', .8, -1.5, 1.5, .01, 'h'), vertical: p('Vertical stretch', 1.2, 0, 2, .01, 'sᵧ') },
  quantities: matrixQuantities,
  views: [{ id: 'values', type: 'values', title: 'The map', quantities: ['e1', 'e2', 'corner', 'determinant', 'area'] }],
  assumptions: ['Column-vector convention: M = [[sₓ,h],[0,sᵧ]].', 'The initial square has area 1; its image is the parallelogram spanned by the transformed basis vectors.'],
  limitations: ['This three-parameter family is not every possible 2×2 matrix.', 'Area is |det M|; a negative determinant reverses orientation.', 'The view clips the grid to a fixed window and uses equal coordinate scales.'],
};

export const probability: VisualizationDocument = {
  ...base, id: 'showcase-probability', title: 'A flag is not a verdict.', description: 'Why a capable fault detector can still produce mostly false alarms.',
  parameters: { prevalence: p('Faulty parts', 1, 0, 50, .1, '%'), sensitivity: p('Fault detection rate', 90, 0, 100, .1, '%'), falseAlarm: p('False-alarm rate', 5, 0, 20, .1, '%') },
  quantities: {
    population: q(1000, 'Parts inspected'), faulty: q('population*prevalence/100', 'Faulty parts'), sound: q('population-faulty', 'Sound parts'),
    trueFlags: q('faulty*sensitivity/100', 'Correct flags'), falseFlags: q('sound*falseAlarm/100', 'False flags'),
    flagged: q('trueFlags+falseFlags', 'Flagged parts'), clear: q('population-flagged', 'Unflagged parts'),
    precision: q('100*trueFlags/flagged', 'P(faulty | flagged)', '%'), missed: q('faulty-trueFlags', 'Missed faulty parts'),
  },
  views: [{ id: 'values', type: 'values', title: 'Expected frequencies', quantities: ['trueFlags', 'falseFlags', 'flagged', 'precision', 'missed'] }],
  assumptions: ['Illustrative factory quality-control model with 1,000 inspected parts.', 'Detection and false-alarm rates are constant across the population.', 'Counts are expected frequencies, not an actual sample.'],
  limitations: ['Fractional cells represent fractional expected counts; no random sampling or rounding to whole parts.', 'If no parts are flagged, the conditional probability is undefined.', 'A detector flag is not proof of a fault; this model does not infer costs or recommend operational policy.'],
};

export const documents = { projectile, forces, waves, light, matrix, probability };
export type ExampleId = keyof typeof documents;
