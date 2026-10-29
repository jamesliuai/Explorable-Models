/**
 * Spatial activity consumer: the plain-DOM consumer with the optional spatial renderer supplied as
 * `spatialLoader: () => import('@explorable-models/player-3d')`. The renderer (and Three.js) is fetched only when a card
 * shows a `scene3d` view; 2D templates never call the loader. Every loader call is recorded (`spatialLoads`) so the
 * driver can relate network requests for the 3D chunks to the moment a 3D template was opened.
 */
import { createLazyCatalog } from '@explorable-models/catalog';
import { createStudyHarnessVisualizer, mountStudyActivity, type SpatialRendererModule } from '@explorable-models/player/activity';
import { ConsumerHost } from './host';
import { exposeConsumer } from './page';
import { ConsumerSession, type CardMounter } from './session';
import './page.css';

const spatialLoads: number[] = [];
const spatialLoader = (): Promise<SpatialRendererModule> => {
  spatialLoads.push(performance.now());
  return import('@explorable-models/player-3d');
};

const catalog = createLazyCatalog();
const host = new ConsumerHost(catalog);
const diagnostics: unknown[] = [];
const visualizer = createStudyHarnessVisualizer({
  catalog, host, maxWorkers: 2, mountSurface: mountStudyActivity,
  surfaceDefaults: { theme: 'light', fonts: 'bundled', headingLevel: 2, spatialLoader, onDiagnostic: diagnostic => { diagnostics.push(diagnostic); } },
});
const mount: CardMounter = (container, prepared, surfaceId) => visualizer.mount(container, prepared, { surfaceId });
const session = new ConsumerSession({
  catalog, host, mount, container: document.getElementById('cards')!,
  prepare: (request, input) => visualizer.prepare(request, input),
  restore: (artifact, input) => visualizer.restore(artifact, input),
  release: activityId => visualizer.dispose(activityId),
});
exposeConsumer({
  entry: 'spatial', session, host, diagnostics, capabilities: () => visualizer.getCapabilities(),
  dispose: () => { session.closeAll(); visualizer.dispose(); },
  extra: {
    spatialLoads,
    /** State of each spatial view of the card (`ready`, `suspended`, `fallback`, …). */
    spatialState: (activityId: string) => [...(session.surfaceRoot(activityId)?.querySelectorAll<HTMLElement>('[data-ema-spatial]') ?? [])]
      .map(element => ({ viewId: element.dataset.emaSpatial, state: element.dataset.emaSpatialState, canvas: !!element.querySelector('canvas') })),
  },
});
