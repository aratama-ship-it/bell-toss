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

/* 投げの高さの段階（1〜5）。稽古では「1.15秒」より「高さ4」の方が声に出して共有しやすい。
   滞空時間の可動域 0.7〜1.4秒 を 0.15秒刻みで5段に割る。
   高さ(頭上) h = g*t^2/8 なので、段が上がるほど実際の高さの伸びは大きくなる。
     高さ1 = 0.70〜0.84秒（頭上 約0.6〜0.9m）  低く速い投げ
     高さ2 = 0.85〜0.99秒（約0.9〜1.2m）
     高さ3 = 1.00〜1.14秒（約1.2〜1.6m）
     高さ4 = 1.15〜1.29秒（約1.6〜2.0m）
     高さ5 = 1.30〜1.40秒（約2.1〜2.4m）  高く大きな投げ */
TOREI.throwLevel = function (flightSec) {
  return Math.max(1, Math.min(5, 1 + Math.floor((flightSec - 0.7) / 0.15 + 1e-9)));
};
/* 頭上何メートルまで上がるか（自由落下から逆算）。滞空の半分が上昇にあたる */
TOREI.throwHeightM = function (flightSec) {
  return 9.8 * flightSec * flightSec / 8;
};

/* 音高→色: トーンを揃えた多色（トーン・イン・トーン）。彩度控えめで紙白になじませる */
TOREI.pitchColor = function (midi, alpha) {
  const hue = ((midi % 12) * 30 + 205) % 360;
  return `hsla(${hue}, 42%, 46%, ${alpha == null ? 1 : alpha})`;
};
