import { readFile, writeFile, mkdir, mkdtemp, cp, rm, readdir } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { createServer } from 'node:http';
import { chromium } from 'playwright';
const root = fileURLToPath(new URL('../', import.meta.url));
const out = path.join(root, 'release/preview'); await mkdir(out, { recursive: true });
const scratch = await mkdtemp(path.join(tmpdir(), 'experiment-packed-consumer-'));
const screenshots = '/tmp/experiment-kit-preview'; await mkdir(screenshots, { recursive: true });
const manifest = JSON.parse(await readFile(path.join(root,'package.json'),'utf8'));
// npm ci may cache tarballs without package metadata. Exercise a real first install
// with an isolated cache, rather than relying on the maintainer's warmed registry cache.
const consumerCache = path.join(scratch, '.npm-cache');
const run = (command,args,cwd=scratch) => { const result=spawnSync(command,args,{cwd,encoding:'utf8',maxBuffer:10_000_000,env:{...process.env,npm_config_cache:consumerCache,npm_config_audit:'false',npm_config_fund:'false'}}); if(result.error||result.status) throw new Error(`${command} ${args.join(' ')}\n${result.error??result.stderr}\n${result.stdout}`); return result.stdout; };
const packages=[]; let server, browser;
try {
  for(const name of ['core','player','agent']) {
    const packed=JSON.parse(run('npm',['pack','--json','--ignore-scripts','--pack-destination',out],path.join(root,'packages',name)))[0];
    const inventory=packed.files.map(item=>item.path);
    for(const required of ['LICENSE','README.md','package.json']) if(!inventory.includes(required)) throw new Error(`${name}: missing ${required}`);
    if(inventory.some(file=>/(^|\/)(\.env|\.git|\.codex|node_modules|.*session.*\.json)(\/|$)/.test(file))) throw new Error(`${name}: forbidden local artifact`);
    const bytes=await readFile(path.join(out,packed.filename)); packages.push({name:`@experiment-kit/${name}`,file:packed.filename,sha256:createHash('sha256').update(bytes).digest('hex'),integrity:packed.integrity,bytes:bytes.length,files:inventory.length});
  }
  await cp(path.join(root,'examples/consumer'),scratch,{recursive:true});
  await writeFile(path.join(scratch,'package.json'),JSON.stringify({private:true,type:'module',dependencies:Object.fromEntries([...packages.map(p=>[p.name,`file:${path.join(out,p.file)}`]),['react',manifest.dependencies.react],['react-dom',manifest.dependencies['react-dom']]]),devDependencies:{vite:manifest.devDependencies.vite}}));
  run('npm',['install','--ignore-scripts','--no-audit','--no-fund']);
  run(process.execPath,['--input-type=module','-e',"await import('@experiment-kit/core/declarative'); await import('@experiment-kit/player'); await import('@experiment-kit/agent'); if(globalThis.window || globalThis.document) throw new Error('Unexpected DOM globals');"]);
  run('npm',['exec','vite','build']);
  const dist=path.join(scratch,'dist');
  const assets=await readdir(path.join(dist,'assets')); const sizes=[];
  for(const file of assets) {const bytes=await readFile(path.join(dist,'assets',file));sizes.push({file,bytes:bytes.length,gzipBytes:gzipSync(bytes).length});}
  const js=sizes.filter(item=>item.file.endsWith('.js')); const compressed=js.reduce((sum,item)=>sum+item.gzipBytes,0);
  if(compressed>180_000) throw new Error(`2D compressed JS including React and both consumer entries exceeds 180KB: ${compressed}`);
  const source=await Promise.all(js.map(item=>readFile(path.join(dist,'assets',item.file),'utf8')));
  if(source.some(text=>/THREE\.REVISION|WebGLRenderer|playwright-core|@modelcontextprotocol/.test(text))) throw new Error('Optional 3D or CLI dependency leaked into consumer');
  server=createServer(async(req,res)=> { const pathname=decodeURIComponent(new URL(req.url,'http://localhost').pathname); const file=path.resolve(dist,`.${pathname}`); if(!file.startsWith(`${dist}${path.sep}`)){res.writeHead(403).end();return;} try{const bytes=await readFile(file);res.setHeader('Content-Type',file.endsWith('.html')?'text/html':file.endsWith('.js')?'text/javascript':'application/octet-stream');res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; worker-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'");res.end(bytes);}catch{res.writeHead(404).end();} });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve)); const base=`http://127.0.0.1:${server.address().port}`;
  browser=await chromium.launch({headless:true}); const page=await browser.newPage({viewport:{width:1440,height:1000},reducedMotion:'reduce'}); const errors=[];page.on('pageerror',error=>errors.push(error.message));page.on('console',msg=>{if(msg.type()==='error')errors.push(msg.text());});page.on('requestfailed',req=>errors.push(`${req.url()}: ${req.failure()?.errorText}`));
  const checks=[]; let performanceEvidence;
  for(const entry of ['dom','react']) {
    await page.goto(`${base}/${entry}.html`);await page.waitForFunction(()=>Boolean(window.consumer)).catch(async error=>{throw new Error(`${error.message}\n${JSON.stringify(errors)}\n${await page.locator('body').innerText()}`);});
    const result=await page.evaluate(async()=> {const c=window.consumer; const first=c.first.session, tools=c.first.tools; const initial=first.getState(); if(initial.frame.quantities.ordinate.value!==2)throw new Error('Reference value failed');
      const other=c.second?.session.getState().run.id;
      const prepared=await tools.execute('visualization_revise',{edits:[{op:'set',collection:'series',id:'second',value:{label:'Comparison cosine',x:'x',y:'amplitude*cos(2*pi*frequency*x)',domain:[-2,2],samples:101}},{op:'setMark',viewId:'plot',mark:{id:'comparison',type:'line',label:'Comparison cosine',series:'second',style:{stroke:'#aa5533',dash:'dashed'}}},{op:'setMark',viewId:'plot',mark:{id:'note',type:'label',label:'Probe annotation',text:'Exact probe',bindings:{position:'probePoint'},offset:[10,-12]}}],guard:c.guard(first)});
      if(!prepared.ok)throw new Error(JSON.stringify(prepared));const committed=await tools.execute('visualization_commit',{candidateId:prepared.data.candidateId,guard:c.guard(first)});if(!committed.ok)throw new Error(JSON.stringify(committed));
      if(first.getState().document.series.wave.y!==initial.document.series.wave.y)throw new Error('Original curve changed');
      const prior=first.getState();const style=await tools.execute('visualization_revise',{edits:[{op:'presentation',value:{columns:2,precision:7}}],guard:c.guard(first)});await tools.execute('visualization_commit',{candidateId:style.data.candidateId,guard:c.guard(first)}); if(first.getState().run.id!==prior.run.id)throw new Error('Presentation restarted run');
      const bad=await tools.execute('visualization_revise',{edits:[{op:'set',collection:'quantities',id:'bad',value:{expression:'window.alert(1)'}}],guard:c.guard(first)});if(bad.ok)throw new Error('Unsafe expression accepted');
      const operation={action:'parameters',parameters:{amplitude:3},guard:c.guard(first)};const a=await tools.execute('visualization_operate',operation);const run=first.getState().run.id;const b=await tools.execute('visualization_operate',operation);if(!a.ok||!b.ok||first.getState().run.id!==run)throw new Error('Retry dedupe failed');
      if(c.second&&c.second.session.getState().run.id!==other)throw new Error('Cross-instance state changed');
      const saved=await tools.execute('visualization_save',{});const restored=await tools.execute('visualization_restore',{artifact:saved.data,guard:c.guard(first)});if(!restored.ok||first.getState().frame.quantities.ordinate.value!==3)throw new Error('Restore failed');return {entry:document.title,revision:first.getState().identity.documentRevision,independent:!!c.second,quantity:first.getState().frame.quantities.ordinate.value,comparisons:saved.data.comparisons.length}; });
    await page.screenshot({path:`${screenshots}/packed-${entry}-1440.png`,fullPage:true});await page.setViewportSize({width:390,height:844});await page.screenshot({path:`${screenshots}/packed-${entry}-390.png`,fullPage:true});
    if(await page.evaluate(()=>document.documentElement.scrollWidth>window.innerWidth+1))throw new Error(`${entry}: mobile overflow`);
    await page.setViewportSize({width:1440,height:1000});
    if(entry==='dom') performanceEvidence=await page.evaluate(async()=> {
      const consumer=window.consumer;
      const host=document.createElement('section');host.style.cssText='width:900px;max-width:100%;background:white';document.body.prepend(host);
      const session=await consumer.createVisualizationSession();const surface=consumer.mountVisualization(host,{session});
      const guard=()=>consumer.guard(session);
      const painted=async()=>{await new Promise(requestAnimationFrame);await new Promise(requestAnimationFrame);};
      const install=async document=>{const candidate=await session.createCandidate(document,guard());await session.commitCandidate(candidate.id,guard());await painted();};
      const visible=()=>{
        const state=session.getState();const svg=surface.element.shadowRoot.querySelector('svg[data-view-id]');
        if(!svg||Number(svg.dataset.sessionVersion)!==state.version||svg.dataset.runId!==state.run.id)throw new Error('Benchmark surface did not render the committed frame');
      };
      const quantiles=samples=>{const sorted=[...samples].sort((a,b)=>a-b);const at=q=>sorted[Math.max(0,Math.ceil(q*sorted.length)-1)];return{count:samples.length,minMs:sorted[0],p50Ms:at(.5),p95Ms:at(.95),maxMs:sorted.at(-1),samplesMs:samples};};
      const workloads=[];
      async function measure(name,document,summary){
        await install(document);host.scrollIntoView();await painted();
        for(let i=0;i<5;i++){await session.setParameters({amplitude:i%2?2:3},guard());await painted();visible();}
        const samples=[];
        for(let i=0;i<30;i++){const start=performance.now();await session.setParameters({amplitude:i%2?2:3},guard());await painted();visible();samples.push(performance.now()-start);}
        const stats=quantiles(samples);workloads.push({name,summary,...stats,targetP95Ms:100,targetPassed:stats.p95Ms<100});
      }
      try {
        await measure('small-wave',consumer.createPreset('wave'),'401 sampled points, linked values and equation; one mounted session alongside two idle consumers');
        const thousand=consumer.createPreset('wave');thousand.series.wave.samples=1001;
        await measure('1001-sample-plot',thousand,'One line with 1001 samples, exact probe and linked readouts');
        const objects=consumer.createPreset('wave');objects.views[0].marks=Array.from({length:100},(_,i)=>{const id=`position${i}`;objects.quantities[id]={expression:`[amplitude*0.01+${(i%10)*.4-1.8},${Math.floor(i/10)-4.5}]`,label:`Position ${i}`};return{id:`point-${i}`,type:'point',label:`Semantic point ${i}`,bindings:{position:id}};});
        await measure('100-semantic-marks',objects,'100 independently focusable semantic point objects on a grid; each model-bound position responds to the parameter');
        const dataset=consumer.createPreset('wave');dataset.datasets={supplied:{columns:[{id:'x',label:'x'},{id:'y',label:'Observed y'}],rows:Array.from({length:5000},(_,i)=>[i/1000,Math.sin(i/1000)]),description:'Fixed synthetic supplied benchmark values; not experimental observations.'}};dataset.series.wave={label:'Supplied 5000-row series',dataset:'supplied',xColumn:'x',yColumn:'y',kind:'observed'};dataset.views[0].bounds=[0,5,-2,2];
        await measure('5000-row-dataset',dataset,'Published maximum supplied rows rendered as one line; amplitude edits still evaluate the document and linked readouts');
        const lifecycle=[];const memory=[];
        surface.dispose();session.dispose();
        for(let i=0;i<25;i++){
          const started=performance.now();const next=await consumer.createVisualizationSession();const nextGuard=()=>consumer.guard(next);const candidate=await next.createCandidate(consumer.createPreset('wave'),nextGuard());await next.commitCandidate(candidate.id,nextGuard());const mounted=consumer.mountVisualization(host,{session:next});await next.setParameters({amplitude:3},nextGuard());await painted();mounted.dispose();next.dispose();
          if(host.childElementCount!==0)throw new Error('Mount/dispose cycle retained a DOM surface');lifecycle.push(performance.now()-started);
          if(performance.memory)memory.push({cycle:i+1,usedJSHeapSize:performance.memory.usedJSHeapSize});
        }
        return{scope:'Local desktop browser only; synthetic workloads, not a real-mobile-device result.',userAgent:navigator.userAgent,hardwareConcurrency:navigator.hardwareConcurrency,viewport:{width:innerWidth,height:innerHeight},measurement:'performance.now from parameter command invocation through two requestAnimationFrame callbacks; exact committed SVG run/version verified after each sample; 5 warmups then30 samples.',workloads,lifecycle:{...quantiles(lifecycle),cycles:25,retainedSurfaceCount:host.childElementCount,heapSamples:memory,heapConclusion:memory.length?'Browser-reported heap samples retained as diagnostic data; garbage collection is uncontrolled, so no memory-stabilization claim.':'Heap measurements unavailable in this browser; no memory-stabilization claim.'}};
      } finally {surface.dispose();session.dispose();host.remove();}
    });
    await page.evaluate(()=>window.consumer.dispose());checks.push(result);await page.setViewportSize({width:1440,height:1000});
  }
  if(errors.length)throw new Error(errors.join('\n'));
  const evidence={version:manifest.version,createdAt:new Date().toISOString(),node:process.version,platform:process.platform,arch:process.arch,browser:browser.version(),packages,checks,performance:performanceEvidence,ssrImport:'passed',installation:'Fresh directory and isolated empty npm cache; npm install --ignore-scripts with local tarballs and pinned React/ReactDOM/Vite; no repository aliases.',csp:'self scripts/workers, no eval or external network',dependencyBudget:{gzipBytes:compressed,maxGzipBytes:180000,assets:sizes},screenshots,publication:'Not published. Registry ownership, external trials and public smoke tests remain open.'};await writeFile(path.join(out,'package-evidence.json'),JSON.stringify(evidence,null,2)+'\n');process.stdout.write(JSON.stringify(evidence,null,2)+'\n');
} finally { await browser?.close();if(server)await new Promise(resolve=>server.close(resolve));await rm(scratch,{recursive:true,force:true}); }
