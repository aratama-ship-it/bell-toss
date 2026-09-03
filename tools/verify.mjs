#!/usr/bin/env node
/* 投鈴 — デプロイ前の一括検査（Node）
 *
 * なぜ要るか（2026-08-26 レビュー #4）: これまで検証は analyze.mjs / invariants.mjs /
 * check_held_catch.mjs の3本を人が手で回す運用だった。忘れれば壊れたまま公開できる。
 * さらに、完成曲（js/frozen.js）はスケジューラーの変更で振付が黙って動くことがあり
 * （実測: bestCatch の回避を精密化しただけで bunbun seed117 の行動列が変わった。
 * #2の修正時に発見）、既存3ツールはそこを見ていなかった。
 *
 * このスクリプトは:
 *   1. 既存3ツールを実使用の既定条件で実行（曲・音楽的な整合性／不変条件／両鳴り・回復時間）
 *   2. 完成曲（js/frozen.js）のハッシュを、下の PINNED_HASHES に固定した値と照合。
 *      1文字でもズレたら「完成曲が動いた」ことを検出して落とす
 *   3. 完成曲の melodySig（どの楽譜のものかの署名）を、今の js/songs.js の該当曲と照合
 *      （2026-09-04 レビュー#3）。songs.js を編集して1音でも変われば不一致で検出する
 * を通し、1つでも不合格なら非0で終了する。デプロイ前に必ずこれを走らせる運用にする。
 *
 * 新しい曲を完成として焼き付けたら（tools/freeze.mjs）、このファイル冒頭の
 * PINNED_HASHES にそのハッシュを追記すること（意図的な追記を強制するための設計。
 * 追記を忘れている＝焼き付けたことをまだ確定していない、という扱いにする）。
 *
 * 使い方: node tools/verify.mjs
 * 将来: GitHub Actions に push フックとして載せれば自動化できる（今回は未実装）。
 */
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

// 完成曲（js/frozen.js）の承認済みハッシュ。tools/freeze.mjs で焼き付けたら、
// このリストにも手で追記する（実測値は本コマンドの失敗メッセージにも出す）。
const PINNED_HASHES = {
  bunbun: "2db3c6b683be1c59",
};

function frozenHash(actions) {
  return crypto.createHash("sha256").update(JSON.stringify(actions)).digest("hex").slice(0, 16);
}

function runTool(label, file, args = []) {
  process.stdout.write(`\n${"═".repeat(60)}\n▶ ${label}\n${"═".repeat(60)}\n`);
  try {
    execFileSync(process.execPath, [path.join(ROOT, file), ...args], { cwd: ROOT, stdio: "inherit" });
    return true;
  } catch (e) {
    // execFileSync は非0終了で例外を投げる。出力は stdio:"inherit" で既に流れている
    return false;
  }
}

function checkFrozenIntegrity() {
  process.stdout.write(`\n${"═".repeat(60)}\n▶ 完成曲（js/frozen.js）のハッシュ・署名照合\n${"═".repeat(60)}\n`);
  globalThis.window = globalThis;
  globalThis.localStorage = { getItem: () => null, setItem: () => {} };
  // scheduler.js は TOREI.songSignature（melodySig照合に使う）を持つので追加で読む
  for (const f of ["js/presets.js", "js/songs.js", "js/frozen.js", "js/scheduler.js"]) {
    vm.runInThisContext(fs.readFileSync(path.join(ROOT, f), "utf8"), { filename: f });
  }
  const TOREI = globalThis.TOREI;
  const frozen = TOREI.FROZEN || {};
  const ids = Object.keys(frozen);
  if (!ids.length) {
    console.log("  完成曲は0件（まだ何も焼き付けていない）");
    return true;
  }
  let ok = true;
  for (const id of ids) {
    const entry = frozen[id];
    const h = frozenHash(entry.actions);
    const pinned = PINNED_HASHES[id];
    let entryOk = true;
    if (pinned == null) {
      console.log(`  ✗ ${id}: PINNED_HASHESに未登録（実測 ${h}）。`
        + ` tools/verify.mjs 冒頭に "${id}": "${h}" を追記して承認すること`);
      entryOk = false;
    } else if (h !== pinned) {
      console.log(`  ✗ ${id}: 振付が変わっている！ 承認済み ${pinned} → 実測 ${h}`
        + `（スケジューラーの変更で完成曲が動いた可能性。意図した変更なら承認して`
        + ` PINNED_HASHES を更新、そうでなければ原因を調べること）`);
      entryOk = false;
    }
    // melodySig: 焼き付け時の楽譜と、今の js/songs.js の該当曲が一致するか
    const song = TOREI.SONGS.find(s => s.id === id);
    if (!song) {
      console.log(`  ✗ ${id}: js/songs.js に該当曲が見つからない（曲IDが変わった、または削除された）`);
      entryOk = false;
    } else if (!entry.melodySig) {
      console.log(`  ✗ ${id}: melodySig が未設定（古い形式の焼き付け）。`
        + ` node tools/freeze.mjs ${id} --resign で署名だけ追記できる`);
      entryOk = false;
    } else {
      const nowSig = TOREI.songSignature(song);
      if (nowSig !== entry.melodySig) {
        console.log(`  ✗ ${id}: 楽譜が焼き付け時と変わっている（songs.jsが編集された）。`
          + ` 曲の変更が意図的なら node tools/freeze.mjs ${id} <seed> で焼き直すこと`);
        entryOk = false;
      }
    }
    if (entryOk) {
      console.log(`  ok ${id}: ${h}（承認済みと一致・楽譜も一致・seed${entry.seed}・${entry.frozenAt}凍結）`);
    } else {
      ok = false;
    }
  }
  return ok;
}

const results = [];
results.push(["曲の音楽的整合性（analyze.mjs）", runTool("analyze.mjs — 不可能音・和音の成否", "tools/analyze.mjs")]);
results.push(["物理的な不変条件（invariants.mjs）", runTool("invariants.mjs — 手の二重保持など", "tools/invariants.mjs")]);
results.push(["両鳴り・回復時間（check_held_catch.mjs）", runTool("check_held_catch.mjs — 持ったままキャッチ", "tools/check_held_catch.mjs")]);
results.push(["完成曲のハッシュ照合", checkFrozenIntegrity()]);
// スケジューラーの出力そのものの回帰（2026-09-04 レビュー#5）。上の完成曲ハッシュは保存済みデータを
// 見るだけで _scheduleOnce を再実行しない。こちらは全曲×seed×fix を実際に走らせて記録と照合する。
// 振る舞いを意図して変えたときは node tools/golden.mjs --record で正を更新する
results.push(["スケジューラー出力の黄金ハッシュ（golden.mjs）", runTool("golden.mjs — 全曲×seed×fix の出力一致", "tools/golden.mjs")]);

console.log(`\n${"═".repeat(60)}`);
console.log("検査結果まとめ");
console.log("─".repeat(60));
let allOk = true;
for (const [label, ok] of results) {
  console.log(`  ${ok ? "✔" : "✗"} ${label}`);
  if (!ok) allOk = false;
}
console.log("─".repeat(60));
console.log(allOk ? "全項目通過。デプロイしてよい。" : "不合格の項目がある。上のログを確認してから直すこと。");
process.exit(allOk ? 0 : 1);
