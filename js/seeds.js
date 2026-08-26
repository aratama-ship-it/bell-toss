/* 投鈴 — 曲ごとに確定させた編成の seed（自動生成）
 *
 * tools/optimize.mjs が大きな探索量で選んだ結果。ブラウザはこの seed を1回再現するだけで、
 * 探索し直さない＝配った曲の振り付けが後から黙って変わらない。
 * 楽譜を編集すると seed は捨てられ、その場の探索に切り替わる（js/main.js）。
 *
 * 再生成: node tools/optimize.mjs
 * 探索量: 8000シード
 */
window.TOREI = window.TOREI || {};
TOREI.SEEDS = {
  "saints": 4047,
  "twinkle": 136,
  "tulip": 7470,
  "mary": 4389,
  "ode": 2554,
  "hayate": 5307,
  "yotsutsuji": 77,
  "mitsudomoe": 3814,
  "swinglow": 1434,
  "susanna": 754,
  "hotaru": 1732,
  "gomon": 5742,
  "yoimachi": 120,
  "korobeiniki": 2068,
  "amazing": 231,
  "kiyoshi": 316,
  "etude2": 162,
  "greensleeves": 4951,
  "kasanesuzu": 234,
  "sakura": 2108,
  "furusato": 1061,
  "bunbun": 117,
  "yuyake": 6759,
  "furudokei": 7118,
  "kaeru": 5667,
  "chocho": 6903,
  "london": 1871,
  "jingle": 3063,
  "birthday": 5,
  "makiba": 87,
  "morobito": 1899,
  "kusakeiba": 1039,
  "rowboat": 431,
  "frere": 7827
};
