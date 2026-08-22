/* 投鈴 — スケジューラー
   メロディ（キャッチ時刻の列）から、各演者の行動（取得・投げ・キャッチ・持ち替え）を逆算する。

   モデル（2026-08-21 本人確認済みの前提）:
   - 1リング = 1音高。キャッチの衝撃でベルが鳴る。
   - 演者は手2本。予備リングは「脇に挟む」（速い）か「スタンドに置く」（遅い）。
   - 滞空時間は投げの高さで調整できる（min〜max の範囲）。
   - 曲開始前の準備時間（負の時刻）に取得・投げを行ってよい。
   - 間に合わない音は（設定ONなら）手元で振って鳴らす。それも無理なら警告。

   実装上の要点: 手の空きは「busy区間の集合」で管理する（スカラーの freeAt では
   「キャッチ予約より前の空き時間」が消えてしまい、滞空中に次の作業をする本物の
   ジャグリングを表現できない）。保持中のリングも区間 {ring, from, to} で持つ。 */
"use strict";

TOREI.SCHED = {
  // 滞空時間と最高到達点は h = g*t^2/8 で決まる（投げ上げ〜同じ高さに戻るまでが t 秒）。
  // 1.4秒 = 手の高さから約2.4m上 = 床から約3.8m。これ以上は天井に当たるため上限とする。
  FLIGHT_MIN: 0.7,   // これより短い投げは「投げ」として成立しない（秒）
  FLIGHT_MAX: 1.4,
  T_THROW: 0.15,     // 投げ動作で手がふさがる時間
  T_CATCH: 0.25,     // キャッチ動作で手がふさがる時間
  T_WAKI: 0.7,       // 脇に挟む / 脇から取る
  T_STAND: 2.0,      // スタンドに掛ける / スタンドから取る（移動込み。2026-08-21 本人指定）
  T_SHAKE: 0.35,     // 手元で振って鳴らす
  T_HANDOFF: 0.4,    // 逆の手へ持ち替える
  PREP: -600,        // 準備時間の起点（曲全体を遡れるよう十分に昔）
};

/* 乱択リスタート: コストに微小なジッターを加えて複数回走らせ、
   (不可能数, 振り数, リング数) が最良の結果を採用する。シード固定で再現可能。 */
TOREI.schedule = function (melody, cfg) {
  let best = null, bestScore = Infinity;
  for (let seed = 0; seed < 20; seed++) {
    const r = TOREI._scheduleOnce(melody, cfg, seed);
    const fails = r.noteResults.filter(x => x && x.kind === "fail").length;
    const shakes = r.noteResults.filter(x => x && x.kind === "shake").length;
    const throws = r.actions.filter(a => a.type === "throw");
    const passes = throws.filter(a => a.pass).length;
    // 成立を最優先し、同点ならパスが多くリングが少ない編成を選ぶ
    const passBonus = cfg.passMode === "off" ? 0
      : (throws.length ? passes / throws.length : 0) * 5;
    const score = fails * 1000 + shakes * 10 + r.rings.length * 0.1 - passBonus;
    if (score < bestScore) { bestScore = score; best = r; }
    if (fails === 0 && shakes === 0 && passes === throws.length) break;
  }
  return best;
};

