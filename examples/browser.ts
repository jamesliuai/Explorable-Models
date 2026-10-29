import { WorkerExecutor, type CheckSuite, type ExperimentDefinition, type ModelExecutor } from '@explorable-models/core';
import { definition as definition0 } from './rolling/metadata';
import { checks as checks0 } from './rolling/checks';
import modelCard0 from './rolling/model.md?raw';
import { definition as definition1 } from './linear-map/metadata';
import { checks as checks1 } from './linear-map/checks';
import modelCard1 from './linear-map/model.md?raw';
import { definition as definition2 } from './base-rates/metadata';
import { checks as checks2 } from './base-rates/checks';
import modelCard2 from './base-rates/model.md?raw';
import { definition as definition3 } from './riemann-sums/metadata';
import { checks as checks3 } from './riemann-sums/checks';
import modelCard3 from './riemann-sums/model.md?raw';
import { definition as definition4 } from './oscillator/metadata';
import { checks as checks4 } from './oscillator/checks';
import modelCard4 from './oscillator/model.md?raw';

/** Only metadata and a worker factory enter the trusted UI; model code stays in workers. */
export interface ExperimentEntry { id: string; definition: ExperimentDefinition; checks?: CheckSuite; createExecutor: () => ModelExecutor }
export const experimentEntries: ExperimentEntry[] = [
  { id: 'rolling', definition: { ...definition0, modelCard: modelCard0 }, checks: checks0, createExecutor: () => new WorkerExecutor(new Worker(new URL('./rolling/worker.ts', import.meta.url), { type: 'module' }), definition0.manifest) },
  { id: 'linear-map', definition: { ...definition1, modelCard: modelCard1 }, checks: checks1, createExecutor: () => new WorkerExecutor(new Worker(new URL('./linear-map/worker.ts', import.meta.url), { type: 'module' }), definition1.manifest) },
  { id: 'base-rates', definition: { ...definition2, modelCard: modelCard2 }, checks: checks2, createExecutor: () => new WorkerExecutor(new Worker(new URL('./base-rates/worker.ts', import.meta.url), { type: 'module' }), definition2.manifest) },
  { id: 'riemann-sums', definition: { ...definition3, modelCard: modelCard3 }, checks: checks3, createExecutor: () => new WorkerExecutor(new Worker(new URL('./riemann-sums/worker.ts', import.meta.url), { type: 'module' }), definition3.manifest) },
  { id: 'oscillator', definition: { ...definition4, modelCard: modelCard4 }, checks: checks4, createExecutor: () => new WorkerExecutor(new Worker(new URL('./oscillator/worker.ts', import.meta.url), { type: 'module' }), definition4.manifest) },
];
export const referenceEntries = experimentEntries.slice(0, 3);
export default experimentEntries;
