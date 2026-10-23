import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { register } from 'tsx/esm/api';
import { chromium } from 'playwright';
register();
const {serveStatic}=await import('../packages/cli/src/server.ts');
const inventory=JSON.parse(await readFile('dist/source-manifest.json','utf8'));
const server=await serveStatic('dist');
const browser=await chromium.launch();
const reports=[];const documentReports=[];
try {
 const context=await browser.newContext({viewport:{width:1440,height:1000},reducedMotion:'reduce'});
 await context.route('**/*',route=>new URL(route.request().url()).origin===server.url?route.continue():route.abort());
 const page=await context.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
 for(const id of Object.keys(inventory.experiments)){
  await page.goto(`${server.url}/?experiment=${id}`);
  await page.waitForFunction(()=>!!window.__EXPERIMENT_KIT__);
  const report=await page.evaluate(()=>window.__EXPERIMENT_KIT__.request({method:'verify'}));
  if(!report.passed)throw new Error(`${id}: quantitative worker checks failed: ${JSON.stringify(report)}`);
  if(report.definitionRevision!==inventory.experiments[id].definitionRevision)throw new Error(`${id}: source and runtime revision mismatch.`);
  const state=await page.evaluate(()=>window.__EXPERIMENT_KIT__.request({method:'checkpoint'}));
  const fresh=await context.newPage();await fresh.goto(`${server.url}/?experiment=${id}`);await fresh.waitForFunction(()=>!!window.__EXPERIMENT_KIT__);
  const restored=await fresh.evaluate(async snapshot=>{const api=window.__EXPERIMENT_KIT__;const s=await api.request({method:'state'});return api.request({method:'command',args:{type:'restore',snapshot,expectedRunVersion:s.run.version,expectedActiveRunId:s.activeRunId}});},state);
  if(restored.error||JSON.stringify(restored.state.run.parameters)!==JSON.stringify(state.parameters))throw new Error(`${id}: fresh-process restore failed.`);
  await fresh.close();reports.push(report);console.log(`${id}: ${report.results.length} cases passed; fresh state restored with external requests blocked.`);
 }
 const bundle=JSON.parse(await readFile('dist/bundle-manifest.json','utf8'));
 if(bundle.declarative){
  await page.goto(`${server.url}/agent.html`);await page.waitForFunction(()=>!!window.__COMPOSITION_STUDIO__);
  for(const entry of bundle.declarative.documents){
   await page.getByRole('combobox').selectOption(entry.id);
   await page.waitForFunction(id=>window.__COMPOSITION_STUDIO__.session.getState().document?.id===id,JSON.parse(await readFile(`dist/${entry.path}`,'utf8')).id);
   const artifact=await page.evaluate(()=>window.__COMPOSITION_STUDIO__.session.exportDocument());
   if(artifact.identity.documentRevision!==entry.documentRevision)throw new Error(`${entry.id}: production document identity mismatch`);
   const fresh=await context.newPage();await fresh.goto(`${server.url}/agent.html`);await fresh.waitForFunction(()=>!!window.__COMPOSITION_STUDIO__);
   const result=await fresh.evaluate(async artifact=>{const {session,guard}=window.__COMPOSITION_STUDIO__;await session.restoreDocument(artifact,guard());return session.getState();},artifact);
   if(result.identity.documentRevision!==entry.documentRevision||JSON.stringify(result.run.params)!==JSON.stringify(artifact.run.params))throw new Error(`${entry.id}: production document restore mismatch`);
   if(entry.id==='projectile'){const endpoint=await fresh.evaluate(async()=>{const {session,guard}=window.__COMPOSITION_STUDIO__;await session.seek(5,guard());return session.getState().frame;});if(endpoint.time!==0.8||endpoint.quantities.verticalVelocity.value!==-4)throw new Error('Production projectile boundary failed');}
   await fresh.close();documentReports.push({id:entry.id,documentRevision:entry.documentRevision,worker:'passed',freshRestore:'passed'});
  }
  await page.getByRole('combobox').selectOption('wave');await page.waitForFunction(()=>window.__COMPOSITION_STUDIO__.session.getState().document?.id==='wave');
  await mkdir('/tmp/experiment-kit-preview',{recursive:true});
  for(const width of [1440,1024,390]){await page.setViewportSize({width,height:1000});await page.screenshot({path:`/tmp/experiment-kit-preview/production-studio-${width}.png`,fullPage:true});if(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1))throw new Error('Production studio overflow');}
  console.log(`${documentReports.length} declarative documents restored in fresh production sessions; external requests blocked.`);
 }
 if(errors.length)throw new Error(errors.join('\n'));
 await mkdir('dist/checks',{recursive:true});
 for(let i=0;i<reports.length;i++)await writeFile(`dist/checks/${Object.keys(inventory.experiments)[i]}.json`,JSON.stringify(reports[i],null,2));
 await writeFile('dist/release-checks.json',JSON.stringify({runtimeVersion:'0.1.0',environment:{browser:browser.version(),node:process.version,platform:process.platform,viewport:{width:1440,height:1000}},externalNetwork:'blocked',freshStateRestore:'passed',consoleErrors:errors,reports,documentReports},null,2));
} finally {await browser.close();await server.close();}
const result=spawnSync(process.execPath,['scripts/postbuild.mjs'],{stdio:'inherit'});if(result.status)process.exit(result.status);
