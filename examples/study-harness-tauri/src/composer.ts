// Host-owned response composer, passed to the learner card through `responseSlot`. The card renders it inside its own
// response region; the text goes to the native host's responses table and the activity receives only the reference.
// Styled with the card's own classes (the shadow root does not see host styles); the few layout values are React style
// props, which React applies through CSSOM, never as parsed style attributes (native.md N4).
import { createElement, useState, useSyncExternalStore, type FormEvent, type ReactElement } from 'react';
import type { ReferenceHostApp } from './app';

const FORM_STYLE = { display: 'grid', gap: '0.5rem' } as const;
const TEXT_STYLE = { width: '100%', maxWidth: 'none', minHeight: '5rem', padding: '0.5em 0.6em', boxSizing: 'border-box', resize: 'vertical', fontVariantNumeric: 'normal' } as const;

function Composer({ app }: { app: ReferenceHostApp }): ReactElement {
  const snapshot = useSyncExternalStore(app.subscribe, app.getSnapshot);
  const [text, setText] = useState('');
  const request = snapshot.current ? app.composerRequest() : null;
  if (!request) {
    return createElement('p', { className: 'eka-panel-note', 'data-host-composer': 'idle' },
      snapshot.composerStatus || 'The host collects a response here when the activity asks for one.');
  }
  const busy = snapshot.busy !== null;
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    void app.submitResponse(text).then(failure => { if (!failure) setText(''); });
  };
  return createElement('form', { onSubmit: submit, 'data-host-composer': request.kind, 'aria-label': `${request.label} (host composer)`, style: FORM_STYLE },
    // The card already shows a stage's own response prompt; the host adds only its independent-task prompt.
    createElement('p', { className: 'eka-panel-note' }, `${request.kind === 'answer' ? `${request.prompt} ` : ''}The reference host stores this text; the activity receives only a reference.`),
    createElement('label', { className: 'eka-panel-title', htmlFor: 'host-composer-text' }, request.label),
    createElement('textarea', {
      id: 'host-composer-text', className: 'eka-input', rows: 3, value: text, maxLength: 4000, 'data-host-composer-text': '', style: TEXT_STYLE,
      onChange: (event: { target: { value: string } }) => setText(event.target.value),
    }),
    createElement('div', { className: 'eka-footer-actions' },
      createElement('button', { type: 'submit', className: 'eka-button eka-button-primary', 'aria-disabled': busy || undefined, 'data-host-action': 'submit-response' },
        `Submit ${request.label.replace(/^Your /, '').toLowerCase()}`),
      snapshot.composerStatus ? createElement('span', { className: 'eka-next-status', role: 'status' }, snapshot.composerStatus) : null));
}

export function composerElement(app: ReferenceHostApp): ReactElement {
  return createElement(Composer, { app });
}
