/* 投鈴 — プリセット曲（すべてパブリックドメインの旋律）
   notes: { beat: 拍位置(0始まり), midi: ノート番号 } の羅列。ベルは打点だけが意味を持つ。 */
"use strict";

window.TOREI = window.TOREI || {};

TOREI.PRESETS = [
  // 楽曲は tools/make_midi.py が生成する js/songs.js に集約している。
  // ここには「白紙から作る」だけを置く。
  {
    id: "blank",
    name: "（白紙から作る）",
    bpm: 90,
    beatsPerBar: 4,
    performers: 3,
    notes: [],
  },
];

/* 演者名（編集可・localStorageに保存） */
TOREI.names = (() => {
  try {
    const saved = JSON.parse(localStorage.getItem("torei.names") || "[]");
    return Array.isArray(saved) ? saved : [];
  } catch (e) { return []; }
})();
TOREI.perfName = function (i) {
  return (TOREI.names[i] && TOREI.names[i].trim()) || `演者${i + 1}`;
};
TOREI.setPerfName = function (i, name) {
  TOREI.names[i] = name;
  try { localStorage.setItem("torei.names", JSON.stringify(TOREI.names)); } catch (e) {}
};

/* 音名表示: ドレミ表記 + オクターブ点 */
TOREI.noteName = function (midi) {
  const kana = ["ド", "ド♯", "レ", "レ♯", "ミ", "ファ", "ファ♯", "ソ", "ソ♯", "ラ", "ラ♯", "シ"];
  return kana[midi % 12];
};

TOREI.noteNameFull = function (midi) {
  const oct = Math.floor(midi / 12) - 1; // MIDI 72 = C5
  return TOREI.noteName(midi) + oct;
};

/* 音高→色: トーンを揃えた多色（トーン・イン・トーン）。彩度控えめで紙白になじませる */
TOREI.pitchColor = function (midi, alpha) {
  const hue = ((midi % 12) * 30 + 205) % 360;
  return `hsla(${hue}, 42%, 46%, ${alpha == null ? 1 : alpha})`;
};
