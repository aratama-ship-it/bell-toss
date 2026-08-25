#!/usr/bin/env node
/* 投鈴 — 作曲支援の測定器（Node）
 *
 * なぜ要るか: 「保持キャッチ和音」（片手が静かに持っているリングに、同じ手で別のリングを
 * キャッチして両方鳴らす技法）は、スケジューラーが受動的に見つけたときだけ成立する。
 * 作曲側が同時刻2音を書いても、それが1手の和音になったのか、単に2人へ振り分けられたのかは
 * ブラウザで行動表を目視するまで分からなかった。狙って和音を書くには、まず測れる必要がある。
 *
 * このスクリプトはブラウザを介さず js/scheduler.js を直接回し、
 * 「楽譜に書いた同時刻2音」が実際にどう処理されたかを箇所ごとに報告する。
 *
 * 使い方:
 *   node tools/analyze.mjs                  全曲のサマリ
 *   node tools/analyze.mjs gomon            1曲の詳細（和音の箇所ごとの成否）
 *   node tools/analyze.mjs gomon --seeds 50 50シードを直接スキャンして成立率の安定性を見る
 *   node tools/analyze.mjs --file tmp.json  js/songs.js と同じ形の曲を外から与える（作曲中の試し打ち）
 *
 * 注意: js/scheduler.js と js/songs.js はDOM非依存だが、js/presets.js だけ
 * window と localStorage に触るためシムを入れている。
 */
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const EPS = 1e-6;

/* ---------- ブラウザのグローバルを最小限だけ用意して js/ を読み込む ---------- */

function loadTorei() {
  globalThis.window = globalThis;
  globalThis.localStorage = { getItem: () => null, setItem: () => {} };
  for (const f of ["js/presets.js", "js/songs.js", "js/seeds.js", "js/scheduler.js"]) {
    const p = path.join(ROOT, f);
    vm.runInThisContext(fs.readFileSync(p, "utf8"), { filename: p });
  }
  return globalThis.TOREI;
}

/* ---------- 曲 → スケジューラー入力 ---------- */

