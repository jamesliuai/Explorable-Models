// Host chrome (plain DOM, no innerHTML, no style attributes). Every control here is host-owned; the learner card is
// mounted separately and never sees this panel. All of it is labelled as the reference host, a conformance fixture.
import type { ReferenceHostApp } from './app';
import { onCall, type CallRecord } from './native-bridge';

type Child = Node | string | null | false | undefined;
function el<K extends keyof HTMLElementTagNameMap>(tag: K, props: { className?: string; text?: string; attrs?: Record<string, string> } = {}, ...children: Child[]): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (props.className) node.className = props.className;
  if (props.text !== undefined) node.textContent = props.text;
  for (const [name, value] of Object.entries(props.attrs ?? {})) node.setAttribute(name, value);
  for (const child of children) if (child !== null && child !== false && child !== undefined) node.append(child);
  return node;
}
function button(label: string, action: string, onClick: () => void, options: { disabled?: boolean; primary?: boolean; key?: string; describedBy?: string } = {}): HTMLButtonElement {
  const node = el('button', { className: options.primary ? 'host-button host-button-primary' : 'host-button', text: label, attrs: { type: 'button', 'data-host-action': action } });
  if (options.key) node.dataset.hostKey = options.key;
  if (options.describedBy) node.setAttribute('aria-describedby', options.describedBy);
  node.disabled = options.disabled ?? false;
  node.addEventListener('click', () => { if (!node.disabled) onClick(); });
  return node;
}
function section(title: string, id: string, ...children: Child[]): HTMLElement {
  return el('section', { className: 'host-section', attrs: { 'aria-labelledby': id } }, el('h2', { className: 'host-h2', text: title, attrs: { id } }), ...children);
}
const short = (id: string): string => id.length > 16 ? `${id.slice(0, 12)}…` : id;

