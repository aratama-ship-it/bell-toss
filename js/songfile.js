/* 投鈴 — 作業中の曲データの保存・復元
   ★保存先は曲IDごとに分ける（2026-09-04 レビュー#8）。以前は torei.work という
   単一キーで、曲を切り替えるたびに上書きしていた。クライアントが「第九を組み直し→
   ぶんぶんぶんを確認→第九に戻る」と操作した瞬間に、第九の編集が黙って消えていた
   （通知は出るが消える事実は変わらない、というレビュー指摘）。 */
"use strict";

TOREI.songfile = (() => {
  const PREFIX = "torei.work.";
  // 曲を跨いだ「最後にどの曲を触っていたか」。?song= が無い素の再訪問で、
  // どの曲IDの保存を探せばいいか分からないと復元できないため
  const LAST_KEY = "torei.work.lastId";
  const LEGACY_KEY = "torei.work"; // 旧・単一キー（移行元）
  const keyFor = (id) => PREFIX + (id || "blank");

  function serialize(state, songId, songName) {
    return {
      v: 1,
      id: songId || "blank",
      name: songName || "",
      bpm: state.melody.bpm,
      beatsPerBar: state.melody.beatsPerBar,
      performers: state.cfg.nPerformers,
      passMode: state.cfg.passMode,
      standTime: state.cfg.standTime,
      flight: state.cfg.flight,
      wakiCap: state.cfg.wakiCap,
      maxDup: state.cfg.maxDup,
      maxRings: state.cfg.maxRings || null,
      allowShake: state.cfg.allowShake,
      notes: state.melody.notes.map(n => n.fix
        ? { beat: n.beat, midi: n.midi, fix: n.fix }
        : { beat: n.beat, midi: n.midi }),
    };
  }

  function validate(data) {
    if (!data || typeof data !== "object" || Array.isArray(data)) {
      return "曲データがオブジェクトではありません";
    }
    if (!Array.isArray(data.notes)) return "notes が配列ではありません";
    if (!Number.isFinite(data.bpm) || data.bpm < 20 || data.bpm > 300) {
      return "bpm は20〜300の有限数にしてください";
    }
    if (data.v !== 1) return "対応していない曲データのバージョンです";
    if (typeof data.id !== "string" || typeof data.name !== "string") {
      return "id と name は文字列にしてください";
    }
    if (!Number.isFinite(data.beatsPerBar) || data.beatsPerBar <= 0) {
      return "beatsPerBar は正の有限数にしてください";
    }
    if (!Number.isInteger(data.performers) || data.performers < 1) {
      return "performers は1以上の整数にしてください";
    }
    if (!Number.isFinite(data.flight) || data.flight <= 0) return "flight は正の有限数にしてください";
    if (!Number.isFinite(data.standTime) || data.standTime <= 0) {
      return "standTime は正の有限数にしてください";
    }
    if (!Number.isInteger(data.wakiCap) || data.wakiCap < 0) {
      return "wakiCap は0以上の整数にしてください";
    }
    if (!Number.isInteger(data.maxDup) || data.maxDup < 1) {
      return "maxDup は1以上の整数にしてください";
    }
    if (typeof data.allowShake !== "boolean") return "allowShake は真偽値にしてください";
    if (!["more", "natural", "off"].includes(data.passMode)) {
      return "passMode は more、natural、off のいずれかにしてください";
    }
    for (let i = 0; i < data.notes.length; i++) {
      const n = data.notes[i];
      if (!n || typeof n !== "object" || !Number.isFinite(n.beat) || !Number.isFinite(n.midi)) {
        return `notes[${i}] の beat と midi は有限数にしてください`;
      }
      if (n.midi < 0 || n.midi > 127) return `notes[${i}] の midi は0〜127にしてください`;
    }
    return null;
  }

  // obj.id（serializeが必ず入れる。"blank"含む）でキーを決める。
  // 曲を跨いでも他の曲の保存を上書きしない。あわせて「最後の曲」も更新する
  function save(obj) {
    try {
      localStorage.setItem(keyFor(obj.id), JSON.stringify(obj));
      localStorage.setItem(LAST_KEY, obj.id || "blank");
    } catch (e) {}
  }

  function load(id) {
    try {
      const text = localStorage.getItem(keyFor(id));
      return text == null ? null : JSON.parse(text);
    } catch (e) { return null; }
  }

  // 最後に保存された曲のIDを返す（?song= が無い素の再訪問で使う）
  function loadLastId() {
    try { return localStorage.getItem(LAST_KEY); } catch (e) { return null; }
  }

  function clear(id) {
    try { localStorage.removeItem(keyFor(id)); } catch (e) {}
  }

  // 旧・単一キー（torei.work）に残っている作業中データを、曲IDごとの新しいキーへ
  // 1回だけ移す。新しいキーに既にデータがあれば上書きしない（何か既に保存済みなら
  // 古いデータを優先させる理由が無い）。init() の先頭で1回だけ呼ぶ
  function migrateLegacy() {
    try {
      const text = localStorage.getItem(LEGACY_KEY);
      if (text == null) return;
      const data = JSON.parse(text);
      const id = (data && data.id) || "blank";
      if (localStorage.getItem(keyFor(id)) == null) {
        localStorage.setItem(keyFor(id), text);
        // ★lastIdが既にあるなら上書きしない（2026-09-04発見・実機で再現）。
        // 旧キーは定義上いちばん古いデータ。新方式で既に何か触っていれば
        // そちらのほうが新しく、移行のためにそれを巻き戻してはいけない
        if (localStorage.getItem(LAST_KEY) == null) localStorage.setItem(LAST_KEY, id);
      }
      localStorage.removeItem(LEGACY_KEY);
    } catch (e) {}
  }

  return { serialize, validate, save, load, loadLastId, clear, migrateLegacy };
})();
