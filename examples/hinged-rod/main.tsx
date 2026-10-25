import { createRoot } from 'react-dom/client';
import { createRodController } from './controller';
import { RodCard } from './RodCard';
import '@fontsource-variable/inter';
import './style.css';

const root = createRoot(document.getElementById('root')!);
root.render(<p className="loading" role="status">Preparing the rod model…</p>);
createRodController().then(controller => {
  root.render(<div className="rod-example">
    <nav className="example-nav" aria-label="Example navigation"><a href="./">Explorable Models</a><span>Local example</span></nav>
    <main className="conversation">
      <div className="user-message">What happens when a hinged rod is released?</div>
      <p className="assistant-message">Gravity creates a torque about the hinge, so the rod begins to rotate. Explore the instant it’s released below—the arrows and values respond as you drag.</p>
      <RodCard controller={controller} />
      <footer className="example-footer">An interactive model, embedded in a conversation.<a href="./">Open the composition studio <span aria-hidden="true">↗</span></a></footer>
    </main>
  </div>);
  // Dev-only inspection hook for browser tests, never needed by the embedded component.
  if (import.meta.env.DEV) Object.assign(window, { __ROD_EXAMPLE__: controller });
  const dispose = () => { root.unmount(); controller.dispose(); };
  window.addEventListener('pagehide', dispose, { once: true });
  import.meta.hot?.dispose(() => { window.removeEventListener('pagehide', dispose); dispose(); });
}).catch(error => {
  root.render(<main className="loading"><h1>Unable to load the model</h1><p role="alert">{error instanceof Error ? error.message : 'Please reload to retry.'}</p></main>);
});
