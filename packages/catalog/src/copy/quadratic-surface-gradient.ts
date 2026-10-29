/**
 * Learner-facing copy for the quadratic surface and gradient activity. Neutral and descriptive: it names what is shown
 * and what to do, never claims understanding or mastery, and contains no answers, rubrics or scoring. All of it is
 * part of the template digest and of the content digest of the group that displays it.
 */
type Copy = { label: string; description: string };
const point = (x: number, y: number): string => `p = (${x}, ${y})`;

export const SURFACE_GRADIENT_COPY = Object.freeze({
  title: 'Gradient on a quadratic surface',
  purpose: 'Predict, then observe, how the gradient of f(x, y) = (a·x² + 2b·x·y + c·y²)/2 at a chosen point p relates to the shape of the surface and to its contour lines.',
  stages: {
    orient: { instruction: 'Look at the surface and at the contour view. Each contour line joins points where f has the same value. Turn or reset the 3D view to compare them; turning the view never changes the surface or the point.' },
    predict: {
      instruction: 'Before the gradient is shown, make a prediction about it at the marked point p.',
      prompt: 'At the marked point p, in which direction do you expect f to increase fastest, and how do you expect that direction to sit relative to the contour line through p?',
    },
    explorePoint: { instruction: 'Once the gradient at p is shown as an arrow and as values, move p by dragging it in the contour view, with the arrow keys or by typing coordinates, and compare the arrow with the contour lines and with your prediction.' },
    exploreField: { instruction: 'Once arrows for the gradient at a grid of points are shown, change a, b and c as well as the point, and compare how the arrows and the contour lines change together.' },
    explain: {
      instruction: 'Explain in your own words how the gradient at a point is related to the contour lines and to the coefficients a, b and c.',
      prompt: 'How is the gradient at a point related to the contour line through that point, and how do a, b and c change the arrows?',
    },
    closed: { instruction: 'This activity is closed.' },
    freeExplore: { instruction: 'Explore freely: change a, b, c and the point, turn the 3D view, and compare the arrows, the contour lines and the cross-sections.' },
  },
  groups: {
    scene: { label: '3D surface view', description: 'The surface z = f(x, y) in three dimensions, with a camera you can turn and reset.' },
    contourView: { label: 'Contour view', description: 'The xy plane seen from above, with x to the right and y up, at equal scale on both axes.' },
    sectionViews: { label: 'Cross-section plots', description: 'Plots of f along the x-axis and along the y-axis.' },
    surface: { label: 'Surface samples', description: 'Heights of f on a 41 by 41 grid with spacing 0.1.' },
    contours: { label: 'Contour lines', description: 'Closed curves where f equals 0.25, 0.5, 1, 2 and 4.' },
    crossSections: { label: 'Cross-sections', description: 'f(x, 0) and f(0, y) at 81 points each, with their tables.' },
    point: { label: 'Selected point', description: 'The point p in the contour view and on the surface.' },
    surfaceValues: { label: 'Point values', description: 'The coordinates of p, the height f(p) and the Hessian determinant a·c − b², with the values panel and table.' },
    surfaceRules: { label: 'Surface rules', description: 'The definition of f, the condition on a, b and c, and the axis cross-sections in symbols.' },
    gradientRules: { label: 'Gradient rules', description: 'The definition of the gradient and of its direction in symbols.' },
    gradient: { label: 'Gradient values', description: 'The gradient at p, its length, its direction and the arrow length scale.' },
    gradientDrawing: { label: 'Gradient arrow', description: 'The arrow for the gradient at p in the contour view and on the surface.' },
    gradientValues: { label: 'Gradient with values', description: 'The gradient at p and its direction with the current values substituted.' },
    field: { label: 'Gradient field', description: 'Arrows for the gradient at 81 grid points, with their table and the stated arrow scale.' },
    minimum: { label: 'Lowest point', description: 'Where f is lowest and its value there, with a marker in the contour view.' },
    minimumValues: { label: 'Lowest point with values', description: 'The location and value of the lowest point substituted into a sentence.' },
    coefficientControls: { label: 'Coefficient controls', description: 'Sliders and exact entry for a, b and c.' },
    pointControls: { label: 'Point controls', description: 'Sliders, exact entry and dragging for the coordinates of p.' },
    scenarios: { label: 'Comparison settings', description: 'Preset coefficients and points to compare.' },
    alternatives: { label: 'Other ways to use this activity', description: 'Tables, text descriptions, a contour projection, exact entry and keyboard controls that stand in for the 3D view, the plots and the gestures.' },
  } satisfies Record<string, Copy>,
  views: {
    surface: {
      title: 'Surface',
      description: 'The surface z = f(x, y) for x and y from −2 to 2, drawn from a 41 by 41 grid of samples with spacing 0.1, with the point (p, f(p)) on it and, once shown, the gradient arrow in the horizontal plane at height f(p). The vertical axis has its own scale. Turning or resetting the view never changes the surface or the point.',
    },
    contour: {
      title: 'Contour view',
      description: 'The xy plane from above (x to the right, y up, equal scale) with the contour lines f = 0.25, 0.5, 1, 2 and 4, the point p and, once shown, the gradient arrow at p, the gradient field and the lowest point. Arrows are drawn at the stated scale; their directions are exact.',
    },
    sectionX: { title: 'Cross-section along the x-axis', description: 'f(x, 0) for x from −2 to 2, sampled at 81 points.' },
    sectionY: { title: 'Cross-section along the y-axis', description: 'f(0, y) for y from −2 to 2, sampled at 81 points.' },
    readouts: { title: 'Values', description: 'Values at the selected point. Values that are not shown yet are not listed.' },
    rules: { title: 'Rules', description: 'The surface, the condition on its coefficients, its cross-sections and, once shown, the gradient.' },
    valueTable: { title: 'Values table', description: 'The same values as the values panel, one per row.' },
    fieldTable: { title: 'Gradient field table', description: 'Each of the 81 grid points (x, y) with the gradient there.' },
    sectionXTable: { title: 'Cross-section along the x-axis: table', description: 'All 81 samples x and f(x, 0).' },
    sectionYTable: { title: 'Cross-section along the y-axis: table', description: 'All 81 samples y and f(0, y).' },
  } satisfies Record<string, { title: string; description: string }>,
  marks: {
    surface: 'Surface z = f(x, y)',
    pointOnSurface: 'Point (p, f(p)) on the surface',
    gradient3d: 'Gradient arrow at p in the plane z = f(p)',
    contours: 'Contour lines f = 0.25, 0.5, 1, 2 and 4',
    field: 'Gradient arrows at grid points',
    gradient2d: 'Gradient arrow at p',
    point2d: 'Selected point p',
    minimum: 'Lowest point of f',
    sectionX: 'f(x, 0)',
    sectionY: 'f(0, y)',
  },
  /** Labelled groups of related controls (report §10.2). */
  sections: { coefficients: { id: 'coefficients', label: 'Coefficients a, b and c' }, point: { id: 'point', label: 'Point p' } },
  controls: {
    a: { label: 'Coefficient a', description: 'How sharply f curves along the x-axis. Use the slider, the arrow keys or type an exact value.' },
    b: { label: 'Coefficient b', description: 'How strongly x and y are coupled; nonzero values tilt the contour lines. Values that would break a·c − b² > 0 are explained and not applied.' },
    c: { label: 'Coefficient c', description: 'How sharply f curves along the y-axis. Use the slider, the arrow keys or type an exact value.' },
    px: { label: 'Point x-coordinate', description: 'Horizontal position of p. Drag p in the contour view, use the arrow keys or type an exact value.' },
    py: { label: 'Point y-coordinate', description: 'Vertical position of p in the contour view. Drag p, use the arrow keys or type an exact value.' },
  } satisfies Record<string, Copy>,
  scenarioNote: 'Each comparison setting fixes a, b, c and the point p.',
  scenario: (a: number, b: number, c: number, x: number, y: number) => ({
    label: `a = ${a}, b = ${b}, c = ${c} at ${point(x, y)}`,
    description: `Coefficients a = ${a}, b = ${b} and c = ${c}, with the point ${point(x, y)}.`,
  }),
  alternatives: {
    withoutWebgl: {
      label: 'Without the 3D view',
      description: 'The activity can be completed without the 3D view, using the contour view, the cross-section plots, the values, the tables, exact entry and keyboard controls. This is a different representation of the same model, not the same spatial view.',
    },
    projectionGradient: {
      label: 'Contour view for the gradient',
      description: 'For the gradient at p, the contour view shows the same point and the same arrow seen from above, with the height f(p) and the gradient values listed alongside.',
    },
    projectionShape: {
      label: 'Contour view for the shape',
      description: 'For the shape of the surface, the contour lines show where f takes five values only; they do not show the surface between those levels as the 3D view does.',
    },
    equationValues: {
      label: 'Equation, coefficients and values',
      description: 'The equation for f with the current values of a, b and c fixes every contour line and cross-section exactly; with the contour levels, the point values and, once shown, the gradient formula and values, it carries the information drawn in the contour view and the cross-section plots.',
    },
    valueTable: { label: 'Values table', description: 'Lists p, f(p) and, once shown, the gradient at p, its length, its direction, the arrow scale and the lowest point.' },
    fieldTable: { label: 'Gradient field table', description: 'Lists each of the 81 grid points with the gradient there, once the field is shown.' },
    sectionTables: { label: 'Cross-section tables', description: 'List all 81 samples of each cross-section.' },
    textDescription: { label: 'Text description', description: 'A generated text summary of each view, built from the values currently shown. It summarises the views rather than listing every point.' },
    exactEntry: { label: 'Exact entry', description: 'Type exact values for a, b, c and the point instead of dragging. Values outside the allowed range, or with a·c − b² not greater than 0, are explained and are not changed into a different experiment.' },
    keyboard: { label: 'Keyboard controls', description: 'Arrow keys change each control by one step and move the point without dragging.' },
  } satisfies Record<string, Copy>,
});
