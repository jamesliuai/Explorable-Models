import type { CheckSuite, ExperimentDefinition } from '@experiment-kit/core';
import { definition as definition0 } from './rolling/metadata';
import { model as model0 } from './rolling/model';
import { checks as checks0 } from './rolling/checks';
import { definition as definition1 } from './linear-map/metadata';
import { model as model1 } from './linear-map/model';
import { checks as checks1 } from './linear-map/checks';
import { definition as definition2 } from './base-rates/metadata';
import { model as model2 } from './base-rates/model';
import { checks as checks2 } from './base-rates/checks';
import { definition as definition3 } from './riemann-sums/metadata';
import { model as model3 } from './riemann-sums/model';
import { checks as checks3 } from './riemann-sums/checks';
import { definition as definition4 } from './oscillator/metadata';
import { model as model4 } from './oscillator/model';
import { checks as checks4 } from './oscillator/checks';

/** Trusted reference-test registry. The browser player must import browser.ts instead. */
export const experiments: (ExperimentDefinition & { checks: CheckSuite })[] = [
  { ...definition0, model: model0, checks: checks0 },
  { ...definition1, model: model1, checks: checks1 },
  { ...definition2, model: model2, checks: checks2 },
  { ...definition3, model: model3, checks: checks3 },
  { ...definition4, model: model4, checks: checks4 },
];
export const experimentDefinitions = Object.fromEntries(experiments.map(item => [item.manifest.id, item]));
export const models = Object.fromEntries(experiments.map(item => [item.manifest.id, item.model!]));
export function getExperiment(id: string) {
  const experiment = experimentDefinitions[id];
  if (!experiment) throw new Error(`Unknown experiment: ${id}`);
  return experiment;
}
