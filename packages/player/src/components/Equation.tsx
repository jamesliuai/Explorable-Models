import { memo } from 'react';
import katex from 'katex';
export const Equation=memo(function Equation({tex}:{tex:string}) {
 const html=katex.renderToString(tex,{throwOnError:false,trust:false,strict:'warn',output:'htmlAndMathml',displayMode:true});
 return <div className="equation" dangerouslySetInnerHTML={{__html:html}}/>;
});
