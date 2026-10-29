import type { CheckSuite } from '@explorable-models/core';

/** Fixed reference assertions; execution and value evaluation occur in the browser worker. */
export const checks: CheckSuite = {
  "id": "riemann-sums-reference",
  "version": "1.0.0",
  "author": "Explorable Models specification reference cases and transparent derived fixtures",
  "provenance": "reference",
  "cases": [
    {
      "id": "right-100",
      "label": "Right endpoint sum at n=100",
      "time": 0,
      "expected": {
        "sum.estimate": 0.33835,
        "sum.exact": 0.3333333333333333
      },
      "parameters": {
        "count": 100,
        "rule": "right"
      }
    },
    {
      "id": "midpoint-100",
      "label": "Midpoint sum at n=100",
      "time": 0,
      "expected": {
        "sum.estimate": 0.333325,
        "sum.exact": 0.3333333333333333
      },
      "parameters": {
        "count": 100,
        "rule": "midpoint"
      }
    },
    {
      "id": "signed",
      "label": "Signed integral cancels; unsigned area is one",
      "time": 0,
      "expected": {
        "sum.estimate": 0,
        "sum.exact": 0,
        "sum.unsignedEstimate": 1,
        "sum.unsignedExact": 1
      },
      "parameters": {
        "count": 100,
        "rule": "midpoint",
        "integrand": "signed"
      }
    }
  ]
};

export default checks;
