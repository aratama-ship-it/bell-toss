# 投鈴 UI design system

## Product and user

投鈴 is a rehearsal and arrangement simulator for handbell juggling. A director or performer imports or edits a melody, changes performer and juggling constraints, and studies the generated throws, catches, passes, storage operations, and failures. The central job is not generic music playback: it is understanding who does what, when, with which ring, and rehearsing a difficult interval repeatedly.

## Design character

The product should feel like a stage manager's score, an annotated rehearsal sheet, and a precise physical-motion instrument. Preserve the project's warm paper, ink, brass, and performer-blue identity, but improve hierarchy and interaction substantially. It must not look like a generic SaaS dashboard, AI glass UI, bento grid, or purple-gradient music app.

Use restrained material qualities: paper-white working surfaces, fine rules, occasional brass playhead/selection, performer blue for people and motion, warning red only for physical impossibility. Prefer compact rectangular controls and typographic hierarchy over rounded cards and decorative badges.

## Typography

- Interface: Hiragino Sans / Yu Gothic / Japanese system sans.
- Product title and rare musical accents: Hiragino Mincho / Yu Mincho.
- Time, BPM, bar and beat values: tabular numerals.
- Keep labels concise and suitable for rehearsal-room use at a glance.

## Color tokens

- Paper: `#f6f3ec`
- Deep paper: `#ece7dc`
- Canvas paper: `#fbf9f4`
- Ink: `#2c313a`
- Muted ink: `#6b6f77`
- Rule: `#d8d2c4`
- Brass interaction/playhead: `#a9822f`
- Brass light: `#c9a45a`
- Performer blue: `#3d5578`
- Physical warning: `#b2472e`

## Timeline information architecture

The MIDI piano roll and performer actions share one time coordinate system and must remain vertically aligned. Add a persistent navigator above them:

1. A whole-song overview strip that compresses notes and action density.
2. A clearly visible viewport window that can be dragged horizontally.
3. A persistent brass playhead that remains visible while stopped.
4. Bar numbers, beat subdivisions, elapsed time, and current bar/beat readout.
5. Zoom out/in buttons and a compact zoom slider, centered on pointer or playhead.
6. A–B loop handles and a one-click “この小節を反復” action.
7. Keep left performer/pitch gutters fixed while timeline content scrolls.
8. Current actions in every performer lane highlight at the playhead, connecting the shared timeline to future per-performer cue sheets.

## Interaction model

- Click or drag the ruler/navigator to seek without creating notes.
- Drag the overview viewport window to pan long songs.
- Space+drag or middle-button drag pans the detailed score; ordinary left drag on a note continues editing it.
- Shift+wheel pans horizontally; Cmd/Ctrl+wheel zooms.
- Space toggles play/pause when focus is not inside an input.
- Left/right arrows move by the selected snap value; Shift+arrows move by one bar.
- Seeking updates the stage preview immediately and does not erase the cursor on pause.
- Touch targets for navigator handles and playback controls are at least 44 CSS pixels even when the visual mark is finer.

## Motion and feedback

Scrolling and zooming should be immediate, with minimal 100–160ms easing only for button feedback or non-critical viewport settling. Do not animate score data gratuitously. During drag, update the stage and playhead continuously; reschedule audio only on release. Make hover, active, keyboard-focus, loop, and disabled states unambiguous.

## Accessibility and performance

- Preserve native buttons/inputs where practical and provide visible focus rings.
- Expose time position, zoom, loop start/end, and playback state with accessible labels.
- Support pointer events for mouse, pen, and touch.
- Avoid red/green-only meaning; pair warnings with shape/text.
- Redraw canvases with devicePixelRatio support and throttle continuous pointer/wheel drawing through requestAnimationFrame.
- The main timeline must remain usable at 720px and below; prioritize navigator, play/pause, time readout, and horizontal manipulation over secondary export controls.

## Constraints

- Vanilla HTML, CSS, and JavaScript; no framework migration for this feature.
- Do not obscure the score with floating glass panels.
- Do not compromise real playback, MIDI import/export, copy, pause, or keyboard focus controls.
- The final implementation must repair the current `js/presets.js` syntax break before browser QA, but the design draft itself should focus on timeline navigation rather than displaying the defect.
