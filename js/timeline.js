/* 投鈴 — 行動表（場所ベースのダイヤグラム）
   2026-08-26 全面改訂（本人要望「各演者4段=左手・右手・左脇・右脇＋スタンドの計13段。
   保持している最中も表記。人間が管理するにはこれが良い」）。

   横=時間（楽譜と同じX座標系）、縦=リングの置き場所。
   リングが「どこにあるか」を色帯（保持区間）で常時表示し、投げは手の段から手の段への弧、
   脇やスタンドへの出し入れは段をまたぐ斜めの線で描く。鉄道ダイヤと同じ読み方ができる。 */
"use strict";

TOREI.timeline = (() => {
  const V = TOREI.view;
  const LANE_H = 20;                 // 1段の高さ
  const ROWS = ["左手", "右手", "左脇", "右脇"];  // 演者ごとの段（添字=手/脇の側）
  const BAND_H = LANE_H * ROWS.length;
  const STAND_H = 22;                // 最下段のスタンド

  function height(n) { return n * BAND_H + STAND_H; }

  // 段の中心Y。row: 0=左手 1=右手 2=左脇 3=右脇
  function rowY(perf, row) { return perf * BAND_H + row * LANE_H + LANE_H / 2; }
  function standY(n) { return n * BAND_H + STAND_H / 2; }

  // 和音のキャッチ点は同じ(演者,手,時刻)に2つ乗るので上下にずらす（drawとlayoutActionで共有）
  function catchLaneY(a) {
    const y = rowY(0, a.hand) - 0 * BAND_H; // バンド内ローカル（layoutAction用）
    return a.chordRole === "held" ? y - 4.5 : a.chordRole === "new" ? y + 4.5 : y;
  }

  // 再生位置ハイライト用: 1アクションの見た目上の矩形（バンド内ローカル座標）
  function layoutAction(a, spb) {
    const toX = (tSec) => V.x(tSec / spb);
    if (a.type === "throw") {
      const x = toX(a.t);
      return { x: x - 8, y: rowY(0, a.hand) - 8, w: 16, h: 16 };
    }
    if (a.type === "catch" || a.type === "shake") {
      const x = toX(a.t);
      const y = a.type === "catch" ? catchLaneY(a) : rowY(0, a.hand);
      return { x: x - 8, y: y - 8, w: 16, h: 16 };
    }
    if (a.type === "pickup" || a.type === "store") {
      const x1 = toX(a.t), x2 = toX(a.t + a.dur);
      // 出し入れは手の段と脇の段をまたぐ。ハイライトは両方を覆う
      let y0 = rowY(0, a.hand), y1 = y0;
      const side = (a.type === "store" && a.to === "waki") ? 2 + (1 - a.hand)
        : (a.type === "pickup" && a.from === "waki") ? 2 + (1 - a.hand) : null;
      if (side != null) { y1 = rowY(0, side); }
      const top = Math.min(y0, y1) - 9, bot = Math.max(y0, y1) + 9;
      return { x: x1 - 3, y: top, w: Math.max(6, x2 - x1) + 6, h: bot - top };
    }
    return null;
  }

  /* リングの「所在の区間」を行動列から組み立てる。
     戻り値: [{ring, from, to, kind:'hand'|'waki'|'stand', perf, row}] （kind=standはperf/row無し）
     リングは開演前スタンドから始まり、pickup/catch/throw/store で移動する。 */
  function buildSpans(result) {
    const spans = [];
    const cur = {};   // ringId -> {kind, perf, row, since}
    for (const r of result.rings) cur[r.id] = { kind: "stand", since: -Infinity };
    const close = (id, t) => {
      const c = cur[id];
      if (!c) return;
      if (t > c.since + 1e-6) spans.push({ ring: id, from: c.since, to: t, kind: c.kind, perf: c.perf, row: c.row });
      delete cur[id];
    };
    const open = (id, t, kind, perf, row) => { cur[id] = { kind, perf, row, since: t }; };

    const acts = result.actions.slice().sort((a, b) => a.t - b.t);
    for (const a of acts) {
      if (a.type === "pickup") {
        close(a.ring, a.t);
        open(a.ring, a.t + a.dur, "hand", a.perf, a.hand);
      } else if (a.type === "catch") {
        // 投げ側の throw で所在は閉じてある（空中は弧で描くので区間にしない）
        open(a.ring, a.t, "hand", a.perf, a.hand);
      } else if (a.type === "throw") {
        close(a.ring, a.t);
      } else if (a.type === "store") {
        close(a.ring, a.t);
        if (a.to === "waki") open(a.ring, a.t + a.dur, "waki", a.perf, 2 + (1 - a.hand));
        else if (a.to === "otherhand") open(a.ring, a.t + a.dur, "hand", a.perf, 1 - a.hand);
        else open(a.ring, a.t + a.dur, "stand");
      }
      // shake は所在が変わらない
    }
    const endT = acts.length ? acts[acts.length - 1].t + 2 : 2;
    for (const id of Object.keys(cur)) close(+id, endT);
    return spans;
  }

  function draw(state) {
    const canvas = document.getElementById("timeline");
    const n = state.cfg.nPerformers;
    const ctx = TOREI.pianoroll.setupCanvas(canvas, V.width, height(n));
    const spb = 60 / state.melody.bpm;
    const toX = (tSec) => V.x(tSec / spb);

    ctx.fillStyle = "#f8f5ee";
    ctx.fillRect(0, 0, V.width, height(n));
    // 脇の段は少し沈んだ地色にして手の段と見分ける
    for (let p = 0; p < n; p++) {
      ctx.fillStyle = "rgba(44,49,58,0.03)";
      ctx.fillRect(0, p * BAND_H + 2 * LANE_H, V.width, 2 * LANE_H);
    }
    ctx.fillStyle = "rgba(169,130,47,0.05)";
    ctx.fillRect(0, n * BAND_H, V.width, STAND_H);

    // 準備ゾーン
    if (V.preBeats > 0) {
      ctx.fillStyle = "rgba(169,130,47,0.06)";
      ctx.fillRect(0, 0, V.preBeats * V.PPB, height(n));
    }

    // 小節線
    const bpb = state.melody.beatsPerBar || 4;
    for (let b = 0; b <= V.TOTAL_BEATS; b += 1) {
      const x = V.x(b);
      ctx.strokeStyle = b % bpb === 0 ? "rgba(44,49,58,0.16)" : "rgba(44,49,58,0.05)";
      ctx.beginPath();
      ctx.moveTo(x + 0.5, 0);
      ctx.lineTo(x + 0.5, height(n));
      ctx.stroke();
    }

    // 段の基線とバンド区切り
    for (let p = 0; p < n; p++) {
      ctx.strokeStyle = "rgba(44,49,58,0.28)";
      ctx.beginPath();
      ctx.moveTo(0, p * BAND_H + 0.5); ctx.lineTo(V.width, p * BAND_H + 0.5);
      ctx.stroke();
      for (let row = 0; row < 4; row++) {
        ctx.strokeStyle = "rgba(44,49,58,0.08)";
        ctx.setLineDash([1, 3]);
        ctx.beginPath();
        ctx.moveTo(0, rowY(p, row) + 0.5); ctx.lineTo(V.width, rowY(p, row) + 0.5);
        ctx.stroke();
        ctx.setLineDash([]);
      }
    }
    ctx.strokeStyle = "rgba(44,49,58,0.28)";
    ctx.beginPath();
    ctx.moveTo(0, n * BAND_H + 0.5); ctx.lineTo(V.width, n * BAND_H + 0.5);
    ctx.stroke();

    if (!state.result) return;
    const rings = state.result.rings;
    const minT = state.result.minT;

    // --- 保持区間の帯（このダイヤグラムの主役。2026-08-26 本人要望） ---
    const spans = buildSpans(state.result);
    for (const sp of spans) {
      const ring = rings[sp.ring];
      const from = Math.max(sp.from, minT);
      if (sp.to <= from + 1e-6) continue;
      const x1 = toX(from), x2 = toX(sp.to);
      const y = sp.kind === "stand" ? standY(n)
        : rowY(sp.perf, sp.row);
      // スタンドは同時に多数乗るので、リングごとに少し上下へ散らす
      const yo = sp.kind === "stand" ? ((sp.ring % 3) - 1) * 5 : 0;
      const color = TOREI.pitchColor(ring.midi, 0.9);
      ctx.fillStyle = TOREI.pitchColor(ring.midi, sp.kind === "hand" ? 0.30 : 0.16);
      ctx.strokeStyle = TOREI.pitchColor(ring.midi, sp.kind === "hand" ? 0.75 : 0.4);
      ctx.lineWidth = 1;
      const h = sp.kind === "hand" ? 9 : 7;
      ctx.beginPath();
      ctx.roundRect(x1, y + yo - h / 2, Math.max(3, x2 - x1), h, 3);
      ctx.fill(); ctx.stroke();
      // 帯が十分広ければリング名を書く
      if (x2 - x1 > 26) {
        ctx.font = "600 9px 'Hiragino Sans', sans-serif";
        ctx.fillStyle = color;
        ctx.fillText(ring.label, x1 + 3, y + yo - h / 2 - 2);
      }
    }

    // --- 行動（弧・点・出し入れの斜め線） ---
    for (const a of state.result.actions) {
      const color = TOREI.pitchColor(a.midi != null ? a.midi : rings[a.ring].midi, 0.95);

      if (a.type === "throw") {
        const x1 = toX(a.t);
        const x2 = toX(a.t + a.flight);
        const y1 = rowY(a.perf, a.hand);
        const y2 = rowY(a.catchPerf != null ? a.catchPerf : a.perf,
          a.catchHand != null ? a.catchHand : a.hand);
        ctx.strokeStyle = color;
        ctx.lineWidth = 1.8;
        ctx.beginPath();
        ctx.moveTo(x1, y1);
        ctx.quadraticCurveTo((x1 + x2) / 2, Math.min(y1, y2) - 14 - a.flight * 4, x2, y2);
        ctx.stroke();
        // 人間が編集した音（fix）は金の四角で囲む
        const fx = a.noteIdx != null && state.melody.notes[a.noteIdx]
          ? state.melody.notes[a.noteIdx].fix : null;
        if (fx) {
          ctx.strokeStyle = "rgba(169,130,47,0.9)";
          ctx.lineWidth = 1.4;
          ctx.strokeRect(x1 - 7, y1 - 7, 14, 14);
        }
        // 投げ点（白抜き丸）
        ctx.fillStyle = "#f8f5ee";
        ctx.strokeStyle = color;
        ctx.lineWidth = 1.6;
        ctx.beginPath();
        ctx.arc(x1, y1, 3.6, 0, Math.PI * 2);
        ctx.fill(); ctx.stroke();
      }

      if (a.type === "catch") {
        const x = toX(a.t);
        const base = rowY(a.perf, a.hand);
        const yy = base + (a.chordRole === "held" ? -4.5 : a.chordRole === "new" ? 4.5 : 0);
        ctx.beginPath();
        ctx.arc(x, yy, 5, 0, Math.PI * 2);
        if (a.chordRole === "held") {
          ctx.fillStyle = "#f8f5ee";
          ctx.fill();
          ctx.strokeStyle = color;
          ctx.lineWidth = 1.8;
          ctx.stroke();
        } else {
          ctx.fillStyle = color;
          ctx.fill();
        }
        ctx.font = "600 10px 'Hiragino Sans', sans-serif";
        ctx.textAlign = "center";
        ctx.fillStyle = "rgba(44,49,58,0.9)";
        ctx.fillText(TOREI.noteName(a.midi), x, yy - 8);
        ctx.textAlign = "left";
      }

      if (a.type === "shake") {
        const x = toX(a.t);
        const y = rowY(a.perf, a.hand);
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
        // 段をまたぐ斜めの線で「移動」を描く（ダイヤグラムの乗り換え線）
        const x1 = toX(a.t), x2 = toX(a.t + a.dur);
        let yFrom, yTo;
        if (a.type === "pickup") {
          yFrom = a.from === "waki" ? rowY(a.perf, 2 + (1 - a.hand)) : standY(n);
          yTo = rowY(a.perf, a.hand);
        } else {
          yFrom = rowY(a.perf, a.hand);
          yTo = a.to === "waki" ? rowY(a.perf, 2 + (1 - a.hand))
            : a.to === "otherhand" ? rowY(a.perf, 1 - a.hand)
            : standY(n);
        }
        ctx.strokeStyle = TOREI.pitchColor(rings[a.ring].midi, 0.55);
        ctx.lineWidth = 2;
        ctx.setLineDash([3, 2]);
        ctx.beginPath();
        ctx.moveTo(x1, yFrom);
        ctx.lineTo(x2, yTo);
        ctx.stroke();
        ctx.setLineDash([]);
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
        if (onRename) onRename(p, inp.value);
      });
      div.appendChild(inp);
      const rows = document.createElement("div");
      rows.className = "row-labels";
      for (const name of ROWS) {
        const r = document.createElement("i");
        r.textContent = name;
        r.style.height = LANE_H + "px";
        rows.appendChild(r);
      }
      div.appendChild(rows);
      gutter.appendChild(div);
    }
    const stand = document.createElement("div");
    stand.className = "stand-label";
    stand.style.height = STAND_H + "px";
    stand.textContent = "スタンド";
    gutter.appendChild(stand);
  }

  /* ダイヤグラム上の投げのヒットテスト（人間の組み直し用） */
  function throwAt(state, px, py) {
    if (!state.result) return null;
    const spb = 60 / state.melody.bpm;
    let best = null, bestD = 12 * 12;
    for (const a of state.result.actions) {
      if (a.type !== "throw" || a.noteIdx == null) continue;
      const x = V.x(a.t / spb);
      const y = rowY(a.perf, a.hand);
      const d = (px - x) * (px - x) + (py - y) * (py - y);
      if (d < bestD) { bestD = d; best = a; }
    }
    return best;
  }

  return { draw, buildGutter, BAND_H, LANE_H, STAND_H, height, layoutAction, throwAt };
})();
