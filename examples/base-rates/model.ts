import type { AnalyticModel, ScalarParams } from '@explorable-models/core';

export type BaseRateParameters = ScalarParams & {
  prevalence: number; sensitivity: number; falsePositiveRate: number; population: number;
};
export const defaults: BaseRateParameters = { prevalence: 0.01, sensitivity: 0.9, falsePositiveRate: 0.05, population: 10_000 };
const valid = (value: number) => ({ value, status: 'valid' as const });

/** Expected frequencies, never a random sample or rounded integer population. */
export const model: AnalyticModel<BaseRateParameters> = {
  kind: 'parametric',
  evaluate({ params: { prevalence, sensitivity, falsePositiveRate, population } }) {
    const defective = population * prevalence;
    const nondefective = population * (1 - prevalence);
    const truePositive = defective * sensitivity;
    const falsePositive = nondefective * falsePositiveRate;
    const falseNegative = defective * (1 - sensitivity);
    const trueNegative = nondefective * (1 - falsePositiveRate);
    const flagged = truePositive + falsePositive;
    const unflagged = falseNegative + trueNegative;
    const flagProbability = prevalence * sensitivity + (1 - prevalence) * falsePositiveRate;
    return {
      quantities: {
        'count.population': valid(population),
        'count.defective': valid(defective),
        'count.nondefective': valid(nondefective),
        'count.truePositive': valid(truePositive),
        'count.falsePositive': valid(falsePositive),
        'count.falseNegative': valid(falseNegative),
        'count.trueNegative': valid(trueNegative),
        'count.flagged': valid(flagged),
        'count.unflagged': valid(unflagged),
        'probability.flagged': valid(flagProbability),
        'probability.posterior': flagProbability === 0
          ? { value: null, status: 'undefined' as const, reason: 'No parts are flagged, so the conditioning event has probability zero.' }
          : valid(prevalence * sensitivity / flagProbability),
      },
    };
  },
};

export default model;
