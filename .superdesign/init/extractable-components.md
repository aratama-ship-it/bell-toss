# Extractable Components

The current app has no reusable HTML layout components. It is a single static document with native controls and three canvas modules. Component extraction is intentionally skipped for the baseline design.

Potential future components after implementation:

## TimelineNavigator
- Source: not yet implemented
- Category: basic
- Description: Whole-song overview, viewport window, scrubber, zoom, and loop range.
- Extractable props: none until a real source implementation exists.
- Hardcoded: none.

## PerformerCueLane
- Source: currently drawn inside `js/timeline.js`
- Category: basic
- Description: One performer's left/right hand actions aligned to the MIDI time axis.
- Extractable props: none; canvas rendering is state-driven.
- Hardcoded: lane geometry and Japanese action labels.
