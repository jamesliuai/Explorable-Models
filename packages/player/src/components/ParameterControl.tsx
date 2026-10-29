import { useEffect, useState, useId, useRef } from 'react';
import type { ParameterDefinition, Scalar } from '@explorable-models/core';
import { format } from '../utils';
export function ParameterControl({name,definition,value,onCommit,onPreview,onCancel,compact=false}:{name:string;definition:ParameterDefinition;value:Scalar;onCommit:(value:Scalar)=>void;onPreview?:(value:number,commit:boolean)=>void;onCancel?:()=>void;compact?:boolean}) {
 const id=useId();const scale=definition.display?.scale??1;const [draft,setDraft]=useState(String(typeof value==='number'?Number((value*scale).toPrecision(12)):value));
 const [problem,setProblem]=useState('');
 const gesturing=useRef(false);
 const finish=(text:string)=>{if(gesturing.current&&onPreview){gesturing.current=false;onPreview(Number(text)/scale,true);}else commit(text);};
 useEffect(()=>{setDraft(String(typeof value==='number'?Number((value*scale).toPrecision(12)):value));setProblem('');},[value,scale]);
 const commit=(text:string)=>{
  const n=Number(text)/scale;
  if(!text.trim()||!Number.isFinite(n)||(definition.min!==undefined&&n<definition.min-1e-12)||(definition.max!==undefined&&n>definition.max+1e-12)||(definition.integer&&!Number.isInteger(n))){
   setProblem(`Enter ${definition.integer?'a whole number':'a value'} from ${format((definition.min??0)*scale)} to ${format((definition.max??1)*scale)}.`);return;
  }setProblem('');if(n!==value)onCommit(n);
 };
 if(definition.type==='string')return <div className="parameter"><label htmlFor={id}>{definition.label}</label><select id={id} value={String(value)} onChange={e=>onCommit(e.target.value)}>{definition.options?.map(option=>{const item=typeof option==='string'?{value:option,label:option}:option;return <option key={item.value} value={item.value}>{item.label}</option>;})}</select></div>;
 if(definition.type==='boolean')return <label className="check-control"><input type="checkbox" checked={Boolean(value)} onChange={e=>onCommit(e.target.checked)}/>{definition.label}</label>;
 const unit=definition.display?.unit??definition.unit;
 return <div className={`parameter ${compact?'compact':''}`}><label htmlFor={id}>{definition.label}</label><div className="numeric-control">
  {!compact&&definition.min!==undefined&&definition.max!==undefined?<input type="range" aria-label={`${definition.label} slider`} min={definition.min*scale} max={definition.max*scale} step={definition.step?definition.step*scale:'any'} value={Number(draft)||0} onChange={e=>{setDraft(e.target.value);if(onPreview){gesturing.current=true;onPreview(Number(e.target.value)/scale,false);}}} onPointerUp={e=>finish(e.currentTarget.value)} onPointerCancel={()=>{gesturing.current=false;onCancel?.();}} onKeyDown={e=>{if(e.key==='Escape'&&gesturing.current){gesturing.current=false;onCancel?.();}}} onKeyUp={e=>{if(['ArrowLeft','ArrowRight','ArrowUp','ArrowDown','Home','End','PageUp','PageDown'].includes(e.key))finish(e.currentTarget.value);}} onBlur={e=>{if(gesturing.current)finish(e.currentTarget.value);}} />:null}
  <div className="number-box"><input id={id} aria-invalid={!!problem} aria-describedby={problem?`${id}-error`:undefined} type="number" value={draft} min={definition.min===undefined?undefined:definition.min*scale} max={definition.max===undefined?undefined:definition.max*scale} step={definition.step?definition.step*scale:'any'} onChange={e=>setDraft(e.target.value)} onBlur={()=>commit(draft)} onKeyDown={e=>{if(e.key==='Enter')e.currentTarget.blur();}}/>{unit&&unit!=='1'?<span>{unit}</span>:null}</div>
 </div>{!compact&&definition.min!==undefined&&definition.max!==undefined?<div className="range-labels"><span>{format(definition.min*scale)}{unit}</span><span>{format(definition.max*scale)}{unit}</span></div>:null}{problem?<p className="field-error" id={`${id}-error`} role="alert">{problem}</p>:null}</div>;
}
