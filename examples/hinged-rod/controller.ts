import { createDocumentInteractionController, type DocumentInteractionController } from '@explorable-models/core/declarative';
import { rodDocument } from './document';

/** The supported document interaction controller (primary/scratch sessions, coalesced previews, suspension). */
export const createRodController = (): Promise<DocumentInteractionController> => createDocumentInteractionController(rodDocument);
export type RodController = DocumentInteractionController;
