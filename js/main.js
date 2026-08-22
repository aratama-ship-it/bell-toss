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

  const $ = (id) => document.getElementById(id);
  const spb = () => 60 / state.melody.bpm;

  function songEndT() {
    const last = state.melody.notes.reduce((m, n) => Math.max(m, n.beat), 0);
    return last * spb() + 2.5;
  }

  /* ---------- 再計算と描画 ---------- */

  function recompute() {
    stopPlayback();
    state.result = TOREI.schedule(state.melody, state.cfg);
    const sp = spb();
    V.preBeats = Math.ceil(Math.max(0, -state.result.minT) / sp + 0.001);
    // 楽譜の幅は曲の長さに合わせる（64拍固定だと長い曲の後半が描画されない）
    const last = state.melody.notes.reduce((m, n) => Math.max(m, n.beat), 0);
    V.TOTAL_BEATS = Math.max(64, Math.ceil((last + 8) / 4) * 4);
    V.clampPPB();
    clampPos();
    drawAll();
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
    updatePlayheadEl();
    updateReadout();
    updateZoomUI();
    scheduleNavDraw();
  }

  // ズーム変更時: スケジュール計算は変わらないので楽譜側だけ描き直す
  function redrawScore() {
    TOREI.pianoroll.draw(state);
    TOREI.timeline.draw(state);
    TOREI.nav.drawRuler();
    updatePlayheadEl();
    scheduleNavDraw();
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
    el.textContent = `${posTxt}　${m}:${s}`;
  }

  function updateZoomUI() {
    const sl = $("inp-zoom");
    if (!sl) return;
    sl.min = V.PPB_MIN;
    sl.max = V.maxPPB();
    sl.value = V.PPB;
  }

  // 滞空時間から最高到達点を出す（h = g*t^2/8）。投げの現実味を確かめるための表示。
  function updateFlightHeight() {
    const t = state.cfg.flight;
    const h = 9.8 * t * t / 8;
    $("flight-height").textContent = `（頭上 約${h.toFixed(1)}m ／ 床から 約${(h + 1.4).toFixed(1)}m）`;
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

  function renderWarnings() {
    const el = $("warnings");
    const ws = state.result ? state.result.warnings : [];
    if (!ws.length) { el.hidden = true; return; }
    el.hidden = false;
    const rows = ws.slice(0, 8).map(w => `<div>⚠ ${w.msg}</div>`);
    if (ws.length > 8) rows.push(`<div>…他 ${ws.length - 8} 件</div>`);
    el.innerHTML = rows.join("");
  }

  /* ---------- 再生 ---------- */

  // simT 秒から鳴らす（ループ中は終端より先の音を予約しない）
  // ループの巻き戻しは描画（rAF）ではなくタイマーで行う。タブが裏に回って
  // rAFが止まっても、耳で合わせる稽古（音だけ流し続ける）が途切れないように。
  let loopTimer = null;

  function scheduleFrom(simT) {
    const ctx = TOREI.audio.ensure();
    TOREI.audio.beginSession();
    playT0 = simT;
    playBase = ctx.currentTime + 0.08;
    const loopEnd = state.loop ? state.loop.b * spb() : Infinity;
    for (const a of state.result.actions) {
      if ((a.type === "catch" || a.type === "shake") && a.t >= simT - 1e-3 && a.t < loopEnd) {
        TOREI.audio.bell(a.midi, playBase + (a.t - simT), a.type === "shake" ? 0.7 : 1);
      }
    }
    clearTimeout(loopTimer);
    loopTimer = null;
    if (state.loop) {
      const delay = 80 + Math.max(0, (loopEnd - simT) * 1000);
      loopTimer = setTimeout(() => {
        if (playing && state.loop) scheduleFrom(state.loop.a * spb());
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

    const scroll = $("scroll-area");
    const endT = songEndT();

    const tick = () => {
      if (!playing) return;
      const ctx = TOREI.audio.ctx;
      let pos = playT0 + (ctx.currentTime - playBase);
      // ループの巻き戻し自体は scheduleFrom のタイマーが行う。
      // タイマー発火までのわずかな間、表示だけ終端で止めておく。
      if (state.loop) pos = Math.min(pos, state.loop.b * spb());
      state.pos = pos;
      TOREI.stage.render(pos);
      updatePlayheadEl();
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
    if (b) { b.textContent = "▶ 再生"; b.classList.remove("playing"); }
    // カーソルは消さない: 止めた場所が次の稽古の起点になる
    if (state.result) TOREI.stage.render(state.pos);
    scheduleNavDraw();
  }

  /* ---------- シーク・ズーム・ループ ---------- */

  function seek(t, opts) {
    state.pos = t;
    clampPos();
    if (state.result) TOREI.stage.render(state.pos);
    updatePlayheadEl();
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
    state.loop = l;
    $("btn-loop-clear").hidden = !l;
    $("btn-loop-bar").classList.toggle("active", !!l);
    TOREI.nav.drawRuler();
    scheduleNavDraw();
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
        $("inp-bpm").value = state.melody.bpm;
        $("sel-preset").value = "blank";
        state.pos = 0;
        setLoop(null);
        recompute(); // 楽譜の幅は recompute が曲の長さから決める
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

  /* ---------- 初期化 ---------- */

  function loadPreset(id) {
    const p = TOREI.PRESETS.find(x => x.id === id) || TOREI.PRESETS[0];
    state.melody = {
      bpm: p.bpm,
      beatsPerBar: p.beatsPerBar,
      notes: p.notes.map(n => ({ beat: n.beat, midi: n.midi })),
    };
    $("inp-bpm").value = p.bpm;
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
    state.pos = 0;
    setLoop(null);
    recompute();
    $("scroll-area").scrollLeft = 0;
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
    for (const p of TOREI.PRESETS) {
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

    // ズームとループ
    $("btn-zoom-out").addEventListener("click", () => zoomTo(V.PPB / 1.3));
    $("btn-zoom-in").addEventListener("click", () => zoomTo(V.PPB * 1.3));
    $("inp-zoom").addEventListener("input", () => zoomTo(+$("inp-zoom").value));
    $("btn-loop-bar").addEventListener("click", loopCurrentBar);
    $("btn-loop-clear").addEventListener("click", () => setLoop(null));

    $("inp-bpm").addEventListener("change", () => {
      state.melody.bpm = Math.max(40, Math.min(200, +$("inp-bpm").value || 90));
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
      if (!(ev.ctrlKey || ev.metaKey)) return;
      ev.preventDefault();
      const rect = sa.getBoundingClientRect();
      zoomTo(V.PPB * Math.pow(1.0015, -ev.deltaY), ev.clientX - rect.left);
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
    loadPreset("saints");
  }

  document.addEventListener("DOMContentLoaded", init);
})();
