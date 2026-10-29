import { useLayoutEffect, useRef, useState } from 'react';
import type { RunFrame, ScalarParams } from '@explorable-models/core';
import { binding, bodyNames, format, scalar, vector } from '../utils';
export interface RollingSceneProps {frame:RunFrame;parameters:ScalarParams;comparison?:RunFrame;comparisonParameters?:ScalarParams;selectedIds:readonly string[];onSelect:(id:string)=>void;forces:boolean}

export function RollingScene({frame,parameters:p,comparison,comparisonParameters,selectedIds,onSelect,forces}:RollingSceneProps) {
 const ref=useRef<SVGSVGElement>(null);
 const [viewport,setViewport]=useState({width:800,height:390});
 useLayoutEffect(()=>{
  const node=ref.current;if(!node)return;
  const resize=()=>{const bounds=node.getBoundingClientRect();if(bounds.width&&bounds.height)setViewport(previous=>previous.width===bounds.width&&previous.height===bounds.height?previous:{width:bounds.width,height:bounds.height});};
  resize();const observer=new ResizeObserver(resize);observer.observe(node);return()=>observer.disconnect();
 },[]);
 const {width,height}=viewport;
 const compact=width<520;
 const length=Number(p.length),angle=Number(p.incline),radius=Number(p.radius);
 const start=[0,length*Math.sin(angle)],end=[length*Math.cos(angle),0];
 const position=vector(frame,'body.position');
 // Fit the whole trajectory once per parameter set, keeping the ramp stationary
 // during playback. Equal scales on both axes preserve the physical incline.
 const centers=(r:number)=>[start,end].map(point=>[point[0]+r*Math.sin(angle),point[1]+r*Math.cos(angle)]);
 const worldPoints:number[][]=[start,end,[0,start[1]+2*radius],[end[0]+2*radius,0]];
 const addBodyEnvelope=(r:number)=>centers(r).forEach(center=>worldPoints.push([center[0]-r,center[1]-r],[center[0]+r,center[1]+r]));
 addBodyEnvelope(radius);
 if(comparison&&comparisonParameters)addBodyEnvelope(Number(comparisonParameters.radius));
 const forceIds=['force.gravityVector','force.normalVector','force.frictionVector'];
 if(forces)for(const id of forceIds){const f=vector(frame,id);for(const center of centers(radius))worldPoints.push([center[0]+f[0]*.15,center[1]+f[1]*.15]);}
 const minX=Math.min(...worldPoints.map(v=>v[0])),maxX=Math.max(...worldPoints.map(v=>v[0]));
 const minY=Math.min(...worldPoints.map(v=>v[1])),maxY=Math.max(...worldPoints.map(v=>v[1]));
 const left=compact?24:48,right=compact?24:48,top=76,bottom=45;
 const availableWidth=width-left-right,availableHeight=height-top-bottom;
 const scale=Math.min(availableWidth/Math.max(.1,maxX-minX),availableHeight/Math.max(.1,maxY-minY));
 const offsetX=left+(availableWidth-(maxX-minX)*scale)/2-minX*scale;
 const offsetY=height-bottom+minY*scale;
 const project=(v:readonly number[])=>[offsetX+v[0]*scale,offsetY-v[1]*scale];
 const [sx,sy]=project(start),[ex,ey]=project(end),[cx,cy]=project(position);
 const r=radius*scale,ground=project([0,0])[1]+6;
 const terminal=frame.status==='boundary';
 const colors=['#b86518','#00777c','#2864e8'];
 const arrow=(id:string,color:string)=>{const f=vector(frame,id),dx=f[0]*.15*scale,dy=-f[1]*.15*scale;return <g key={id} {...binding(frame,id)} data-display-scale="0.15 m/N"><line x1={cx} y1={cy} x2={cx+dx} y2={cy+dy} stroke={color} strokeWidth="2.2" markerEnd={`url(#force-${color.slice(1)})`}/></g>;};
 const bodyMark=(f:RunFrame,params:ScalarParams,color:string,rr:number,second=false)=>{
  const hollow=params.bodyType==='hoop'||params.bodyType==='shell';
  const rot=-scalar(f,'body.rotation')*180/Math.PI;
  return <g transform={`rotate(${rot})`}>
   <circle r={rr} fill={hollow?'#f5f9fc':second?'#d4eff0':'#c8dcff'} stroke={color} strokeWidth={Math.min(hollow?4:2,Math.max(.8,rr*.25))}/>
   {params.bodyType==='shell'?<circle r={rr*.74} fill="none" stroke={color} strokeWidth="1" strokeDasharray="3 3"/>:null}
   {!hollow&&rr>4?<><path d={`M ${-rr*.8} ${-rr*.6} L ${rr*.8} ${rr*.6} M ${-rr} 0 L ${rr} 0 M ${-rr*.8} ${rr*.6} L ${rr*.8} ${-rr*.6}`} fill="none" stroke={color} opacity=".6" strokeWidth="1.3"/><circle r={rr*.67} fill="none" stroke={color} strokeWidth="1" opacity=".35"/></>:null}
   <line x1="0" y1="0" x2={rr} y2="0" stroke={color} strokeWidth={Math.min(2.5,Math.max(.7,rr*.12))}/><circle cx={rr*.82} r={Math.min(2.4,rr*.13)} fill={color}/>
  </g>;
 };
 const disc=(f:RunFrame,params:ScalarParams,color:string,second=false)=>{
  const pos=project(vector(f,'body.position')),rr=Number(params.radius)*scale;
  const label=bodyNames[String(params.bodyType)],labelWidth=label.length*6.8;
  const rightSide=pos[0]+rr+18+labelWidth<width-12;
  const labelX=rightSide?Math.max(12,pos[0]+rr+15):Math.max(12,pos[0]-rr-labelWidth-15);
  const labelY=Math.max(18,pos[1]-rr-(second?48:18));
  const calloutX=rightSide?labelX-6:labelX+labelWidth+6;
  return <g key={second?'comparison':'primary'} {...binding(f,'body.rotation')} data-scene-role={second?'comparison':'primary'} data-position={JSON.stringify(vector(f,'body.position'))} role="button" tabIndex={0} aria-label={`${second?'Comparison: ':''}${label}, distance ${format(scalar(f,'body.distance'))} metres, speed ${format(scalar(f,'body.speed'))} metres per second`} onClick={()=>onSelect('body.speed')} onKeyDown={e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();onSelect('body.speed');}}} className="selectable-mark">
   <circle cx={pos[0]} cy={pos[1]} r={Math.max(rr,12)} fill="transparent"/>
   <g transform={`translate(${pos[0]},${pos[1]})`}>{bodyMark(f,params,color,rr,second)}</g>
   {selectedIds.includes('body.speed')&&!second?<circle cx={pos[0]} cy={pos[1]} r={rr+6} stroke={color} strokeDasharray="3 3" fill="none"/>:null}
   <path d={`M ${pos[0]+(rightSide?rr*.6:-rr*.6)} ${pos[1]-rr*.6} L ${calloutX} ${labelY-4}`} stroke={color} strokeWidth=".8" fill="none"/>
   <text x={labelX} y={labelY} fill={color} fontSize="12" fontWeight="500" stroke="#f5f9fd" strokeWidth="3" paintOrder="stroke">{label}</text>
  </g>;
 };
 const note=forces?'Forces: 0.15 m/N · weight, normal, friction':terminal?'Ramp end · terminal velocity retained':'From rest · no slipping or energy loss';
 return <svg ref={ref} className="rolling-svg" viewBox={`0 0 ${width} ${height}`} role="group" aria-label="Side view of ideal rolling bodies on a ramp. The position and orientation use the current model frame.">
  <defs>{colors.map(c=><marker key={c} id={`force-${c.slice(1)}`} markerWidth="6" markerHeight="6" refX="5" refY="3" orient="auto"><path d="M0 0L6 3L0 6Z" fill={c}/></marker>)}<pattern id="ramp-hatch" width="7" height="7" patternUnits="userSpaceOnUse"><path d="M0 7L7 0" stroke="#a6b8cb" strokeWidth=".6"/></pattern></defs>
  <line x1={Math.max(12,sx-15)} y1={ground} x2={Math.min(width-12,ex+22)} y2={ground} stroke="#a4b7cb"/>
  <path d={`M${sx} ${sy+6} L${ex} ${ey+6} L${ex} ${ground} L${sx} ${ground}Z`} fill="#e8eff6" opacity=".65"/>
  <path d={`M${sx} ${sy}L${ex} ${ey}l0 6L${sx} ${sy+6}Z`} fill="url(#ramp-hatch)" stroke="#8398b1" strokeWidth="1.1"/>
  <line x1={sx+3} y1={sy+6} x2={sx+3} y2={ground} stroke="#b3c3d4"/>
  <path d={`M${ex-30} ${ey} A30 30 0 0 1 ${ex-30*Math.cos(angle)} ${ey-30*Math.sin(angle)}`} fill="none" stroke="#8697af"/>
  <text x={ex-sx<120&&ex+84<width?ex+12:Math.max(12,ex-72)} y={ey-10} fontSize="12" fill="#50627d">θ = {format(angle*180/Math.PI,1)}°</text>
  {comparison&&comparisonParameters?disc(comparison,comparisonParameters,'#007e86',true):null}
  {disc(frame,p,'#1765f5')}
  {forces?forceIds.map((id,index)=>arrow(id,colors[index])):null}
  {r<5.5?<g transform={`translate(${width-47},42)`} {...binding(frame,'body.rotation')} aria-label={`Rotation detail, enlarged ${format(16/r,1)} times`}>
   {bodyMark(frame,p,'#1765f5',16)}<text x="0" y="31" textAnchor="middle" fontSize="10" fill="#526783">Rotation ×{format(16/r,1)}</text>
  </g>:null}
  <text x={compact?18:left} y={height-12} fontSize="11" fill="#50627d">{note}</text>
  <g transform={`translate(${compact?16:25} 49)`} fill="none" stroke="#7286a0" strokeWidth="1"><path d="M0 0V-23m-3 5l3-5 3 5M0 0H23m-5-3l5 3-5 3"/><text x="27" y="4" fill="#50627d" stroke="none" fontSize="11">x</text><text x="-3" y="-28" fill="#50627d" stroke="none" fontSize="11">y</text></g>
 </svg>;
}
