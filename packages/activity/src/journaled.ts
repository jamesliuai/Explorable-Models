import type { InteractionEvent } from './contracts.js';

/**
 * Event lists handed to the interaction summary straight from an activity's own journal, which validated each event
 * when it was appended; the summary does not validate them again. Internal: the package index does not re-export it.
 */
export const journaledEvents = new WeakSet<readonly InteractionEvent[]>();
