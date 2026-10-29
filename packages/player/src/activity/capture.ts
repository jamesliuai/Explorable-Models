/**
 * Frozen visual capture of one view of one mounted surface (report §19, A50, native.md N6).
 *
 * - Captures only what the host policy authorizes (report §5.3 “authorized capture”): a projection whose
 *   `permissions.capture` is not true (policy `export.capture` off, or the activity blocked) is refused with
 *   `CAPTURE_REJECTED` before anything is read or serialized.
 * - Rejects unresolved state: a tentative frame/preview or running playback (`CAPTURE_REJECTED`, recovery “commit or
 *   cancel” / “pause”), and surfaces that have not rendered the current projection (`NOT_READY`).
 * - Selects only this surface's view element by surface ID + projection ID + view ID, never a document-wide query, so
 *   another mounted surface with a different camera, reveal state or size cannot be captured by mistake.
 * - Serializes pure SVG: no `<foreignObject>`, computed presentation attributes inlined, equations as SVG text from
 *   their plain form, metadata limited to identities (the projection holds no hidden data, and nothing else is read).
 * - Embeds fonts as `data:` only when bundled fonts are in use; rasterizes PNG through a `blob:` image onto a canvas
 *   bounded to `CAPTURE_LIMITS`.
 */
import type { LearnerProjection, ProjectedView } from '@experiment-kit/activity';
import type { AssetLocations } from './assets.js';
import { formatPosition, valueDisplay } from './format.js';

export const CAPTURE_LIMITS = Object.freeze({ maxSide: 4096, maxPixels: 16_777_216, maxScale: 4, companionChars: 16_384, tableRows: 50, textWidth: 520 });

export type CaptureErrorCode = 'CAPTURE_REJECTED' | 'NOT_READY' | 'NOT_FOUND' | 'DISPOSED' | 'UNSUPPORTED_CAPABILITY';
export class CaptureError extends Error {
  constructor(readonly code: CaptureErrorCode, message: string, readonly recovery: string) { super(message); this.name = 'CaptureError'; }
}

export interface CaptureOptions { format: 'svg' | 'png'; viewId?: string; scale?: number }
export interface CaptureMetadata { surfaceId: string; projectionId: string; projectionDigest: string; frameId: string; activityRevision: number; presentationRevision: number; viewId: string }
interface CaptureBase { companionText: string; metadata: CaptureMetadata; width: number; height: number; fonts: 'embedded' | 'system' }
export type CaptureResult = (CaptureBase & { mimeType: 'image/svg+xml'; svg: string }) | (CaptureBase & { mimeType: 'image/png'; bytes: Uint8Array; scale: number });

/** Why the projection cannot be captured now, or null. */
export function captureRejection(projection: LearnerProjection): CaptureError | null {
  const ui = projection.status.ui;
  if (ui === 'disposed') return new CaptureError('DISPOSED', 'This activity has ended.', 'Mount the activity again.');
  if (ui === 'empty' || ui === 'preparing' || !projection.frame) return new CaptureError('NOT_READY', 'There is no committed result to capture yet.', 'Wait until the activity is ready.');
  // Fail closed: a projection without an explicit grant (older or hand-built objects included) is not capturable.
  if (projection.permissions?.capture !== true) return new CaptureError('CAPTURE_REJECTED', 'The host policy does not allow captures of this activity.', 'Ask the host; captures follow its policy (export.capture).');
  if (projection.frame.kind === 'tentative' || ui === 'tentative-preview' || projection.preview) return new CaptureError('CAPTURE_REJECTED', 'A tentative preview is shown; it is not a committed run.', 'Commit or cancel the preview, then capture.');
  if (ui === 'playing' || projection.navigation?.playing) return new CaptureError('CAPTURE_REJECTED', 'Playback is running.', 'Pause playback, then capture.');
  return null;
}

/** Frames a capture waits for the surface to show the current projection before it reports `NOT_READY`. */
export const CAPTURE_FRAME_WAIT = 6;
const disposedError = () => new CaptureError('DISPOSED', 'This surface has been disposed.', 'Mount the activity again.');

/**
 * Waits until the surface shows `projectionId` (`shown()` is read before every wait), for at most `frames` frames.
 * Disposal settles the wait at once with `DISPOSED`, also when no frame ever comes (a hidden or occluded page delivers
 * none); only a surface that is still mounted and still shows another projection after the last frame is `NOT_READY`.
 * `nextFrame` must settle when `signal` aborts (the surface cancels its animation frame).
 */
export async function awaitRenderedProjection(input: { projectionId: string; shown(): string | null | undefined; nextFrame(signal: AbortSignal): Promise<unknown>; signal: AbortSignal; frames?: number }): Promise<void> {
  const frames = input.frames ?? CAPTURE_FRAME_WAIT;
  for (let attempt = 0; ; attempt++) {
    if (input.signal.aborted) throw disposedError();
    if (input.shown() === input.projectionId) return;
    if (attempt >= frames) throw new CaptureError('NOT_READY', 'The surface has not finished showing the current state.', 'Wait a moment, then capture again.');
    await input.nextFrame(input.signal);
  }
}

