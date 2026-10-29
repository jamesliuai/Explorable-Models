/** On-demand SVG/PNG rendering for an authorized, committed surface capture. */
import type { LearnerProjection, ProjectedView } from '@explorable-models/activity';
import { base64, fontFaceCss, fontsForText, INTER_FONT_FILES } from './assets.js';
import { formatPosition, valueDisplay } from './format.js';
import { labelMetrics, wrapText } from './labels.js';
import { CAPTURE_LIMITS, CaptureError, captureRejection, captureSize, companionText, type CaptureContext, type CaptureMetadata, type CaptureOptions, type CaptureResult } from './capture.js';

const GRAPHICAL = new Set<ProjectedView['kind']>(['plot2d', 'scene2d', 'scene3d']);

/** The view to capture: the named one, else the first graphical view, else the first view. */
export function selectCaptureView(projection: LearnerProjection, viewId?: string): ProjectedView {
  if (viewId !== undefined) {
    const view = projection.views.find(candidate => candidate.viewId === viewId);
    if (!view) throw new CaptureError('NOT_FOUND', 'This view is not shown in this activity.', 'Capture one of the views currently shown.');
    return view;
  }
  const view = projection.views.find(candidate => GRAPHICAL.has(candidate.kind)) ?? projection.views[0];
  if (!view) throw new CaptureError('NOT_FOUND', 'This activity shows no view to capture.', 'Wait until a view is shown.');
  return view;
}

export const captureMetadata = (surfaceId: string, projection: LearnerProjection, viewId: string): CaptureMetadata => ({
  surfaceId, projectionId: projection.projectionId, projectionDigest: projection.projectionDigest, frameId: projection.frame?.frameId ?? '',
  activityRevision: projection.activityRevision, presentationRevision: projection.presentationRevision, viewId,
});

