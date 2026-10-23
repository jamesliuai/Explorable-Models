import type { CheckSuite } from '@experiment-kit/core';

/** Fixed reference assertions; execution and value evaluation occur in the browser worker. */
export const checks: CheckSuite = {
  "id": "rolling-reference",
  "version": "1.0.0",
  "author": "Experiment Kit specification reference cases and transparent derived fixtures",
  "provenance": "reference",
  "cases": [
    {
      "id": "sphere-one-second",
      "label": "Default solid sphere at one second",
      "time": 1,
      "expected": {
        "body.acceleration": 3.503571428571,
        "body.distance": 1.751785714286,
        "body.speed": 3.503571428571,
        "body.angularSpeed": 17.517857142857,
        "body.rotation": -8.758928571429,
        "force.friction": 1.401428571429,
        "force.normal": 8.495709211125,
        "force.minCoefficient": 0.164957219768,
        "event.arrivalTime": 1.511087125792
      }
    },
    {
      "id": "release",
      "label": "Release from rest",
      "time": 0,
      "expected": {
        "body.distance": 0,
        "body.speed": 0,
        "body.rotation": 0,
        "energy.translational": 0,
        "energy.rotational": 0,
        "energy.total": 19.62
      }
    },
    {
      "id": "sphere-arrival",
      "label": "Sphere immediately before the exact arrival event",
      "time": 1.5110871257915,
      "expected": {
        "body.distance": 4,
        "body.speed": 5.294201680005,
        "body.rotation": -20,
        "energy.total": 19.62
      }
    },
    {
      "id": "horizontal",
      "label": "A horizontal incline has no finite arrival",
      "time": 10,
      "expected": {
        "body.acceleration": 0,
        "body.speed": 0,
        "body.distance": 0,
        "event.arrivalTime": null
      },
      "parameters": {
        "incline": 0
      },
      "statuses": {
        "event.arrivalTime": "undefined"
      }
    },
    {
      "id": "double-mass",
      "label": "Doubling mass leaves acceleration unchanged",
      "time": 1,
      "expected": {
        "body.acceleration": 3.503571428571,
        "force.friction": 2.802857142857,
        "energy.total": 39.24
      },
      "parameters": {
        "mass": 2
      }
    },
    {
      "id": "double-radius",
      "label": "Doubling radius halves angular speed",
      "time": 1,
      "expected": {
        "body.acceleration": 3.503571428571,
        "body.speed": 3.503571428571,
        "body.angularSpeed": 8.758928571429,
        "body.rotation": -4.379464285714
      },
      "parameters": {
        "radius": 0.4
      }
    },
    {
      "id": "hoop",
      "label": "Hoop at one second",
      "time": 1,
      "expected": {
        "body.kappa": 1,
        "body.acceleration": 2.4525,
        "body.distance": 1.22625
      },
      "parameters": {
        "bodyType": "hoop"
      }
    },
    {
      "id": "cylinder",
      "label": "Solid cylinder at one second",
      "time": 1,
      "expected": {
        "body.kappa": 0.5,
        "body.acceleration": 3.27,
        "body.distance": 1.635
      },
      "parameters": {
        "bodyType": "cylinder"
      }
    },
    {
      "id": "shell",
      "label": "Thin spherical shell at one second",
      "time": 1,
      "expected": {
        "body.kappa": 0.6666666666666666,
        "body.acceleration": 2.943,
        "body.distance": 1.4715
      },
      "parameters": {
        "bodyType": "shell"
      }
    }
  ]
};

export default checks;
