import type { ExperimentDefinition, Manifest, ViewDefinition } from '@explorable-models/core';
import manifestData from './experiment.json';
import viewsData from './views.json';
import { revisions } from '../revisions';

export const manifest = manifestData as Manifest;
export const views = viewsData as ViewDefinition[];
export const definition: ExperimentDefinition = { manifest, views, definitionRevision: revisions['riemann-sums'] };
export default definition;
