# Player design

The full primary-screen concept is retained outside the source tree at the task's visualization path, `experiment-kit-concept.png`. It sets the player composition; the diagrams themselves are semantic SVG and Three.js views computed from model frames.

White background, cool gray diagram surface, navy text, blue primary quantity and teal comparison. Header 64px; navigation rail 228px; content gutter 28px. A two-thirds scene and one-third controls layout collapses to a single column below 1000px. Inter typography; 32px/1.2 heading, 14px body, 12–13px labels. Hairline borders, 5–8px radii, visible blue focus rings, restrained 18px outline icons.

Primary copy: Explorable Models; Experiments; Authoring guide; Export; Rolling bodies; Linear transformations; Base rates; Saved runs; Model & checks; Same ramp. Different motion.; Why does a sphere reach the bottom before a hoop?; Save state; Experiment; 2D; 3D; Play; Step; Reset; Set up the experiment; Body type; Ramp angle; Advanced parameters; At this moment; Where the energy goes; Speed over time; Ideal rolling without slipping; View assumptions.

Required scientific corrections to the visual concept: the supported angle is 0–45°, the sphere must travel farther than the hoop at equal time, the speed traces are straight until the terminal event, and rotation is signed and calculated from distance/radius. The initial state is released from rest. Time, numbers, and graph positions therefore intentionally differ from the illustrative mockup.

Saved runs, model/check inspector, authoring guide, export dialog, and nonvisual tables extend the same component system. All controls must perform real operations; no remote fonts or imagery are required for playback.

## Final visual review

The generated concept and the rendered 1536 × 1024 desktop capture were inspected together with `view_image`. Additional Chromium captures covered 390 px mobile layouts, 1024/1440 px browser checks, the exact rolling endpoint, horizontal and steep ramps, extreme body sizes and force vectors, and singular/extreme matrix maps. The built-in browser was used for interactive inspection; the installed Browser plugin was unavailable, so automated flows used the pinned Playwright Chromium runtime.

| Comparison | Concept and rendered evidence | Resolution |
| --- | --- | --- |
| Composition | White header and navigation rail; dominant pale-blue scene; right controls; two linked panels below | Preserved. Desktop scene height fixed at 390 px so the linked panels remain visible. |
| Typography | Navy heading, Inter UI text, quieter labels, blue primary values | Preserved; labels rendered in measured SVG coordinates so mobile text remains 11–12 px instead of shrinking with the entire drawing. |
| Palette and surfaces | White page, cool scene, blue primary body, teal comparison, hairline borders | Preserved; muted copy and teal bars darkened for contrast. |
| Geometry and motion | Concept shows an illustrative ramp with inconsistent angle, ordering, and speed curve | Corrected: isotropic physical axes, sphere ahead at equal time, signed rotation, straight speed traces, exact terminal events. The physically correct 30° ramp occupies less horizontal width than the illustrative concept. |
| Spacing and controls | Scene toolbar, transport row, exact value inputs, right-side setup | Preserved with added working force/comparison toggles and playback-rate control. Focus rings now appear only on interactive elements. |
| Labels and icons | Small outline icons and labelled bodies/axes | Consistent Lucide outline family. Body callouts and matrix labels reposition to prevent collisions; tiny bodies use an explicitly magnified rotation inset. |
| Responsive behavior | Desktop is the primary concept | Mobile stacks the scene, linked views, and controls, with a compact navigation drawer. Matrix and rolling marks remain readable without horizontal overflow. |
| 3D endpoint framing | The mobile 3D camera initially looked toward the origin and could clip the terminal body | Corrected OrbitControls target initialization and fit the default/reset camera to the full ramp and body trajectory at the actual viewport aspect. Reviewed 390 px and 1440 px captures, including the exact endpoint, 0°/45° inclines, and 0.05/0.5 m radii. Explicitly saved camera poses remain unchanged; orbit, reset, and snapshot restoration were verified. |

Above-the-fold copy was compared with the allowed list above. Main title, question, navigation, primary actions, setup, transport, and linked-view headings match. Intentional functional additions are **Forces**, **Compare with hoop**, **More experiments**, and playback speed. **Rotation** is clarified to **Signed rotation**. Angle limits, current values, force scale, terminal messages, and energy totals come from the actual model rather than the illustrative image. These changes preserve the supplied scientific requirements.

The final render was verified against the concept's composition, typography, palette, icon treatment, and interaction hierarchy. No material clipping, label collisions, or unintended layout mismatches remained in the reviewed states. Functional evidence includes play/step/reset, exact input, keyboard/drag manipulation, linked values, save/restore, model checks, and portable export.
