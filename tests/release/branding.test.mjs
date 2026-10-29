import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
const root=fileURLToPath(new URL('../../',import.meta.url));
const previous=[String.fromCharCode(101,120,112,101,114,105,109,101,110,116),String.fromCharCode(107,105,116)];
const obsolete=new RegExp(`${previous[0]}[ _-]?${previous[1]}`,'i');
test('the active repository uses only the current project identity',()=>{
 const files=execFileSync('git',['ls-files','--cached','--others','--exclude-standard','-z'],{cwd:root}).toString().split('\0').filter(Boolean);
 const problems=[];
 for(const name of new Set(files)){
  const file=path.join(root,name);if(!existsSync(file))continue;
  if(obsolete.test(name)){problems.push(name);continue;}
  const bytes=readFileSync(file);if(bytes.includes(0))continue;
  if(obsolete.test(bytes.toString('utf8')))problems.push(name);
 }
 assert.deepEqual(problems,[]);
});
test('the workspace exposes one canonical CLI and current scoped package names',()=>{
 const manifest=JSON.parse(readFileSync(path.join(root,'package.json')));
 assert.equal(manifest.name,'@explorable-models/workspace');
 assert.equal(manifest.scripts.models,'node packages/cli/bin/explorable-models.mjs');
 for(const key of [previous[1],String.fromCharCode(101,107)])assert.equal(manifest.scripts[key],undefined);
 for(const name of ['core','activity','catalog','player','player-3d','agent']){
  const pkg=JSON.parse(readFileSync(path.join(root,'packages',name,'package.json')));
  assert.equal(pkg.name,`@explorable-models/${name}`);
 }
});
