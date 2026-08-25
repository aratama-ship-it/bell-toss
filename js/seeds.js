/* 投鈴 — 曲ごとに確定させた編成の seed（自動生成）
 *
 * tools/optimize.mjs が大きな探索量で選んだ結果。ブラウザはこの seed を1回再現するだけで、
 * 探索し直さない＝配った曲の振り付けが後から黙って変わらない。
 * 楽譜を編集すると seed は捨てられ、その場の探索に切り替わる（js/main.js）。
 *
 * 再生成: node tools/optimize.mjs
 * 探索量: 2000シード
 */
window.TOREI = window.TOREI || {};
TOREI.SEEDS = {
  "saints": 700,
  "twinkle": 124,
  "tulip": 693,
  "mary": 231,
  "ode": 855,
  "hayate": 39,
  "yotsutsuji": 3,
  "mitsudomoe": 0,
  "swinglow": 769,
  "susanna": 39,
  "hotaru": 954,
  "gomon": 177,
  "yoimachi": 21,
  "korobeiniki": 183,
  "amazing": 1221,
  "kiyoshi": 1809,
  "etude2": 3,
  "greensleeves": 993,
  "kasanesuzu": 874,
  "sakura": 1708,
  "furusato": 1047,
  "bunbun": 51,
  "yuyake": 1977,
  "furudokei": 1857,
  "kaeru": 237,
  "chocho": 297,
  "london": 33,
  "jingle": 1485,
  "birthday": 245,
  "makiba": 33,
  "morobito": 21,
  "kusakeiba": 1269,
  "rowboat": 33,
  "frere": 261
};
