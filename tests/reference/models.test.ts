import { describe, expect, it } from 'vitest';
import {
  defaultParameters, validateEvaluation, validateManifest, validateParameters, validateViews,
  type CheckSuite, type Evaluation, type NumericValue,
} from '@experiment-kit/core';
import { experiments, getExperiment } from '../../examples';
import { model as rolling, defaults as rollingDefaults, BODY_TYPES } from '../../examples/rolling/model';
import { model as linear, defaults as linearDefaults } from '../../examples/linear-map/model';
import { model as probability, defaults as probabilityDefaults } from '../../examples/base-rates/model';
import { model as riemann, defaults as riemannDefaults } from '../../examples/riemann-sums/model';
import { model as oscillator, defaults as oscillatorDefaults } from '../../examples/oscillator/model';
import rollingFixtures from './fixtures/rolling.json';
import linearFixtures from './fixtures/linear-map.json';
import probabilityFixtures from './fixtures/base-rates.json';
import riemannFixtures from './fixtures/riemann-sums.json';
import oscillatorFixtures from './fixtures/oscillator.json';

// Acceptance fixtures deliberately live outside the candidate example directories.
// Editing an example's author checks must not silently rewrite its reference gate.
const referenceSuites: Record<string, CheckSuite> = {
  rolling: rollingFixtures as unknown as CheckSuite,
  'linear-map': linearFixtures as unknown as CheckSuite,
  'base-rates': probabilityFixtures as unknown as CheckSuite,
  'riemann-sums': riemannFixtures as unknown as CheckSuite,
  oscillator: oscillatorFixtures as unknown as CheckSuite,
};

const scalar = (frame: Evaluation, id: string) => frame.quantities[id].value as number;
const vector = (frame: Evaluation, id: string) => frame.quantities[id].value as number[];
const close = (observed: number, expected: number, atol = 1e-9, rtol = 1e-8) =>
  Number.isFinite(observed) && Math.abs(observed - expected) <= atol + rtol * Math.abs(expected);
function matches(actual: NumericValue | null, expected: NumericValue | null): boolean {
  if (expected === null) return actual === null;
  if (typeof expected === 'number') return typeof actual === 'number' && close(actual, expected);
  return Array.isArray(actual) && actual.length === expected.length && expected.every((value, i) => close(actual[i], value));
}

describe('published example contracts and independent fixtures', () => {
  for (const experiment of experiments) {
    describe(experiment.manifest.id, () => {
      it('has a valid manifest, bounded bindings, and an honest review status', () => {
        expect(validateManifest(experiment.manifest)).toEqual(experiment.manifest);
        expect(validateViews(experiment.views!, experiment.manifest)).toEqual(experiment.views);
        expect(experiment.manifest.review?.status).toBe('unreviewed');
        expect(experiment.definitionRevision).toMatch(/^sha256:[a-f0-9]{64}$/);
      });
      for (const fixture of referenceSuites[experiment.manifest.id].cases) {
        it(fixture.label, () => {
          const params = validateParameters(experiment.manifest, fixture.parameters ?? {});
          const frame = experiment.model!.evaluate({ params, time: fixture.time ?? 0 });
          expect(() => validateEvaluation(experiment.manifest, frame)).not.toThrow();
          for (const [id, expected] of Object.entries(fixture.expected)) {
            expect(frame.quantities[id], id).toBeDefined();
            expect(matches(frame.quantities[id].value, expected), `${id}: observed ${JSON.stringify(frame.quantities[id].value)}, expected ${JSON.stringify(expected)}`).toBe(true);
            expect(frame.quantities[id].status).toBe(fixture.statuses?.[id] ?? (expected === null ? 'undefined' : 'valid'));
          }
        });
      }
      it('is a pure evaluation that leaves frozen input parameters unchanged', () => {
        const params = Object.freeze(defaultParameters(experiment.manifest));
        const first = experiment.model!.evaluate({ params, time: 0 });
        const second = experiment.model!.evaluate({ params, time: 0 });
        expect(first).toEqual(second);
        expect(params).toEqual(defaultParameters(experiment.manifest));
      });
    });
  }
});

