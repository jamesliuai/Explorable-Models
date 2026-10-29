/**
 * Installed content of `linear-transformation`: the activity template (with its learner copy) and its model manifest, as one
 * on-demand chunk for `createLazyCatalog`, which verifies it against the installed index before serving it. Data only:
 * the kernel that evaluates the model is bundled in the catalogue worker, not here.
 */
import { deepFreeze } from '@experiment-kit/core';
import type { InstalledContent } from './types.js';
import { linearTransformationManifest } from '../models/linear-transformation.js';
import { linearTransformationTemplate } from '../templates/linear-transformation.js';

export const content: InstalledContent = deepFreeze({ template: linearTransformationTemplate, manifest: linearTransformationManifest });
