import { createRoot } from 'react-dom/client';
import { VisualizationSurface } from '@explorable-models/player';
import { setup, guard } from './setup';
const first = await setup();
const root = createRoot(document.getElementById('root')!);
root.render(<VisualizationSurface session={first.session} />);
Object.assign(window, { consumer: { first, guard, dispose() { root.unmount(); first.session.dispose(); } } });
