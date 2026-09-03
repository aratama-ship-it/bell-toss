#!/usr/bin/env node
/* 投鈴 — スケジューラーの出力を丸ごと固定して照合する「黄金ハッシュ」検査（Node）
 *
 * なぜ要るか（2026-09-04 レビュー#5 の着手時）: _scheduleOnce は約1,200行の単一クロージャで、
 * 分割（リファクタ）の安全を確かめる手段が無かった。verify.mjs の完成曲ハッシュは
 * js/frozen.js に保存済みのデータを見るだけで、スケジューラーを再実行しない。
 * つまり「振る舞いを変えないはずの整理」で振る舞いが変わっても、どの検査も気づかない。
 *
 * このスクリプトは全34曲 × 複数seed（＋人間の編集 fix を含む合成ケース）で
 * _scheduleOnce を実際に走らせ、結果オブジェクト全体（actions/rings/warnings/
 * noteResults/minT/fixDrops…）の JSON ハッシュを tools/golden.json に記録・照合する。
 * seed は 0〜11 で avoidLevel(seed%3) × passAggressive(floor(seed/3)%2) × 開演配置の
 * 組み合わせが一巡するぶん、それに配布用の確定seed（js/seeds.js）を足す。
 *
 * 使い方:
 *   node tools/golden.mjs --record   今の出力を正として tools/golden.json に書く
 *   node tools/golden.mjs            golden.json と照合。1件でも違えば非0で終了
 *
 * ★スケジューラーの振る舞いを意図して変えたとき（ルール追加・重み調整）は照合が落ちる。
 *   それが意図どおりなら --record で正を更新する。同時に js/seeds.js も古くなるので
 *   tools/optimize.mjs の再実行を検討すること（完成曲 frozen.js は影響を受けない）。
 */
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const OUT = path.join(ROOT, "tools/golden.json");
const record = process.argv.includes("--record");

globalThis.window = globalThis;
globalThis.localStorage = { getItem: () => null, setItem: () => {} };
for (const f of ["js/presets.js", "js/songs.js", "js/seeds.js", "js/scheduler.js"]) {
  vm.runInThisContext(fs.readFileSync(path.join(ROOT, f), "utf8"), { filename: f });
}
const TOREI = globalThis.TOREI;

const sha = (s) => crypto.createHash("sha256").update(s).digest("hex").slice(0, 16);

function cfgFor(song) {
  return {
    nPerformers: song.performers || 3, flight: song.flight || 1.2,
    wakiCap: song.wakiCap ?? 1, maxDup: song.maxDup ?? 2, maxRings: song.maxRings || null,
    allowShake: song.allowShake ?? true, standTime: song.standTime || 2.0,
    passMode: song.passMode || "more",
  };
}

// 人間の編集（fix）の経路も検査に含める。UIと同じく和音の音には付けない。
// 4種類: 高さ指定／受ける人指定／受ける手だけ指定／ロック（投げ手まで固定・意図的に
// 成立しないこともある → 段階的に緩める経路と fixDrops の集計まで検査に入る）
function withFixes(song) {
  const EPS = 1e-6;
  const notes = song.notes.map(n => ({ beat: n.beat, midi: n.midi }));
  const isChord = (i) => notes.filter(m => Math.abs(m.beat - notes[i].beat) < EPS).length >= 2;
  const n = notes.length;
  const put = (i, fix) => { if (i < n && !isChord(i)) notes[i].fix = fix; };
  put(0, { level: 2 });
  if ((song.performers || 3) > 1) put(2, { catchPerf: 1 });
  put(4, { catchHand: 0 });
  put(6, { locked: true, throwPerf: 0, throwHand: 1, catchPerf: 0, catchHand: 1, level: 3 });
  return notes;
}

function runCase(song, seed, notes) {
  const melody = { bpm: song.bpm, beatsPerBar: song.beatsPerBar, notes };
  const cfg = cfgFor(song);
  const r = TOREI._scheduleOnce(melody, cfg, seed);
  // scoreResult も一緒にハッシュする（2026-09-04 レビュー#6）。_scheduleOnce の結果だけでは
  // 採点（TOREI.scoreResult）の回帰は検出できない——schedule()/optimize.mjs はこの関数で
  // シードを選ぶが、golden.mjs はここまで直接 _scheduleOnce を呼んで scoreResult を経由しない
  // ため、重みの集約などscoreResult自体の変更を確かめる安全網が別途要る。
  const chordSpots = TOREI.countChordSpots(melody);
  const score = TOREI.scoreResult(r, chordSpots, cfg);
  return sha(JSON.stringify({ r, score }));
}

const cases = {};
const t0 = Date.now();
for (const song of TOREI.SONGS) {
  const plain = song.notes.map(n => ({ beat: n.beat, midi: n.midi }));
  const seeds = new Set([...Array(12).keys()]);
  const pinned = (TOREI.SEEDS || {})[song.id];
  if (pinned != null) seeds.add(pinned);
  for (const seed of [...seeds].sort((a, b) => a - b)) {
    cases[`${song.id}:${seed}`] = runCase(song, seed, plain);
  }
  cases[`${song.id}:3:fix`] = runCase(song, 3, withFixes(song));
}
const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
const nCases = Object.keys(cases).length;

if (record) {
  fs.writeFileSync(OUT, JSON.stringify({
    recordedAt: new Date().toISOString().slice(0, 10),
    schedulerSrcHash: sha(fs.readFileSync(path.join(ROOT, "js/scheduler.js"), "utf8")),
    note: "tools/golden.mjs --record で生成。_scheduleOnce の結果全体のsha256先頭16桁。",
    cases,
  }, null, 1) + "\n");
  console.log(`黄金ハッシュを記録した: ${nCases}件（${TOREI.SONGS.length}曲・${elapsed}秒）→ tools/golden.json`);
  process.exit(0);
}

if (!fs.existsSync(OUT)) {
  console.error("tools/golden.json が無い。先に node tools/golden.mjs --record を実行すること");
  process.exit(1);
}
const gold = JSON.parse(fs.readFileSync(OUT, "utf8"));
const diffs = [];
for (const [k, h] of Object.entries(cases)) {
  if (gold.cases[k] == null) diffs.push(`${k}: 記録に無い（新しい曲かseed。--record で追加）`);
  else if (gold.cases[k] !== h) diffs.push(`${k}: ${gold.cases[k]} → ${h}`);
}
for (const k of Object.keys(gold.cases)) {
  if (cases[k] == null) diffs.push(`${k}: 記録にあるが今は生成されない（曲が消えた？）`);
}
if (diffs.length) {
  console.log(`✗ スケジューラーの出力が記録（${gold.recordedAt}）と違う: ${diffs.length}/${nCases}件`);
  for (const d of diffs.slice(0, 12)) console.log(`    ${d}`);
  if (diffs.length > 12) console.log(`    …他 ${diffs.length - 12}件`);
  console.log("  振る舞いを変えるつもりが無いなら回帰。意図した変更なら node tools/golden.mjs --record で正を更新し、"
    + " tools/optimize.mjs の再実行も検討すること");
  process.exit(1);
}
console.log(`ok スケジューラーの出力は記録（${gold.recordedAt}）と全件一致: ${nCases}件（${elapsed}秒）`);
process.exit(0);
