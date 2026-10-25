import { useEffect, useId, useState, useSyncExternalStore } from 'react';
import type { CSSProperties } from 'react';
import type { ParameterSpec } from '@experiment-kit/core/declarative';
import type { RodController } from './controller';
import { rodDocument } from './document';
import { format, RodDiagram, scalar } from './RodDiagram';

function Parameter({ id, spec, value, controller, disabled }: { id: string; spec: ParameterSpec; value: number; controller: RodController; disabled: boolean }) {
  const uid = useId();
  const [exact, setExact] = useState(String(value));
  const [error, setError] = useState('');
  useEffect(() => { setExact(String(Number(value.toFixed(2)))); setError(''); }, [value]);
  const symbol = id === 'angle' ? 'θ' : id === 'length' ? 'L' : 'g';
  const apply = () => {
    const n = Number(exact);
    if (!exact.trim() || !Number.isFinite(n) || n < spec.min || n > spec.max) { setError(`Enter ${spec.min} to ${spec.max}.`); return; }
    setError(''); void controller.commit({ [id]: n }).then(() => setExact(String(Number(controller.getSnapshot().parameters[id].toFixed(2)))));
  };
  return <div className="rod-parameter">
    <div className="parameter-heading">
      <label htmlFor={`${uid}-slider`}>{spec.label}, <i>{symbol}</i></label>
      <form onSubmit={event => { event.preventDefault(); apply(); }}>
        <input className="exact-input" aria-label={`${spec.label} exact value`} aria-describedby={`${uid}-hint${error ? ` ${uid}-error` : ''}`} aria-invalid={!!error} inputMode="decimal" value={exact} disabled={disabled} onChange={event => setExact(event.target.value)} onBlur={() => { if (exact !== String(Number(value.toFixed(2)))) apply(); }} onKeyDown={event => { if (event.key === 'Escape') { setExact(String(value)); setError(''); controller.cancel(); } }} />
        <span className="parameter-unit">{spec.unit}</span>
      </form>
    </div>
    <input id={`${uid}-slider`} type="range" min={spec.min} max={spec.max} step={spec.step} value={value} disabled={disabled} style={{ '--fill': `${100 * (value - spec.min) / (spec.max - spec.min)}%` } as CSSProperties}
      aria-label={spec.label} aria-describedby={`${uid}-hint`} aria-valuetext={`${format(value, id === 'angle' ? 1 : 2)} ${spec.unit}`}
      onChange={event => controller.preview({ [id]: Number(event.target.value) })}
      onPointerDown={event => event.currentTarget.setPointerCapture(event.pointerId)}
      onPointerUp={() => void controller.commit()} onPointerCancel={() => controller.cancel()}
      onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); controller.cancel(); } }}
      onKeyUp={event => { if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown'].includes(event.key)) void controller.commit(); }}
      onBlur={() => void controller.commit()} />
    <div className="range-ends" id={`${uid}-hint`}><span>{spec.min}{id === 'angle' ? '°' : ''}</span><span>{spec.max}{id === 'angle' ? '°' : ''}</span></div>
    {error ? <p id={`${uid}-error`} className="input-error" role="alert">{error}</p> : null}
  </div>;
}

/** Embeddable host component; the caller owns and disposes its controller. */
export function RodCard({ controller }: { controller: RodController }) {
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot);
  const frame = state.rendered.frame!;
  const unavailable = Object.values(frame.quantities).find(result => result.status === 'undefined');
  const tangential = unavailable ? null : scalar(frame, 'tangential');
  const angular = unavailable ? null : scalar(frame, 'alpha');
  const uid = useId();
  return <article className="rod-card" aria-labelledby={`${uid}-title`} data-preview={state.previewing} aria-busy={state.saving}>
    <header className="rod-card-heading"><h1 id={`${uid}-title`}>A rod, released from rest</h1><p>Change the angle. Watch the acceleration respond.</p></header>
    <div className="rod-experiment">
      <div className="rod-workbench">
        <div className="rod-canvas">
          {unavailable ? <p role="status">Model unavailable: {unavailable.reason}</p> : <RodDiagram state={state.rendered} />}
          <div className="canvas-caption"><span className={state.previewing ? 'preview-dot active' : 'preview-dot'} />{state.previewing ? 'Live preview · release to keep · Esc to cancel' : 'At the instant of release · initially at rest'}</div>
        </div>
        <div className="rod-controls" role="group" aria-label="Rod parameters">
          {Object.entries(rodDocument.parameters).map(([id, spec]) => <Parameter key={id} id={id} spec={spec} value={state.parameters[id]} controller={controller} disabled={state.saving} />)}
          <div className="controls-footer"><span>Drag to explore.<br />Type a value for precision.</span><button type="button" onClick={() => void controller.reset()} disabled={state.saving}>Reset</button></div>
        </div>
      </div>
      <div className="rod-results">
        <div><output aria-live="off" data-testid="tangential-value" className="teal">{tangential === null ? 'Undefined' : format(tangential)} <span>m/s²</span></output><span>Tangential acceleration, <i>a<sub>t</sub></i></span><small>at the center of mass</small></div>
        <div><output aria-live="off" data-testid="angular-value" className="violet">{angular === null ? 'Undefined' : format(angular)} <span>rad/s²</span></output><span>Angular acceleration, <i>α</i></span><small>{angular === 0 ? 'no initial rotation' : 'clockwise about the hinge'}</small></div>
      </div>
    </div>
    {state.error ? <p className="card-error" role="alert">{state.error} The last saved configuration is still available.</p> : null}
    <p className="rod-insight">{tangential === 0 ? 'No gravitational torque means no initial acceleration. Increase the angle and gravity to explore.' : <>At the same angle and gravity, a longer rod has less angular acceleration. Its center has the same tangential acceleration: <span className="formula">a<sub>t</sub> = ¾g sin θ.</span></>}</p>
    <details className="rod-model"><summary>Model &amp; assumptions</summary><div>
      <p>A uniform rigid rod of length <i>L</i> pivots about a fixed, frictionless hinge. Gravity is uniform. The rod starts at rest, with θ measured from downward vertical.</p>
      <div className="model-equations"><span>I = ⅓mL²</span><span>τ = mg(L/2) sin θ</span><span>α = τ/I = 3g sin θ / (2L)</span><span>a<sub>t</sub> = αL/2 = ¾g sin θ</span></div>
      <p>Since the initial angular speed is zero, the centripetal acceleration is also zero. The teal arrow shows the center-of-mass acceleration; the free end accelerates twice as much. This card explores the instant of release, not the subsequent swing.</p>
      <p className="model-note">Diagram scale: 105 units per metre (85 in the compact view). Teal arrow scale: 14 units per m/s² (10 in the compact view). The purple arrow indicates direction, not magnitude. The model has automated reference checks; it has not had independent scientific review.</p>
    </div></details>
  </article>;
}
