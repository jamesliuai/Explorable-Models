/**
 * Learner-facing copy for the spatial vector-orientation activity. Neutral and descriptive: it names what is shown and
 * what to do, never claims understanding or mastery, and contains no answers, rubrics or scoring. Scenario labels
 * describe their inputs only, never the relationship they produce. All of it is part of the template digest and of
 * the content digest of the group that displays it.
 */
export const VECTOR_ORIENTATION_COPY = Object.freeze({
  title: 'Two vectors in space',
  purpose: 'Predict, then observe, how the directions of two vectors u and v in a right-handed 3D frame determine the angle between them, their dot product and their cross product.',
  stages: {
    orient: { instruction: 'Get oriented: turn the 3D view or use the orientation presets, find the positive x, y and z axes, and compare the view with the three flat projections.' },
    predict: {
      instruction: 'Before any angle or product is shown, look at u and v in space and in the projections, and predict how they are related.',
      prompt: 'Is the angle between u and v acute, a right angle or obtuse? What sign do you expect for u·v, and which way do you expect u × v to point?',
    },
    exploreAngle: { instruction: 'Change the components of u and v and watch the angle θ, the dot product u·v and the relationship. Compare what you see with your prediction.' },
    exploreCross: { instruction: 'Once the cross product u × v is shown as well, change u and v, swap their order and compare its direction and length with the angle between them.' },
    explain: {
      instruction: 'Explain in your own words how the directions of u and v determine the angle, the dot product and the cross product.',
      prompt: 'How do the directions of u and v determine the sign of u·v, the size of θ and the direction and length of u × v?',
    },
    closed: { instruction: 'This activity is closed.' },
    freeExplore: { instruction: 'Explore freely: change both vectors, use the scenarios, turn the 3D view and compare the projections and values.' },
  },
  groups: {
    space: { label: '3D view', description: 'The vectors u and v drawn from the origin in a right-handed x, y, z frame, with orientation presets.' },
    projections: { label: 'Projections', description: 'Three flat views of the same vectors projected onto the xy, xz and yz planes.' },
    vectors: { label: 'Vector drawings', description: 'The segments for u and v in the 3D view and in each projection.' },
    components: { label: 'Coordinates', description: 'The components of u and v and of their projections, with the values and coordinate tables.' },
    lengths: { label: 'Lengths', description: 'The lengths |u| and |v|.' },
    controlsU: { label: 'Components of u', description: 'Sliders and exact entry for u_x, u_y and u_z.' },
    controlsV: { label: 'Components of v', description: 'Sliders and exact entry for v_x, v_y and v_z.' },
    angleDot: { label: 'Angle and dot product', description: 'The dot product u·v, the angle θ between u and v, and their relationship.' },
    angleArc: { label: 'Angle arc', description: 'An arc in the plane of u and v marking the angle θ in the 3D view.' },
    dotRules: { label: 'Dot product and angle rules', description: 'The definitions of the dot product and of the angle in symbols.' },
    dotValues: { label: 'Dot product and angle values', description: 'The current values of u·v and θ written into equations.' },
    cross: { label: 'Cross product', description: 'The cross product u × v, its length and its unit direction.' },
    crossDrawing: { label: 'Cross product drawing', description: 'The cross product u × v drawn at true scale from the origin in the 3D view.' },
    crossRules: { label: 'Cross product rules', description: 'The definition of u × v, its length rule and the right-hand rule for the axes.' },
    crossValues: { label: 'Cross product values', description: 'The current values of u × v, its length and its direction written into equations.' },
    scenarios: { label: 'Vector pairs', description: 'Preset pairs of vectors, each named by its components.' },
    alternatives: { label: 'Other ways to use this activity', description: 'Projections, tables, text descriptions, exact entry and keyboard controls that stand in for the 3D view and for dragging.' },
  },
  views: {
    space: {
      title: '3D view',
      description: 'u and v drawn from the origin in a right-handed frame (x × y = z), within −4 to 4 on each axis. Orientation presets: isometric, front (xz), top (xy), side (yz). Once shown, an arc marks the angle θ, u × v is drawn at true scale (it can extend past the box) and its direction is drawn with length 1. A zero vector is not drawn.',
    },
    planeXY: { title: 'Top view: xy plane', description: 'u and v projected onto the xy plane, seen from +z: x to the right, y up, z toward you. A vector along z projects to a point and is not drawn.' },
    planeXZ: { title: 'Front view: xz plane', description: 'u and v projected onto the xz plane, seen from −y: x to the right, z up, y away from you. A vector along y projects to a point and is not drawn.' },
    planeYZ: { title: 'Side view: yz plane', description: 'u and v projected onto the yz plane, seen from +x: y to the right, z up, x toward you. A vector along x projects to a point and is not drawn.' },
    readouts: { title: 'Values', description: 'Lengths and, once shown, the dot product, angle, relationship and length of u × v. Values that are not shown yet are not listed.' },
    vectorTable: { title: 'Vector table', description: 'Components x, y and z of u and v and, once shown, of u × v and its unit direction.' },
    projectionTable: { title: 'Projection table', description: 'The two components of u and v in each projection plane.' },
    rules: { title: 'Rules', description: 'Definitions of the dot product, the angle and the cross product, and their current values once shown.' },
  },
  marks: {
    vectors: 'Vectors u and v from the origin, each labelled with its name',
    angleArc: 'Arc marking the angle θ between u and v',
    crossSegment: 'Cross product u × v at true scale',
    crossDirection: 'Direction of u × v (length 1, not to scale)',
    projection: (plane: string) => `u and v projected onto the ${plane} plane, each labelled with its name`,
  },
  /** Labelled groups of related controls (report §10.2). */
  sections: { u: { id: 'vector-u', label: 'Vector u' }, v: { id: 'vector-v', label: 'Vector v' } },
  controls: {
    component: (vector: string, axis: string) => ({
      label: `${axis} component of ${vector}`,
      description: `The ${axis} component of ${vector}. Use the slider, the arrow keys or type an exact value from −3 to 3.`,
    }),
  },
  scenarioNote: 'Preset pairs of vectors, named by their components, for comparing different orientations.',
  scenarios: {
    'basis-x-y': { label: 'u = e_x, v = e_y', description: 'u = (1, 0, 0) and v = (0, 1, 0).' },
    'basis-y-x': { label: 'u = e_y, v = e_x', description: 'u = (0, 1, 0) and v = (1, 0, 0): the same vectors in the other order.' },
    'pair-a': { label: 'u = (1, 2, 2), v = (1.5, 3, 3)', description: 'u = (1, 2, 2) and v = (1.5, 3, 3).' },
    'pair-b': { label: 'u = (1, 2, 2), v = (−1.5, −3, −3)', description: 'u = (1, 2, 2) and v = (−1.5, −3, −3).' },
    'pair-c': { label: 'u = (1, 2, 2), v = (2, 1, −2)', description: 'u = (1, 2, 2) and v = (2, 1, −2).' },
    'pair-d': { label: 'u = (2, 1, 0), v = (1, 2, 2)', description: 'u = (2, 1, 0) and v = (1, 2, 2), the starting pair.' },
    'pair-e': { label: 'u = (0, 0, 0), v = (1, 2, 2)', description: 'u is the zero vector and v = (1, 2, 2).' },
  },
  alternatives: {
    withoutWebgl: {
      label: 'Activity without the 3D view',
      description: 'A different way to do the same tasks without the 3D view: the three projections, the vector and projection tables, the values and exact entry together carry every quantity drawn in the 3D view. It is not the same spatial experience; judging orientation in space from projections and numbers takes more steps. Tested equivalence: completing the predict, explore and explain stages without WebGL.',
    },
    projections: {
      label: 'Flat projections',
      description: 'Three flat views of the vectors. Each projection drops one coordinate, so a single projection can make vectors look parallel, orthogonal or shorter than they are in space; spatial understanding may need the 3D view or all three projections read together with the values.',
    },
    projectionTable: { label: 'Projection table', description: 'Lists the two components of u and v in each plane; each projection plot draws exactly these components from the origin.' },
    textDescription: { label: 'Text description', description: 'A generated text summary of each view, built from the values currently shown. It summarises the views rather than reproducing them.' },
    exactEntry: { label: 'Exact entry', description: 'Type exact values for the six components instead of dragging. Values outside −3 to 3 are explained and are not changed into a different pair of vectors.' },
    keyboard: { label: 'Keyboard controls', description: 'Arrow keys change each component by one step. In the 3D view, the orientation preset buttons and bounded arrow-key rotation turn the camera without dragging; turning the camera never changes the vectors.' },
  },
});
