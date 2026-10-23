import type { CheckSuite } from '@experiment-kit/core';

/** Fixed reference assertions; execution and value evaluation occur in the browser worker. */
export const checks: CheckSuite = {
  "id": "base-rates-reference",
  "version": "1.0.0",
  "author": "Experiment Kit specification reference cases and transparent derived fixtures",
  "provenance": "reference",
  "cases": [
    {
      "id": "default",
      "label": "Default detector expected frequencies",
      "time": 0,
      "expected": {
        "count.defective": 100,
        "count.nondefective": 9900,
        "count.truePositive": 90,
        "count.falsePositive": 495,
        "count.falseNegative": 10,
        "count.trueNegative": 9405,
        "count.flagged": 585,
        "probability.posterior": 0.153846153846
      }
    },
    {
      "id": "zero-prevalence",
      "label": "No defective parts",
      "time": 0,
      "expected": {
        "probability.posterior": 0,
        "count.truePositive": 0,
        "count.falsePositive": 500
      },
      "parameters": {
        "prevalence": 0
      }
    },
    {
      "id": "all-defective",
      "label": "All parts defective",
      "time": 0,
      "expected": {
        "probability.posterior": 1,
        "count.falsePositive": 0,
        "count.truePositive": 9000
      },
      "parameters": {
        "prevalence": 1
      }
    },
    {
      "id": "perfect-specificity",
      "label": "No false positives",
      "time": 0,
      "expected": {
        "probability.posterior": 1,
        "count.falsePositive": 0
      },
      "parameters": {
        "falsePositiveRate": 0
      }
    },
    {
      "id": "zero-sensitivity",
      "label": "Zero sensitivity with some false positives",
      "time": 0,
      "expected": {
        "probability.posterior": 0,
        "count.truePositive": 0
      },
      "parameters": {
        "sensitivity": 0
      }
    },
    {
      "id": "no-flags",
      "label": "No flags means undefined posterior",
      "time": 0,
      "expected": {
        "probability.posterior": null,
        "count.flagged": 0
      },
      "parameters": {
        "sensitivity": 0,
        "falsePositiveRate": 0
      },
      "statuses": {
        "probability.posterior": "undefined"
      }
    },
    {
      "id": "fractional",
      "label": "Expected counts remain fractional",
      "time": 0,
      "expected": {
        "count.defective": 3.333,
        "count.truePositive": 2.3331,
        "count.falsePositive": 1.3334,
        "count.flagged": 3.6665
      },
      "parameters": {
        "population": 10,
        "prevalence": 0.3333,
        "sensitivity": 0.7,
        "falsePositiveRate": 0.2
      }
    }
  ]
};

export default checks;
