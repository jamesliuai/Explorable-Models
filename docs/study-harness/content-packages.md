# Content packages

Five installed activity packages ship through `@explorable-models/catalog`. Each package contains a pure kernel, a
model manifest, an activity template with learner copy, accessible alternatives, boundary cases, an independent
oracle and reference fixtures outside the catalogue, representation and restore tests, capture examples and a
subject-review packet under `docs/study-harness/review-packets/<id>/`. None has independent human subject review;
the highest lifecycle status they can reach in this repository is `reference-checked`.

| Package | Kernel / mode | Model domain and conventions | Key undefined/boundary states |
| --- | --- | --- | --- |
| `quadratic-gradient-descent` | discrete, `maxIndex` 1000 | f(x)=a·x²/2, a∈[0.1,10], η∈[0,2], x₀∈[−10,10], constraint η·a ≤ 4 | zero start exact at any index; η·a=1 one-step; η·a=2 oscillation; overflow → numerical limit with last finite index; underflow approximation |
| `function-derivative` | static | f(x)=A·x²+B·x+C on x∈[−5,5]; probe p; secant offset h with p+h∈[−5,5] (coupled constraint) | h=0 secant undefined (never relabelled as the derivative); linear/constant degeneracies; vertex undefined when A=0 |
| `linear-transformation` | static | 2×2 matrix, column-vector convention (M·e₁ is the first column), entries ∈[−3,3], test vector ∈[−3,3]² | det sign → orientation; area = |det|; rank 0/1/2 collapse; real eigen-directions only when they exist (complex → none; scalar → all directions; defective → one) |
| `vector-orientation-3d` | static | u, v ∈[−3,3]³, dimensionless, right-handed frame, angle in radians (degree display) | zero vector → angle and direction undefined; parallel/antiparallel → zero cross product has no direction |
| `quadratic-surface-gradient` | static | f(x,y)=(a·x²+2b·x·y+c·y²)/2 with a>0, c>0, a·c−b²>0 (positive-definite constraint); point (x,y)∈[−2,2]² | gradient zero at the minimum (origin); analytic contour ellipses; sampled surface 41×41; bounded gradient field with disclosed scale |

None of the five packages draws observed data. The observed-data path of report §8.5 (manifest observation datasets,
`observations2` geometry drawn as unconnected points, missing cells with reasons, provenance, observed/model labels;
authoring.md §13) is exercised by the example package `examples/study-harness-observed/`: a constant-gravity
prediction beside illustrative recorded heights. It is example content, not installed, not reviewed, and its values
are not a measurement.

Learner copy that states sampling resolution (the 401 samples and every-third table rows of `function-derivative`, the
41 × 41 surface grid with spacing 0.1, 81-point cross-sections and 81-point gradient field of
`quadratic-surface-gradient`) is checked against the kernel constants, the frames' `sampling` metadata and the
projected table shortening by `tests/catalog/sampling-copy.test.ts`; manifest descriptions derive their counts from
the same constants.

Reference oracles under `tests/reference/oracles/` are written independently of catalogue code (exact rational
arithmetic where possible; otherwise independent analytic formulas with declared tolerances). Each package's
reference test (`tests/reference/activities/<id>.test.ts`) compares each reported quantity (every quantity in at least
one case) and the parameter-only geometry shown before any reveal with its fixture or oracle, and runs
activity-specific mutants, each of which must fail named cases. Every package has mutants for wrong signs, wrong
factors, incorrect boundaries and hidden-output leakage into its parameter-only channels; unit and transposition
mutants exist where the package has a unit or an ordered pair that can be confused:

| Package | Unit mutants | Transposition mutants |
| --- | --- | --- |
| `quadratic-gradient-descent` | none applicable (dimensionless; an off-by-one iteration index instead) | none applicable (η and a have different domains and roles) |
| `function-derivative` | offset read in hundredths of a unit | coefficients A and B exchanged |
| `linear-transformation` | none applicable (dimensionless) | rows used as the images of e₁ and e₂ |
| `vector-orientation-3d` | angle in degrees under the radian unit | cross-product and projection components exchanged |
| `quadratic-surface-gradient` | none applicable (dimensionless) | x and y exchanged in the gradient |

The quadratic test also checks boundary neighbours that the fixture file does not list (η = 0 and 5e-324, x0 = ±0
and ±5e-324, and every declared bound and the coupled bound η·a ≤ 4 at the bound and at the next double beyond it),
with mutants that move those boundaries. The generic mutants of a review packet (sign, factor, unit slip,
transposition of square matrices, undefined or limit reported as zero, swapped inputs, boundary nudges) cover only
quantities with an expectation in the converted suite; `mutation.uncovered` in each packet lists the others. It is
empty for `quadratic-gradient-descent` (start.position, start.loss and product are restated from each case; the
packet states how), `function-derivative` and `vector-orientation-3d`; for `linear-transformation` (basis.e1, basis.e2,
vector.v) and `quadratic-surface-gradient` (point, minimum.location, minimum.value) those quantities are checked by the
package's reference test instead.
