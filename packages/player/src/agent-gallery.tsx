import { createRoot } from 'react-dom/client';
import { useEffect, useRef, useState } from 'react';
import { createPreset, createVisualizationSession, presetCatalog } from '@experiment-kit/core/declarative';
import type { MutationGuard, VisualizationSession } from '@experiment-kit/core/declarative';
import { createVisualizationTools } from '@experiment-kit/agent';
import { VisualizationSurface } from '@experiment-kit/player';
import './agent-gallery.css';

function guard(session: VisualizationSession): MutationGuard {
  const state = session.getState();
  return { sessionId: session.id, expectedVersion: state.version, ...(state.run ? { expectedRunId: state.run.id } : {}), operationId: crypto.randomUUID(), origin: 'host' };
}
function Studio() {
  const [session, setSession] = useState<VisualizationSession | null>(null);
  const [preset, setPreset] = useState('wave');
  const [message, setMessage] = useState('Starting the model worker…');
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    let alive = true; let owned: VisualizationSession | null = null;
    void createVisualizationSession().then(async value => {
      owned = value;
      if (!alive) { value.dispose(); return; }
      const candidate = await value.createCandidate(createPreset('wave'), guard(value));
      await value.commitCandidate(candidate.id, guard(value));
      if (!alive) { value.dispose(); return; }
      setSession(value); setMessage('Ready. Computation runs locally in a dedicated worker.');
      // This page-owned bridge is a development/demo integration, not part of the reusable surface.
      (window as unknown as { __COMPOSITION_STUDIO__: unknown }).__COMPOSITION_STUDIO__ = { session: value, tools: createVisualizationTools({ session: value }), guard: () => guard(value) };
    }).catch(error => { if (alive) setMessage(String(error)); });
    return () => { alive = false; owned?.dispose(); };
  }, []);
  async function action(work: () => Promise<void>, success: string) {
    setBusy(true);
    try { await work(); setMessage(success); } catch (error) { setMessage(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  }
  async function load(id: string) {
    if (!session) return;
    await action(async () => { const candidate = await session.createCandidate(createPreset(id), guard(session)); await session.commitCandidate(candidate.id, guard(session)); setPreset(id); }, 'Editable composition loaded. Inspect its complete public document below.');
  }
  async function revise() {
    if (!session) return;
    await action(async () => {
      const document = session.getState().document!;
      const view = document.views.find(v => v.marks?.length);
      if (!view?.marks?.[0]) throw new Error('This composition has no scene mark. Choose a scene or plot example.');
      const mark = view.marks[0];
      const candidate = await session.reviseCandidate([{ op: 'setMark', viewId: view.id, mark: { ...mark, style: { ...mark.style, stroke: mark.style?.stroke === '#7756a8' ? '#287c8e' : '#7756a8', dash: 'dashed' } } }], guard(session));
      await session.commitCandidate(candidate.id, guard(session));
    }, 'Targeted presentation revision accepted; scientific run and time preserved. This button is a deterministic tool workflow, not a live AI service.');
  }
  function save() {
    if (!session) return;
    try {
      const artifact = session.exportDocument();
      const url = URL.createObjectURL(new Blob([JSON.stringify(artifact, null, 2)], { type: 'application/json' }));
      const link = document.createElement('a'); link.href = url; link.download = `${artifact.document.id}.experiment.json`; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); setMessage('Artifact downloaded with exact revisions and retained runs.');
    } catch(error) { setMessage(String(error)); }
  }
  return <>
    <a className="studio-skip" href="#composition">Skip to composition</a>
    <main className="studio">
      <header className="studio-header"><a href="./index.html">Explorable Models</a><span>Developer preview · 0.3</span></header>
      <nav className="studio-links" aria-label="Preview">
        <a href="./guide.html">Preview guide</a>
        <a href="./guide.html#embedding">Embed in your app</a>
        <a href="./gallery.html">Experiment gallery</a>
        <a href="https://github.com/jamesliuai/Explorable-Models">Source</a>
      </nav>
      <section className="studio-intro"><p className="studio-kicker">COMPOSITION STUDIO</p><h1>One model.<br/>Many ways to understand it.</h1><p>Explore an editable explanation. Its scene, values, and equations all read the same committed frame.</p></section>
      <div className="studio-toolbar">
        <label>Start from a composition<select value={preset} disabled={!session || busy} onChange={event => void load(event.target.value)}>{presetCatalog.map(item => <option key={item.id} value={item.id}>{item.title}</option>)}</select></label>
        <div>
          <button disabled={!session || busy} aria-describedby="revision-demo-note" onClick={() => void revise()}>Try a targeted revision</button>
          <button disabled={!session || busy} onClick={save}>Save document</button>
          <button disabled={!session || busy} onClick={() => input.current?.click()}>Reopen</button>
          <input ref={input} type="file" accept="application/json,.json" hidden onChange={event => {
            const file = event.target.files?.[0]; if (!file || !session) return;
            void action(async () => {
              if (file.size > 4_000_000) throw new Error('Artifact is too large.');
              const artifact = JSON.parse(await file.text()); await session.restoreDocument(artifact, guard(session));
            }, 'Artifact reopened in a new run with its original provenance.');
            event.target.value = '';
          }}/>
        </div>
      </div>
      <p id="revision-demo-note" className="studio-demo-note">The revision demo is scripted. Explore without an account or AI connection; save downloads a file.</p>
      <p className="studio-status" role="status">{message}</p>
      <section id="composition" aria-label="Editable composition">{session ? <VisualizationSurface session={session}/> : <div className="studio-loading">Preparing the first composition…</div>}</section>
      <footer className="studio-footer"><strong>Inspectable by design.</strong><p>Copy the public document to author your own composition. Presets use the same primitives available to your agent. These examples are unreviewed; technical checks do not establish scientific review or learning efficacy.</p><a href="./guide.html#scope">Preview scope and limitations</a> · <a href="./gallery.html">Open the experiment gallery →</a></footer>
    </main>
  </>;
}
createRoot(document.getElementById('root')!).render(<Studio/>);
