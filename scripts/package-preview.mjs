import { readFile, readdir, writeFile, mkdir, copyFile, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { zipSync } from 'fflate';
import { execFileSync } from 'node:child_process';
const root=fileURLToPath(new URL('../',import.meta.url));const directory=path.join(root,'release/preview');
const packageEvidence=JSON.parse(await readFile(path.join(directory,'package-evidence.json'),'utf8'));
const verification=JSON.parse(await readFile(path.join(directory,'verification.json'),'utf8'));
await mkdir(path.join(root,'dist/evidence'),{recursive:true});
for(const name of ['verification.json','package-evidence.json','cross-browser-evidence.json'])await copyFile(path.join(directory,name),path.join(root,'dist/evidence',name));
execFileSync(process.execPath,['scripts/postbuild.mjs'],{cwd:root,stdio:'inherit'});
const cliEvidence=JSON.parse(await readFile(path.join(root,'release/release-manifest.json'),'utf8'));
await copyFile(path.join(root,'release',cliEvidence.package),path.join(directory,cliEvidence.package));
await copyFile(path.join(root,'release/release-manifest.json'),path.join(directory,'cli-evidence.json'));
const files={};
async function visit(folder,prefix=''){for(const entry of await readdir(folder,{withFileTypes:true})){const relative=path.posix.join(prefix,entry.name);if(entry.isDirectory())await visit(path.join(folder,entry.name),relative);else if(entry.isFile())files[relative]=new Uint8Array(await readFile(path.join(folder,entry.name)));}}
await visit(path.join(root,'dist'));
if(!files['agent.html']||!files['bundle-manifest.json'])throw new Error('Build the static composition studio before packaging.');
const archive=`explorable-models-site-${packageEvidence.version}.zip`;
await writeFile(path.join(directory,archive),zipSync(files,{level:6}));
// The previous verified candidate is retained separately; avoid ambiguous old site names.
await rm(path.join(directory,`explorable-models-site-${packageEvidence.version}.zip`),{force:true});
const entries=[];
for(const name of [...packageEvidence.packages.map(item=>item.file),archive,cliEvidence.package,'cli-evidence.json','package-evidence.json','verification.json','cross-browser-evidence.json']){const bytes=await readFile(path.join(directory,name));entries.push({file:name,bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')});}
const manifest={project:'Explorable Models',repository:'https://github.com/jamesliuai/Explorable-Models',source:verification.source,version:packageEvidence.version,kind:'verified-local-developer-preview',publication:'npm unpublished; hosting deferred; source repository is a separate channel',createdAt:new Date().toISOString(),files:entries,site:{entry:'index.html',studioAlias:'agent.html',legacyEntry:'gallery.html',guide:'guide.html',legacyQueryLinks:true,serveOver:'HTTP(S)',directFileLoading:false},evidence:'package-evidence.json',releaseChecklist:'docs/study-harness/requirement-ledger.md',historicalChecklist:'docs/agent-first-release-status.md (0.2 preview; historical)',limits:'Not the supported release: actual Study Harness integration, a real configured agent trial, manual AT and intended-user sessions, independent subject review, other native platforms, learning efficacy and public smoke tests remain open (docs/study-harness/external-gates.md).'};
await writeFile(path.join(directory,'preview-manifest.json'),JSON.stringify(manifest,null,2)+'\n');
await writeFile(path.join(directory,'README.md'),`# Explorable Models ${packageEvidence.version}\n\nVerified developer preview artifacts. npm publishing and hosting are deferred.\n\nRepository: https://github.com/jamesliuai/Explorable-Models\n\nInstall the scoped library tarballs listed in package-evidence.json (${packageEvidence.packages.map(item=>item.name.replace('@explorable-models/','')).join(', ')}) together with React/ReactDOM using the embedding guide; install them together, because @explorable-models/agent depends on @explorable-models/activity and both depend on @explorable-models/core. The Study Harness subsystem's complete set of six packages (adding @explorable-models/catalog and @explorable-models/player-3d) is packed separately by npm run pack:study-harness into release/study-harness/packages and verified by npm run release:study-harness. Technical package and CLI names retain explorable-models for compatibility; npm namespace ownership is unconfirmed. The unscoped explorable-models tarball is the separate trusted-local CLI/source distribution. The site archive is self-contained: unzip it and serve the directory over HTTP. index.html opens the studio, agent.html is its retained alias, gallery.html preserves the legacy gallery, and guide.html explains the preview. Existing ?experiment= links still work.\n\nPackage hashes, clean-consumer checks and measured desktop workloads: package-evidence.json. All deliverable hashes: preview-manifest.json. Requirement status: site docs/study-harness/requirement-ledger.md; external gates: docs/study-harness/external-gates.md (the 0.2 preview status in docs/agent-first-release-status.md is historical). Remaining owner details and handoff: site docs/public-preview-handoff.md. Local artifact/subpath verification: npm run verify:artifacts from the source checkout.\n`);
process.stdout.write(JSON.stringify(manifest,null,2)+'\n');
