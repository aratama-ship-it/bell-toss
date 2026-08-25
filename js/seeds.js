/* 投鈴 — 曲ごとに確定させた編成の seed（自動生成）
 *
 * tools/optimize.mjs が大きな探索量で選んだ結果。ブラウザはこの seed を1回再現するだけで、
 * 探索し直さない＝配った曲の振り付けが後から黙って変わらない。
 * 楽譜を編集すると seed は捨てられ、その場の探索に切り替わる（js/main.js）。
 *
 * 再生成: node tools/optimize.mjs
 * 探索量: 3000シード
 */
window.TOREI = window.TOREI || {};
TOREI.SEEDS = {
  "saints": 257,
  "twinkle": 357,
  "tulip": 531,
  "mary": 1701,
  "ode": 195,
  "hayate": 171,
  "yotsutsuji": 39,
  "mitsudomoe": 81,
  "swinglow": 24,
  "susanna": 1167,
  "hotaru": 129,
  "gomon": 477,
  "yoimachi": 657,
  "korobeiniki": 1959,
  "amazing": 321,
  "kiyoshi": 117,
  "etude2": 1398,
  "greensleeves": 1083,
  "kasanesuzu": 316,
  "sakura": 152,
  "furusato": 1144,
  "bunbun": 117,
  "yuyake": 1617,
  "furudokei": 149,
  "kaeru": 1509,
  "chocho": 1545,
  "london": 153,
  "jingle": 717,
  "birthday": 147,
  "makiba": 765,
  "morobito": 237,
  "kusakeiba": 2613,
  "rowboat": 2535,
  "frere": 423
};
