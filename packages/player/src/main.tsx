import { createRoot } from 'react-dom/client';
import '@fontsource-variable/inter';
import 'katex/dist/katex.min.css';
import './styles.css';
import { App } from './App';
createRoot(document.getElementById('root')!).render(<App/>);
