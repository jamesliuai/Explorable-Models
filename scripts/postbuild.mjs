import { readFile, writeFile, readdir, cp, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { register } from 'tsx/esm/api';
register();
const { copyPlaybackLicenses } = await import('../packages/cli/src/licenses.ts');
const dist=path.resolve('dist');
const hash=b=>'sha256:'+createHash('sha256').update(b).digest('hex');
const list=async(dir,base='')=>{const out=[];for(const e of await readdir(dir,{withFileTypes:true})){const name=path.posix.join(base,e.name);if(e.isDirectory())out.push(...await list(path.join(dir,e.name),name));else if(e.isFile()&&name!=='bundle-manifest.json')out.push(name);}return out.sort();};
for(const name of ['LICENSE','THIRD_PARTY_NOTICES.md'])await cp(name,path.join(dist,name));
await copyPlaybackLicenses(dist);
const { createPreset, presetCatalog, documentIdentity } = await import('../packages/core/src/declarative/index.ts');
await mkdir(path.join(dist,'documents'),{recursive:true});
const documents=[];
for(const preset of presetCatalog){const document=createPreset(preset.id);const identity=await documentIdentity(document);const file=`documents/${preset.id}.json`;await writeFile(path.join(dist,file),JSON.stringify(document,null,2)+'\n');documents.push({id:preset.id,path:file,...identity,review:'unreviewed'});}
await cp('docs',path.join(dist,'docs'),{recursive:true});
const source=JSON.parse(await readFile(path.join(dist,'source-manifest.json'),'utf8'));
const assets=[];for(const name of await list(dist)){const bytes=await readFile(path.join(dist,name));assets.push({path:name,bytes:bytes.length,sha256:hash(bytes)});}
await writeFile(path.join(dist,'bundle-manifest.json'),JSON.stringify({project:'Explorable Models',repository:'https://github.com/jamesliuai/Explorable-Models',schemaVersion:'1.0',runtimeVersion:'0.1.0',entry:'index.html',legacyEntry:'gallery.html',guide:'guide.html',declarative:{schemaVersion:'2.0',runtimeVersion:'0.2.0-preview.1',entry:'index.html',alias:'agent.html',documents},experiments:source.experiments,assets,capabilities:{offlineHTTPPlayback:true,fileURLPlayback:false,hostileCodeIsolation:false},modelReview:'unreviewed',learnerEvidence:'not_evaluated'},null,2));
console.log(`Static gallery: ${assets.length} local assets, ${Object.keys(source.experiments).length} revision-pinned experiments.`);
