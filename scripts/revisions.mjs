import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { register } from 'tsx/esm/api';
register();
const { getRuntimeIdentity, readDependencyLock } = await import('../packages/cli/src/compiler.ts');
const { canonical, readSource } = await import('../packages/cli/src/files.ts');
const { definitionRevision } = await import('../packages/core/src/index.ts');
const root = new URL('../', import.meta.url);
const ids = ['rolling','linear-map','base-rates','riemann-sums','oscillator'];
const revisions = {};
const inventory = {schemaVersion:'1.0',experiments:{}};
const dependencyLock = await readDependencyLock();
const runtimeIdentity = await getRuntimeIdentity();
for (const id of ids) {
 const source=await readSource(fileURLToPath(new URL(`examples/${id}/`,root)));
 revisions[id]=definitionRevision({manifest:JSON.parse(source['experiment.json']),views:JSON.parse(source['views.json']),source:canonical(source),dependencyLock,runtimeIdentity});
 const dir=new URL(`public/source/${id}/`,root);await mkdir(dir,{recursive:true});
 for(const [name,content] of Object.entries(source))await writeFile(new URL(name,dir),content);
 await writeFile(new URL('package-lock.json',dir),dependencyLock);
 inventory.experiments[id]={definitionRevision:revisions[id],files:[...Object.keys(source),'package-lock.json']};
}
await writeFile(new URL('examples/revisions.ts',root),`// Generated from source, dependency lock, and exact runtime/player identity.\nexport const revisions = ${JSON.stringify(revisions,null,2)} as const;\n`);
await writeFile(new URL('public/source-manifest.json',root),JSON.stringify(inventory,null,2));
