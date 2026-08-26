/* 投鈴 — 作業中の曲データの保存・復元 */
"use strict";

TOREI.songfile = (() => {
  const KEY = "torei.work";

  function serialize(state, songId, songName) {
    return {
      v: 1,
      id: songId || "blank",
      name: songName || "",
      bpm: state.melody.bpm,
      beatsPerBar: state.melody.beatsPerBar,
      performers: state.cfg.nPerformers,
      passMode: state.cfg.passMode,
      standTime: state.cfg.standTime,
      flight: state.cfg.flight,
      wakiCap: state.cfg.wakiCap,
      maxDup: state.cfg.maxDup,
      maxRings: state.cfg.maxRings || null,
      allowShake: state.cfg.allowShake,
      notes: state.melody.notes.map(n => ({ beat: n.beat, midi: n.midi })),
    };
  }

  function validate(data) {
    if (!data || typeof data !== "object" || Array.isArray(data)) {
      return "曲データがオブジェクトではありません";
    }
    if (!Array.isArray(data.notes)) return "notes が配列ではありません";
    if (!Number.isFinite(data.bpm) || data.bpm < 20 || data.bpm > 300) {
      return "bpm は20〜300の有限数にしてください";
    }
    if (data.v !== 1) return "対応していない曲データのバージョンです";
    if (typeof data.id !== "string" || typeof data.name !== "string") {
      return "id と name は文字列にしてください";
    }
    if (!Number.isFinite(data.beatsPerBar) || data.beatsPerBar <= 0) {
      return "beatsPerBar は正の有限数にしてください";
    }
    if (!Number.isInteger(data.performers) || data.performers < 1) {
      return "performers は1以上の整数にしてください";
    }
    if (!Number.isFinite(data.flight) || data.flight <= 0) return "flight は正の有限数にしてください";
    if (!Number.isFinite(data.standTime) || data.standTime <= 0) {
      return "standTime は正の有限数にしてください";
    }
    if (!Number.isInteger(data.wakiCap) || data.wakiCap < 0) {
      return "wakiCap は0以上の整数にしてください";
    }
    if (!Number.isInteger(data.maxDup) || data.maxDup < 1) {
      return "maxDup は1以上の整数にしてください";
    }
    if (typeof data.allowShake !== "boolean") return "allowShake は真偽値にしてください";
    if (!["more", "natural", "off"].includes(data.passMode)) {
      return "passMode は more、natural、off のいずれかにしてください";
    }
    for (let i = 0; i < data.notes.length; i++) {
      const n = data.notes[i];
      if (!n || typeof n !== "object" || !Number.isFinite(n.beat) || !Number.isFinite(n.midi)) {
        return `notes[${i}] の beat と midi は有限数にしてください`;
      }
      if (n.midi < 0 || n.midi > 127) return `notes[${i}] の midi は0〜127にしてください`;
    }
    return null;
  }

  function save(obj) {
    try { localStorage.setItem(KEY, JSON.stringify(obj)); } catch (e) {}
  }

  function load() {
    try {
      const text = localStorage.getItem(KEY);
      return text == null ? null : JSON.parse(text);
    } catch (e) { return null; }
  }

  function clear() {
    try { localStorage.removeItem(KEY); } catch (e) {}
  }

  return { serialize, validate, save, load, clear };
})();
