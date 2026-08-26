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

  // パス率の目安。これを下回ると ring-summary で警告色になる（2026-08-25 本人指定）
  const PASS_TARGET = 20;

  // 手動の音ズレ補正（秒）。Safariは outputLatency を実装しておらず、Bluetooth等の
  // 出力遅延を自動検出できない（2026-08-25 本人報告: Safariのみ映像が音より先行）。
  // 自動で測れないものは較正してもらうしかないので、端末ごとの設定として持つ。
  // 曲データには含めない（環境の性質であって曲の性質ではない）。
  let avSync = 0;
  try { avSync = Math.max(0, Math.min(0.4, +(localStorage.getItem("torei.avSync") || 0))) || 0; } catch (e) {}

  const $ = (id) => document.getElementById(id);
  const spb = () => 60 / state.melody.bpm;

  function songEndT() {
    const last = state.melody.notes.reduce((m, n) => Math.max(m, n.beat), 0);
    return last * spb() + 2.5;
  }

  /* ---------- 再計算と描画 ---------- */

  // 確定済み編成（seed）を使ってよいかの判定。
  // 曲を読み込んだ時点の楽譜・設定に対してだけ有効で、1音でも動かしたら捨てる。
  // 「編集した箇所を直す」のを忘れる事故が起きないよう、個々の編集操作に手を入れるのではなく
  // 署名を突き合わせて自動で外す（編集の入口はドラッグ・キー・小節操作・MIDI読込と多い）。
  let seedSig = null, frozenSeed = null, frozenResult = null;
  function stateSig() {
    const c = state.cfg;
    return JSON.stringify([
      state.melody.bpm, state.melody.beatsPerBar,
      state.melody.notes.map(n => [n.beat, n.midi, n.fix || null]),
      c.nPerformers, c.flight, c.wakiCap, c.maxDup, c.maxRings || null, c.allowShake, c.standTime, c.passMode,
      c.effort || null,
    ]);
  }
  function freezeSeed(seed, frozen) {
    frozenSeed = seed == null ? null : seed;
    state.cfg.seed = frozenSeed;
    seedSig = (frozenSeed == null && !frozen) ? null : stateSig();
    // 完成曲は振付データそのものを持つ（seed再現ではなく再生。2026-08-26）。
    // スケジューラーを改良しても完成曲の振付が変わらない唯一の保証
    frozenResult = frozen || null;
  }

  function recompute() {
    stopPlayback();
    // 楽譜か設定が変わっている間だけ、確定編成を外して探索に切り替える。
    // 編集を元に戻せば確定編成へ復帰する（外しっぱなしにすると、戻したのに
    // 配布版と違う振り付けのまま、という分かりにくい状態になる）。
    const sigIntact = seedSig != null && stateSig() === seedSig;
    if (frozenSeed != null) state.cfg.seed = sigIntact ? frozenSeed : null;
    // 小節操作以外の編集が入ったら「取り消す」を無効化する。
    // 古いスナップショットで新しい編集ごと巻き戻す事故を防ぐため
    if (!inBarOp && typeof invalidateBarUndo === "function" && barSnapshot) invalidateBarUndo();
    // 再計算でスケジュールが別物になるので、開きっぱなしのモーダルは閉じる
    // （古い動作列のまま操作させない）
    if (soloOpen) closeSolo();
    if (frozenResult && sigIntact) {
      // 完成曲: 焼き付けた振付（js/frozen.js）をそのまま再生する。再計算しない
      state.result = structuredClone(frozenResult);
    } else {
      state.result = TOREI.schedule(state.melody, state.cfg);
    }
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

  // 演者名の変更を画面に反映する（2026-08-26 本人要望で上部からも編集できるようにした）。
  // ★recompute() を呼ばない。名前は振付に一切影響しないので、組み直す必要がないうえ、
  // 楽譜を編集済み（確定編成が外れている状態）だと探索が走って待たされる。
  function applyRename(i, name) {
    TOREI.setPerfName(i, name);
    TOREI.timeline.draw(state);
    TOREI.timeline.buildGutter(state, applyRename);
    TOREI.stage.render(state.pos);
    renderSummary();
    renderStartLayout();
    renderEffort();
    renderWarnings();
    buildCueSheet();
    if (soloOpen) $("solo-title").textContent = `${TOREI.perfName(soloPerf)} の動き`;
  }

  /* ダイヤグラム（行動表）上で人間が組み直す（2026-08-26 本人要望）。
     投げの白抜き丸をクリック→受け手（演者・手）と高さを指定。指定は音符の fix として持ち、
     スケジューラーが計画時の制約として尊重する。指定どおりに投げられない場合は
     自動割り当てで鳴らし、警告に出す（破綻で止めない）。
     編集すると署名が変わり、焼き付け・確定seedは自動的に外れる（完成曲を守る仕組みと同居）。 */
  let fixNoteIdx = null;
  function setupFixEditor() {
    const canvas = $("timeline");
    const pop = $("fix-pop");

    const openPop = (a, ev) => {
      fixNoteIdx = a.noteIdx;
      const note = state.melody.notes[a.noteIdx];
      const fix = note.fix || {};
      // 受け手の選択肢は人数に合わせて作り直す
      const sel = $("fp-catch");
      sel.innerHTML = '<option value="">自動</option>';
      for (let p = 0; p < state.cfg.nPerformers; p++) {
        for (const h of [0, 1]) {
          const o = document.createElement("option");
          o.value = p + ":" + h;
          o.textContent = `${TOREI.perfName(p)} の${["左手", "右手"][h]}`;
          sel.appendChild(o);
        }
        const o2 = document.createElement("option");
        o2.value = p + ":";
        o2.textContent = `${TOREI.perfName(p)}（手は自動）`;
        sel.appendChild(o2);
      }
      sel.value = fix.catchPerf != null
        ? fix.catchPerf + ":" + (fix.catchHand != null ? fix.catchHand : "") : "";
      $("fp-level").value = fix.level || "";
      $("fp-title").textContent =
        `${TOREI.noteName(note.midi)}（${TOREI.perfName(a.perf)}が投げる音）の編集`;
      // クリック位置の近くに出す（scroll-area基準の絶対配置）
      const area = canvas.parentElement;
      const ar = area.getBoundingClientRect();
      pop.hidden = false;
      pop.style.left = Math.min(ev.clientX - ar.left + area.scrollLeft + 12,
        area.scrollWidth - pop.offsetWidth - 8) + "px";
      pop.style.top = (canvas.offsetTop + 8) + "px";
    };
    const closePop = () => { pop.hidden = true; fixNoteIdx = null; };

    canvas.addEventListener("click", (ev) => {
      const r = canvas.getBoundingClientRect();
      const a = TOREI.timeline.throwAt(state, ev.clientX - r.left, ev.clientY - r.top);
      if (!a) { closePop(); return; }
      // 和音の音は編集対象外（キャッチの手が和音の成立条件そのものなので）
      const cnt = state.melody.notes.filter(n => Math.abs(n.beat - state.melody.notes[a.noteIdx].beat) < 1e-6).length;
      if (cnt >= 2) { showNotice("和音の音は編集できません（キャッチの手が和音の成立条件のため）"); return; }
      openPop(a, ev);
    });
    canvas.addEventListener("mousemove", (ev) => {
      const r = canvas.getBoundingClientRect();
      canvas.style.cursor = TOREI.timeline.throwAt(state, ev.clientX - r.left, ev.clientY - r.top) ? "pointer" : "";
    });

    $("fp-apply").addEventListener("click", () => {
      if (fixNoteIdx == null) return;
      const note = state.melody.notes[fixNoteIdx];
      const v = $("fp-catch").value;
      const lv = +$("fp-level").value || null;
      const fix = {};
      if (v) {
        const [p, h] = v.split(":");
        fix.catchPerf = +p;
        if (h !== "") fix.catchHand = +h;
      }
      if (lv) fix.level = lv;
      note.fix = (fix.catchPerf != null || fix.level) ? fix : null;
      closePop();
      recompute();
      updateClearFixesBtn();
    });
    $("fp-clear").addEventListener("click", () => {
      if (fixNoteIdx == null) return;
      state.melody.notes[fixNoteIdx].fix = null;
      closePop();
      recompute();
      updateClearFixesBtn();
    });
    $("fp-close").addEventListener("click", closePop);

    $("btn-clear-fixes").addEventListener("click", () => {
      for (const n of state.melody.notes) n.fix = null;
      recompute();
      updateClearFixesBtn();
    });
  }
  function updateClearFixesBtn() {
    const btn = $("btn-clear-fixes");
    if (btn) btn.hidden = !state.melody.notes.some(n => n.fix);
  }

  /* 舞台の名札を直接クリックして書き換える（2026-08-26 本人要望）。
     canvasには入力欄を置けないので、名札と同じ位置にHTMLのinputを浮かせて重ねる。
     舞台の座標＝CSSピクセル（setupCanvasがcanvasのCSS寸法を合わせている）なので、
     stage.nameBoxes() の値をそのまま left/top に使える。 */
  function setupStageRename() {
    const canvas = $("stage");
    const box = $("stage-name");
    let editing = null;

    const close = (commit) => {
      if (editing == null) return;
      const i = editing, v = box.value;
      editing = null;
      box.style.display = "none";
      if (commit) applyRename(i, v);
    };
    const open = (b) => {
      editing = b.perf;
      box.value = TOREI.perfName(b.perf);
      box.style.left = b.x + "px";
      box.style.top = b.y + "px";
      box.style.width = b.w + "px";
      box.style.height = b.h + "px";
      box.style.display = "block";
      box.focus();
      box.select();
    };

    canvas.addEventListener("click", (ev) => {
      const r = canvas.getBoundingClientRect();
      const hit = TOREI.stage.nameAt(ev.clientX - r.left, ev.clientY - r.top);
      if (hit) open(hit); else close(true);
    });
    // 名札の上ではカーソルを変えて「押せる」と分かるようにする
    canvas.addEventListener("mousemove", (ev) => {
      const r = canvas.getBoundingClientRect();
      canvas.style.cursor = TOREI.stage.nameAt(ev.clientX - r.left, ev.clientY - r.top) ? "text" : "";
    });
    box.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter") { ev.preventDefault(); close(true); }
      else if (ev.key === "Escape") { ev.preventDefault(); close(false); }
      ev.stopPropagation();   // 楽譜のキー操作へ流さない
    });
    box.addEventListener("blur", () => close(true));
  }

  function drawAll() {
    TOREI.pianoroll.draw(state);
    TOREI.pianoroll.drawGutter(state);
    TOREI.timeline.draw(state);
    TOREI.timeline.buildGutter(state, applyRename);
    TOREI.nav.drawRuler();
    TOREI.stage.prepare(state);
    TOREI.stage.setLabels(!playing);
    TOREI.stage.render(state.pos);
    renderSummary();
    renderStartLayout();
    renderEffort();
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
    const open = document.createElement("button");
    open.type = "button";
    open.className = "cue-open";
    open.textContent = "▶ この演者の動きを見る";
    open.addEventListener("click", () => openSolo(cuePerf));
    tabs.appendChild(open);
    // 本体
    cueRows = [];
    cueLastIdx = -1;
    if (!state.result) { body.innerHTML = ""; return; }
    const rows = TOREI.cueSheet(state.result, state.melody, state.cfg, cuePerf);
    // Qシートの冒頭に「開演時の構え」を出す。演者はこれを見て舞台に立つので、
    // 1行目が「何を持って始めるか」でないと使えない（2026-08-25 本人要望）。
    const mySlot = TOREI.initialLayout(state.result, state.cfg.nPerformers)[cuePerf];
    let startEl = null;
    if (mySlot) {
      startEl = document.createElement("p");
      startEl.className = "cue-start";
      startEl.innerHTML = `<b>開始時の持ち方</b> ${TOREI.layoutText(mySlot)}`;
    }
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
    if (startEl) body.appendChild(startEl);
    body.appendChild(table);
    updateCueHighlight();
  }

  /* ---------- 演者1人分の動きモーダル（2026-08-25） ----------
     Qシートの表は「いつ何をするか」は分かるが、体の動きは想像するしかない。
     舞台ビューの1人分を拡大し、ゆっくり再生して所作を覚えるための画面。
     本編の再生とは独立した時計で動く（本編を止めずに確認できるように）。 */
  let soloOpen = false, soloPerf = 0, soloRows = [], soloIdx = 0;
  let soloT = 0, soloPlaying = false, soloRaf = 0, soloLast = 0, soloSpeed = 0.5;

  function openSolo(perfId) {
    if (!state.result) return;
    soloPerf = perfId;
    soloRows = TOREI.cueSheet(state.result, state.melody, state.cfg, perfId);
    if (!soloRows.length) { showNotice("この演者には動作がありません"); return; }
    soloOpen = true;
    $("solo-modal").hidden = false;
    $("solo-title").textContent = `${TOREI.perfName(perfId)} の動き`;
    // いまの再生位置に最も近い動作から始める（Qシートで見ていた場所を引き継ぐ）
    soloIdx = 0;
    for (let i = 0; i < soloRows.length; i++) if (soloRows[i].t <= state.pos + 1e-6) soloIdx = i;
    // 開始点は最初の投げの直前まで（準備の取り出しは開演前に済んでいる体。2026-08-26）。
    // 「準備」行へは前後ボタンで明示的に戻れる
    soloSeek(Math.max(soloRows[soloIdx].t, state.result.minT - 0.4));
    $("solo-close").focus();
  }

  function closeSolo() {
    soloOpen = false;
    soloPlaying = false;
    cancelAnimationFrame(soloRaf);
    $("solo-modal").hidden = true;
    $("solo-play").textContent = "▶ 再生";
  }

  function soloSeek(t) {
    soloT = t;
    // 直近に過ぎた動作を「いま」として表示する
    let idx = -1;
    for (let i = 0; i < soloRows.length; i++) { if (soloRows[i].t > t + 1e-6) break; idx = i; }
    if (idx >= 0) soloIdx = idx;
    drawSolo();
  }

  function drawSolo() {
    if (!soloOpen) return;
    const canvas = $("solo-stage");
    // ★canvas自身の clientWidth は setupCanvas が書いたインラインstyle（＝前回の寸法）に
    // 引きずられるうえ、モーダルを開いた直後は 0 になることがある。親の実寸から測る
    // （#stage で同じ罠を踏んで stageBox() を作ったのと同じ理由）。
    const panel = canvas.parentElement;
    const cs = getComputedStyle(panel);
    // 親の「内容幅」= clientWidth − 左右padding。canvasはwidth:100%なのでこれが実寸。
    // canvas自身の clientWidth を使わないのは、setupCanvas が書いたインラインstyle
    // （＝前回の寸法）に引きずられ、開いた直後は0になることもあるため。
    // box-sizing:border-box なので枠線分を引く必要はない（引くと隙間ができる）
    const w = Math.round(panel.clientWidth
      - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight));
    const h = parseFloat(cs.getPropertyValue("--solo-h")) || 340;
    if (w <= 0) return;
    TOREI.stage.renderSolo(canvas, soloT, soloPerf, w, h);
    const r = soloRows[soloIdx];
    $("solo-now").textContent = r
      ? `${r.bar || "準備"}　${r.label}　${r.hand}：${r.text}`
      : "—";
  }

  function soloStep(dir) {
    soloPlaying = false;
    cancelAnimationFrame(soloRaf);
    $("solo-play").textContent = "▶ 再生";
    const next = Math.max(0, Math.min(soloRows.length - 1, soloIdx + dir));
    soloIdx = next;
    soloT = soloRows[next].t;
    drawSolo();
  }

  function soloTick() {
    if (!soloPlaying) return;
    const now = performance.now();
    soloT += ((now - soloLast) / 1000) * soloSpeed;
    soloLast = now;
    const end = soloRows[soloRows.length - 1].t + 1.5;
    if (soloT >= end) { soloT = end; soloPlaying = false; $("solo-play").textContent = "▶ 再生"; }
    soloSeek(soloT);
    if (soloPlaying) soloRaf = requestAnimationFrame(soloTick);
  }

  function soloTogglePlay() {
    if (soloPlaying) {
      soloPlaying = false;
      cancelAnimationFrame(soloRaf);
      $("solo-play").textContent = "▶ 再生";
      return;
    }
    // 終端まで見たあとの再生は頭から
    const end = soloRows[soloRows.length - 1].t + 1.5;
    if (soloT >= end - 1e-6) soloT = soloRows[0].t;
    soloPlaying = true;
    soloLast = performance.now();
    $("solo-play").textContent = "■ 停止";
    soloRaf = requestAnimationFrame(soloTick);
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
    // パス率＝演者間で受け渡す投げの割合。ジャグリングの見どころなので常に見えるようにする
    // （2026-08-25 本人要望）。目安20%を下回ったら警告色にする。
    const throws = state.result.actions.filter(a => a.type === "throw");
    const passes = throws.filter(a => a.pass).length;
    const rate = throws.length ? Math.round((passes / throws.length) * 100) : 0;
    const passHtml = throws.length
      ? `<span class="${rate >= PASS_TARGET ? "pass-ok" : "pass-low"}" title="演者間で受け渡す投げの割合（自分で投げて自分で受ける分は含まない）。目安${PASS_TARGET}%以上">`
        + `演者間パス <b>${rate}%</b>（${passes}/${throws.length}投）</span> ｜ `
      : "";
    el.innerHTML = `${passHtml}必要リング <b>${need}本</b> ${cap} ｜ ${parts.join(" ／ ")}`;
  }

  // 重み付けの効き目を数字で見せる。見えないと調整のしようがない。
  function renderEffort() {
    const el = $("effort-now");
    if (!el) return;
    if (!state.result) { el.textContent = ""; return; }
    const m = TOREI.effortMetrics(state.result, state.cfg);
    const acts = m.perActions.map((c, i) => `${TOREI.perfName(i)} ${c}`).join(" ／ ");
    el.innerHTML = `いまの編成: 窮屈な連続 <b>${m.tight}</b>回 ｜ 高さの変化 <b>${m.levelChange}</b>回 ｜ `
      + `高さ上限超え <b>${m.tooHigh}</b>本 ｜ 遠い演者へのパス <b>${m.farPasses}</b>回 ｜ `
      + `脇側の腕で取る <b>${m.armCatches}</b>回 ｜ `
      + `演者ごとの動作数 ${acts}（偏り <b>${Math.round(m.imbalance * 100)}%</b>）`;
  }

  // 開演の瞬間に誰が何の音を持っているか（2026-08-25 本人要望）。
  // 舞台のリングは音高で色分けされているだけで音名が書かれていないので、
  // 同じ色の丸を添えて文字と絵を対応させる。位置（右手／左手／脇）まで出すのは、
  // 演者が本番前に構えを作るのにそこまで要るため。
  function renderStartLayout() {
    const el = $("start-layout");
    if (!state.result || !state.result.rings.length) { el.innerHTML = ""; return; }
    const slots = TOREI.initialLayout(state.result, state.cfg.nPerformers);
    const chip = (where, ring) =>
      `<span class="sl-slot"><i class="sl-where">${where}</i>`
      + `<span class="sl-note" style="--c:${TOREI.pitchColor(ring.midi, 0.95)}">${ring.label}</span></span>`;
    const rows = slots.map(sl => {
      const parts = [];
      if (sl.hands[1]) parts.push(chip("右手", sl.hands[1]));
      if (sl.hands[0]) parts.push(chip("左手", sl.hands[0]));
      for (const w of sl.waki) parts.push(chip(["左脇", "右脇"][w.side], w.ring));
      for (const r of sl.stand) parts.push(chip("スタンド", r));
      if (!parts.length) parts.push('<span class="sl-empty">手ぶら</span>');
      // 名前は編集できる。演者名を直す場所を探して画面を下まで探させない
      // （行動表の左端にも同じ入力欄があるが、気づきにくかった。2026-08-26 本人要望）
      return `<div class="sl-row">`
        + `<input class="sl-perf" value="${TOREI.perfName(sl.perf).replace(/"/g, "&quot;")}"`
        + ` data-perf="${sl.perf}" maxlength="8" title="クリックで演者名を編集">`
        + `${parts.join("")}</div>`;
    });
    el.innerHTML = `<div class="sl-head">開始時の持ち方<span class="sl-hint">（演者名はクリックで編集）</span></div>`
      + `<div class="sl-rows">${rows.join("")}</div>`;
    for (const inp of el.querySelectorAll(".sl-perf")) {
      inp.addEventListener("change", () => applyRename(+inp.dataset.perf, inp.value));
    }
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
  // 直近の scheduleFrom がループの継ぎ目（先行予約）だったか。
  // tick の周回ラップ表示はこのときだけ行う。フレッシュ開始でも pos は
  // playT0 − 0.08 − 出力遅延 から始まるため、フラグなしでラップ条件を書くと
  // ループ再生の開始直後に一瞬プレイヘッドがループ終端へ飛ぶ
  let loopChained = false;

  // simT 秒から鳴らす。baseTime を指定すると「その音声時刻ちょうどに simT が来る」よう
  // 予約する（ループの継ぎ目用。省略時は今+0.08秒＝新規再生）。
  function scheduleFrom(simT, baseTime) {
    const ctx = TOREI.audio.ensure();
    const fresh = baseTime == null;
    loopChained = !fresh;   // tick の周回ラップ表示は「継ぎ目」のときだけ有効にする
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
    // カーソルが曲頭・曲末にあるときは最初の投げの直前から見せる
    // （スタンド取り出しの儀式は見せない。2026-08-26 本人指示）
    const prepStart = Math.max(-4, Math.min(0, state.result.minT)) - 0.4;
    if (Math.abs(state.pos) <= 1e-3 || state.pos >= songEndT() - 0.01) return prepStart;
    return state.pos;
  }

  function startPlayback() {
    if (!state.result) return;
    const from = playStartPos();
    playing = true;
    TOREI.stage.setLabels(false);   // 動いている間は音名を消す（飛球で重なって読めない）
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
      // 表示は「いま耳に聞こえている音」の位置に合わせる。
      // ★上限0.5秒でクランプする（2026-08-25 音声タイムラグ再発の報告を受けて堅牢化）。
      // Chromeには outputLatency が異常な巨大値を返し続ける既知の不具合がある
      // （Bluetooth機器の切替後など）。無防備に使うと映像が音から数秒遅れ、
      // さらに停止→再開のたびにその分だけ大きく巻き戻る。異常値のときは
      // baseLatency（内部処理分のみ・小さく安定）へ落とす
      let lat = ctx.outputLatency || 0;
      if (!(lat >= 0) || lat > 0.5) lat = Math.min(ctx.baseLatency || 0, 0.5);
      lat += avSync;   // 手動の音ズレ補正（Safari等、自動検出できない環境向け）
      let pos = playT0 + (ctx.currentTime - playBase) - lat;
      // 次の周を先行予約した直後は playBase が未来（境界時刻）を指す。境界を越えるまでは
      // 前の周の続きの位置として表示すると、プレイヘッドが途切れず境界を通過する。
      // 条件の playT0 >= loop.a は、再生中にループ開始より前へシークした場合
      // （playT0 がループ外）を誤って巻き込まないため
      if (state.loop && loopChained) {
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
    TOREI.stage.setLabels(true);    // 止めたら誰が何を持っているか読めるようにする
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
      notes: state.melody.notes.map(n => ({ beat: n.beat, midi: n.midi, fix: n.fix || null })),
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
      notes: data.notes.map(n => ({ beat: n.beat, midi: n.midi, fix: n.fix || null })),
    };
    state.cfg.nPerformers = data.performers;
    state.cfg.flight = data.flight;
    state.cfg.wakiCap = data.wakiCap;
    state.cfg.maxDup = data.maxDup;
    state.cfg.maxRings = data.maxRings || null;
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
    $("inp-rings").value = data.maxRings || "";
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
    // 同音リング最大は曲データの値をそのまま使う（UIからは外した。2026-08-26 クライアント方針
    // 「リング総数の上限だけ決めて、同音複製は自動であり」）。総数は maxRings で絞る。
    state.cfg.maxDup = p.maxDup || 2;
    state.cfg.maxRings = p.maxRings || null;
    $("inp-rings").value = state.cfg.maxRings || "";
    state.pos = 0;
    setLoop(null);
    // 配布用に確定させた編成があれば、探索せずそれを再現する（tools/optimize.mjs が選定）。
    // 稽古する振り付けが開くたびに変わらないようにするのが目的で、速さは副次的な利点。
    // 完成曲（焼き付け）＞確定seed＞探索、の順。焼き付けはスケジューラーが
    // どう変わっても振付が動かない（tools/freeze.mjs で生成）
    const fz = (TOREI.FROZEN || {})[p.id];
    freezeSeed(fz ? fz.seed : (TOREI.SEEDS || {})[p.id], fz || null);
    updateClearFixesBtn();
    recompute();
    scrollToSongHead();
  }

  /* ---------- キーボード ---------- */

  function onKey(ev) {
    const tag = ev.target.tagName;
    if (tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA") return;
    // モーダル表示中は本編の操作（Space=再生、矢印=シーク）を奪わない
    if (soloOpen) {
      if (ev.key === "Escape") { ev.preventDefault(); closeSolo(); }
      else if (ev.code === "Space") { ev.preventDefault(); soloTogglePlay(); }
      else if (ev.key === "ArrowLeft") { ev.preventDefault(); soloStep(-1); }
      else if (ev.key === "ArrowRight") { ev.preventDefault(); soloStep(1); }
      return;
    }
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
    setupStageRename();   // 舞台の名札をクリックで編集（2026-08-26）
    setupFixEditor();     // ダイヤグラム上で投げの受け手・高さを編集（2026-08-26）
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
    // 難易度の重み付け（2026-08-25 本人要望）。
    // 物理的に成立していても人に無理な編成はある。ここは「重み」ではなく
    // 手の余裕・高さの上限といった稽古で使える言葉で持つ（scheduler.js の TOREI.EFFORT）。
    const effortInputs = [
      ["eff-gap", "handGap"], ["eff-level", "maxLevel"], ["eff-even", "evenLevel"],
      ["eff-load", "evenLoad"], ["eff-far", "farPass"], ["eff-arm", "wakiArm"],
      ["eff-ring", "ringCost"],
    ];
    function readEffort() {
      const e = {};
      for (const [id, key] of effortInputs) e[key] = +$(id).value;
      state.cfg.effort = e;
    }
    readEffort();
    for (const [id] of effortInputs) {
      $(id).addEventListener("change", () => { readEffort(); recompute(); });
    }

    // 音ズレ補正スライダー（端末設定）
    $("inp-avsync").value = Math.round(avSync * 1000);
    $("avsync-val").textContent = Math.round(avSync * 1000);
    $("inp-avsync").addEventListener("input", () => {
      avSync = (+$("inp-avsync").value || 0) / 1000;
      $("avsync-val").textContent = Math.round(avSync * 1000);
      try { localStorage.setItem("torei.avSync", String(avSync)); } catch (e) {}
    });

    // 演者1人分の動きモーダル
    $("solo-close").addEventListener("click", closeSolo);
    $("solo-play").addEventListener("click", soloTogglePlay);
    $("solo-prev").addEventListener("click", () => soloStep(-1));
    $("solo-next").addEventListener("click", () => soloStep(1));
    $("solo-speed").addEventListener("input", () => {
      soloSpeed = +$("solo-speed").value;
      $("solo-speed-val").textContent = soloSpeed.toFixed(2).replace(/0$/, "");
    });
    // 背景（パネルの外）クリックで閉じる
    $("solo-modal").addEventListener("mousedown", (ev) => {
      if (ev.target === $("solo-modal")) closeSolo();
    });

    $("btn-bar-insert").addEventListener("click", insertBar);
    $("btn-bar-delete").addEventListener("click", deleteBar);
    $("btn-bar-undo").addEventListener("click", undoBarOp);

    // スライダーは1回動かすたびに input が飛ぶ。スケジューラーの探索は1曲80ms前後あるので、
    // 毎イベントで回すとドラッグが引っかかる。数値表示は即座に、再計算だけ後追いにする。
    let slideTimer = null;
    const recomputeSoon = () => {
      if (slideTimer) clearTimeout(slideTimer);
      slideTimer = setTimeout(() => { slideTimer = null; recompute(); }, 140);
    };
    $("inp-bpm").addEventListener("input", () => {
      state.melody.bpm = Math.max(30, Math.min(200, +$("inp-bpm").value || 90));
      $("bpm-val").textContent = state.melody.bpm;
      recomputeSoon();
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
      recomputeSoon();
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
    $("inp-rings").addEventListener("change", () => {
      const v = +$("inp-rings").value || 0;
      state.cfg.maxRings = v >= 3 ? v : null;
      $("inp-rings").value = state.cfg.maxRings || "";
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
      if (soloOpen) drawSolo();
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
