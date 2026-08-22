# Page Dependency Trees

## `/` — 投鈴 simulator

Entry: `index.html`

Dependencies:

- `css/style.css`
- `js/presets.js` — bootstrap helpers, note labels, performer names
- `js/songs.js` — generated preset melody data
- `js/scheduler.js` — ring/action scheduling
- `js/audio.js` — WebAudio bell playback
- `js/midi.js` — MIDI export
- `js/pianoroll.js` — shared view coordinates and editable note canvas
- `js/timeline.js` — performer hand/action lanes
- `js/stage.js` — animated stage visualization
- `js/main.js` — state, recomputation, playback, note editing, MIDI import, controls

Actual render order: header → stage → transport → configuration → summaries/warnings → piano roll and performer timeline → usage hint → footer.
