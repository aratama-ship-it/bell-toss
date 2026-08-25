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
  "saints": 664,
  "twinkle": 1198,
  "tulip": 1395,
  "mary": 1539,
  "ode": 645,
  "hayate": 42,
  "yotsutsuji": 3,
  "mitsudomoe": 3,
  "swinglow": 999,
  "susanna": 81,
  "hotaru": 990,
  "gomon": 426,
  "yoimachi": 315,
  "korobeiniki": 693,
  "amazing": 861,
  "kiyoshi": 1071,
  "etude2": 3,
  "greensleeves": 1406,
  "kasanesuzu": 297,
  "sakura": 225,
  "furusato": 1445,
  "bunbun": 1719,
  "yuyake": 1269,
  "furudokei": 389,
  "kaeru": 165,
  "chocho": 1449,
  "london": 101,
  "jingle": 525,
  "birthday": 695,
  "makiba": 1287,
  "morobito": 177,
  "kusakeiba": 705,
  "rowboat": 593,
  "frere": 375
};
