/* 投鈴 — ナビゲーター（全曲オーバービュー）と小節ルーラー
   考え方は「舞台監督の見取り図」:
   - 全曲を墨点で圧縮した帯の上で、いま見えている範囲だけ紙が明るく「開いている」。
   - ループ範囲は舞台のバミリ（スパイクテープ）のような真鍮のブラケットで示す。
   - ルーラーは指でなぞって再生位置を動かす場所。音符編集とは完全に分離する。
   楽譜（ピアノロール）と同じ TOREI.view のX座標系を使う。 */
"use strict";

TOREI.nav = (() => {
  const V = TOREI.view;
  const RULER_H = 22;
  const NAV_H = 44;
  const HANDLE_HIT = 14;   // 窓の端のつかみ判定（左右それぞれ。上下は帯全体44px）
  const BRACKET_HIT = 10;  // ループブラケットのつかみ判定

  let S = null;   // main の state（melody / result / pos / loop を読む）
  let H = null;   // main から渡されるハンドラ { seek, setLoop, applyZoom, scrollArea }

  /* ---------- 座標（ナビゲーター帯 ← 全曲） ---------- */

  function navWidth() {
    // canvas自体はsetupCanvasが幅を固定するので、親（伸縮する箱）から測る
    const body = document.getElementById("nav-body");
    return body ? body.clientWidth : 0;
  }
  function totalBeats() { return V.preBeats + V.TOTAL_BEATS; }
  function navX(beat) { return ((V.preBeats + beat) / totalBeats()) * navWidth(); }
  function beatAtNav(x) { return (x / navWidth()) * totalBeats() - V.preBeats; }

  function spb() { return 60 / S.melody.bpm; }

  // いま楽譜側に見えている範囲（拍）
  function viewportBeats() {
    const sa = H.scrollArea();
    const a = sa.scrollLeft / V.PPB - V.preBeats;
    return { a, b: a + sa.clientWidth / V.PPB };
  }

  /* ---------- ルーラー描画（楽譜と一緒にスクロールする） ---------- */

  function drawRuler() {
    const canvas = document.getElementById("ruler");
    const ctx = TOREI.pianoroll.setupCanvas(canvas, V.width, RULER_H);
    const bpb = S.melody.beatsPerBar || 4;

    ctx.fillStyle = "#f1ede2";
    ctx.fillRect(0, 0, V.width, RULER_H);

    // 準備ゾーン
    if (V.preBeats > 0) {
      ctx.fillStyle = "rgba(169,130,47,0.08)";
      ctx.fillRect(0, 0, V.preBeats * V.PPB, RULER_H);
    }

    // ループ範囲（バミリ帯）
    if (S.loop) {
      const x1 = V.x(S.loop.a), x2 = V.x(S.loop.b);
      ctx.fillStyle = "rgba(169,130,47,0.16)";
      ctx.fillRect(x1, 0, x2 - x1, RULER_H);
    }

    // 目盛り: 小節線＋番号、拍、16分（ズームが深いときだけ）
    ctx.font = "10px 'Hiragino Sans', sans-serif";
    ctx.textBaseline = "alphabetic";
    for (let b = 0; b <= V.TOTAL_BEATS; b++) {
      const x = V.x(b) + 0.5;
      if (b % bpb === 0) {
        ctx.strokeStyle = "rgba(44,49,58,0.35)";
        ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, RULER_H); ctx.stroke();
        if (b < V.TOTAL_BEATS) {
          ctx.fillStyle = "rgba(107,111,119,0.95)";
          ctx.fillText(String(b / bpb + 1), x + 3.5, 14);
        }
      } else {
        ctx.strokeStyle = "rgba(44,49,58,0.18)";
        ctx.beginPath(); ctx.moveTo(x, RULER_H - 6); ctx.lineTo(x, RULER_H); ctx.stroke();
      }
      if (V.PPB >= 44 && b < V.TOTAL_BEATS) {
        for (let q = 1; q < 4; q++) {
          const xq = V.x(b + q / 4) + 0.5;
          ctx.strokeStyle = "rgba(44,49,58,0.10)";
          ctx.beginPath(); ctx.moveTo(xq, RULER_H - 3); ctx.lineTo(xq, RULER_H); ctx.stroke();
        }
      }
    }

    // ループのブラケット（⌐ ¬ のかたち）
    // 再生位置の三角はプレイヘッドdiv側（CSSの::before）が持つ。
    // Canvasに描くと再生中に毎フレーム全幅を描き直すことになるため。
    if (S.loop) drawBrackets(ctx, V.x(S.loop.a), V.x(S.loop.b), RULER_H);

    ctx.strokeStyle = "rgba(44,49,58,0.25)";
    ctx.beginPath(); ctx.moveTo(0, RULER_H - 0.5); ctx.lineTo(V.width, RULER_H - 0.5); ctx.stroke();
  }

  function drawBrackets(ctx, x1, x2, h) {
    ctx.strokeStyle = "#a9822f";
    ctx.lineWidth = 1.6;
    const foot = 5;
    ctx.beginPath();
    ctx.moveTo(x1 + foot, 1); ctx.lineTo(x1 + 0.8, 1); ctx.lineTo(x1 + 0.8, h - 1); ctx.lineTo(x1 + foot, h - 1);
    ctx.moveTo(x2 - foot, 1); ctx.lineTo(x2 - 0.8, 1); ctx.lineTo(x2 - 0.8, h - 1); ctx.lineTo(x2 - foot, h - 1);
    ctx.stroke();
    ctx.lineWidth = 1;
  }

  /* ---------- ナビゲーター帯の描画 ---------- */

  function drawNav() {
    const canvas = document.getElementById("navigator");
    const w = navWidth();
    if (!w) return;
    const ctx = TOREI.pianoroll.setupCanvas(canvas, w, NAV_H);
    const bpb = S.melody.beatsPerBar || 4;

    // 地: 深い紙
    ctx.fillStyle = "#eae4d6";
    ctx.fillRect(0, 0, w, NAV_H);

    // 準備ゾーン
    if (V.preBeats > 0) {
      ctx.fillStyle = "rgba(169,130,47,0.10)";
      ctx.fillRect(0, 0, navX(0), NAV_H);
      ctx.strokeStyle = "rgba(169,130,47,0.5)";
      ctx.beginPath(); ctx.moveTo(navX(0) + 0.5, 0); ctx.lineTo(navX(0) + 0.5, NAV_H); ctx.stroke();
    }

    // 小節の淡い目盛り（方向感のためのテクスチャ）
    for (let b = 0; b <= V.TOTAL_BEATS; b += bpb) {
      const x = navX(b) + 0.5;
      ctx.strokeStyle = "rgba(44,49,58,0.06)";
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, NAV_H); ctx.stroke();
    }

    // ループ帯
    if (S.loop) {
      const x1 = navX(S.loop.a), x2 = navX(S.loop.b);
      ctx.fillStyle = "rgba(169,130,47,0.14)";
      ctx.fillRect(x1, 0, x2 - x1, NAV_H);
    }

    // 音符の墨点（音高で縦位置・色）。振り/不可能は赤で大きめに打ち、
    // 全曲を見渡して「どこが破綻しているか」が分かるようにする。
    const pr = V.PITCH_MAX - V.PITCH_MIN;
    for (let i = 0; i < S.melody.notes.length; i++) {
      const n = S.melody.notes[i];
      const x = navX(n.beat);
      const y = 5 + (1 - (n.midi - V.PITCH_MIN) / pr) * (NAV_H - 12);
      const r = S.result && S.result.noteResults[i];
      if (r && (r.kind === "shake" || r.kind === "fail")) {
        ctx.fillStyle = "#b2472e";
        ctx.fillRect(x - 2, y - 2, 4.5, 4.5);
      } else {
        ctx.fillStyle = TOREI.pitchColor(n.midi, 0.75);
        ctx.fillRect(x - 1, y - 1, 3, 2.5);
      }
    }

    // 窓の外に紗をかける（開いているページだけが明るい）
    const vp = viewportBeats();
    const wx1 = Math.max(0, navX(vp.a));
    const wx2 = Math.min(w, navX(vp.b));
    ctx.fillStyle = "rgba(236,231,220,0.55)";
    ctx.fillRect(0, 0, wx1, NAV_H);
    ctx.fillRect(wx2, 0, w - wx2, NAV_H);

    // 窓枠（真鍮）と両端のつまみ
    ctx.strokeStyle = "#a9822f";
    ctx.lineWidth = 1.4;
    ctx.strokeRect(wx1 + 0.7, 0.7, wx2 - wx1 - 1.4, NAV_H - 1.4);
    ctx.fillStyle = "rgba(169,130,47,0.85)";
    ctx.fillRect(wx1, 0, 4, NAV_H);
    ctx.fillRect(wx2 - 4, 0, 4, NAV_H);
    ctx.lineWidth = 1;

    // ループのブラケット（紗の上にも見えるように最後）
    if (S.loop) drawBrackets(ctx, navX(S.loop.a), navX(S.loop.b), NAV_H);

    // 再生位置
    const px = navX(S.pos / spb());
    ctx.strokeStyle = "#a9822f";
    ctx.lineWidth = 1.4;
    ctx.beginPath(); ctx.moveTo(px, 0); ctx.lineTo(px, NAV_H); ctx.stroke();
    ctx.lineWidth = 1;
  }

  /* ---------- ルーラーの操作: なぞって再生位置 / option+ドラッグでループ ---------- */

  function snap16(beat) { return Math.round(beat * 4) / 4; }
  function snapBeat(beat) { return Math.round(beat); }
  function clampBeat(beat) {
    return Math.max(-V.preBeats, Math.min(V.TOTAL_BEATS, beat));
  }

  let rulerDrag = null; // {mode:"scrub"|"loop-new"|"loop-a"|"loop-b", startBeat}

  // 一部環境（合成イベント・古いブラウザ）で例外を投げるため握りつぶす
  function capture(el, ev) {
    try { el.setPointerCapture(ev.pointerId); } catch (e) {}
  }

  function wireRuler() {
    const ruler = document.getElementById("ruler");

    ruler.addEventListener("pointerdown", (ev) => {
      const beat = clampBeat(V.beatAt(ev.offsetX));
      capture(ruler, ev);

      // 既存ループのブラケットをつかむ（指のときは判定を広く）
      const bHit = ev.pointerType === "touch" ? 22 : BRACKET_HIT;
      if (S.loop) {
        if (Math.abs(ev.offsetX - V.x(S.loop.a)) <= bHit) {
          rulerDrag = { mode: "loop-a" }; return;
        }
        if (Math.abs(ev.offsetX - V.x(S.loop.b)) <= bHit) {
          rulerDrag = { mode: "loop-b" }; return;
        }
      }
      if (ev.altKey) {
        rulerDrag = { mode: "loop-new", startBeat: snapBeat(beat) };
        H.setLoop({ a: snapBeat(beat), b: snapBeat(beat) + 1 });
        return;
      }
      rulerDrag = { mode: "scrub" };
      H.seek(snap16(beat) * spb());
      ev.preventDefault();
    });

    ruler.addEventListener("pointermove", (ev) => {
      if (!rulerDrag) {
        // ブラケットの上ではつかめることを示す
        let cur = "col-resize";
        if (S.loop && (Math.abs(ev.offsetX - V.x(S.loop.a)) <= BRACKET_HIT ||
                       Math.abs(ev.offsetX - V.x(S.loop.b)) <= BRACKET_HIT)) cur = "ew-resize";
        ruler.style.cursor = cur;
        return;
      }
      const beat = clampBeat(V.beatAt(ev.offsetX));
      if (rulerDrag.mode === "scrub") {
        H.seek(snap16(beat) * spb());
      } else if (rulerDrag.mode === "loop-new") {
        const a = Math.min(rulerDrag.startBeat, snapBeat(beat));
        const b = Math.max(rulerDrag.startBeat + 1, snapBeat(beat));
        H.setLoop({ a, b: Math.max(b, a + 1) });
      } else if (rulerDrag.mode === "loop-a") {
        H.setLoop({ a: Math.min(snapBeat(beat), S.loop.b - 1), b: S.loop.b });
      } else if (rulerDrag.mode === "loop-b") {
        H.setLoop({ a: S.loop.a, b: Math.max(snapBeat(beat), S.loop.a + 1) });
      }
    });

    const end = () => { rulerDrag = null; };
    ruler.addEventListener("pointerup", end);
    ruler.addEventListener("pointercancel", end);
  }

  /* ---------- ナビゲーター帯の操作: 窓をつかむ/伸ばす、外を突くと移動＋シーク ---------- */

  let navDrag = null; // {mode:"pan"|"zoom-l"|"zoom-r"|"seek", grabBeat, fixedBeat}

  function wireNav() {
    const nav = document.getElementById("navigator");

    nav.addEventListener("pointerdown", (ev) => {
      const x = ev.offsetX;
      const vp = viewportBeats();
      const wx1 = navX(vp.a), wx2 = navX(vp.b);
      capture(nav, ev);

      const hHit = ev.pointerType === "touch" ? 26 : HANDLE_HIT;
      if (Math.abs(x - wx1) <= hHit) {
        navDrag = { mode: "zoom-l", fixedBeat: vp.b };
      } else if (Math.abs(x - wx2) <= hHit) {
        navDrag = { mode: "zoom-r", fixedBeat: vp.a };
      } else if (x > wx1 && x < wx2) {
        navDrag = { mode: "pan", grabBeat: beatAtNav(x) - vp.a };
      } else {
        // 窓の外 = その場所へシーク（設計方針: ナビゲーターのクリックはシーク）
        navDrag = { mode: "seek" };
        H.seek(snap16(clampBeat(beatAtNav(x))) * spb(), { center: true });
      }
      ev.preventDefault();
    });

    nav.addEventListener("pointermove", (ev) => {
      if (!navDrag) {
        const vp = viewportBeats();
        const wx1 = navX(vp.a), wx2 = navX(vp.b);
        const x = ev.offsetX;
        nav.style.cursor =
          (Math.abs(x - wx1) <= HANDLE_HIT || Math.abs(x - wx2) <= HANDLE_HIT) ? "ew-resize" :
          (x > wx1 && x < wx2) ? "grab" : "pointer";
        return;
      }
      const x = ev.offsetX;
      const sa = H.scrollArea();

      if (navDrag.mode === "pan") {
        const beat = beatAtNav(x) - navDrag.grabBeat;
        sa.scrollLeft = (V.preBeats + beat) * V.PPB;
        nav.style.cursor = "grabbing";
      } else if (navDrag.mode === "seek") {
        H.seek(snap16(clampBeat(beatAtNav(x))) * spb(), { center: true });
      } else {
        // 窓の端を引いて伸縮 = ズーム。反対側の端の拍を固定する。
        const beat = clampBeat(beatAtNav(x));
        let span = navDrag.mode === "zoom-l" ? navDrag.fixedBeat - beat : beat - navDrag.fixedBeat;
        span = Math.max(2, span);
        const ppb = V.setPPB(sa.clientWidth / span);
        const left = navDrag.mode === "zoom-l"
          ? (V.preBeats + navDrag.fixedBeat) * ppb - sa.clientWidth
          : (V.preBeats + navDrag.fixedBeat) * ppb;
        H.applyZoom(ppb, left);
      }
    });

    const end = () => { navDrag = null; };
    nav.addEventListener("pointerup", end);
    nav.addEventListener("pointercancel", end);
  }

  /* ---------- 初期化 ---------- */

  function init(state, handlers) {
    S = state;
    H = handlers;
    wireRuler();
    wireNav();
  }

  return { init, drawRuler, drawNav, RULER_H, NAV_H };
})();
