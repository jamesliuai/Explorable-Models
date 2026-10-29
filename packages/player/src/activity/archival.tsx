/**
 * Archival read-only record of a saved activity (report §14, A49). Renders an `ArchivalView` from
 * `@experiment-kit/activity`'s `archivalView(artifact, { audience })` — the saved stage, position, the parameter values
 * the audience may read and the exposure history — and nothing else: no model is evaluated, no control can change the
 * saved activity and no template content is looked up, so a missing or revoked model is never replaced by a similar one.
 * A host shows it when `restore` reports `UNSUPPORTED_ARTIFACT` or `CONTENT_REVOKED`.
 *
 * Audiences (report §10.4: no unexplained IDs in ordinary learner UI, and a clear return action):
 * - `learner` and `tutor`: learner-facing words only. The view carries identities, not names, so the activity title,
 *   step names, parameter names and content names come from `labels` the host supplies (`archivalLabels(template)` from
 *   the exact saved template it still holds); anything without a name is counted, never shown by its identifier. The
 *   artifact, template, model, stage and group identifiers and the journal sequence are not shown. A backup's parameter
 *   values are withheld by `archivalView` for these audiences; a learner snapshot lists the values that were visible.
 * - `teacher` and `host`: the saved identities, artifact ID and journal checkpoint as well (diagnostic detail).
 * The record's only control is the host's `returnAction` (for example back to the session); it changes nothing saved.
 */
import { useLayoutEffect, useMemo, useRef, type CSSProperties } from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import type { ActivityTemplate, ArchivalView, FramePosition, StageKind } from '@experiment-kit/activity';
import { Heading, useStableId } from './components/context.js';
import { formatShown } from './format.js';
import { adoptActivityStyles } from './styles.js';
import { resolveTheme, tokenVariables, type ThemeMode, type ThemeTokens } from './theme.js';
import type { NextAction } from './types.js';

/**
 * Learner-facing names for a learner or tutor record, supplied by the host from the exact saved template it holds (see
 * {@link archivalLabels}). Names for another template version are ignored. Every field is optional; unnamed items are
 * counted, never listed by identifier.
 */
export interface ArchivalLabels {
  /** The template the names come from; when given, it must match the saved template ID and version. */
  template?: { templateId: string; version: string };
  /** The activity title. */
  title?: string;
  /** Step name by stage ID (for example `Exploration`). */
  stages?: Readonly<Record<string, string>>;
  /** Parameter name by parameter ID (the control label, for example `Step size η`). */
  parameters?: Readonly<Record<string, string>>;
  /** Content name by group ID (the group label). */
  groups?: Readonly<Record<string, string>>;
}

export interface ArchivalRecordProps {
  view: ArchivalView;
  /** Heading level of the record title (2–6, default 2). */
  headingLevel?: number;
  theme?: ThemeMode;
  tokens?: Partial<ThemeTokens>;
  locale?: string;
  /** Learner-facing names for the `learner` and `tutor` audiences (see {@link ArchivalLabels}). */
  labels?: ArchivalLabels;
  /** Host-owned return action (for example `Return to the session`); without it the record offers no control. */
  returnAction?: NextAction;
}

const STAGE_NAMES: Record<StageKind, string> = { prepare: 'Getting started', predict: 'Prediction', explore: 'Exploration', explain: 'Explanation', closed: 'Closed' };
/**
 * Learner-facing names of a template for {@link ArchivalRecordProps.labels}: its title, a step name for each stage (by
 * kind), each control's label and each content group's label. Names only: no instruction, equation, value or other
 * template content enters the record.
 */
export function archivalLabels(template: Pick<ActivityTemplate, 'templateId' | 'version' | 'title' | 'stages' | 'controls' | 'groups'>): ArchivalLabels {
  return {
    template: { templateId: template.templateId, version: template.version },
    title: template.title,
    stages: Object.fromEntries(template.stages.map(stage => [stage.id, STAGE_NAMES[stage.kind] ?? 'A step of the activity'])),
    parameters: Object.fromEntries(template.controls.map(control => [control.parameter, control.label])),
    groups: Object.fromEntries(template.groups.map(group => [group.id, group.label])),
  };
}

const STATUS_TEXT: Record<ArchivalView['exposures'][number]['displayStatus'], string> = {
  displayed: 'shown', uncertain: 'potentially shown (not confirmed)', authorized: 'authorized, potentially shown', 'not-displayed': 'not shown',
};
const positionText = (position: FramePosition, locale?: string): string =>
  position.kind === 'index' ? `n = ${position.index} of ${position.maxIndex}`
    : position.kind === 'time' ? `t = ${formatShown(position.time, locale)}${position.endTime !== null ? ` of ${formatShown(position.endTime, locale)}` : ''}` : 'Single static state';

