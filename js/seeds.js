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
  "saints": 1207,
  "twinkle": 129,
  "tulip": 33,
  "mary": 615,
  "ode": 855,
  "hayate": 213,
  "yotsutsuji": 3,
  "mitsudomoe": 0,
  "swinglow": 769,
  "susanna": 39,
  "hotaru": 1836,
  "gomon": 177,
  "yoimachi": 21,
  "korobeiniki": 231,
  "amazing": 1953,
  "kiyoshi": 1828,
  "etude2": 69,
  "greensleeves": 636,
  "kasanesuzu": 1929,
  "sakura": 1563,
  "furusato": 364,
  "bunbun": 51,
  "yuyake": 1977,
  "furudokei": 405,
  "kaeru": 237,
  "chocho": 801,
  "london": 33,
  "jingle": 153,
  "birthday": 785,
  "makiba": 1017,
  "morobito": 1911,
  "kusakeiba": 921,
  "rowboat": 60,
  "frere": 261
};
