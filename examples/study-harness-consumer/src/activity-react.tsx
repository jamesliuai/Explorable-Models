/**
 * React activity consumer: one React root owned by the host renders every open learner card as
 * `<StudyActivitySurface binding={…} />` (no shadow root; the surface adopts its stylesheet into the document). The
 * activity adapter is created directly with `createStudyHarnessAdapter`, the catalogue's kernel module worker is used
 * unchanged, and `window.consumer` exposes the host steps to the packed-consumer driver.
 */
import { useSyncExternalStore } from 'react';
import { createPortal, flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';
import { createStudyHarnessAdapter, type ActivityBinding } from '@experiment-kit/activity';
import { createLazyCatalog } from '@experiment-kit/catalog';
import { StudyActivitySurface, type StudyActivityHandle } from '@experiment-kit/player/activity';
import { ConsumerHost } from './host';
import { exposeConsumer } from './page';
import { ConsumerSession, type CardHandle, type CardMounter } from './session';
import './page.css';

interface CardEntry { surfaceId: string; binding: ActivityBinding; container: HTMLElement }
/** The host's own card list: React renders it; mount/dispose change it. */
function createCardStore() {
  let cards: CardEntry[] = [];
  const listeners = new Set<() => void>();
  return {
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    get: () => cards,
    set(next: CardEntry[]) { cards = next; for (const listener of [...listeners]) listener(); },
  };
}

// The on-demand catalogue: the installed index is eager; each template's content loads when it is first opened.
const catalog = createLazyCatalog();
const host = new ConsumerHost(catalog);
const adapter = createStudyHarnessAdapter({ catalog, host, maxWorkers: 2 });
const diagnostics: unknown[] = [];
const store = createCardStore();
const handles = new Map<string, StudyActivityHandle>();

/** Cards render into host-owned elements inside the session's wrappers (React portals keep one root). */
function Cards() {
  const cards = useSyncExternalStore(store.subscribe, store.get);
  return <>{cards.map(card => createPortal(
    <StudyActivitySurface
      binding={card.binding} surfaceId={card.surfaceId} theme="light" fonts="bundled" headingLevel={2}
      onDiagnostic={diagnostic => { diagnostics.push(diagnostic); }}
      ref={(handle: StudyActivityHandle | null) => { if (handle) handles.set(card.surfaceId, handle); else handles.delete(card.surfaceId); }}
    />, card.container, card.surfaceId))}</>;
}
const root = createRoot(document.getElementById('react-root')!);
flushSync(() => root.render(<Cards />));

const mount: CardMounter = (container, prepared, surfaceId): CardHandle => {
  const element = document.createElement('div');
  element.className = 'consumer-react-card';
  container.append(element);
  flushSync(() => store.set([...store.get(), { surfaceId, binding: prepared.binding('learner', surfaceId), container: element }]));
  let disposed = false;
  return {
    surfaceId, element, ready: Promise.resolve(),
    capture(options) {
      const handle = handles.get(surfaceId);
      if (disposed || !handle) return Promise.reject(new Error('The card is not mounted.'));
      return handle.capture(options);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      flushSync(() => store.set(store.get().filter(card => card.surfaceId !== surfaceId)));
      element.remove();
    },
  };
};
const session = new ConsumerSession({
  catalog, host, mount, container: document.getElementById('cards')!,
  prepare: (request, input) => adapter.prepare(request, input),
  restore: (artifact, input) => adapter.restore(artifact, input),
  release: activityId => adapter.dispose(activityId),
});
exposeConsumer({
  entry: 'react', session, host, diagnostics, capabilities: () => adapter.getCapabilities(),
  dispose: () => { session.closeAll(); root.unmount(); adapter.dispose(); },
});
