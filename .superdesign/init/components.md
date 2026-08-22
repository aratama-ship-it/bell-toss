# Shared UI Components

This project is a framework-free static application. It has no React/Vue component library and uses native HTML controls plus canvas rendering modules.

## Piano Roll Canvas

- Path: `js/pianoroll.js`
- Purpose: Shared time/pitch coordinate system and editable MIDI-note canvas.
- State inputs: `state.melody`, `state.result`, global `TOREI.view`.

```js
/* 投鈴 — 楽譜（ピアノロール）描画
   時間軸は「準備ゾーン（負の時刻）＋ 楽曲ゾーン」。行動表と同じX座標系を共有する。 */
"use strict";

TOREI.view = {
  PITCH_MIN: 60,
  PITCH_MAX: 84,
  ROW_H: 13,
  PPB: 56,
  TOTAL_BEATS: 64,
  preBeats: 0,

  x(beat) { return (this.preBeats + beat) * this.PPB; },
  beatAt(x) { return x / this.PPB - this.preBeats; },
  rowY(midi) { return (this.PITCH_MAX - midi) * this.ROW_H; },
  midiAt(y) { return this.PITCH_MAX - Math.floor(y / this.ROW_H); },
  get rows() { return this.PITCH_MAX - this.PITCH_MIN + 1; },
  get prHeight() { return this.rows * this.ROW_H; },
  get width() { return (this.preBeats + this.TOTAL_BEATS) * this.PPB; },
};

TOREI.pianoroll = (() => {
  const V = TOREI.view;

  function setupCanvas(canvas, w, h) {
    const dpr = window.devicePixelRatio || 1;
    canvas.width = w * dpr;
    canvas.height = h * dpr;
    canvas.style.width = w + "px";
    canvas.style.height = h + "px";
    const ctx = canvas.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return ctx;
  }

  function draw(state) {
    const canvas = document.getElementById("pianoroll");
    const ctx = setupCanvas(canvas, V.width, V.prHeight);
    const { melody, result } = state;

    ctx.fillStyle = "#fbf9f4";
    ctx.fillRect(0, 0, V.width, V.prHeight);

    for (let m = V.PITCH_MIN; m <= V.PITCH_MAX; m++) {
      if ([1, 3, 6, 8, 10].includes(m % 12)) {
        ctx.fillStyle = "rgba(44,49,58,0.035)";
        ctx.fillRect(0, V.rowY(m), V.width, V.ROW_H);
      }
    }

    if (V.preBeats > 0) {
      ctx.fillStyle = "rgba(169,130,47,0.06)";
      ctx.fillRect(0, 0, V.preBeats * V.PPB, V.prHeight);
      ctx.fillStyle = "rgba(169,130,47,0.65)";
      ctx.font = "10.5px 'Hiragino Sans', sans-serif";
      ctx.fillText("準備", 8, 14);
    }

    const bpb = melody.beatsPerBar || 4;
    for (let b = 0; b <= V.TOTAL_BEATS; b++) {
      const x = V.x(b);
      const isBar = b % bpb === 0;
      ctx.strokeStyle = isBar ? "rgba(44,49,58,0.22)" : "rgba(44,49,58,0.08)";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(x + 0.5, 0);
      ctx.lineTo(x + 0.5, V.prHeight);
      ctx.stroke();
      if (b < V.TOTAL_BEATS) {
        ctx.strokeStyle = "rgba(44,49,58,0.04)";
        ctx.beginPath();
        ctx.moveTo(V.x(b + 0.5) + 0.5, 0);
        ctx.lineTo(V.x(b + 0.5) + 0.5, V.prHeight);
        ctx.stroke();
      }
    }

    for (let m = V.PITCH_MIN; m <= V.PITCH_MAX; m++) {
      const y = V.rowY(m) + V.ROW_H;
      ctx.strokeStyle = m % 12 === 0 ? "rgba(44,49,58,0.18)" : "rgba(44,49,58,0.06)";
      ctx.beginPath();
      ctx.moveTo(0, y + 0.5);
      ctx.lineTo(V.width, y + 0.5);
      ctx.stroke();
    }

    for (let i = 0; i < melody.notes.length; i++) {
      const n = melody.notes[i];
      const x = V.x(n.beat);
      const y = V.rowY(n.midi);
      const r = result && result.noteResults[i];
      ctx.fillStyle = TOREI.pitchColor(n.midi, 0.9);
      roundRect(ctx, x + 1.5, y + 1.5, V.PPB * 0.25 - 3 + 8, V.ROW_H - 3, 3);
      ctx.fill();
      if (r && r.kind === "shake") {
        ctx.strokeStyle = "rgba(178,71,46,0.9)";
        ctx.setLineDash([3, 2]);
        ctx.lineWidth = 1.5;
        roundRect(ctx, x + 1.5, y + 1.5, V.PPB * 0.25 - 3 + 8, V.ROW_H - 3, 3);
        ctx.stroke();
        ctx.setLineDash([]);
      } else if (r && r.kind === "fail") {
        ctx.strokeStyle = "#b2472e";
        ctx.lineWidth = 2;
        const cx = x + 6, cy = y + V.ROW_H / 2;
        ctx.beginPath();
        ctx.moveTo(cx - 4, cy - 4); ctx.lineTo(cx + 4, cy + 4);
        ctx.moveTo(cx + 4, cy - 4); ctx.lineTo(cx - 4, cy + 4);
        ctx.stroke();
      }
    }
  }

  function drawGutter(state) {
    const canvas = document.getElementById("pr-gutter");
    const ctx = setupCanvas(canvas, 92, V.prHeight);
    ctx.fillStyle = "#f3efe6";
    ctx.fillRect(0, 0, 92, V.prHeight);
    ctx.font = "10px 'Hiragino Sans', sans-serif";
    ctx.textBaseline = "middle";
    for (let m = V.PITCH_MIN; m <= V.PITCH_MAX; m++) {
      const y = V.rowY(m) + V.ROW_H / 2;
      const isC = m % 12 === 0;
      ctx.fillStyle = isC ? "rgba(44,49,58,0.9)" : "rgba(44,49,58,0.45)";
      ctx.fillText(TOREI.noteNameFull(m), 10, y);
      ctx.fillStyle = TOREI.pitchColor(m, 0.55);
      ctx.fillRect(78, V.rowY(m) + 3, 8, V.ROW_H - 6);
    }
  }

  function roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  return { draw, drawGutter, setupCanvas, roundRect };
})();
```

## Performer Timeline Canvas

- Path: `js/timeline.js`
- Purpose: Renders performer hand lanes and throw-to-catch arcs in the same horizontal coordinate system as the piano roll.
- State inputs: scheduler actions, rings, performer count.

The complete source file is passed directly to Superdesign in the target context bundle; it is not a generic primitive and is not extracted as a reusable DraftComponent.
