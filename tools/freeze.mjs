#!/usr/bin/env node
/* 投鈴 — 完成した曲の振付を「データそのもの」として焼き付ける（Node）
 *
 * なぜ要るか（2026-08-26）: seed の固定だけでは振付は守れない。seed は乱択の選択を
 * 固定するだけで、スケジューラーのアルゴリズムを改良すると同じ seed でも別の振付が出る
 * （実測: bestCatch の回避を精密化しただけで bunbun seed117 の行動列が変わった）。
 * 完成した曲は schedule() の結果（actions/rings/noteResults/warnings/minT）を JSON として
 * js/frozen.js に保存し、ブラウザは再計算せずそれを再生する。以後どれだけスケジューラーが
 * 変わっても、完成曲の振付は1ミリも動かない。
 *
 * 使い方:
 *   node tools/freeze.mjs bunbun 117            現在のコードで seed117 を焼き付ける
 *   node tools/freeze.mjs bunbun 117 --from-git 直前のコミットのスケジューラーで焼き付ける
 *                                               （アルゴリズム変更後に、変更前の振付を救うため）
 *   node tools/freeze.mjs bunbun --resign        振付（actions等）はそのまま、曲の署名
 *                                               （melodySig）だけ今の js/songs.js から
 *                                               作り直す。_scheduleOnceは呼ばない
 * 既存の焼き付けは保持され、指定した曲だけ追加・上書きされる。
 *
 * melodySig（2026-09-04 レビュー#3）: 焼き付けが「どの楽譜のものか」の署名。
 * songs.js を編集して1音でも変わると、古い焼き付けが黙って別の楽譜に貼り付く事故を防ぐため、
 * TOREI.songSignature(song) を保存し、読み込み時（js/main.js・tools/verify.mjs）に照合する。
 * ★通常の焼き付け（seed指定）はその場で計算した現在の署名を書くので、seed指定の再焼き付けは
 * 常に安全。--resign は「actionsは変えたくないが署名だけ足したい／作り直したい」ときに使う
 * （actionsを変えずに済むぶん、スケジューラーのドリフトで振付が変わる心配がない）。
 */
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const args = process.argv.slice(2);
const fromGit = args.includes("--from-git");
const resign = args.includes("--resign");
const [id, seedStr] = args.filter(a => !a.startsWith("--"));
const seed = Number(seedStr);
if (!id || (!resign && !Number.isFinite(seed))) {
  console.error("使い方: node tools/freeze.mjs <曲id> <seed> [--from-git]");
  console.error("      node tools/freeze.mjs <曲id> --resign   （actionsはそのまま署名だけ作り直す）");
  process.exit(1);
}

globalThis.window = globalThis;
globalThis.localStorage = { getItem: () => null, setItem: () => {} };
for (const f of ["js/presets.js", "js/songs.js"]) {
  vm.runInThisContext(fs.readFileSync(path.join(ROOT, f), "utf8"), { filename: f });
}
const schedSrc = fromGit
  ? execSync("git show HEAD:js/scheduler.js", { cwd: ROOT, encoding: "utf8" })
  : fs.readFileSync(path.join(ROOT, "js/scheduler.js"), "utf8");
vm.runInThisContext(schedSrc, { filename: "scheduler" + (fromGit ? "(HEAD)" : "") });
const TOREI = globalThis.TOREI;

const song = TOREI.SONGS.find(s => s.id === id);
if (!song) { console.error(`曲 "${id}" が見つからない`); process.exit(1); }

// 既存の焼き付けを読み込む（両モード共通）
const outPath = path.join(ROOT, "js/frozen.js");
let existing = {};
if (fs.existsSync(outPath)) {
  const ctx = { window: {} }; ctx.TOREI = {}; vm.createContext(ctx);
  vm.runInContext("window.TOREI = window.TOREI || {};" , ctx);
  try {
    vm.runInContext(fs.readFileSync(outPath, "utf8").replace("window.TOREI = window.TOREI || {};", ""), ctx);
    existing = ctx.TOREI.FROZEN || {};
  } catch (e) { /* 壊れていたら作り直す */ }
}

function writeFrozen() {
  fs.writeFileSync(outPath,
    `/* 投鈴 — 完成した曲の振付（焼き付け・自動生成: tools/freeze.mjs）
 * seed固定では守れない: スケジューラーを改良すると同じseedでも別の振付になるため、
 * 完成曲は結果データそのものを保存する。ブラウザは再計算せずこれを再生する。
 * 楽譜や設定を編集した場合だけ、通常の探索に切り替わる（js/main.js）。
 * melodySig: どの楽譜（音符・BPM・拍子・演者数など）に対する焼き付けかの署名
 * （2026-09-04）。songs.jsを編集して1音でも変わると不一致になり、js/main.jsと
 * tools/verify.mjsが検出して古い焼き付けを使わないようにする。 */
window.TOREI = window.TOREI || {};
TOREI.FROZEN = ${JSON.stringify(existing)};
`);
}

if (resign) {
  // ★actions等は一切触らない。今のscheduler.jsで_scheduleOnceを呼ぶと、
  // 前回の焼き付け以降にスケジューラーが変わっていた場合、別の振付を上書きしてしまう
  // （実測: bunbunで発生。2026-09-04発見）。署名だけを今のsongs.jsから作り直す
  const prev = existing[id];
  if (!prev) { console.error(`${id} はまだ焼き付けられていない（--resignは既存の焼き付けの署名を更新するだけ）`); process.exit(1); }
  const oldSig = prev.melodySig || "(未設定)";
  prev.melodySig = TOREI.songSignature(song);
  writeFrozen();
  console.log(`${id} の署名を今の楽譜で更新した（actions等は不変・seed${prev.seed}のまま）`);
  console.log(`  旧署名: ${oldSig}`);
  console.log(`  新署名: ${prev.melodySig}`);
  process.exit(0);
}

const cfg = {
  nPerformers: song.performers || 3, flight: song.flight || 1.2,
  wakiCap: song.wakiCap ?? 1, maxDup: song.maxDup ?? 2, maxRings: song.maxRings || null,
  allowShake: song.allowShake ?? true, standTime: song.standTime || 2.0,
  passMode: song.passMode || "more",
};
const melody = { bpm: song.bpm, beatsPerBar: song.beatsPerBar,
  notes: song.notes.map(n => ({ beat: n.beat, midi: n.midi })) };
const r = TOREI._scheduleOnce(melody, cfg, seed);
const fails = r.noteResults.filter(x => x && x.kind === "fail").length;
if (fails > 0) { console.error(`不可能音 ${fails} 件を含む結果は焼き付けない`); process.exit(1); }

existing[id] = {
  seed, frozenAt: new Date().toISOString().slice(0, 10),
  melodySig: TOREI.songSignature(song),
  actions: r.actions, rings: r.rings, warnings: r.warnings,
  noteResults: r.noteResults, minT: r.minT,
};
const th = r.actions.filter(a => a.type === "throw");
const rate = Math.round(th.filter(a => a.pass).length / th.length * 100);
writeFrozen();
console.log(`${id} seed${seed} を焼き付けた（パス${rate}% リング${r.rings.length}本 動作${r.actions.length}件）→ js/frozen.js`);
