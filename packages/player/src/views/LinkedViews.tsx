import { useLayoutEffect, useRef, useState } from 'react';
import { scaleLinear } from 'd3-scale';
import { line } from 'd3-shape';
import type { RunFrame, ScalarParams } from '@experiment-kit/core';
import { binding, bodyNames, format, scalar } from '../utils';
export function EnergyView({frame,comparison,parameters,comparisonParameters,onSelect}:{frame:RunFrame;comparison?:RunFrame;parameters:ScalarParams;comparisonParameters?:ScalarParams;onSelect:(id:string)=>void}) {
 const row=(f:RunFrame,p:ScalarParams,secondary=false)=>{
  const translation=scalar(f,'energy.translational'),rotation=scalar(f,'energy.rotational'),kinetic=translation+rotation;
  const share=kinetic>0?translation/kinetic:1/(1+scalar(f,'body.kappa'));
  return <div className={`energy-row ${secondary?'comparison':''}`} key={f.frameId}><span>{bodyNames[String(p.bodyType)]}<small>κ = {format(scalar(f,'body.kappa'),3)}</small></span><div className="energy-bar" aria-label={`${format(share*100,1)} percent translational, ${format((1-share)*100,1)} percent rotational`}><button style={{width:`${share*100}%`}} onClick={()=>onSelect('energy.translational')} {...binding(f,'energy.translational')} aria-label={`Translational energy ${format(translation)} joules`}>{format(share*100,0)}%</button><button style={{width:`${(1-share)*100}%`}} onClick={()=>onSelect('energy.rotational')} {...binding(f,'energy.rotational')} aria-label={`Rotational energy ${format(rotation)} joules`}>{format((1-share)*100,0)}%</button></div></div>;
 };
 return <section className="secondary-panel"><h3>Where the energy goes</h3>{row(frame,parameters)}{comparison&&comparisonParameters?row(comparison,comparisonParameters,true):null}<div className="energy-key"><span><i className="legend-dot blue"/>Translation</span><span><i className="legend-dot pale"/>Rotation</span></div><p className="tiny-note">{scalar(frame,'energy.total')===0?'Horizontal ramp: no energy is converted.':scalar(frame,'energy.translational')===0?'Share of kinetic energy once motion begins.':`${format(scalar(frame,'energy.translational')+scalar(frame,'energy.rotational'),2)} J of gravitational energy converted.`}</p></section>;
}
export function SpeedPlot({frame,trace,comparisonTrace,comparison,parameters}:{frame:RunFrame;trace:RunFrame[];comparisonTrace:RunFrame[];comparison?:RunFrame;parameters:ScalarParams}) {
 const ref=useRef<SVGSVGElement>(null);const [width,setWidth]=useState(400);
 useLayoutEffect(()=>{const node=ref.current;if(!node)return;const resize=()=>{if(node.clientWidth)setWidth(node.clientWidth);};resize();const observer=new ResizeObserver(resize);observer.observe(node);return()=>observer.disconnect();},[]);
 const height=185,left=38,right=14,top=16,bottom=145;
 const all=[...trace,...comparisonTrace];const maxTime=Math.max(...all.map(f=>f.timePoint.time),frame.timePoint.time,1),maxSpeed=Math.max(...all.map(f=>scalar(f,'body.speed')),scalar(frame,'body.speed'),1)*1.1;
 const x=scaleLinear().domain([0,maxTime]).range([left,width-right]),y=scaleLinear().domain([0,maxSpeed]).range([bottom,top]);
 const makeLine=line<RunFrame>().x(f=>x(f.timePoint.time)).y(f=>y(scalar(f,'body.speed')));
 return <section className="secondary-panel speed-panel"><div className="panel-title"><h3>Speed over time</h3><span className="tiny-note">m/s</span></div><svg ref={ref} viewBox={`0 0 ${width} ${height}`} className="speed-plot" role="img" aria-label="Speed grows linearly with time until each body reaches the ramp end. Each trace stops at its own arrival event.">
  {y.ticks(4).map(v=><g key={v}><line x1={left} x2={width-right} y1={y(v)} y2={y(v)} stroke="#e5edf5"/><text x={left-8} y={y(v)+4} textAnchor="end" fontSize="11" fill="#526783">{format(v,1)}</text></g>)}
  <path d={`M${left} ${top}V${bottom}H${width-right}`} stroke="#a7b7ca" fill="none"/>
  {x.ticks(width<300?3:4).map(v=><text key={v} x={x(v)} y={bottom+18} textAnchor="middle" fontSize="11" fill="#526783">{format(v,1)}</text>)}
  <path d={makeLine(trace)??''} stroke="#1765f5" fill="none" strokeWidth="2" data-trace-run={frame.runId} data-quantity-id="body.speed"/>
  <path d={makeLine(comparisonTrace)??''} stroke="#007e86" fill="none" strokeWidth="2" strokeDasharray="4 4"/>
  <line x1={x(frame.timePoint.time)} x2={x(frame.timePoint.time)} y1={top} y2={bottom} stroke="#9aacbf" strokeDasharray="3 3"/>
  <circle cx={x(frame.timePoint.time)} cy={y(scalar(frame,'body.speed'))} r="4" fill="#1765f5" stroke="white" {...binding(frame,'body.speed')}/>
  {comparison?<circle cx={x(comparison.timePoint.time)} cy={y(scalar(comparison,'body.speed'))} r="4" fill="#007e86" stroke="white" {...binding(comparison,'body.speed')}/>:null}
  <text x={(left+width-right)/2} y={height-3} textAnchor="middle" fontSize="11" fill="#526783">Time (s)</text>
 </svg><div className="plot-legend"><span><i className="line-key"/>{bodyNames[String(parameters.bodyType)]}</span>{comparison?<span><i className="line-key dashed"/>Comparison</span>:null}</div></section>;
}
export function FrequencyTable({frame,onSelect}:{frame:RunFrame;onSelect:(id:string)=>void}) {
 return <section className="secondary-panel frequency-table"><h3>Every part accounted for</h3><table><caption className="sr-only">Exact expected frequency table, values rounded to three decimals for display.</caption><thead><tr><th scope="col">Expected parts</th><th scope="col">Flagged</th><th scope="col">Not flagged</th><th scope="col">Total</th></tr></thead><tbody>{[['Defective','truePositive','falseNegative','defective'],['Nondefective','falsePositive','trueNegative','nondefective'],['Total','flagged','unflagged','population']].map(([label,...ids])=><tr key={label}><th scope="row">{label}</th>{ids.map(id=><td key={id}><button onClick={()=>onSelect(`count.${id}`)} {...binding(frame,`count.${id}`)}>{format(scalar(frame,`count.${id}`))}</button></td>)}</tr>)}</tbody></table></section>;
}
