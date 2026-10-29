/** Shape of one installed template's on-demand content module (`./<template-id>.ts`). */
import type { ActivityTemplate } from '@explorable-models/activity';
import type { ModelManifest } from '@explorable-models/core/model';

export interface InstalledContent { readonly template: ActivityTemplate; readonly manifest: ModelManifest }
export interface InstalledContentModule { readonly content: InstalledContent }