const count = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;
const nameOf = (names: Readonly<Record<string, string>> | undefined, id: string): string | null => {
  const name = names && Object.prototype.hasOwnProperty.call(names, id) ? names[id]?.trim() : '';
  return name ? name : null;
};

/** Read-only record of a saved activity (see module comment). */
export function ArchivalRecord({ view, headingLevel = 2, theme = 'light', tokens, locale, labels, returnAction }: ArchivalRecordProps) {
  const rootRef = useRef<HTMLElement>(null);
  const titleId = useStableId('eka-archival');
  const stateId = useStableId('eka-archival-state');
  const valuesId = useStableId('eka-archival-values');
  const exposureId = useStableId('eka-archival-exposure');
  const tokenKey = JSON.stringify(tokens ?? null);
  const variables = useMemo(() => tokenVariables(resolveTheme(theme, tokens).tokens) as CSSProperties, [theme, tokenKey]);
  useLayoutEffect(() => {
    const root = rootRef.current?.getRootNode();
    if (!root || !('adoptedStyleSheets' in root || 'head' in root)) return;
    return adoptActivityStyles(root as Document | ShadowRoot).release;
  }, []);
  const sub = Math.min(6, headingLevel + 1);
  // Teacher and host records name the saved identities; learner and tutor records use the host's names only.
  const full = view.audience === 'teacher' || view.audience === 'host';
  const named = labels && (!labels.template || (labels.template.templateId === view.template.templateId && labels.template.version === view.template.version)) ? labels : undefined;
  const stageName = nameOf(named?.stages, view.activity.stageId);
  const contextText = view.activity.context === 'independent' ? 'Independent task' : 'Instructional';
  const modeText = view.activity.mode === 'exploratory' ? 'Exploratory (not reviewed)' : 'Approved';
  const position = `${positionText(view.position, locale)}${view.terminal ? ' (last available)' : ''}`;
  const facts: [string, string][] = full ? [
    ['Template', `${view.template.templateId} ${view.template.version}`],
    ['Model', `${view.model.modelId} ${view.model.version}`],
    ['Saved stage', `${view.activity.stageId}${view.activity.closed ? ' (closed)' : ''}`],
    ['Context', contextText],
    ['Mode', modeText],
    ['Position', position],
    ['Saved record', `${view.artifact.kind === 'backup' ? 'Backup' : 'Learner snapshot'} ${view.artifact.artifactId}`],
    ['Journal checkpoint', `Event ${view.journal.lastSequence}${view.journal.pendingEvents ? `, ${view.journal.pendingEvents} not yet acknowledged` : ''}`],
  ] : [
    // The activity title, when named, is the heading.
    ...(stageName ? [['Saved step', `${stageName}${view.activity.closed ? ' (the activity was closed)' : ''}`] as [string, string]]
      : view.activity.closed ? [['Status', 'The activity was closed'] as [string, string]] : []),
    ['Context', contextText],
    ['Mode', modeText],
    ['Position', position],
    ['Saved record', view.artifact.kind === 'backup' ? 'A saved copy of the activity' : 'A copy of what was shown'],
  ];
  const parameterName = (id: string): string | null => full ? id : nameOf(named?.parameters, id);
  const parameters = view.parameters?.flatMap(item => { const name = parameterName(item.parameter); return name ? [{ ...item, name }] : []; }) ?? null;
  const unnamedParameters = (view.parameters?.length ?? 0) - (parameters?.length ?? 0);
  const groupText = (groups: readonly string[]): string => {
    if (full) return groups.join(', ');
    const names = groups.flatMap(id => { const name = nameOf(named?.groups, id); return name ? [name] : []; });
    const unnamed = groups.length - names.length;
    return [...names, ...(unnamed ? [names.length ? `${count(unnamed, 'other part', 'other parts')} of the activity` : `${count(unnamed, 'part', 'parts')} of the activity`] : [])].join(', ');
  };
  return (
    <section ref={rootRef} className="eka" data-theme={theme} lang={locale} style={variables} aria-labelledby={titleId} data-eka-archival={view.artifact.artifactId} data-audience={view.audience}>
      <div className="eka-card">
        <header className="eka-header">
          <div className="eka-heading">
            <Heading level={headingLevel} id={titleId} className="eka-title">{!full && named?.title ? `${named.title} — saved, read-only` : 'Saved activity — read-only record'}</Heading>
            <p className="eka-subtitle">Nothing is calculated again and no other model is used in its place.</p>
          </div>
          <div className="eka-meta"><span className="eka-chip">Read-only</span></div>
        </header>
        <section className="eka-panel" aria-labelledby={stateId}>
          <Heading level={sub} id={stateId} className="eka-panel-title">What was saved</Heading>
          <dl className="eka-values">
            {facts.map(([label, value]) => <div key={label} className="eka-value-row"><dt>{label}</dt><dd>{value}</dd></div>)}
          </dl>
        </section>
        <section className="eka-panel" aria-labelledby={valuesId}>
          <Heading level={sub} id={valuesId} className="eka-panel-title">Saved values</Heading>
          {parameters ? (
            parameters.length ? (
              <div className="eka-table-region" role="region" aria-labelledby={valuesId} tabIndex={0}>
                <table className="eka-table">
                  <thead><tr><th scope="col">Parameter</th><th scope="col">Value (model units)</th></tr></thead>
                  <tbody>{parameters.map(item => <tr key={item.parameter}><th scope="row">{item.name}</th><td>{formatShown(item.value, locale)}</td></tr>)}</tbody>
                </table>
              </div>
            ) : unnamedParameters ? null : <p className="eka-panel-note">No parameter values are listed.</p>
          ) : <p className="eka-panel-note">{full ? 'Saved values are listed for the host. A learner snapshot carries the values that were visible.' : 'The saved settings are kept with the record; a copy of what was shown lists the values that were visible.'}</p>}
          {unnamedParameters ? <p className="eka-panel-note">{count(unnamedParameters, 'saved value is', 'saved values are')} kept but not listed here, because {unnamedParameters === 1 ? 'its name is' : 'their names are'} not available.</p> : null}
          {view.comparisons.length ? (
            <ul className="eka-notes">
              {view.comparisons.map((item, index) => {
                const values = item.parameters?.flatMap(entry => { const name = parameterName(entry.parameter); return name ? [`${name} = ${formatShown(entry.value, locale)}`] : []; }) ?? [];
                return <li key={`${index}:${item.label}`}>Comparison “{item.label}” at {positionText(item.position, locale)}{values.length ? `: ${values.join(', ')}` : ''}</li>;
              })}
            </ul>
          ) : null}
        </section>
        <section className="eka-panel" aria-labelledby={exposureId}>
          <Heading level={sub} id={exposureId} className="eka-panel-title">Content shown</Heading>
          {view.exposures.length ? (
            <ul className="eka-notes">
              {view.exposures.map((item, index) => <li key={`${index}:${item.groups.join(',')}`}>{groupText(item.groups)}: {STATUS_TEXT[item.displayStatus]}{item.uncertainty ? ` (${item.uncertainty})` : ''}</li>)}
            </ul>
          ) : <p className="eka-panel-note">No exposure records are listed.</p>}
        </section>
        {view.notes.length ? <ul className="eka-notes" aria-label="Notes">{view.notes.map((note, index) => <li key={`${index}:${note}`}>{note}</li>)}</ul> : null}
        {returnAction ? (
          <footer className="eka-footer">
            <p className="eka-review">This saved activity cannot be opened again here; nothing in it was changed.</p>
            <div className="eka-footer-actions">
              {returnAction.status ? <span className="eka-next-status" role="status">{returnAction.status}</span> : null}
              <button type="button" className="eka-button eka-button-primary" aria-disabled={returnAction.disabled || undefined}
                onClick={() => { if (!returnAction.disabled) returnAction.onSelect(); }}>{returnAction.label}</button>
            </div>
          </footer>
        ) : null}
      </div>
    </section>
  );
}

