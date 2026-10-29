import { useCallback, useEffect, useRef, useState } from 'react';
import { ExperimentRuntime, type RuntimeState, type RuntimeCommand, type ScalarParams, type TimeDomain } from '@explorable-models/core';
import type { ExperimentEntry } from '../types';
export function useExperiment(entry:ExperimentEntry) {
 const [runtime,setRuntime]=useState<ExperimentRuntime>();
 const [state,setState]=useState<RuntimeState>();
 const [domain,setDomain]=useState<TimeDomain>({start:0,end:null});
 const [error,setError]=useState('');
 const runtimeRef=useRef<ExperimentRuntime|undefined>(undefined);
 const uiQueue=useRef<Promise<unknown>>(Promise.resolve());
 useEffect(()=>{
   let alive=true; const executor=entry.createExecutor(); let off:(()=>void)|undefined;let ownedRuntime:ExperimentRuntime|undefined;
   setRuntime(undefined);setState(undefined);setError('');
   ExperimentRuntime.create(entry.definition,executor).then(r=>{
     if(!alive){executor.dispose?.();return;}
     ownedRuntime=r;runtimeRef.current=r; setRuntime(r);setState(r.getState());
     off=r.subscribe(()=>{if(alive)setState(r.getState());});
   }).catch(e=>{if(alive)setError(e.message);});
   return ()=>{alive=false;off?.();ownedRuntime?.dispose();executor.dispose?.();runtimeRef.current=undefined;};
 },[entry]);
 useEffect(()=>{
  if(!runtime||!state)return;
  let active=true;
  runtime.getTimeDomain(state.run.parameters).then(d=>{if(active)setDomain(d);}).catch(e=>{if(active)setError(e.message);});
  return ()=>{active=false;};
 },[entry,runtime,state?.activeRunId]);
 useEffect(()=>{
  if(!runtime||state?.frame.status!=='running')return;
  let cancelled=false,raf=0,previous=performance.now(),busy=false;
  const animate=(now:number)=>{
   if(cancelled)return;const delta=Math.min((now-previous)/1000,.1);previous=now;
   if(!busy){busy=true;runtime.tick(delta).catch(e=>setError(e.message)).finally(()=>{busy=false;});}
   raf=requestAnimationFrame(animate);
  };raf=requestAnimationFrame(animate);return()=>{cancelled=true;cancelAnimationFrame(raf);};
 },[runtime,state?.frame.status]);
 const execute=useCallback(async(cmd:Record<string,unknown>)=>{
  if(!runtime)return;const task=uiQueue.current.then(async()=>{try {setError('');return await runtime.command((cmd.type==='set_view'?{...cmd,expectedViewVersion:runtime.getState().viewVersion}:{...runtime.guard(),...cmd}) as RuntimeCommand);}catch(e){setError(e instanceof Error?e.message:String(e));}});uiQueue.current=task;return task;
 },[runtime]);
 const setParameters=useCallback((parameters:ScalarParams)=>execute({type:'set_parameters',parameters}),[execute]);
 const previewParameters=useCallback((parameters:ScalarParams,commit=false)=>{
  if(!runtime)return;const task=uiQueue.current.then(async()=>{try{
   const s=runtime.getState();const command=s.preview?{type:'update_preview' as const,previewId:s.preview.id,parameters}:{type:'begin_preview' as const,parameters};
   await runtime.command({...runtime.guard(),...command});
   if(commit){const previewId=runtime.getState().preview?.id;if(previewId)await runtime.command({...runtime.guard(),type:'commit_preview',previewId});}
  }catch(e){setError(e instanceof Error?e.message:String(e));}});uiQueue.current=task;return task;
 },[runtime]);
 const cancelPreview=useCallback(()=>{
  if(!runtime)return;const task=uiQueue.current.then(async()=>{const s=runtime.getState();if(s.preview)await runtime.command({...runtime.guard(),type:'cancel_preview',previewId:s.preview.id});}).catch(e=>setError(e.message));uiQueue.current=task;return task;
 },[runtime]);
 const select=useCallback((id:string)=>{
  if(!runtime)return;const s=runtime.getState();
  return execute({type:'set_view',expectedViewVersion:s.viewVersion,view:{selectedIds:s.view.selectedIds.includes(id)?[]:[id]}});
 },[runtime,execute]);
 return {runtime,state,domain,error,setError,execute,setParameters,previewParameters,cancelPreview,select};
}
