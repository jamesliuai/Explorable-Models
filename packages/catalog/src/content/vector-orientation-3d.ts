/**
 * Installed content of `vector-orientation-3d`: the activity template (with its learner copy) and its model manifest, as one
 * on-demand chunk for `createLazyCatalog`, which verifies it against the installed index before serving it. Data only:
 * the kernel that evaluates the model is bundled in the catalogue worker, not here.
 */
import { deepFreeze } from '@explorable-models/core';
import type { InstalledContent } from './types.js';
import { vectorOrientationManifest } from '../models/vector-orientation-3d.js';
import { vectorOrientationTemplate } from '../templates/vector-orientation-3d.js';

export const content: InstalledContent = deepFreeze({ template: vectorOrientationTemplate, manifest: vectorOrientationManifest });
