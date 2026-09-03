#!/usr/bin/env node
/* 投鈴 — 編成の物理的な不変条件をスキャンする（Node）
 *
 * スケジューラーの状態機械を変えたら、既存曲だけでなく多数シードで機械的に確かめる
 * （PROJECT_NOTES「保持キャッチ和音」の教訓: 稀な組み合わせでしか出ないバグを見落とす）。
 *
 * 見る不変条件:
 *   1. リング参照の健全性（actions が指すリングが実在するか）
 *   2. 同じ手が同時に2本を持っていないこと
 *      ただし保持キャッチ和音の瞬間だけは「持っていた1本＋キャッチした1本」が
 *      同じ手にあるのが正しい状態なので、そこは違反にしない。
 *
 * 使い方:
 *   node tools/invariants.mjs                全曲を実使用の20シードで
 *   node tools/invariants.mjs --seeds 200    範囲を広げる（採用されない領域も含む）
 *   node tools/invariants.mjs kasanesuzu     曲を指定
 *
 * 注意: TOREI.schedule は seed 0〜19 から最良を選ぶ。20以上のシードは実際には
 * 採用されないので、そこでの違反は「アプリの挙動」ではない。
 */
import fs from "node:fs"; import vm from "node:vm"; import path from "node:path";
const ROOT = process.cwd();
globalThis.window = globalThis;
globalThis.localStorage = { getItem: () => null, setItem: () => {} };
for (const f of ["js/presets.js","js/songs.js","js/scheduler.js"])
  vm.runInThisContext(fs.readFileSync(path.join(ROOT,f),"utf8"),{filename:f});

const T_CATCH = TOREI.SCHED.T_CATCH;

function check(song, seed) {
  const cfg = {nPerformers: song.performers||3, flight: song.flight||1.2, wakiCap:1, maxDup:2,
               allowShake:true, standTime: song.standTime||2.0, passMode: song.passMode||"more"};
  const r = TOREI._scheduleOnce({bpm:song.bpm,beatsPerBar:song.beatsPerBar,notes:song.notes}, cfg, seed);
  const bad = [];

  // 1) リング参照
  for (const a of r.actions) if (!r.rings[a.ring] || r.rings[a.ring].id !== a.ring) bad.push(`ring参照 ${a.type}@${a.t}`);

  // 2) 手の同時保持: (perf,hand) ごとに、在手区間が重ならないこと
  //
  // 注意: 「取得完了時刻」(pickup.t + pickup.dur) と「直後の投げ時刻」(throw.t) は
  // 数式上は一致するはずでも、浮動小数点演算では最下位ビットがずれることがある
  // （実例: 2.9000000000000004 + 0.7 === 3.6000000000000005 ≠ 3.6）。
  // これをそのままソートすると in/out の順序が入れ替わり、閉じるはずの区間が
  // 開かないまま握りつぶされ、後続の別区間と誤って合体する（実際に踏んだ）。
  // ROUND_NS 単位（1000分の1秒=1ms未満）に丸めて、真に同時刻のイベントを
  // 確実に同値として扱う。
  const ROUND = (t) => Math.round(t * 1e6) / 1e6;
  const ev = new Map();  // ring -> events
  for (const a of r.actions) {
    if (!ev.has(a.ring)) ev.set(a.ring, []);
    if (a.type === "catch") ev.get(a.ring).push({t: ROUND(a.t + T_CATCH), in: true, perf: a.perf, hand: a.hand, chord: !!a.chord});
    else if (a.type === "pickup") ev.get(a.ring).push({t: ROUND(a.t + (a.dur||0)), in: true, perf: a.perf, hand: a.hand});
    else if (a.type === "throw" || a.type === "store") ev.get(a.ring).push({t: ROUND(a.t), in: false});
  }
  const perHand = new Map();
  for (const [ring, list] of ev) {
    list.sort((x,y)=>x.t-y.t);
    let open = null;
    for (const e of list) {
      if (e.in) { if (!open) open = {from: e.t, perf: e.perf, hand: e.hand, chord: e.chord}; }
      else if (open) { const k = `${open.perf}:${open.hand}`;
        if (!perHand.has(k)) perHand.set(k, []);
        perHand.get(k).push({ring, from: open.from, to: e.t, chord: open.chord}); open = null; }
    }
    if (open) { const k = `${open.perf}:${open.hand}`;
      if (!perHand.has(k)) perHand.set(k, []);
      perHand.get(k).push({ring, from: open.from, to: Infinity, chord: open.chord}); }
  }
  for (const [k, iv] of perHand) {
    iv.sort((a,b)=>a.from-b.from);
    for (let i=1;i<iv.length;i++) {
      // 和音の瞬間は「持っていた1本 + キャッチした1本」が同じ手にあるのが正しい状態。
      // 持っていた方は直後に分離（逆手/脇/スタンドへ）されるので、その重なりは違反ではない。
      if (iv[i].chord) continue;
      if (iv[i].from < iv[i-1].to - T_CATCH - 1e-6)
        bad.push(`手の二重保持 ${k} ring${iv[i-1].ring}/${iv[i].ring} @${iv[i].from.toFixed(2)}`);
    }
  }
  return bad;
}

const argv = process.argv.slice(2);
let SEEDS = 20;
const at = argv.indexOf("--seeds");
if (at >= 0) { SEEDS = parseInt(argv[at + 1], 10) || 20; argv.splice(at, 2); }
const ids = argv;
const songs = ids.length ? TOREI.SONGS.filter(s=>ids.includes(s.id)) : TOREI.SONGS;
let total = 0;
for (const song of songs) {
  let n = 0;
  for (let seed=0; seed<SEEDS; seed++) n += check(song, seed).length;
  total += n;
  console.log(`${n===0?"ok":"NG"} ${song.id.padEnd(14)} ${SEEDS}シードで違反 ${n}件`);
}
console.log(total === 0 ? `\n対象すべてが ${SEEDS} シードで不変条件を満たす` : `\n違反 合計 ${total}件`);
// tools/verify.mjs（デプロイ前の一括検査）が拾えるよう、違反があれば非0で終了
// （2026-08-26 レビュー #4。従来は出力を人が目視するだけだった）
if (total > 0) process.exit(1);
