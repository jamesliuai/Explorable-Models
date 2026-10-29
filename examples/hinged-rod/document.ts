import type { VisualizationDocument } from '@explorable-models/core/declarative';

/** Data only. All expressions are evaluated by the toolkit's browser worker. */
export const rodDocument: VisualizationDocument = {
  schemaVersion: '2.0', id: 'hinged-rod', title: 'A rod, released from rest',
  description: 'Initial acceleration of a uniform rod about a fixed frictionless end hinge. Angle is measured from downward vertical toward the right.',
  parameters: {
    angle: { label: 'Angle', value: 45, min: 0, max: 90, step: 0.1, unit: '°' },
    length: { label: 'Length', value: 2, min: 0.5, max: 3, step: 0.01, unit: 'm', dimension: 'length' },
    gravity: { label: 'Gravity', value: 9.81, min: 0, max: 20, step: 0.01, unit: 'm/s²', dimension: 'acceleration' },
  },
  quantities: {
    theta: { expression: 'angle*pi/180', label: 'Angle in radians', unit: 'rad' },
    direction: { expression: '[sin(theta),-cos(theta)]', label: 'Rod unit direction' },
    halfDirection: { expression: '[sin(theta/2),-cos(theta/2)]', label: 'Angle label direction' },
    hinge: { expression: [0, 0], dimension: 'length', unit: 'm' },
    tip: { expression: 'length*direction', label: 'Free end', unit: 'm', dimension: 'length' },
    center: { expression: 'tip/2', label: 'Center of mass', unit: 'm', dimension: 'length' },
    alpha: { expression: '3*gravity*sin(theta)/(2*length)', label: 'Clockwise angular acceleration', unit: 'rad/s²', dimension: 'time^-2' },
    tangential: { expression: 'alpha*length/2', label: 'Center-of-mass tangential acceleration', unit: 'm/s²', dimension: 'acceleration' },
    acceleration: { expression: 'tangential*[-cos(theta),-sin(theta)]', label: 'Center-of-mass acceleration vector', unit: 'm/s²', dimension: 'acceleration' },
    centripetal: { expression: 0, label: 'Centripetal acceleration at release', unit: 'm/s²', dimension: 'acceleration' },
  },
  views: [
    { id: 'rod', type: 'scene', title: 'Rod at release', bounds: [-1, 3.5, -3.5, 0.5], marks: [
      { id: 'body', type: 'segment', label: 'Uniform rod', bindings: { start: 'hinge', end: 'tip' }, style: { stroke: '#477caf', strokeWidth: 8 } },
      { id: 'center', type: 'point', label: 'Center of mass', bindings: { position: 'center' }, style: { fill: '#c98422' } },
    ] },
    { id: 'results', type: 'values', title: 'At the instant of release', quantities: ['tangential', 'alpha', 'centripetal'] },
    { id: 'equations', type: 'equation', title: 'Uniform-rod model', equation: 'I = mL²/3; τ = mg(L/2)sinθ\nα = 3g sinθ/(2L) = {{alpha}}\naₜ = αL/2 = 3g sinθ/4 = {{tangential}}' },
  ],
  assumptions: ['Uniform rigid rod, hinged at one end.', 'Fixed frictionless hinge; uniform gravitational field.', 'Released from rest. Angle θ is measured from downward vertical.'],
  limitations: ['This is the instant of release, not a time integration.', 'The tangential acceleration shown is at the center of mass; the tip acceleration is twice as large.', 'The custom card uses 105 diagram units per metre and 14 diagram units per m/s² (85 and 10 in the compact view). The curved arrow indicates direction only.'],
  provenance: { review: 'unreviewed', checks: 'author', authoredBy: 'Explorable Models hinged-rod example' },
};

export const defaultParameters = Object.fromEntries(Object.entries(rodDocument.parameters).map(([id, spec]) => [id, spec.value]));
