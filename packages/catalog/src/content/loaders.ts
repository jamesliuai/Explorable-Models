/**
 * On-demand content chunks of the installed templates, keyed by `templateId@version`. Each loader is a static
 * `import()` of a bundled module (never a path, URL or name taken from input), so bundlers emit one chunk per
 * template and fetch it only when `createLazyCatalog().load()` asks for that exact version. New activity packages add
 * their loader here and regenerate the installed index (scripts/study-harness/generate-catalog-index.mjs).
 */
import type { InstalledContentModule } from './types.js';

export const CONTENT_LOADERS: Readonly<Record<string, () => Promise<InstalledContentModule>>> = Object.freeze({
  'quadratic-gradient-descent@1.0.0': () => import('./quadratic-gradient-descent.js'),
  'function-derivative@1.0.0': () => import('./function-derivative.js'),
  'linear-transformation@1.0.0': () => import('./linear-transformation.js'),
  'vector-orientation-3d@1.0.0': () => import('./vector-orientation-3d.js'),
  'quadratic-surface-gradient@1.0.0': () => import('./quadratic-surface-gradient.js'),
});
