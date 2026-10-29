/**
 * Learner-facing copy for the linear-transformation activity. Neutral and descriptive: it states the column-vector
 * convention, names what is shown and what to do, never claims understanding or mastery, and contains no answers,
 * rubrics or scoring. All of it is part of the template digest and of the content digest of the group that shows it.
 */
export const LINEAR_COPY = Object.freeze({
  title: 'Matrices as transformations of the plane',
  /** Labelled groups of related controls (report §10.2). */
  sections: { matrix: { id: 'matrix', label: 'Matrix M' }, vector: { id: 'test-vector', label: 'Test vector v' } },
  purpose: 'Predict, then observe, how a 2×2 matrix M moves the plane: where e₁ and e₂ land (the columns of M), whether orientation is kept or reversed, how areas scale, whether the plane collapses, and which directions stay on their own line.',
  convention: 'Vectors are columns and M acts by M·v. The first column of M is M·e₁, where e₁ = (1, 0) lands; the second column is M·e₂, where e₂ = (0, 1) lands.',
  stages: {
    prepare: {
      instruction: 'Vectors are columns and M acts by M·v. The first column of M is where e₁ = (1, 0) lands and the second column is where e₂ = (0, 1) lands. The grid, the unit square, e₁, e₂, their images and the test vector v are shown; the transformed plane is not shown yet.',
    },
    predict: {
      instruction: 'The arrows Me₁ and Me₂ are the columns of the matrix shown. Before the transformed plane is shown, predict what M does to the whole plane.',
      prompt: 'For this matrix, will M keep the counterclockwise order of e₁ and e₂, reverse it, or flatten the plane onto a line or a point? Which directions through the origin, if any, will M map onto their own line?',
    },
    explore: { instruction: 'Change the matrix entries or type exact values, and watch the transformed grid, the image of the unit square, Mv, the determinant and the area scale. Compare what you see with your prediction.' },
    exploreEigen: { instruction: 'Now look for directions that M maps onto their own line through the origin. Compare matrices with two such directions, exactly one, every direction, and none.' },
    explain: {
      instruction: 'Explain in your own words how the matrix entries determine orientation, area, collapse and the unchanged directions.',
      prompt: 'How do the columns of M and its determinant tell you whether orientation is kept or reversed, how areas scale and whether the plane collapses? When does a matrix have no real unchanged direction, exactly one, or every direction?',
    },
    closed: { instruction: 'This activity is closed.' },
    freeExplore: { instruction: 'Explore freely: change the matrix and the test vector, try the scenarios, and compare the determinant, the area scale and the unchanged directions.' },
  },
  groups: {
    plane: { label: 'The plane', description: 'Scene of the plane from −8 to 8 on both axes, with equal scales.' },
    reference: { label: 'Reference grid and unit square', description: 'The grid lines x = k and y = k for k = −3 to 3 and the unit square, before the transformation.' },
    basis: { label: 'Basis vectors', description: 'The basis vectors e₁ = (1, 0) and e₂ = (0, 1) before the transformation.' },
    columns: { label: 'Columns of M', description: 'The images Me₁ and Me₂ of the basis vectors, which are the first and second columns of M.' },
    testVector: { label: 'Test vector', description: 'The test vector v before the transformation.' },
    matrixControl: { label: 'Matrix entries', description: 'Sliders and exact entry for the four entries of M, listed by row and column.' },
    vectorControl: { label: 'Test vector entries', description: 'Sliders and exact entry for the components of v.' },
    convention: { label: 'Column convention', description: 'How the columns of M and the product Mv are formed.' },
    readouts: { label: 'Values and vectors', description: 'Panels listing the values and vector coordinates that are currently shown.' },
    transformed: { label: 'Transformed plane', description: 'The image of the grid and of the unit square under M, with a table of the transformed grid lines.' },
    imageVector: { label: 'Image of the test vector', description: 'The vector Mv.' },
    determinant: { label: 'Determinant and area', description: 'The determinant of M, the area scale |det M| and the orientation.' },
    collapse: { label: 'Rank and collapse', description: 'The rank of M and, when the plane collapses onto a line, the direction of that line.' },
    determinantRule: { label: 'Determinant rule', description: 'The determinant and area-scale rules in symbols.' },
    determinantValues: { label: 'Determinant with values', description: 'The determinant and the area scale with the current values substituted.' },
    eigen: { label: 'Unchanged directions', description: 'The eigenvalue category, the real eigenvalues, the unit directions that M maps onto their own line, the trace and the discriminant.' },
    eigenLines: { label: 'Unchanged-direction lines', description: 'Lines through the origin along each real unchanged direction.' },
    eigenRule: { label: 'Eigen rule', description: 'The eigenvalue equation and the characteristic equation in symbols.' },
    eigenValues: { label: 'Characteristic equation with values', description: 'The characteristic equation and its discriminant with the current values substituted.' },
    scenarios: { label: 'Example matrices', description: 'Matrices to compare: identity, rotations, a shear, reflections, a collapse, the zero matrix and a zero test vector.' },
    alternatives: { label: 'Other ways to use this activity', description: 'Tables, text descriptions, exact entry and keyboard controls that stand in for the scene and the sliders.' },
  },
  scenarioNote: 'Each example sets all four matrix entries and the test vector. Rotation entries are the nearest stored values of cos and sin.',
  scenarios: {
    identity: { label: 'Identity', description: 'M = I: columns (1, 0) and (0, 1).' },
    rotation30: { label: 'Rotation by 30°', description: 'Counterclockwise rotation by 30°: columns (cos 30°, sin 30°) and (−sin 30°, cos 30°).' },
    rotation120: { label: 'Rotation by 120°', description: 'Counterclockwise rotation by 120°: columns (cos 120°, sin 120°) and (−sin 120°, cos 120°).' },
    shear: { label: 'Shear', description: 'Horizontal shear: columns (1, 0) and (1.5, 1).' },
    reflectionDiagonal: { label: 'Reflection across y = x', description: 'Swaps the coordinates: columns (0, 1) and (1, 0).' },
    reflectionAxis: { label: 'Reflection across the x-axis', description: 'Columns (1, 0) and (0, −1).' },
    collapse: { label: 'Collapse onto a line', description: 'Parallel columns (0.5, 1) and (1, 2).' },
    zero: { label: 'Zero matrix', description: 'All four entries are 0.' },
    zeroVector: { label: 'Zero test vector', description: 'Columns (2, 1) and (−1, 0.5) with the test vector v = (0, 0).' },
  },
  alternatives: {
    vectorTable: { label: 'Vector table', description: 'Lists the coordinates of every vector drawn on the plane that is currently shown: e₁, e₂, Me₁, Me₂, v and, once shown, Mv, the collapse direction and the unchanged directions. A vector whose value is undefined is listed with its reason.' },
    gridTable: { label: 'Grid and square coordinates', description: 'Describes the grid and the unit square exactly: the original grid is the lines x = k and y = k for k = −3 to 3, and the unit square has corners (0, 0), (1, 0), (1, 1), (0, 1). Once shown, the transformed grid table lists both endpoints of every transformed grid line, and the image of the unit square has corners 0, Me₁, Me₁ + Me₂ and Me₂ from the vector table.' },
    textDescription: { label: 'Text description', description: 'A generated text summary of the scene, built from the values currently shown. It summarises the scene rather than listing every line.' },
    exactEntry: { label: 'Exact entry', description: 'Type exact values for the four matrix entries and the two test-vector components instead of dragging. Values outside −3 to 3 are explained and are not changed into a different experiment.' },
    keyboard: { label: 'Keyboard controls', description: 'Arrow keys change each entry by one step without dragging, and every example matrix can be chosen from the keyboard.' },
  },
});
