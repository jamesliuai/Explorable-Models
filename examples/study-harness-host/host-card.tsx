/**
 * BROWSER INTEGRATION FIXTURE — the generic flow's learner card with the host's response composer in the card's
 * response slot (report §10.1: the application owns the composer; the card provides the slot).
 *
 * `mountStudyActivity` takes its props once, so a host whose slot content changes with the activity (a composer
 * while the stage requests a response, nothing otherwise) uses the React entry instead, as here: the public
 * `StudyActivitySurface` rendered into a shadow root this host owns, re-rendered with the current `responseSlot`. The
 * returned handle has the `MountedStudyActivity` shape (element, surfaceId, ready, capture, dispose), and the shadow
 * host carries the same `data-experiment-kit-activity` attribute, so browser helpers address both mounts alike.
 *
 * The composer is host UI: the response text goes to the host tables (`FixtureHost.recordResponse`); the activity only
 * ever receives a response reference (`submitResponseRef`). The composer component keeps its identity while the card
 * re-renders (keyed by the response request), so typed text, focus and the submit status survive projection updates.
 * Its styles are a constructable stylesheet adopted into the shadow root (no style attributes, no inline `<style>`),
 * drawing on the card's documented `--eka-*` host tokens so it follows the card theme.
 */
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { useId, useLayoutEffect, useState, useSyncExternalStore } from 'react';
import type { FormEvent, Ref } from 'react';
import {
  adoptActivityStyles, CaptureError, StudyActivitySurface,
  type CaptureOptions, type CaptureResult, type MountedStudyActivity, type StudyActivityHandle, type StudyActivitySurfaceProps,
} from '@experiment-kit/player/activity';

/** A response the host currently requests from the learner (prediction/explanation from the stage, answer in an independent task). */
export interface ResponseRequest {
  /** Stable while the same request is open (the composer is keyed by it). */
  key: string;
  kind: 'prediction' | 'explanation' | 'answer';
  label: string;
  /** Response ID once the activity holds the reference; null while the response is still requested. */
  recorded: string | null;
}
/** What the composer needs from the host session. `responseRequest` must return the same object while nothing changed. */
export interface ResponseSlotSource {
  subscribe(listener: () => void): () => void;
  responseRequest(): ResponseRequest | null;
  submitResponse(text: string): Promise<{ ok: boolean; message: string }>;
}

const SLOT_STYLES = `
.fx-slot{display:grid;gap:var(--eka-s2)}
.fx-slot-label{font-weight:650}
.fx-slot-textarea{box-sizing:border-box;width:100%;min-height:4.5em;padding:.4em .6em;border:1px solid var(--eka-border-strong);border-radius:calc(var(--eka-radius) - 3px);background:var(--eka-background);color:var(--eka-text);font:inherit;line-height:1.4;resize:vertical}
.fx-slot-row{display:flex;flex-wrap:wrap;align-items:center;gap:var(--eka-s2)}
.fx-slot-button{display:inline-flex;align-items:center;min-height:2.25rem;padding:0 .8em;border:1px solid var(--eka-primary);border-radius:calc(var(--eka-radius) - 2px);background:var(--eka-primary);color:var(--eka-on-primary);font:inherit;font-weight:600;cursor:pointer}
.fx-slot-button[aria-disabled=true]{opacity:.6;cursor:not-allowed}
.fx-slot-status:empty{display:none}
.fx-slot-status,.fx-slot-note{margin:0;color:var(--eka-text-muted);font-size:.875em}
.fx-slot-recorded{margin:0}
`;
const slotSheets = new WeakMap<Document, CSSStyleSheet>();
function adoptSlotStyles(root: ShadowRoot): void {
  const doc = root.ownerDocument;
  let sheet = slotSheets.get(doc);
  if (!sheet) { sheet = new (doc.defaultView ?? window).CSSStyleSheet(); sheet.replaceSync(SLOT_STYLES); slotSheets.set(doc, sheet); }
  if (!root.adoptedStyleSheets.includes(sheet)) root.adoptedStyleSheets = [...root.adoptedStyleSheets, sheet];
}

const NOUN: Record<ResponseRequest['kind'], string> = { prediction: 'prediction', explanation: 'explanation', answer: 'answer' };

