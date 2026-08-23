#!/usr/bin/env node
/* 投鈴 — 「リングを持っている手でのキャッチ」検出（Node）
 *
 * 物理仕様（2026-08-23 本人確認）: リングを持っている手で別のリングをキャッチすると、
 * 持っている方にも衝撃が伝わって**必ず両方鳴る**。つまり保持キャッチ和音として
 * 意図した場合以外にこれが起きると、楽譜にない音が鳴る振付になる。
 * このスクリプトは全曲の採用スケジュールを走査し、和音フラグのないキャッチの瞬間に
 * 同じ手が別リングを保持しているケースを数える（あるべき値は常に0）。
 *
 * あわせて「キャッチ直前の手放し余裕」も検査する。手が空いてから受け位置へ腕を戻す
 * 時間が要るため、TOREI.SCHED.T_RECOVER（既定0.35秒）を下回るキャッチは実演では
 * 事実上「持ったままキャッチ」になる。本人指定の必要値は
 * 投げてから0.4秒／脇に挟んでから0.3〜0.4秒（2026-08-23）。
 * 占有区間の終わりから数えるので、期待される最小余裕は
 * 投げ: T_THROW+T_RECOVER=0.50秒 ／ 脇: T_RECOVER=0.35秒。
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
const tooTight = [];
for (const s of TOREI.SONGS) {
  const cfg = {nPerformers:s.performers||3, flight:s.flight||1.2, wakiCap:1, maxDup:2,
               allowShake:true, standTime:s.standTime||2.0, passMode:s.passMode||"more"};
  const r = TOREI.schedule({bpm:s.bpm,beatsPerBar:s.beatsPerBar,notes:s.notes}, cfg);
  const evs = [];
  for (const a of r.actions) {
    if (a.type==="catch") evs.push({t:R(a.t), kind:"in", p:a.perf,h:a.hand,ring:a.ring});
    else if (a.type==="pickup") evs.push({t:R(a.t+(a.dur||0)), kind:"in", p:a.perf,h:a.hand,ring:a.ring});
    else if (a.type==="throw") evs.push({t:R(a.t), kind:"out", why:"throw", p:a.perf,h:a.hand,ring:a.ring});
    else if (a.type==="store") {
      evs.push({t:R(a.t+(a.dur||0)), kind:"out", why:"store", p:a.perf,h:a.hand,ring:a.ring});
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
    let lastOut=-Infinity, lastKind="";
    for (const e of evs) if (e.kind==="out" && key(e.p,e.h)===k && e.t<=a.t+1e-6 && e.ring!==a.ring) {
      if (e.t>lastOut) { lastOut=e.t; lastKind=e.why||""; }
    }
    const m=a.t-lastOut;
    // 必要余裕: 投げの直後は占有0.15秒を含むので T_THROW+T_RECOVER
    if (m<1000) {
      const need = (lastKind==="throw" ? TOREI.SCHED.T_THROW : 0) + (TOREI.SCHED.T_RECOVER||0);
      if (m < need - 1e-6) tooTight.push({song:s.id, t:a.t, m, kind:lastKind});
    }
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
const REC = TOREI.SCHED.T_RECOVER || 0;
console.log(totalViol === 0
  ? `ok 全${TOREI.SONGS.length}曲: 意図しない「持ったままキャッチ」（両鳴り）は0件`
  : `NG 合計${totalViol}件 — 楽譜にない音が鳴る振付が生成されている`);
console.log("キャッチ直前の手放し余裕:", JSON.stringify(marginHist));
// 回復時間の不足（投げ後は T_THROW+T_RECOVER、脇/台/逆手の後は T_RECOVER が下限）
const tight = tooTight.length;
console.log(tight === 0
  ? `ok 回復時間（T_RECOVER=${REC}秒）を下回るキャッチも0件`
  : `NG 回復時間不足 ${tight}件: ${tooTight.slice(0,5).map(x=>`${x.song} ${x.t.toFixed(2)}s ${x.kind} ${x.m.toFixed(3)}秒`).join(" / ")}`);
process.exit(totalViol === 0 && tight === 0 ? 0 : 1);
