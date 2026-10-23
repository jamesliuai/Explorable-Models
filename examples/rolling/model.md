# Rolling bodies

**Question:** Why does a solid sphere reach the bottom before a hoop?

## Model

A rigid body is released from rest on a straight fixed incline. Static friction is sufficient for rolling without slipping. Gravity is 9.81 m/s². Drag, deformation, rolling resistance, and impacts are omitted. This is an ideal comparison of mass distributions, not a general rolling predictor.

Write the moment of inertia as I = κmR². A solid sphere has κ = 2/5, a thin spherical shell 2/3, a solid cylinder 1/2, and a hoop 1. Force and torque balance give a = g sin(θ)/(1 + κ). Thus s = at²/2, v = at, angular speed = v/R, and accumulated signed rotation = −s/R. Static friction has magnitude κma and points uphill in this release-from-rest setup. Its required coefficient is κ tan(θ)/(1 + κ).

## Coordinates, units, and valid domain

All physical values are SI; angles are radians, converted to degrees only by the control display. World X points right, Y up, and Z out of the side view. The downhill tangent is (cos θ, −sin θ, 0); the outward normal is (sin θ, cos θ, 0). The center is one radius above the contact path. Clockwise rotation is negative about positive Z. Speed is a nonnegative magnitude, distinct from the signed angular-velocity vector.

Supported inputs: θ ∈ [0, π/4], mass ∈ [0.1, 10] kg, radius ∈ [0.05, 0.5] m, and travel length ∈ [1, 8] m. Time starts at zero and ends at √(2L/a). At zero incline there is no finite arrival event; the body stays at rest. The end frame retains the physical nonzero terminal speed. A paused boundary is the limit of the model, not a collision or energy loss.

Potential energy is measured relative to the final center height. It decreases by mgs sin θ, matching the sum of translational kinetic energy mv²/2 and rotational kinetic energy Iω²/2. The constant radius offset cancels from this potential-energy difference.

## How to explore

Predict which body arrives first. Keep incline, mass, radius, and travel matched while changing body type. The energy representation shows why a larger κ leaves a smaller fraction for translation. Double mass and then radius: acceleration remains unchanged, although energy and angular speed change. Inspect the force vector to distinguish uphill friction from downhill motion.

The marked 2D body exposes signed rotation. The orbitable 3D representation conveys mass distribution. Both must use the same registered position and angle. A current-values table provides an equivalent numerical path.

## Checks and evidence

`fixtures.json` records reference values supplied by the project specification, including the one-second sphere case and exact arrival. `checks.ts` runs numerical reference assertions through the model worker. The repository reference suite additionally checks mass/radius invariance, body ordering, energy and force balance, contact-point velocity, no-slip orientation, horizontal incline, and terminal velocity. Tolerances are atol = 1e-9 in the declared unit and rtol = 1e-8 unless a case says otherwise.

Technical checks are distinct from subject review. **Independent subject review: not completed. Learner efficacy: not evaluated.** The original implementation and fixtures are transparent for review; passing cases do not certify all explanations or real-world applicability.

## Source

[OpenStax, University Physics Volume 1, §11.1 Rolling Motion](https://openstax.org/books/university-physics-volume-1/pages/11-1-rolling-motion). Consulted for the standard rolling relations; all toolkit text and implementation are original.
