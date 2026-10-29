/**
 * Installed content of `quadratic-surface-gradient`: the activity template (with its learner copy) and its model manifest, as one
 * on-demand chunk for `createLazyCatalog`, which verifies it against the installed index before serving it. Data only:
 * the kernel that evaluates the model is bundled in the catalogue worker, not here.
 */
import { deepFreeze } from '@explorable-models/core';
import type { InstalledContent } from './types.js';
import { quadraticSurfaceGradientManifest } from '../models/quadratic-surface-gradient.js';
import { quadraticSurfaceGradientTemplate } from '../templates/quadratic-surface-gradient.js';

export const content: InstalledContent = deepFreeze({ template: quadraticSurfaceGradientTemplate, manifest: quadraticSurfaceGradientManifest });
