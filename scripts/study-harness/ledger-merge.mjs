// Merges a patch file ([{id, status?, implementation?, verification?, evidence?, externalDependency?, notes?}]) into the ledger.
import { readFile, writeFile } from 'node:fs/promises';
const url = new URL('../../docs/study-harness/requirement-ledger.json', import.meta.url);
const ledger = JSON.parse(await readFile(url, 'utf8'));
const patch = JSON.parse(await readFile(process.argv[2], 'utf8'));
const merge = (into, items = []) => { for (const item of items) if (!into.some(existing => JSON.stringify(existing) === JSON.stringify(item))) into.push(item); };
for (const change of patch) {
  const row = ledger.requirements.find(entry => entry.id === change.id);
  if (!row) throw new Error(`Unknown requirement ${change.id}`);
  if (change.status) { if (!ledger.statusVocabulary.includes(change.status)) throw new Error(`Unknown status ${change.status}`); row.status = change.status; }
  merge(row.implementation, change.implementation); merge(row.verification, change.verification); merge(row.evidence, change.evidence);
  if (change.externalDependency !== undefined) row.externalDependency = change.externalDependency;
  if (change.notes) row.notes = change.notes;
}
await writeFile(url, JSON.stringify(ledger, null, 2) + '\n');
