/* 投鈴 — 行動表（演者タイムライン）描画
   楽譜と同じX座標系。各演者は「左手・右手」の2レーン。
   投げ→キャッチは弧で結び、「音が鳴る瞬間より前に行動が始まる」ことを見せる。 */
"use strict";

TOREI.timeline = (() => {
  const V = TOREI.view;
  const BAND_H = 66;
  const LANE_Y = [22, 48]; // 左手・右手のレーン中心（バンド内）

  function height(n) { return n * BAND_H; }

  function draw(state) {
    const canvas = document.getElementById("timeline");
    const n = state.cfg.nPerformers;
    const ctx = TOREI.pianoroll.setupCanvas(canvas, V.width, height(n));
    const spb = 60 / state.melody.bpm;
    const toX = (tSec) => V.x(tSec / spb);

    ctx.fillStyle = "#f8f5ee";
    ctx.fillRect(0, 0, V.width, height(n));

    // 準備ゾーン
    if (V.preBeats > 0) {
      ctx.fillStyle = "rgba(169,130,47,0.06)";
      ctx.fillRect(0, 0, V.preBeats * V.PPB, height(n));
    }

    // 小節線（楽譜と揃える）
    const bpb = state.melody.beatsPerBar || 4;
    for (let b = 0; b <= V.TOTAL_BEATS; b += 1) {
      const x = V.x(b);
      ctx.strokeStyle = b % bpb === 0 ? "rgba(44,49,58,0.16)" : "rgba(44,49,58,0.05)";
      ctx.beginPath();
      ctx.moveTo(x + 0.5, 0);
      ctx.lineTo(x + 0.5, height(n));
      ctx.stroke();
    }

    // バンド区切りとレーン基線
    for (let p = 0; p < n; p++) {
      const top = p * BAND_H;
      ctx.strokeStyle = "rgba(44,49,58,0.25)";
      ctx.beginPath();
      ctx.moveTo(0, top + 0.5);
      ctx.lineTo(V.width, top + 0.5);
      ctx.stroke();
      for (const ly of LANE_Y) {
        ctx.strokeStyle = "rgba(44,49,58,0.09)";
        ctx.setLineDash([1, 3]);
        ctx.beginPath();
        ctx.moveTo(0, top + ly + 0.5);
        ctx.lineTo(V.width, top + ly + 0.5);
        ctx.stroke();
        ctx.setLineDash([]);
      }
    }

    if (!state.result) return;
    const rings = state.result.rings;

    for (const a of state.result.actions) {
      const top = a.perf * BAND_H;
      const y = top + LANE_Y[a.hand];
      const color = TOREI.pitchColor(a.midi != null ? a.midi : rings[a.ring].midi, 0.95);

      if (a.type === "throw") {
        // 投げ→キャッチの弧。パスは演者バンドをまたぐ。
        const x1 = toX(a.t);
        const x2 = toX(a.t + a.flight);
        const top2 = (a.catchPerf != null ? a.catchPerf : a.perf) * BAND_H;
        const y2 = top2 + LANE_Y[a.catchHand != null ? a.catchHand : a.hand];
        ctx.strokeStyle = color;
        ctx.lineWidth = 1.8;
        ctx.beginPath();
        ctx.moveTo(x1, y);
        ctx.quadraticCurveTo((x1 + x2) / 2, Math.min(y, y2) - 14 - a.flight * 4, x2, y2);
        ctx.stroke();
        // 投げ点（白抜き丸）
        ctx.fillStyle = "#f8f5ee";
        ctx.strokeStyle = color;
        ctx.lineWidth = 1.6;
        ctx.beginPath();
        ctx.arc(x1, y, 3.6, 0, Math.PI * 2);
        ctx.fill(); ctx.stroke();
      }

      if (a.type === "catch") {
        // 保持キャッチ和音: 同じ(演者,手,時刻)に2つの音が重なるため、上下にずらして
        // 「1つの手で2音」が見えるようにする（held=元々持っていた・new=今キャッチした）。
        const x = toX(a.t);
        const yy = a.chordRole === "held" ? y - 4.5 : a.chordRole === "new" ? y + 4.5 : y;
        ctx.beginPath();
        ctx.arc(x, yy, 5, 0, Math.PI * 2);
        if (a.chordRole === "held") {
          // 既に持っていたリング: 中抜きの丸（新しく飛んできたのではないことを示す）
          ctx.fillStyle = "#f8f5ee";
          ctx.fill();
          ctx.strokeStyle = color;
          ctx.lineWidth = 1.8;
          ctx.stroke();
        } else {
          ctx.fillStyle = color;
          ctx.fill();
        }
        if (a.chordRole) {
          ctx.strokeStyle = "rgba(44,49,58,0.3)";
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.moveTo(x - 6, y - 4.5); ctx.lineTo(x - 6, y + 4.5);
          ctx.stroke();
        }
        ctx.font = "600 10px 'Hiragino Sans', sans-serif";
        ctx.textAlign = "center";
        ctx.fillStyle = "rgba(44,49,58,0.9)";
        ctx.fillText(TOREI.noteName(a.midi), x, yy - 8);
        ctx.textAlign = "left";
      }

      if (a.type === "shake") {
        const x = toX(a.t);
        ctx.strokeStyle = "#b2472e";
        ctx.fillStyle = "rgba(178,71,46,0.15)";
        ctx.lineWidth = 1.6;
        ctx.beginPath();
        ctx.moveTo(x, y - 6); ctx.lineTo(x + 5, y); ctx.lineTo(x, y + 6); ctx.lineTo(x - 5, y);
        ctx.closePath();
        ctx.fill(); ctx.stroke();
        ctx.font = "600 10px 'Hiragino Sans', sans-serif";
        ctx.textAlign = "center";
        ctx.fillStyle = "#b2472e";
        ctx.fillText(TOREI.noteName(a.midi) + "振", x, y - 9);
        ctx.textAlign = "left";
      }

      if (a.type === "pickup" || a.type === "store") {
        const x1 = toX(a.t);
        const x2 = toX(a.t + a.dur);
        ctx.strokeStyle = TOREI.pitchColor(rings[a.ring].midi, 0.5);
        ctx.lineWidth = 4;
        ctx.beginPath();
        ctx.moveTo(x1, y);
        ctx.lineTo(x2, y);
        ctx.stroke();
        const label = a.type === "pickup"
          ? (a.from === "waki" ? "脇→手" : "台→手")
          : (a.to === "waki" ? "手→脇" : a.to === "otherhand" ? "持ち替え" : "手→台");
        ctx.font = "9px 'Hiragino Sans', sans-serif";
        ctx.fillStyle = "rgba(44,49,58,0.55)";
        ctx.fillText(label, x1 + 2, y + 12);
      }
    }
  }

  function buildGutter(state, onRename) {
    const gutter = document.getElementById("tl-gutter");
    gutter.innerHTML = "";
    for (let p = 0; p < state.cfg.nPerformers; p++) {
      const div = document.createElement("div");
      div.className = "perf-label";
      div.style.height = BAND_H + "px";
      const inp = document.createElement("input");
      inp.className = "name-input";
      inp.value = TOREI.perfName(p);
      inp.maxLength = 8;
      inp.title = "クリックで演者名を編集";
      inp.addEventListener("change", () => {
        TOREI.setPerfName(p, inp.value);
        if (onRename) onRename();
      });
      const span = document.createElement("span");
      span.textContent = "左手 ／ 右手";
      div.appendChild(inp);
      div.appendChild(span);
      gutter.appendChild(div);
    }
  }

  return { draw, buildGutter, BAND_H, height };
})();