export function mountHostChrome(panel: HTMLElement, app: ReferenceHostApp): void {
  const calls: CallRecord[] = [];
  onCall(record => { calls.unshift(record); calls.length = Math.min(calls.length, 12); schedule(); });
  let pendingDelete: string | null = null;
  let selectedTemplate = '';
  // Batched with a zero-delay task, not requestAnimationFrame: WebKit stops animation frames for hidden or occluded
  // windows, and the host panel must keep reflecting host state while the window is not visible.
  let scheduled = false;
  const schedule = () => { if (!scheduled) { scheduled = true; setTimeout(() => { scheduled = false; render(); }, 0); } };
  app.subscribe(schedule);

  function render(): void {
    const focused = document.activeElement instanceof HTMLElement && panel.contains(document.activeElement)
      ? { action: document.activeElement.dataset.hostAction, key: document.activeElement.dataset.hostKey } : null;
    const snapshot = app.getSnapshot();
    const busy = snapshot.busy !== null;
    const current = snapshot.current, projection = snapshot.projection;
    const state = current ? app.hostState() : null;

    const approved = snapshot.status?.approved ?? [];
    if (!selectedTemplate && approved.length) selectedTemplate = `${approved.find(entry => entry.templateId === 'quadratic-gradient-descent')?.templateId ?? approved[0]!.templateId}@${approved[0]!.version}`;
    const select = el('select', { className: 'host-select', attrs: { id: 'host-template', 'data-host-action': 'select-template' } });
    for (const entry of approved) {
      const option = el('option', { text: `${entry.title} (${entry.lifecycle})`, attrs: { value: `${entry.templateId}@${entry.version}` } });
      option.selected = `${entry.templateId}@${entry.version}` === selectedTemplate;
      select.append(option);
    }
    select.disabled = busy;
    select.addEventListener('change', () => { selectedTemplate = select.value; });

    const archival = snapshot.archival;
    const activity = archival ? el('p', { className: 'host-note', attrs: { 'data-host-archival': archival.activityId } },
      `Archival read-only record of ${short(archival.activityId)} (artifact ${short(archival.artifactId)}): the saved activity could not be reopened (${archival.codes.join(', ')}). Nothing is evaluated; the host keeps every record.`)
      : current && projection ? el('dl', { className: 'host-facts' },
      el('dt', { text: 'Activity' }), el('dd', { text: `${current.template.title} · ${short(current.activityId)}` }),
      el('dt', { text: 'Context' }), el('dd', { text: projection.context === 'independent' ? `independent task (${current.taskRef ?? ''})` : 'instructional', attrs: { 'data-host-context': projection.context } }),
      el('dt', { text: 'Stage' }), el('dd', { text: projection.stage.id, attrs: { 'data-host-stage': projection.stage.id } }),
      el('dt', { text: 'Revisions' }), el('dd', { text: `activity ${projection.activityRevision} · policy ${projection.policyRevision} · presentation ${projection.presentationRevision}` }),
      el('dt', { text: 'Persistence' }), el('dd', { text: projection.status.persistence, attrs: { 'data-host-persistence': projection.status.persistence } }),
      el('dt', { text: 'Card state' }), el('dd', { text: projection.status.ui }),
    ) : el('p', { className: 'host-note', text: snapshot.phase === 'starting' ? 'Starting the host…' : 'No activity is open.' });

    const independent = projection?.context === 'independent';
    const stageButtons = app.stageControls().map(control => button(`→ ${control.label}`, 'stage', () => void app.transition(control.toStage), { disabled: busy, key: control.toStage }));
    const held = app.heldBackGroups();
    const exploration = app.explorationRequest();
    const stageSection = section('Stage controls (host)', 'host-stage-title',
      el('p', { className: 'host-note', text: 'Generated from the template transitions. Solution-bearing content stays hidden until the host authorizes it and records the exposure.' }),
      stageButtons.length ? el('div', { className: 'host-row' }, ...stageButtons)
        : el('p', { className: 'host-note', text: !current ? 'Open an activity to see its stage controls.' : independent ? 'Independent task: no instructional stage controls.' : 'No transition from this stage.' }),
      held.length ? button(`Authorize and reveal: ${held.map(group => group.label).join(', ')}`, 'reveal', () => void app.reveal(), { disabled: busy, primary: true }) : null,
      exploration && !app.explorationCovered() ? button('Authorize exploration (live preview)', 'exploration', () => void app.authorizeExploration(), { disabled: busy }) : null,
    );

    const closePending = el('select', { className: 'host-select', attrs: { id: 'host-close-pending', 'data-host-action': 'close-pending' } });
    for (const [value, label] of [['cancel', 'cancel it'], ['commit', 'commit it'], ['retain', 'keep it as a draft']] as const) {
      const option = el('option', { text: label, attrs: { value } });
      option.selected = snapshot.closePending === value;
      closePending.append(option);
    }
    closePending.disabled = busy;
    closePending.addEventListener('change', () => app.setClosePending(closePending.value as 'cancel' | 'commit' | 'retain'));
    const actions = section('Host actions', 'host-actions-title',
      el('div', { className: 'host-row' },
        button('Save', 'save', () => void app.save(), { disabled: busy || !current }),
        button('Close', 'close', () => void app.close(), { disabled: busy || !current }),
        button('Start independent task', 'independent-task', () => void app.startIndependentTask(), { disabled: busy || (!current && !snapshot.activities.length) }),
        button('Reopen teaching visual (assistance)', 'reopen-assistance', () => void app.reopenInstructional(), { disabled: busy || !independent }),
      ),
      el('label', { className: 'host-label', text: 'On Close, an active preview: (host policy)', attrs: { for: 'host-close-pending' } }),
      el('div', { className: 'host-row host-row-fill' }, closePending),
      el('label', { className: 'host-label', text: 'Approved template', attrs: { for: 'host-template' } }),
      el('div', { className: 'host-row host-row-fill' }, select,
        button('Open activity', 'open', () => { const [templateId, version] = selectedTemplate.split('@'); if (templateId && version) void app.openActivity(templateId, version); }, { disabled: busy || !selectedTemplate }),
      ),
    );

    const rows = snapshot.activities.map(item => el('li', { className: 'host-record', attrs: { 'data-host-activity': item.activityId } },
      el('p', { className: 'host-record-title', text: `${item.templateId}${item.kind === 'independent-task' ? ' · independent task' : ''}${current?.activityId === item.activityId ? ' · open' : ''}` }),
      el('p', { className: 'host-note', text: `${short(item.activityId)} · stage ${item.stage}${item.closed ? ` (closed${item.closedPending ? `; preview ${item.closedPending === 'retain' ? 'kept as a draft' : `${item.closedPending === 'commit' ? 'committed' : 'cancelled'}`}` : ''})` : ''} · ${item.events} events · exposures ${item.exposures.displayed}/${item.exposures.uncertain}/${item.exposures.authorized}` }),
      el('div', { className: 'host-row' },
        button('Reopen', 'reopen', () => void app.reopen(item.activityId), { disabled: busy || !item.hasBackup || current?.activityId === item.activityId, key: item.activityId }),
        pendingDelete === item.activityId
          ? button('Confirm delete', 'confirm-delete', () => { pendingDelete = null; void app.deleteActivity(item.activityId); }, { disabled: busy, key: item.activityId })
          : button('Delete', 'delete', () => { pendingDelete = item.activityId; schedule(); }, { disabled: busy, key: item.activityId }),
        pendingDelete === item.activityId ? button('Cancel', 'cancel-delete', () => { pendingDelete = null; schedule(); }, { key: item.activityId }) : null,
      ),
    ));
    const records = section('Host records', 'host-records-title',
      rows.length ? el('p', { className: 'host-note', text: 'Exposures: displayed / uncertain / authorized.' }) : null,
      rows.length ? el('ul', { className: 'host-records' }, ...rows) : el('p', { className: 'host-note', text: 'The host holds no activity records.' }),
      el('div', { className: 'host-row' }, button('Export portable backup', 'export', () => void app.exportBackup(), { disabled: busy || !snapshot.activities.length })),
      snapshot.lastExport ? el('p', { className: 'host-note', attrs: { 'data-host-export': snapshot.lastExport.sha256 } },
        `Wrote ${snapshot.lastExport.fileName} (${snapshot.lastExport.activities} activities, ${snapshot.lastExport.events} events) to ${snapshot.status?.exportsFolder ?? 'the exports folder'}.`) : null,
      snapshot.backups.length ? el('ul', { className: 'host-list' }, ...snapshot.backups.map(backup => el('li', {},
        `Import folder: ${backup.backupSha256.slice(0, 12)}… ${backup.valid ? `${backup.activities ?? 0} activities` : `invalid (${backup.code ?? ''})`}${backup.importedAt ? ' · imported' : ''} `,
        backup.valid && !backup.importedAt ? button('Import', 'import', () => void app.importBackup(backup.backupSha256), { disabled: busy, key: backup.backupSha256 }) : null))) : null,
    );

    const status = snapshot.status;
    const diagnostics = section('Host status', 'host-status-title',
      el('p', { className: 'host-note', text: status ? `Host start ${status.starts} · SQLite ${status.database.journalMode}, synchronous=${status.database.synchronous === 2 ? 'FULL' : status.database.synchronous} · ${status.recoveries.length} restart recoveries` : '…' }),
      state ? el('p', { className: 'host-note', text: `Exposures: ${(state.exposures ?? []).map(record => `${record.scope}:${record.displayStatus}`).join(', ') || 'none'}` }) : null,
      snapshot.restoredNotes.length ? el('ul', { className: 'host-list' }, ...snapshot.restoredNotes.map(note => el('li', { text: note }))) : null,
      snapshot.pendingDraft ? el('p', { className: 'host-note', attrs: { 'data-host-pending-draft': snapshot.pendingDraft.previewId } },
        `Retained draft, not committed (re-offer it to the learner if the activity continues): ${Object.entries(snapshot.pendingDraft.params).map(([key, value]) => `${key} = ${value}`).join(', ')}.`) : null,
      el('ul', { className: 'host-list host-log', attrs: { 'aria-label': 'Host log' } }, ...snapshot.log.slice(0, 12).map(line => el('li', { text: line }))),
      el('p', { className: 'host-note', text: `Recent native calls: ${calls.slice(0, 6).map(call => `${call.command}${call.ok ? '' : ` (${call.code}${call.reason ? `/${call.reason}` : ''})`}`).join(', ') || 'none'}` }),
    );

    const error = snapshot.error ? el('p', { className: 'host-error', text: snapshot.error, attrs: { role: 'alert' } }) : null;
    const live = el('p', { className: 'host-sr', text: snapshot.busy ? `${snapshot.busy}…` : '', attrs: { role: 'status' } });
    panel.replaceChildren(...[error, section('Activity', 'host-activity-title', activity), stageSection, actions, records, diagnostics, live].filter((node): node is HTMLElement => node !== null));
    panel.dataset.hostBusy = busy ? 'true' : 'false';
    panel.dataset.hostPhase = snapshot.phase;
    if (focused?.action) {
      const selector = `[data-host-action="${focused.action}"]${focused.key ? `[data-host-key="${CSS.escape(focused.key)}"]` : ''}`;
      (panel.querySelector<HTMLElement>(selector) ?? null)?.focus();
    }
  }
  render();
}
