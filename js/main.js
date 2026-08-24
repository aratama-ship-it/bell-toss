/* 投鈴 — 全体制御
   再生カーソル（state.pos）は常設: 止めても消えず、その場から稽古を再開できる。
   ループ（state.loop）は「この区間を反復して稽古する」ための範囲（拍単位）。 */
"use strict";

(() => {
  const V = TOREI.view;

  const state = {
    melody: { bpm: 96, beatsPerBar: 4, notes: [] },
    cfg: { nPerformers: 3, flight: 1.2, wakiCap: 1, maxDup: 2, allowShake: true, standTime: 2.0, passMode: "more" },
    result: null,
    pos: 0,      // 再生カーソル（シミュレーション秒。0 = 曲頭、負 = 準備）
    loop: null,  // {a, b} 拍。null = ループなし
  };

  let playing = false;
  let playBase = 0;   // AudioContext上の再生開始時刻
  let playT0 = 0;     // シミュレーション上の開始時刻
  let rafId = null;
  let navRaf = 0;
  let saveTimer = null;
  let hlEls = [];      // 行動表の「今どの行動が進行中か」ハイライト（演者×手の数だけ）

  const $ = (id) => document.getElementById(id);
  const spb = () => 60 / state.melody.bpm;

  function songEndT() {
    const last = state.melody.notes.reduce((m, n) => Math.max(m, n.beat), 0);
    return last * spb() + 2.5;
  }

  /* ---------- 再計算と描画 ---------- */

  function recompute() {
    stopPlayback();
    // 小節操作以外の編集が入ったら「取り消す」を無効化する。
    // 古いスナップショットで新しい編集ごと巻き戻す事故を防ぐため
    if (!inBarOp && typeof invalidateBarUndo === "function" && barSnapshot) invalidateBarUndo();
    state.result = TOREI.schedule(state.melody, state.cfg);
    const sp = spb();
    V.preBeats = Math.ceil(Math.max(0, -state.result.minT) / sp + 0.001);
    // 楽譜の幅は曲の長さに合わせる（64拍固定だと長い曲の後半が描画されない）
    const last = state.melody.notes.reduce((m, n) => Math.max(m, n.beat), 0);
    V.TOTAL_BEATS = Math.max(64, Math.ceil((last + 8) / 4) * 4);
    V.clampPPB();
    clampPos();
    drawAll();
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      const sel = $("sel-preset");
      const option = sel && sel.options[sel.selectedIndex];
      if (!sel || !option) return;
      TOREI.songfile.save(TOREI.songfile.serialize(state, sel.value, option.textContent));
    }, 400);
  }

  function clampPos() {
    state.pos = Math.max(-V.preBeats * spb(), Math.min(V.TOTAL_BEATS * spb(), state.pos));
  }

  function drawAll() {
    TOREI.pianoroll.draw(state);
    TOREI.pianoroll.drawGutter(state);
    TOREI.timeline.draw(state);
    TOREI.timeline.buildGutter(state, () => recompute());
    TOREI.nav.drawRuler();
    TOREI.stage.prepare(state);
    TOREI.stage.render(state.pos);
    renderSummary();
    renderWarnings();
    buildHighlightEls();
    buildCueSheet();
    updatePlayheadEl();
    updateActionHighlight();
    updateReadout();
    updateZoomUI();
    scheduleNavDraw();
  }

  /* ---------- Qシート（演者ごとの手順。2026-08-23） ----------
     演者1人分の行動だけを時刻順の表にする。稽古で「自分は何をするか」を覚えるための
     インターフェース。再生中は今の行を追いかけてスクロールする。
     データは TOREI.cueSheet（scheduler側）が作り、ここは表にするだけ。 */
  let cuePerf = 0;       // いま表示している演者
  let cueRows = [];      // {t, until, tr} 再生ハイライト用
  let cueLastIdx = -1;

  function buildCueSheet() {
    const tabs = $("cuesheet-tabs");
    const body = $("cuesheet-body");
    if (!tabs || !body) return;
    if (cuePerf >= state.cfg.nPerformers) cuePerf = 0;
    // タブ（演者名は編集可能なので毎回作り直す）
    tabs.innerHTML = "";
    for (let i = 0; i < state.cfg.nPerformers; i++) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "cue-tab";
      b.setAttribute("role", "tab");
      b.setAttribute("aria-selected", String(i === cuePerf));
      b.textContent = TOREI.perfName(i);
      b.addEventListener("click", () => { cuePerf = i; buildCueSheet(); });
      tabs.appendChild(b);
    }
    // 本体
    cueRows = [];
    cueLastIdx = -1;
    if (!state.result) { body.innerHTML = ""; return; }
    const rows = TOREI.cueSheet(state.result, state.melody, state.cfg, cuePerf);
    const table = document.createElement("table");
    table.className = "cue-table";
    table.innerHTML = "<thead><tr><th>小節</th><th>時刻</th><th>手</th><th>すること</th></tr></thead>";
    const tbody = document.createElement("tbody");
    for (const r of rows) {
      const tr = document.createElement("tr");
      if (r.t < 0) tr.className = "cue-prep";
      if (r.kind === "catch") tr.classList.add("cue-catch");
      const td = (cls, text) => {
        const el = document.createElement("td");
        el.className = cls;
        el.textContent = text;
        tr.appendChild(el);
      };
      td("cue-bar", r.bar || "準備");
      td("cue-time", r.label);
      td("cue-hand", r.hand);
      td("cue-text", r.text);
      tbody.appendChild(tr);
      cueRows.push({ t: r.t, until: Math.max(r.until, r.t + 0.4), tr });
    }
    table.appendChild(tbody);
    body.innerHTML = "";
    body.appendChild(table);
    updateCueHighlight();
  }

  // 再生位置の行を強調し、視界に持ってくる（毎フレーム呼ばれるので差分だけ触る）
  function updateCueHighlight() {
    if (!cueRows.length) return;
    const t = state.pos;
    // 「今まさに実行中」の行。無ければ直近に過ぎた行を光らせておく（次の行の予告より
    // 「いま何をしているか」を優先する）
    let idx = -1;
    for (let i = 0; i < cueRows.length; i++) {
      if (cueRows[i].t > t + 1e-6) break;
      idx = i;
    }
    if (idx === cueLastIdx) return;
    if (cueLastIdx >= 0) cueRows[cueLastIdx].tr.classList.remove("cue-now");
    cueLastIdx = idx;
    if (idx >= 0) {
      const tr = cueRows[idx].tr;
      tr.classList.add("cue-now");
      // 追従スクロールはQシートの箱（#cuesheet-body）の中だけで行う。
      // scrollIntoView はページ全体まで動かしてしまい、再生中に画面が下へずれて
      // 上部の舞台ビューが見えなくなる（2026-08-23 本人指摘で発覚）
      if (playing) {
        const box = $("cuesheet-body");
        box.scrollTop = tr.offsetTop - box.clientHeight / 2 + tr.offsetHeight / 2;
      }
    }
  }

  // ズーム変更時: スケジュール計算は変わらないので楽譜側だけ描き直す
  function redrawScore() {
    TOREI.pianoroll.draw(state);
    TOREI.timeline.draw(state);
    TOREI.nav.drawRuler();
    updatePlayheadEl();
    updateActionHighlight();
    scheduleNavDraw();
  }

  // 行動表の「今どの行動が進行中か」ハイライト。演者×手の数だけDOM要素を作っておき、
  // 毎フレームは位置(left/top)だけを書き換える——幅6000px超にもなる行動表Canvasを
  // 毎フレーム全体再描画するコストを避けるため（design-system.md 項目8）。
  function buildHighlightEls() {
    for (const item of hlEls) item.el.remove();
    hlEls = [];
    const sa = $("scroll-area");
    for (let p = 0; p < state.cfg.nPerformers; p++) {
      for (let h = 0; h < 2; h++) {
        const el = document.createElement("div");
        el.className = "action-hl";
        sa.appendChild(el);
        hlEls.push({ el, perf: p, hand: h });
      }
    }
  }

  // 演者pの手hについて、時刻pos（シミュレーション秒）に進行中の全アクションを探す。
  // 保持キャッチ和音は同じ(演者,手,時刻)に2件（held/new）重なるため配列で返す。
  // dur:0（和音の相方）は一瞬すぎて見えないので、表示用に最小幅を与える。
  function activeActions(perf, hand, pos) {
    const acts = state.result ? state.result.actions : [];
    const found = [];
    for (const a of acts) {
      if (a.perf !== perf || a.hand !== hand) continue;
      const dur = Math.max(a.dur || 0, 0.12);
      if (pos >= a.t - 1e-6 && pos <= a.t + dur + 1e-6) found.push(a);
    }
    return found;
  }

  function updateActionHighlight() {
    if (!state.result) return;
    const timelineTop = TOREI.nav.RULER_H + V.prHeight + 2;
    const sp = spb();
    for (const { el, perf, hand } of hlEls) {
      const acts = activeActions(perf, hand, state.pos);
      if (!acts.length) { el.style.display = "none"; continue; }
      // 複数（和音）のときは矩形の和集合を1つのハイライトとして囲む
      let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
      for (const a of acts) {
        const box = TOREI.timeline.layoutAction(a, sp);
        if (!box) continue;
        x1 = Math.min(x1, box.x); y1 = Math.min(y1, box.y);
        x2 = Math.max(x2, box.x + box.w); y2 = Math.max(y2, box.y + box.h);
      }
      if (x1 === Infinity) { el.style.display = "none"; continue; }
      el.style.display = "block";
      el.style.left = x1 + "px";
      el.style.top = (timelineTop + perf * TOREI.timeline.BAND_H + y1) + "px";
      el.style.width = (x2 - x1) + "px";
      el.style.height = (y2 - y1) + "px";
    }
  }

  function scheduleNavDraw() {
    if (navRaf) return;
    navRaf = requestAnimationFrame(() => { navRaf = 0; TOREI.nav.drawNav(); });
  }

  function updatePlayheadEl() {
    const ph = $("playhead");
    ph.hidden = false;
    ph.style.height = (TOREI.nav.RULER_H + V.prHeight + 2 +
      TOREI.timeline.height(state.cfg.nPerformers)) + "px";
    ph.style.left = (V.x(state.pos / spb()) - 0.75) + "px";
  }

  function updateReadout() {
    const el = $("pos-readout");
    if (!el) return;
    const t = state.pos;
    const bpb = state.melody.beatsPerBar || 4;
    const beat = t / spb();
    let posTxt;
    if (beat < -0.001) {
      posTxt = `準備 −${(-t).toFixed(1)}秒`;
    } else {
      const bar = Math.floor(beat / bpb) + 1;
      const bi = Math.floor(beat - (bar - 1) * bpb) + 1;
      posTxt = `${bar}小節 ${bi}拍`;
    }
    const tt = Math.max(0, t);
    const m = Math.floor(tt / 60);
    const s = (tt - m * 60).toFixed(1).padStart(4, "0");
    const text = `${posTxt}　${m}:${s}`;
    el.textContent = text;
    if (!playing) {
      const sr = $("pos-sr");
      const ll = loopLabel();
      if (sr) sr.textContent = ll ? `${text}　${ll}` : text;
    }
  }

  function loopLabel() {
    if (!state.loop) return "";
    const bpb = state.melody.beatsPerBar || 4;
    const fmt = (beat) => {
      const bar = Math.floor(beat / bpb) + 1;
      const bi = Math.floor(beat - (bar - 1) * bpb) + 1;
      return `${bar}小節 ${bi}拍`;
    };
    return `ループ ${fmt(state.loop.a)} から ${fmt(state.loop.b)}`;
  }

  // 読み上げ専用領域への通知。再生中は位置表示が毎フレーム変わるので黙る。
  function announce(text) {
    if (playing) return;
    const sr = $("pos-sr");
    if (sr) sr.textContent = text;
  }

  function updateZoomUI() {
    const sl = $("inp-zoom");
    if (!sl) return;
    sl.min = V.PPB_MIN;
    sl.max = V.maxPPB();
    sl.value = V.PPB;
    sl.setAttribute("aria-valuetext", `1拍あたり${Math.round(V.PPB)}ピクセル`);
  }

  // 滞空時間から最高到達点を出す（h = g*t^2/8）。投げの現実味を確かめるための表示。
  // 拍子セレクタ。値を書き込む全経路（曲選択・JSON・MIDI読み込み）から呼ぶ。
  // MIDIには 7/8 など選択肢にない拍子もあり得るので、そのときは動的に選択肢を足す
  function setMeterUI(bpb) {
    const sel = $("sel-meter");
    if (![...sel.options].some(o => +o.value === bpb)) {
      const o = document.createElement("option");
      o.value = bpb;
      o.textContent = `${bpb}拍子`;
      sel.appendChild(o);
    }
    sel.value = bpb;
  }

  // テンポはスライダー。つまみの位置と数値表示を必ず一緒に動かす
  function setBpmUI(bpm) {
    $("inp-bpm").value = bpm;
    $("bpm-val").textContent = bpm;
  }

  function updateFlightHeight() {
    const t = state.cfg.flight;
    const h = TOREI.throwHeightM(t);
    // 稽古で声に出すのは秒数ではなく段階。「高さ4で」と言えるように段を主役にする
    $("flight-height").textContent =
      `＝ 高さ${TOREI.throwLevel(t)}（頭上 約${h.toFixed(1)}m ／ 床から 約${(h + 1.4).toFixed(1)}m）`;
  }

  function renderSummary() {
    const el = $("ring-summary");
    if (!state.result || state.result.rings.length === 0) {
      el.innerHTML = "音符を置くと、必要なリングの内訳がここに出ます。";
      return;
    }
    // 同時に手元へ置ける本数の上限 = 人数 ×（手2本 + 脇の本数）。
    // これを超えるとスタンド往復が必須になり、速い曲では投げが間に合わなくなる。
    const capacity = state.cfg.nPerformers * (2 + state.cfg.wakiCap);
    const need = state.result.rings.length;
    const rings = state.result.rings;
    const byOwner = {};
    for (const r of rings) {
      const h = r.home != null ? r.home : r.owner;
      (byOwner[h] = byOwner[h] || []).push(r.label);
    }
    const parts = [];
    for (let i = 0; i < state.cfg.nPerformers; i++) {
      if (byOwner[i]) parts.push(`${TOREI.perfName(i)}: ${byOwner[i].join("・")}`);
    }
    const cap = need > capacity
      ? `<span class="cap-over">手元の上限 ${capacity}本を超過（${state.cfg.nPerformers}人 × 手2+脇${state.cfg.wakiCap}）— 演者を増やすかテンポを落としてください</span>`
      : `<span class="cap-ok">手元の上限 ${capacity}本以内</span>`;
    el.innerHTML = `必要リング <b>${need}本</b> ${cap} ｜ ${parts.join(" ／ ")}`;
  }

  // 警告は「読むもの」ではなく「飛ぶもの」。稽古中に破綻箇所を潰していく道具なので、
  // 1行クリックでその瞬間へシークし、楽譜も画面内へ持ってくる。
  function renderWarnings() {
    const el = $("warnings");
    const ws = state.result ? state.result.warnings : [];
    if (!ws.length) { el.hidden = true; return; }
    el.hidden = false;
    const esc = (t) => t.replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
    const rows = ws.slice(0, 8).map((w, i) =>
      `<button type="button" class="warn-jump" data-w="${i}" title="この箇所へ移動">⚠ ${esc(w.msg)}</button>`);
    if (ws.length > 8) rows.push(`<div class="warn-more">…他 ${ws.length - 8} 件</div>`);
    el.innerHTML = rows.join("");
    el.querySelectorAll(".warn-jump").forEach(btn => {
      btn.addEventListener("click", () => jumpToWarning(ws[+btn.dataset.w]));
    });
  }

  function jumpToWarning(w) {
    if (!w) return;
    stopPlayback();
    seek(w.t, { center: true });          // その瞬間を楽譜の中央に置く
    const area = $("score-area");
    // 警告は楽譜より上（狭い画面では下）にあるので、楽譜自体を画面内へ運ぶ
    const box = area.getBoundingClientRect();
    if (box.top < 0 || box.top > window.innerHeight * 0.5) {
      window.scrollTo({ top: box.top + window.scrollY - 12, behavior: "smooth" });
    }
    flashPlayhead();
  }

  // 飛んだ先が分かるように、プレイヘッドを一瞬強調する
  function flashPlayhead() {
    const ph = $("playhead");
    ph.classList.remove("flash");
    void ph.offsetWidth;   // アニメーションを再起動させるための強制リフロー
    ph.classList.add("flash");
  }

  /* ---------- 再生 ---------- */

  // simT 秒から鳴らす（ループ中は終端より先の音を予約しない）
  // ループの巻き戻しは描画（rAF）ではなくタイマーで行う。タブが裏に回って
  // rAFが止まっても、耳で合わせる稽古（音だけ流し続ける）が途切れないように。
  let loopTimer = null;

  // simT 秒から鳴らす。baseTime を指定すると「その音声時刻ちょうどに simT が来る」よう
  // 予約する（ループの継ぎ目用。省略時は今+0.08秒＝新規再生）。
  function scheduleFrom(simT, baseTime) {
    const ctx = TOREI.audio.ensure();
    const fresh = baseTime == null;
    // 継ぎ目ではセッションを張り替えない。張り替えると前の周の残響と、
    // 先行予約より後ろにある前の周の末尾の音が切れてしまう
    if (fresh) TOREI.audio.beginSession();
    playT0 = simT;
    playBase = fresh ? ctx.currentTime + 0.08 : baseTime;
    const loopEnd = state.loop ? state.loop.b * spb() : Infinity;
    for (const a of state.result.actions) {
      if ((a.type === "catch" || a.type === "shake") && a.t >= simT - 1e-3 && a.t < loopEnd) {
        TOREI.audio.bell(a.midi, playBase + (a.t - simT), a.type === "shake" ? 0.7 : 1);
      }
    }
    clearTimeout(loopTimer);
    loopTimer = null;
    if (state.loop) {
      // ★音ズレ修正（2026-08-23 本人報告）: 次の周は「前の周の音声時刻の続き」
      // ちょうど（nextBase）に予約する。以前は巻き戻しタイマーが発火した時刻+0.08秒を
      // 新しい基準にしていたため、設計上1周ごとに必ず80ms+タイマー誤差の遅れが挟まり、
      // ループのたびにリズムがもたついた。
      // タイマーは境界より0.35秒早く起こして先行予約する。タイマーが遅れても音声時刻の
      // 基準はずれない（遅れた分は最初の音が詰まるだけで、周回誤差は蓄積しない）。
      const nextBase = playBase + (loopEnd - simT);
      const delay = Math.max(0, (nextBase - ctx.currentTime - 0.35) * 1000);
      loopTimer = setTimeout(() => {
        if (playing && state.loop) scheduleFrom(state.loop.a * spb(), nextBase);
      }, delay);
    }
  }

  function playStartPos() {
    if (state.loop) {
      const a = state.loop.a * spb(), b = state.loop.b * spb();
      return (state.pos < a - 1e-3 || state.pos >= b - 1e-3) ? a : state.pos;
    }
    // カーソルが曲頭・曲末にあるときは準備の動きから見せる
    const prepStart = Math.max(-4, Math.min(0, state.result.minT)) - 0.4;
    if (Math.abs(state.pos) <= 1e-3 || state.pos >= songEndT() - 0.01) return prepStart;
    return state.pos;
  }

  function startPlayback() {
    if (!state.result) return;
    const from = playStartPos();
    playing = true;
    scheduleFrom(from);
    state.pos = from;
    $("btn-play").textContent = "■ 停止";
    $("btn-play").classList.add("playing");
    $("btn-play").setAttribute("aria-pressed", "true");

    const scroll = $("scroll-area");
    const endT = songEndT();

    const tick = () => {
      if (!playing) return;
      const ctx = TOREI.audio.ctx;
      // 出力遅延の補正（2026-08-23 本人報告「通常再生でも音ズレ」への対応）。
      // Bluetoothイヤホン等では音がスピーカーに届くまで0.1〜0.3秒かかり、
      // 補正しないと映像（プレイヘッド・舞台）が音より先に動いて「ズレ」に見える。
      // 表示は「いま耳に聞こえている音」の位置に合わせる
      const lat = ctx.outputLatency || ctx.baseLatency || 0;
      let pos = playT0 + (ctx.currentTime - playBase) - lat;
      // 次の周を先行予約した直後は playBase が未来（境界時刻）を指す。境界を越えるまでは
      // 前の周の続きの位置として表示すると、プレイヘッドが途切れず境界を通過する。
      // 条件の playT0 >= loop.a は、再生中にループ開始より前へシークした場合
      // （playT0 がループ外）を誤って巻き込まないため
      if (state.loop) {
        const La = state.loop.a * spb();
        if (pos < La - 1e-6 && playT0 >= La - 1e-6) {
          pos += (state.loop.b - state.loop.a) * spb();
        }
      }
      state.pos = pos;
      TOREI.stage.render(pos);
      updatePlayheadEl();
      updateActionHighlight();
      updateCueHighlight();
      updateReadout();
      scheduleNavDraw();
      const x = V.x(pos / spb());
      // 再生位置が見えるように追従スクロール
      if (x < scroll.scrollLeft + 40 || x > scroll.scrollLeft + scroll.clientWidth - 120) {
        scroll.scrollLeft = Math.max(0, x - 120);
      }
      if (!state.loop && pos > endT) { stopPlayback(); return; }
      rafId = requestAnimationFrame(tick);
    };
    rafId = requestAnimationFrame(tick);
  }

  function stopPlayback() {
    if (rafId) cancelAnimationFrame(rafId);
    rafId = null;
    clearTimeout(loopTimer);
    loopTimer = null;
    if (playing) TOREI.audio.endSession();
    playing = false;
    const b = $("btn-play");
    if (b) {
      b.textContent = "▶ 再生";
      b.classList.remove("playing");
      b.setAttribute("aria-pressed", "false");
    }
    // カーソルは消さない: 止めた場所が次の稽古の起点になる
    if (state.result) TOREI.stage.render(state.pos);
    updateReadout();
    scheduleNavDraw();
  }

  /* ---------- シーク・ズーム・ループ ---------- */

  // 曲頭（＝停止中のカーソル位置）が必ず見えるところまで横スクロールする。
  // 準備ゾーンは曲によって6〜27拍と幅があり、0にすると曲頭が右の画面外に出る。
  function scrollToSongHead() {
    const sa = $("scroll-area");
    sa.scrollLeft = Math.max(0, V.x(0) - 48);
  }

  function seek(t, opts) {
    state.pos = t;
    clampPos();
    if (state.result) TOREI.stage.render(state.pos);
    updatePlayheadEl();
    updateActionHighlight();
    updateCueHighlight();
    updateReadout();
    scheduleNavDraw();
    const sa = $("scroll-area");
    const x = V.x(state.pos / spb());
    if (opts && opts.center) {
      sa.scrollLeft = Math.max(0, x - sa.clientWidth / 2);
    } else if (x < sa.scrollLeft + 6 || x > sa.scrollLeft + sa.clientWidth - 6) {
      sa.scrollLeft = Math.max(0, x - sa.clientWidth / 2);
    }
    if (playing) scheduleFrom(state.pos);
  }

  // ppb は設定済みの値、scrollLeft はズーム後の位置（ナビゲーターの窓伸縮から呼ばれる）
  function applyZoom(ppb, scrollLeft) {
    redrawScore();
    updateZoomUI();
    if (scrollLeft != null) $("scroll-area").scrollLeft = Math.max(0, scrollLeft);
  }

  // 基準点（プレイヘッドが見えていればそこ、なければ画面中央/指定位置）の拍を固定してズーム
  function zoomTo(target, anchorCssX) {
    const sa = $("scroll-area");
    let ax = anchorCssX;
    if (ax == null) {
      const px = V.x(state.pos / spb()) - sa.scrollLeft;
      ax = (px >= 0 && px <= sa.clientWidth) ? px : sa.clientWidth / 2;
    }
    const anchorBeat = (sa.scrollLeft + ax) / V.PPB - V.preBeats;
    const ppb = V.setPPB(target);
    applyZoom(ppb, (V.preBeats + anchorBeat) * ppb - ax);
  }

  function setLoop(l) {
    const had = !!state.loop;   // 曲切替のたびに「ループ解除」と読み上げないため
    state.loop = l;
    $("btn-loop-clear").hidden = !l;
    $("btn-loop-bar").classList.toggle("active", !!l);
    const hit = $("ruler-hit");
    if (hit) {
      hit.setAttribute("aria-label",
        l ? loopLabel() : "再生位置のルーラー（option+ドラッグでループ範囲）");
    }
    TOREI.nav.drawRuler();
    scheduleNavDraw();
    updateReadout();                       // 読み上げ領域にループ範囲を反映
    if (had && !l) announce("ループ解除");  // 解除は位置表示だけでは伝わらない
    if (playing) {
      const from = l && (state.pos < l.a * spb() || state.pos >= l.b * spb())
        ? l.a * spb() : state.pos;
      scheduleFrom(from);
      state.pos = from;
    }
  }

  function loopCurrentBar() {
    const bpb = state.melody.beatsPerBar || 4;
    const beat = Math.max(0, state.pos / spb());
    const a = Math.min(Math.floor(beat / bpb) * bpb, V.TOTAL_BEATS - bpb);
    setLoop({ a, b: a + bpb });
    if (!playing) seek(a * spb());
  }

  /* ---------- 小節の挿入・削除（2026-08-23 本人要望） ----------
     どちらも再生位置の小節が対象。削除は音符が消える破壊的操作なので、
     直前の状態を1段だけ持ち「取り消す」で戻せるようにする。
     スナップショットは小節操作の間だけ有効で、他の編集（音符ドラッグ・
     曲切替など）が入った時点で無効化する（古い状態へ巻き戻す事故を防ぐ）。 */
  let barSnapshot = null;   // { notes, loop, pos }
  let inBarOp = false;      // recompute に「小節操作中」を伝えるフラグ

  function invalidateBarUndo() {
    barSnapshot = null;
    $("btn-bar-undo").hidden = true;
  }

  function takeBarSnapshot() {
    barSnapshot = {
      notes: state.melody.notes.map(n => ({ beat: n.beat, midi: n.midi })),
      loop: state.loop ? { ...state.loop } : null,
      pos: state.pos,
    };
    $("btn-bar-undo").hidden = false;
  }

  function insertBar() {
    const EPS = 1e-6;
    const bpb = state.melody.beatsPerBar || 4;
    stopPlayback();
    const beat = Math.max(0, state.pos / spb());
    const a = Math.floor(beat / bpb) * bpb;
    takeBarSnapshot();
    inBarOp = true;
    for (const n of state.melody.notes) if (n.beat >= a - EPS) n.beat += bpb;
    if (state.loop) {
      const l = { ...state.loop };
      if (l.a >= a - EPS) l.a += bpb;
      if (l.b > a + EPS) l.b += bpb;
      setLoop(l);
    }
    recompute();
    seek(a * spb(), { center: true });
    inBarOp = false;
    showNotice(`${a / bpb + 1}小節目に空の小節を挿入しました（以降を1小節後ろへ）`);
  }

  function deleteBar() {
    const EPS = 1e-6;
    const bpb = state.melody.beatsPerBar || 4;
    stopPlayback();
    const beat = Math.max(0, state.pos / spb());
    const a = Math.floor(beat / bpb) * bpb;
    const b = a + bpb;
    takeBarSnapshot();
    inBarOp = true;
    const kept = [];
    let removed = 0;
    for (const n of state.melody.notes) {
      if (n.beat >= a - EPS && n.beat < b - EPS) { removed++; continue; }
      if (n.beat >= b - EPS) n.beat -= bpb;
      kept.push(n);
    }
    state.melody.notes = kept;
    if (state.loop) {
      const l = { ...state.loop };
      // 消した小節にかかるループは意味が変わるので解除。完全に後ろなら前へつめる
      if (l.a < b - EPS && l.b > a + EPS) setLoop(null);
      else if (l.a >= b - EPS) setLoop({ a: l.a - bpb, b: l.b - bpb });
    }
    recompute();
    seek(a * spb(), { center: true });
    inBarOp = false;
    showNotice(`${a / bpb + 1}小節目を削除しました（音符${removed}個・以降を1小節前へ）`);
  }

  function undoBarOp() {
    if (!barSnapshot) return;
    stopPlayback();
    inBarOp = true;
    state.melody.notes = barSnapshot.notes;
    setLoop(barSnapshot.loop);
    recompute();
    seek(barSnapshot.pos, { center: true });
    inBarOp = false;
    invalidateBarUndo();
    showNotice("小節操作を取り消しました");
  }

  /* ---------- 楽譜編集 ---------- */

  // ドラッグ編集の状態。音符の上で押すと掴む、空白で押すと新規追加してそのまま掴む。
  let drag = null;

  function posAt(ev) {
    const beatRaw = V.beatAt(ev.offsetX);
    const midi = V.midiAt(ev.offsetY);
    return { beatRaw, beat: Math.round(beatRaw * 4) / 4, midi };
  }

  function findNote(beat, midi) {
    return state.melody.notes.findIndex(
      n => n.midi === midi && Math.abs(n.beat - beat) < 0.26);
  }

  function onRollDown(ev) {
    const { beatRaw, beat, midi } = posAt(ev);
    if (beatRaw < -0.01) return; // 準備ゾーンは編集不可
    if (midi < V.PITCH_MIN || midi > V.PITCH_MAX) return;

    const i = findNote(beat, midi);
    if (i >= 0) {
      drag = { i, moved: false, startBeat: state.melody.notes[i].beat, startMidi: midi };
    } else {
      state.melody.notes.push({ beat, midi });
      TOREI.audio.bell(midi, 0, 0.6);
      drag = { i: state.melody.notes.length - 1, moved: true, startBeat: beat, startMidi: midi };
      recompute();
    }
    ev.preventDefault();
  }

  function onRollMove(ev) {
    if (!drag) {
      // ドラッグしていないときは、音符の上でカーソルを変える
      const { beat, midi } = posAt(ev);
      $("pianoroll").style.cursor = findNote(beat, midi) >= 0 ? "grab" : "crosshair";
      return;
    }
    const { beatRaw, beat, midi } = posAt(ev);
    if (beatRaw < -0.01 || midi < V.PITCH_MIN || midi > V.PITCH_MAX) return;
    const n = state.melody.notes[drag.i];
    if (!n) return;
    if (n.beat === beat && n.midi === midi) return;
    if (n.midi !== midi) TOREI.audio.bell(midi, 0, 0.5); // 音高が変わったら鳴らす
    n.beat = beat;
    n.midi = midi;
    drag.moved = true;
    $("pianoroll").style.cursor = "grabbing";
    TOREI.pianoroll.draw(state); // ドラッグ中は楽譜だけ即描画（再計算は離したとき）
  }

  function onRollUp() {
    if (!drag) return;
    const d = drag;
    drag = null;
    $("pianoroll").style.cursor = "crosshair";
    if (!d.moved) {
      // 動かさずに離した = 削除
      state.melody.notes.splice(d.i, 1);
    }
    recompute();
  }

  /* ---------- MIDIファイルの読み込み ---------- */

  // 標準MIDIファイルを読み、最も音数の多いトラックをメロディとして取り込む
  function parseMidi(buf) {
    const v = new DataView(buf);
    let pos = 0;
    const str = (n) => { let s = ""; for (let i = 0; i < n; i++) s += String.fromCharCode(v.getUint8(pos++)); return s; };
    if (str(4) !== "MThd") throw new Error("MIDIファイルではありません");
    const headLen = v.getUint32(pos); pos += 4;
    v.getUint16(pos); pos += 2;                 // format
    const nTracks = v.getUint16(pos); pos += 2;
    const division = v.getUint16(pos); pos += 2;
    pos += headLen - 6;
    if (division & 0x8000) throw new Error("SMPTE形式のMIDIには未対応です");

    let usPerQuarter = 500000;                  // 既定120BPM
    let beatsPerBar = 4;
    const tracks = [];

    for (let t = 0; t < nTracks; t++) {
      if (str(4) !== "MTrk") break;
      const len = v.getUint32(pos); pos += 4;
      const end = pos + len;
      let tick = 0, running = 0;
      const on = {};       // midi -> tick
      const notes = [];
      while (pos < end) {
        // デルタタイム
        let delta = 0, b;
        do { b = v.getUint8(pos++); delta = (delta << 7) | (b & 0x7f); } while (b & 0x80);
        tick += delta;

        let status = v.getUint8(pos);
        if (status & 0x80) { pos++; running = status; } else { status = running; }
        const type = status & 0xf0;

        if (status === 0xff) {
          const meta = v.getUint8(pos++);
          let mlen = 0;
          do { b = v.getUint8(pos++); mlen = (mlen << 7) | (b & 0x7f); } while (b & 0x80);
          if (meta === 0x51 && mlen === 3) {
            usPerQuarter = (v.getUint8(pos) << 16) | (v.getUint8(pos + 1) << 8) | v.getUint8(pos + 2);
          } else if (meta === 0x58 && mlen >= 2) {
            beatsPerBar = v.getUint8(pos);
          }
          pos += mlen;
        } else if (status === 0xf0 || status === 0xf7) {
          let mlen = 0;
          do { b = v.getUint8(pos++); mlen = (mlen << 7) | (b & 0x7f); } while (b & 0x80);
          pos += mlen;
        } else if (type === 0x90 || type === 0x80) {
          const note = v.getUint8(pos++);
          const vel = v.getUint8(pos++);
          if (type === 0x90 && vel > 0) { on[note] = tick; }
          else if (on[note] !== undefined) { notes.push({ tick: on[note], midi: note }); delete on[note]; }
        } else if (type === 0xa0 || type === 0xb0 || type === 0xe0) {
          pos += 2;
        } else if (type === 0xc0 || type === 0xd0) {
          pos += 1;
        } else {
          pos = end; // 解釈できないバイト列。このトラックは打ち切る
        }
      }
      pos = end;
      if (notes.length) tracks.push(notes);
    }

    if (!tracks.length) throw new Error("音符が見つかりませんでした");
    // 最も音数の多いトラックをメロディとみなす
    tracks.sort((a, b) => b.length - a.length);
    const src = tracks[0];
    const bpm = Math.round(60000000 / usPerQuarter);
    const notes = src.map(n => ({ beat: n.tick / division, midi: n.midi }))
      .sort((a, b) => a.beat - b.beat || a.midi - b.midi);
    // 開始位置を0拍に寄せ、16分単位へ丸める
    const first = notes.length ? notes[0].beat : 0;
    for (const n of notes) n.beat = Math.round((n.beat - first) * 4) / 4;
    return { bpm, beatsPerBar, notes };
  }

  function onMidiFile(ev) {
    const file = ev.target.files && ev.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const m = parseMidi(reader.result);
        // 音域が広すぎる場合は表示範囲へ収める（オクターブ単位で寄せる）
        let over = 0;
        for (const n of m.notes) {
          while (n.midi > V.PITCH_MAX) { n.midi -= 12; over++; }
          while (n.midi < V.PITCH_MIN) { n.midi += 12; over++; }
        }
        state.melody = { bpm: Math.max(30, Math.min(200, m.bpm)),
                         beatsPerBar: m.beatsPerBar, notes: m.notes };
        setBpmUI(state.melody.bpm);
        setMeterUI(state.melody.beatsPerBar || 4);
        $("sel-preset").value = "blank";
        state.pos = 0;
        setLoop(null);
        recompute(); // 楽譜の幅は recompute が曲の長さから決める
        scrollToSongHead();
        const msg = `${file.name} を読み込みました（${m.notes.length}音 / ${state.melody.bpm}BPM）`
          + (over ? ` ※音域外の${over}音をオクターブ移動しました` : "");
        showNotice(msg);
      } catch (e) {
        showNotice("読み込めませんでした: " + e.message, true);
      }
      ev.target.value = ""; // 同じファイルを再選択できるように
    };
    reader.readAsArrayBuffer(file);
  }

  function showNotice(text, isError) {
    const el = $("notice");
    el.textContent = text;
    el.hidden = false;
    el.classList.toggle("error", !!isError);
    clearTimeout(showNotice._t);
    showNotice._t = setTimeout(() => { el.hidden = true; }, 6000);
  }

  /* ---------- 曲データの保存・復元 ---------- */

  function applySongData(data) {
    state.melody = {
      bpm: data.bpm,
      beatsPerBar: data.beatsPerBar,
      notes: data.notes.map(n => ({ beat: n.beat, midi: n.midi })),
    };
    state.cfg.nPerformers = data.performers;
    state.cfg.flight = data.flight;
    state.cfg.wakiCap = data.wakiCap;
    state.cfg.maxDup = data.maxDup;
    state.cfg.allowShake = data.allowShake;
    state.cfg.standTime = data.standTime;
    state.cfg.passMode = data.passMode;

    setBpmUI(data.bpm);
    setMeterUI(data.beatsPerBar || 4);
    $("inp-performers").value = data.performers;
    $("inp-flight").value = data.flight;
    $("flight-val").textContent = data.flight.toFixed(2);
    $("inp-waki").value = data.wakiCap;
    $("inp-stand").value = data.standTime;
    $("sel-pass").value = data.passMode;
    $("inp-dup").value = data.maxDup;
    $("inp-shake").checked = data.allowShake;
    updateFlightHeight();

    // 非表示の曲を選択状態にはできない（<option>自体が無い）ので、
    // 実際にドロップダウンへ出ている選択肢かどうかで判定する
    const sel = $("sel-preset");
    sel.value = [...sel.options].some(o => o.value === data.id) ? data.id : "blank";
    state.pos = 0;
    setLoop(null);
    recompute();
    scrollToSongHead();
  }

  function downloadSongData() {
    const sel = $("sel-preset");
    const option = sel.options[sel.selectedIndex];
    const id = sel.value;
    const obj = TOREI.songfile.serialize(state, id, option ? option.textContent : "");
    const blob = new Blob([JSON.stringify(obj, null, 1)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = id ? `torei_${id}.json` : "torei_melody.json";
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  }

  function onJsonFile(ev) {
    const file = ev.target.files && ev.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const data = JSON.parse(reader.result);
        const reason = TOREI.songfile.validate(data);
        if (reason) throw new Error(reason);
        applySongData(data);
        showNotice(`${file.name} を読み込みました（${data.notes.length}音 / ${data.bpm}BPM）`);
      } catch (e) {
        showNotice("読み込めませんでした: " + e.message, true);
      }
      ev.target.value = "";
    };
    reader.onerror = () => {
      showNotice("読み込めませんでした: ファイルの読み取りに失敗しました", true);
      ev.target.value = "";
    };
    reader.readAsText(file);
  }

  /* ---------- 初期化 ---------- */

  function loadPreset(id) {
    const p = TOREI.PRESETS.find(x => x.id === id) || TOREI.PRESETS[0];
    state.melody = {
      bpm: p.bpm,
      beatsPerBar: p.beatsPerBar,
      notes: p.notes.map(n => ({ beat: n.beat, midi: n.midi })),
    };
    setBpmUI(p.bpm);
    setMeterUI(p.beatsPerBar || 4);
    // 曲ごとの推奨設定（検証済みの成立条件）を自動で当てる
    if (p.performers) {
      state.cfg.nPerformers = p.performers;
      $("inp-performers").value = p.performers;
    }
    if (p.passMode) {
      state.cfg.passMode = p.passMode;
      $("sel-pass").value = p.passMode;
    }
    if (p.standTime) {
      state.cfg.standTime = p.standTime;
      $("inp-stand").value = p.standTime;
    }
    if (p.flight) {
      // 速い曲は滞空を短く（低く速い投げ）。遅い曲は高く大きな投げ
      state.cfg.flight = p.flight;
      $("inp-flight").value = p.flight;
      $("flight-val").textContent = p.flight.toFixed(2);
      updateFlightHeight();
    }
    // 同音リング最大。全曲が明示した値を持つ（2026-08-24修正）ので無条件に反映する。
    // 「指定が無ければ引き継ぐ」流儀（flight等と同じ）にしていたら、ぶんぶんぶんの
    // maxDup=1を見た後に他の曲へ切り替えると、その曲が本来必要とする値に戻らず
    // 再生不可能になる事故が起きた（実機で11曲を確認）。
    state.cfg.maxDup = p.maxDup || 2;
    $("inp-dup").value = state.cfg.maxDup;
    state.pos = 0;
    setLoop(null);
    recompute();
    scrollToSongHead();
  }

  /* ---------- キーボード ---------- */

  function onKey(ev) {
    const tag = ev.target.tagName;
    if (tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA") return;
    if (ev.code === "Space") {
      ev.preventDefault();
      playing ? stopPlayback() : startPlayback();
    } else if (ev.key === "ArrowLeft" || ev.key === "ArrowRight") {
      ev.preventDefault();
      const bpb = state.melody.beatsPerBar || 4;
      const step = (ev.shiftKey ? bpb : 0.25) * (ev.key === "ArrowLeft" ? -1 : 1);
      const beat = Math.round((state.pos / spb() + step) * 4) / 4;
      seek(beat * spb());
    } else if (ev.key === "Home") {
      ev.preventDefault();
      seek(0, { center: true });
    }
  }

  function init() {
    const sel = $("sel-preset");
    // 4人以上前提の曲は選べなくする（2026-08-23 本人指示）。データ自体は
    // TOREI.SONGS / tools/analyze.mjs 側にそのまま残るので、後で戻すのも解析も可能
    for (const p of TOREI.PRESETS) {
      if (p.hidden) continue;
      const o = document.createElement("option");
      o.value = p.id;
      o.textContent = p.name;
      sel.appendChild(o);
    }
    sel.addEventListener("change", () => loadPreset(sel.value));

    TOREI.nav.init(state, {
      seek,
      setLoop,
      applyZoom,
      scrollArea: () => $("scroll-area"),
    });

    $("btn-play").addEventListener("click", () => playing ? stopPlayback() : startPlayback());
    $("btn-clear").addEventListener("click", () => { state.melody.notes = []; setLoop(null); recompute(); });
    $("btn-midi").addEventListener("click", () => {
      if (!state.result) return;
      const name = TOREI.PRESETS.find(p => p.id === sel.value);
      TOREI.midi.download(state.melody, state.result, state.cfg,
        `torei_${name ? name.id : "melody"}.mid`);
    });
    $("btn-copy").addEventListener("click", async () => {
      if (!state.result) return;
      const text = TOREI.actionText(state.result, state.melody, state.cfg);
      try {
        await navigator.clipboard.writeText(text);
        const b = $("btn-copy");
        const old = b.textContent;
        b.textContent = "コピーしました ✓";
        setTimeout(() => (b.textContent = old), 1500);
      } catch (e) {
        window.prompt("コピーできない環境のため、手動でコピーしてください:", text.slice(0, 500));
      }
    });
    $("btn-save-json").addEventListener("click", downloadSongData);
    $("btn-open-json").addEventListener("click", () => $("inp-json-file").click());
    $("inp-json-file").addEventListener("change", onJsonFile);

    // 狭い画面での二次操作の畳み込み（デスクトップではボタン自体が非表示なので無関係）
    $("btn-more-toggle").addEventListener("click", () => {
      const more = $("transport-more");
      const open = more.classList.toggle("open");
      $("btn-more-toggle").setAttribute("aria-expanded", String(open));
      $("btn-more-toggle").textContent = open ? "操作を閉じる ▴" : "その他の操作 ▾";
    });

    // ズームとループ
    $("btn-zoom-out").addEventListener("click", () => zoomTo(V.PPB / 1.3));
    $("btn-zoom-in").addEventListener("click", () => zoomTo(V.PPB * 1.3));
    $("inp-zoom").addEventListener("input", () => zoomTo(+$("inp-zoom").value));
    $("btn-loop-bar").addEventListener("click", loopCurrentBar);
    $("btn-loop-clear").addEventListener("click", () => setLoop(null));
    $("btn-bar-insert").addEventListener("click", insertBar);
    $("btn-bar-delete").addEventListener("click", deleteBar);
    $("btn-bar-undo").addEventListener("click", undoBarOp);

    $("inp-bpm").addEventListener("input", () => {
      state.melody.bpm = Math.max(30, Math.min(200, +$("inp-bpm").value || 90));
      $("bpm-val").textContent = state.melody.bpm;
      recompute();
    });
    $("sel-meter").addEventListener("change", () => {
      // 音符の時刻は拍のまま動かさない。小節の数え方（ルーラー・読み出し・
      // 「この小節を反復」・Shift+矢印）だけが新しい拍子に切り替わる
      state.melody.beatsPerBar = +$("sel-meter").value || 4;
      recompute();
    });
    $("inp-performers").addEventListener("change", () => {
      state.cfg.nPerformers = Math.max(1, Math.min(5, +$("inp-performers").value || 3));
      recompute();
    });
    $("inp-flight").addEventListener("input", () => {
      state.cfg.flight = +$("inp-flight").value;
      $("flight-val").textContent = state.cfg.flight.toFixed(2);
      updateFlightHeight();
      recompute();
    });
    $("inp-waki").addEventListener("change", () => {
      state.cfg.wakiCap = Math.max(0, Math.min(3, +$("inp-waki").value || 0));
      recompute();
    });
    $("inp-stand").addEventListener("change", () => {
      state.cfg.standTime = Math.max(1, Math.min(8, +$("inp-stand").value || 2));
      recompute();
    });
    $("sel-pass").addEventListener("change", () => {
      state.cfg.passMode = $("sel-pass").value;
      recompute();
    });
    $("inp-dup").addEventListener("change", () => {
      state.cfg.maxDup = Math.max(1, Math.min(3, +$("inp-dup").value || 1));
      recompute();
    });
    $("inp-shake").addEventListener("change", () => {
      state.cfg.allowShake = $("inp-shake").checked;
      recompute();
    });

    const roll = $("pianoroll");
    roll.addEventListener("mousedown", onRollDown);
    roll.addEventListener("mousemove", onRollMove);
    window.addEventListener("mouseup", onRollUp);
    $("inp-midi-file").addEventListener("change", onMidiFile);
    $("btn-load-midi").addEventListener("click", () => $("inp-midi-file").click());

    // スクロール・ホイール・中ボタンドラッグ
    const sa = $("scroll-area");
    sa.addEventListener("scroll", scheduleNavDraw, { passive: true });
    sa.addEventListener("wheel", (ev) => {
      // ⌘/Ctrl+ホイール（トラックパッドのピンチ含む）= ポインタ位置基準のズーム
      if (ev.ctrlKey || ev.metaKey) {
        ev.preventDefault();
        const rect = sa.getBoundingClientRect();
        zoomTo(V.PPB * Math.pow(1.0015, -ev.deltaY), ev.clientX - rect.left);
        return;
      }
      // Shift+ホイール = 横パン。縦ホイールしかないマウスでも楽譜を送れるようにする
      // （既定のままだとページ全体が縦に動いてしまい、楽譜は止まったままになる）
      if (ev.shiftKey) {
        const d = Math.abs(ev.deltaX) > Math.abs(ev.deltaY) ? ev.deltaX : ev.deltaY;
        if (!d) return;
        ev.preventDefault();
        sa.scrollLeft += d;
      }
    }, { passive: false });

    let panDrag = null;
    sa.addEventListener("mousedown", (ev) => {
      if (ev.button !== 1) return;
      panDrag = { x: ev.clientX, left: sa.scrollLeft };
      ev.preventDefault();
    });
    window.addEventListener("mousemove", (ev) => {
      if (!panDrag) return;
      sa.scrollLeft = panDrag.left - (ev.clientX - panDrag.x);
    });
    window.addEventListener("mouseup", () => { panDrag = null; });

    window.addEventListener("keydown", onKey);

    window.addEventListener("resize", () => {
      if (state.result) { TOREI.stage.prepare(state); TOREI.stage.render(state.pos); }
      scheduleNavDraw();
    });

    updateFlightHeight();
    // URLで曲を指定できる（?song=bunbun）。クライアントに「この曲をセットした状態」で
    // リンクを送るための入口。指定があれば自動保存の復元より優先する
    const wanted = new URLSearchParams(location.search).get("song");
    if (wanted && [...sel.options].some(o => o.value === wanted)) {
      sel.value = wanted;   // loadPresetはセレクタ表示を触らない（change経由の設計）ので明示する
      loadPreset(wanted);
      return;
    }
    const saved = TOREI.songfile.load();
    if (saved && !TOREI.songfile.validate(saved)) {
      applySongData(saved);
      // 復元した中身が元の曲と違うなら、曲セレクタは「白紙」に戻す。
      // 同じ曲名が選ばれたままだと、それを選び直しても change イベントが出ず
      // 元の曲に戻せない（セレクタの表示が嘘になる）。
      const src = TOREI.PRESETS.find(p => p.id === saved.id);
      const edited = !src || src.bpm !== saved.bpm ||
        src.notes.length !== saved.notes.length ||
        src.notes.some((n, i) => n.beat !== saved.notes[i].beat || n.midi !== saved.notes[i].midi);
      if (edited) $("sel-preset").value = "blank";
      showNotice(edited && src
        ? `前回の続き（「${src.name}」を編集したもの）を復元しました。曲を選び直すと破棄されます`
        : "前回の続きを復元しました。曲を選び直すと破棄されます");
    } else {
      loadPreset("saints");
    }
  }

  document.addEventListener("DOMContentLoaded", init);
})();
