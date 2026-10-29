import type { RunFrame } from '@explorable-models/core';
import { binding, format, scalar } from '../utils';
export function ProbabilityScene({frame,onSelect,selectedIds,tree=false}:{frame:RunFrame;onSelect:(id:string)=>void;selectedIds:readonly string[];tree?:boolean}) {
 const tp=scalar(frame,'count.truePositive'),fp=scalar(frame,'count.falsePositive'),flagged=scalar(frame,'count.flagged'),total=scalar(frame,'count.population');
 const posterior=frame.quantities['probability.posterior'];
 const percent=posterior.status==='valid'?Number(posterior.value)*100:null;
 if(tree)return <svg className="probability-tree" viewBox="0 0 800 420" aria-label="Probability tree with exact expected counts">
  <g fill="none" stroke="#ccd9e7" strokeWidth="2"><path d="M100 210L340 100M100 210L340 310M340 100L620 60M340 100L620 160M340 310L620 260M340 310L620 360"/></g>
  <g fontSize="13" fill="#526782"><text x="35" y="210">All parts</text><text x="35" y="231">{format(total)}</text><text x="260" y="77">Defective: {format(scalar(frame,'count.defective'))}</text><text x="260" y="337">Nondefective: {format(scalar(frame,'count.nondefective'))}</text></g>
  {[['count.truePositive','Flagged · defective',60,'#1765f5'],['count.falseNegative','Not flagged · defective',160,'#769bce'],['count.falsePositive','Flagged · nondefective',260,'#008e96'],['count.trueNegative','Not flagged · nondefective',360,'#96a6ba']].map(([id,label,y,color])=><g key={id} {...binding(frame,String(id))} role="button" tabIndex={0} onClick={()=>onSelect(String(id))} onKeyDown={e=>{if(e.key==='Enter')onSelect(String(id));}}><circle cx="620" cy={Number(y)} r="5" fill={String(color)}/><text x="635" y={Number(y)-10} fontSize="11" fill="#526782">{label}</text><text x="635" y={Number(y)+10} fontSize="17" fontWeight="600" fill={String(color)}>{format(scalar(frame,String(id)))}</text></g>)}
 </svg>;
 return <div className="frequency-scene">
  <div className="frequency-heading"><span>Look inside the flagged group</span><strong {...binding(frame,'count.flagged')}>{format(flagged)} <small>of {format(total)} parts</small></strong></div>
  <div className="frequency-strip" role="group" aria-label={`Among flagged parts: ${format(tp)} defective, ${format(fp)} nondefective.`}>
   {flagged>0?<><button style={{flex:tp||.00001}} className={`frequency-segment true-positive ${selectedIds.includes('count.truePositive')?'selected':''}`} onClick={()=>onSelect('count.truePositive')} aria-label={`${format(tp)} true positives`} {...binding(frame,'count.truePositive')}/><button style={{flex:fp||.00001}} className={`frequency-segment false-positive ${selectedIds.includes('count.falsePositive')?'selected':''}`} onClick={()=>onSelect('count.falsePositive')} aria-label={`${format(fp)} false positives`} {...binding(frame,'count.falsePositive')}/></>:<div className="empty-frequency">No parts are flagged</div>}
  </div>
  <div className="frequency-legend"><button onClick={()=>onSelect('count.truePositive')}><span className="legend-dot blue"/><span>Defective<strong>{format(tp)}</strong></span></button><button onClick={()=>onSelect('count.falsePositive')}><span className="legend-dot teal"/><span>Nondefective<strong>{format(fp)}</strong></span></button></div>
  <div className="posterior-insight"><span>When a part is flagged, the probability it is defective is</span><strong {...binding(frame,'probability.posterior')}>{percent===null?'Undefined':`${format(percent,2)}%`}</strong><p>{percent===null?posterior.reason:'Sensitivity asks a different question: how often the detector flags a defective part.'}</p></div>
  <p className="scene-footnote">Expected frequencies, not a random sample. Bar lengths use exact proportions; labels round to 3 decimal places.</p>
 </div>;
}