describe('ideal rolling mechanics', () => {
  it('orders all four mass distributions independently of mass and radius', () => {
    const speeds = (['sphere', 'cylinder', 'shell', 'hoop'] as const).map(bodyType =>
      scalar(rolling.evaluate({ params: { ...rollingDefaults, bodyType }, time: 1 }), 'body.speed'));
    expect(speeds[0]).toBeGreaterThan(speeds[1]);
    expect(speeds[1]).toBeGreaterThan(speeds[2]);
    expect(speeds[2]).toBeGreaterThan(speeds[3]);
    for (const bodyType of Object.keys(BODY_TYPES) as (keyof typeof BODY_TYPES)[]) {
      for (const mass of [0.1, 1, 10]) for (const radius of [0.05, 0.2, 0.5]) {
        const frame = rolling.evaluate({ params: { ...rollingDefaults, bodyType, mass, radius }, time: 0.5 });
        const original = rolling.evaluate({ params: { ...rollingDefaults, bodyType }, time: 0.5 });
        expect(scalar(frame, 'body.acceleration')).toBe(scalar(original, 'body.acceleration'));
        expect(scalar(frame, 'body.distance')).toBe(scalar(original, 'body.distance'));
      }
    }
  });

  it('conserves energy and satisfies force balance at release, interior, and arrival', () => {
    for (const bodyType of Object.keys(BODY_TYPES) as (keyof typeof BODY_TYPES)[]) {
      for (const incline of [0, Math.PI / 12, Math.PI / 4]) {
        const params = { ...rollingDefaults, bodyType, incline };
        const domain = rolling.timeDomain!(params);
        for (const time of [0, (domain.end ?? 2) / 2, domain.end ?? 2]) {
          const frame = rolling.evaluate({ params, time });
          const a = scalar(frame, 'body.acceleration');
          const energy = scalar(frame, 'energy.total');
          expect(close(energy, params.mass * 9.81 * params.length * Math.sin(incline))).toBe(true);
          expect(close(params.mass * a, params.mass * 9.81 * Math.sin(incline) - scalar(frame, 'force.friction'))).toBe(true);
          const sum = ['force.gravityVector', 'force.normalVector', 'force.frictionVector'].map(id => vector(frame, id)).reduce((total, force) => total.map((v, i) => v + force[i]), [0, 0, 0]);
          expect(close(sum[0], params.mass * a * Math.cos(incline))).toBe(true);
          expect(close(sum[1], -params.mass * a * Math.sin(incline))).toBe(true);
        }
      }
    }
  });

  it('has zero contact-point velocity with the declared signed rotation convention', () => {
    const params = { ...rollingDefaults, bodyType: 'hoop' as const };
    const frame = rolling.evaluate({ params, time: 1 });
    const centerVelocity = vector(frame, 'body.velocity');
    const omega = vector(frame, 'body.angularVelocity');
    const contactRadius = [-params.radius * Math.sin(params.incline), -params.radius * Math.cos(params.incline), 0];
    const rotationalVelocity = [-omega[2] * contactRadius[1], omega[2] * contactRadius[0], 0];
    expect(close(centerVelocity[0] + rotationalVelocity[0], 0)).toBe(true);
    expect(close(centerVelocity[1] + rotationalVelocity[1], 0)).toBe(true);
    expect(close(scalar(frame, 'body.rotation') * params.radius, -scalar(frame, 'body.distance'))).toBe(true);
  });

  it('keeps the center one radius off the ramp and exposes finite arrival velocity', () => {
    const params = rollingDefaults;
    const end = rolling.timeDomain!(params).end!;
    const frame = rolling.evaluate({ params, time: end });
    const center = vector(frame, 'body.position');
    const contact = [params.length * Math.cos(params.incline), 0];
    expect(close(Math.hypot(center[0] - contact[0], center[1] - contact[1]), params.radius)).toBe(true);
    expect(close(scalar(frame, 'body.distance'), 4)).toBe(true);
    expect(close(scalar(frame, 'body.rotation'), -20)).toBe(true);
    expect(scalar(frame, 'body.speed')).toBeGreaterThan(5);
    expect(frame.boundary?.reached).toBe(true);
  });

  it('models a horizontal ramp with null end rather than Infinity', () => {
    const params = { ...rollingDefaults, incline: 0 };
    expect(rolling.timeDomain!(params).end).toBeNull();
    const frame = rolling.evaluate({ params, time: 100 });
    expect(scalar(frame, 'body.distance')).toBe(0);
    expect(frame.quantities['event.arrivalTime']).toMatchObject({ value: null, status: 'undefined' });
  });
});

