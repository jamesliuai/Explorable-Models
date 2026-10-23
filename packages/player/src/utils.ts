import type { RunFrame, CheckSuite } from '@experiment-kit/core';
export const scalar = (frame: RunFrame | undefined, id: string, fallback = 0): number => {
 const v=frame?.quantities[id]?.value; return typeof v==='number' ? v : fallback;
};
export const vector = (frame: RunFrame, id: string): readonly number[] => {
 const v=frame.quantities[id]?.value; return Array.isArray(v) ? v : [];
};
export const format = (n: number, digits = 3) => {
 const value = Object.is(n, -0) ? 0 : n;
 if (value !== 0 && Math.abs(value) < 10 ** -digits) return value.toExponential(Math.max(1, digits - 1));
 return new Intl.NumberFormat('en-US', { maximumFractionDigits: digits }).format(value);
};
export const bodyNames: Record<string,string> = {sphere:'Solid sphere',shell:'Spherical shell',cylinder:'Solid cylinder',hoop:'Hoop'};
export function download(name:string, content: string | Uint8Array, type='application/json') {
 const blob = new Blob([typeof content==='string'?content:new Uint8Array(content)],{type});
 const url=URL.createObjectURL(blob); const link=document.createElement('a'); link.href=url;link.download=name;link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
}
export function downloadJSON(name:string,data:unknown){download(name,JSON.stringify(data,null,2));}
export function binding(frame:RunFrame,id:string){return {'data-quantity-id':id,'data-frame-id':frame.frameId,'data-value':JSON.stringify(frame.quantities[id]?.value)};}
export async function loadChecksFromWorker(createWorker:()=>Worker):Promise<CheckSuite|null>{
 const worker=createWorker();return new Promise((resolve,reject)=>{
  const id=crypto.randomUUID();const done=()=>{clearTimeout(timer);worker.terminate();};
  const timer=setTimeout(()=>{done();reject(new Error('Author checks did not respond within 3 seconds.'));},3000);
  worker.onerror=()=>{done();reject(new Error('Author checks worker failed.'));};
  worker.onmessage=e=>{if(e.data?.namespace!=='experiment-kit-checks'||e.data.id!==id)return;done();if(e.data.error)reject(new Error(e.data.error.message??'Author checks failed.'));else resolve(e.data.result?{...e.data.result,provenance:'author'}:null);};
  worker.postMessage({namespace:'experiment-kit-checks',id});
 });
}
