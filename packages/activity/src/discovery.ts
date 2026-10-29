/**
 * Content-derived discovery entry of one installed template (report §5.3 `getCapabilities`, A05). The adapter reports
 * it for every listed template; a catalogue that loads content on demand stores the same entry, generated from the
 * content and checked against it by tests, in its eager index (`ActivityCatalog.describe`), so discovery is complete
 * before any template content is loaded. Pure: derived from the template and its model manifest only. Activity content
 * such as instructions and prompts is not listed.
 */
import type { TemplateDiscovery } from './api.js';
import type { ActivityTemplate, ModelManifest } from './contracts.js';
import { TABLE_ROW_LIMIT } from './projection.js';

export function templateDiscovery(template: ActivityTemplate, manifest: ModelManifest): TemplateDiscovery {
  const execution = manifest.execution;
  return {
    title: template.title, dimension: template.dimension, executionKind: execution.kind,
    mode: execution.kind === 'kernel' ? execution.mode : execution.document.time ? 'continuous' : 'static',
    controls: template.controls.map(control => {
      const definition = manifest.parameters[control.parameter]!;
      return { parameter: control.parameter, label: control.label, min: definition.min, max: definition.max, unit: definition.unit, displayUnits: [...control.displayUnits] };
    }),
    // Per-stage actions and the stage graph.
    stages: template.stages.map(stage => ({
      id: stage.id, kind: stage.kind, allowsPreview: stage.allowsPreview, allowsPlayback: stage.allowsPlayback, allowsNavigation: stage.allowsNavigation,
      controls: { ...stage.controls }, response: stage.response?.kind ?? null,
    })),
    transitions: template.transitions.map(transition => ({ id: transition.id, from: transition.from, to: transition.to, label: transition.label })),
    alternatives: template.alternatives.map(alternative => ({ id: alternative.id, kind: alternative.kind, equivalence: alternative.equivalence })),
    renderingRequirements: [template.dimension === '3d' ? 'webgl (optional; a 2D alternative is required)' : 'svg', ...(template.equations.length ? ['math (lazy, plain-text fallback)'] : []), 'module-workers'],
    limits: { ...manifest.limits, tableRows: TABLE_ROW_LIMIT },
    requires: template.requires.map(ref => ({ id: ref.id, version: ref.version })),
  };
}
