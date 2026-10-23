import type { VisualizationSession } from '@experiment-kit/core/declarative';

const surfaces = new WeakMap<VisualizationSession, Set<HTMLElement>>();

export function registerSurface(session: VisualizationSession, element: HTMLElement): () => void {
  const set = surfaces.get(session) ?? new Set<HTMLElement>();
  set.add(element); surfaces.set(session, set);
  return () => { set.delete(element); if (!set.size) surfaces.delete(session); };
}

export interface FrozenScene {
  mimeType: 'image/svg+xml';
  svg: string;
  metadata: { sessionId: string; viewId: string; documentRevision: string; modelRevision: string; presentationRevision: string; runId: string; time: number; version: number };
}

/** Captures one rendered scene, never the surrounding application or a full browser page. */
export function exportSceneSvg(session: VisualizationSession, viewId: string): FrozenScene {
  const state = session.getState();
  if (!state.document || !state.identity || !state.run || !state.frame) throw new Error('There is no committed visualization to export.');
  if (state.preview) throw new Error('Commit or cancel the parameter preview before exporting.');
  if (state.playing) throw new Error('Pause playback before exporting a frozen scene.');
  const elements = surfaces.get(session);
  let source: SVGSVGElement | undefined;
  for (const element of elements ?? []) {
    source = Array.from(element.querySelectorAll<SVGSVGElement>('svg[data-view-id]')).find(svg => svg.dataset.viewId === viewId && Number(svg.dataset.sessionVersion) === state.version && svg.dataset.runId === state.run!.id && Number(svg.dataset.frameTime) === state.frame!.time && svg.dataset.documentRevision === state.identity!.documentRevision);
    if (source) break;
  }
  if (!source) throw new Error('A mounted surface showing this exact committed scene is required. Wait for the surface to render, or supply a browser capture service.');
  const metadata = { sessionId: state.sessionId, viewId, ...state.identity, runId: state.run.id, time: state.frame.time, version: state.version };
  const clone = source.cloneNode(true) as SVGSVGElement;
  clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
  clone.setAttribute('width', String(source.viewBox.baseVal.width)); clone.setAttribute('height', String(source.viewBox.baseVal.height));
  const palette = getComputedStyle(source);
  const variables = ['--ek-bg', '--ek-ink', '--ek-muted', '--ek-border'].map(key => `${key}:${palette.getPropertyValue(key).trim()}`).join(';');
  clone.setAttribute('style', variables);
  const meta = source.ownerDocument.createElementNS('http://www.w3.org/2000/svg', 'metadata');
  meta.textContent = JSON.stringify(metadata); clone.prepend(meta);
  for (const node of clone.querySelectorAll('[tabindex]')) node.removeAttribute('tabindex');
  return { mimeType: 'image/svg+xml', svg: new XMLSerializer().serializeToString(clone), metadata };
}