describe('linear maps and signed area', () => {
  it('maps every parallelogram corner using matrix columns', () => {
    const frame = linear.evaluate({ params: { ...linearDefaults, a: 1, b: 2, c: 0.5, d: -1 }, time: 0 });
    expect(frame.geometry!.transformedSquare).toEqual([0, 0, 1, 0.5, 3, -0.5, 2, -1, 0, 0]);
    expect(vector(frame, 'basis.i')).toEqual([1, 0.5]);
    expect(vector(frame, 'basis.j')).toEqual([2, -1]);
  });

  it('preserves addition and scalar multiplication at nonaxis points', () => {
    const params = { ...linearDefaults, a: -0.75, b: 2.5, c: 1.25, d: 0.2 };
    const transform = (x: number, y: number) => vector(linear.evaluate({ params: { ...params, x, y }, time: 0 }), 'point.output');
    const u = transform(1.2, -0.4), v = transform(-0.6, 2.1), sum = transform(0.6, 1.7), scaled = transform(2.4, -0.8);
    expect(sum.every((value, i) => close(value, u[i] + v[i]))).toBe(true);
    expect(scaled.every((value, i) => close(value, 2 * u[i]))).toBe(true);
  });

  it('distinguishes a tiny determinant from an exactly singular map', () => {
    const frame = linear.evaluate({ params: { ...linearDefaults, a: 1, b: 1, c: 1, d: 1 + 1e-12 }, time: 0 });
    expect(scalar(frame, 'matrix.determinant')).toBeGreaterThan(0);
    expect(scalar(frame, 'matrix.orientation')).toBe(1);
  });
});

describe('base rates and exact expectations', () => {
  it('satisfies every contingency-table total, including probability boundaries', () => {
    for (const prevalence of [0, 0.01, 0.37, 1]) for (const sensitivity of [0, 0.9, 1]) for (const falsePositiveRate of [0, 0.05, 1]) {
      const frame = probability.evaluate({ params: { ...probabilityDefaults, prevalence, sensitivity, falsePositiveRate }, time: 0 });
      const n = (id: string) => scalar(frame, `count.${id}`);
      expect(close(n('truePositive') + n('falseNegative'), n('defective'))).toBe(true);
      expect(close(n('falsePositive') + n('trueNegative'), n('nondefective'))).toBe(true);
      expect(close(n('flagged') + n('unflagged'), 10000)).toBe(true);
      const posterior = frame.quantities['probability.posterior'];
      if (n('flagged') === 0) expect(posterior.status).toBe('undefined');
      else {
        expect(posterior.value).toBeGreaterThanOrEqual(0);
        expect(posterior.value).toBeLessThanOrEqual(1);
        expect(close(posterior.value as number, n('truePositive') / n('flagged'))).toBe(true);
      }
    }
  });

  it('preserves fractional expectations and does not mistake sensitivity for posterior', () => {
    const frame = probability.evaluate({ params: { ...probabilityDefaults, population: 7 }, time: 0 });
    expect(scalar(frame, 'count.truePositive')).not.toBe(Math.round(scalar(frame, 'count.truePositive')));
    expect(close(scalar(frame, 'probability.posterior'), 2 / 13)).toBe(true);
    expect(scalar(frame, 'probability.posterior')).not.toBe(probabilityDefaults.sensitivity);
  });
});

