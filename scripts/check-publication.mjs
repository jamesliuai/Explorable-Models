// Read-only owner handoff check. Packaging a local preview does not require publication approval.
import { readFile } from 'node:fs/promises';
const root = new URL('../', import.meta.url);
const config = JSON.parse(await readFile(new URL('publication.config.json', root), 'utf8'));
const pending = [];
if (!config.maintainerName?.trim()) pending.push('Public maintainer/contact name');
if (!config.securityContact?.trim()) pending.push('Working private security-reporting email or URL, tested by the owner');
if (process.argv.includes('--packages') && config.npmNamespaceOwnershipConfirmed !== true) pending.push('Ownership of every npm package name/scope, including the separate CLI name');
const securityPolicy = await readFile(new URL('SECURITY.md', root), 'utf8');
if (config.securityContact && !securityPolicy.includes(config.securityContact)) pending.push('SECURITY.md must contain the configured private reporting destination');
for (const relative of ['package.json', 'packages/core/package.json', 'packages/player/package.json', 'packages/agent/package.json']) {
  const manifest = JSON.parse(await readFile(new URL(relative, root), 'utf8'));
  if (manifest.repository?.url !== `git+${config.repository}.git`) pending.push(`${relative}: repository metadata mismatch`);
  if (!manifest.private && manifest.publishConfig?.tag !== 'preview') pending.push(`${relative}: preview publish tag missing`);
  const authorName = typeof manifest.author === 'string' ? manifest.author.split(' <')[0] : manifest.author?.name;
  if (config.maintainerName && authorName !== config.maintainerName) pending.push(`${relative}: maintainer metadata mismatch`);
}
const result = { project: config.projectName, repository: config.repository, status: pending.length ? 'awaiting-owner-details' : 'metadata-complete', pending, hosting: 'deferred by owner; no deployment configured', publication: 'not performed', remaining: 'Per-commit CI is recorded in GitHub Actions; public package/site smoke tests and external validation remain separate.' };
console.log(JSON.stringify(result, null, 2));
if (pending.length) process.exitCode = 1;
