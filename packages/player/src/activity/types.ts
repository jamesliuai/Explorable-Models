/** Public types of `@experiment-kit/player/activity`. */
import type { ReactNode } from 'react';
import type { ActivityBinding, Diagnostic } from '@experiment-kit/activity';
import type { KatexModule } from './math.js';
import type { SpatialRendererModule } from './spatial-contract.js';
import type { ThemePreference, ThemeTokens } from './theme.js';
import type { CaptureOptions, CaptureResult } from './capture.js';

export type SurfaceDiagnosticCode =
  | 'TOKEN_REJECTED' | 'STYLES_UNAVAILABLE' | 'FONTS_UNAVAILABLE' | 'MATH_FALLBACK' | 'MATH_ASSETS_UNAVAILABLE' | 'SPATIAL_FALLBACK'
  | 'LABEL_OVERLAP' | 'LABEL_CALLOUT' | 'CLIPPED' | 'COMMAND_REJECTED' | 'CAPTURE_REJECTED';

/**
 * Developer-facing diagnostic. `binding` diagnostics carry the adapter's stable code and learner-safe message; surface
 * diagnostics describe presentation fallbacks. Never shown verbatim to learners except command messages, which the
 * contract requires to be learner-safe.
 */
export interface SurfaceDiagnostic {
  source: 'surface' | 'binding';
  code: SurfaceDiagnosticCode | Diagnostic['code'];
  message: string;
  path?: string;
  recovery?: string;
}

/** One clear host-owned next action (for example “Submit prediction”); the card never owns response submission. */
export interface NextAction { label: string; onSelect(): void; disabled?: boolean; status?: string }

export interface StudyActivitySurfaceProps {
  /** Learner binding created by the host (`prepared.binding('learner', surfaceId)`). */
  binding: ActivityBinding;
  theme?: ThemePreference;
  /** Host tokens; unsafe overrides (low contrast, non-literal colours, unsafe sizes) are ignored and reported. */
  tokens?: Partial<ThemeTokens>;
  /** Heading level of the activity title (default 2); view headings use the next level. */
  headingLevel?: 2 | 3 | 4 | 5 | 6;
  /** Locale for numbers the surface formats itself (ticks, index); defaults to the projection's presentation locale. */
  locale?: string;
  /** Host-owned prediction/explanation composer; the card renders no transcript, microphone or response field. */
  responseSlot?: ReactNode;
  nextAction?: NextAction;
  /** Lazy KaTeX loader (default: dynamic `import('katex')`). */
  mathLoader?: () => Promise<KatexModule>;
  /** Lazy spatial renderer loader, e.g. `() => import('@experiment-kit/player-3d')`; absent → 2D projection + table. */
  spatialLoader?: () => Promise<SpatialRendererModule>;
  /** `system` (default) uses the platform UI font and loads no font files; `bundled` registers Inter and KaTeX fonts. */
  fonts?: 'bundled' | 'system';
  onDiagnostic?(diagnostic: SurfaceDiagnostic): void;
  /** Stable surface ID (generated when omitted); must match the contract ID pattern. */
  surfaceId?: string;
  /** Base URL of relocated assets laid out like `dist/activity/` (math/, fonts/, activity.css). */
  assetBase?: string | URL;
  /** Host handling for `return`/`reload` recovery actions; without it those actions are described but not offered. */
  onRecoveryAction?(action: 'return' | 'reload'): void;
}

export interface StudyActivityHandle {
  readonly surfaceId: string;
  /** Frozen capture of one view of this surface (rejects unresolved previews and playback). */
  capture(options: CaptureOptions): Promise<CaptureResult>;
}