describe('two independently specified extension topics use the same contract', () => {
  it('matches independent finite-sum formulas for Riemann estimates', () => {
    for (const count of [1, 2, 3, 10, 100, 200]) {
      const right = riemann.evaluate({ params: { ...riemannDefaults, count, rule: 'right' }, time: 0 });
      const midpoint = riemann.evaluate({ params: { ...riemannDefaults, count, rule: 'midpoint' }, time: 0 });
      expect(close(scalar(right, 'sum.estimate'), 1 / 3 + 1 / (2 * count) + 1 / (6 * count * count))).toBe(true);
      expect(close(scalar(midpoint, 'sum.estimate'), 1 / 3 - 1 / (12 * count * count))).toBe(true);
    }
  });

  it('distinguishes signed integral from unsigned area', () => {
    const frame = riemann.evaluate({ params: { count: 100, rule: 'midpoint', integrand: 'signed' }, time: 0 });
    expect(close(scalar(frame, 'sum.estimate'), 0)).toBe(true);
    expect(close(scalar(frame, 'sum.unsignedEstimate'), 1)).toBe(true);
  });

  it('checks oscillator phase and energy over the declared observation window', () => {
    for (let quarter = 0; quarter <= 12; quarter++) {
      const time = quarter * Math.PI / 4;
      const frame = oscillator.evaluate({ params: oscillatorDefaults, time });
      const positions = [1, 0, -1, 0];
      const velocities = [0, -2, 0, 2];
      expect(close(scalar(frame, 'body.position'), positions[quarter % 4])).toBe(true);
      expect(close(scalar(frame, 'body.velocity'), velocities[quarter % 4])).toBe(true);
      expect(close(scalar(frame, 'energy.total'), 2)).toBe(true);
    }
    expect(oscillator.timeDomain!(oscillatorDefaults).end).toBe(3 * Math.PI);
  });
});

describe('input boundaries and evaluator sensitivity', () => {
  it.each([
    ['rolling', { radius: 0 }], ['rolling', { incline: 30 }], ['rolling', { bodyType: 'unknown' }],
    ['linear-map', { a: 3.1 }], ['base-rates', { prevalence: -0.01 }],
    ['base-rates', { sensitivity: 1.01 }], ['base-rates', { population: 0 }],
    ['riemann-sums', { count: 2.5 }], ['oscillator', { mass: 0 }],
  ])('rejects invalid parameters for %s', (id, params) => {
    expect(() => validateParameters(getExperiment(id as string).manifest, params)).toThrow();
  });

  it('catches a degrees-to-radians conversion applied twice', () => {
    const incorrect = rolling.evaluate({ params: { ...rollingDefaults, incline: rollingDefaults.incline * Math.PI / 180 }, time: 1 });
    expect(matches(incorrect.quantities['body.acceleration'].value, 3.503571428571)).toBe(false);
  });

  it('catches a reversed friction arrow using the declared world convention', () => {
    const frame = rolling.evaluate({ params: rollingDefaults, time: 1 });
    const actual = vector(frame, 'force.frictionVector');
    const expected = [-1.213672744447, 0.700714285714, 0];
    expect(matches(actual, expected)).toBe(true);
    expect(matches(actual.map(value => -value), expected)).toBe(false);
  });

  it('catches transposed matrix bindings at a nonsymmetric fixture', () => {
    const frame = linear.evaluate({ params: { ...linearDefaults, a: 1, b: 2, c: 0.5, d: -1, x: 1.25, y: -0.875 }, time: 0 });
    expect(matches(frame.quantities['point.output'].value, [-0.5, 1.5])).toBe(true);
    const transposed = [1 * 1.25 + 0.5 * -0.875, 2 * 1.25 + -1 * -0.875];
    expect(matches(transposed, [-0.5, 1.5])).toBe(false);
    expect(matches(transposed, frame.quantities['point.output'].value)).toBe(false);
  });

  it('catches the wrong Bayes denominator and a phase error despite conserved energy', () => {
    const wrongPosterior = 90 / 10000;
    expect(close(wrongPosterior, 2 / 13)).toBe(false);
    const quarter = oscillator.evaluate({ params: oscillatorDefaults, time: Math.PI / 4 });
    expect(close(scalar(quarter, 'energy.total'), 2)).toBe(true);
    expect(close(1, scalar(quarter, 'body.position'))).toBe(false);
  });
});
