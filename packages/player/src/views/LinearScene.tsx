import { useLayoutEffect, useRef, useState } from 'react';
import type { RunFrame, ScalarParams } from '@explorable-models/core';
import { scaleLinear } from 'd3-scale';
import { binding, scalar, vector, format } from '../utils';

interface Projection { scale:number; originX:number; originY:number; width:number; height:number }
interface Label { id:string; text:string; color:string; point:number[] }
interface LabelPlacement extends Label { x:number; y:number; width:number }

/** Label offsets are presentation only; geometry always uses an equal-axis projection. */
function placeLabels(labels:Label[],width:number,height:number,obstacles:Pick<LabelPlacement,'x'|'y'|'width'>[]=[]):LabelPlacement[] {
 const placed:LabelPlacement[]=[];
 for(const label of labels){
  const w=label.text.length*6.8;
  const [px,py]=label.point;
  const candidates=[[px+12,py-18],[px+12,py+26],[px-w-12,py-18],[px-w-12,py+26],[px-w/2,py-42],[px-w/2,py+48]];
  const clear=(x:number,y:number)=>x>=10&&x+w<=width-10&&y>=24&&y<=height-35&&![...placed,...obstacles].some(other=>x<other.x+other.width+9&&x+w+9>other.x&&y-14<other.y+8&&y+8>other.y-14);
  const position=candidates.find(([x,y])=>clear(x,y))??[Math.max(10,Math.min(width-w-10,px+12)),26+placed.length*22];
  placed.push({...label,x:position[0],y:position[1],width:w});
 }
 return placed;
}

