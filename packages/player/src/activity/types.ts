/** Public types of `@explorable-models/player/activity`. */
import type { ReactNode } from 'react';
import type { ActivityBinding, Diagnostic } from '@explorable-models/activity';
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

/**
 * How much orientation the card carries itself (0.3 presentation):
 * - `standalone` (default): the card names the activity, states the stage instruction and offers its tools in place,
 *   so it works on a page by itself;
 * - `embedded`: the host already presents the learning prompt and composer beside the card (for example a study
 *   workspace's side pane). The title stays the card's accessible heading but is not shown while there is content, the
 *   stage instruction is one compact line, the stage response prompt is left to the host unless a `responseSlot` is
 *   passed, and secondary tools (alternative representations, Reset experiment, kept-run comparisons, Read current
 *   values) are gathered in one “More tools” disclosure, so the drawing, the primary parameters and the essential values
 *   come first. Nothing about what is computed, permitted, recorded or acknowledged changes between variants.
 */
export type SurfaceVariant = 'standalone' | 'embedded';

/** One clear host-owned next action (for example “Submit prediction”); the card never owns response submission. */
export interface NextAction { label: string; onSelect(): void; disabled?: boolean; status?: string }

export interface StudyActivitySurfaceProps {
  /** Learner binding created by the host (`prepared.binding('learner', surfaceId)`). */
  binding: ActivityBinding;
  theme?: ThemePreference;
  /** Host tokens; unsafe overrides (low contrast, non-literal colours, unsafe sizes) are ignored and reported. */
  tokens?: Partial<ThemeTokens>;
  /** `standalone` (default) or `embedded`; see {@link SurfaceVariant}. Presentation only. */
  variant?: SurfaceVariant;
  /** Heading level of the activity title (default 2); view headings use the next level. */
  headingLevel?: 2 | 3 | 4 | 5 | 6;
  /** Locale for numbers the surface formats itself (ticks, index); defaults to the projection's presentation locale. */
  locale?: string;
  /** Host-owned prediction/explanation composer; the card renders no transcript, microphone or response field. */
  responseSlot?: ReactNode;
  nextAction?: NextAction;
  /** Lazy KaTeX loader (default: dynamic `import('katex')`). */
  mathLoader?: () => Promise<KatexModule>;
  /** Lazy spatial renderer loader, e.g. `() => import('@explorable-models/player-3d')`; absent → 2D projection + table. */
  spatialLoader?: () => Promise<SpatialRendererModule>;
  /**
   * `system` (default) uses the platform UI font and loads no font files (typeset math then uses KaTeX fonts only where
   * the host document already provides them); `bundled` registers the packaged KaTeX fonts and Inter. With `bundled`,
   * a `tokens.fontFamily` override (for example `SYSTEM_FONT_STACK`) keeps the platform UI font while math still uses
   * the packaged KaTeX fonts; fonts are fetched only when text uses them.
   */
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
