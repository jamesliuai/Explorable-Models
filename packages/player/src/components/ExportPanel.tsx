import { useState } from 'react';
import { Download, FileJson, Package, Code } from 'lucide-react';
import { zipSync, strToU8 } from 'fflate';
import { sha256, type ExperimentRuntime } from '@explorable-models/core';
import type { ExperimentEntry } from '../types';
import { download, downloadJSON } from '../utils';
export function ExportPanel({entry,runtime}:{entry:ExperimentEntry;runtime:ExperimentRuntime}) {
 const [message,setMessage]=useState(''),[busy,setBusy]=useState(false);
 const bundle=async(sourceOnly:boolean)=>{setBusy(true);setMessage('');try{
  const files:Record<string,Uint8Array>={};const snapshot=runtime.checkpoint();
  if(sourceOnly){
   const index=await fetch(new URL('source-manifest.json',document.baseURI));if(!index.ok||index.headers.get('content-type')?.includes('text/html'))throw new Error('This server does not include a source inventory. Use the CLI export command below.');
   const inventory=(await index.json()).experiments?.[entry.id];
   if(inventory?.definitionRevision!==entry.definition.definitionRevision)throw new Error('The active model differs from this served source bundle. Export the checked candidate with the CLI.');
   if(!Array.isArray(inventory.files)||inventory.files.length>1000)throw new Error('Invalid source inventory.');
   for(const name of inventory.files){if(typeof name!=='string'||name.includes('..')||name.startsWith('/')||name.includes(':'))throw new Error('Invalid source path.');const response=await fetch(new URL(`source/${entry.id}/${name}`,document.baseURI));if(!response.ok||response.headers.get('content-type')?.includes('text/html'))throw new Error('Source files are unavailable here. Use the CLI export command.');files[name]=new Uint8Array(await response.arrayBuffer());}
  }else{
   const response=await fetch(new URL('bundle-manifest.json',document.baseURI));if(!response.ok||response.headers.get('content-type')?.includes('text/html'))throw new Error('Runnable exports are available from a production build. Run npm run build, or use the CLI export command below.');const manifest=await response.json();
   const revision=manifest.experiments?.[entry.id]?.definitionRevision??(manifest.experimentId===entry.id?manifest.definitionRevision:undefined);
   if(revision!==entry.definition.definitionRevision)throw new Error('The active model differs from this served bundle. Export the checked candidate with the CLI.');
   if(!Array.isArray(manifest.assets)||manifest.assets.length>1000)throw new Error('Invalid bundle manifest.');
   for(const item of manifest.assets){const path=typeof item==='string'?item:item.path;if(typeof path!=='string'||path.includes('..')||path.startsWith('/')||path.includes(':'))throw new Error('Invalid bundle asset path.');const data=await fetch(new URL(path,document.baseURI));if(!data.ok)throw new Error(`Could not load ${path}`);files[path]=new Uint8Array(await data.arrayBuffer());}
   const html=new TextDecoder().decode(files['index.html']);
   const json=JSON.stringify(snapshot).replace(/</g,'\\u003c');
   const startup=`<script type="application/json" id="explorable-models-snapshot">${json}</script>`;
   const rewritten=html.replace(/<script type="application\/json" id="explorable-models-snapshot">[\s\S]*?<\/script>/,'').replace('</head>',`${startup}</head>`);
   files['index.html']=strToU8(rewritten);
   manifest.assets=manifest.assets.map((item:{path:string})=>item.path==='index.html'?{path:'index.html',sha256:`sha256:${sha256(rewritten)}`,bytes:files['index.html'].byteLength}:item);
   const snapshotJSON=JSON.stringify(snapshot,null,2);files['snapshot.json']=strToU8(snapshotJSON);
   manifest.assets=manifest.assets.filter((item:{path:string})=>item.path!=='snapshot.json');
   manifest.assets.push({path:'snapshot.json',sha256:`sha256:${sha256(snapshotJSON)}`,bytes:files['snapshot.json'].byteLength});
   files['bundle-manifest.json']=strToU8(JSON.stringify(manifest,null,2));
  }
  files['snapshot.json']=strToU8(JSON.stringify(snapshot,null,2));
  download(`${entry.id}-${sourceOnly?'source':'experiment'}.zip`,zipSync(files,{level:6}),'application/zip');setMessage('Download prepared. Serve a runnable export over HTTP.');
 }catch(e){setMessage(e instanceof Error?e.message:String(e));}finally{setBusy(false);}};
 return <div className="export-options"><p>Take the experiment with you. A snapshot preserves this moment; a runnable bundle includes everything needed for offline playback over HTTP.</p><button onClick={()=>downloadJSON(`${entry.id}-snapshot.json`,runtime.checkpoint())}><FileJson/><span><strong>Download snapshot</strong><small>Parameters, exact time, selection, and view state</small></span><Download size={17}/></button><button onClick={()=>bundle(true)} disabled={busy}><Code/><span><strong>Download source</strong><small>Editable model, manifest, views, and checks</small></span><Download size={17}/></button><button onClick={()=>bundle(false)} disabled={busy}><Package/><span><strong>Download runnable bundle</strong><small>Self-contained static player from a production build</small></span><Download size={17}/></button>{message?<p role="status" className="notice-inline">{message}</p>:null}<h3>From your terminal</h3><pre>npm run models -- export examples/{entry.id} --out exports/{entry.id} --zip</pre><p className="tiny-note">Exports contain no AI credentials or chat history. Source revisions are identified by a content digest.</p></div>;
}
