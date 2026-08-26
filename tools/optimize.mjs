#!/usr/bin/env node
/* 投鈴 — 配布する編成を曲ごとに選んで固める（Node）
 *
 * なぜ要るか（2026-08-25 本人提案「楽曲ごとに先にしっかり最適化しておく」）:
 *
 * スケジューラーはランダム再スタート法なので、探索量がそのまま質になる。実測では
 * ぶんぶんぶんが 48シードでパス45%・冒頭は自分投げ、200シードでパス88%・冒頭3音すべてパス、
 * と別物になった。つまり「構造的に無理」に見えた多くは、単に探索が足りていなかった。
 *
 * 一方でブラウザは編集のたびに再計算するため、大きな探索量は置けない（200シードで最長1.3秒）。
 * そこで役割を分ける:
 *   - このツール = 時間をかけて（既定2000シード）曲ごとの最良を選び、seed を js/seeds.js に書く
 *   - ブラウザ  = seed があればそれを1回再現するだけ（数ミリ秒・毎回まったく同じ編成）
 *
 * 固めることの本当の価値は速さではなく再現性にある。稽古して本番に持っていく振り付けが、
 * こちらがスケジューラーに手を入れるたびに黙って変わってしまってはいけない。
 * 楽譜を編集した時点で seed は捨てられ、通常の探索に戻る（main.js 側で処理）。
 *
 * 使い方:
 *   node tools/optimize.mjs                 全曲（既定2000シード）→ js/seeds.js を書き出す
 *   node tools/optimize.mjs bunbun          1曲だけ試す（書き出さず結果を表示）
 *   node tools/optimize.mjs --budget 5000   探索量を変える
 *   node tools/optimize.mjs --dry           書き出さずに全曲の結果だけ見る
 */
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

function loadTorei() {
  globalThis.window = globalThis;
  globalThis.localStorage = { getItem: () => null, setItem: () => {} };
  for (const f of ["js/presets.js", "js/songs.js", "js/frozen.js", "js/scheduler.js"]) {
    const p = path.join(ROOT, f);
    vm.runInThisContext(fs.readFileSync(p, "utf8"), { filename: p });
  }
  return globalThis.TOREI;
}

function cfgFor(song) {
  return {
    nPerformers: song.performers || 3,
    flight: song.flight || 1.2,
    wakiCap: song.wakiCap ?? 1,
    maxDup: song.maxDup ?? 2,
    maxRings: song.maxRings || null,
    allowShake: song.allowShake ?? true,
    standTime: song.standTime || 2.0,
    passMode: song.passMode || "more",
  };
}

function melodyFor(song) {
  return {
    bpm: song.bpm,
    beatsPerBar: song.beatsPerBar,
    notes: song.notes.map(n => ({ beat: n.beat, midi: n.midi })),
  };
}

/* 1曲を総当たりで探索し、最良の seed と、その中身を返す */
function optimize(TOREI, song, budget) {
  const cfg = cfgFor(song);
  const melody = melodyFor(song);
  const chordSpots = TOREI.countChordSpots(melody);
  let best = null;
  for (let seed = 0; seed < budget; seed++) {
    const r = TOREI._scheduleOnce(melody, cfg, seed);
    const m = TOREI.scoreResult(r, chordSpots, cfg);
    if (!best || m.score < best.m.score) best = { seed, m, r };
  }
  return { best, chordSpots };
}

const pad = (s, n) => String(s).padEnd(n, " ");
const padL = (s, n) => String(s).padStart(n, " ");

function line(song, seed, m, chordSpots) {
  return pad(song.id, 14) + padL("seed" + seed, 9)
    + padL(Math.round(m.passRate * 100) + "%", 6)
    + padL(m.rings + "本", 6)
    + padL(m.openPass ? "パス" : "自分", 5)
    + padL(chordSpots ? (chordSpots - m.chordMiss) + "/" + chordSpots : "－", 6)
    + padL(m.fails, 4) + padL(m.shakes, 4)
    + padL(m.handoffs, 4) + padL(m.prepWaki, 4);
}

/* ---------- 実行 ---------- */

const args = process.argv.slice(2);
const dry = args.includes("--dry");
const bi = args.indexOf("--budget");
const budget = bi >= 0 ? Number(args[bi + 1]) : 2000;
const only = args.find(a => !a.startsWith("--") && a !== String(budget));

/* 完成が確定した曲は探索し直さない（2026-08-26 本人「ぶんぶんぶんは完成形。保存」）。
   採点や探索を改良しても、確定済みの振付が黙って変わることはあってはならない。 */
const PINNED = { bunbun: 117 };

const TOREI = loadTorei();
const songs = only ? TOREI.SONGS.filter(s => s.id === only) : TOREI.SONGS;
if (!songs.length) {
  console.error(`曲 "${only}" が見つからない。候補: ${TOREI.SONGS.map(s => s.id).join(", ")}`);
  process.exit(1);
}

console.log(`探索量 ${budget}シード / ${songs.length}曲`);
console.log("");
console.log(pad("曲", 14) + padL("seed", 9) + padL("パス", 6) + padL("リング", 6)
  + padL("冒頭", 5) + padL("和音", 6) + padL("不可", 4) + padL("振り", 4)
  + padL("持替", 4) + padL("準脇", 4));
console.log("─".repeat(66));

const seeds = {};
const t0 = Date.now();
let fails = 0, shakes = 0;
for (const song of songs) {
  if (PINNED[song.id] != null) {
    const cfg = cfgFor(song), melody = melodyFor(song);
    const cs = TOREI.countChordSpots(melody);
    // 焼き付け済みならその振付を評価に使う（seed再現はアルゴリズム変更でズレるため）
    const fz = TOREI.FROZEN && TOREI.FROZEN[song.id];
    const r = fz || TOREI._scheduleOnce(melody, cfg, PINNED[song.id]);
    const m = TOREI.scoreResult(r, cs, cfg);
    seeds[song.id] = PINNED[song.id];
    fails += m.fails; shakes += m.shakes;
    console.log(line(song, PINNED[song.id], m, cs) + "  ★確定");
    continue;
  }
  const { best, chordSpots } = optimize(TOREI, song, budget);
  seeds[song.id] = best.seed;
  fails += best.m.fails;
  shakes += best.m.shakes;
  console.log(line(song, best.seed, best.m, chordSpots));
}
console.log("─".repeat(66));
console.log(`所要 ${((Date.now() - t0) / 1000).toFixed(1)}秒 ／ 不可能 ${fails} ／ 振り ${shakes}`);

if (only || dry) {
  console.log("\n（1曲指定または --dry のため js/seeds.js は書き換えていない）");
  process.exit(0);
}

const out = `/* 投鈴 — 曲ごとに確定させた編成の seed（自動生成）
 *
 * tools/optimize.mjs が大きな探索量で選んだ結果。ブラウザはこの seed を1回再現するだけで、
 * 探索し直さない＝配った曲の振り付けが後から黙って変わらない。
 * 楽譜を編集すると seed は捨てられ、その場の探索に切り替わる（js/main.js）。
 *
 * 再生成: node tools/optimize.mjs
 * 探索量: ${budget}シード
 */
window.TOREI = window.TOREI || {};
TOREI.SEEDS = ${JSON.stringify(seeds, null, 2)};
`;
fs.writeFileSync(path.join(ROOT, "js/seeds.js"), out);
console.log(`\njs/seeds.js に ${Object.keys(seeds).length}曲ぶん書き出した。`);
