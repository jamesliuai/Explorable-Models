import { useEffect, useId, useRef, useState } from 'react';
import type { CSSProperties, PointerEvent as ReactPointerEvent } from 'react';
import type { DocumentInteractionController, InteractionState, ParameterSpec } from '@experiment-kit/core/declarative';
import { fmt } from './scenes/shared';

const NAVIGATION_KEYS = ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown'];

/**
 * Pointer gesture of one range input. A drag previews and commits once on release; Escape or pointer cancellation
 * cancels it, and the still-pressed pointer then changes nothing until it is released (WebKit reports the release
 * position as one more value change, which would otherwise start and commit a new run). A value change the release
 * itself produces in the same task (Firefox's release-position `change`, after `pointerup`) belongs to that release and
 * starts nothing. A key starts a new gesture.
 *
 * Range inputs take no explicit pointer capture: the native slider keeps its pressed pointer itself (Chromium, Firefox
 * and WebKit deliver the release to it, also outside its box), and `setPointerCapture` stops WebKit's thumb from
 * following the pointer at all. The pressed slider takes focus so that Escape reaches it: WebKit on macOS gives a pressed
 * range input no focus and blurs the focused element while it handles the press; that blur belongs to the press and
 * commits nothing (the same rules as the Study Harness learner surface's sliders).
 */
export function useRangeGesture(controller: Pick<DocumentInteractionController, 'commit' | 'cancel'>) {
  const pressed = useRef<number | null>(null);
  const pressing = useRef<number | null>(null);
  const cancelled = useRef(false);
  const releasing = useRef(false);
  return {
    /** A cancelled pointer gesture is still held, or the change comes from a release: the value change is ignored. */
    ignoring: () => cancelled.current || releasing.current,
    onPointerDown: (event: ReactPointerEvent<HTMLInputElement>) => {
      if (event.button !== 0) return;
      const id = event.pointerId, input = event.currentTarget;
      pressed.current = id; pressing.current = id; cancelled.current = false;
      input.focus({ preventScroll: true });
      setTimeout(() => {
        if (pressing.current === id) pressing.current = null;
        const root = input.getRootNode() as Document | ShadowRoot;
        if (pressed.current === id && input.isConnected && root.activeElement !== input) input.focus({ preventScroll: true });
      }, 0);
    },
    onPointerUp: (event: ReactPointerEvent<HTMLInputElement>) => {
      const held = pressed.current === event.pointerId;
      pressed.current = null; pressing.current = null;
      if (held) { releasing.current = true; setTimeout(() => { releasing.current = false; }, 0); }
      if (held && cancelled.current) { cancelled.current = false; return; }
      void controller.commit();
    },
    cancel: () => { controller.cancel(); if (pressed.current !== null) cancelled.current = true; },
    onKey: () => { pressed.current = null; pressing.current = null; cancelled.current = false; releasing.current = false; },
    /** Leaving the slider commits its gesture, except for the blur WebKit performs while it handles the press. */
    onBlur: () => { if (pressing.current === null && !cancelled.current) void controller.commit(); },
  };
}

export function Parameter({ id, spec, state, controller }: { id: string; spec: ParameterSpec; state: InteractionState; controller: DocumentInteractionController }) {
  const value = state.parameters[id], uid = useId();
  const gesture = useRangeGesture(controller);
  const [exact, setExact] = useState(String(value)), [error, setError] = useState('');
  useEffect(() => { setExact(String(Number(value.toFixed(4)))); setError(''); }, [value]);
  const apply = () => {
    const number = Number(exact);
    if (!exact.trim() || !Number.isFinite(number) || number < spec.min || number > spec.max) { setError(`Enter a value from ${spec.min} to ${spec.max}.`); return; }
    setError(''); void controller.commit({ [id]: number }).then(() => setExact(String(controller.getSnapshot().parameters[id])));
  };
  return <div className="ex-parameter">
    <div className="ex-parameter-heading"><label htmlFor={uid}>{spec.label}</label><form onSubmit={event => { event.preventDefault(); apply(); }}><input inputMode="decimal" aria-label={`${spec.label} exact value`} value={exact} disabled={state.saving} aria-invalid={!!error} aria-describedby={error ? `${uid}-error` : undefined} onChange={event => setExact(event.target.value)} onBlur={() => { if (exact !== String(value)) apply(); }} onKeyDown={event => { if (event.key === 'Escape') { setExact(String(value)); setError(''); controller.cancel(); } }} /><span>{spec.unit}</span></form></div>
    <input id={uid} aria-label={spec.label} type="range" min={spec.min} max={spec.max} step={spec.step} value={value} disabled={state.saving} style={{ '--fill': `${100 * (value - spec.min) / (spec.max - spec.min)}%` } as CSSProperties}
      onChange={event => { if (!gesture.ignoring()) controller.preview({ [id]: Number(event.target.value) }); }} onPointerDown={gesture.onPointerDown} onPointerUp={gesture.onPointerUp} onPointerCancel={gesture.cancel}
      onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); gesture.cancel(); } else if (NAVIGATION_KEYS.includes(event.key)) gesture.onKey(); }} onKeyUp={event => { if (NAVIGATION_KEYS.includes(event.key)) void controller.commit(); }} onBlur={gesture.onBlur} />
    <div className="ex-range-ends"><span>{spec.min}</span><span>{spec.max}</span></div>
    {error ? <p className="ex-error" id={`${uid}-error`} role="alert">{error}</p> : null}
  </div>;
}

export function Timeline({ state, controller }: { state: InteractionState; controller: DocumentInteractionController }) {
  const frame = state.rendered.frame!, end = frame.endTime!, time = state.previewTime ?? frame.time;
  const gesture = useRangeGesture(controller);
  return <div className="ex-timeline" aria-label="Flight playback">
    <div className="ex-play-buttons"><button className="ex-primary" disabled={state.saving || state.previewing} onClick={() => void controller.togglePlay()}>{state.rendered.playing ? 'Pause' : frame.terminal ? 'Replay' : 'Play'}</button><button disabled={state.saving} onClick={() => void controller.seek(0)}>Restart</button><button disabled={state.saving || state.previewing || state.rendered.playing || frame.terminal} onClick={() => void controller.step()}>Step</button></div>
    <input type="range" aria-label="Flight time" min="0" max="1" step="0.001" value={time / end} disabled={state.saving || state.rendered.playing} style={{ '--fill': `${100 * time / end}%` } as CSSProperties}
      onChange={event => { if (!gesture.ignoring()) controller.previewTime(Number(event.target.value) * end); }} onPointerDown={gesture.onPointerDown} onPointerUp={gesture.onPointerUp} onPointerCancel={gesture.cancel}
      onKeyDown={event => { if (event.key === 'Escape') gesture.cancel(); else if (NAVIGATION_KEYS.includes(event.key)) gesture.onKey(); }} onKeyUp={event => { if (NAVIGATION_KEYS.includes(event.key)) void controller.commit(); }} onBlur={gesture.onBlur} />
    <span className="ex-time">{fmt(time)} / {fmt(end)} s</span>
  </div>;
}
