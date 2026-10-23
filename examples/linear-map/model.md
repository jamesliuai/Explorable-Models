# Linear transformations

**Question:** How does a matrix change shape, area, and orientation?

## Model

A = [[a, b], [c, d]] acts on column vectors: (x, y) maps to (ax + by, cx + dy). Storage is row-major [a, b, c, d]. The visible transformed basis vectors are the columns (a, c) and (b, d). The unit square becomes the parallelogram with corners (0,0), (a,c), (a+b,c+d), and (b,d).

The determinant ad − bc is the signed area scale. Its absolute value is the nonnegative geometric area scale. A negative determinant reverses orientation; zero collapses the square into a line or point. Values are dimensionless Cartesian coordinates. Matrix entries and input coordinates range from −3 to 3. This parametric model has no advancing clock.

No eigenvector layer or eigenvector claim is included. In particular, a 90° rotation has no nonzero real eigenvector. A tiny nonzero determinant remains nonzero in the numerical output; the display must not conceal that distinction by declaring it exactly singular.

## How to explore

Start with a shear, then try identity, scaling, reflection, rotation, and a singular map. Predict where (1,1) goes. Move the input using the diagram or exact x/y controls; its linked output and values come from the same frame. Compare a reflection's negative signed determinant with its positive geometric area.

## Checks and evidence

`fixtures.json` contains externally specified reference cases and additional nonaxis points that distinguish row-major storage from a transposed mapping. `checks.ts` evaluates these cases in the browser worker. Repository tests also verify corner geometry, basis columns, determinant sign, and linearity. Standard tolerance: atol = 1e-9, rtol = 1e-8.

**Independent subject review: not completed. Learner efficacy: not evaluated.** These are explicit technical checks, not an independent certification.

## Source

[MIT OpenCourseWare, Area, Volume and the Determinant in Two and Three Dimensions](https://ocw.mit.edu/ans7870/18/18.013a/textbook/HTML/chapter04/section01.html). All toolkit text and implementation are original.
