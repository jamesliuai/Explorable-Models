import { spawnSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { chromium, firefox, webkit } from 'playwright';
const output='/tmp/experiment-kit-final-verification';await mkdir(output,{recursive:true});await mkdir('release/preview',{recursive:true});
const commands=[['typecheck'],['test'],['test:release'],['test:browser'],['test:cross-browser'],['build'],['verify:gallery'],['build:packages'],['verify:packages'],['release']];
const results=[];
for(const [name] of commands){
 const start=Date.now();const args=name==='test'?['test']:['run',name];
 const result=spawnSync('npm',args,{encoding:'utf8',maxBuffer:20_000_000,env:{...process.env,NO_COLOR:'1',FORCE_COLOR:'0'}});
 const log=`${result.stdout??''}\n${result.stderr??''}`;const logPath=`${output}/${name.replaceAll(':','-')}.log`;await writeFile(logPath,log);
 const stripped=log.replace(/\u001b\[[0-9;]*m/g,'');
 const testCount=name==='test'?Number(stripped.match(/Tests\s+(\d+) passed/)?.[1]??0):name==='test:release'?Number(stripped.match(/(?:^|\n)(?:#\s*|ℹ\s*)?pass\s+(\d+)/)?.[1]??0):name.startsWith('test:')?Number(stripped.match(/(\d+) passed\s*\(/)?.[1]??0):undefined;
 results.push({command:`npm ${args.join(' ')}`,status:result.status===0?'passed':'failed',durationMs:Date.now()-start,...(testCount!==undefined?{passedTests:testCount}:{}),log:logPath});
 console.log(`${name}: ${result.status===0?'passed':'FAILED'} (${((Date.now()-start)/1000).toFixed(1)}s)${testCount?` · ${testCount} tests`:''}`);
 if(result.error||result.status!==0){await writeFile('release/preview/verification.json',JSON.stringify({status:'failed',createdAt:new Date().toISOString(),results},null,2)+'\n');throw new Error(`${name} failed; see ${logPath}\n${log.slice(-8000)}`);}
}
const evidence=JSON.parse(await readFile('release/preview/package-evidence.json','utf8'));const engines={};
for(const [name,engine] of Object.entries({chromium,firefox,webkit})){const browser=await engine.launch({headless:true});engines[name]=browser.version();await browser.close();}
const gallery=JSON.parse(await readFile('dist/release-checks.json','utf8'));
const revision=spawnSync('git',['rev-parse','HEAD'],{encoding:'utf8'});
const worktree=spawnSync('git',['status','--porcelain','--untracked-files=normal'],{encoding:'utf8'});
const source={repository:'https://github.com/jamesliuai/Explorable-Models',commit:revision.status===0?revision.stdout.trim():null,workingTreeClean:worktree.status===0?!worktree.stdout.trim():null,...(process.env.GITHUB_RUN_ID?{ciRunUrl:`https://github.com/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`}:{})};
if(process.env.GITHUB_SHA&&source.commit!==process.env.GITHUB_SHA)throw new Error('CI checkout does not match the triggering source commit.');
const verification={version:evidence.version,status:'passed',createdAt:new Date().toISOString(),source,platform:process.platform,arch:process.arch,node:process.version,engines,results,packageHashes:evidence.packages.map(({name,sha256,integrity})=>({name,sha256,integrity})),gallery:{legacyExperiments:gallery.reports.length,legacyReferenceChecks:gallery.reports.reduce((sum,item)=>sum+item.results.length,0),declarativeFreshRestores:gallery.documentReports.length,externalNetwork:gallery.externalNetwork},claims:{humanScientificReview:false,manualAssistiveTechnology:false,externalPilots:false,credentialedProviderRun:false,supportedRelease:false,npmPublication:false,websiteDeployment:false},scope:'Source-repository developer preview; full supported-release gates remain in docs/agent-first-release-status.md'};
await writeFile('release/preview/verification.json',JSON.stringify(verification,null,2)+'\n');
await writeFile('release/preview/cross-browser-evidence.json',JSON.stringify({version:evidence.version,createdAt:verification.createdAt,engines:{firefox:engines.firefox,webkit:engines.webkit},result:results.find(item=>item.command.includes('test:cross-browser')),packages:verification.packageHashes,actualSafari:false,realMobileDevice:false},null,2)+'\n');
console.log('Verified developer preview artifacts. No external trials, npm publication or website deployment claimed.');
