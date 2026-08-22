/* 投鈴 — 標準MIDIファイル(SMF format 1)書き出し
   トラック構成: 0=テンポ / 1=メロディ全体 / 2〜=演者ごとのキャッチ音 */
"use strict";

TOREI.midi = (() => {
  const TPQ = 480;

  function vlq(n) {
    // 可変長数値
    const bytes = [n & 0x7f];
    while ((n >>= 7)) bytes.unshift((n & 0x7f) | 0x80);
    return bytes;
  }

  function str(s) { return [...s].map(c => c.charCodeAt(0)); }

  function trackChunk(events) {
    // events: [{tick, bytes:[..]}] 絶対tick → デルタ変換
    events.sort((a, b) => a.tick - b.tick);
    const out = [];
    let last = 0;
    for (const e of events) {
      out.push(...vlq(Math.max(0, Math.round(e.tick - last))), ...e.bytes);
      last = e.tick;
    }
    out.push(0x00, 0xff, 0x2f, 0x00); // end of track
    const len = out.length;
    return [...str("MTrk"),
      (len >> 24) & 0xff, (len >> 16) & 0xff, (len >> 8) & 0xff, len & 0xff, ...out];
  }

  function noteEvents(notes, channel, program, name) {
    const ev = [];
    ev.push({ tick: 0, bytes: [0xff, 0x03, name.length, ...str(name)] });
    ev.push({ tick: 0, bytes: [0xc0 | channel, program] });
    for (const n of notes) {
      const tick = Math.round(n.beat * TPQ);
      ev.push({ tick, bytes: [0x90 | channel, n.midi, 96] });
      ev.push({ tick: tick + TPQ, bytes: [0x80 | channel, n.midi, 0] }); // 1拍でノートオフ（ベルは余韻）
    }
    return ev;
  }

  /* melody, result(schedule結果), cfg → Uint8Array */
  function build(melody, result, cfg) {
    const tracks = [];

    // テンポトラック
    const usPerBeat = Math.round(60000000 / melody.bpm);
    tracks.push(trackChunk([
      { tick: 0, bytes: [0xff, 0x51, 0x03, (usPerBeat >> 16) & 0xff, (usPerBeat >> 8) & 0xff, usPerBeat & 0xff] },
      { tick: 0, bytes: [0xff, 0x58, 0x04, melody.beatsPerBar || 4, 2, 24, 8] },
    ]));

    // メロディ全体（チューブラーベル）
    tracks.push(trackChunk(noteEvents(melody.notes, 0, 14, "Melody (all bells)")));

    // 演者ごと
    const spb = 60 / melody.bpm;
    for (let p = 0; p < cfg.nPerformers; p++) {
      const notes = [];
      for (const a of result.actions) {
        if (a.perf !== p) continue;
        if (a.type === "catch" || a.type === "shake") {
          notes.push({ beat: a.t / spb, midi: a.midi });
        }
      }
      tracks.push(trackChunk(noteEvents(notes, (p + 1) % 16, 14, `Performer ${p + 1}`)));
    }

    const header = [...str("MThd"), 0, 0, 0, 6, 0, 1,
      (tracks.length >> 8) & 0xff, tracks.length & 0xff, (TPQ >> 8) & 0xff, TPQ & 0xff];
    return new Uint8Array([...header, ...tracks.flat()]);
  }

  function download(melody, result, cfg, filename) {
    const data = build(melody, result, cfg);
    const blob = new Blob([data], { type: "audio/midi" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = filename || "torei.mid";
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  }

  return { build, download };
})();