function HostResponseComposer({ request, source }: { request: ResponseRequest; source: ResponseSlotSource }) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('');
  const noteId = useId();
  if (request.recorded) {
    return <p className="fx-slot-recorded" role="status" data-fx-response-recorded={request.kind}>{request.label} is recorded by the host (reference {request.recorded}). The text stays with the host.</p>;
  }
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setStatus('Recording…');
    const result = await source.submitResponse(text);
    setBusy(false);
    setStatus(result.ok ? '' : result.message);
    if (result.ok) setText('');
  };
  return (
    <form className="fx-slot" data-fx-composer={request.kind} onSubmit={submit}>
      <label className="fx-slot-label" htmlFor="fx-response">{request.label}</label>
      <textarea id="fx-response" className="fx-slot-textarea" rows={3} value={text} aria-describedby={noteId} onChange={event => setText(event.currentTarget.value)} />
      <div className="fx-slot-row">
        <button type="submit" className="fx-slot-button" aria-disabled={busy || undefined}>Submit {NOUN[request.kind]}</button>
        <span className="fx-slot-status" role="status">{status}</span>
      </div>
      <p className="fx-slot-note" id={noteId}>Host composer (integration fixture): the text stays with the host; the activity receives only a response reference. Nothing is evaluated.</p>
    </form>
  );
}

function HostCard({ props, source, handleRef, onFirstCommit }: { props: StudyActivitySurfaceProps; source: ResponseSlotSource; handleRef: Ref<StudyActivityHandle>; onFirstCommit(): void }) {
  const request = useSyncExternalStore(source.subscribe, source.responseRequest);
  // Runs after the surface's own layout effects of the first commit (children first).
  useLayoutEffect(() => { onFirstCommit(); }, []);
  const slot = request ? <HostResponseComposer key={request.key} request={request} source={source} /> : undefined;
  return <StudyActivitySurface {...props} responseSlot={slot} ref={handleRef} />;
}

export type HostCardOptions = Omit<StudyActivitySurfaceProps, 'responseSlot' | 'surfaceId'> & { surfaceId: string; source: ResponseSlotSource };

/** Mounts the learner card with the host response slot in a dedicated shadow root (see module comment). */
export function mountHostCard(container: HTMLElement, options: HostCardOptions): MountedStudyActivity {
  const { source, ...rest } = options;
  const surfaceId = options.surfaceId;
  const doc = container.ownerDocument;
  const element = doc.createElement('div');
  element.setAttribute('data-experiment-kit-activity', surfaceId);
  element.setAttribute('data-fx-host-card', '');
  const shadow = element.attachShadow({ mode: 'open' });
  // Component styles before the first render (no unstyled flash), then the host's slot styles.
  const styles = adoptActivityStyles(shadow, rest.assetBase);
  adoptSlotStyles(shadow);
  container.appendChild(element);

  let disposed = false;
  let settle: { resolve: () => void; reject: (error: Error) => void } | null = null;
  const ready = new Promise<void>((resolve, reject) => { settle = { resolve, reject }; });
  ready.catch(() => undefined);
  const handle: { current: StudyActivityHandle | null } = { current: null };
  // Host callbacks are wrapped so nothing reaches the host after dispose, even from late asynchronous work.
  const guard = <A extends unknown[]>(fn: ((...args: A) => void) | undefined) => fn && ((...args: A) => { if (!disposed) fn(...args); });
  const props: StudyActivitySurfaceProps = { ...rest, onDiagnostic: guard(rest.onDiagnostic), onRecoveryAction: guard(rest.onRecoveryAction) };
  const onFirstCommit = () => {
    const fonts = props.fonts === 'bundled' ? doc.fonts?.ready : undefined;
    Promise.resolve(fonts).then(() => { if (!disposed) settle?.resolve(); }, () => { if (!disposed) settle?.resolve(); });
  };
  const root = createRoot(shadow);
  flushSync(() => root.render(<HostCard props={props} source={source} onFirstCommit={onFirstCommit} handleRef={(value: StudyActivityHandle | null) => { handle.current = value; }} />));

  return {
    element,
    surfaceId,
    ready,
    async capture(captureOptions: CaptureOptions): Promise<CaptureResult> {
      if (disposed) throw new CaptureError('DISPOSED', 'This surface has been disposed.', 'Mount the activity again.');
      await ready;
      if (disposed || !handle.current) throw new CaptureError('DISPOSED', 'This surface has been disposed.', 'Mount the activity again.');
      return handle.current.capture(captureOptions);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      settle?.reject(new CaptureError('DISPOSED', 'The surface was disposed before it was ready.', 'Mount the activity again.'));
      root.unmount();
      styles.release();
      element.remove();
      handle.current = null;
    },
  };
}
