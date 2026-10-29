/**
 * Index/time navigation (report §8.4, §9, D9): start (n = 0), previous, next, play/pause and restart as one roving
 * toolbar, an integer readout such as “n = 3 of 1000”, and an exact “go to” entry. Indices are whole numbers: a
 * fractional entry is explained and never sent. Playback is driven by the adapter in whole steps; the surface shows no
 * interpolation and announces no frames while playing.
 *
 * Every unavailable button stays focusable with `aria-disabled` and a visible reason it references through
 * `aria-describedby` (already at the start, end of the computed run, playback not available here, a preview to finish
 * first, or the reason the whole card is inert). Go is guarded like the buttons: it never sends while a scientific
 * command or gesture completion is in flight.
 */
import { useState } from 'react';
import type { LearnerProjection, ProjectedNavigation, PositionRequest } from '@experiment-kit/activity';
import { formatPosition, parseDraft } from '../format.js';
import { Heading, useRoving, useRuntime, useStableId } from './context.js';

type NavButton = 'start' | 'back' | 'next' | 'play' | 'restart' | 'go';
const PREVIEW_REASON = 'finish or cancel the preview first';
const PLAYBACK_REASON = 'playback is not available in this part of the activity';
const STEPPING_REASON = 'stepping is not available in this part of the activity';
const TERMINAL_REASON = 'end of the computed run';

const PLAY_FACES = { play: ['▶', 'Play'], pause: ['❚❚', 'Pause'] } as const;
/**
 * The Play/Pause toggle draws both faces in one grid cell, the other one invisible and hidden from assistive
 * technology, so it is as wide as its wider face in every engine and font and never resizes when it toggles (a
 * minimum width alone left WebKit's Pause 0.6 px wider than Play, moving the buttons after it).
 */
function PlayFaces({ shown }: { shown: keyof typeof PLAY_FACES }) {
  const [icon, label] = PLAY_FACES[shown];
  const [spareIcon, spareLabel] = PLAY_FACES[shown === 'play' ? 'pause' : 'play'];
  return (
    <>
      <span className="eka-play-face"><span aria-hidden="true">{icon}</span>{label}</span>
      <span className="eka-play-face eka-play-spare" aria-hidden="true"><span>{spareIcon}</span>{spareLabel}</span>
    </>
  );
}

