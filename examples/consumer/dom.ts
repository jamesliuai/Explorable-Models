import { mountVisualization } from '@explorable-models/player';
import { setup, guard, createPreset, createVisualizationSession } from './setup';
const first = await setup();
const second = await setup(true);
const a = mountVisualization(document.querySelector('#first')!, { session: first.session });
const b = mountVisualization(document.querySelector('#second')!, { session: second.session, controls: false });
Object.assign(window, { consumer: { first, second, guard, surfaces: [a,b], createPreset, createVisualizationSession, mountVisualization, dispose() { a.dispose(); b.dispose(); first.session.dispose(); second.session.dispose(); } } });
