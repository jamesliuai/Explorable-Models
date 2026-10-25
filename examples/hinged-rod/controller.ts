import { createCardController } from '../shared/controller';
import { rodDocument } from './document';

export const createRodController = () => createCardController(rodDocument);
export type RodController = Awaited<ReturnType<typeof createRodController>>;
