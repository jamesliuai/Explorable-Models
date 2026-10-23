import type { AnalyticModel, ScalarParams } from '@experiment-kit/core';

export const BODY_TYPES = {
  sphere: { label: 'Solid sphere', kappa: 2 / 5 },
  shell: { label: 'Spherical shell', kappa: 2 / 3 },
  cylinder: { label: 'Solid cylinder', kappa: 1 / 2 },
  hoop: { label: 'Hoop', kappa: 1 },
} as const;

export type RollingParameters = ScalarParams & {
  bodyType: keyof typeof BODY_TYPES;
  incline: number;
  mass: number;
  radius: number;
  length: number;
};

export const defaults: RollingParameters = {
  bodyType: 'sphere', incline: Math.PI / 6, mass: 1, radius: 0.2, length: 4,
};

const gravity = 9.81;
const valid = (value: number | readonly number[]) => ({ value, status: 'valid' as const });

/** Ideal rolling from rest. World X is right, Y up, Z out of the side view. */
export const model: AnalyticModel<RollingParameters> = {
  kind: 'analytic',
  timeDomain(params) {
    const acceleration = gravity * Math.sin(params.incline) / (1 + BODY_TYPES[params.bodyType].kappa);
    return { start: 0, end: acceleration > 0 ? Math.sqrt(2 * params.length / acceleration) : null, endEventId: 'ramp-arrival' };
  },
  evaluate({ params, time }) {
    const { incline, mass, radius, length } = params;
    const kappa = BODY_TYPES[params.bodyType].kappa;
    const sin = Math.sin(incline);
    const cos = Math.cos(incline);
    const acceleration = gravity * sin / (1 + kappa);
    const distance = 0.5 * acceleration * time * time;
    const speed = acceleration * time;
    const angularSpeed = speed / radius;
    const rotation = -distance / radius;
    const inertia = kappa * mass * radius * radius;
    const friction = kappa * mass * acceleration;
    const normal = mass * gravity * cos;
    const translational = 0.5 * mass * speed * speed;
    const rotational = 0.5 * inertia * angularSpeed * angularSpeed;
    const potential = mass * gravity * (length - distance) * sin;
    const terminalTime = acceleration > 0 ? Math.sqrt(2 * length / acceleration) : null;
    const position = [distance * cos + radius * sin, (length - distance) * sin + radius * cos, 0];
    return {
      quantities: {
        'body.kappa': valid(kappa),
        'body.inertia': valid(inertia),
        'body.acceleration': valid(acceleration),
        'body.distance': valid(distance),
        'body.speed': valid(speed),
        'body.angularSpeed': valid(angularSpeed),
        'body.rotation': valid(rotation),
        'body.position': valid(position),
        'body.velocity': valid([speed * cos, -speed * sin, 0]),
        'body.angularVelocity': valid([0, 0, -angularSpeed]),
        'force.friction': valid(friction),
        'force.normal': valid(normal),
        'force.gravity': valid(mass * gravity),
        'force.minCoefficient': valid(kappa * Math.tan(incline) / (1 + kappa)),
        'force.frictionVector': valid([-friction * cos, friction * sin, 0]),
        'force.normalVector': valid([normal * sin, normal * cos, 0]),
        'force.gravityVector': valid([0, -mass * gravity, 0]),
        'energy.potential': valid(potential),
        'energy.translational': valid(translational),
        'energy.rotational': valid(rotational),
        'energy.total': valid(potential + translational + rotational),
        'event.arrivalTime': terminalTime === null
          ? { value: null, status: 'undefined' as const, reason: 'A horizontal ramp has no finite arrival event when released from rest.' }
          : valid(terminalTime),
      },
      geometry: { ramp: [0, length * sin, 0, length * cos, 0, 0] },
      boundary: { reached: terminalTime !== null && time >= terminalTime, reason: 'The body has reached the end of the modeled ramp. Its terminal speed is retained.' },
    };
  },
};

export default model;
