import { createRoot } from 'react-dom/client';
import 'katex/dist/katex.min.css';
import './styles.css';
import { App } from './App';
// Warm charcoal by default; ?theme=light or ?theme=system (follows the platform setting) selects the light palette.
const requestedTheme = new URLSearchParams(location.search).get('theme');
const prefersLight = typeof matchMedia === 'function' && matchMedia('(prefers-color-scheme: light)').matches;
document.documentElement.dataset.theme = requestedTheme === 'light' || (requestedTheme === 'system' && prefersLight) ? 'light' : 'dark';
createRoot(document.getElementById('root')!).render(<App/>);
