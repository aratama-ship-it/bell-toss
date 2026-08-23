#!/usr/bin/env node
/* 投鈴 — 「リングを持っている手でのキャッチ」検出（Node）
 *
 * 物理仕様（2026-08-23 本人確認）: リングを持っている手で別のリングをキャッチすると、
 * 持っている方にも衝撃が伝わって**必ず両方鳴る**。つまり保持キャッチ和音として
 * 意図した場合以外にこれが起きると、楽譜にない音が鳴る振付になる。
 * このスクリプトは全曲の採用スケジュールを走査し、和音フラグのないキャッチの瞬間に
 * 同じ手が別リングを保持しているケースを数える（あるべき値は常に0）。
 *
 * あわせて「キャッチ直前の手放し余裕」（同じ手が直前に投げ/置きしてからキャッチまでの
 * 時間）の分布も出す。余裕が短すぎる振付は実演で事実上「持ったままキャッチ」になる。
 *
 * 使い方: node tools/check_held_catch.mjs
 *
 * 実装注意（過去に2度踏んだ罠）:
 * - イベント時刻はマイクロ秒に丸める（pickup完了 t+dur と直後の throw t は数式上同時刻でも
 *   浮動小数点では最下位ビットがずれる。例: 2.9000000000000004+0.7 ≠ 3.6）
 * - 同時刻の in/out は in を先に処理（pickup完了→即throw の連続動作。逆順だと
 *   閉じるはずの区間が開かないまま握りつぶされ、幽霊の長時間保持が生えて誤検出する）
 */
import fs from "node:fs"; import vm from "node:vm"; import path from "node:path";
const ROOT = process.cwd();
globalThis.window = globalThis;
globalThis.localStorage = { getItem: () => null, setItem: () => {} };
for (const f of ["js/presets.js","js/songs.js","js/scheduler.js"])
  vm.runInThisContext(fs.readFileSync(path.join(ROOT,f),"utf8"),{filename:f});

const R = (t) => Math.round(t * 1e6) / 1e6;
let totalViol = 0;
const marginHist = {"<0.1":0,"0.1-0.2":0,"0.2-0.3":0,"0.3-0.5":0,">=0.5":0};
for (const s of TOREI.SONGS) {
  const cfg = {nPerformers:s.performers||3, flight:s.flight||1.2, wakiCap:1, maxDup:2,
               allowShake:true, standTime:s.standTime||2.0, passMode:s.passMode||"more"};
  const r = TOREI.schedule({bpm:s.bpm,beatsPerBar:s.beatsPerBar,notes:s.notes}, cfg);
  const evs = [];
  for (const a of r.actions) {
    if (a.type==="catch") evs.push({t:R(a.t), kind:"in", p:a.perf,h:a.hand,ring:a.ring});
    else if (a.type==="pickup") evs.push({t:R(a.t+(a.dur||0)), kind:"in", p:a.perf,h:a.hand,ring:a.ring});
    else if (a.type==="throw") evs.push({t:R(a.t), kind:"out", p:a.perf,h:a.hand,ring:a.ring});
    else if (a.type==="store") {
      evs.push({t:R(a.t+(a.dur||0)), kind:"out", p:a.perf,h:a.hand,ring:a.ring});
      if (a.to==="otherhand") evs.push({t:R(a.t+(a.dur||0)), kind:"in", p:a.perf,h:1-a.hand,ring:a.ring});
    }
  }
  evs.sort((x,y)=>x.t-y.t || (x.kind==="in"?-1:1));
  const iv={}, opens={};
  const key=(p,h)=>p+":"+h;
  for (const e of evs) {
    const k=key(e.p,e.h);
    iv[k]=iv[k]||[]; opens[k]=opens[k]||{};
    if (e.kind==="in") opens[k][e.ring]=e.t;
    else if (opens[k][e.ring]!=null) { iv[k].push([opens[k][e.ring], e.t, e.ring]); delete opens[k][e.ring]; }
  }
  for (const k in opens) for (const ring in opens[k]) iv[k].push([opens[k][ring], Infinity, +ring]);

  let viol=0;
  for (const a of r.actions) {
    if (a.type!=="catch" || a.chordRole) continue;
    const k=key(a.perf,a.hand);
    for (const [st,en,ring] of (iv[k]||[])) {
      if (ring===a.ring) continue;
      if (st < a.t - 1e-4 && a.t < en - 1e-4) { viol++; break; }
    }
    let lastOut=-Infinity;
    for (const e of evs) if (e.kind==="out" && key(e.p,e.h)===k && e.t<=a.t+1e-6 && e.ring!==a.ring) lastOut=Math.max(lastOut,e.t);
    const m=a.t-lastOut;
    if (m<1000) {
      if (m<0.1) marginHist["<0.1"]++;
      else if (m<0.2) marginHist["0.1-0.2"]++;
      else if (m<0.3) marginHist["0.2-0.3"]++;
      else if (m<0.5) marginHist["0.3-0.5"]++;
      else marginHist[">=0.5"]++;
    }
  }
  if (viol) console.log(`NG ${s.id}: ${viol}件`);
  totalViol += viol;
}
console.log(totalViol === 0
  ? `ok 全${TOREI.SONGS.length}曲: 意図しない「持ったままキャッチ」（両鳴り）は0件`
  : `NG 合計${totalViol}件 — 楽譜にない音が鳴る振付が生成されている`);
console.log("キャッチ直前の手放し余裕:", JSON.stringify(marginHist));
process.exit(totalViol === 0 ? 0 : 1);