export function LinearScene({frame,onParameters,onPreview,onCancel,onSelect,selectedIds}:{frame:RunFrame;onParameters:(params:ScalarParams)=>void;onPreview:(params:ScalarParams,commit:boolean)=>void;onCancel:()=>void;onSelect:(id:string)=>void;selectedIds:readonly string[]}) {
 const ref=useRef<SVGSVGElement>(null);
 const drag=useRef<Projection|null>(null);
 const [viewport,setViewport]=useState({width:800,height:390});
 useLayoutEffect(()=>{
  const node=ref.current;if(!node)return;
  const resize=()=>{const r=node.getBoundingClientRect();if(r.width&&r.height)setViewport(previous=>previous.width===r.width&&previous.height===r.height?previous:{width:r.width,height:r.height});};
  resize();const observer=new ResizeObserver(resize);observer.observe(node);return()=>observer.disconnect();
 },[]);
 const output=vector(frame,'point.output'),input=vector(frame,'point.input'),i=vector(frame,'basis.i'),j=vector(frame,'basis.j');
 const square=frame.geometry?.transformedSquare??[];
 const points=[input,output,i,j,[0,0],[1,1],...Array.from({length:square.length/2},(_,n)=>square.slice(n*2,n*2+2))];
 const lowX=Math.min(-.8,...points.map(p=>p[0]-.65)),highX=Math.max(1.8,...points.map(p=>p[0]+.65));
 const lowY=Math.min(-.8,...points.map(p=>p[1]-.65)),highY=Math.max(1.8,...points.map(p=>p[1]+.65));
 const padding={left:32,right:24,top:24,bottom:40};
 const availableWidth=viewport.width-padding.left-padding.right,availableHeight=viewport.height-padding.top-padding.bottom;
 const scale=Math.min(availableWidth/(highX-lowX),availableHeight/(highY-lowY));
 const computed:Projection={scale,originX:padding.left+(availableWidth-(highX-lowX)*scale)/2-lowX*scale,originY:padding.top+(availableHeight-(highY-lowY)*scale)/2+highY*scale,...viewport};
 // Keep the coordinate mapping stable throughout a drag; refit after its commit.
 const projection=drag.current??computed;
 const {scale:s,originX:cx,originY:cy,width,height}=projection;
 const pt=(v:readonly number[])=>[cx+v[0]*s,cy-v[1]*s];
 const path=(values:readonly number[])=>Array.from({length:values.length/2},(_,n)=>pt(values.slice(n*2,n*2+2)).join(',')).join(' ');
 const move=(e:React.PointerEvent<SVGSVGElement>,commit=false)=>{
  if(!drag.current||!ref.current)return;const matrix=ref.current.getScreenCTM();if(!matrix)return;
  const local=new DOMPoint(e.clientX,e.clientY).matrixTransform(matrix.inverse());
  const x=(local.x-drag.current.originX)/drag.current.scale,y=(drag.current.originY-local.y)/drag.current.scale;
  onPreview({x:Math.max(-3,Math.min(3,Math.round(x*20)/20)),y:Math.max(-3,Math.min(3,Math.round(y*20)/20))},commit);
 };
 const [ox,oy]=pt(output),[ix,iy]=pt(input);
 const tickCount=width<500?4:7;
 const xTicks=scaleLinear().domain([(padding.left-cx)/s,(width-padding.right-cx)/s]).ticks(tickCount);
 const yTicks=scaleLinear().domain([(cy-height+padding.bottom)/s,(cy-padding.top)/s]).ticks(5);
 const tickLabels=[
  ...xTicks.filter(n=>n!==0).map(n=>({x:cx+n*s-format(n,1).length*3.1,y:Math.min(height-padding.bottom+15,Math.max(padding.top+15,cy+17)),width:format(n,1).length*6.2})),
  ...yTicks.filter(n=>n!==0).map(n=>({x:Math.max(padding.left+10,Math.min(width-padding.right,cx-9))-format(n,1).length*6.2,y:cy-n*s+4,width:format(n,1).length*6.2})),
 ];
 const labels=placeLabels([
  {id:'point.input',text:`x (${format(input[0],2)}, ${format(input[1],2)})`,color:'#1765f5',point:[ix,iy]},
  {id:'point.output',text:`Ax (${format(output[0],2)}, ${format(output[1],2)})`,color:'#007780',point:[ox,oy]},
  {id:'basis.i',text:'A e₁',color:'#1765f5',point:pt(i)},
  {id:'basis.j',text:'A e₂',color:'#007780',point:pt(j)},
 ],width,height,tickLabels);
 const onKeySelect=(e:React.KeyboardEvent,id:string)=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();onSelect(id);}};
 return <svg ref={ref} className="linear-svg" viewBox={`0 0 ${viewport.width} ${viewport.height}`} role="group" aria-label="Reference grid, transformed unit square, input point and output point. Use the exact point controls as an alternative to dragging." onPointerMove={e=>move(e)} onPointerUp={e=>{if(drag.current){move(e,true);drag.current=null;}}} onPointerCancel={()=>{drag.current=null;onCancel();}}>
  <defs><marker id="basis-blue" markerWidth="6" markerHeight="6" refX="5" refY="3" orient="auto"><path d="M0 0L6 3L0 6Z" fill="#1765f5"/></marker><marker id="basis-teal" markerWidth="6" markerHeight="6" refX="5" refY="3" orient="auto"><path d="M0 0L6 3L0 6Z" fill="#008e96"/></marker></defs>
  {xTicks.map(n=><g key={`x-${n}`}><line x1={cx+n*s} x2={cx+n*s} y1={padding.top} y2={height-padding.bottom} stroke={n===0?'#9eafc4':'#e4ebf3'}/>{n!==0?<text x={cx+n*s} y={Math.min(height-padding.bottom+15,Math.max(padding.top+15,cy+17))} textAnchor="middle" fontSize="11" fill="#526783">{format(n,1)}</text>:null}</g>)}
  {yTicks.map(n=><g key={`y-${n}`}><line x1={padding.left} x2={width-padding.right} y1={cy-n*s} y2={cy-n*s} stroke={n===0?'#9eafc4':'#e4ebf3'}/>{n!==0?<text x={Math.max(padding.left+10,Math.min(width-padding.right,cx-9))} y={cy-n*s+4} textAnchor="end" fontSize="11" fill="#526783">{format(n,1)}</text>:null}</g>)}
  <polygon points={path(frame.geometry?.referenceSquare??[])} fill="#e2e8f0" fillOpacity=".6" stroke="#7d91aa" strokeDasharray="5 4"/>
  <polygon points={path(square)} fill="#1765f5" fillOpacity=".12" stroke="#1765f5" strokeWidth="2" {...binding(frame,'matrix.area')}/>
  {[{id:'basis.i',v:i,color:'#1765f5',marker:'basis-blue',name:'First transformed basis vector'},{id:'basis.j',v:j,color:'#008e96',marker:'basis-teal',name:'Second transformed basis vector'}].map(b=><g key={b.id} {...binding(frame,b.id)} role="button" tabIndex={0} aria-label={`${b.name} ${format(b.v[0])}, ${format(b.v[1])}`} onClick={()=>onSelect(b.id)} onKeyDown={e=>onKeySelect(e,b.id)}><line x1={cx} y1={cy} x2={pt(b.v)[0]} y2={pt(b.v)[1]} stroke={b.color} strokeWidth="2.5" markerEnd={`url(#${b.marker})`}/></g>)}
  <line x1={ix} y1={iy} x2={ox} y2={oy} stroke="#9c83c1" strokeDasharray="3 5"/>
  <g {...binding(frame,'point.output')} onClick={()=>onSelect('point.output')} role="button" tabIndex={0} aria-label={`Output point ${format(output[0])}, ${format(output[1])}`} onKeyDown={e=>onKeySelect(e,'point.output')}><rect x={ox-6} y={oy-6} width="12" height="12" fill="#008e96" stroke="#fff" strokeWidth="2"/></g>
  <g {...binding(frame,'point.input')} className="point-drag" role="button" tabIndex={0} aria-label={`Input point ${format(input[0])}, ${format(input[1])}. Arrow keys move by 0.1.`} onPointerDown={e=>{e.preventDefault();drag.current=computed;ref.current?.setPointerCapture(e.pointerId);onSelect('point.input');}} onKeyDown={e=>{const moves:Record<string,number[]>={ArrowLeft:[-.1,0],ArrowRight:[.1,0],ArrowUp:[0,.1],ArrowDown:[0,-.1]};const m=moves[e.key];if(m){e.preventDefault();onParameters({x:Math.max(-3,Math.min(3,input[0]+m[0])),y:Math.max(-3,Math.min(3,input[1]+m[1]))});}}}><circle cx={ix} cy={iy} r="15" fill="transparent"/><circle cx={ix} cy={iy} r={selectedIds.includes('point.input')?7:6} fill="#1765f5" stroke="#fff" strokeWidth="2"/></g>
  {labels.map(label=><g key={label.id} pointerEvents="none"><path d={`M${label.point[0]} ${label.point[1]}L${Math.max(label.x,Math.min(label.x+label.width,label.point[0]))} ${label.y-4}`} stroke={label.color} strokeWidth=".7" opacity=".6"/><text x={label.x} y={label.y} fontSize="12" fill={label.color} stroke="#f5f9fd" strokeWidth="3" paintOrder="stroke">{label.text}</text></g>)}
  <text x={padding.left} y={height-12} fontSize="11" fill="#526783">{scalar(frame,'matrix.determinant')===0?'Singular map · area collapses to zero':'Dashed square = original unit area'}</text>
 </svg>;
}
