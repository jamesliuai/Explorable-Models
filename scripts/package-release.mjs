import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { chmod, copyFile, lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const manifest=JSON.parse(await readFile(path.join(root,'package.json'),'utf8'));
const releaseDirectory=path.join(root,'release');
const temporary=await mkdtemp(path.join(tmpdir(),'experiment-kit-release-'));
const staging=path.join(temporary,'staging');
await mkdir(staging);await mkdir(releaseDirectory,{recursive:true});
const hash=bytes=>`sha256:${createHash('sha256').update(bytes).digest('hex')}`;
const exists=async file=>{try{await lstat(file);return true;}catch(error){if(error.code==='ENOENT')return false;throw error;}};
function run(command,args,cwd=staging){
 const result=spawnSync(command,args,{cwd,encoding:'utf8',maxBuffer:32*1024*1024,env:{...process.env,CI:'1',npm_config_audit:'false',npm_config_fund:'false'}});
 if(result.error||result.status!==0)throw new Error(`${command} ${args.join(' ')} failed: ${result.error?.message??''}\n${(result.stderr||result.stdout||'').slice(-10000)}`);
 return result.stdout;
}
async function copyTree(relative){
 const source=path.join(root,relative),info=await lstat(source);
 if(info.isSymbolicLink())throw new Error(`Release source cannot contain symlinks: ${relative}`);
 if(info.isDirectory()){
  if(['node_modules','dist','.git','.codex','.agents','test-results','coverage'].includes(path.basename(relative)))return;
  for(const entry of (await readdir(source)).sort())await copyTree(path.join(relative,entry));
 }else if(info.isFile()){
  // Explicit source roots plus an extension allowlist exclude credentials, editor state, binaries, and unrelated files.
  if(!/\.(?:ts|tsx|js|mjs|json|md|css|html|svg|txt)$/.test(relative)&&!['LICENSE','.gitignore'].includes(path.basename(relative)))return;
  if(/(?:^|[/\\])\./.test(relative)&&path.basename(relative)!=='.gitignore')return;
  const destination=path.join(staging,relative);await mkdir(path.dirname(destination),{recursive:true});await copyFile(source,destination);
 }
}

try{
 for(const required of ['README.md','LICENSE','index.html','tsconfig.json','vite.config.ts','package-lock.json'])if(!await exists(path.join(root,required)))throw new Error(`Create ${required} before packaging a release.`);
 for(const relative of ['packages/core/src','packages/core/package.json','packages/core/tsconfig.build.json','packages/core/README.md','packages/core/LICENSE','packages/player/src','packages/player/package.json','packages/player/tsconfig.build.json','packages/player/build.mjs','packages/player/README.md','packages/player/LICENSE','packages/agent','packages/cli/src','packages/cli/bin','examples','tests','docs','scripts','public/favicon.svg','publication.config.json','README.md','AGENTS.md','LICENSE','THIRD_PARTY_NOTICES.md','SECURITY.md','CONTRIBUTING.md','CHANGELOG.md','index.html','agent.html','gallery.html','guide.html','tsconfig.json','vite.config.ts','vitest.config.ts','playwright.config.ts'])if(await exists(path.join(root,relative)))await copyTree(relative);
 const runtimeTools=['vite','esbuild','typescript','playwright','@vitejs/plugin-react'];
 const dependencies={...manifest.dependencies};const development={...manifest.devDependencies};
 for(const name of runtimeTools){if(!dependencies[name]&&!development[name])throw new Error(`Missing pinned runtime dependency ${name}`);dependencies[name]??=development[name];delete development[name];}
 const stagedManifest={name:'experiment-kit',version:manifest.version,description:manifest.description,type:'module',license:'MIT',engines:manifest.engines,bin:{'experiment-kit':'packages/cli/bin/experiment-kit.mjs'},files:['packages','examples','docs','scripts','tests','public','dist','README.md','AGENTS.md','LICENSE','THIRD_PARTY_NOTICES.md','SECURITY.md','CONTRIBUTING.md','CHANGELOG.md','RELEASE.json','npm-shrinkwrap.json','index.html','agent.html','tsconfig.json','vite.config.ts','vitest.config.ts','playwright.config.ts'],scripts:{...manifest.scripts,kit:'node packages/cli/bin/experiment-kit.mjs',ek:'node packages/cli/bin/experiment-kit.mjs','build:sdk':'tsc -p packages/core/tsconfig.build.json',release:'node scripts/package-release.mjs'},dependencies,devDependencies:development};
 for(const script of ['build:packages','verify:packages','verify:preview','release:preview']) delete stagedManifest.scripts[script];
 delete stagedManifest.scripts['verify:artifacts'];
 Object.assign(stagedManifest, { repository: manifest.repository, homepage: manifest.homepage, bugs: manifest.bugs, author: manifest.author, publishConfig: { access: 'public', tag: 'preview' } });
 stagedManifest.files.push('gallery.html','guide.html','publication.config.json');
 for(const hook of ['preinstall','install','postinstall','prepare','prepack','postpack'])delete stagedManifest.scripts[hook];
 // Workspaces are intentionally absent: the unified package retains the toolkit source layout.
 await writeFile(path.join(staging,'package.json'),`${JSON.stringify(stagedManifest,null,2)}\n`);
 await copyFile(path.join(root,'package-lock.json'),path.join(staging,'package-lock.json'));
 run('npm',['install','--package-lock-only','--ignore-scripts','--no-audit','--no-fund']);
 const lock=await readFile(path.join(staging,'package-lock.json'));
 // npm excludes package-lock.json from tarballs. Shrinkwrap is the standard distributable lock format.
 await writeFile(path.join(staging,'npm-shrinkwrap.json'),lock);
 await chmod(path.join(staging,'packages/cli/bin/experiment-kit.mjs'),0o755);
 await symlink(path.join(root,'node_modules'),path.join(staging,'node_modules'),'dir');
 try{run('npm',['run','build']);run('npm',['run','verify:gallery']);}finally{await rm(path.join(staging,'node_modules'),{force:true});}
 await writeFile(path.join(staging,'RELEASE.json'),`${JSON.stringify({name:'experiment-kit',version:manifest.version,createdAt:new Date().toISOString(),node:process.version,dependencyLockDigest:hash(lock),distribution:'unified source toolkit and static gallery',modelReview:'unreviewed',learnerEvidence:'not_evaluated',scope:'Trusted local authoring; analytical and parametric models; no hostile-code isolation.'},null,2)}\n`);
 const dryRun=JSON.parse(run('npm',['pack','--dry-run','--json','--ignore-scripts']))[0];
 const files=dryRun.files.map(file=>file.path);
 if(files.some(file=>/(?:^|\/)(?:\.env(?:\.|$)|\.git(?:\/|$)|\.codex(?:\/|$)|node_modules(?:\/|$)|\.experiment-kit-session\.json|local-bridge\.js)/.test(file)))throw new Error('Disallowed local or credential-bearing path entered the package.');
 for(const required of ['npm-shrinkwrap.json','AGENTS.md','packages/cli/bin/experiment-kit.mjs','packages/player/src/main.tsx','packages/core/src/index.ts','examples/linear-map/model.ts','dist/index.html','dist/favicon.svg','dist/release-checks.json','dist/licenses/index.json'])if(!files.includes(required))throw new Error(`Missing release file: ${required}`);
 const packed=JSON.parse(run('npm',['pack','--json','--ignore-scripts','--pack-destination',releaseDirectory]))[0];
 const tarball=path.join(releaseDirectory,packed.filename);
 const fresh=path.join(temporary,'fresh');await mkdir(fresh);
 run('tar',['-xzf',tarball,'-C',fresh],root);
 const installed=path.join(fresh,'package');
 run('npm',['ci','--ignore-scripts','--no-audit','--no-fund'],installed);
 const help=run(process.execPath,['packages/cli/bin/experiment-kit.mjs','--help'],installed);
 if(!help.includes('Explorable Models'))throw new Error('Packaged executable did not start.');
 const report=JSON.parse(run(process.execPath,['packages/cli/bin/experiment-kit.mjs','verify','examples/linear-map'],installed));
 if(!report.passed)throw new Error('Fresh packaged source failed browser-worker verification.');
 const expected=(await readFile(path.join(installed,'examples/revisions.ts'),'utf8')).match(/"linear-map":\s*"([^"]+)"/)?.[1];
 if(expected!==report.definitionRevision)throw new Error('Packaged gallery and CLI definition revisions disagree.');
 run('npm',['run','build:sdk'],installed);
 const gallery=JSON.parse(await readFile(path.join(installed,'dist/release-checks.json'),'utf8'));
 const evidence={package:path.basename(tarball),version:manifest.version,sha256:hash(await readFile(tarball)),integrity:packed.integrity,bytes:packed.size,unpackedBytes:packed.unpackedSize,files:files.length,validation:{npmPackDryRun:'passed',freshExtraction:'passed',npmCiIgnoreScripts:'passed',executableHelp:'passed',browserWorkerVerify:'passed',galleryCliIdentity:'matched',sdkBuild:'passed',galleryExperiments:gallery.reports.length,galleryChecks:gallery.reports.reduce((count,report)=>count+report.results.length,0),galleryFreshStateRestore:gallery.freshStateRestore,galleryExternalNetwork:gallery.externalNetwork},browserInstall:'Uses the installed Playwright Chromium cache; end users install it once with npx playwright install chromium.',publication:'Not published to any registry.'};
 await writeFile(path.join(releaseDirectory,'release-manifest.json'),`${JSON.stringify(evidence,null,2)}\n`);
 process.stdout.write(`${JSON.stringify(evidence,null,2)}\n`);
}finally{await rm(temporary,{recursive:true,force:true});}
