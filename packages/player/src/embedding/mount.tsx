import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { VisualizationSurface } from './VisualizationSurface.js';
import type { VisualizationSurfaceProps } from './VisualizationSurface.js';
import { exportSceneSvg } from './export.js';
import type { FrozenScene } from './export.js';

export interface MountedVisualization {
  /** Removes this surface. The host retains ownership of the session. */
  dispose(): void;
  /** Alias for dispose; neither method disposes the host-owned session. */
  unmount(): void;
  exportSceneSvg(viewId: string): FrozenScene;
  readonly element: HTMLElement;
}

/** Mounts in a dedicated child shadow root so host CSS cannot affect the controls. */
export function mountVisualization(container: HTMLElement, options: VisualizationSurfaceProps): MountedVisualization {
  if (!container || typeof container.appendChild !== 'function') throw new Error('mountVisualization requires a browser HTMLElement.');
  const element = container.ownerDocument.createElement('div');
  element.setAttribute('data-experiment-kit-mount', '');
  const shadow = element.attachShadow({ mode: 'open' });
  container.appendChild(element);
  const root = createRoot(shadow);
  flushSync(() => root.render(<VisualizationSurface {...options} />));
  let disposed = false;
  const dispose = () => { if (disposed) return; disposed = true; root.unmount(); element.remove(); };
  return {
    element,
    exportSceneSvg: viewId => { if (disposed) throw new Error('This surface has been disposed.'); return exportSceneSvg(options.session, viewId); },
    dispose,
    unmount: dispose,
  };
}