// js/main.js の state.cfg 既定値に、曲プリセットの推奨設定を上書きしたもの。
// アプリで曲を選んだ直後とまったく同じ条件で回すため、ここはアプリ側と揃える。
function cfgFor(song) {
  return {
    // 配布時に確定させた編成をそのまま測る。ここを空にすると、ツールの数字と
    // 実際に配られる曲の中身がズレる（2026-08-25 二段構えの導入に伴い追加）。
    seed: (globalThis.TOREI && globalThis.TOREI.SEEDS) ? globalThis.TOREI.SEEDS[song.id] : undefined,
    nPerformers: song.performers || 3,
    flight: song.flight || 1.2,
    wakiCap: song.wakiCap ?? 1,
    maxDup: song.maxDup ?? 2,
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

/* ---------- 楽譜に書かれた「同時刻2音以上」の箇所 ---------- */

function writtenChords(song) {
  const byBeat = new Map();
  song.notes.forEach((n, i) => {
    const k = n.beat.toFixed(6);
    if (!byBeat.has(k)) byBeat.set(k, { beat: n.beat, idxs: [], midis: [] });
    byBeat.get(k).idxs.push(i);
    byBeat.get(k).midis.push(n.midi);
  });
  return [...byBeat.values()].filter(g => g.idxs.length >= 2)
    .sort((a, b) => a.beat - b.beat);
}

/* ---------- リングが「手に静かにある」時間帯の再構成 ---------- */

// 和音が不成立だったとき、原因が作曲側にあるのか（そもそも該当音高のリングを
// 誰も手に持っていない）スケジューラー側の都合なのか（持ってはいたが分離できない等）を
// 切り分けるための近似。actions から各リングの在手区間を組み直す。
// 手に入る: catch(+0.25秒) / pickup(+dur) ｜ 手から出る: throw / store
function inHandIntervals(result) {
  // ROUND: 取得完了時刻(pickup.t+dur)と直後の投げ時刻(throw.t)は数式上は一致するはずでも
  // 浮動小数点では最下位ビットがずれることがある。丸めないと in/out の順序が入れ替わり、
  // 閉じるはずの区間が握りつぶされて後続の別区間と誤って合体する
  // （tools/invariants.mjs で実際に踏んだのと同じ罠。ここも同じ丸めを入れる）。
  const ROUND = (t) => Math.round(t * 1e6) / 1e6;
  const byRing = new Map();
  for (const a of result.actions) {
    if (!byRing.has(a.ring)) byRing.set(a.ring, []);
    const ev = byRing.get(a.ring);
    if (a.type === "catch") ev.push({ t: ROUND(a.t + 0.25), in: true, perf: a.perf, hand: a.hand });
    else if (a.type === "pickup") ev.push({ t: ROUND(a.t + (a.dur || 0)), in: true, perf: a.perf, hand: a.hand });
    else if (a.type === "throw" || a.type === "store") ev.push({ t: ROUND(a.t), in: false });
  }
  const out = new Map();
  for (const [ring, ev] of byRing) {
    ev.sort((x, y) => x.t - y.t);
    const iv = [];
    let open = null;
    for (const e of ev) {
      if (e.in) { if (!open) open = { from: e.t, perf: e.perf, hand: e.hand }; }
      else if (open) { iv.push({ ...open, to: e.t }); open = null; }
    }
    if (open) iv.push({ ...open, to: Infinity });
    out.set(ring, iv);
  }
  return out;
}

function holdersAt(result, intervals, midi, t) {
  const found = [];
  for (const r of result.rings) {
    if (r.midi !== midi) continue;
    for (const iv of intervals.get(r.id) || []) {
      if (iv.from <= t - 1e-4 && iv.to > t + 1e-4) found.push({ ring: r, iv });
    }
  }
  return found;
}

/* ---------- 1箇所の判定 ---------- */

// 判定は actions を見る。noteResults にも chord フラグはあるが「持っていた側」にしか付かず、
// 「新しく取った側」は chordRole:"new" のアクションにしか出ないため。
function classifySpot(spot, result, spb, TOREI, intervals) {
  const t = spot.beat * spb;
  const acts = result.actions.filter(
    a => Math.abs(a.t - t) < 1e-4 && spot.idxs.includes(a.noteIdx) &&
         (a.type === "catch" || a.type === "shake"));
  const held = acts.find(a => a.chordRole === "held");
  const fresh = acts.find(a => a.chordRole === "new");
  const kinds = spot.idxs.map(i => (result.noteResults[i] || {}).kind);
  const perfs = spot.idxs.map(i => (result.noteResults[i] || {}).perf);
  const hands = spot.idxs.map(i => (result.noteResults[i] || {}).hand);

  if (held && fresh && held.perf === fresh.perf && held.hand === fresh.hand) {
    const cover = spot.idxs.length > 2 ? `（${spot.idxs.length}音中2音）` : "";
    return {
      ok: true, kind: "chord",
      detail: `${TOREI.perfName(held.perf)}の${["左手", "右手"][held.hand]}で1手和音${cover}`,
    };
  }
  if (kinds.includes("fail")) return { ok: false, kind: "fail", detail: "不可能な音を含む" };
  if (kinds.includes("shake")) return { ok: false, kind: "shake", detail: "振りで代用した音を含む" };
  // 直前にどれかの音高のリングが手に静かにあったか（＝和音の素材があったか）
  const cands = spot.midis.flatMap(m => holdersAt(result, intervals, m, t - 0.3)
    .map(h => `${TOREI.noteName(m)}(${TOREI.perfName(h.iv.perf)})`));
  const why = cands.length
    ? `素材はあった: ${[...new Set(cands)].join("・")} → 分離経路か投げ側の都合で不採用`
    : "そもそもどの音高のリングも手に静かに置かれていない → 作曲で直せる";

  // 1手和音ではないが、全音が普通のキャッチとして実現している場合は「和音としては鳴る」。
  // 鳴らない（不可能・振り代用）のとは意味が違うので区別する。1手和音は一撃なので必ず揃うが、
  // 分かれた場合は演者どうしのタイミング精度に依存する、という差でしかない。
  const sounds = !kinds.includes("fail") && !kinds.includes("shake") &&
                 spot.idxs.every(i => (result.noteResults[i] || {}).kind === "toss");

  const uniqPerf = new Set(perfs.filter(p => p != null));
  if (uniqPerf.size >= 2) {
    return { ok: false, sounds, kind: "split-perf",
             detail: `${uniqPerf.size}人が同時に鳴らす（和音にはなる。1手の一撃ではないので揃えは演者次第）｜${why}` };
  }
  if (new Set(hands.filter(h => h != null)).size >= 2) {
    return { ok: false, sounds, kind: "split-hand",
             detail: `同じ演者の左右の手に分かれた（和音にはなる）｜${why}` };
  }
  return { ok: false, sounds, kind: "other", detail: `判定できない組み合わせ｜${why}` };
}

/* ---------- 1曲を測る ---------- */

function analyze(song, TOREI, seed) {
  const cfg = cfgFor(song);
  const melody = melodyFor(song);
  const result = seed == null
    ? TOREI.schedule(melody, cfg)
    : TOREI._scheduleOnce(melody, cfg, seed);
  const spb = 60 / song.bpm;

  const throws = result.actions.filter(a => a.type === "throw");
  const passes = throws.filter(a => a.pass).length;
  const intervals = inHandIntervals(result);
  const spots = writtenChords(song).map(s => ({ ...s, ...classifySpot(s, result, spb, TOREI, intervals) }));

  return {
    song, cfg, result, spots,
    fails: result.noteResults.filter(x => x && x.kind === "fail").length,
    shakes: result.noteResults.filter(x => x && x.kind === "shake").length,
    ringCount: result.rings.length,
    passRate: throws.length ? passes / throws.length : 0,
    chordSpots: spots.length,
    chordHits: spots.filter(s => s.ok).length,
    chordSounds: spots.filter(s => s.ok || s.sounds).length,
    pitches: new Set(song.notes.map(n => n.midi)).size,
  };
}

/* ---------- 出力 ---------- */

const pad = (s, n) => String(s).padEnd(n, " ");
const padL = (s, n) => String(s).padStart(n, " ");

function printSummary(rows) {
  console.log("");
  console.log(pad("曲", 26) + padL("音数", 5) + padL("音高", 5) + padL("人", 3) +
              padL("BPM", 5) + padL("リング", 7) + padL("パス", 6) +
              padL("振り", 5) + padL("不可", 5) + padL("和音1手/鳴/計", 14));
  console.log("─".repeat(80));
  for (const r of rows) {
    // 「1手和音の数／実際に鳴る数／書いた数」。真ん中が書いた数と等しければ、和音は全部鳴っている。
    const chord = r.chordSpots ? `${r.chordHits}/${r.chordSounds}/${r.chordSpots}` : "－";
    console.log(
      pad(r.song.name.replace(/\s*※.*$/, ""), 26) +
      padL(r.song.notes.length, 5) + padL(r.pitches, 5) +
      padL(r.cfg.nPerformers, 3) + padL(r.song.bpm, 5) +
      padL(r.ringCount, 7) + padL((r.passRate * 100).toFixed(0) + "%", 6) +
      padL(r.shakes, 5) + padL(r.fails, 5) + padL(chord, 14));
  }
  const tot = rows.reduce((a, r) => ({
    spots: a.spots + r.chordSpots, hits: a.hits + r.chordHits,
    sounds: a.sounds + r.chordSounds,
    shakes: a.shakes + r.shakes, fails: a.fails + r.fails,
  }), { spots: 0, hits: 0, sounds: 0, shakes: 0, fails: 0 });
  console.log("─".repeat(80));
  console.log(`合計: 書かれた和音 ${tot.spots}箇所 → 和音として鳴る ${tot.sounds}箇所` +
              `（うち1手の保持キャッチ和音 ${tot.hits}箇所）` +
              ` ／ 鳴らない ${tot.spots - tot.sounds}箇所 ／ 振り ${tot.shakes} ／ 不可能 ${tot.fails}`);
  console.log("");
}

function printDetail(r, TOREI) {
  const s = r.song;
  console.log("");
  console.log(`${s.name}  (${s.bpm}BPM / ${s.beatsPerBar}拍子 / ${r.cfg.nPerformers}人 / 滞空${r.cfg.flight}秒)`);
  if (s.desc) console.log(`  ${s.desc}`);
  console.log(`  音数 ${s.notes.length} ／ 音高 ${r.pitches} ／ リング ${r.ringCount}本 ／ ` +
              `パス ${(r.passRate * 100).toFixed(0)}% ／ 振り ${r.shakes} ／ 不可能 ${r.fails}`);
  // どの音高が複製されたかは「その音高が詰まりすぎ」のサイン。作曲の直し所になる
  const dup = {};
  for (const ring of r.result.rings) {
    const n = TOREI.noteName(ring.midi);
    dup[n] = (dup[n] || 0) + 1;
  }
  console.log(`  リング内訳: ${Object.entries(dup).map(([n, c]) => n + (c > 1 ? `×${c}` : "")).join(" ")}`);
  console.log("");
  if (!r.spots.length) {
    console.log("  楽譜に同時刻2音がない（和音の機会そのものがない）");
    console.log("");
    return;
  }
  console.log(`  書かれた和音 ${r.chordSpots}箇所 → 和音として鳴る ${r.chordSounds}箇所` +
              `（うち1手の保持キャッチ和音 ${r.chordHits}箇所）`);
  console.log("    ○=1手の保持キャッチ和音（一撃で必ず揃う）  △=鳴るが複数の手／演者に分かれる  ×=和音として鳴らない");
  const bpb = s.beatsPerBar || 4;
  for (const sp of r.spots) {
    const bar = Math.floor(sp.beat / bpb) + 1;
    const bi = (sp.beat - (bar - 1) * bpb) + 1;
    const names = sp.midis.map(m => TOREI.noteName(m)).join("+");
    const mark = sp.ok ? "○" : (sp.sounds ? "△" : "×");
    console.log(`    ${mark} ${padL(bar, 3)}小節${bi.toFixed(bi % 1 ? 1 : 0)}拍  ` +
                `${pad(names, 12)} ${sp.detail}`);
  }
  console.log("");
}

function printSeedScan(song, TOREI, n) {
  const hits = [];
  let fails = 0, shakes = 0;
  for (let seed = 0; seed < n; seed++) {
    const r = analyze(song, TOREI, seed);
    hits.push(r.chordHits);
    fails += r.fails; shakes += r.shakes;
  }
  const spots = writtenChords(song).length;
  const avg = hits.reduce((a, b) => a + b, 0) / n;
  console.log("");
  console.log(`${song.name}: ${n}シードの直接スキャン`);
  console.log(`  書かれた和音 ${spots}箇所 ／ 成立数 最小 ${Math.min(...hits)} ・ 平均 ${avg.toFixed(1)} ・ 最大 ${Math.max(...hits)}`);
  console.log(`  振り 延べ${shakes} ／ 不可能 延べ${fails}`);
  console.log("  ※配布される編成は js/seeds.js で確定済み（tools/optimize.mjs が選定）。");
  console.log("  　単独シードには破綻するものが混ざるのが普通（例: 五音の橋も60シード中に不可能46件を含む）。");
  console.log("  　見るべきは平均と最大。平均が箇所数に近いほど、和音は運ではなく構造で出ている。");
  console.log("");
}

/* ---------- エントリポイント ---------- */

function main() {
  const TOREI = loadTorei();
  const args = process.argv.slice(2);
  let songs = TOREI.SONGS;

  const fileAt = args.indexOf("--file");
  if (fileAt >= 0) {
    const extra = JSON.parse(fs.readFileSync(args[fileAt + 1], "utf8"));
    songs = Array.isArray(extra) ? extra : [extra];
    args.splice(fileAt, 2);
  }

  const seedsAt = args.indexOf("--seeds");
  let seeds = 0;
  if (seedsAt >= 0) { seeds = parseInt(args[seedsAt + 1], 10) || 50; args.splice(seedsAt, 2); }

  const id = args[0];
  if (id) {
    const song = songs.find(s => s.id === id);
    if (!song) {
      console.error(`曲 "${id}" が見つからない。候補: ${songs.map(s => s.id).join(", ")}`);
      process.exit(1);
    }
    if (seeds) printSeedScan(song, TOREI, seeds);
    else printDetail(analyze(song, TOREI), TOREI);
    return;
  }
  printSummary(songs.map(s => analyze(s, TOREI)));
}

main();
