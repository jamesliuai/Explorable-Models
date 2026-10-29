/**
 * Plain-DOM activity consumer (no React in the host code): `createStudyHarnessVisualizer` around the installed catalogue
 * and the fixture host, mounting learner cards with `mountStudyActivity` (a shadow root per card). The catalogue's own
 * kernel module worker is used unchanged. `window.consumer` exposes the host steps to the packed-consumer driver.
 */
import { createLazyCatalog } from '@explorable-models/catalog';
import { createStudyHarnessVisualizer, mountStudyActivity } from '@explorable-models/player/activity';
import { ConsumerHost } from './host';
import { exposeConsumer } from './page';
import { ConsumerSession, type CardMounter } from './session';
import './page.css';

// The on-demand catalogue: the installed index is eager; each template's content loads when it is first opened.
const catalog = createLazyCatalog();
const host = new ConsumerHost(catalog);
const diagnostics: unknown[] = [];
const visualizer = createStudyHarnessVisualizer({
  catalog, host, maxWorkers: 2, mountSurface: mountStudyActivity,
  surfaceDefaults: { theme: 'light', fonts: 'bundled', headingLevel: 2, onDiagnostic: diagnostic => { diagnostics.push(diagnostic); } },
});
const mount: CardMounter = (container, prepared, surfaceId) => visualizer.mount(container, prepared, { surfaceId });
const session = new ConsumerSession({
  catalog, host, mount, container: document.getElementById('cards')!,
  prepare: (request, input) => visualizer.prepare(request, input),
  restore: (artifact, input) => visualizer.restore(artifact, input),
  release: activityId => visualizer.dispose(activityId),
});
exposeConsumer({ entry: 'dom', session, host, diagnostics, capabilities: () => visualizer.getCapabilities(), dispose: () => { session.closeAll(); visualizer.dispose(); } });
