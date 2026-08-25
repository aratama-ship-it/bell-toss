/* 投鈴 — 舞台ビュー
   白いホールと大窓を思わせる背景に、細線の演者・リング・放物線・キャッチの波紋を描く。 */
"use strict";

TOREI.stage = (() => {
  let scene = null; // prepare() の結果

  // 舞台の寸法はCSSが持つ（幅=親、高さ=#stage-wrap の --stage-h）。
  // canvas自身の clientWidth/Height は setupCanvas が書いたインラインstyle＝
  // 「前回描いたときの寸法」なので、ここで読むと縮小方向のリサイズを取りこぼす。
  function stageBox() {
    const wrap = document.getElementById("stage").parentElement;
    const h = parseFloat(getComputedStyle(wrap).getPropertyValue("--stage-h"));
    return { W: wrap.clientWidth, H: (h > 0 ? h : 360) };
  }

  function prepare(state) {
    const { W, H } = stageBox();
    const n = state.cfg.nPerformers;
    const floorY = H - 34;
    const handY = floorY - 74;

    const perfs = [];
    for (let i = 0; i < n; i++) {
      const x = (W * (i + 1)) / (n + 1);
      perfs.push({
        id: i,          // ソロ表示のフィルタで使う
        x, floorY, handY,
        hands: [ { x: x - 20, y: handY }, { x: x + 20, y: handY } ],
        standX: x + 50,
        wakiX: x - 10, wakiY: floorY - 88,
        slots: 0,
      });
    }

    const rings = (state.result ? state.result.rings : []).map(r => ({
      id: r.id, midi: r.midi, owner: r.home != null ? r.home : r.owner, label: r.label,
      slot: perfs[r.home != null ? r.home : r.owner] ? perfs[r.home != null ? r.home : r.owner].slots++ : 0,
      segments: [], // {t0,t1,kind:'still'|'move'|'air', from:{x,y}, to:{x,y}, h}
    }));

    const posStand = (perfIdx, ring) => {
      const p = perfs[perfIdx];
      const col = Math.floor(ring.slot / 4);
      const row = ring.slot % 4;
      return { x: p.standX + col * 26, y: p.floorY - 104 + row * 26 };
    };
    const posWaki = (perfIdx, ring) => {
      // 脇に挟んだリングは体側に密着（横から見るので細い楕円に見える）
      const p = perfs[perfIdx];
      return { x: p.wakiX - (ring.id % 2) * 5, y: p.wakiY };
    };
    const posHand = (perfIdx, hand) => {
      const p = perfs[perfIdx];
      return { x: p.hands[hand].x, y: p.hands[hand].y };
    };

    const effects = []; // {t, x, y, midi, kind:'catch'|'shake'}
    const PREP = TOREI.SCHED.PREP;

    // アクション列から、各リングの位置セグメントを組み立てる
    const byRing = {};
    for (const a of (state.result ? state.result.actions : [])) {
      (byRing[a.ring] = byRing[a.ring] || []).push(a);
    }

    for (const ring of rings) {
      let cur = { kind: "still", pos: posStand(ring.owner, ring), since: PREP, loc: "stand" };
      const segs = ring.segments;
      const closeStill = (until) => {
        if (until > cur.since) segs.push({ t0: cur.since, t1: until, kind: "still", from: cur.pos, to: cur.pos, loc: cur.loc });
      };
      for (const a of (byRing[ring.id] || [])) {
        if (a.type === "pickup") {
          closeStill(a.t);
          const to = posHand(a.perf, a.hand);
          segs.push({ t0: a.t, t1: a.t + a.dur, kind: "move", from: cur.pos, to, loc: "move" });
          cur = { kind: "still", pos: to, since: a.t + a.dur, loc: "hand" };
        } else if (a.type === "store") {
          closeStill(a.t);
          const to = a.to === "waki" ? posWaki(a.perf, ring)
            : a.to === "otherhand" ? posHand(a.perf, 1 - a.hand)
            : posStand(a.perf, ring);
          segs.push({ t0: a.t, t1: a.t + a.dur, kind: "move", from: cur.pos, to, loc: "move" });
          cur = { kind: "still", pos: to, since: a.t + a.dur,
                  loc: a.to === "otherhand" ? "hand" : a.to };
        } else if (a.type === "throw") {
          closeStill(a.t);
          const cpPerf = a.catchPerf != null ? a.catchPerf : a.perf;
          const hp = posHand(a.perf, a.hand);
          const cp = posHand(cpPerf, a.catchHand != null ? a.catchHand : a.hand);
          const from = { x: hp.x, y: hp.y };
          const to = { x: cp.x, y: cp.y };
          if (Math.abs(from.x - to.x) < 2) { from.x -= 6; to.x += 6; } // 自分の同じ手へは軽くずらす
          // 高さは物理式 h = g*t^2/8。演者の身長(124px≒1.7m)を基準に画素へ換算する。
          // 距離で高さを足すのは非現実的なのでしない（パスは低く速く飛ぶ）。
          const PX_PER_M = 124 / 1.7;
          const h = (9.8 * a.flight * a.flight / 8) * PX_PER_M;
          // fromPerf/toPerf はソロ表示（1人分の拡大）で「この人に関係する飛球か」を判定するのに使う
          segs.push({ t0: a.t, t1: a.t + a.flight, kind: "air", from, to, h, loc: "air",
                      fromPerf: a.perf, toPerf: cpPerf });
          cur = { kind: "still", pos: { x: cp.x, y: cp.y }, since: a.t + a.flight, loc: "hand" };
        } else if (a.type === "catch") {
          const hp = posHand(a.perf, a.hand);
          effects.push({ t: a.t, x: hp.x, y: hp.y, midi: a.midi, kind: "catch", perf: a.perf });
        } else if (a.type === "shake") {
          const hp = posHand(a.perf, a.hand);
          effects.push({ t: a.t, x: hp.x, y: hp.y, midi: a.midi, kind: "shake", perf: a.perf });
        }
      }
      closeStill(1e9);
    }

    scene = { W, H, floorY, perfs, rings, effects, state };
  }

  function ringPos(ring, t) {
    for (const s of ring.segments) {
      if (t >= s.t0 && t < s.t1) {
        if (s.kind === "still") return { x: s.from.x, y: s.from.y, seg: s };
        const u = (t - s.t0) / (s.t1 - s.t0);
        if (s.kind === "move") {
          return { x: s.from.x + (s.to.x - s.from.x) * u, y: s.from.y + (s.to.y - s.from.y) * u, seg: s };
        }
        // air: 放物線
        const x = s.from.x + (s.to.x - s.from.x) * u;
        const y = s.from.y - s.h * 4 * u * (1 - u);
        return { x, y, seg: s };
      }
    }
    const last = ring.segments[ring.segments.length - 1];
    return last ? { x: last.to.x, y: last.to.y, seg: last } : null;
  }

  function drawWakiRing(ctx, x, y, midi) {
    // 横から見た（脇に挟まれた）リング: 細い縦長の楕円
    ctx.strokeStyle = TOREI.pitchColor(midi, 0.95);
    ctx.lineWidth = 2.4;
    ctx.beginPath();
    ctx.ellipse(x, y, 3, 11, 0, 0, Math.PI * 2);
    ctx.stroke();
  }

  function drawRing(ctx, x, y, midi, r) {
    ctx.strokeStyle = TOREI.pitchColor(midi, 0.95);
    ctx.lineWidth = 2.4;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.stroke();
    // リング内のベル（真鍮色の小さな棒）
    ctx.strokeStyle = "#a9822f";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(x - r * 0.55, y);
    ctx.lineTo(x + r * 0.55, y);
    ctx.stroke();
    ctx.fillStyle = "#a9822f";
    ctx.beginPath();
    ctx.arc(x, y + 2.5, 2.2, 0, Math.PI * 2);
    ctx.fill();
  }

  // labels: 手・脇・スタンドにあるリングへ音名を添えるか。
  // リングは音高の色で描き分けているだけなので、止まっている間は文字でも読めた方がよい
  // （開演時に誰が何を持つのかを確かめる用途。2026-08-25 本人要望）。
  // 動いている間は出さない。飛球が増えると文字が重なって読めなくなるため。
  let showLabels = false;
  function setLabels(on) { showLabels = !!on; }

  function render(t) {
    if (!scene) return;
    const canvas = document.getElementById("stage");
    const { W, H } = stageBox();
    if (scene.W !== W || scene.H !== H) prepare(scene.state); // 寸法が変わったら組み直し
    const ctx = TOREI.pianoroll.setupCanvas(canvas, W, H);
    drawScene(ctx, t, W, H, null);
  }

  /* 1人分だけを拡大して別のcanvasへ描く（Qシートのモーダル用。2026-08-25）。
     舞台の座標系は prepare() が全演者ぶんで組んでいるので、そこから作り直すのではなく
     「対象演者を中心に平行移動して拡大する」変換を掛けて、描画ロジックをそのまま使う。
     こうすれば本番の舞台ビューと見た目が完全に一致する（別実装だと必ずズレる）。 */
  function renderSolo(canvas, t, perfId, cssW, cssH) {
    if (!scene) return;
    const p = scene.perfs[perfId];
    if (!p) return;
    const ctx = TOREI.pianoroll.setupCanvas(canvas, cssW, cssH);
    // 1人分の見せ場が収まる範囲。投げの放物線は頭上へ大きく伸びる（滞空1.4秒で
    // 頭上約2.4m≒175px）ので、縦は体（124px）＋投げの高さ＋余白で見積もる。
    // 体（頭上124px＋床まで）と両手・スタンドが気持ちよく収まる大きさを優先する。
    // 投げの放物線は頭上へ大きく伸びるが、全部を入れると演者が小さくなりすぎるので
    // 上に少し余白を取るだけにして、軌道は上端で切れてよい（所作を覚えるのが目的）。
    const spanW = 250, spanH = 250;
    const scale = Math.min(cssW / spanW, cssH / spanH);
    ctx.save();
    // 対象演者を中心に。スタンド(x+50)と脇(x-10)の中間が視覚的な重心
    const cx = p.x + 20;
    const cy = scene.floorY - 80;
    ctx.translate(cssW / 2, cssH / 2);
    ctx.scale(scale, scale);
    ctx.translate(-cx, -cy);
    drawScene(ctx, t, cssW, cssH, perfId);
    ctx.restore();
  }

  // perfFilter が数値なら、その演者に関係する要素だけを描く
  function drawScene(ctx, t, W, H, perfFilter) {
    const { floorY, perfs, rings, effects } = scene;
    const solo = perfFilter != null;

    // --- 背景: 大窓 ---（ソロ表示では拡大で画面外になるので省く）
    if (!solo) {
    const winW = Math.min(W * 0.62, 560);
    const winX = (W - winW) / 2;
    const winY = 20, winH = floorY - 46;
    ctx.fillStyle = "rgba(255,255,255,0.5)";
    ctx.fillRect(winX, winY, winW, winH);
    ctx.strokeStyle = "rgba(44,49,58,0.13)";
    ctx.lineWidth = 1.5;
    ctx.strokeRect(winX, winY, winW, winH);
    ctx.lineWidth = 0.75;
    for (let i = 1; i < 6; i++) {
      const gx = winX + (winW * i) / 6;
      ctx.beginPath(); ctx.moveTo(gx, winY); ctx.lineTo(gx, winY + winH); ctx.stroke();
    }
    for (let i = 1; i < 8; i++) {
      const gy = winY + (winH * i) / 8;
      ctx.beginPath(); ctx.moveTo(winX, gy); ctx.lineTo(winX + winW, gy); ctx.stroke();
    }

    }

    // 床（ソロ表示では対象演者の周りだけ）
    ctx.strokeStyle = "rgba(44,49,58,0.3)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    if (solo) {
      const p0 = perfs[perfFilter];
      ctx.moveTo(p0.x - 130, floorY + 0.5);
      ctx.lineTo(p0.x + 130, floorY + 0.5);
    } else {
      ctx.moveTo(0, floorY + 0.5);
      ctx.lineTo(W, floorY + 0.5);
    }
    ctx.stroke();

    // --- リング位置を先に解決（腕の描画に使う） ---
    const positions = rings.map(r => ringPos(r, t));

    // --- スタンド ---
    for (const p of perfs) {
      if (solo && p.id !== perfFilter) continue;
      ctx.strokeStyle = "rgba(44,49,58,0.4)";
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(p.standX, floorY);
      ctx.lineTo(p.standX, floorY - 118);
      ctx.stroke();
      // 三脚
      ctx.beginPath();
      ctx.moveTo(p.standX - 9, floorY); ctx.lineTo(p.standX, floorY - 14);
      ctx.lineTo(p.standX + 9, floorY);
      ctx.stroke();
    }

    // --- 演者 ---
    for (let i = 0; i < perfs.length; i++) {
      if (solo && i !== perfFilter) continue;
      const p = perfs[i];
      ctx.strokeStyle = "#3d5578";
      ctx.lineWidth = 2.2;
      ctx.lineCap = "round";
      // 頭
      ctx.beginPath();
      ctx.arc(p.x, floorY - 124, 8.5, 0, Math.PI * 2);
      ctx.stroke();
      // 体
      ctx.beginPath();
      ctx.moveTo(p.x, floorY - 114);
      ctx.lineTo(p.x, floorY - 56);
      ctx.stroke();
      // 脚
      ctx.beginPath();
      ctx.moveTo(p.x, floorY - 56); ctx.lineTo(p.x - 10, floorY);
      ctx.moveTo(p.x, floorY - 56); ctx.lineTo(p.x + 10, floorY);
      ctx.stroke();
      // 腕: 手にリングがあればそこへ、なければ基本位置へ
      for (let h = 0; h < 2; h++) {
        let target = { x: p.hands[h].x, y: p.hands[h].y };
        for (let ri = 0; ri < rings.length; ri++) {
          const r = rings[ri], pos = positions[ri];
          // owner ではなく位置で判定する（owner は最終的な持ち主で、パス後の所在と
          // 食い違う。owner で絞ると、パスで受け取ったリングへ腕が伸びない）
          if (!pos) continue;
          const s = pos.seg;
          const inHand = (s.kind === "still" && Math.abs(pos.x - p.hands[h].x) < 12 && Math.abs(pos.y - p.hands[h].y) < 12)
            || (s.kind === "move" && Math.abs(s.to.x - p.hands[h].x) < 12 && Math.abs(s.to.y - p.hands[h].y) < 12);
          if (inHand) target = { x: pos.x, y: pos.y };
        }
        ctx.beginPath();
        ctx.moveTo(p.x, floorY - 104);
        ctx.lineTo(target.x, target.y);
        ctx.stroke();
      }
      // 名札
      ctx.font = "11px 'Hiragino Sans', sans-serif";
      ctx.textAlign = "center";
      // 名札はクリックで編集できる。押せる場所だと分かるよう、うっすら下線を敷く
      const nm = TOREI.perfName(i);
      if (!solo) {
        const w = ctx.measureText(nm).width;
        ctx.strokeStyle = "rgba(44,49,58,0.18)";
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(p.x - w / 2, floorY + 19.5);
        ctx.lineTo(p.x + w / 2, floorY + 19.5);
        ctx.stroke();
      }
      ctx.fillStyle = "rgba(44,49,58,0.55)";
      ctx.fillText(nm, p.x, floorY + 16);
      ctx.textAlign = "left";
    }

    // --- リング ---
    for (let ri = 0; ri < rings.length; ri++) {
      const r = rings[ri], pos = positions[ri];
      if (!pos) continue;
      // ソロ表示は「実際に描かれる位置が対象演者の視野に入っているか」だけで判定する。
      // ★ring.owner で絞ってはいけない: owner は曲の最終的な持ち主を指す静的な値で、
      // パスで持ち主が移った後も元の値のままではない（＝その時刻の所在を表さない）。
      // 位置で判定すれば、手・脇・スタンド・飛球のすべてを一貫して扱える。
      if (solo) {
        const p0 = perfs[perfFilter];
        if (Math.abs(pos.x - p0.x) > 125) continue;   // 1人分の視野の外
      }
      // 空中のリングは軌道もうっすら描く
      if (pos.seg.kind === "air") {
        const s = pos.seg;
        ctx.strokeStyle = TOREI.pitchColor(r.midi, 0.22);
        ctx.lineWidth = 1;
        ctx.setLineDash([2, 4]);
        ctx.beginPath();
        for (let u = 0; u <= 1.001; u += 0.05) {
          const x = s.from.x + (s.to.x - s.from.x) * u;
          const y = s.from.y - s.h * 4 * u * (1 - u);
          u === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
        }
        ctx.stroke();
        ctx.setLineDash([]);
      }
      if (pos.seg.loc === "waki") drawWakiRing(ctx, pos.x, pos.y, r.midi);
      else drawRing(ctx, pos.x, pos.y, r.midi, 11);
      if (showLabels && pos.seg.kind !== "air") {
        ctx.font = "bold 10px 'Hiragino Sans', sans-serif";
        ctx.textAlign = "center";
        // 背景の線とぶつかっても読めるよう、白で縁取ってから塗る
        ctx.lineWidth = 3;
        ctx.strokeStyle = "rgba(255,255,255,0.9)";
        ctx.strokeText(r.label, pos.x, pos.y - 15);
        ctx.fillStyle = TOREI.pitchColor(r.midi, 1);
        ctx.fillText(r.label, pos.x, pos.y - 15);
        ctx.textAlign = "left";
        ctx.lineWidth = 1;
      }
    }

    // 脇にリングを挟んでいる演者には「脇」ラベル
    for (let i = 0; i < perfs.length; i++) {
      if (solo && i !== perfFilter) continue;
      const p = perfs[i];
      // 位置で判定する（owner は最終的な持ち主で、その時刻の所在を表さない）
      const hasWaki = rings.some((r, ri) => positions[ri] && positions[ri].seg.loc === "waki"
        && Math.abs(positions[ri].x - p.wakiX) < 30);
      if (hasWaki) {
        ctx.font = "9.5px 'Hiragino Sans', sans-serif";
        ctx.fillStyle = "rgba(44,49,58,0.5)";
        ctx.textAlign = "center";
        ctx.fillText("脇", p.wakiX - 4, p.wakiY + 24);
        ctx.textAlign = "left";
      }
    }

    // --- キャッチの波紋と音名 ---
    for (const e of effects) {
      if (solo && e.perf != null && e.perf !== perfFilter) continue;
      const age = t - e.t;
      if (age < 0 || age > 1.1) continue;
      if (age < 0.6) {
        const rr = 10 + age * 55;
        ctx.strokeStyle = e.kind === "shake"
          ? `rgba(178,71,46,${0.5 * (1 - age / 0.6)})`
          : `rgba(169,130,47,${0.55 * (1 - age / 0.6)})`;
        ctx.lineWidth = 1.6;
        ctx.beginPath();
        ctx.arc(e.x, e.y, rr, 0, Math.PI * 2);
        ctx.stroke();
      }
      const alpha = Math.max(0, 1 - age / 1.1);
      ctx.font = "600 15px 'Hiragino Mincho ProN', serif";
      ctx.fillStyle = `rgba(169,130,47,${alpha})`;
      ctx.textAlign = "center";
      ctx.fillText("♪" + TOREI.noteName(e.midi), e.x, e.y - 24 - age * 18);
      ctx.textAlign = "left";
    }
  }

  /* 名札の位置（CSSピクセル）。舞台はcanvasなので、名前を直接クリックして
     編集できるようにするには当たり判定を外へ出す必要がある（2026-08-26 本人要望）。
     setupCanvas がcanvasのCSS寸法を W×H に合わせているので、描画座標＝CSS座標。 */
  function nameBoxes() {
    if (!scene) return [];
    return scene.perfs.map((p, i) => ({
      perf: i, w: 76, h: 20,
      x: p.x - 38,                 // fillText は textAlign=center で p.x に描いている
      y: scene.floorY + 16 - 11,   // ベースラインの少し上から
    }));
  }
  function nameAt(x, y) {
    for (const b of nameBoxes()) {
      if (x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + b.h) return b;
    }
    return null;
  }

  return { prepare, render, renderSolo, setLabels, nameBoxes, nameAt };
})();