export interface MountedArchivalRecord { readonly element: HTMLElement; dispose(): void }
/** Mounts an {@link ArchivalRecord} into its own shadow root (style isolation, like `mountStudyActivity`). Idempotent dispose. */
export function mountArchivalRecord(container: HTMLElement, view: ArchivalView, options: Omit<ArchivalRecordProps, 'view'> = {}): MountedArchivalRecord {
  if (!container || typeof container.appendChild !== 'function' || !container.ownerDocument) throw new TypeError('mountArchivalRecord requires a browser HTMLElement container.');
  if (!view || view.kind !== 'archival-view' || view.readOnly !== true) throw new TypeError('mountArchivalRecord requires an ArchivalView from archivalView().');
  const element = container.ownerDocument.createElement('div');
  element.setAttribute('data-experiment-kit-archival', view.artifact.artifactId);
  const shadow = element.attachShadow({ mode: 'open' });
  const styles = adoptActivityStyles(shadow);
  container.appendChild(element);
  const root = createRoot(shadow);
  let disposed = false;
  // The host's return action never runs after dispose.
  const returnAction = options.returnAction && { ...options.returnAction, onSelect: () => { if (!disposed) options.returnAction?.onSelect(); } };
  flushSync(() => root.render(<ArchivalRecord view={view} {...options} returnAction={returnAction} />));
  return {
    element,
    dispose() {
      if (disposed) return;
      disposed = true;
      root.unmount();
      styles.release();
      element.remove();
    },
  };
}
