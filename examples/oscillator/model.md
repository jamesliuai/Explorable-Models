# Analytical oscillator

**Question:** Where does the energy go as a spring oscillates?

An ideal mass m on a linear spring k is released from rest at displacement A. Angular frequency is ω = √(k/m), position is A cos(ωt), velocity is −Aω sin(ωt), and acceleration is −ω²x. There is no damping or forcing. Spring potential energy is kx²/2 and kinetic energy is mv²/2. Their sum is constant.

This is a closed-form analytical model, **not** a stateful numerical solver. The observation ends after the selected integer number of periods; the oscillator has not physically stopped. All values are SI. Amplitude spans 0–3 m, mass 0.1–10 kg, stiffness 0.1–20 N/m, and observation length 1–10 periods.

At default parameters ω=2 rad/s and period π seconds. Quarter-period position is zero and velocity is −2 m/s; half-period position is −1 m and velocity is zero. These phase checks catch errors that energy conservation alone would miss.

`checks.ts` evaluates reference fixtures in the same browser worker path as playback. The repository suite checks phase, energy, parameter scaling, and the zero-amplitude limit. **Independent subject review: not completed. Learner efficacy: not evaluated.** This extension demonstrates the unchanged API; it is not evidence of an external agent's held-out task performance.

Source: [OpenStax, University Physics Volume 1, §15.1 Simple Harmonic Motion](https://openstax.org/books/university-physics-volume-1/pages/15-1-simple-harmonic-motion). Original implementation and explanatory text.