const escapeXml = (text: string) => text.replace(/[<>&"']/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[c]!);
const INLINE_PROPERTIES = ['fill', 'fill-opacity', 'stroke', 'stroke-width', 'stroke-opacity', 'stroke-dasharray', 'stroke-linecap', 'stroke-linejoin', 'opacity', 'font-family', 'font-size', 'font-weight', 'font-style', 'text-anchor', 'dominant-baseline', 'paint-order'];
const DROP_ATTRIBUTES = /^(class|tabindex|style|aria-selected|aria-roledescription|aria-keyshortcuts|aria-describedby|aria-labelledby|focusable|on.*|data-.*)$/i;

/**
 * Clones a rendered scene SVG with its computed presentation inlined as attributes; drops focus/hit helpers, hidden
 * elements, foreignObject and interactive attributes.
 */
export function inlineSceneSvg(source: SVGSVGElement): string {
  const clone = source.cloneNode(true) as SVGSVGElement;
  const sources = [source, ...source.querySelectorAll('*')];
  const clones = [clone, ...clone.querySelectorAll('*')];
  const view = source.ownerDocument.defaultView!;
  const remove: Element[] = [];
  sources.forEach((element, index) => {
    const target = clones[index];
    if (element.getAttribute('data-ema-capture') === 'omit' || element.localName === 'foreignObject') { remove.push(target); return; }
    const style = view.getComputedStyle(element);
    if (style.display === 'none' || style.visibility === 'hidden') { remove.push(target); return; }
    for (const property of INLINE_PROPERTIES) {
      const value = style.getPropertyValue(property).trim();
      if (value && value !== 'normal' && !(property === 'paint-order' && value === 'normal')) target.setAttribute(property, value);
    }
    for (const attribute of [...target.attributes]) if (DROP_ATTRIBUTES.test(attribute.name)) target.removeAttribute(attribute.name);
  });
  for (const element of remove) element.remove();
  const width = source.viewBox.baseVal.width || source.getBoundingClientRect().width, height = source.viewBox.baseVal.height || source.getBoundingClientRect().height;
  clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
  clone.setAttribute('width', String(width)); clone.setAttribute('height', String(height));
  const serialized = new (view as Window & typeof globalThis).XMLSerializer().serializeToString(clone);
  return serialized.replace(/<foreignObject[\s\S]*?<\/foreignObject>/gi, '');
}

export interface ComposeInput {
  metadata: CaptureMetadata;
  title: string;
  summary: string;
  scene: { svg: string; width: number; height: number } | null;
  textLines: string[];
  footer: string;
  colors: { background: string; text: string; muted: string; border: string };
  fontFamily: string;
  fontFaces: string;
  outputSize?: { width: number; height: number };
}

/** Builds the capture document as a string (pure; escaped text; no foreignObject). */
export function composeCaptureSvg(input: ComposeInput): { svg: string; width: number; height: number } {
  const pad = 16, metrics = labelMetrics(13), titleMetrics = labelMetrics(15);
  const width = Math.max(320, Math.ceil(input.scene?.width ?? CAPTURE_LIMITS.textWidth) + 2 * pad);
  const textWidth = width - 2 * pad;
  const parts: string[] = [];
  let y = pad;
  const text = (line: string, size: number, weight: number, color: string, at: number) =>
    `<text x="${pad}" y="${at.toFixed(1)}" font-size="${size}" font-weight="${weight}" fill="${escapeXml(color)}" font-family="${escapeXml(input.fontFamily)}">${escapeXml(line)}</text>`;
  for (const line of wrapText(input.title, textWidth, titleMetrics.charWidth, 3)) { y += titleMetrics.lineHeight; parts.push(text(line, 15, 650, input.colors.text, y - 4)); }
  y += 6;
  if (input.scene) {
    parts.push(`<g transform="translate(${pad} ${y.toFixed(1)})">${input.scene.svg}</g>`);
    y += input.scene.height + 8;
  }
  for (const raw of input.textLines) {
    for (const line of wrapText(raw, textWidth, metrics.charWidth, 6)) { y += metrics.lineHeight; parts.push(text(line, 13, 400, input.colors.text, y - 3)); }
  }
  y += 6;
  for (const line of wrapText(input.footer, textWidth, metrics.charWidth, 2)) { y += metrics.lineHeight; parts.push(text(line, 12, 400, input.colors.muted, y - 3)); }
  const height = Math.ceil(y + pad);
  const out = input.outputSize ?? { width, height };
  const svg = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${out.width}" height="${out.height}" viewBox="0 0 ${width} ${height}" role="img" aria-labelledby="ema-capture-title ema-capture-desc">`,
    `<title id="ema-capture-title">${escapeXml(input.title)}</title><desc id="ema-capture-desc">${escapeXml(input.summary)}</desc>`,
    `<metadata>${escapeXml(JSON.stringify(input.metadata))}</metadata>`,
    input.fontFaces ? `<style>${input.fontFaces.replace(/</g, '')}</style>` : '',
    `<rect x="0" y="0" width="${width}" height="${height}" fill="${escapeXml(input.colors.background)}"/>`,
    `<rect x="0.5" y="0.5" width="${width - 1}" height="${height - 1}" fill="none" stroke="${escapeXml(input.colors.border)}"/>`,
    ...parts,
    '</svg>',
  ].join('');
  return { svg, width, height };
}

/** Lines of text for the view kinds that have no drawing, and the equation plain forms for drawn views. */
export function viewTextLines(view: ProjectedView): string[] {
  const lines: string[] = [];
  for (const value of view.values) { const display = valueDisplay(value); lines.push(`${value.label}: ${display.text}${display.unit ? ` ${display.unit}` : ''}${display.reason ? ` (${display.reason})` : ''}`); }
  for (const equation of view.equations) lines.push(`${equation.label}: ${equation.plain}`);
  if (view.table) {
    lines.push(view.table.columns.map(column => column.unitLabel ? `${column.label} (${column.unitLabel})` : column.label).join('  |  '));
    for (const row of view.table.rows.slice(0, CAPTURE_LIMITS.tableRows)) lines.push(row.cells.join('  |  '));
    if (view.table.rows.length > CAPTURE_LIMITS.tableRows || view.table.truncated) lines.push(`(${Math.min(view.table.rows.length, CAPTURE_LIMITS.tableRows)} of ${view.table.totalRows} rows)`);
  }
  return lines;
}

async function embeddedFonts(ctx: CaptureContext, sample: string): Promise<string> {
  if (ctx.fonts !== 'bundled') return '';
  try {
    const fonts = fontsForText(INTER_FONT_FILES, sample);
    const sources = await Promise.all(fonts.map(async font => {
      const response = await fetch(ctx.locations.fontUrl(font).href, { credentials: 'same-origin' });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return `data:font/woff2;base64,${base64(new Uint8Array(await response.arrayBuffer()))}`;
    }));
    return fontFaceCss(fonts, font => sources[fonts.indexOf(font)]);
  } catch { return ''; }
}

async function rasterize(svgFor: (size: { width: number; height: number }) => string, width: number, height: number, scale: number): Promise<{ bytes: Uint8Array; width: number; height: number; scale: number }> {
  const size = captureSize(width, height, scale);
  const url = URL.createObjectURL(new Blob([svgFor(size)], { type: 'image/svg+xml' }));
  try {
    const image = new Image();
    image.decoding = 'async';
    image.src = url;
    await image.decode();
    const canvas = document.createElement('canvas');
    canvas.width = size.width; canvas.height = size.height;
    const context = canvas.getContext('2d');
    if (!context) throw new CaptureError('UNSUPPORTED_CAPABILITY', 'This browser cannot rasterize captures.', 'Use the SVG capture instead.');
    context.drawImage(image, 0, 0, size.width, size.height);
    const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, 'image/png'));
    // A null blob is a failed encoding of this capture (for example too large for the canvas), not a missing capability.
    if (!blob) throw new CaptureError('CAPTURE_REJECTED', 'The PNG could not be encoded.', 'Use the SVG capture instead.');
    return { bytes: new Uint8Array(await blob.arrayBuffer()), width: size.width, height: size.height, scale: size.scale };
  } catch (error) {
    if (error instanceof CaptureError) throw error;
    throw new CaptureError('CAPTURE_REJECTED', 'The capture could not be rasterized safely.', 'Use the SVG capture instead.');
  } finally { URL.revokeObjectURL(url); }
}