TOREI._scheduleOnce = function (melody, cfg, seed) {
  const C = TOREI.SCHED;

  // 決定論的な擬似乱数（xorshift32）。seed=0 はジッターなし
  let rndState = ((seed + 1) * 2654435761) >>> 0;
  const rnd = () => {
    rndState ^= rndState << 13; rndState >>>= 0;
    rndState ^= rndState >>> 17;
    rndState ^= rndState << 5; rndState >>>= 0;
    return (rndState % 10000) / 10000;
  };
  const jitter = seed === 0 ? 0 : 0.6 + (seed % 4) * 0.5;
  // パス回避の強さも seed で変える。弱いとパスが増えるが破綻しやすく、
  // 強いと安全だがパスが減る。両極を探索して最良を採る。
  const avoidLevel = seed % 3; // 0=弱い(パス多) 1=中 2=強い(安全)
  const T_STAND = cfg.standTime || C.T_STAND; // スタンド持ち替え時間（UI設定）
  // パッシングの好み: more=積極的に他の演者へ投げ渡す / natural=必要な時だけ / off=なし
  const passCost = cfg.passMode === "more" ? -0.1 : cfg.passMode === "off" ? Infinity : 0.5;
  const EPS = 1e-6;
  const spb = 60 / melody.bpm;

  const notes = melody.notes
    .map((n, i) => ({ t: n.beat * spb, beat: n.beat, midi: n.midi, idx: i }))
    .sort((a, b) => a.t - b.t || a.midi - b.midi);

  const perfs = [];
  for (let i = 0; i < cfg.nPerformers; i++) {
    perfs.push({
      id: i,
      hands: [
        { busy: [], poss: [] }, // busy: [s,e]の配列 / poss: {ring, from, to}
        { busy: [], poss: [] },
      ],
      wakiIv: [], // 脇の占有区間 {ring, from, to(取り出しまで∞)}
      load: 0,
    });
  }

  const rings = [];
  const actions = [];
  // 空中にあるリングの区間 {perf, from, to} — スタンドへ行ける時間の判定に使う
  const airborne = [];
  const warnings = [];
  const noteResults = [];

  const pitchCount = (midi) => rings.filter(r => r.midi === midi).length;

  // 「次にこの音を使うのはいつか」の先読み（パーキング判断用）
  const pitchTimes = {};
  for (const n of notes) (pitchTimes[n.midi] = pitchTimes[n.midi] || []).push(n.t);
  function nextNeed(midi, after) {
    const ts = pitchTimes[midi] || [];
    for (const t of ts) if (t > after + EPS) return t;
    return null;
  }

  /* --- 事前割り当て（実際の演技と同じ段取り） ---
     スタンド操作は体ごと動く＝曲中はほぼ不可能。そこで曲全体の音高を先に演者へ配り、
     開演前にスタンドから手・脇へ移しておく。曲中は手と脇だけで回す。 */
  function preassign() {
    // 音高ごとに「必要本数」を決める（同音が近接するなら複製が要る）
    const need = [];
    for (const midi of Object.keys(pitchTimes).map(Number).sort((a, b) => a - b)) {
      const ts = pitchTimes[midi];
      // 1本を投げ直すには キャッチ+投げ+滞空 が要る。標準の滞空で回らないなら複製する
      // （最短滞空で見積もると、実際には間に合わない箇所を取りこぼす）。
      const cycle = C.T_CATCH + C.T_THROW + cfg.flight;
      let copies = 1;
      for (let i = 1; i < ts.length; i++) {
        if (ts[i] - ts[i - 1] < cycle + 0.4) { copies = 2; break; }
      }
      need.push({ midi, copies: Math.min(copies, cfg.maxDup), count: ts.length, first: ts[0] });
    }
    // 使用頻度の高い音から順に、手の空いている演者へ配る（1人 手2＋脇の本数まで）
    need.sort((a, b) => b.count - a.count || a.first - b.first);
    const capacity = 2 + cfg.wakiCap;
    const load = perfs.map(() => 0);
    for (const item of need) {
      for (let c = 0; c < item.copies; c++) {
        let best = -1;
        for (let i = 0; i < perfs.length; i++) {
          if (load[i] >= capacity) continue;
          if (best < 0 || load[i] < load[best]) best = i;
        }
        if (best < 0) break; // 全員の手元が一杯（音高が多すぎる。警告は音符処理時に出る）
        const r = newRing(item.midi, best);
        load[best]++;
      }
    }
    // 開演前にスタンドから取り出して手・脇へ。1人ずつ順に（体ごと動くので並行できない）
    for (const perf of perfs) {
      const mine = rings.filter(r => r.owner === perf.id);
      let cursor = -4; // 曲頭から遡って配置していく
      let handSlot = 0;
      for (const r of mine) {
        const toWaki = handSlot >= 2;
        const dur = T_STAND + (toWaki ? C.T_WAKI : 0);
        cursor -= dur + 0.3;
        actions.push({ type: "pickup", perf: perf.id, hand: handSlot % 2, ring: r.id,
          t: cursor, dur: T_STAND, from: "stand", midi: r.midi, prep: true });
        bodyOccupy(perf, cursor, cursor + T_STAND);
        if (toWaki) {
          actions.push({ type: "store", perf: perf.id, hand: handSlot % 2, ring: r.id,
            t: cursor + T_STAND, dur: C.T_WAKI, to: "waki", midi: r.midi, prep: true });
          perf.hands[handSlot % 2].busy.push([cursor + T_STAND, cursor + T_STAND + C.T_WAKI]);
          wakiEnter(perf, r.id, cursor + T_STAND + C.T_WAKI, null);
          r.loc = "waki";
          r.hand = null;
        } else {
          perf.hands[handSlot].poss.push({ ring: r.id, from: cursor + T_STAND, to: Infinity });
          r.loc = "hand";
          r.hand = handSlot;
        }
        r.readyAt = cursor + dur;
        handSlot++;
      }
    }
  }

  function newRing(midi, owner) {
    const r = { id: rings.length, midi, owner, home: owner, loc: "stand", readyAt: C.PREP, hand: null };
    rings.push(r);
    return r;
  }

  /* --- スタンド操作中は演者全体が塞がる（体ごと移動するため両手ともジャグリング不可） --- */
  function bodyFree(perf, s0, e0) {
    for (let h = 0; h < 2; h++) {
      for (const b of perf.hands[h].busy) {
        if (s0 < b[1] - EPS && e0 > b[0] + EPS) return false;
      }
    }
    // 空中のリング（投げてキャッチ待ち）がある間はスタンドへ行けない
    for (const a of airborne) {
      if (a.perf === perf.id && s0 < a.to - EPS && e0 > a.from + EPS) return false;
    }
    return true;
  }
  function bodyOccupy(perf, s0, e0) {
    perf.hands[0].busy.push([s0, e0]);
    perf.hands[1].busy.push([s0, e0]);
  }

  /* --- 脇の占有（時間区間で管理） ---
     新しい滞在 [from, to) が既存のどの滞在とも重なって定員を超えないか判定する。
     退出時刻が未定の滞在は to=∞（保守的にずっと塞ぐ）。処理順と時刻順はズレるため、
     「今いる本数」を数える方式は使えない（過去の時刻への挿入を見逃す）。 */
  function wakiHasRoom(perf, from, to) {
    const hi = to == null ? Infinity : to;
    let n = 0;
    for (const iv of perf.wakiIv) {
      if (iv.from < hi - EPS && from < iv.to - EPS) n++;
    }
    return n < cfg.wakiCap;
  }
  function wakiEnter(perf, ringId, from, to) {
    perf.wakiIv.push({ ring: ringId, from, to: to == null ? Infinity : to });
  }
  function wakiLeave(perf, ringId, t) {
    for (const iv of perf.wakiIv) {
      if (iv.ring === ringId && iv.to === Infinity) { iv.to = t + C.T_WAKI; return; }
    }
  }

  /* --- 手の区間ユーティリティ --- */
  function isFree(hand, s, e) {
    for (const b of hand.busy) if (s < b[1] - EPS && e > b[0] + EPS) return false;
    return true;
  }
  function holdingAt(hand, time) {
    for (const p of hand.poss) if (time >= p.from - EPS && time < p.to - EPS) return p;
    return null;
  }
  // 窓 [s,e] に重なる「別リングの保持」を調べる。
  // 戻り値: {kind:'none'} | {kind:'storable', poss} | {kind:'blocked'}
  function possConflict(hand, s, e, ringId) {
    let storable = null;
    for (const p of hand.poss) {
      if (p.ring === ringId) continue;
      if (p.to <= s + EPS || p.from >= e - EPS) continue; // 重ならない
      if (p.to === Infinity && p.from <= s + EPS) { storable = p; continue; }
      return { kind: "blocked" }; // 途中で始まる/終わる保持（将来のキャッチ等）とは両立しない
    }
    return storable ? { kind: "storable", poss: storable } : { kind: "none" };
  }

  /* --- 1候補の計画 ---
     ring を perf の hand(handIdx) が投げ、キャッチ時刻 t で鳴らす。 */
  function planToss(ring, perf, handIdx, t, isNew) {
    if (ring.loc === "hand" && (ring.owner !== perf.id || ring.hand !== handIdx)) return null;
    if ((ring.loc === "waki" || ring.loc === "stand") && ring.owner !== perf.id) return null;

    const hand = perf.hands[handIdx];
    let acqDur = 0, acqFrom = null;
    if (ring.loc === "waki") { acqDur = C.T_WAKI; acqFrom = "waki"; }
    else if (ring.loc === "stand") { acqDur = T_STAND; acqFrom = "stand"; }

    // 滞空時間の候補: 希望値を中心に外側へ探す
    const fCands = [];
    for (let d = 0; d <= 1.6; d += 0.1) {
      const a = +(cfg.flight + d).toFixed(2), b = +(cfg.flight - d).toFixed(2);
      if (b >= C.FLIGHT_MIN && b <= C.FLIGHT_MAX) fCands.push(b);
      if (d > 0 && a >= C.FLIGHT_MIN && a <= C.FLIGHT_MAX) fCands.push(a);
    }

    // 1つの (f, lead, 取得時間, リング準備時刻) の組について実行可能性を判定
    const tryWindow = (f, lead, aDur, ready, aFrom) => {
      const throwTime = t - f;
      const chainEnd = throwTime + C.T_THROW;
      const acqStart0 = throwTime - aDur - lead;
      if (ready > acqStart0 + EPS) return null;

      // 別リングを持っていたら先に置く（置き先: 脇に空きがあれば脇、なければ台）
      let storeDur = 0, storeTo = null, storedPoss = null;
      const conf0 = possConflict(hand, acqStart0, chainEnd, ring.id);
      if (conf0.kind === "blocked") return null;
      if (conf0.kind === "storable") {
        storedPoss = conf0.poss;
        // 置き先の優先順: 逆の手へ持ち替え(速い) → 脇(1本まで) → スタンド(遅い)
        const otherIdx = 1 - handIdx;
        const other = perf.hands[otherIdx];
        const hs = acqStart0 - C.T_HANDOFF;
        if (isFree(other, hs, acqStart0)
            && possConflict(other, hs, Infinity, storedPoss.ring).kind === "none") {
          storeTo = "otherhand";
          storeDur = C.T_HANDOFF;
        } else if (wakiHasRoom(perf, acqStart0 - C.T_WAKI, null)) {
          storeTo = "waki";
          storeDur = C.T_WAKI;
        } else {
          storeTo = "stand";
          storeDur = T_STAND;
        }
      }
      const chainStart = acqStart0 - storeDur;
      if (!isFree(hand, chainStart, chainEnd)) return null;
      if (storeDur > 0) {
        const conf1 = possConflict(hand, chainStart, chainEnd, ring.id);
        if (conf1.kind === "blocked") return null;
      }
      // スタンドの出し入れは体ごと動く＝その間ジャグリングできない
      if (aFrom === "stand" && !bodyFree(perf, acqStart0, acqStart0 + aDur)) return null;
      if (storeTo === "stand" && !bodyFree(perf, chainStart, chainStart + storeDur)) return null;
      return { storeDur, storeTo, storedPoss, acqStart: acqStart0, lead, f, throwTime };
    };

    // 経路の探索: 「最初に見つかった1つ」ではなく候補を集めて最善を選ぶ。
    // 早期returnにすると、少し待てば成立する良い経路を取り逃す（実測で判明）。
    const opts = [];
    const push = (w, kind) => { if (w) { w.route = kind; opts.push(w); } };

    // (a) 直前取得
    for (const f of fCands) {
      const w = tryWindow(f, 0, acqDur, ring.readyAt, acqFrom);
      if (w) { w.acqDur = acqDur; w.acqFrom = acqFrom; push(w, "jit"); break; }
    }

    // (b) スタンドから早めに取って手に持って待つ。
    // スタンド操作は体ごと動く＝曲中はほぼ不可能なので、開演前まで遡れるようにする
    // （実際の演技でも、使うリングは開演前に手と脇へ配っておく）。
    if (acqFrom === "stand") {
      const fShort = fCands.slice(0, 5);
      const leads = [0.5, 1, 1.5, 2, 3, 4, 6, 9, 13, 18, 25];
      // 「投げの時刻から曲頭より前まで」を粗く刻んで追加する
      const toStart = t - acqDur + 2;
      for (let L = 30; L < toStart + 30; L += 5) leads.push(L);
      outer: for (const lead of leads) {
        for (const f of fShort) {
          const w = tryWindow(f, lead, acqDur, ring.readyAt, acqFrom);
          if (w) { w.acqDur = acqDur; w.acqFrom = acqFrom; push(w, "hold"); break outer; }
        }
      }
    }

    // (c) 補充: 暇な時間に 台→手→脇 を済ませ、直前は脇から取る
    if (acqFrom === "stand") {
      const rDur = T_STAND + C.T_WAKI;
      outer2: for (const f of fCands.slice(0, 3)) {
        const acqStartW = t - f - C.T_WAKI;
        const latest = acqStartW - rDur;
        const floor0 = Math.max(ring.readyAt, -8 - T_STAND - C.T_WAKI);
        for (let s0 = latest; s0 >= floor0; s0 -= 0.75) {
          for (let rh = 0; rh < 2; rh++) {
            const rHand = perf.hands[rh];
            if (!isFree(rHand, s0, s0 + rDur)) continue;
            if (possConflict(rHand, s0, s0 + rDur, ring.id).kind !== "none") continue;
            if (!bodyFree(perf, s0, s0 + T_STAND)) continue;
            const w = tryWindow(f, 0, C.T_WAKI, s0 + rDur, "waki");
            if (!w) continue;
            if (!bodyFree(perf, s0, s0 + T_STAND)) continue; // 台から取る間は動けない
            if (!wakiHasRoom(perf, s0 + rDur, w.acqStart + C.T_WAKI)) continue;
            w.acqDur = C.T_WAKI;
            w.acqFrom = "waki";
            w.restock = { hand: rh, start: s0 };
            push(w, "restock");
            break outer2;
          }
        }
      }
    }

    if (!opts.length) return null;
    // 早い準備・長い保持ほど僅かに不利。実行できることを最優先する
    opts.sort((a, b) =>
      (a.storeDur + a.acqDur + a.lead * 0.05 + (a.restock ? 0.5 : 0)) -
      (b.storeDur + b.acqDur + b.lead * 0.05 + (b.restock ? 0.5 : 0)));
    const found = opts[0];

    const { storeDur, storeTo, storedPoss, acqStart, lead, f, throwTime } = found;

    // キャッチ手の候補: 自分の両手 ＋（パッシング有効なら）他の演者の手。
    // 投げ渡し(パス)はリングの持ち主がキャッチした演者に移る。
    let bestCatch = null;
    for (const q of perfs) {
      for (let c = 0; c < 2; c++) {
        const isSelf = q.id === perf.id;
        if (!isSelf && passCost === Infinity) continue;
        const ch = q.hands[c];
        if (!isFree(ch, t, t + C.T_CATCH)) continue;
        const held = holdingAt(ch, t);
        const heldOk = held == null
          || (isSelf && c === handIdx && (held === storedPoss || held.ring === ring.id));
        if (!heldOk) continue;
        // 受け手が直後に自分の担当音を投げる予定なら、その手を塞ぐパスは避ける
        // （パスでリングが集まると、担当音を出せなくなって破綻する）
        // パス多めの設定では、この回避を弱める（受け手の余裕より見た目のパスを優先）。
        // 強すぎると3人編成では常にペナルティがかかりパスがほぼ起きなくなる（実測）。
        const base = cfg.passMode === "more" ? 0 : 1;
        const lv = Math.min(2, base + avoidLevel);
        const avoidWin = [1.2, 2.0, 2.8][lv];
        const avoidCost = [0.4, 1.0, 2.0][lv];
        let busySoon = 0;
        if (!isSelf) {
          for (const other of rings) {
            if (other.home !== q.id || other.id === ring.id) continue;
            const nt = nextNeed(other.midi, t - 0.01);
            if (nt != null && nt - t < avoidWin) busySoon += avoidCost;
          }
        }
        const cc = (isSelf ? (c === handIdx ? 0.25 : 0) : passCost) + q.load * 0.3 + busySoon;
        if (!bestCatch || cc < bestCatch.cc) bestCatch = { q, c, cc };
      }
    }
    if (!bestCatch) return null;

    return {
      kind: "toss", ring, perf, handIdx, isNew,
      catchPerf: bestCatch.q, catchHand: bestCatch.c,
      storeDur, storeTo, storedPoss,
      acqDur: found.acqDur, acqFrom: found.acqFrom, acqStart,
      restock: found.restock || null,
      throwTime, flight: f,
      cost: (storeDur + found.acqDur) + perf.load * 0.3 + (isNew ? 3 : 0)
        + Math.abs(cfg.flight - f) * 0.3 + lead * 0.05
        + (found.restock ? 0.5 : 0) + bestCatch.cc,
    };
  }

  function planShake(ring, perf, handIdx, t, isNew) {
    if (!cfg.allowShake) return null;
    if (ring.loc === "hand" && (ring.owner !== perf.id || ring.hand !== handIdx)) return null;
    if ((ring.loc === "waki" || ring.loc === "stand") && ring.owner !== perf.id) return null;

    const hand = perf.hands[handIdx];
    let acqDur = 0, acqFrom = null;
    if (ring.loc === "waki") { acqDur = C.T_WAKI; acqFrom = "waki"; }
    else if (ring.loc === "stand") { acqDur = T_STAND; acqFrom = "stand"; }

    const acqStart = t - acqDur;
    if (ring.readyAt > acqStart + EPS) return null;

    let storeDur = 0, storeTo = null, storedPoss = null;
    const conf = possConflict(hand, acqStart, t + C.T_SHAKE, ring.id);
    if (conf.kind === "blocked") return null;
    if (conf.kind === "storable") {
      storeTo = wakiHasRoom(perf, acqStart - C.T_WAKI - storeDur, null) ? "waki" : "stand";
      storeDur = storeTo === "waki" ? C.T_WAKI : T_STAND;
      storedPoss = conf.poss;
    }
    const chainStart = acqStart - storeDur;
    if (!isFree(hand, chainStart, t + C.T_SHAKE)) return null;
    if (acqFrom === "stand" && !bodyFree(perf, acqStart, acqStart + acqDur)) return null;
    if (storeTo === "stand" && !bodyFree(perf, chainStart, chainStart + storeDur)) return null;

    return {
      kind: "shake", ring, perf, handIdx, isNew,
      storeDur, storeTo, storedPoss, acqDur, acqFrom, acqStart,
      cost: (storeDur + acqDur) + perf.load * 0.6 + (isNew ? 3 : 0) + 10,
    };
  }

  function closePoss(hand, ringId, at) {
    for (const p of hand.poss) {
      if (p.ring === ringId && p.to === Infinity) { p.to = at; return; }
    }
  }

  function applyPlan(plan, note) {
    const perf = plan.perf;
    const hand = perf.hands[plan.handIdx];
    const ring = plan.ring;
    const t = note.t;

    const acqStart = plan.acqStart != null ? plan.acqStart
      : (plan.kind === "toss" ? plan.throwTime : t) - plan.acqDur;
    const storeStart = acqStart - plan.storeDur;

    // 補充: 暇な時間に 台→手→脇 を済ませておく（第3段の計画）
    if (plan.restock) {
      const rHand = perf.hands[plan.restock.hand];
      const ps = plan.restock.start;
      actions.push({ type: "pickup", perf: perf.id, hand: plan.restock.hand, ring: ring.id,
        t: ps, dur: T_STAND, from: "stand", midi: ring.midi });
      actions.push({ type: "store", perf: perf.id, hand: plan.restock.hand, ring: ring.id,
        t: ps + T_STAND, dur: C.T_WAKI, to: "waki", midi: ring.midi });
      bodyOccupy(perf, ps, ps + T_STAND); // 台への往復は体ごと
      rHand.busy.push([ps + T_STAND, ps + T_STAND + C.T_WAKI]);
      rHand.poss.push({ ring: ring.id, from: ps, to: ps + T_STAND + C.T_WAKI });
      wakiEnter(perf, ring.id, ps + T_STAND + C.T_WAKI, acqStart + C.T_WAKI);
      ring.loc = "waki";
      ring.readyAt = ps + T_STAND + C.T_WAKI;
    }

    // 別リングを置く（または逆の手へ持ち替える）
    if (plan.storeDur > 0 && plan.storedPoss) {
      const stored = rings[plan.storedPoss.ring];
      actions.push({ type: "store", perf: perf.id, hand: plan.handIdx, ring: stored.id,
        t: storeStart, dur: plan.storeDur, to: plan.storeTo, midi: stored.midi });
      if (plan.storeTo === "stand") bodyOccupy(perf, storeStart, storeStart + plan.storeDur);
      else hand.busy.push([storeStart, storeStart + plan.storeDur]);
      closePoss(hand, stored.id, storeStart);
      stored.readyAt = storeStart + plan.storeDur;
      if (plan.storeTo === "otherhand") {
        const otherIdx = 1 - plan.handIdx;
        const other = perf.hands[otherIdx];
        other.busy.push([storeStart, storeStart + plan.storeDur]);
        other.poss.push({ ring: stored.id, from: storeStart + plan.storeDur, to: Infinity });
        stored.loc = "hand";
        stored.hand = otherIdx;
      } else {
        stored.loc = plan.storeTo;
        stored.hand = null;
        if (plan.storeTo === "waki") wakiEnter(perf, stored.id, storeStart + plan.storeDur, null);
      }
    }

    // リングを取得
    if (plan.acqDur > 0) {
      actions.push({ type: "pickup", perf: perf.id, hand: plan.handIdx, ring: ring.id,
        t: acqStart, dur: plan.acqDur, from: plan.acqFrom, midi: ring.midi });
      if (plan.acqFrom === "stand") bodyOccupy(perf, acqStart, acqStart + plan.acqDur);
      else hand.busy.push([acqStart, acqStart + plan.acqDur]);
      hand.poss.push({ ring: ring.id, from: acqStart + plan.acqDur, to: Infinity });
      if (plan.acqFrom === "waki") wakiLeave(perf, ring.id, acqStart);
      ring.loc = "hand";
      ring.hand = plan.handIdx;
    }

    let holdHandObj = hand;
    let holdIdx = plan.handIdx;
    let holdPerf = perf;

    if (plan.kind === "toss") {
      const cq = plan.catchPerf;
      const ch = cq.hands[plan.catchHand];
      const isPass = cq.id !== perf.id;
      actions.push({ type: "throw", perf: perf.id, hand: plan.handIdx,
        catchPerf: cq.id, catchHand: plan.catchHand, pass: isPass,
        ring: ring.id, t: plan.throwTime, dur: C.T_THROW, flight: plan.flight,
        noteIdx: note.idx, midi: note.midi });
      actions.push({ type: "catch", perf: cq.id, hand: plan.catchHand,
        throwPerf: perf.id, throwHand: plan.handIdx, pass: isPass,
        ring: ring.id, t, dur: C.T_CATCH, noteIdx: note.idx, midi: note.midi,
        throwTime: plan.throwTime });
      hand.busy.push([plan.throwTime, plan.throwTime + C.T_THROW]);
      airborne.push({ perf: perf.id, from: plan.throwTime, to: t });
      if (cq.id !== perf.id) airborne.push({ perf: cq.id, from: plan.throwTime, to: t });
      closePoss(hand, ring.id, plan.throwTime);
      ch.busy.push([t, t + C.T_CATCH]);
      ch.poss.push({ ring: ring.id, from: t, to: Infinity });
      ring.loc = "hand";
      ring.hand = plan.catchHand;
      ring.owner = cq.id; // パスでリングの持ち主が移る
      ring.readyAt = t + C.T_CATCH;
      holdHandObj = ch;
      holdIdx = plan.catchHand;
      holdPerf = cq;
      noteResults[note.idx] = { kind: "toss", perf: cq.id, hand: plan.catchHand,
        ring: ring.id, throwTime: plan.throwTime, flight: plan.flight, pass: isPass };
    } else {
      actions.push({ type: "shake", perf: perf.id, hand: plan.handIdx, ring: ring.id,
        t, dur: C.T_SHAKE, noteIdx: note.idx, midi: note.midi });
      hand.busy.push([t, t + C.T_SHAKE]);
      if (plan.acqDur === 0 && !holdingAt(hand, t)) {
        hand.poss.push({ ring: ring.id, from: t, to: Infinity });
      }
      ring.readyAt = t + C.T_SHAKE;
      noteResults[note.idx] = { kind: "shake", perf: perf.id, hand: plan.handIdx, ring: ring.id };
      warnings.push({ noteIdx: note.idx, t, midi: note.midi,
        msg: `${fmtTime(t)} の ${TOREI.noteName(note.midi)}: 投げが間に合わず、${TOREI.perfName(perf.id)}が手元で振って鳴らします` });
    }
    holdPerf.load++;

    // キャッチ後のパーキング: 次の使用が遠いリングは手から戻し、手と脇を空けておく
    const nn = nextNeed(note.midi, t);
    const gap = nn == null ? Infinity : nn - t;
    const after0 = plan.kind === "toss" ? t + C.T_CATCH : t + C.T_SHAKE;
    // 置き場の選択。スタンドは体ごと動くため曲中は原則使わない
    // （手・脇に収まっているうちは戻さない。戻すと次に取り出すのに4秒かかり破綻する）。
    let park = null;
    if (gap > 2.5 && wakiHasRoom(holdPerf, after0, null)) park = "waki";
    else if (nn == null && t > 0) park = null; // 曲が終わるなら持ったままでよい
    if (park) {
      const after = plan.kind === "toss" ? t + C.T_CATCH : t + C.T_SHAKE;
      const dur = park === "waki" ? C.T_WAKI : T_STAND;
      const canPark = park === "stand"
        ? bodyFree(holdPerf, after, after + dur)
        : isFree(holdHandObj, after, after + dur);
      if (canPark) {
        actions.push({ type: "store", perf: holdPerf.id, hand: holdIdx, ring: ring.id,
          t: after, dur, to: park, midi: ring.midi });
        if (park === "stand") bodyOccupy(holdPerf, after, after + dur);
        else holdHandObj.busy.push([after, after + dur]);
        closePoss(holdHandObj, ring.id, after);
        ring.loc = park;
        ring.hand = null;
        ring.readyAt = after + dur;
        if (park === "waki") wakiEnter(holdPerf, ring.id, after + dur, null);
      }
    }
  }

  function fmtTime(t) {
    const m = Math.floor(Math.max(0, t) / 60);
    const s = (Math.max(0, t) % 60).toFixed(1);
    return `${m}:${s.padStart(4, "0")}`;
  }

  preassign();

  /* --- メインループ: 音符を時刻順に割り当てる --- */
  for (const note of notes) {
    const candidates = [];

    for (const ring of rings) {
      if (ring.midi !== note.midi) continue;
      const perf = perfs[ring.owner];
      for (let h = 0; h < 2; h++) {
        const p = planToss(ring, perf, h, note.t, false);
        if (p) candidates.push(p);
      }
    }

    const anyToss = candidates.some(p => p.kind === "toss");

    // 投げで間に合う既存リングがなければ、新しいリング（複製）を検討。
    // 同音を既に持つ演者には加点（同じ演者では速い連打を分担できないため、別の演者へ散らす）
    if (!anyToss && pitchCount(note.midi) < cfg.maxDup) {
      for (const perf of perfs) {
        const ownsSame = rings.some(r => r.midi === note.midi && r.owner === perf.id);
        for (let h = 0; h < 2; h++) {
          const ghost = { id: -1, midi: note.midi, owner: perf.id, loc: "stand", readyAt: C.PREP, hand: null };
          const p = planToss(ghost, perf, h, note.t, true);
          if (p) { if (ownsSame) p.cost += 2.5; candidates.push(p); }
        }
      }
    }

    // それでも投げられなければ、振って鳴らす計画
    if (!candidates.some(p => p.kind === "toss")) {
      for (const ring of rings) {
        if (ring.midi !== note.midi) continue;
        const perf = perfs[ring.owner];
        for (let h = 0; h < 2; h++) {
          const p = planShake(ring, perf, h, note.t, false);
          if (p) candidates.push(p);
        }
      }
      if (pitchCount(note.midi) < cfg.maxDup) {
        for (const perf of perfs) {
          for (let h = 0; h < 2; h++) {
            const ghost = { id: -1, midi: note.midi, owner: perf.id, loc: "stand", readyAt: C.PREP, hand: null };
            const p = planShake(ghost, perf, h, note.t, true);
            if (p) candidates.push(p);
          }
        }
      }
    }

    for (const c of candidates) c.k = c.cost + (jitter ? rnd() * jitter : 0);
    const best = candidates.sort((a, b) => a.k - b.k)[0] || null;

    if (!best) {
      warnings.push({ noteIdx: note.idx, t: note.t, midi: note.midi,
        msg: `${fmtTime(note.t)} の ${TOREI.noteName(note.midi)}: どの演者も間に合いません（演者を増やす／テンポを落とす／滞空を短くする）` });
      noteResults[note.idx] = { kind: "fail" };
      continue;
    }

    if (best.isNew) {
      const real = newRing(note.midi, best.perf.id);
      real.loc = "stand";
      best.ring = real;
    }
    applyPlan(best, note);
  }

  actions.sort((a, b) => a.t - b.t);
  const minT = actions.length ? Math.min(0, actions[0].t) : 0;

  // リングのラベル（同音が複数あるとき ド①ド② と区別）
  const perPitch = {};
  const pcOctaves = {};
  for (const r of rings) {
    perPitch[r.midi] = (perPitch[r.midi] || 0) + 1;
    r.pitchIdx = perPitch[r.midi];
    const pc = r.midi % 12;
    (pcOctaves[pc] = pcOctaves[pc] || new Set()).add(Math.floor(r.midi / 12));
  }
  for (const r of rings) {
    const multiOct = pcOctaves[r.midi % 12].size > 1;
    const base = multiOct ? TOREI.noteNameFull(r.midi) : TOREI.noteName(r.midi);
    r.label = base + (perPitch[r.midi] > 1 ? "①②③"[r.pitchIdx - 1] : "");
  }

  return { actions, rings, warnings, noteResults, minT };
};

