import { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react';
import { Bookmark, ChartNoAxesCombined, ChevronRight, Download, FlaskConical, Info, Menu, Pause, Play, RotateCcw, Save, SkipForward, X, GitCompareArrows } from 'lucide-react';
import { WorkerExecutor, type CheckReport, type CheckSuite, type ExperimentDefinition, type RuntimeCommand, type ScalarParams, type Snapshot, type ViewState } from '@experiment-kit/core';
import { experimentEntries } from '@experiment-kit/examples';
import { useExperiment } from './hooks/useExperiment';
import { useRollingComparison } from './hooks/useRollingComparison';
import { ParameterControl } from './components/ParameterControl';
import { Equation } from './components/Equation';
import { Modal } from './components/Modal';
import { Inspector } from './components/Inspector';
import { SavedRuns, type SavedRun } from './components/SavedRuns';
import { ExportPanel } from './components/ExportPanel';
import { Guide } from './components/Guide';
import { RollingScene } from './views/RollingScene';
import { LinearScene } from './views/LinearScene';
import { ProbabilityScene } from './views/ProbabilityScene';
import { GenericScene } from './views/GenericScene';
import { EnergyView, SpeedPlot, FrequencyTable } from './views/LinkedViews';
import { binding, bodyNames, format, scalar, vector, loadChecksFromWorker } from './utils';
import type { ExperimentEntry } from './types';
const Rolling3D=lazy(()=>import('./views/Rolling3D'));
interface Request {method:string;args?:Record<string,unknown>}
declare global {interface Window {
 __EXPERIMENT_KIT__?:{request:(r:Request)=>Promise<unknown>};
 __EXPERIMENT_KIT_CAPTURE__?:Snapshot;
 __EXPERIMENT_KIT_CAPTURE_READY__?:{frameId:string;definitionRevision:string;viewVersion:number;timePoint:unknown};
}}
const metadata:Record<string,{title:string;subtitle:string;category:string}>={
 rolling:{title:'Same ramp. Different motion.',subtitle:'Why does a sphere reach the bottom before a hoop?',category:'Mechanics'},
 'linear-map':{title:'See what a matrix does.',subtitle:'Move the basis. Watch a whole plane transform.',category:'Linear algebra'},
 'base-rates':{title:'A positive is only part of the story.',subtitle:'When defects are rare, what does a flagged part really tell us?',category:'Probability'},
 'riemann-sums':{title:'Small pieces. A whole area.',subtitle:'Explore how finite sums approach an integral.',category:'Calculus'},
 oscillator:{title:'A rhythm in the mathematics.',subtitle:'Follow position, velocity, and energy through one oscillation.',category:'Mechanics'},
};
const presets:Record<string,ScalarParams>={Identity:{a:1,b:0,c:0,d:1},Scaling:{a:2,b:0,c:0,d:3},Shear:{a:1,b:2,c:0,d:1},Reflection:{a:-1,b:0,c:0,d:1},Rotation:{a:0,b:-1,c:1,d:0},Singular:{a:1,b:2,c:1.5,d:3}};
const storageKey='experiment-kit:saved:v1';
const startupSnapshot=(()=>{try{const content=document.getElementById('experiment-kit-snapshot')?.textContent;return content?JSON.parse(content) as Snapshot:undefined;}catch{return undefined;}})();
const readSaved=():SavedRun[]=>{try{const parsed=JSON.parse(localStorage.getItem(storageKey)??'[]');return Array.isArray(parsed)?parsed.filter(r=>r&&typeof r.id==='string'&&typeof r.name==='string'&&r.snapshot?.schemaVersion==='1.0').slice(0,64):[];}catch{return [];}};
export function App() {
 const initial=startupSnapshot?.experimentId??new URLSearchParams(location.search).get('experiment');
 const [selected,setSelected]=useState(experimentEntries.some(e=>e.id===initial)?initial!:experimentEntries[0].id);
 const baseEntry=useMemo(()=>experimentEntries.find(e=>e.id===selected)??experimentEntries[0],[selected]);
 const session=useExperiment(baseEntry);const {runtime,state,domain,error,setError,execute,setParameters,previewParameters,cancelPreview,select}=session;
 const [activated,setActivated]=useState<ExperimentEntry>();const entry:ExperimentEntry=activated?.id===selected?activated:baseEntry;
 const [panel,setPanel]=useState<'saved'|'model'|'guide'|'export'|'save'|null>(null);
 const [mobileNav,setMobileNav]=useState(false),[notice,setNotice]=useState('');
 const [saved,setSaved]=useState<SavedRun[]>(readSaved),[saveName,setSaveName]=useState('');
 const [pendingRestore,setPendingRestore]=useState<Snapshot|undefined>(startupSnapshot);
 const [compareSaved,setCompareSaved]=useState<SavedRun>();
 const [comparedValues,setComparedValues]=useState<Record<string,unknown>>();
 const restoredCapture=useRef<string>('');const [captureFrame,setCaptureFrame]=useState('');const isCapture=new URLSearchParams(location.search).has('capture');const embed=new URLSearchParams(location.search).has('embed');
 const frame=state?.frame,params=state?.preview?.parameters??state?.run.parameters;
 const compareEnabled=state?.view.layers.comparison!==false;
 const comparison=useRollingComparison(entry,params,frame,entry.id==='rolling'&&compareEnabled,compareSaved?.snapshot.parameters);
 const m=entry.definition.manifest,copy=metadata[entry.id]??{title:m.title,subtitle:m.question,category:m.kind==='analytic'?'Analytical experiment':'Parametric experiment'};
 const mode=state?.view.mode??'2d';const forces=state?.view.layers.forces??false;
 const setView=(view:Partial<ViewState>)=>{if(state)execute({type:'set_view',expectedViewVersion:runtime!.getState().viewVersion,view});};
 const changeExperiment=(id:string)=>{if(id===selected){setMobileNav(false);return;}setSelected(id);setActivated(undefined);setCompareSaved(undefined);setPanel(null);setMobileNav(false);const url=new URL(location.href);url.searchParams.set('experiment',id);history.replaceState(null,'',url);};
 useEffect(()=>{document.title=`${m.title} · Explorable Models`;},[m.title]);
 useEffect(()=>{try{localStorage.setItem(storageKey,JSON.stringify(saved));}catch{setNotice('Browser storage is full. Download snapshots to keep them.');}},[saved]);
 useEffect(()=>{if(!notice)return;const t=setTimeout(()=>setNotice(''),5000);return()=>clearTimeout(t);},[notice]);
 useEffect(()=>{
  if(!pendingRestore||!runtime||pendingRestore.experimentId!==entry.id||runtime.describe().manifest.id!==entry.id)return;
  const snapshot=pendingRestore;setPendingRestore(undefined);
  execute({type:'restore',snapshot}).then(result=>{if(result)setNotice('Saved state restored as a new run.');});
 },[pendingRestore,runtime,entry.id,execute]);
 useEffect(()=>{
  if(!runtime)return;
  const request=async({method,args={}}:Request):Promise<unknown>=>{try{
   switch(method){
    case 'describe':return runtime.describe();
    case 'inspect':return runtime.inspect(args.quantityIds as string[]|undefined);
    case 'state':return runtime.getState();
    case 'command':return await runtime.command(args as unknown as RuntimeCommand);
    case 'sample':return await runtime.sample({parameters:args.parameters as ScalarParams|undefined,times:args.times as number[]});
    case 'compare':return await runtime.compare({runIds:args.runIds as string[],times:args.times as number[]});
    case 'checkpoint':return runtime.checkpoint(args.annotations as string|undefined,args.comparisonReferences as string[]|undefined);
    case 'create_run':return runtime.createRun(args.parameters as ScalarParams,{expectedRunVersion:args.expectedRunVersion as number,expectedActiveRunId:args.expectedActiveRunId as string});
    case 'verify':{const suite=(args.suite as CheckSuite|undefined)??entry.checks??await entry.loadChecks?.();if(!suite)return {error:{code:'NOT_FOUND',message:'No check suite supplied.'}};return runtime.verify(suite);}
    case 'activate_revision':{
     const definition=args.definition as ExperimentDefinition,url=new URL(args.workerUrl as string,location.href);
     if(url.origin!==location.origin)throw new Error('Candidate worker must have the same origin as this player.');
     const factory=()=>new WorkerExecutor(new Worker(url,{type:'module'}),definition.manifest);
     const executor=factory();try{const result=await runtime.activateRevision(definition,executor,args.report as CheckReport,{expectedDefinitionRevision:args.expectedDefinitionRevision as string,expectedRunVersion:args.expectedRunVersion as number,expectedActiveRunId:args.expectedActiveRunId as string});setActivated({id:definition.manifest.id,definition,createExecutor:factory,loadChecks:()=>loadChecksFromWorker(()=>new Worker(url,{type:'module'}))});return result;}catch(e){executor.dispose();throw e;}
    }
    default:return {error:{code:'UNSUPPORTED_CAPABILITY',message:`Unknown method ${method}`}};
   }
  }catch(e){const failure=e as Error&{code?:string;toJSON?:()=>unknown};return {error:failure.toJSON?.()??{code:failure.code??'MODEL_ERROR',message:failure.message}};}};
  window.__EXPERIMENT_KIT__={request};return()=>{delete window.__EXPERIMENT_KIT__;};
 },[runtime,entry]);
 useEffect(()=>{
  if(!runtime||!isCapture||!window.__EXPERIMENT_KIT_CAPTURE__||restoredCapture.current===entry.id)return;
  restoredCapture.current=entry.id;runtime.command({type:'restore',snapshot:window.__EXPERIMENT_KIT_CAPTURE__,...runtime.guard()}).then(result=>setCaptureFrame(result.state.frame.frameId)).catch(e=>setError(e.message));
 },[runtime,entry.id,isCapture,setError]);
 useEffect(()=>{
  if(!isCapture||!state||!runtime||captureFrame!==state.frame.frameId)return;
  let active=true,raf=0;delete window.__EXPERIMENT_KIT_CAPTURE_READY__;
  void document.fonts.ready.then(()=>{const ready=()=>{if(!active)return;if(document.querySelector('[data-render-pending]')||(entry.id==='rolling'&&compareEnabled&&(!comparison.comparison||!comparison.trace.length))){raf=requestAnimationFrame(ready);return;}raf=requestAnimationFrame(()=>{if(active)window.__EXPERIMENT_KIT_CAPTURE_READY__={frameId:state.frame.frameId,definitionRevision:state.frame.definitionRevision,viewVersion:state.viewVersion,timePoint:state.frame.timePoint};});};raf=requestAnimationFrame(ready);});return()=>{active=false;cancelAnimationFrame(raf);};
 },[state,runtime,entry.id,isCapture,captureFrame,compareEnabled,comparison.comparison,comparison.trace.length]);
 useEffect(()=>{
  if(!compareSaved||!runtime||entry.id==='rolling')return;let active=true;
  runtime.sample({parameters:compareSaved.snapshot.parameters,times:[compareSaved.snapshot.timePoint.time]}).then(r=>{if(active)setComparedValues(r.frames[0].quantities);}).catch(e=>setError(e.message));return()=>{active=false;};
 },[compareSaved,runtime,entry.id,setError]);
 const save=()=>{if(!runtime)return;try{const snapshot=runtime.checkpoint();setSaved(old=>[{id:crypto.randomUUID(),name:saveName.trim()||`${m.title} · ${format(snapshot.timePoint.time,2)} s`,snapshot},...old].slice(0,64));setPanel(null);setNotice('State saved to your notebook.');}catch(e){setError(String(e));}};
 const restore=(s:SavedRun)=>{changeExperiment(s.snapshot.experimentId);setPendingRestore(s.snapshot);setPanel(null);};
 const importSnapshot=async(file:File)=>{try{if(file.size>1024*1024)throw new Error('Snapshot exceeds the 1 MB limit.');const snapshot=JSON.parse(await file.text()) as Snapshot;if(!experimentEntries.some(e=>e.id===snapshot.experimentId))throw new Error('This snapshot belongs to an experiment that is not in this player.');setPendingRestore(snapshot);changeExperiment(snapshot.experimentId);setPanel(null);}catch(e){setError(e instanceof Error?e.message:String(e));}};
 const compare=(s:SavedRun)=>{if(s.snapshot.definitionRevision!==entry.definition.definitionRevision){setError('This saved state uses a different definition revision.');return;}setCompareSaved(s);setView({layers:{comparison:true}});setPanel(null);setNotice(`Comparing with “${s.name}”.`);};
 const mainQuantityIds=entry.id==='rolling'?['body.speed','body.acceleration','body.rotation']:entry.id==='linear-map'?['matrix.determinant','matrix.area','point.output']:entry.id==='base-rates'?['count.flagged','probability.posterior']:Object.keys(m.quantities).slice(0,3);
 const renderControl=(name:string,compact=false)=>{const definition=name==='incline'?{...m.parameters[name],label:'Ramp angle'}:m.parameters[name];return <ParameterControl key={name} name={name} definition={definition} value={params![name]} compact={compact} onCommit={value=>setParameters({[name]:value})} onPreview={(value,commit)=>previewParameters({[name]:value},commit)} onCancel={cancelPreview}/>;};
 return <div className={`app ${embed?'embedded':''}`}><a className="skip-link" href="#experiment-main">Skip to experiment</a>
 {!embed?<><header className="app-header"><button className="mobile-menu icon-button" aria-label="Open experiment navigation" onClick={()=>setMobileNav(v=>!v)}><Menu size={20}/></button><a className="brand" href="./"><svg viewBox="0 0 24 28" aria-hidden="true"><path d="M3 3H22V8H9V12H19V17H9V21H22V26H3V21H5V8H3Z" fill="currentColor"/></svg><span>Explorable Models</span></a><nav className="top-nav" aria-label="Main"><button className={panel!=='guide'?'active':''} onClick={()=>setPanel(null)}>Experiments</button><button onClick={()=>setPanel('guide')}>Authoring guide</button></nav><button className="header-export" disabled={!runtime} onClick={()=>setPanel('export')}><Download size={17}/>Export</button></header>
 <aside className={`sidebar ${mobileNav?'nav-open':''}`} aria-label="Experiment navigation"><div className="side-label">Experiments</div><nav>{experimentEntries.slice(0,3).map((e,index)=><button key={e.id} className={selected===e.id?'selected':''} onClick={()=>changeExperiment(e.id)}><span className="nav-number">{String(index+1).padStart(2,'0')}</span>{e.definition.manifest.title}</button>)}</nav><div className="sidebar-divider"/><div className="side-label">Workspace</div><nav><button onClick={()=>{setPanel('saved');setMobileNav(false);}}><Bookmark size={18}/>Saved runs{saved.length?<span className="count">{saved.length}</span>:null}</button><button disabled={!runtime} onClick={()=>{setPanel('model');setMobileNav(false);}}><ChartNoAxesCombined size={18}/>Model & checks</button></nav>{experimentEntries.length>3?<details className="more-experiments"><summary>More experiments</summary><nav>{experimentEntries.slice(3).map(e=><button key={e.id} className={selected===e.id?'selected':''} onClick={()=>changeExperiment(e.id)}>{e.definition.manifest.title}</button>)}</nav></details>:null}<div className="sidebar-foot"><span className="online-dot"/>Runs locally. Yours to explore.<small>Explorable Models · v0.1</small></div></aside></>:null}
 <main id="experiment-main" className="main-content"><div className="page-heading"><div><div className="breadcrumb">{copy.category}<span>/</span>{m.title}</div><h1>{copy.title}</h1><p>{copy.subtitle}</p></div><button className="button save-button" disabled={!runtime} onClick={()=>{setSaveName(`${m.title} · ${format(frame?.timePoint.time??0,2)} s`);setPanel('save');}}><Save size={16}/>Save state</button></div>
 {error?<div className="error-banner" role="alert"><Info size={18}/><span>{error}</span><button className="icon-button" onClick={()=>setError('')} aria-label="Dismiss error"><X size={16}/></button></div>:null}
 {notice?<div className="toast" role="status">{notice}</div>:null}
 {!state||!runtime||!frame||!params?<div className="loading-state" aria-live="polite"><FlaskConical size={30}/><p>{error?'The experiment could not start. Check the model and reload.':'Preparing your experiment…'}</p></div>:<>
 <div className="experiment-layout"><div className="experiment-column"><section className="scene-panel" aria-label="Interactive experiment"><div className="scene-toolbar"><h2><FlaskConical size={17}/>Experiment</h2><div className="scene-actions">{entry.id==='rolling'?<>{mode==='2d'?<label className="toolbar-check"><input type="checkbox" checked={forces} onChange={e=>setView({layers:{forces:e.target.checked}})}/>Forces</label>:null}<div className="segmented" aria-label="View mode">{['2d','3d'].map(v=><button key={v} aria-pressed={mode===v} onClick={()=>setView({mode:v})}>{v.toUpperCase()}</button>)}</div></>:entry.id==='base-rates'?<div className="segmented"><button aria-pressed={mode!=='tree'} onClick={()=>setView({mode:'2d'})}>Frequencies</button><button aria-pressed={mode==='tree'} onClick={()=>setView({mode:'tree'})}>Tree</button></div>:<span className="scene-state">{entry.id==='linear-map'?'Drag the blue point':'Live model'}</span>}</div></div>
 <div className="scene-content" data-view-frame={frame.frameId}>{entry.id==='rolling'?(mode==='3d'?<Suspense fallback={<div className="loading-state" data-render-pending>Loading 3D view…</div>}><Rolling3D frame={frame} parameters={params} camera={state.view.camera} onCamera={camera=>setView({camera})}/></Suspense>:<RollingScene frame={frame} parameters={params} comparison={compareEnabled?comparison.comparison:undefined} comparisonParameters={comparison.comparisonParameters} selectedIds={state.view.selectedIds} onSelect={select} forces={forces}/>):entry.id==='linear-map'?<LinearScene frame={frame} onParameters={setParameters} onPreview={previewParameters} onCancel={cancelPreview} onSelect={select} selectedIds={state.view.selectedIds}/>:entry.id==='base-rates'?<ProbabilityScene frame={frame} onSelect={select} selectedIds={state.view.selectedIds} tree={mode==='tree'}/>:<GenericScene definition={entry.definition} frame={frame} onSelect={select}/>}</div>
 {m.kind==='analytic'?<div className="playback"><button className="button primary play-button" disabled={isCapture||frame.status==='boundary'} onClick={()=>execute({type:frame.status==='running'?'pause':'play'})}>{frame.status==='running'?<Pause size={15} fill="currentColor"/>:<Play size={15} fill="currentColor"/>}{frame.status==='running'?'Pause':'Play'}</button><button className="button" aria-label="Step one tick" onClick={()=>execute({type:'step'})}><SkipForward size={15}/>Step</button><button className="button" onClick={()=>execute({type:'reset'})}><RotateCcw size={15}/>Reset</button><label className="time-control"><span>{format(frame.timePoint.time,3)} s</span><input type="range" aria-label="Model time" min="0" max={domain.end??Math.max(10,frame.timePoint.time+1)} step="any" value={frame.timePoint.time} onChange={e=>execute({type:'seek',time:Number(e.target.value)})}/></label><select className="speed-select" aria-label="Playback speed" value={state.view.playbackSpeed} onChange={e=>setView({playbackSpeed:Number(e.target.value)})}><option value="0.25">¼×</option><option value="0.5">½×</option><option value="1">1×</option><option value="2">2×</option></select></div>:<div className="parametric-footer"><span>No clock needed. Each change is a new experiment.</span><button onClick={()=>setParameters(Object.fromEntries(Object.entries(m.parameters).map(([k,p])=>[k,p.default])))}><RotateCcw size={14}/>Reset</button></div>}
 </section>
 {entry.id==='rolling'?<div className="secondary-grid"><EnergyView frame={frame} comparison={compareEnabled?comparison.comparison:undefined} parameters={params} comparisonParameters={comparison.comparisonParameters} onSelect={select}/><SpeedPlot frame={frame} trace={comparison.trace} comparisonTrace={compareEnabled?comparison.comparisonTrace:[]} comparison={compareEnabled?comparison.comparison:undefined} parameters={params}/></div>:entry.id==='base-rates'?<FrequencyTable frame={frame} onSelect={select}/>:entry.id==='linear-map'?<div className="secondary-grid"><section className="secondary-panel"><h3>The columns tell the story</h3><Equation tex={`A=\\begin{bmatrix}${params.a}&${params.b}\\\\${params.c}&${params.d}\\end{bmatrix}`}/><p className="tiny-note">The first column moves e₁; the second moves e₂.</p></section><section className="secondary-panel"><h3>Area & orientation</h3><div className="area-metric" {...binding(frame,'matrix.area')}>{format(scalar(frame,'matrix.area'))}<span>× the original area</span></div><p className="tiny-note">{scalar(frame,'matrix.orientation')===0?'Singular: area collapses to zero.':scalar(frame,'matrix.orientation')<0?'Reflection: orientation is reversed.':'Orientation is preserved.'}</p></section></div>:null}
 {compareSaved?<section className="comparison-summary"><div className="panel-title"><h3><GitCompareArrows size={16}/>Comparing: {compareSaved.name}</h3><button className="icon-button" aria-label="Clear comparison" onClick={()=>setCompareSaved(undefined)}><X size={16}/></button></div><p>{Object.entries(params).filter(([k,v])=>v!==compareSaved.snapshot.parameters[k]).map(([k,v])=>`${m.parameters[k].label}: ${compareSaved.snapshot.parameters[k]} → ${v}`).join(' · ')||'Parameters match. Comparing the saved and current states.'}</p>{entry.id==='rolling'?<p className="tiny-note">Aligned by model time. Each trace ends at its own arrival event.</p>:comparedValues?<table><thead><tr><th>Quantity</th><th>Saved</th><th>Current</th></tr></thead><tbody>{mainQuantityIds.map(id=><tr key={id}><th>{m.quantities[id].label}</th><td>{JSON.stringify((comparedValues[id] as {value:unknown})?.value)}</td><td>{JSON.stringify(frame.quantities[id].value)}</td></tr>)}</tbody></table>:null}</section>:null}
 <details className="accessible-values"><summary>Explore the current values</summary><p>Select any quantity to link its representations. Exact values and units are available in Model & checks.</p><div className="value-list">{Object.entries(m.quantities).map(([id,q])=><button key={id} onClick={()=>select(id)} aria-pressed={state.view.selectedIds.includes(id)} {...binding(frame,id)}><span>{q.label}</span><strong>{frame.quantities[id].status==='valid'?(Array.isArray(frame.quantities[id].value)?`[${(frame.quantities[id].value as number[]).map(n=>format(n)).join(', ')}]`:format(Number(frame.quantities[id].value))):'Undefined'} <small>{q.unit==='1'?'':q.unit}</small></strong></button>)}</div></details>
 </div>
 <aside className="controls-panel" aria-label="Experiment controls"><h2>Set up the experiment</h2>{entry.id==='linear-map'?<><div className="matrix-controls">{['a','b','c','d'].map(n=>renderControl(n,true))}</div><div className="preset-buttons" aria-label="Matrix presets">{Object.entries(presets).map(([label,p])=><button key={label} onClick={()=>setParameters(p)}>{label}</button>)}</div><details><summary>Input point</summary>{['x','y'].map(n=>renderControl(n))}<p className="tiny-note">Numeric inputs are an alternative to dragging.</p></details></>:<>{Object.entries(m.parameters).filter(([,d])=>!d.advanced).map(([n])=>renderControl(n))}{Object.values(m.parameters).some(d=>d.advanced)?<details className="advanced"><summary>Advanced parameters</summary>{Object.entries(m.parameters).filter(([,d])=>d.advanced).map(([n])=>renderControl(n))}</details>:null}</>}
 {entry.id==='rolling'?<label className="check-control compare-toggle"><input type="checkbox" checked={compareEnabled} onChange={e=>setView({layers:{comparison:e.target.checked}})}/>Compare with {compareSaved?compareSaved.name:bodyNames[String(comparison.comparisonParameters?.bodyType??'hoop')].toLowerCase()}</label>:null}
 <section className="moment"><h2>At this moment</h2>{mainQuantityIds.map(id=>{const q=frame.quantities[id],def=m.quantities[id];const value=q.status!=='valid'?'Undefined':Array.isArray(q.value)?`[${q.value.map(n=>format(n,2)).join(', ')}]`:entry.id==='base-rates'&&id==='probability.posterior'?`${format(Number(q.value)*100,2)}%`:format(Number(q.value),2);return <button className={`metric ${state.view.selectedIds.includes(id)?'selected':''}`} onClick={()=>select(id)} key={id} aria-pressed={state.view.selectedIds.includes(id)} {...binding(frame,id)}><span>{def.label}</span><strong>{value}{def.unit!=='1'&&id!=='point.output'?<small> {def.unit}</small>:null}</strong></button>;})}
 <p className="equation-label">{entry.id==='rolling'?'Ideal acceleration · rolling without slipping':entry.id==='linear-map'?'A matrix maps each input to its output':entry.id==='base-rates'?'Condition on the flagged group':'The relationship in this model'}</p>
 <Equation tex={entry.id==='rolling'?'a=\\frac{g\\sin\\theta}{1+\\kappa}':entry.id==='linear-map'?'\\mathbf y=A\\mathbf x':entry.id==='base-rates'?'P(D\\mid +)=\\frac{ps}{ps+(1-p)f}':entry.definition.views?.find(v=>v.type==='equation')?.template??'y=f(x)'}/>
 <div className="equation-values">{mainQuantityIds.slice(0,2).map(id=><button key={id} onClick={()=>select(id)} {...binding(frame,id)}>{m.quantities[id].label}: {frame.quantities[id].status==='valid'?format(Number(frame.quantities[id].value),4):'undefined'}</button>)}</div>
 {entry.id==='rolling'?<p className="tiny-note">κ = {format(scalar(frame,'body.kappa'),3)}. Mass distribution determines the split between translation and rotation.</p>:null}</section>
 <button className="text-link inspect-link" onClick={()=>setPanel('model')}>Inspect model & quantities<ChevronRight size={15}/></button>
 </aside></div>
 <footer className="model-footer"><Info size={17}/><strong>{entry.id==='rolling'?'Ideal rolling without slipping':entry.id==='linear-map'?'Column vectors. Signed determinant.':entry.id==='base-rates'?'Expected frequencies. Exact probabilities.':'An explicit, inspectable model.'}</strong><span>{entry.id==='rolling'?'Rigid bodies, no energy loss, uniform gravitational field.':m.assumptions[0]}</span><button onClick={()=>setPanel('model')}>View assumptions<ChevronRight size={14}/></button></footer>
 <span className="sr-only" aria-live="polite" aria-atomic="true">{frame.status==='boundary'?'End of the model domain reached.':frame.status==='paused'?'Experiment paused.':''}</span>
 </>}
 </main>
 {panel==='guide'?<Modal title="Authoring guide" onClose={()=>setPanel(null)} wide><Guide/></Modal>:null}
 {panel==='saved'?<Modal title="Saved runs" onClose={()=>setPanel(null)} wide><SavedRuns runs={saved} currentId={selected} onRestore={restore} onDelete={id=>setSaved(old=>old.filter(s=>s.id!==id))} onCompare={compare} onImport={importSnapshot}/></Modal>:null}
 {panel==='model'&&runtime&&frame?<Modal title="Model & checks" onClose={()=>setPanel(null)} wide><Inspector entry={entry} runtime={runtime} frame={frame} onSelect={select}/></Modal>:null}
 {panel==='export'&&runtime?<Modal title="Export your experiment" onClose={()=>setPanel(null)}><ExportPanel entry={entry} runtime={runtime}/></Modal>:null}
 {panel==='save'&&runtime?<Modal title="Save this moment" onClose={()=>setPanel(null)}><form onSubmit={e=>{e.preventDefault();save();}}><label className="form-label" htmlFor="save-name">Name this run</label><input autoFocus id="save-name" className="text-input" maxLength={120} value={saveName} onChange={e=>setSaveName(e.target.value)}/><p className="muted">The exact parameters, model time, and view state will be saved to this browser. You can download a snapshot from Saved runs.</p><button type="submit" className="button primary"><Save size={16}/>Save run</button></form></Modal>:null}
 </div>;
}