/** Captures one view of the surface described by `ctx` (DOM required). */
export async function captureView(ctx: CaptureContext, options: CaptureOptions): Promise<CaptureResult> {
  if (!options || (options.format !== 'svg' && options.format !== 'png')) throw new CaptureError('CAPTURE_REJECTED', 'Choose the svg or png format.', 'Pass format: "svg" or "png".');
  const projection = ctx.projection;
  const rejection = captureRejection(projection);
  if (rejection) throw rejection;
  const view = selectCaptureView(projection, options.viewId);
  const metadata = captureMetadata(ctx.surfaceId, projection, view.viewId);
  let scene: ComposeInput['scene'] = null;
  if (GRAPHICAL.has(view.kind)) {
    const element = [...ctx.root.querySelectorAll<SVGSVGElement>('svg[data-ema-view-id]')].find(svg =>
      svg.dataset.emaSurfaceId === ctx.surfaceId && svg.dataset.emaProjectionId === projection.projectionId && svg.dataset.emaViewId === view.viewId);
    if (!element) {
      throw view.kind === 'scene3d'
        ? new CaptureError('CAPTURE_REJECTED', 'This view is shown in 3D, which is not captured.', 'Show the 2D projection of this view, then capture.')
        : new CaptureError('NOT_READY', 'The surface has not finished showing this view.', 'Wait until the view is visible, then capture.');
    }
    const width = element.viewBox.baseVal.width, height = element.viewBox.baseVal.height;
    scene = { svg: inlineSceneSvg(element), width, height };
  }
  const style = (ctx.themeElement.ownerDocument.defaultView ?? window).getComputedStyle(ctx.themeElement);
  const token = (name: string, fallback: string) => style.getPropertyValue(name).trim() || fallback;
  const textLines = scene ? view.equations.map(equation => `${equation.label}: ${equation.plain}`) : viewTextLines(view);
  const footer = [projection.navigation ? formatPosition(projection.navigation, ctx.locale) : '', projection.reviewNotice].filter(Boolean).join(' · ');
  const fontFaces = await embeddedFonts(ctx, [projection.title, view.title, ...textLines, footer, scene?.svg ?? ''].join(' '));
  const input: ComposeInput = {
    metadata, title: `${projection.title} — ${view.title}`, summary: view.summary, scene, textLines, footer,
    colors: { background: token('--ema-background', '#ffffff'), text: token('--ema-text', '#17212b'), muted: token('--ema-text-muted', '#4a5866'), border: token('--ema-border', '#c9d2db') },
    fontFamily: style.fontFamily || 'system-ui, sans-serif', fontFaces,
  };
  const composed = composeCaptureSvg(input);
  const base = { companionText: companionText(projection, view, ctx.locale), metadata, fonts: fontFaces ? 'embedded' as const : 'system' as const };
  if (options.format === 'svg') return { ...base, mimeType: 'image/svg+xml', svg: composed.svg, width: composed.width, height: composed.height };
  const raster = await rasterize(size => composeCaptureSvg({ ...input, outputSize: size }).svg, composed.width, composed.height, options.scale ?? 2);
  return { ...base, mimeType: 'image/png', bytes: raster.bytes, width: raster.width, height: raster.height, scale: raster.scale };
}
