// Entry of the packaged reference host. The conformance runner is imported only in a `vite --mode conformance` build:
// in the production build the condition is the constant `false` and neither the runner nor its probes are emitted.
import './styles.css';
import { ReferenceHostApp } from './app';
import { mountHostChrome } from './ui';

async function boot(): Promise<void> {
  if (import.meta.env.MODE === 'conformance') {
    const { installMathVisibilityAudit } = await import('./conformance/math-visibility');
    installMathVisibilityAudit();
  }
  const card = document.getElementById('card');
  const panel = document.getElementById('host-panel');
  if (!card || !panel) throw new Error('The host page is incomplete.');
  const app = new ReferenceHostApp(card);
  mountHostChrome(panel, app);
  await app.start();
  document.body.dataset.hostReady = 'true';
  if (import.meta.env.MODE === 'conformance') {
    const { runConformance } = await import('./conformance/runner');
    await runConformance(app);
  }
}

void boot();
