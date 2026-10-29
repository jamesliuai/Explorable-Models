/**
 * Learner-facing copy for the function-and-derivative activity. Neutral and descriptive: it names what is shown and
 * what to do, never claims understanding or mastery, and contains no answers, rubrics or scoring. All of it is part of
 * the template digest and of the content digest of the group that displays it.
 */

/** Formats a coefficient or position with a typographic minus sign. */
const number = (value: number): string => (value < 0 ? `−${-value}` : `${value}`);
/** A·x² + B·x + C with signs folded into the operators and zero terms kept visible. */
const polynomial = (A: number, B: number, C: number): string =>
  `${number(A)}·x² ${B < 0 ? '−' : '+'} ${Math.abs(B)}·x ${C < 0 ? '−' : '+'} ${Math.abs(C)}`;

export const FUNCTION_DERIVATIVE_COPY = Object.freeze({
  title: 'Slope of a curve and its derivative',
  /** Labelled groups of related controls (report §10.2). */
  sections: { coefficients: { id: 'coefficients', label: 'Coefficients of f' }, points: { id: 'points', label: 'Points P and Q' } },
  purpose: 'Predict, then observe, how the slope of the tangent to f(x) = A·x² + B·x + C changes along the curve, how secant slopes compare with it as the second point moves closer, and how the derivative f′ records the slope at every x.',
  stages: {
    prepare: {
      instruction: 'Look at the graph of f(x) = A·x² + B·x + C and the probe point P. You can change the coefficients A, B and C to see different curves. Slopes, tangents and the derivative are not shown yet.',
    },
    predict: {
      instruction: 'Before any slopes are shown, predict the slope of the curve at the probe point P.',
      prompt: 'Is the curve rising, falling or level at P, and roughly how steep is it there? How would the slope change if P moved to the right?',
    },
    exploreSlope: {
      instruction: 'Once the tangent at P and its slope f′(p) are shown, move P along the curve and compare the slope with your prediction. Then set the offset h to place a second point Q, and watch the secant slope as h gets closer to 0 from either side.',
    },
    exploreDerivative: {
      instruction: 'Once the graph of the derivative f′ is shown, move P and change the coefficients, and compare the height of the derivative graph at x = p with the slope of the tangent at P.',
    },
    explain: {
      instruction: 'Explain in your own words how the slope of f changes along the curve and how the secant slope behaves as h shrinks.',
      prompt: 'How does the slope of the tangent at P change as P moves, how does the secant slope behave as h gets close to 0, and what does the derivative graph show?',
    },
    closed: { instruction: 'This activity is closed.' },
    freeExplore: { instruction: 'Explore freely: change the coefficients, move the probe and the second point, and compare the tangent, the secant and the derivative graph.' },
  },
  groups: {
    functionPlot: { label: 'Graph of f', description: 'Plot of f(x) = A·x² + B·x + C for x from −5 to 5, with its table of sampled values.' },
    probe: { label: 'Probe point', description: 'The probe point P = (p, f(p)), its marker on the graph and the values panel.' },
    functionRule: { label: 'Function rule', description: 'The rule f(x) = A·x² + B·x + C in symbols.' },
    coefficientControls: { label: 'Coefficient controls', description: 'Sliders and exact entry for the coefficients A, B and C.' },
    probeControl: { label: 'Probe control', description: 'Slider and exact entry for the probe position p; the probe marker can also be dragged along x.' },
    offsetControl: { label: 'Offset control', description: 'Slider and exact entry for the offset h from P to the second point Q.' },
    tangent: { label: 'Tangent line', description: 'The tangent line to the graph at P.' },
    slope: { label: 'Slope at the probe', description: 'The derivative f′(p) and whether the graph is increasing, decreasing or stationary at P.' },
    slopeEquations: { label: 'Tangent equations', description: 'The equation of the tangent line and the value of f′(p).' },
    secant: { label: 'Secant line', description: 'The second point Q and the secant line through P and Q.' },
    secantValues: { label: 'Secant values', description: 'The coordinates of Q, the secant slope and its difference from f′(p).' },
    secantEquations: { label: 'Secant equations', description: 'The secant slope as a difference quotient, with its current value.' },
    derivativePlot: { label: 'Graph of f′', description: 'Plot of the derivative f′(x) = 2A·x + B with the point (p, f′(p)) and its table of sampled values.' },
    shape: { label: 'Shape of the graph', description: 'Whether the graph curves upward, curves downward, is a sloped line or is level, and where its vertex is.' },
    derivativeRule: { label: 'Derivative rule', description: 'The derivative rule for f and the exact relation between secant slope and derivative.' },
    scenarios: { label: 'Ready-made settings', description: 'Preset coefficients, probe positions and offsets.' },
    alternatives: { label: 'Other ways to use this activity', description: 'Tables, values, text descriptions, exact entry and keyboard controls that stand in for the graphs and gestures.' },
  },
  scenarioNote: 'Ready-made settings for the coefficients, the probe and the offset h, including three offsets for the same probe.',
  scenario: ({ A, B, C, p, h }: { A: number; B: number; C: number; p: number; h: number }) => ({
    label: `f(x) = ${polynomial(A, B, C)}, p = ${number(p)}, h = ${number(h)}`,
    description: `Sets A = ${number(A)}, B = ${number(B)} and C = ${number(C)}, places P at x = ${number(p)} and Q at offset h = ${number(h)}.`,
  }),
  alternatives: {
    curveTable: { label: 'Table of f(x)', description: 'Lists x and f(x) at the sampled positions from −5 to 5, the same values the graph is drawn through. The 401 samples are shortened to every third one plus both ends; the rule f(x) = A·x² + B·x + C with the coefficients shown gives every value in between exactly.' },
    pointValues: {
      label: 'Point and slope values',
      description: 'The values panel and the equations give the coordinates of P and, once shown, the slope f′(p), the coordinates of Q and the secant slope. A line through a known point with a known slope is fully determined, so these values carry what the tangent and secant lines show.',
    },
    derivativeTable: { label: 'Table of f′(x)', description: 'Lists x and f′(x) at the sampled positions from −5 to 5, the same values the derivative graph is drawn through, shortened to every third sample plus both ends. The derivative rule gives every value in between, and the value at the probe is in the values panel.' },
    textDescription: { label: 'Text description', description: 'A generated text summary of each graph, built from the values currently shown. It summarises the graphs rather than listing every point.' },
    exactEntry: { label: 'Exact entry', description: 'Type exact values for A, B, C, the probe position p and the offset h instead of dragging. Values outside the allowed range, or a second point outside −5 to 5, are explained and are not changed into a different experiment.' },
    keyboard: { label: 'Keyboard controls', description: 'Arrow keys change each control by one step of 0.25, including moving the probe P, without dragging.' },
  },
});
