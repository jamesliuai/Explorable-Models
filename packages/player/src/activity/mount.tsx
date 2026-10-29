/**
 * Plain-DOM mounting of the learner surface in a dedicated shadow root (style isolation; report §10.1). The component
 * stylesheet is adopted into the shadow root before the first render, so no style attribute or inline `<style>` is
 * needed (native.md N4). A shadow root is a styling boundary, not a security boundary (report §16).
 */
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { CaptureError, type CaptureOptions, type CaptureResult } from './capture.js';
import { createSurfaceId } from './runtime.js';
import { StudyActivitySurface } from './StudyActivitySurface.js';
import { adoptActivityStyles } from './styles.js';
import type { StudyActivityHandle, StudyActivitySurfaceProps } from './types.js';

export type MountStudyActivityOptions = StudyActivitySurfaceProps;

export interface MountedStudyActivity {
  /** The host element appended to the container (its shadow root holds the surface). */
  readonly element: HTMLElement;
  readonly surfaceId: string;
  /** Resolves after the first render is committed (and bundled fonts have settled); rejects if disposed first. */
  readonly ready: Promise<void>;
  capture(options: CaptureOptions): Promise<CaptureResult>;
  /** Unmounts, unregisters the surface and removes the element. Idempotent; no host callback runs afterwards. */
  dispose(): void;
}

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;

export function mountStudyActivity(container: HTMLElement, options: MountStudyActivityOptions): MountedStudyActivity {
  if (!container || typeof container.appendChild !== 'function' || !container.ownerDocument) throw new TypeError('mountStudyActivity requires a browser HTMLElement container.');
  if (!options?.binding || typeof options.binding.getProjection !== 'function') throw new TypeError('mountStudyActivity requires an activity binding.');
  const surfaceId = options.surfaceId ?? createSurfaceId();
  if (!ID_PATTERN.test(surfaceId)) throw new TypeError('surfaceId must match ^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$.');
  const doc = container.ownerDocument;
  const element = doc.createElement('div');
  element.setAttribute('data-explorable-models-activity', surfaceId);
  const shadow = element.attachShadow({ mode: 'open' });
  const styles = adoptActivityStyles(shadow, options.assetBase);
  container.appendChild(element);

  let disposed = false;
  let settle: { resolve: () => void; reject: (error: Error) => void } | null = null;
  const ready = new Promise<void>((resolve, reject) => { settle = { resolve, reject }; });
  ready.catch(() => undefined);
  const handle: { current: StudyActivityHandle | null } = { current: null };
  // Host callbacks are wrapped so nothing reaches the host after dispose, even from late asynchronous work.
  const guard = <A extends unknown[]>(fn: ((...args: A) => void) | undefined) => fn && ((...args: A) => { if (!disposed) fn(...args); });
  const props: StudyActivitySurfaceProps = {
    ...options, surfaceId,
    onDiagnostic: guard(options.onDiagnostic?.bind(options)),
    onRecoveryAction: guard(options.onRecoveryAction?.bind(options)),
    nextAction: options.nextAction && { ...options.nextAction, onSelect: guard(options.nextAction.onSelect.bind(options.nextAction))! },
  };
  if (!styles.ok) props.onDiagnostic?.({ source: 'surface', code: 'STYLES_UNAVAILABLE', message: 'This browser cannot apply the surface stylesheet; pass assetBase so activity.css can be linked.' });
  const onFirstRender = () => {
    const fonts = props.fonts === 'bundled' ? doc.fonts?.ready : undefined;
    Promise.resolve(fonts).then(() => { if (!disposed) settle?.resolve(); }, () => { if (!disposed) settle?.resolve(); });
  };

  const root = createRoot(shadow);
  flushSync(() => root.render(<StudyActivitySurface {...props} onFirstRender={onFirstRender} ref={(value: StudyActivityHandle | null) => { handle.current = value; }} />));

  return {
    element,
    surfaceId,
    ready,
    async capture(captureOptions) {
      if (disposed) throw new CaptureError('DISPOSED', 'This surface has been disposed.', 'Mount the activity again.');
      await ready;
      if (disposed || !handle.current) throw new CaptureError('DISPOSED', 'This surface has been disposed.', 'Mount the activity again.');
      return handle.current.capture(captureOptions);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      settle?.reject(new CaptureError('DISPOSED', 'The surface was disposed before it was ready.', 'Mount the activity again.'));
      root.unmount();
      styles.release();
      element.remove();
      handle.current = null;
    },
  };
}
