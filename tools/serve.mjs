#!/usr/bin/env node
/* 投鈴 — ローカル確認用の静的サーバー（Node）
 *
 * なぜ要るか（2026-09-05）: 従来は .claude/launch.json から
 * `python3 -m http.server 8934` を起動していたが、Claude Codeのサンドボックス下では
 * 起動時に必ず落ちる:
 *   http/server.py の argparse が `default=os.getcwd()` を評価する
 *   → iCloud配下の作業ディレクトリで PermissionError: [Errno 1] Operation not permitted
 * --directory を渡してもパーサ構築時に評価されるため回避できない。そこでNodeで置き換えた。
 *
 * 使い方: node tools/serve.mjs [ポート]     （既定 8934・このファイルの1つ上を配信）
 * キャッシュは no-store。?v= を上げ忘れても古いJSが配られない（確認事故を防ぐため）。
 */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PORT = Number(process.argv[2]) || 8934;
const TYPES = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8", ".md": "text/plain; charset=utf-8",
  ".mid": "audio/midi", ".png": "image/png", ".jpg": "image/jpeg",
  ".svg": "image/svg+xml", ".ico": "image/x-icon", ".woff2": "font/woff2",
};

http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split("?")[0]);
  if (p.endsWith("/")) p += "index.html";
  const file = path.join(ROOT, p);
  // ルート外への参照（../ など）を弾く
  if (!file.startsWith(ROOT)) { res.writeHead(403); return res.end("forbidden"); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" }); return res.end("not found: " + p); }
    res.writeHead(200, {
      "Content-Type": TYPES[path.extname(file).toLowerCase()] || "application/octet-stream",
      "Cache-Control": "no-store",
    });
    res.end(data);
  });
}).listen(PORT, () => {
  console.log(`投鈴 ローカル確認: http://localhost:${PORT}/`);
  console.log(`  配信元: ${ROOT}`);
});