/** Output size for a capture: scale clamped to (0, maxScale], then reduced so both sides and the pixel count fit. */
export function captureSize(width: number, height: number, scale = 1): { width: number; height: number; scale: number; reduced: boolean } {
  if (!(width > 0) || !(height > 0) || !Number.isFinite(width) || !Number.isFinite(height)) throw new CaptureError('NOT_READY', 'The view has no size yet.', 'Wait until the view is visible.');
  const requested = Number.isFinite(scale) && scale > 0 ? Math.min(scale, CAPTURE_LIMITS.maxScale) : 1;
  const fit = Math.min(requested, CAPTURE_LIMITS.maxSide / width, CAPTURE_LIMITS.maxSide / height, Math.sqrt(CAPTURE_LIMITS.maxPixels / (width * height)));
  let w = Math.max(1, Math.floor(width * fit)), h = Math.max(1, Math.floor(height * fit));
  while (w * h > CAPTURE_LIMITS.maxPixels) { w = Math.max(1, w - 1); h = Math.max(1, Math.floor(w * height / width)); }
  return { width: w, height: h, scale: w / width, reduced: fit < requested };
}

/** Text/numeric companion built only from the projection (the same authorized content as the image). */
export function companionText(projection: LearnerProjection, view: ProjectedView, locale?: string): string {
  const lines: string[] = [projection.title, `${view.title}. ${view.summary}`.trim()];
  if (projection.navigation) lines.push(`Position: ${formatPosition(projection.navigation, locale)}${projection.frame?.terminal ? ` (end${projection.frame.terminalDetail ? `: ${projection.frame.terminalDetail}` : ''})` : ''}.`);
  const values = view.values.length ? view.values : [];
  if (values.length) {
    lines.push('Values:');
    for (const value of values) { const display = valueDisplay(value); lines.push(`- ${value.label}: ${display.text}${display.unit ? ` ${display.unit}` : ''}${display.approximate ? ' (approximate)' : ''}${display.reason ? ` (${display.reason})` : ''}`); }
  }
  if (view.equations.length) { lines.push('Equations:'); for (const equation of view.equations) lines.push(`- ${equation.label}: ${equation.plain}`); }
  if (view.table) {
    const table = view.table;
    const shown = table.rows.slice(0, CAPTURE_LIMITS.tableRows);
    lines.push(`${table.caption} (${shown.length} of ${table.totalRows} rows${table.truncated || shown.length < table.rows.length ? ', shortened' : ''}):`);
    lines.push(table.columns.map(column => column.unitLabel ? `${column.label} (${column.unitLabel})` : column.label).join('\t'));
    for (const row of shown) lines.push(row.cells.join('\t'));
    if (table.source) lines.push(table.source);
  }
  if (projection.comparisons.length) {
    lines.push('Comparisons:');
    for (const comparison of projection.comparisons) lines.push(`- Current run vs ${comparison.label}: ${[...comparison.parameterDifferences.map(d => `${d.label} ${d.text}`), ...(comparison.hiddenDifferences ? ['settings not shown here also differ'] : [])].join('; ')}`);
  }
  if (projection.reviewNotice) lines.push(projection.reviewNotice);
  let text = lines.filter(Boolean).join('\n');
  if (text.length > CAPTURE_LIMITS.companionChars) text = `${text.slice(0, CAPTURE_LIMITS.companionChars - 32)}\n[Shortened to the capture limit]`;
  return text;
}

export interface CaptureContext {
  /** The surface's own root (its shadow root or root element); the only place searched. */
  root: ParentNode;
  /** Element whose computed `--eka-*` tokens give the capture colours. */
  themeElement: Element;
  surfaceId: string;
  projection: LearnerProjection;
  fonts: 'bundled' | 'system';
  locations: AssetLocations;
  locale?: string;
}

/** Loads serialization, font embedding and rasterization only when a surface capture is requested. */
export async function loadCaptureView(signal: AbortSignal): Promise<typeof import('./capture-renderer.js').captureView> {
  let abort!: () => void;
  const stopped = new Promise<never>((_, reject) => {
    abort = () => reject(disposedError());
    if (signal.aborted) abort(); else signal.addEventListener('abort', abort, { once: true });
  });
  try {
    const renderer = await Promise.race([import('./capture-renderer.js'), stopped]);
    if (signal.aborted) throw disposedError();
    return renderer.captureView;
  }
  catch {
    if (signal.aborted) throw disposedError();
    throw new CaptureError('CAPTURE_REJECTED', 'The local capture renderer could not be loaded.', 'Restore the local capture asset, reload and retry.');
  } finally { signal.removeEventListener('abort', abort); }
}
