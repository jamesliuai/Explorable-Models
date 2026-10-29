/**
 * The driver interface every consumer entry exposes as `window.consumer` (JSON-serializable results only), and the
 * page readiness flag (`document.body.dataset.ready`).
 */
import type { CapabilityReport, ExposureRecord, InteractionEvent } from '@explorable-models/activity';
import type { ConsumerHost } from './host';
import type { CardSummary, ConsumerSession, Outcome, SerializedCapture } from './session';

export interface ConsumerApi {
  entry: 'dom' | 'react' | 'spatial';
  open(templateId: string, input?: { activityId?: string; stageId?: string }): Promise<CardSummary>;
  transition(activityId: string, toStage: string): Promise<Outcome>;
  revealStage(activityId: string): Promise<Outcome>;
  authorizeExploration(activityId: string): Promise<Outcome>;
  commit(activityId: string, values: Record<string, number>): Promise<Outcome>;
  settle(activityId: string): Promise<CardSummary>;
  summary(activityId: string): CardSummary;
  capture(activityId: string, format: 'svg' | 'png', viewId?: string): Promise<SerializedCapture>;
  exposures(activityId: string): ExposureRecord[];
  displayAcks(activityId: string): string[];
  events(activityId: string): Pick<InteractionEvent, 'sequence' | 'type'>[];
  capabilities(): CapabilityReport;
  diagnostics: unknown[];
  close(activityId: string): void;
  dispose(): void;
}

export function exposeConsumer(input: {
  entry: ConsumerApi['entry']; session: ConsumerSession; host: ConsumerHost; diagnostics: unknown[]; capabilities(): CapabilityReport; dispose(): void;
  extra?: Record<string, unknown>;
}): ConsumerApi {
  const { session, host } = input;
  const api: ConsumerApi = {
    entry: input.entry,
    open: (templateId, options) => session.open(templateId, options),
    transition: (activityId, toStage) => session.transition(activityId, toStage),
    revealStage: activityId => session.revealStage(activityId),
    authorizeExploration: activityId => session.authorizeExploration(activityId),
    commit: (activityId, values) => session.commit(activityId, values),
    settle: activityId => session.settle(activityId),
    summary: activityId => session.summary(activityId),
    capture: (activityId, format, viewId) => session.capture(activityId, format, viewId),
    exposures: activityId => host.exposures(activityId),
    displayAcks: activityId => host.displayAcks(activityId),
    events: activityId => host.events(activityId).map(event => ({ sequence: event.sequence, type: event.type })),
    capabilities: input.capabilities,
    diagnostics: input.diagnostics,
    close: activityId => session.close(activityId),
    dispose: input.dispose,
  };
  Object.assign(window, { consumer: Object.assign(api, input.extra ?? {}) });
  document.body.dataset.ready = 'true';
  return api;
}
