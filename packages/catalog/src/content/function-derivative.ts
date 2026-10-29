/**
 * Installed content of `function-derivative`: the activity template (with its learner copy) and its model manifest, as one
 * on-demand chunk for `createLazyCatalog`, which verifies it against the installed index before serving it. Data only:
 * the kernel that evaluates the model is bundled in the catalogue worker, not here.
 */
import { deepFreeze } from '@explorable-models/core';
import type { InstalledContent } from './types.js';
import { functionDerivativeManifest } from '../models/function-derivative.js';
import { functionDerivativeTemplate } from '../templates/function-derivative.js';

export const content: InstalledContent = deepFreeze({ template: functionDerivativeTemplate, manifest: functionDerivativeManifest });
