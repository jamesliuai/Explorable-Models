/**
 * Learner-facing copy for the quadratic gradient-descent activity. Neutral and descriptive: it names what is shown
 * and what to do, never claims understanding or mastery, and contains no answers, rubrics or scoring. All of it is
 * part of the template digest and of the content digest of the group that displays it.
 */
export const QUADRATIC_COPY = Object.freeze({
  title: 'Step size in gradient descent',
  purpose: 'Predict, then observe, how the step size η and the curvature a determine the positions produced by fixed-step gradient descent on f(x) = a·x²/2.',
  stages: {
    predict: {
      instruction: 'Before any iterations are shown, predict what the positions x_n will do over the first few updates for the three comparison step sizes η = 0.25, 0.75 and 1.25 (curvature a = 2, start x₀ = 4).',
      prompt: 'For η = 0.25, 0.75 and 1.25 with a = 2 and x₀ = 4, what do you expect the positions to do over the first few iterations, and why?',
    },
    exploreStep: { instruction: 'Change the step size η and step through the iterations one at a time. Use the scenarios to compare η = 0.25, 0.75 and 1.25, and compare what you see with your prediction.' },
    exploreCurvature: { instruction: 'Now change the curvature a as well as the step size. Notice how the step sizes that give each kind of behaviour change with a.' },
    explain: {
      instruction: 'Explain in your own words how the step size and the curvature together determine what the positions do.',
      prompt: 'How do η and a together determine whether the positions shrink, change sign, keep the same size or grow?',
    },
    closed: { instruction: 'This activity is closed.' },
    freeExplore: { instruction: 'Explore freely: change the step size, curvature and starting position, step through the iterations and compare the scenarios.' },
  },
  groups: {
    landscape: { label: 'Objective landscape', description: 'Plot of the objective f(x) = a·x²/2 for positions from −10 to 10.' },
    start: { label: 'Starting point', description: 'The starting position x₀, its loss f(x₀) and its marker on the landscape, with the values panel.' },
    updateRule: { label: 'Update rule', description: 'The objective and the gradient-descent update rule in symbols.' },
    stepControl: { label: 'Step size control', description: 'Slider and exact entry for the step size η.' },
    curvatureControl: { label: 'Curvature control', description: 'Slider and exact entry for the curvature a.' },
    startControl: { label: 'Starting position control', description: 'Slider and exact entry for the starting position x₀.' },
    navigation: { label: 'Iteration navigation', description: 'The current iteration number n and the controls that step through iterations.' },
    trace: { label: 'Iteration trace', description: 'Positions x_n by iteration, the iterates and steps on the landscape, the current iterate and the trace table.' },
    observations: { label: 'Current values', description: 'Position, loss, gradient, update multiplier and the product η·a at the current iteration.' },
    regime: { label: 'Regime', description: 'The named behaviour of the positions and the step size 2/a.' },
    substitutedRule: { label: 'Update rule with values', description: 'The update rule with the current values of η·a and of the multiplier substituted.' },
    scenarios: { label: 'Comparison scenarios', description: 'Three step sizes compared with curvature a = 2 from x₀ = 4.' },
    alternatives: { label: 'Other ways to use this activity', description: 'Tables, text descriptions, exact entry and keyboard controls that stand in for the plots and gestures.' },
  },
  scenarioNote: 'Compare three step sizes with curvature a = 2, starting at x₀ = 4.',
  scenario: (eta: number) => ({ label: `η = ${eta}`, description: `Step size ${eta} with curvature a = 2, starting at x₀ = 4.` }),
  alternatives: {
    traceTable: { label: 'Trace table', description: 'Lists each computed iteration n with its position x_n, including the row where the trace stops if a value cannot be represented.' },
    landscapeValues: { label: 'Objective equation and values', description: 'The objective equation with the current curvature, the starting values x₀ and f(x₀), and, once shown, the position and loss values and the trace table carry the information drawn on the landscape.' },
    textDescription: { label: 'Text description', description: 'A generated text summary of each plot, built from the values currently shown. It summarises the plot rather than listing every point.' },
    exactEntry: { label: 'Exact entry', description: 'Type exact values for the step size, curvature and starting position instead of dragging. Values outside the allowed range are explained and are not changed into a different experiment.' },
    keyboard: { label: 'Keyboard controls', description: 'Arrow keys change each control by one step, and the next and previous buttons move one whole iteration at a time without dragging or animation.' },
  },
});
