# Theme

## Compact token summary

- Product material: warm paper, fine ink rules, restrained brass accents, blue performer lines.
- Colors: paper `#f6f3ec`; deep paper `#ece7dc`; ink `#2c313a`; muted ink `#6b6f77`; rules `#d8d2c4`; brass `#a9822f`; brass light `#c9a45a`; performer blue `#3d5578`; warning red `#b2472e`.
- Type: Japanese system sans for interface; Hiragino/Yu Mincho for the product name, tagline, and musical event accents.
- Shapes: mostly 2–3px corner radii, 1px rules, almost no shadow.
- Density: compact rehearsal-tool controls and a dense score canvas.
- Breakpoint: `720px` for stacked header and reduced page/stage padding.

## Raw source

Path: `css/style.css`

```css
:root {
  --paper: #f6f3ec;
  --paper-deep: #ece7dc;
  --ink: #2c313a;
  --ink-soft: #6b6f77;
  --line: #d8d2c4;
  --brass: #a9822f;
  --brass-soft: #c9a45a;
  --performer: #3d5578;
  --warn: #b2472e;
}
* { box-sizing: border-box; margin: 0; padding: 0; }
body { background: var(--paper); color: var(--ink); font-family: "Hiragino Sans", "Hiragino Kaku Gothic ProN", "Yu Gothic", sans-serif; font-size: 14px; line-height: 1.7; }
header { display: flex; align-items: flex-end; gap: 28px; padding: 26px 32px 14px; border-bottom: 1px solid var(--line); }
.title-block h1 { font-family: "Hiragino Mincho ProN", "Yu Mincho", serif; font-size: 42px; font-weight: 600; letter-spacing: 0.14em; line-height: 1; }
.title-block .reading { font-size: 12px; color: var(--ink-soft); letter-spacing: 0.4em; margin-left: 12px; font-family: "Hiragino Sans", sans-serif; }
.tagline { font-family: "Hiragino Mincho ProN", "Yu Mincho", serif; font-size: 14px; color: var(--brass); letter-spacing: 0.22em; margin-top: 8px; }
main { padding: 0 32px 40px; max-width: 1280px; margin: 0 auto; }
#stage-wrap { margin: 18px 0 0; border: 1px solid var(--line); border-radius: 3px; background: linear-gradient(180deg, #faf8f3 0%, #f1ede3 100%); overflow: hidden; }
#stage { display: block; width: 100%; height: 360px; }
#transport, #config { display: flex; align-items: center; flex-wrap: wrap; gap: 14px 22px; padding: 12px 2px; }
#transport { border-bottom: 1px dashed var(--line); }
button { font: inherit; font-size: 13px; color: var(--ink); background: transparent; border: 1px solid var(--ink-soft); border-radius: 2px; padding: 6px 16px; cursor: pointer; letter-spacing: 0.06em; transition: background 0.15s, color 0.15s; }
button:hover { background: var(--ink); color: var(--paper); }
button.primary { border-color: var(--brass); color: var(--brass); font-weight: 600; min-width: 96px; }
button.primary:hover, button.primary.playing { background: var(--brass); color: var(--paper); }
label { color: var(--ink-soft); font-size: 12.5px; display: inline-flex; align-items: center; gap: 6px; }
input[type="number"], select { font: inherit; font-size: 13px; color: var(--ink); background: #fffdf8; border: 1px solid var(--line); border-radius: 2px; padding: 3px 6px; width: 58px; }
input[type="range"] { accent-color: var(--brass); width: 120px; }
#score-area { margin-top: 6px; }
.score-row { display: flex; border: 1px solid var(--line); border-radius: 3px; background: #fbf9f4; }
.gutter-col { flex: 0 0 92px; border-right: 1px solid var(--line); background: #f3efe6; }
#scroll-area { position: relative; overflow-x: auto; overflow-y: hidden; flex: 1; }
#pianoroll { display: block; cursor: crosshair; }
#timeline { display: block; border-top: 2px solid var(--line); }
#playhead { position: absolute; top: 0; width: 1.5px; background: var(--brass); pointer-events: none; }
@media (max-width: 720px) {
  header { flex-direction: column; align-items: flex-start; gap: 8px; padding: 18px 16px 12px; }
  main { padding: 0 12px 32px; }
  #stage { height: 260px; }
}
```
