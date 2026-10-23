import type { CheckSuite, ExperimentDefinition, ModelExecutor } from '@experiment-kit/core';
export interface ExperimentEntry {
  id: string;
  definition: ExperimentDefinition;
  createExecutor: () => ModelExecutor;
  checks?: CheckSuite;
  loadChecks?: () => Promise<CheckSuite | null>;
}
