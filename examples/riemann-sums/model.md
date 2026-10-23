# Riemann sums

**Question:** How does a finite sum approach an integral?

This extension benchmark uses the ordinary parametric contract without changing the runtime. It sums equal-width rectangles with right-endpoint or midpoint samples, either for x² on [0,1] or for x on [−1,1]. The implementation evaluates and accumulates the rectangles; the independent fixtures use closed forms.

For n rectangles, the right sum for x² is 1/3 + 1/(2n) + 1/(6n²), and the midpoint sum is 1/3 − 1/(12n²). At n=100 these are 0.33835 and 0.333325. The signed integral of x on [−1,1] is zero, whereas its unsigned area is one. The model exposes both, so cancellation cannot be confused with an empty region.

Supported counts are integers 1–200. Values are dimensionless. This is not an arbitrary integrand parser or a proof of convergence for other functions. The rectangle geometry is a bounded list of four corners per rectangle; the curve is a 101-point polyline. Interpretation and exact values are available numerically without the plot.

`checks.ts` and `fixtures.json` record reference values; repository tests check estimates against the independent finite-sum formulas at multiple counts. **Independent subject review: not completed. Learner efficacy: not evaluated.** This demonstrates API extensibility; it does not claim a fresh external agent completed a held-out benchmark.

Source: [OpenStax, Calculus Volume 2, §1.2 The Definite Integral](https://openstax.org/books/calculus-volume-2/pages/1-2-the-definite-integral). Original implementation and explanatory text.
