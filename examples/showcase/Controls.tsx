import { useEffect, useId, useState } from 'react';
import type { CSSProperties } from 'react';
import type { ParameterSpec } from '@experiment-kit/core/declarative';
import type { CardController, CardState } from '../shared/controller';
import { fmt } from './scenes/shared';

export function Parameter({ id, spec, state, controller }: { id: string; spec: ParameterSpec; state: CardState; controller: CardController }) {
  const value = state.parameters[id], uid = useId();
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
      onChange={event => controller.preview({ [id]: Number(event.target.value) })} onPointerDown={event => event.currentTarget.setPointerCapture(event.pointerId)} onPointerUp={() => void controller.commit()} onPointerCancel={controller.cancel}
      onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); controller.cancel(); } }} onKeyUp={event => { if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown'].includes(event.key)) void controller.commit(); }} onBlur={() => void controller.commit()} />
    <div className="ex-range-ends"><span>{spec.min}</span><span>{spec.max}</span></div>
    {error ? <p className="ex-error" id={`${uid}-error`} role="alert">{error}</p> : null}
  </div>;
}

export function Timeline({ state, controller }: { state: CardState; controller: CardController }) {
  const frame = state.rendered.frame!, end = frame.endTime!, time = state.previewTime ?? frame.time;
  return <div className="ex-timeline" aria-label="Flight playback">
    <div className="ex-play-buttons"><button className="ex-primary" disabled={state.saving || state.previewing} onClick={() => void controller.togglePlay()}>{state.rendered.playing ? 'Pause' : frame.terminal ? 'Replay' : 'Play'}</button><button disabled={state.saving} onClick={() => void controller.seek(0)}>Restart</button><button disabled={state.saving || state.previewing || state.rendered.playing || frame.terminal} onClick={() => void controller.step()}>Step</button></div>
    <input type="range" aria-label="Flight time" min="0" max="1" step="0.001" value={time / end} disabled={state.saving || state.rendered.playing} style={{ '--fill': `${100 * time / end}%` } as CSSProperties}
      onChange={event => controller.previewTime(Number(event.target.value) * end)} onPointerDown={event => event.currentTarget.setPointerCapture(event.pointerId)} onPointerUp={() => void controller.commit()} onPointerCancel={controller.cancel}
      onKeyDown={event => { if (event.key === 'Escape') controller.cancel(); }} onKeyUp={event => { if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown'].includes(event.key)) void controller.commit(); }} onBlur={() => void controller.commit()} />
    <span className="ex-time">{fmt(time)} / {fmt(end)} s</span>
  </div>;
}
