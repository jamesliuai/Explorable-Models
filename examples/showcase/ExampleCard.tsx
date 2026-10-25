import { useId, useSyncExternalStore } from 'react';
import type { CardController } from '../shared/controller';
import type { Exhibit } from './catalog';
import { Parameter, Timeline } from './Controls';
import * as Scenes from './scenes';
import { fmt } from './scenes/shared';

const renderers = { projectile: Scenes.Projectile, forces: Scenes.Forces, waves: Scenes.Waves, light: Scenes.Light, matrix: Scenes.Matrix, probability: Scenes.Probability };
export function ExampleCard({ exhibit, controller }: { exhibit: Exhibit; controller: CardController }) {
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot), uid = useId();
  const doc = state.rendered.document!, frame = state.rendered.frame!, Scene = renderers[exhibit.id];
  const tir = exhibit.id === 'light' && frame.quantities.transmitted.status === 'undefined';
  return <article className="ex-card" data-example={exhibit.id} data-preview={state.previewing} aria-busy={state.saving} aria-labelledby={`${uid}-title`}>
    <header className="ex-card-heading"><h1 id={`${uid}-title`}>{doc.title}</h1><p>{exhibit.subtitle}</p></header>
    <div className="ex-workbench">
      <div className="ex-canvas"><Scene state={state.rendered} /><div className="ex-preview-note">{state.previewing ? 'Live preview · release to keep · Escape to cancel' : exhibit.id === 'projectile' ? 'Analytical trajectory · equal spatial scales' : 'Every shape and value follows the same model'}</div></div>
      <div className="ex-controls" role="group" aria-label="Model parameters">
        {exhibit.id === 'matrix' ? <div className="ex-matrix-value" aria-label="Current matrix"><span>M =</span><span className="ex-matrix-grid"><b>{fmt(state.rendered.run!.params.stretch, 2)}</b><b>{fmt(state.rendered.run!.params.shear, 2)}</b><b>0</b><b>{fmt(state.rendered.run!.params.vertical, 2)}</b></span></div> : null}
        {Object.entries(doc.parameters).map(([id, spec]) => <Parameter key={id} id={id} spec={spec} state={state} controller={controller} />)}
        <div className="ex-presets"><span>TRY A SCENARIO</span><div>{exhibit.presets.map(preset => <button key={preset.label} disabled={state.saving} onClick={() => void controller.commit(preset.params)}>{preset.label}</button>)}</div></div>
        <button className="ex-reset" disabled={state.saving} onClick={() => void controller.reset()}>Reset parameters</button>
      </div>
    </div>
    {doc.time ? <Timeline state={state} controller={controller} /> : null}
    <div className="ex-metrics" style={{ gridTemplateColumns: `repeat(${exhibit.metrics.length}, minmax(0, 1fr))` }}>
      {exhibit.metrics.map(metric => { const result = frame.quantities[metric.id]; const undefinedLabel = tir && metric.id === 'transmitted' ? 'No refracted ray' : 'Undefined'; return <div key={metric.id}><span className="ex-metric-label">{metric.label}</span><output aria-live="off" data-testid={`metric-${metric.id}`} className={`ex-${metric.color} ${result.status === 'undefined' ? 'ex-undefined' : ''}`}>{result.status === 'undefined' ? undefinedLabel : Array.isArray(result.value) ? `(${result.value.map(value => fmt(value, metric.digits ?? 2)).join(', ')})` : fmt(result.value as number, metric.digits ?? 2)}{result.status === 'valid' && metric.unit ? <small> {metric.unit}</small> : null}</output>{result.status === 'undefined' ? <small className="ex-undefined-reason">{tir ? 'Total internal reflection' : exhibit.id === 'probability' ? 'No parts are flagged.' : 'Both input amplitudes are zero.'}</small> : null}</div>; })}
    </div>
    {state.error ? <p role="alert" className="ex-error">{state.error} The last accepted configuration is retained.</p> : null}
    <div className="ex-takeaway"><strong>Takeaway</strong><p>{exhibit.takeaway}</p></div>
    <details className="ex-model"><summary>Model &amp; assumptions</summary><div><p>{doc.description}</p><ul>{doc.assumptions.map(text => <li key={text}>{text}</li>)}</ul><ul>{doc.limitations.map(text => <li key={text}>{text}</li>)}</ul><p>All numerical quantities below come from the same committed frame. Expected undefined values retain their reasons.</p><div className="ex-quantity-table"><table><thead><tr><th>Quantity</th><th>Value</th></tr></thead><tbody>{Object.entries(frame.quantities).filter(([id]) => !id.startsWith('grid')).map(([id, value]) => <tr key={id}><td>{doc.quantities[id].label ?? id}</td><td>{value.status === 'undefined' ? `Undefined — ${value.reason}` : Array.isArray(value.value) ? `(${value.value.map(v => fmt(v, 3)).join(', ')})` : fmt(value.value as number, 3)} {value.status === 'valid' ? doc.quantities[id].unit : ''}</td></tr>)}</tbody></table></div><p className="ex-review-note">Engineering reference checks are automated. These examples have not had independent scientific review.</p></div></details>
  </article>;
}