export function Navigation({ navigation, frame, headingLevel }: { navigation: ProjectedNavigation; frame: LearnerProjection['frame']; headingLevel: number }) {
  const runtime = useRuntime();
  const { binding } = runtime;
  const headingId = useStableId('eka-nav');
  const inputId = useStableId('eka-goto');
  const errorId = useStableId('eka-goto-error');
  const terminalId = useStableId('eka-nav-end');
  const inertId = useStableId('eka-nav-inert');
  const reasonBase = useStableId('eka-nav-why');
  const [draft, setDraft] = useState('');
  const [error, setError] = useState<string | null>(null);
  const roving = useRoving(5, 'horizontal');
  const guards = () => binding.getProjection().guards;
  const index = navigation.kind === 'index';
  const start: PositionRequest = index ? { kind: 'index', index: 0 } : { kind: 'time', time: 0 };
  const tentative = frame?.kind === 'tentative';
  const inert = runtime.inert;
  const busy = runtime.busy || runtime.settling;

  // Why each button is unavailable (busy is transient and not explained); grouped into one visible line per reason.
  const atStart = `already at the start (${index ? 'n = 0' : 't = 0'})`;
  const TRANSIENT = (text: string): boolean => text === PREVIEW_REASON || text === atStart;
  const backWhy = tentative ? PREVIEW_REASON : navigation.canStepBack ? null : navigation.value <= 0 ? atStart : STEPPING_REASON;
  const why: Record<NavButton, string | null> = {
    start: backWhy, back: backWhy,
    next: tentative ? PREVIEW_REASON : navigation.canStepForward ? null : navigation.terminal ? TERMINAL_REASON : STEPPING_REASON,
    play: !navigation.allowsPlayback ? PLAYBACK_REASON : navigation.terminal ? TERMINAL_REASON : tentative ? PREVIEW_REASON : null,
    restart: !navigation.allowsPlayback ? PLAYBACK_REASON : tentative ? PREVIEW_REASON : null,
    go: tentative ? PREVIEW_REASON : null,
  };
  const names: Record<NavButton, string> = { start: index ? 'n = 0' : 'Start', back: 'Back', next: 'Next', play: 'Play', restart: 'Restart', go: 'Go' };
  const terminalShown = !!frame?.terminal;
  const groups: { text: string; buttons: NavButton[]; id: string }[] = [];
  for (const button of Object.keys(why) as NavButton[]) {
    const text = why[button];
    if (!text || (text === TERMINAL_REASON && terminalShown) || (navigation.playing && button === 'play')) continue;
    const group = groups.find(item => item.text === text);
    if (group) group.buttons.push(button); else groups.push({ text, buttons: [button], id: `${reasonBase}-${groups.length}` });
  }
  const describedBy = (button: NavButton): string | undefined => {
    const text = why[button];
    const ids = [inert ? inertId : null, text === TERMINAL_REASON && terminalShown ? terminalId : groups.find(group => group.buttons.includes(button))?.id ?? null].filter(Boolean);
    return ids.length ? ids.join(' ') : undefined;
  };
  const off = (button: NavButton): boolean => !!why[button] || busy || !!inert;
  const science = (button: NavButton, command: () => ReturnType<typeof binding.step> | ReturnType<typeof binding.play>) => {
    if (off(button) || runtime.scienceBusy()) return;
    void runtime.run(command, 'science');
  };

  const go = () => {
    if (off('go') || runtime.scienceBusy()) return;
    const parsed = parseDraft(draft, runtime.locale);
    let message: string | null = null;
    if (!parsed.ok) message = parsed.message;
    else if (index && !Number.isInteger(parsed.value)) message = 'Iterations are whole numbers. Enter a whole number such as 3.';
    else if (parsed.value < 0 || (navigation.max !== null && parsed.value > navigation.max)) message = `Enter a value from 0 to ${navigation.max ?? 'the end'}.`;
    setError(message);
    if (message || !parsed.ok) { if (message) runtime.announce(message, 'error'); return; }
    const position: PositionRequest = index ? { kind: 'index', index: parsed.value } : { kind: 'time', time: parsed.value };
    void runtime.run(() => binding.navigate({ operationId: runtime.opId(), ...guards(), position }), 'science').then(outcome => { if (outcome?.ok && !runtime.disposed()) setDraft(''); });
  };

  return (
    <section className="eka-panel eka-nav" aria-labelledby={headingId} data-eka-frame-id={frame?.frameId}>
      <div className="eka-nav-row">
        <Heading level={headingLevel} id={headingId} className="eka-panel-title">{index ? 'Iterations' : 'Time'}</Heading>
        <output className="eka-position" aria-live="off">{formatPosition(navigation, runtime.locale)}</output>
      </div>
      <div className="eka-toolbar" role="toolbar" aria-label={`${index ? 'Iteration' : 'Time'} controls`} onKeyDown={roving.onKeyDown}>
        <button type="button" className="eka-button" {...roving.itemProps(0)} aria-disabled={off('start') || undefined} aria-describedby={describedBy('start')}
          onClick={() => science('start', () => binding.navigate({ operationId: runtime.opId(), ...guards(), position: start }))}>
          <span aria-hidden="true">⏮</span>{index ? 'n = 0' : 'Start'}
        </button>
        <button type="button" className="eka-button" {...roving.itemProps(1)} aria-label={`Back one ${index ? 'iteration' : 'step'}`} aria-disabled={off('back') || undefined} aria-describedby={describedBy('back')}
          onClick={() => science('back', () => binding.step({ operationId: runtime.opId(), ...guards(), delta: -1 }))}>
          <span aria-hidden="true">‹</span>Back
        </button>
        <button type="button" className="eka-button" {...roving.itemProps(2)} aria-label={`Next ${index ? 'iteration' : 'step'}`} aria-disabled={off('next') || undefined} aria-describedby={describedBy('next')}
          onClick={() => science('next', () => binding.step({ operationId: runtime.opId(), ...guards(), delta: 1 }))}>
          Next<span aria-hidden="true">›</span>
        </button>
        {navigation.playing ? (
          <button type="button" className="eka-button eka-play" {...roving.itemProps(3)} aria-disabled={!!inert || undefined} aria-describedby={inert ? inertId : undefined}
            onClick={() => { if (!inert) void runtime.run(() => binding.pause({ operationId: runtime.opId(), ...guards() }), 'science'); }}>
            <PlayFaces shown="pause" />
          </button>
        ) : (
          <button type="button" className="eka-button eka-play" {...roving.itemProps(3)} aria-disabled={off('play') || undefined} aria-describedby={describedBy('play')}
            onClick={() => science('play', () => binding.play({ operationId: runtime.opId(), ...guards() }))}>
            <PlayFaces shown="play" />
          </button>
        )}
        <button type="button" className="eka-button" {...roving.itemProps(4)} aria-disabled={off('restart') || undefined} aria-describedby={describedBy('restart')}
          onClick={() => science('restart', () => binding.restartPlayback({ operationId: runtime.opId(), ...guards() }))}>
          <span aria-hidden="true">↻</span>Restart
        </button>
      </div>
      {frame?.terminal ? <p className="eka-terminal" id={terminalId}>End of the computed run{frame.terminalDetail ? `: ${frame.terminalDetail}` : '.'}</p> : null}
      {inert ? <p className="eka-reason" id={inertId}><span className="eka-glyph" aria-hidden="true">–</span>{inert}</p> : null}
      {/* Reasons that come and go with the learner's own steps are announced, not shown, so the panel keeps its height while
          the learner previews, commits or plays (G40): a preview (explained under the controls in use; it always shows
          n = 0) and being at the start (the readout says n = 0). Lasting reasons of this part of the activity are visible. */}
      {groups.some(group => !TRANSIENT(group.text)) ? (
        <p className="eka-panel-note eka-nav-reasons">
          {groups.filter(group => !TRANSIENT(group.text)).map(group => <span key={group.id} id={group.id}>{`${group.buttons.map(button => names[button]).join(', ')}: ${group.text}. `}</span>)}
        </p>
      ) : null}
      {groups.filter(group => TRANSIENT(group.text)).map(group => <span key={group.id} id={group.id} className="eka-sr">{`${group.buttons.map(button => names[button]).join(', ')}: ${group.text}.`}</span>)}
      <div className="eka-exact">
        <label htmlFor={inputId}>Go to {index ? 'n =' : 't ='}</label>
        <input id={inputId} className="eka-input" type="text" inputMode={index ? 'numeric' : 'decimal'} autoComplete="off" value={draft} placeholder={index ? '0' : '0.0'}
          readOnly={!!inert} aria-disabled={!!inert || undefined}
          aria-invalid={error ? true : undefined} aria-describedby={[error ? errorId : null, describedBy('go') ?? null].filter(Boolean).join(' ') || undefined}
          onChange={event => setDraft(event.currentTarget.value)} onKeyDown={event => { if (event.key === 'Enter' && !event.nativeEvent.isComposing) { event.preventDefault(); go(); } }} />
        <button type="button" className="eka-button" aria-disabled={off('go') || undefined} aria-describedby={describedBy('go')} onClick={go}>Go</button>
      </div>
      {error ? <p className="eka-error" id={errorId}><span className="eka-glyph" aria-hidden="true">!</span>{error}</p> : null}
    </section>
  );
}
