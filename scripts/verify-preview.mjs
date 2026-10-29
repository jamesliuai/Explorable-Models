// Verifies the developer-preview artifacts and writes release/preview/verification.json and cross-browser-evidence.json.
//
//   node scripts/verify-preview.mjs                  # runs the gates below itself (stops at the first failure)
//   node scripts/verify-preview.mjs --from-pipeline  # derives the results from the Study Harness release pipeline run
//                                                    # recorded in release/study-harness/verification.json (CI runs the
//                                                    # pipeline once, then this), without running any gate twice
import { spawnSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { chromium, firefox, webkit } from 'playwright';
import { crossBrowserEvidence, crossBrowserRecord, parsePlaywrightReport } from './study-harness/release-pipeline.mjs';
const output='/tmp/explorable-models-final-verification';await mkdir(output,{recursive:true});await mkdir('release/preview',{recursive:true});
// Per-engine, per-spec counts of test:cross-browser (G73): from the pipeline gate's record, or from the JSON report of
// the run below.
let crossBrowser=null;const crossBrowserReport=`${output}/test-cross-browser.report.json`;
const commands=[['typecheck'],['test'],['test:contracts'],['test:release'],['test:browser'],['test:cross-browser'],['build'],['verify:gallery'],['build:packages'],['verify:packages'],['release']];
const results=[];
let pipelineRun=null;
if(process.argv.includes('--from-pipeline')){
 // The pipeline packs once (build:packages is part of its pack step) and runs every gate below with exact counts.
 pipelineRun=JSON.parse(await readFile('release/study-harness/verification.json','utf8'));
 const head=spawnSync('git',['rev-parse','HEAD'],{encoding:'utf8'});
 if(pipelineRun.status==='fail')throw new Error(`The release pipeline run ${pipelineRun.runId} failed; see release/study-harness/verification.json.`);
 if(head.status===0&&pipelineRun.source?.commit!==head.stdout.trim())throw new Error('The recorded release pipeline run is for another source commit.');
 const byId=new Map(pipelineRun.gates.map(gate=>[gate.id,gate]));
 for(const [name] of commands){
  const gate=byId.get(name==='build:packages'?'pack':name);
  if(gate?.status!=='pass')throw new Error(`${name} did not pass in release pipeline run ${pipelineRun.runId} (${gate?.status??'missing'}${gate?.reason?`: ${gate.reason}`:''}).`);
  results.push({command:name==='test'?'npm test':name==='build:packages'?'node scripts/study-harness/pack.mjs (build:packages + npm pack, the pipeline pack)':`npm run ${name}`,status:'passed',startedAt:gate.startedAt??null,durationMs:gate.durationMs??null,...(gate.execution?{execution:gate.execution}:{}),...(gate.reusedFrom?{reusedFrom:gate.reusedFrom}:{}),...(gate.counts?{passedTests:gate.counts.passed,tests:gate.counts.total,skippedTests:gate.counts.skipped??0}:{}),log:gate.log??null});
  if(name==='test:cross-browser'){
   if(!gate.details?.engines)throw new Error(`Release pipeline run ${pipelineRun.runId} recorded no per-engine cross-browser counts; re-run the pipeline.`);
   crossBrowser={engines:gate.details.engines,specs:gate.details.specs,missing:gate.details.missing??[],unexplainedSkips:gate.details.unexplainedSkips??[],scope:gate.details.scope};
  }
 }
}
for(const [name] of pipelineRun?[]:commands){
 const start=Date.now();const cross=name==='test:cross-browser';
 const args=name==='test'?['test']:cross?['run',name,'--','--reporter=list,json']:['run',name];
 const result=spawnSync('npm',args,{encoding:'utf8',maxBuffer:20_000_000,env:{...process.env,NO_COLOR:'1',FORCE_COLOR:'0',...(cross?{PLAYWRIGHT_JSON_OUTPUT_FILE:crossBrowserReport}:{})}});
 const log=`${result.stdout??''}\n${result.stderr??''}`;const logPath=`${output}/${name.replaceAll(':','-')}.log`;await writeFile(logPath,log);
 const stripped=log.replace(/\u001b\[[0-9;]*m/g,'');
 const testCount=name==='test'?Number(stripped.match(/Tests\s+(\d+) passed/)?.[1]??0):name==='test:release'?Number(stripped.match(/(?:^|\n)(?:#\s*|ℹ\s*)?pass\s+(\d+)/)?.[1]??0):name.startsWith('test:')?Number(stripped.match(/(\d+) passed\s*\(/)?.[1]??0):undefined;
 results.push({command:`npm ${args.join(' ')}`,status:result.status===0?'passed':'failed',durationMs:Date.now()-start,...(testCount!==undefined?{passedTests:testCount}:{}),log:logPath});
 console.log(`${name}: ${result.status===0?'passed':'FAILED'} (${((Date.now()-start)/1000).toFixed(1)}s)${testCount?` · ${testCount} tests`:''}`);
 if(result.error||result.status!==0){await writeFile('release/preview/verification.json',JSON.stringify({status:'failed',createdAt:new Date().toISOString(),results},null,2)+'\n');throw new Error(`${name} failed; see ${logPath}\n${log.slice(-8000)}`);}
}
const evidence=JSON.parse(await readFile('release/preview/package-evidence.json','utf8'));const engines={};const browsers={};
for(const [name,engine] of Object.entries({chromium,firefox,webkit})){const browser=await engine.launch({headless:true});engines[name]=browser.version();browsers[name]={version:browser.version(),executablePath:engine.executablePath()};await browser.close();}
if(!crossBrowser){
 const counts=parsePlaywrightReport(JSON.parse(await readFile(crossBrowserReport,'utf8')));
 crossBrowser=crossBrowserRecord(counts,browsers);
 const cross=results.find(item=>item.command.includes('test:cross-browser'));if(cross&&counts)Object.assign(cross,{tests:counts.total,skippedTests:counts.skipped});
}
if(crossBrowser.missing.length)throw new Error(`test:cross-browser did not run ${crossBrowser.missing.join(', ')}.`);
if(crossBrowser.unexplainedSkips.length)throw new Error(`test:cross-browser skipped tests without a recorded reason: ${crossBrowser.unexplainedSkips.join('; ')}.`);
const gallery=JSON.parse(await readFile('dist/release-checks.json','utf8'));
const revision=spawnSync('git',['rev-parse','HEAD'],{encoding:'utf8'});
const worktree=spawnSync('git',['status','--porcelain','--untracked-files=normal'],{encoding:'utf8'});
const source={repository:'https://github.com/jamesliuai/Explorable-Models',commit:revision.status===0?revision.stdout.trim():null,workingTreeClean:worktree.status===0?!worktree.stdout.trim():null,...(process.env.GITHUB_RUN_ID?{ciRunUrl:`https://github.com/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`}:{})};
if(process.env.GITHUB_SHA&&source.commit!==process.env.GITHUB_SHA)throw new Error('CI checkout does not match the triggering source commit.');
const pipeline=pipelineRun?{runId:pipelineRun.runId,status:pipelineRun.status,partial:pipelineRun.partial,summary:pipelineRun.summary,packManifestSha256:pipelineRun.pack?.manifestSha256??null,record:'release/study-harness/verification.json',...(pipelineRun.mode?{mode:pipelineRun.mode}:{}),...(pipelineRun.resume?{resume:{parent:pipelineRun.resume.parent,rerun:pipelineRun.resume.rerun,reused:pipelineRun.resume.reused}}:{})}:null;
// Claims established by automated gates are kept apart from the external ones; none of the latter is established here.
const claims={humanScientificReview:false,manualAssistiveTechnology:false,externalPilots:false,credentialedProviderRun:false,actualStudyHarnessIntegration:false,realConfiguredAgentTrial:false,nativePlatforms:{packagedEvidence:'macOS reference host only, when the native gate passed in the release pipeline; never established by this preview verification',windows:false,linux:false},independentSubjectReview:false,learningEfficacy:false,supportedRelease:false,npmPublication:false,websiteDeployment:false};
const verification={version:evidence.version,status:'passed',createdAt:new Date().toISOString(),source,platform:process.platform,arch:process.arch,node:process.version,engines,results,...(pipeline?{pipeline}:{}),packageHashes:evidence.packages.map(({name,sha256,integrity})=>({name,sha256,integrity})),gallery:{legacyExperiments:gallery.reports.length,legacyReferenceChecks:gallery.reports.reduce((sum,item)=>sum+item.results.length,0),declarativeFreshRestores:gallery.documentReports.length,externalNetwork:gallery.externalNetwork},claims,scope:'Source-repository developer preview (unpublished). Requirement status and remaining external gates: docs/study-harness/requirement-ledger.md and docs/study-harness/external-gates.md; the Study Harness release evidence is release/study-harness/verification.json.'};
await writeFile('release/preview/verification.json',JSON.stringify(verification,null,2)+'\n');
await writeFile('release/preview/cross-browser-evidence.json',JSON.stringify(crossBrowserEvidence({version:evidence.version,createdAt:verification.createdAt,source,record:crossBrowser,result:results.find(item=>item.command.includes('test:cross-browser')),packages:verification.packageHashes,pipeline}),null,2)+'\n');
console.log('Verified developer preview artifacts. No external trials, npm publication or website deployment claimed.');
