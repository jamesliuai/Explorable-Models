import type { AnalyticModel, ScalarParams } from '@explorable-models/core';

export type OscillatorParameters = ScalarParams & { amplitude: number; mass: number; stiffness: number; periods: number };
export const defaults: OscillatorParameters = { amplitude: 1, mass: 1, stiffness: 4, periods: 3 };
const valid = (value: number | readonly number[]) => ({ value, status: 'valid' as const });

/** Closed-form oscillator, not a numerical integration adapter. */
export const model: AnalyticModel<OscillatorParameters> = {
  kind: 'analytic',
  timeDomain(params) {
    return { start: 0, end: params.periods * 2 * Math.PI * Math.sqrt(params.mass / params.stiffness), endEventId: 'observation-end' };
  },
  evaluate({ params: { amplitude, mass, stiffness }, time }) {
    const omega = Math.sqrt(stiffness / mass);
    const position = amplitude * Math.cos(omega * time);
    const velocity = -amplitude * omega * Math.sin(omega * time);
    const potential = 0.5 * stiffness * position * position;
    const kinetic = 0.5 * mass * velocity * velocity;
    return {
      quantities: {
        'body.position': valid(position), 'body.velocity': valid(velocity),
        'body.acceleration': valid(-omega * omega * position),
        'oscillation.omega': valid(omega), 'oscillation.period': valid(2 * Math.PI / omega),
        'energy.potential': valid(potential), 'energy.kinetic': valid(kinetic), 'energy.total': valid(potential + kinetic),
      },
      geometry: { displacement: [0, 0, position, 0] },
    };
  },
};

export default model;