/* 行動表テキスト（練習用）を生成 */
TOREI.actionText = function (result, melody, cfg) {
  const lines = [];
  lines.push(`投鈴 行動表  (テンポ ${melody.bpm} BPM / 演者 ${cfg.nPerformers}人 / 基本滞空 ${cfg.flight}秒)`);
  const inv = {};
  for (const r of result.rings) {
    const h = r.home != null ? r.home : r.owner;
    inv[h] = inv[h] || [];
    inv[h].push(r.label);
  }
  for (let i = 0; i < cfg.nPerformers; i++) {
    lines.push(`${TOREI.perfName(i)} のリング: ${(inv[i] || []).join("・") || "なし"}`);
  }
  lines.push("");
  const handName = ["左手", "右手"];
  for (const a of result.actions) {
    const t = a.t;
    const m = t < 0 ? "準備" : `${Math.floor(t / 60)}:${(t % 60).toFixed(1).padStart(4, "0")}`;
    const ring = result.rings[a.ring];
    const who = `${TOREI.perfName(a.perf)} ${handName[a.hand]}`;
    if (a.type === "pickup") lines.push(`${m}  ${who}: ${ring.label} を${a.from === "waki" ? "脇から取る" : "スタンドから取る"}`);
    if (a.type === "store") lines.push(`${m}  ${who}: ${ring.label} を${a.to === "waki" ? "脇に挟む" : a.to === "otherhand" ? "逆の手へ持ち替える" : "スタンドに掛ける"}`);
    if (a.type === "throw") lines.push(`${m}  ${who}: ${ring.label} を投げる（滞空 ${a.flight.toFixed(1)}秒${a.pass ? `・${TOREI.perfName(a.catchPerf)}へパス` : a.catchHand !== a.hand ? "・逆の手で受ける" : ""}）`);
    if (a.type === "catch") lines.push(`${m}  ${who}: ${ring.label} をキャッチ → ♪${TOREI.noteName(a.midi)}`);
    if (a.type === "shake") lines.push(`${m}  ${who}: ${ring.label} を振って鳴らす → ♪${TOREI.noteName(a.midi)} ※投げが間に合わない箇所`);
  }
  return lines.join("\n");
};
