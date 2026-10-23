# Base rates

**Question:** If a part is flagged, how likely is it actually defective?

## Model

Let p be the defect rate, s = P(flagged | defective) the sensitivity, and f = P(flagged | nondefective) the false positive rate. For an expected population N, true positives are Nps and false positives are N(1−p)f. The flagged population is their sum. Therefore P(defective | flagged) = ps / [ps + (1−p)f].

When the denominator is zero, no part can be flagged. The conditional probability is **undefined**, with a reason; it is not zero. This distinction holds even when a rendered frequency diagram appears empty.

All probabilities accept the full interval [0,1]. N is an integer in [1, 1,000,000]. Counts are **expectations**, not random samples. They may be fractional. Any rounding in a displayed label is a presentation choice and must not change the calculation or table totals. The diagram is an aggregate representation, not a claim that every icon is one sampled part.

## How to explore

At the defaults, 90 truly defective parts and 495 nondefective parts are flagged, out of 10,000 expected parts. Compare the 90% sensitivity with the roughly 15.38% probability of a defect among flags. Increase prevalence while holding detector properties fixed. Select the flagged population to locate both groups that form the denominator.

The frequency view communicates relative groups; the exact table communicates totals and fractional values. The optional tree and equation explain conditioning. A factory example is used to avoid implying medical advice or performance of any actual detector.

## Checks and evidence

`fixtures.json` includes the supplied default counts and posterior, plus probability boundaries and the empty conditioning event. `checks.ts` evaluates reference cases through the browser worker. Repository tests check row and column totals, probability bounds, conditional direction, fractional counts, and a deliberately wrong denominator. Standard tolerance: atol = 1e-9, rtol = 1e-8.

**Independent subject review: not completed. Learner efficacy: not evaluated.** Passing the technical checks does not establish the performance of a real detector or a learning benefit.

## Source

[OpenStax, Principles of Data Science, §3.4 Probability Theory](https://openstax.org/books/principles-data-science/pages/3-4-probability-theory). All toolkit text and implementation are original.
