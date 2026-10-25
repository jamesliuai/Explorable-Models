import { createRoot } from 'react-dom/client';
import { createCardController } from '../shared/controller';
import { exhibits } from './catalog';
import { documents } from './models';
import { ExampleCard } from './ExampleCard';
import '@fontsource-variable/inter';
import './style.css';

const root = createRoot(document.getElementById('root')!);
const requested = new URLSearchParams(location.search).get('example');
const exhibit = exhibits.find(item => item.id === requested) ?? exhibits[0];
document.title = `${exhibit.nav} · Explorable Models`;
root.render(<p className="ex-loading" role="status">Preparing the model…</p>);
createCardController(documents[exhibit.id]).then(async controller => {
  // Open the projectile example at an illustrative paused point, not autoplay.
  if (exhibit.id === 'projectile') await controller.seek(controller.getSnapshot().rendered.frame!.endTime! * .28);
  root.render(<div className="ex-page">
    <header className="ex-header"><a href="./">Explorable Models</a><span>Example collection</span></header>
    <nav className="ex-navigation" aria-label="Examples">{exhibits.map(item => <a href={`?example=${item.id}`} key={item.id} aria-current={item.id === exhibit.id ? 'page' : undefined}>{item.nav}</a>)}</nav>
    <main><div className="ex-user-message">{exhibit.prompt}</div><p className="ex-answer">{exhibit.answer}</p><ExampleCard exhibit={exhibit} controller={controller} /></main>
    <footer className="ex-footer"><span>Six models. Six ways to explore.</span><a href="./hinged-rod.html">The hinged-rod example ↗</a></footer>
  </div>);
  if (import.meta.env.DEV) Object.assign(window, { __SHOWCASE__: controller });
  const dispose = () => { root.unmount(); controller.dispose(); };
  window.addEventListener('pagehide', dispose, { once: true });
  import.meta.hot?.dispose(() => { window.removeEventListener('pagehide', dispose); dispose(); });
}).catch(error => root.render(<main className="ex-loading"><h1>Unable to prepare the model</h1><p role="alert">{error instanceof Error ? error.message : 'Reload to retry.'}</p></main>));
