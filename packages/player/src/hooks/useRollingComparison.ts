import { useEffect, useState } from 'react';
import { ExperimentRuntime, type RunFrame, type ScalarParams } from '@explorable-models/core';
import type { ExperimentEntry } from '../types';
export function useRollingComparison(entry:ExperimentEntry,parameters:ScalarParams|undefined,frame:RunFrame|undefined,enabled:boolean,override?:ScalarParams) {
 const [runtime,setRuntime]=useState<ExperimentRuntime>();
 const [comparison,setComparison]=useState<RunFrame>();const [trace,setTrace]=useState<RunFrame[]>([]);const [comparisonTrace,setComparisonTrace]=useState<RunFrame[]>([]);
 const [traceKey,setTraceKey]=useState(''),[comparisonFrameKey,setComparisonFrameKey]=useState('');
 const params=parameters?{...parameters,bodyType:parameters.bodyType==='hoop'?'sphere':'hoop',...override}:undefined;
 const paramKey=JSON.stringify(parameters),comparisonKey=JSON.stringify(params);
 const key=paramKey+comparisonKey+enabled;
 useEffect(()=>{if(entry.id!=='rolling')return;let active=true;const executor=entry.createExecutor();let instance:ExperimentRuntime|undefined;ExperimentRuntime.create(entry.definition,executor).then(r=>{instance=r;if(active)setRuntime(r);else r.dispose();});return()=>{active=false;setRuntime(undefined);instance?.dispose();executor.dispose?.();};},[entry]);
 useEffect(()=>{
  if(!runtime||!parameters||!params)return;let active=true;const executor=entry.createExecutor();
  Promise.all([executor.timeDomain(parameters),executor.timeDomain(params)]).then(async([d,c])=>{
   const max=Math.max(d.end??4,c.end??4);const times=(end:number|null)=>Array.from({length:25},(_,n)=>((end??max)*n)/24);
   const primary=await runtime.sample({parameters,times:times(d.end)});const secondary=enabled?await runtime.sample({parameters:params,times:times(c.end)}):undefined;
   if(active){setTrace(primary.frames);setComparisonTrace(secondary?.frames??[]);setTraceKey(key);}
  }).finally(()=>executor.dispose?.());return()=>{active=false;};
 },[runtime,paramKey,comparisonKey,enabled]);
 useEffect(()=>{
  if(!runtime||!params||!frame||!enabled||traceKey!==key){setComparison(undefined);return;}let active=true;
  const final=Number(comparisonTrace.at(-1)?.timePoint.time??Infinity);const time=Math.min(frame.timePoint.time,final);
  runtime.sample({parameters:params,times:[time]}).then(s=>{if(active){setComparison(s.frames[0]);setComparisonFrameKey(key);}}).catch(()=>{if(active)setComparison(undefined);});return()=>{active=false;};
 },[runtime,comparisonKey,frame?.frameId,enabled,comparisonTrace,traceKey,key]);
 const time=frame?.timePoint.time;
 const synced=comparison&&comparisonFrameKey===key&&(comparison.timePoint.time===time||comparison.status==='boundary')?comparison:undefined;
 return {comparison:synced,comparisonParameters:params,trace:traceKey===key?trace:[],comparisonTrace:traceKey===key?comparisonTrace:[]};
}
