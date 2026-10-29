#!/usr/bin/env node
// Generates src-tauri/policy/approved.json from the INSTALLED catalogue package (the packed tarball in node_modules).
//
// The Rust host embeds this file with include_str! and issues every policy, receipt and grant from it: the host never
// approves a template, model or content digest because the webview asks for it. The file holds identities and the
// host's own lesson rules only (refs and digests computed by the installed catalogue from its own data, group kinds,
// solution-bearing flags, stage visibility, transitions and control domains); it holds no learner copy and no code.
//
// Run as part of `npm run build:web` (frontend build time). Output is deterministic for a given catalogue.
// This imports trusted installed catalogue data only; no model is evaluated here (kernels run in the browser worker).
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInstalledCatalog } from '@experiment-kit/catalog';

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(appRoot, 'src-tauri/policy/approved.json');
const lock = JSON.parse(readFileSync(path.join(appRoot, 'package-lock.json'), 'utf8'));
const locked = (name) => {
  const entry = lock.packages?.[`node_modules/${name}`];
  return entry ? { name, version: entry.version, integrity: entry.integrity ?? null } : null;
};

const catalog = createInstalledCatalog();
const problems = catalog.problems();
if (problems.length) throw new Error(`The installed catalogue reports problems: ${JSON.stringify(problems).slice(0, 2000)}`);

const templates = [];
for (const entry of catalog.listTemplates()) {
  if (entry.status.revoked) continue;
  const template = catalog.getTemplate(entry.template);
  const manifest = catalog.getModel(entry.model);
  const identity = catalog.identity({ templateId: entry.template.templateId, version: entry.template.version });
  if (!template || !manifest || identity?.kind !== 'template') throw new Error(`Installed entry ${entry.template.templateId} is incomplete.`);
  const digests = new Map(identity.groups.map((group) => [group.groupId, group.contentDigest]));
  const groups = template.groups.map((group) => {
    const contentDigest = digests.get(group.id);
    if (!contentDigest) throw new Error(`${template.templateId}: no content digest for group ${group.id}.`);
    return { groupId: group.id, kind: group.kind, solutionBearing: group.solutionBearing, contentDigest };
  });
  const parameters = Object.fromEntries(template.controls.map((control) => {
    const definition = manifest.parameters[control.parameter];
    if (!definition) throw new Error(`${template.templateId}: control ${control.parameter} has no model parameter.`);
    return [control.parameter, [definition.min, definition.max]];
  }));
  templates.push({
    template: { ...entry.template },
    model: { ...entry.model },
    title: template.title,
    dimension: template.dimension,
    lifecycle: entry.status.lifecycle,
    initialStage: template.initialStage,
    groups,
    stages: template.stages.map((stage) => ({
      id: stage.id,
      kind: stage.kind,
      visible: Object.keys(stage.visible).sort(),
      response: stage.response?.kind ?? null,
    })),
    transitions: template.transitions.map((transition) => ({ id: transition.id, from: transition.from, to: transition.to })),
    parameters,
    // Neutral scaffold kept in an independent task: the non-solution-bearing equation groups (the stated rule, not the
    // worked result). This is the reference host's own rule, not a statement about what a task should allow.
    neutralScaffold: groups.filter((group) => group.kind === 'equation' && !group.solutionBearing).map((group) => group.groupId),
  });
}
templates.sort((a, b) => a.template.templateId.localeCompare(b.template.templateId));

const body = {
  schema: 'study-harness-reference.approved-policy/1',
  generatedBy: 'examples/study-harness-tauri/scripts/generate-approved-policy.mjs',
  note: 'Host-owned approval for the reference host (conformance fixture). Lifecycle is the installed catalogue status; none of these entries has an independent subject review. The Rust host embeds this file and never approves content requested by the webview.',
  catalog: [locked('@experiment-kit/catalog'), locked('@experiment-kit/activity'), locked('@experiment-kit/core')],
  templates,
};
const text = `${JSON.stringify(body, null, 2)}\n`;
mkdirSync(path.dirname(out), { recursive: true });
let previous = null;
try { previous = readFileSync(out, 'utf8'); } catch { /* first generation */ }
if (previous !== text) writeFileSync(out, text);
console.log(`[policy] ${previous === text ? 'unchanged' : 'wrote'} ${path.relative(appRoot, out)} (${templates.length} templates, sha256 ${createHash('sha256').update(text).digest('hex').slice(0, 16)})`);
