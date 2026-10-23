import type { ExperimentDefinition, RunFrame } from '@experiment-kit/core';
import { format, binding } from '../utils';
export function GenericScene({definition,frame,onSelect}:{definition:ExperimentDefinition;frame:RunFrame;onSelect:(id:string)=>void}) {
 const geometry=Object.entries(frame.geometry??{}).filter(([id])=>definition.manifest.geometry?.[id]?.shape.endsWith('2'));
 const all=geometry.flatMap(([,v])=>Array.from({length:v.length/2},(_,i)=>[v[2*i],v[2*i+1]]));
 const xs=all.map(p=>p[0]),ys=all.map(p=>p[1]);const bounds=definition.views?.find(v=>v.type==='scene2d')?.bounds;const minX=bounds?.x[0]??Math.min(0,...xs),maxX=bounds?.x[1]??Math.max(1,...xs),minY=bounds?.y[0]??Math.min(0,...ys),maxY=bounds?.y[1]??Math.max(1,...ys);
 const xy=(x:number,y:number)=>`${60+(x-minX)/(maxX-minX)*680},${350-(y-minY)/(maxY-minY)*290}`;
 return <div className="generic-scene">{geometry.length?<svg viewBox="0 0 800 400" aria-label={definition.manifest.description}>
  <line x1={60+(0-minX)/(maxX-minX)*680} x2={60+(0-minX)/(maxX-minX)*680} y1="40" y2="350" stroke="#b7c4d5"/><line x1="60" x2="740" y1={350-(0-minY)/(maxY-minY)*290} y2={350-(0-minY)/(maxY-minY)*290} stroke="#b7c4d5"/>{geometry.map(([id,points],i)=><polyline key={id} points={Array.from({length:points.length/2},(_,n)=>xy(points[n*2],points[n*2+1])).join(' ')} stroke={i%2?'#008e96':'#1765f5'} strokeWidth="2" fill={id.toLowerCase().includes('rectangle')?'#1765f518':'none'} data-geometry-id={id} data-frame-id={frame.frameId}/>)}
  <text x="60" y="375" fontSize="12" fill="#61738c">{format(minX)} → {format(maxX)}</text><text x="60" y="25" fontSize="12" fill="#61738c">{format(minY)} → {format(maxY)}</text>
 </svg>:<div className="generic-quantities">{Object.entries(frame.quantities).slice(0,6).map(([id,q])=><button onClick={()=>onSelect(id)} key={id} {...binding(frame,id)}><span>{definition.manifest.quantities[id].label}</span><strong>{q.status==='valid'?(Array.isArray(q.value)?q.value.map(v=>format(v)).join(', '):format(Number(q.value))):'Undefined'}</strong><small>{definition.manifest.quantities[id].unit}</small></button>)}</div>}<p className="scene-footnote">{definition.manifest.question}</p></div>;
}
