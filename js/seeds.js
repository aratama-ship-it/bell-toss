/* 投鈴 — 曲ごとに確定させた編成の seed（自動生成）
 *
 * tools/optimize.mjs が大きな探索量で選んだ結果。ブラウザはこの seed を1回再現するだけで、
 * 探索し直さない＝配った曲の振り付けが後から黙って変わらない。
 * 楽譜を編集すると seed は捨てられ、その場の探索に切り替わる（js/main.js）。
 *
 * 再生成: node tools/optimize.mjs
 * 探索量: 6000シード
 */
window.TOREI = window.TOREI || {};
TOREI.SEEDS = {
  "saints": 5773,
  "twinkle": 136,
  "tulip": 28,
  "mary": 4389,
  "ode": 2471,
  "hayate": 249,
  "yotsutsuji": 2,
  "mitsudomoe": 179,
  "swinglow": 108,
  "susanna": 922,
  "hotaru": 2955,
  "gomon": 115,
  "yoimachi": 120,
  "korobeiniki": 2068,
  "amazing": 39,
  "kiyoshi": 274,
  "etude2": 28,
  "greensleeves": 4951,
  "kasanesuzu": 234,
  "sakura": 2108,
  "furusato": 1061,
  "bunbun": 117,
  "yuyake": 1013,
  "furudokei": 360,
  "kaeru": 5123,
  "chocho": 2103,
  "london": 4431,
  "jingle": 1683,
  "birthday": 5,
  "makiba": 87,
  "morobito": 42,
  "kusakeiba": 3310,
  "rowboat": 431,
  "frere": 423
};
