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
  // ★キャッチ前の回復時間（2026-08-23 本人指定）。手が空いてから、落ちてくるリングを
  // 受けられる位置まで腕を戻すのに要る時間。これが無いと「脇に挟んだ0.018秒後に
  // 同じ手でキャッチ」のような実演不可能な振付が出る。
  // キャッチの占有区間を [t-T_RECOVER, t+T_CATCH] として表すことで、
  // 「先に投げを計画→後からキャッチ」「先にキャッチ→後から投げを過去に挿入」の
  // どちらの順序でも busy の重なり判定だけで守られる（片側だけの検査だと後者が漏れる）。
  // 本人指定値: 投げてから0.4秒／脇に挟んでから0.3〜0.4秒。
  // 投げの占有0.15秒・脇入れ0.7秒の直後から数えるので、共通値0.35秒で
  // 投げ→0.50秒・脇→0.35秒となり、両方を満たす。
  T_RECOVER: 0.35,
  T_HANDOFF: 0.4,    // 逆の手へ持ち替える
  // ★脇にリングを挟んでいる側の手へ渡す場合（2026-08-25 本人指摘）。
  // その腕はすでに止まっているので、渡すだけならほとんど時間を食わない、とのこと。
  // この動きは「フリーな腕を空けてキャッチする」ための正しい手順なので、安く扱う。
  T_HANDOFF_PARK: 0.2,
  // 脇へ挟んだ手と違う手で抜くときの割高さ（2026-08-26 本人談。基本は同じ手で抜く）
  WAKI_WRONG_HAND: 2.5,
  // 逆の手が空いているのに脇側の腕で取ったときの割高さ（2026-08-26 本人指示
  // 「もう片方の手が空いているときは、挟んでいない方の手で取ることを優先」）。
  // 実質的に強制だが、逆の手が使えない場面では従来どおり脇側の腕で取れる（悪くはない、の扱い）
  WAKI_ARM_FORCE: 4.0,
  // 脇を使っている側の腕でキャッチするときの割高さ（計画時のコスト。禁止ではなく回避）。
  // 実測で釣り合いの良い点（全34曲・探索800）: 0.2→397回/パス84.9%、0.5→346回/83.8%、
  // 0.8→295回/81.0%。0.5より上げても回数の減りに対してパス率の代償が大きい。
  WAKI_ARM_COST: 0.5,
  PREP: -600,        // 準備時間の起点（曲全体を遡れるよう十分に昔）
};

/* 乱択リスタート: コストに微小なジッターを加えて複数回走らせ、
   (不可能数, 振り数, 和音の欠け, リング数, パス率) が最良の結果を採用する。シード固定で再現可能。 */
/* ---------- 「無理のなさ」の指標（2026-08-25 本人要望）----------
   これまでの採点は「成立するか」「パスが多いか」だけを見ていた。だが物理的に成立しても
   人間に無理な編成はある。稽古で効いてくるのは次のような条件で、いずれも実測で大きくばらつく。

     窮屈さ   … 同じ手が短い間隔で連続して動く回数（全34曲で3〜26回）
     偏り     … 演者ごとの動作数の差（4〜53%。一人に集中すると他が手持ち無沙汰になる）
     高さの乱れ… 同じ手の連続する投げで高さの段が変わる回数（0〜21回）
     高い投げ … 高さの上限を超える投げの本数
     遠パス   … 隣でない演者へのパス（3〜44回。距離が伸びるほど難度が上がる）

   ここは「重み」ではなく物理的に意味の分かる言葉で持つ。稽古で「手の余裕を0.8秒に」とは
   言えても「窮屈さの重みを0.15に」とは言えないため。 */
TOREI.EFFORT = {
  handGap: 0.6,      // 同じ手の動作間隔として確保したい秒数。これを下回るぶんだけ減点
  gapCost: 0.15,     // 窮屈な動作1回あたりの減点
  maxLevel: 5,       // 許容する投げの高さの段（1〜5）。5＝制限なし
  levelCost: 0.5,    // 上限を超えた投げ1本あたりの減点
  evenLevel: 0.2,    // 同じ手で高さの段が変わる1回あたりの減点（0で気にしない）
  evenLoad: 3.0,     // 演者間の偏り（0〜1）にかける減点
  farPass: 0.05,     // 隣でない演者へのパス1回あたりの減点
  ringCost: 0.1,     // リング1本あたりの減点（本数を絞りたいほど上げる）
  // 脇を使っている側の腕でキャッチ／取り出しをした1回あたりの減点。
  // 0.1が釣り合いの良い点（実測: 0で390回・0.1で301回とパス率を落とさず減り、
  // 0.3以上にすると回数は減るがパス率が1〜2pt落ちる）。
  wakiArm: 0.1,
  selfRun: 0.4,      // 自分投げの連続への累進減点（3連続から。順番にパスが混ざる編成を好む）
  // 投げの高さのバリエーション（2026-08-26 本人方針「たくさんあるほどよし。全体的には低く、
  // 定期的に高く投げるバリエーションがあると見栄えがとても良い。とても強い重みで」）
  varietyLevel: 0.6, // 使われた高さの段の種類1つ増えるごとの加点
  // 高い投げ（高さ4以上）が曲の四分区間それぞれに現れるごとの加点。
  // 「とても強い重みで」（本人）。実測: 2.5未満だと散らばり2区間の解が3区間の解に勝つ
  varietyHigh: 3.0,
};

/* 上の指標を実測する。ブラウザの採点・最適化ツール・点検ツールが同じ数値を見るよう1か所に置く */
TOREI.effortMetrics = function (r, cfg) {
  const n = cfg.nPerformers || 3;
  const E = Object.assign({}, TOREI.EFFORT, cfg.effort || {});
  const acts = r.actions.filter(a => a.t >= -0.001 &&
    (a.type === "throw" || a.type === "catch" || a.type === "pickup" || a.type === "store" || a.type === "shake"));
  const throws = r.actions.filter(a => a.type === "throw");

  let tight = 0, levelChange = 0;
  for (let p = 0; p < n; p++) {
    for (let h = 0; h < 2; h++) {
      const mine = acts.filter(a => a.perf === p && a.hand === h).sort((x, y) => x.t - y.t);
      for (let i = 1; i < mine.length; i++) {
        const gap = mine[i].t - mine[i - 1].t;
        // 同時刻の2件は保持キャッチ和音（1回の動作で2つ鳴る）なので窮屈ではない
        if (!(gap > 1e-6 && gap < E.handGap)) continue;
        // 脇側の手へ渡す動作は「ほとんど時間を食わない」（2026-08-25 本人談）。
        // 腕を空けるための正しい手順なので、これが絡む間隔は窮屈と数えない。
        if (mine[i].toParked || mine[i - 1].toParked) continue;
        tight++;
      }
      const seq = throws.filter(a => a.perf === p && a.hand === h)
        .sort((x, y) => x.t - y.t).map(a => TOREI.throwLevel(a.flight));
      for (let i = 1; i < seq.length; i++) if (seq[i] !== seq[i - 1]) levelChange++;
    }
  }
  const per = [];
  for (let p = 0; p < n; p++) per.push(acts.filter(a => a.perf === p).length);
  const hi = Math.max(...per, 1);
  const imbalance = per.length > 1 ? (hi - Math.min(...per)) / hi : 0;
  const tooHigh = throws.filter(a => TOREI.throwLevel(a.flight) > E.maxLevel).length;
  // 脇にリングを挟んでいる側の腕でのキャッチ（2026-08-25 本人指摘）。
  // 挟んだ側の腕は自由が利かないので、できる限りフリーな腕で受けたい。
  // 挟む側は「持っている手の反対」（2026-08-26 本人談）。左手のリングは右脇へ。
  const wakiIv = [];
  for (const a of r.actions) {
    if (a.type === "store" && a.to === "waki") wakiIv.push({ perf: a.perf, side: 1 - a.hand, from: a.t + a.dur, to: Infinity });
  }
  for (const a of r.actions) {
    if (a.type !== "pickup" || a.from !== "waki") continue;
    const iv = wakiIv.find(w => w.perf === a.perf && w.to === Infinity && w.from <= a.t + 1e-6);
    if (iv) iv.to = a.t;
  }
  const armCatches = r.actions.filter(a => (a.type === "catch" || a.type === "pickup") &&
    wakiIv.some(w => w.perf === a.perf && w.side === a.hand && w.from < a.t + 1e-6 && a.t < w.to - 1e-6)).length;
  const farPasses = throws.filter(a => a.pass && Math.abs(a.perf - a.catchPerf) >= 2).length;
  return { tight, levelChange, imbalance, tooHigh, farPasses, armCatches, perActions: per };
};

/* 編成の良し悪しを1つの数値にする。小さいほど良い。
   ★ブラウザの探索（TOREI.schedule）と、配布用の編成を選ぶ tools/optimize.mjs の
   両方がこの関数を使う。別々に持つと必ず食い違い、「ツールが選んだ最良」と
   「画面に出る編成」がズレるため。 */
TOREI.scoreResult = function (r, chordSpots, cfg) {
  const fails = r.noteResults.filter(x => x && x.kind === "fail").length;
  // 振りは2種類。救済振り（投げ損ない・フレーズ末限定）は重く、連打振り（意図した技法）は
  // 軽く。ただし0にはしない: 投げられる連打（複製リングで交互に投げる）が可能なら
  // そちらを選ばせる（振りはジャグリング要素がないため。2026-08-26）。
  const shakes = r.noteResults.filter(x => x && x.kind === "shake" && !x.repeat).length;
  const repShakes = r.noteResults.filter(x => x && x.kind === "shake" && x.repeat).length;
  const throws = r.actions.filter(a => a.type === "throw");
  const passes = throws.filter(a => a.pass).length;
  const passRate = throws.length ? passes / throws.length : 0;
  // パス率の報酬は70%で頭打ち、80%超はむしろ抑える（2026-08-26 本人方針
  // 「多くて良いが80%を超える必要はない。できれば70%くらいに抑えたい」）。
  // 従来の一直線な報酬（rate×8）だと高いほど常に得で、90%台の編成が選ばれ続けた。
  const PASS_SWEET = 0.70, PASS_HIGH = 0.80;
  const passBonus = cfg.passMode === "off" ? 0
    : Math.min(passRate, PASS_SWEET) * 8
      - Math.max(0, passRate - PASS_HIGH) * 6;
  // パス率20%は本人が定めた下限（2026-08-25）。比例ボーナスだけだと、
  // 所作やリング数の小さな得と引き換えに下限を割る編成が選ばれうる。
  const passFloor = (cfg.passMode === "off" || !throws.length) ? 0
    : Math.max(0, 0.20 - passRate) * 100;
  const chordMiss = chordSpots - r.actions.filter(a => a.chordRole === "held").length;
  // 無駄な所作（2026-08-25 本人指摘）。持ち替えと開演前の脇は音楽的に何も生まない。
  // 曲中の脇は減点しない——3本以上を持つ演者には正当な技法で、減点するとパス率を大きく削る
  // （実測: グーチョキパー75%→31%、ジングルベル69%→37%）。
  // 脇側の手へ渡すのはキャッチする腕を空けるための正しい手順なので、無駄には数えない
  const handoffs = r.actions.filter(a => a.type === "store" && a.to === "otherhand" && !a.toParked).length;
  const prepWaki = r.actions.filter(a => a.prep && a.type === "store" && a.to === "waki").length;
  const fuss = handoffs * 0.5 + prepWaki * 0.4;
  // 自分投げの連続を避ける（2026-08-26 本人方針「自分へのパスが3連続・4連続と増えるほど
  // 避けたい。自分へのパスと他人へのパスがいい感じに順番にやってくるのが正しい」）。
  // 曲の時間順に投げを並べ、演者間パスを1本も挟まない連続（run）の長さで累進的に減点。
  // 2連続までは無料、3連続 0.8、4連続 2.4、5連続 4.8 …（(len-2)×(len-1)×0.4）。
  const E0 = Object.assign({}, TOREI.EFFORT, cfg.effort || {});
  let selfRunCost = 0, maxSelfRun = 0;
  if (cfg.passMode !== "off") {
    const seq = throws.slice().sort((a, b) => a.t - b.t);
    let run = 0;
    const closeRun = () => {
      if (run > maxSelfRun) maxSelfRun = run;
      if (run >= 3) selfRunCost += (run - 2) * (run - 1) * (E0.selfRun != null ? E0.selfRun : 0.4);
      run = 0;
    };
    for (const th of seq) { if (th.pass) closeRun(); else run++; }
    closeRun();
  }

  // 冒頭は最も目を引くので、演者間の受け渡しで始めたい（2026-08-25 本人方針。
  // 2026-08-26 拡張: 最初の2音とも。第九の冒頭ミ2音は交換で投げ合える、との本人指摘）。
  let openMiss = 0;
  if (cfg.passMode !== "off") {
    for (const idx of [0, 1]) {
      const c0 = r.actions.find(a => a.type === "catch" && a.noteIdx === idx);
      if (c0 && !c0.pass) openMiss += 1.0;
    }
  }
  // 人間に無理がないか（2026-08-25 本人要望）。物理的な成立とは別の軸なので、
  // 破綻・振り・和音より弱く、パス率と competing する程度の重みに置く。
  const E = Object.assign({}, TOREI.EFFORT, cfg.effort || {});
  const em = TOREI.effortMetrics(r, cfg);
  const effort = em.tight * E.gapCost + em.tooHigh * E.levelCost
    + em.levelChange * E.evenLevel + em.imbalance * E.evenLoad + em.farPasses * E.farPass
    + em.armCatches * E.wakiArm;
  // 投げの高さのバリエーション（2026-08-26 本人方針）。段の種類の多さと、
  // 高い投げ（高さ4以上）が曲全体に「定期的に」散らばっていることを強く加点する。
  // 散らばりは曲を四分割して「高い投げを含む区間の数」で測る（数だけだと一箇所に固まる）。
  let varietyBonus = 0;
  if (throws.length) {
    const lv = throws.map(a => TOREI.throwLevel(a.flight));
    const distinct = new Set(lv).size;
    const t0 = Math.min(...throws.map(a => a.t));
    const t1 = Math.max(...throws.map(a => a.t)) + 0.001;
    const covered = new Set(throws.filter((a, i) => lv[i] >= 4)
      .map(a => Math.min(3, Math.floor((a.t - t0) / (t1 - t0) * 4)))).size;
    varietyBonus = (distinct - 1) * E.varietyLevel + covered * E.varietyHigh;
  }
  return {
    score: fails * 1000 + shakes * 10 + repShakes * 2 + chordMiss * 3 + r.rings.length * E.ringCost
      + fuss + passFloor + openMiss + effort + selfRunCost - passBonus - varietyBonus,
    fails, shakes, repShakes, chordMiss, passRate, rings: r.rings.length,
    handoffs, prepWaki, openPass: openMiss === 0, effort, em,
    selfRunCost, maxSelfRun, varietyBonus,
  };
};

// 楽譜に書かれた和音（同時刻2音以上）の箇所数
TOREI.countChordSpots = function (melody) {
  const m = new Map();
  for (const n of melody.notes) { const k = n.beat.toFixed(6); m.set(k, (m.get(k) || 0) + 1); }
  let c = 0;
  for (const v of m.values()) if (v >= 2) c++;
  return c;
};

TOREI.schedule = function (melody, cfg) {
  // ★確定済みの編成（cfg.seed）があるなら、探索せずそれを再現する。
  // 曲を配って稽古する以上、編成は毎回同じでなければならない。ブラウザで毎回探索し直すと、
  // スケジューラーに手を入れるたびに配布済みの曲の振り付けが黙って変わってしまう
  // （2026-08-25 本人提案「楽曲ごとに先に最適化して固める」への対応）。
  // 楽譜を編集したら呼び出し側が seed を捨てる＝そこからは通常の探索に戻る。
  if (cfg.seed != null) return TOREI._scheduleOnce(melody, cfg, cfg.seed);

  const chordSpots = TOREI.countChordSpots(melody);
  let best = null, bestScore = Infinity;
  // ランダム再スタート法なので、探索量がそのまま質になる。
  // 実測（全34曲・2026-08-25）: 48→平均パス82.7% / 200→86.7% / 600→87.7% / 1500→88.3%。
  // ぶんぶんぶんは 48→45% だが 200→88%（冒頭3音すべてパス）と劇的に変わる。
  // ただし1曲あたりの時間も比例して伸びる（200で最長1.3秒＝編集中の再計算には重い）。
  // そこで対話中は「控えめな上限＋十分に良ければ即打ち切り」、
  // 配布する編成は tools/optimize.mjs が大きな探索量で選んで固める、の二段構えにする。
  const budget = cfg.searchBudget || 200;
  const goodEnough = cfg.passMode === "off" ? 0 : 0.6;
  for (let seed = 0; seed < budget; seed++) {
    const r = TOREI._scheduleOnce(melody, cfg, seed);
    const m = TOREI.scoreResult(r, chordSpots, cfg);
    if (m.score < bestScore) { bestScore = m.score; best = r; }
    if (m.fails === 0 && m.shakes === 0 && m.chordMiss === 0 && m.openPass
        && (m.passRate === 1 || m.passRate >= goodEnough)) break;
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
  // パッシングの好み: more=積極的に他の演者へ投げ渡す / natural=必要な時だけ / off=なし。
  // 「more」の積極性もseedで振る（avoidLevelと同じ発想: 両極を探索し、採点で選ぶ）。
  // 全シードを強気(-0.7)にすると、パスしすぎて自分の担当音を出せない曲が20シード全滅する
  // （実測: Swing Low が成立するのは avoidLevel=0 のシードだけで、そこが強気だと壊れる）。
  // 強気/従来の分け方は avoidLevel(seed%3) と直交する floor(seed/3) の偶奇にして、
  // 全avoidLevel × 両passCost の組み合わせが必ず試されるようにする。
  const passAggressive = Math.floor(seed / 3) % 2 === 1;
  // 開演時の配置も両極を探索する。「脇を先に使う」か「両手を先に埋める」か。
  // どちらが良いかは曲による: 曲頭でキャッチが要るなら手を空けておきたいし、
  // そうでないなら脇は取り出しの0.7秒と所作が増えるだけの無駄になる
  // （2026-08-25 本人指摘「演者1が最初に脇に挟むのは全く無意味」）。
  // seed%3(avoidLevel) と floor(seed/3)%2(passAggressive) に直交させるので、
  // seed 0〜11 で 3×2×2=12 通りの組み合わせが必ず一巡する。
  // ★演者ごとに別々に決める。全員一律にすると必ずどちらかの弊害が出る:
  //   全員「脇を先に」→ 手が空いている演者まで無意味に脇を使う（本人指摘）
  //   全員「両手を先に」→ 曲頭で両手が塞がってパスを受けられない演者が出る
  //     （2026-08-24 に一度これで壊れている。ぶんぶんぶんの冒頭ソが自分投げに落ちた）
  // seed から演者ごとのビットを取り出し、混在した配置も探索対象にする。
  const prepBits = ((seed + 1) * 2246822519) >>> 0;
  const prepHandFirstFor = (i) => ((prepBits >>> (i + 3)) & 1) === 1;
  const passCost = cfg.passMode === "off" ? Infinity
    : cfg.passMode === "natural" ? 0.5
    : passAggressive ? -0.7 : -0.1;
  const EPS = 1e-6;
  const spb = 60 / melody.bpm;

  // 「見せ場」の音（2026-08-26 本人方針「定期的に高く投げると見栄えがとても良い」）。
  // シードごとに音の約2割を見せ場とし、その音では高い投げほど計画コストを安くする。
  // 採点側のバリエーション加点（scoreResult）と対になっていて、こちらが「高い投げを作る」、
  // 採点が「良く散らばったシードを選ぶ」。見せ場の位置はシードで変わるので、
  // 探索を増やすほど散らばりの良い配置が見つかる。
  const isShowcase = (t) => {
    let h = (Math.round(t * 1000) * 2654435761 + (seed + 1) * 40503) >>> 0;
    h ^= h >>> 15; h = (h * 2246822519) >>> 0;
    return (h % 100) < 18;
  };

  const notes = melody.notes
    .map((n, i) => ({ t: n.beat * spb, beat: n.beat, midi: n.midi, idx: i }))
    .sort((a, b) => a.t - b.t || a.midi - b.midi);

  /* --- フレーズ末の判定（2026-08-23 本人方針）---
     振り（手元で鳴らす）はジャグリング要素がないので多用させない。
     フレーズの末尾なら「余韻を鳴らす所作」として演出上成立するので、そこだけ許す。

     フレーズ末 = 次の打点までが「直前までの音の流れの2倍以上」かつ「1小節分以上」
     空く音、および曲の最後の音。両方を課すのは、片方だけだと不安定なため:
       ・倍率だけだと、音が詰まった速い曲でわずかな隙間まで拾ってしまう
       ・休みの長さだけだと、もともとゆったりした曲では全部の音がフレーズ末になる

     ★休みの長さの基準は「3拍固定」ではなく beatsPerBar（1小節分）にする
     （2026-08-24 本人指摘で修正）。旧実装の3拍固定は拍子を無視していたため、
     2/4拍子のぶんぶんぶんでは「まるまる1小節の休符」（2拍）すらフレーズ末と
     認められず、「はちがとぶ」の結びのドが振りで代用できなかった。

     ★さらに「次の打点が小節頭」なら1小節分に満たなくてもフレーズ末とみなす
     （2026-08-25 全曲点検で追加）。弱起（アウフタクト）の曲は2拍目などから
     フレーズが始まるため、結びの音の後ろは「小節の残り」＝1小節未満の休符になる。
     メリーさんのひつじ「…ひつじね」・グーチョキパー「…なにつくろう」・
     蛍の光の各フレーズ末がこれで取りこぼされていた。
     ただし単に小節をまたぐだけの音まで拾わないよう、休みが中央値の3倍以上あることも
     課す（この条件なしだと全34曲で94→177箇所と倍近く緩む。3倍を課せば101箇所）。 */
  const onsets = [...new Set(notes.map(n => n.beat))].sort((a, b) => a - b);
  const gapsB = [];
  for (let i = 1; i < onsets.length; i++) gapsB.push(onsets[i] - onsets[i - 1]);
  const medGap = gapsB.length
    ? gapsB.slice().sort((a, b) => a - b)[Math.floor(gapsB.length / 2)] : 0;
  const phraseEndBeats = new Set();
  for (let i = 0; i < onsets.length; i++) {
    if (i === onsets.length - 1) { phraseEndBeats.add(onsets[i]); continue; }
    const g = onsets[i + 1] - onsets[i];
    const barBeats = melody.beatsPerBar || 4;
    const nextAtBarline = Math.abs(onsets[i + 1] % barBeats) < EPS;
    const longEnough = g >= barBeats - EPS
      || (nextAtBarline && g >= medGap * 3 - EPS);
    if (g >= medGap * 2 - EPS && longEnough) phraseEndBeats.add(onsets[i]);
  }
  const isPhraseEnd = (note) => phraseEndBeats.has(note.beat);

  // 振りの総数の上限。フレーズ末に限っても連発すればジャグリングでなくなるため、
  // フレーズ末の数の1/4（最低1）までとする。超えた分は成立させず警告に出す。
  const shakeCap = Math.max(1, Math.ceil(phraseEndBeats.size / 4));
  let shakeCount = 0;

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
  // 曲中の同音リング追加もリング総数の上限に従う（2026-08-26 クライアント方針）。
  // 上限は「用意する鈴の総数」なので、準備で数えて曲中で破る、では意味がない。
  const canAddRing = (midi) => pitchCount(midi) < cfg.maxDup
    && !(cfg.maxRings > 0 && rings.length >= cfg.maxRings);

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
      // 詰まった連打（同じリングでは投げ直せない間隔）の組数も数える。
      // リング上限で複製を絞るとき、どの音高に複製を回すかの優先度になる
      // （2026-08-26: 第九で「連打1組のレ」が「連打3組のド」より先に複製を
      // もらってしまう事故があった。総出現数ではなく連打の多さで配る）。
      let tightPairs = 0;
      for (let i = 1; i < ts.length; i++) {
        if (ts[i] - ts[i - 1] < cycle + 0.4) tightPairs++;
      }
      need.push({ midi, copies: Math.min(tightPairs > 0 ? 2 : 1, cfg.maxDup),
        tightPairs, count: ts.length, first: ts[0] });
    }
    // 使用頻度の高い音から順に、手の空いている演者へ配る（1人 手2＋脇の本数まで）
    need.sort((a, b) => b.count - a.count || a.first - b.first);
    const capacity = 2 + cfg.wakiCap;
    const load = perfs.map(() => 0);
    // ★リング総数の上限（2026-08-26 クライアント方針「上限だけ決めて同音もあり」）。
    // 二段階で配る。まず各音高の1本目（無いとその音が一切鳴らせないので、上限に
    // 関係なく必ず作る。超過は ring-summary の警告に出る）。次に残り枠へ複製を、
    // 使用頻度の高い音高から順に足す。一段のループだと「頻度上位の複製」が
    // 「頻度下位の1本目」より先に枠を食い、上限5なのに6本できる、が起きる。
    const alloc = (midi) => {
      let best = -1;
      for (let i = 0; i < perfs.length; i++) {
        if (load[i] >= capacity) continue;
        if (best < 0 || load[i] < load[best]) best = i;
      }
      if (best < 0) return false; // 全員の手元が一杯（音高が多すぎる。警告は音符処理時に出る）
      newRing(midi, best);
      load[best]++;
      return true;
    };
    if (cfg.maxRings > 0) {
      // 上限あり: 先に各音1本、残り枠に複製。こうしないと頻度上位の複製が
      // 頻度下位の1本目より先に枠を食い、「上限5なのに6本」が起きる。
      for (const item of need) alloc(item.midi);
      // 複製は「詰まった連打の多い音高」から。上限で全部には行き渡らないため
      const byTight = need.slice().sort((a, b) => b.tightPairs - a.tightPairs || b.count - a.count);
      outer: for (const item of byTight) {
        for (let c = 1; c < item.copies; c++) {
          if (rings.length >= cfg.maxRings) break outer;
          if (!alloc(item.midi)) break outer;
        }
      }
    } else {
      // 上限なし: 従来の配り順（音高ごとに1本目と複製を続けて割り当てる）。
      // ★二段階方式に全面変更したら全曲でこの順に依存した解が崩れ、
      // メリーさんはパス81%→42%上限まで落ちた（実測3000シード）。順序も仕様の一部。
      for (const item of need) {
        for (let c = 0; c < item.copies; c++) {
          if (!alloc(item.midi)) break;
        }
      }
    }
    // 開演前にスタンドから取り出して手・脇へ。1人ずつ順に（体ごと動くので並行できない）。
    // ★手より先に脇を使う（2026-08-24 本人指摘への対応）。
    // 旧実装は「配列順で手2本→脇」という機械的な割り当てで、2本しか持たない演者は
    // 曲の後半でしか使わないリングでも問答無用で開演前から両手を塞いでいた
    // （例: ぶんぶんぶん演者1がソ・ミの2本を両手に持ち、曲頭で誰ともパスできなかった）。
    // 脇からの取り出しは0.7秒で、曲中の通常のスケジューリングが普通に扱える
    // （スタンドと違い「曲中はほぼ不可能」ではない）。そこで、初出が最も早い
    // リングだけを最初から手に持ち、残りは脇の枠が空いている限り脇へ回す。
    // 脇が尽きたときだけ2本目の手を使う（＝旧実装と同じ最終手段）。
    for (const perf of perfs) {
      const mine = rings.filter(r => r.owner === perf.id);
      const withDeadline = mine.map(r => ({ r, dl: nextNeed(r.midi, -1e9) ?? Infinity }))
        .sort((a, b) => a.dl - b.dl);
      let cursor = -4; // 曲頭から遡って配置していく
      let handUsed = 0, wakiUsed = 0;
      for (const { r } of withDeadline) {
        let toWaki, handSlot;
        if (handUsed === 0) {
          // 最初の1本は必ず手0（最速で必要になるので即使える必要がある）
          toWaki = false; handSlot = 0;
        } else if (prepHandFirstFor(perf.id) && handUsed < 2) {
          // 両手を先に埋める方針。脇の出し入れが要らないぶん所作が減る
          toWaki = false; handSlot = 1;
        } else if (wakiUsed < cfg.wakiCap) {
          // 脇へ運ぶ「作業する手」は常に手0を使う。手0の恒久保持はこのループの
          // 最初（＝この演者の準備アクションの中で最も遅い時刻に始まる）ので、
          // ここより後で処理される（＝より早い時刻に起こる）脇作業と絶対に重ならない。
          toWaki = true; handSlot = 0;
        } else {
          // 脇が尽きたら2本目の手（capacity=2+wakiCapの上限があるので高々1回）
          toWaki = false; handSlot = 1;
        }
        if (!toWaki) handUsed++; else wakiUsed++;
        const dur = T_STAND + (toWaki ? C.T_WAKI : 0);
        cursor -= dur + 0.3;
        actions.push({ type: "pickup", perf: perf.id, hand: handSlot % 2, ring: r.id,
          t: cursor, dur: T_STAND, from: "stand", midi: r.midi, prep: true });
        bodyOccupy(perf, cursor, cursor + T_STAND);
        if (toWaki) {
          actions.push({ type: "store", perf: perf.id, hand: handSlot % 2, ring: r.id,
            t: cursor + T_STAND, dur: C.T_WAKI, to: "waki", midi: r.midi, prep: true });
          perf.hands[handSlot % 2].busy.push([cursor + T_STAND, cursor + T_STAND + C.T_WAKI]);
          wakiEnter(perf, r.id, cursor + T_STAND + C.T_WAKI, null, wakiSideOf(handSlot % 2));
          r.loc = "waki";
          r.hand = null;
        } else {
          perf.hands[handSlot].poss.push({ ring: r.id, from: cursor + T_STAND, to: Infinity });
          r.loc = "hand";
          r.hand = handSlot;
        }
        r.readyAt = cursor + dur;
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
  // ★定員は左右それぞれで数える（2026-08-26）。脇は左右に1つずつある独立の場所で、
  // 左脇に挟んでいても右脇は空いている。側を持たせた以上、定員も側ごとが自然。
  // side を省いたときは「どちらかに空きがあるか」を見る。
  function wakiHasRoom(perf, from, to, side) {
    const hi = to == null ? Infinity : to;
    const count = (sd) => {
      let n = 0;
      for (const iv of perf.wakiIv) {
        if (iv.side !== sd) continue;
        if (iv.from < hi - EPS && from < iv.to - EPS) n++;
      }
      return n;
    };
    if (side == null) return count(0) < cfg.wakiCap || count(1) < cfg.wakiCap;
    return count(side) < cfg.wakiCap;
  }
  // ★脇は左右のどちらかに挟む（2026-08-25 本人指摘）。挟んだ側の腕は自由が利かないので、
  // その側の手でキャッチするのは避けたい。どちらに挟んだかを記録しないとこれが表現できない。
  // ★挟む側は「持っている手の反対」（2026-08-26 本人談: 左手で持っているリングは右脇に挟み、
  // 取るときも左手で取るのが基本）。つまり脇の側 = 1 - 挟んだ手。出し入れは同じ手が担う。
  function wakiSideOf(hand) { return 1 - hand; }
  function wakiEnter(perf, ringId, from, to, side) {
    perf.wakiIv.push({ ring: ringId, from, to: to == null ? Infinity : to, side: side == null ? 0 : side });
  }
  // そのリングが今どちらの脇にいるか（いなければ null）。
  // 退出時刻が既に決まっている滞在（restock 経路）もあるので、開いている区間だけを見てはいけない。
  // 直近に入った滞在＝いま挟まっているもの、として最大の from を採る。
  function ringWakiSide(perf, ringId) {
    let best = null;
    for (const iv of perf.wakiIv) {
      if (iv.ring !== ringId) continue;
      if (best == null || iv.from > best.from) best = iv;
    }
    return best ? best.side : null;
  }
  // 時刻 t にその側の脇がふさがっているか
  function wakiSideBusy(perf, side, t) {
    for (const iv of perf.wakiIv) {
      if (iv.side === side && iv.from < t + EPS && t < iv.to - EPS) return true;
    }
    return false;
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
     ring を perf の hand(handIdx) が投げ、キャッチ時刻 t で鳴らす。
     forceCatch指定時（保持キャッチ和音用）: キャッチ手を{perf,hand,chordRing}に固定し、
     その手が chordRing を静かに持ったままでも「和音」としてキャッチを許可する。 */
  function planToss(ring, perf, handIdx, t, isNew, forceCatch) {
    if (ring.loc === "hand" && (ring.owner !== perf.id || ring.hand !== handIdx)) return null;
    if ((ring.loc === "waki" || ring.loc === "stand") && ring.owner !== perf.id) return null;

    const hand = perf.hands[handIdx];
    let acqDur = 0, acqFrom = null;
    // ★脇から取るのは「挟んだ手＝脇の反対側の手」が基本（2026-08-26 本人談:
    //   左手のリングは右脇に挟み、取るときも左手）。右脇のリングを右手で抜くのは無理のある動き。
    //   ただし完全に禁じると、ぶんぶんぶんは5本編成が成立しなくなる（実測: 600シード×8設定すべて0本。
    //   成立させるには複製ありの8〜9本編成が要る）。本人の言葉も「基本」なので、
    //   強く割高にして「他に手が無ければ使う」扱いにする。
    // ★脇から抜くのは「挟んだ手＝脇の反対側の手」だけ（2026-08-26 本人談:
    //   左手のリングは右脇に挟み、取るときも左手）。右脇のリングを右手で抜くのは無理な動き。
    //   投げたい手が違う場合は、禁止でも黙認でもなく **抜いてから渡す** 2段の手順にする。
    //   （禁じるだけだと、ぶんぶんぶんは5本編成が成立しなくなる: 600シード×8設定すべて0本。
    //     一方この2段なら 0.4秒足すだけで、本人が言う自然な動きのまま成立する）
    let acqVia = null;   // 抜く役の手（投げ手と違うとき）
    if (ring.loc === "waki") {
      const side = ringWakiSide(perf, ring.id);
      const puller = side == null ? handIdx : 1 - side;   // 脇の反対側の手が抜く
      acqFrom = "waki";
      if (puller === handIdx) acqDur = C.T_WAKI;
      else { acqVia = puller; acqDur = C.T_WAKI + C.T_HANDOFF; }
    } else if (ring.loc === "stand") { acqDur = T_STAND; acqFrom = "stand"; }

    // 滞空時間の候補: 希望値を中心に外側へ探す。
    // ★刻みは0.05（2026-08-23）。0.1刻みだと「基準±0.1の倍数」しか試せず、
    // スライダーが0.95のとき1.00の成立窓に一度も届かない。テンポが速い曲では
    // 成立窓が狭く、これが「滞空をわずかに動かすとパスが激減する」崖を作っていた
    // （実測: ぶんぶんぶん96BPMで flight1.00=パス84% / 0.95=22%。0.05刻みで
    // 0.95〜1.05が84%の平坦域になる）。
    const fCands = [];
    for (let d = 0; d <= 1.6; d += 0.05) {
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

      // ★「脇の反対側の手で抜いてから渡す」経路では、抜く役の手も空いている必要がある。
      // ここを見ないと、他の予定が入っている手に抜かせる計画が通り、同じ手が2本持つ状態になる。
      if (acqVia != null && aFrom === "waki") {
        const via = perf.hands[acqVia];
        const viaEnd = acqStart0 + C.T_WAKI + C.T_HANDOFF;
        if (!isFree(via, acqStart0, viaEnd)) return null;
        if (possConflict(via, acqStart0, viaEnd, ring.id).kind !== "none") return null;
      }

      // 別リングを持っていたら先に置く（置き先: 脇に空きがあれば脇、なければ台）
      let storeDur = 0, storeTo = null, storedPoss = null, toParkedArm = false;
      const conf0 = possConflict(hand, acqStart0, chainEnd, ring.id);
      if (conf0.kind === "blocked") return null;
      if (conf0.kind === "storable") {
        storedPoss = conf0.poss;
        // 置き先の優先順: 逆の手へ持ち替え(速い) → 脇(1本まで) → スタンド(遅い)
        const otherIdx = 1 - handIdx;
        const other = perf.hands[otherIdx];
        // 逆の手が「脇を使っている側」なら、その腕はもう止まっている。渡すだけなら速い。
        const parkDur = wakiSideBusy(perf, otherIdx, acqStart0) ? C.T_HANDOFF_PARK : C.T_HANDOFF;
        const hs = acqStart0 - parkDur;
        // ★受け側の手を「以後ずっと空いているか」で検査する（2026-08-23 本人指摘への対応）。
        // リングを持っている手でキャッチすると衝撃で両方鳴ってしまう（＝意図しない和音）。
        // 持ち替えたリングがいつ受け手を出るかは将来の計画次第で確定できない。
        // 「次の出番まで」の近似も試したが、その出番を別の複製リングが担って
        // 持ち替えたリングが残留し、確定済みキャッチと両鳴りになった（実測: 蛍の光）。
        // → 受け手に以後の予定が1つでもあれば持ち替えを諦める（waki/standへ流れる）。
        if (isFree(other, hs, Infinity)
            && possConflict(other, hs, Infinity, storedPoss.ring).kind === "none") {
          storeTo = "otherhand";
          storeDur = parkDur;
          toParkedArm = parkDur === C.T_HANDOFF_PARK;
        } else if (wakiHasRoom(perf, acqStart0 - C.T_WAKI, null, wakiSideOf(handIdx))) {
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
      return { storeDur, storeTo, storedPoss, toParkedArm, acqVia, acqStart: acqStart0, lead, f, throwTime };
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
            if (!wakiHasRoom(perf, s0 + rDur, w.acqStart + C.T_WAKI, wakiSideOf(rh))) continue;
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

    const { storeDur, storeTo, storedPoss, toParkedArm, acqStart, lead, f, throwTime } = found;

    // キャッチ手の候補: 自分の両手 ＋（パッシング有効なら）他の演者の手。
    // 投げ渡し(パス)はリングの持ち主がキャッチした演者に移る。
    // forceCatch指定時は「保持キャッチ和音」用に、その特定の(演者,手)だけを候補にする
    // （その手はforceCatch.chordRingを静かに持ったままキャッチを迎え、両方鳴って和音になる）。
    let bestCatch = null;
    const catchTargets = forceCatch
      ? [[forceCatch.perf, forceCatch.hand]]
      : perfs.flatMap(q => [[q, 0], [q, 1]]);
    for (const [q, c] of catchTargets) {
      const isSelf = q.id === perf.id;
      if (!isSelf && passCost === Infinity) continue;
      // ★この計画自身が「逆の手へ退避」を含むなら、その退避先の手では受けない
      // （2026-08-23 本人指摘「持っている手でキャッチすると両方鳴る」への対応）。
      // 退避はまだ適用前なので holdingAt には映らず、ここで見ない限り
      // 「退避したリングを持った手でキャッチ」という両鳴りの計画が通ってしまう
      // （実測: 蛍の光で発生していた）
      if (storeTo === "otherhand" && isSelf && c === 1 - handIdx) continue;
      const ch = q.hands[c];
      if (!isFree(ch, t - C.T_RECOVER, t + C.T_CATCH)) continue;
      const held = holdingAt(ch, t);
      const isChord = !!(forceCatch && held && held.ring === forceCatch.chordRing);
      const heldOk = held == null
        || (isSelf && c === handIdx && (held === storedPoss || held.ring === ring.id))
        || isChord;
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
          if (nt == null || nt - t >= avoidWin) continue;
          // ★どの手で投げる予定かまで見る（2026-08-26）。従来は「受け手が近々何かを投げる」
          // だけで一律に避けていたため、逆の手が完全に空いていてもパスを受けられなかった
          // （実測: 第九の冒頭ミ2音の交換が6000シードで一度も成立しない）。
          // その担当リングの投げに使う手が受け手候補の手と違うなら、衝突しないので数えない。
          const th = other.loc === "hand" ? other.hand
            : other.loc === "waki" ? (1 - ringWakiSide(q, other.id)) : null;
          if (th != null && th !== c) continue;
          busySoon += avoidCost;
        }
      }
      // 自分で投げて自分で受けるとき、どちらの手で受けるか。
      // ★以前は同じ手を 0.25、逆の手を 0 として「わざわざ逆の手へ渡る」方を選ばせていた。
      // これが「右手で投げ→左手でキャッチ→右手へ持ち替え」という無駄な往復を生んでいた
      // （2026-08-25 本人指摘「最初から右手から右手でいいです」）。
      // 投げた手が空いているならその手で受けるのが自然で、持ち替えも要らない。
      // 逆の手を完全に禁じると交差の動きが消えるので、わずかな差にとどめて必要な時は選べるようにする。
      const selfCost = c === handIdx ? 0.2 : 0.22;
      // ★脇にリングを挟んでいる側の腕でキャッチするのは避ける（2026-08-25 本人指摘）。
      // さらに、逆の手がその瞬間空いているなら空いている方を強く優先する
      // （2026-08-26 本人指示。空いている手を遊ばせて塞がった側の腕で取るのは不自然）。
      // 逆の手も使えない場面では従来の弱い割高にとどめ、脇側の腕で取ることを許す。
      let armCost = 0;
      if (wakiSideBusy(q, c, t)) {
        const oth = q.hands[1 - c];
        const othUsable = isFree(oth, t - C.T_RECOVER, t + C.T_CATCH)
          && !holdingAt(oth, t) && !wakiSideBusy(q, 1 - c, t);
        armCost = othUsable ? C.WAKI_ARM_FORCE : C.WAKI_ARM_COST;
      }
      const cc = (isSelf ? selfCost : passCost) + q.load * 0.3 + busySoon + armCost;
      if (!bestCatch || cc < bestCatch.cc) bestCatch = { q, c, cc, chord: isChord };
    }
    if (!bestCatch) return null;

    return {
      kind: "toss", ring, perf, handIdx, isNew,
      catchPerf: bestCatch.q, catchHand: bestCatch.c,
      chordRing: bestCatch.chord ? forceCatch.chordRing : null,
      storeDur, storeTo, storedPoss, toParkedArm, acqVia: found.acqVia,
      acqDur: found.acqDur, acqFrom: found.acqFrom, acqStart,
      restock: found.restock || null,
      throwTime, flight: f,
      cost: (storeDur + found.acqDur) + perf.load * 0.3 + (isNew ? 3 : 0)
        // 見せ場の音は高い投げほど安く、それ以外は希望の滞空に近いほど安い
        + (isShowcase(t) ? (C.FLIGHT_MAX - f) * 0.6 : Math.abs(cfg.flight - f) * 0.3)
        + lead * 0.05
        + (found.restock ? 0.5 : 0) + bestCatch.cc,
    };
  }

  /* --- 保持キャッチ和音 ---
     演者テクニック: 片手にリングを1本静かに持ったまま、別のリングをその同じ手で
     キャッチすると両方が鳴って和音になる。1人の手で2音を同時に出せるため、
     音高数に対して演者が足りない曲でも成立させられる（2026-08-22 追加）。

     制約: キャッチ直後、その手は必ず1本に戻す（＝保持していたリングを
     逆の手／脇／スタンドへ逃がす）。2本を持ったままにすると、以降の
     possConflict（「その手が今どのリングを持っているか」の前提）が壊れるため。
     この分離が成立する経路が見つからない場合、和音そのものを不採用にする。 */

  // 和音キャッチ後、handIdx の手から heldRingId を逃がす経路を探す（逆の手→脇→スタンドの優先順）
  function planSeparation(perf, handIdx, ringId, after) {
    const hand = perf.hands[handIdx];
    const otherIdx = 1 - handIdx;
    const other = perf.hands[otherIdx];
    // 逆の手は「以後ずっと空いているか」で検査（tryWindowのotherhandと同じ理由。両鳴り防止）
    if (isFree(other, after, Infinity)
        && possConflict(other, after, Infinity, ringId).kind === "none") {
      // 逆の手が脇を使っている側なら、その腕は止まっているので渡すのは速い（本人指摘）
      const d = wakiSideBusy(perf, otherIdx, after) ? C.T_HANDOFF_PARK : C.T_HANDOFF;
      return { perf, handIdx, ringId, to: "otherhand", start: after, dur: d, cost: d, toParked: d === C.T_HANDOFF_PARK };
    }
    if (wakiHasRoom(perf, after, null, wakiSideOf(handIdx))) {
      return { perf, handIdx, ringId, to: "waki", start: after, dur: C.T_WAKI, cost: C.T_WAKI };
    }
    if (bodyFree(perf, after, after + T_STAND)) {
      return { perf, handIdx, ringId, to: "stand", start: after, dur: T_STAND, cost: T_STAND };
    }
    return null;
  }

  // noteA・noteB（同時刻）を、片方の手だけで和音として成立させられるか探す。
  // 双方向（Aを保持/Bを保持）と、既存リング・複製の両方を試す。
  function planChordPair(noteA, noteB) {
    const t = noteA.t;
    let best = null;
    for (const [heldNote, newNote] of [[noteA, noteB], [noteB, noteA]]) {
      for (const heldRing of rings) {
        if (heldRing.midi !== heldNote.midi || heldRing.loc !== "hand") continue;
        const heldPerf = perfs[heldRing.owner];
        const heldHand = heldRing.hand;
        const hand = heldPerf.hands[heldHand];
        const held = holdingAt(hand, t);
        // 「今まさに静かに持っている」状態のみ対象（投げ待ち等の途中状態は除く）
        if (!held || held.ring !== heldRing.id || held.to !== Infinity) continue;

        const sep = planSeparation(heldPerf, heldHand, heldRing.id, t + C.T_CATCH);
        if (!sep) continue; // 分離できないなら和音は不採用

        const forceCatch = { perf: heldPerf, hand: heldHand, chordRing: heldRing.id };
        const tossCandidates = [];
        for (const ring2 of rings) {
          if (ring2.midi !== newNote.midi) continue;
          const p2 = perfs[ring2.owner];
          for (let h2 = 0; h2 < 2; h2++) {
            const p = planToss(ring2, p2, h2, t, false, forceCatch);
            if (p) tossCandidates.push(p);
          }
        }
        if (canAddRing(newNote.midi)) {
          for (const p2 of perfs) {
            for (let h2 = 0; h2 < 2; h2++) {
              const ghost = { id: -1, midi: newNote.midi, owner: p2.id, loc: "stand", readyAt: C.PREP, hand: null };
              const p = planToss(ghost, p2, h2, t, true, forceCatch);
              if (p) tossCandidates.push(p);
            }
          }
        }

        for (const tp of tossCandidates) {
          const totalCost = tp.cost + sep.cost + (jitter ? rnd() * jitter : 0);
          if (!best || totalCost < best.cost) {
            best = { cost: totalCost, tossPlan: tp, heldRing, heldPerf, heldHand,
              heldNote, newNote, sep };
          }
        }
      }
    }
    return best;
  }

  function planShake(ring, perf, handIdx, note, isNew) {
    const t = note.t;
    if (!cfg.allowShake) return null;
    // 連打（同音が直前にもある）の2音目以降は、キャッチしたリングをその場で振って鳴らせる
    // （2026-08-26 本人承認。実演の自然な技法で、第九の連打を72BPMで成立させる鍵）。
    // 「直前」の判定は物理で引く: 同じリングを投げ直すのに最低 T_CATCH+T_THROW+FLIGHT_MIN
    // かかるので、それ未満の間隔の同音は投げでは絶対に鳴らせない＝振りの出番。
    const repeatWin = C.T_CATCH + C.T_THROW + C.FLIGHT_MIN;
    const isRepeat = notes.some(n => n.midi === note.midi
      && n.t < note.t - EPS && note.t - n.t < repeatWin - EPS);
    // 通常の振りはフレーズ末だけ・曲全体で shakeCap 本まで（2026-08-23 本人方針）。
    // 連打振りはこの制限の外（意図した技法であって、投げ損ないの救済ではない）。
    if (!isPhraseEnd(note) && !isRepeat) return null;
    if (!isRepeat && shakeCount >= shakeCap) return null;
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
      storeTo = wakiHasRoom(perf, acqStart - C.T_WAKI - storeDur, null, wakiSideOf(handIdx)) ? "waki" : "stand";
      storeDur = storeTo === "waki" ? C.T_WAKI : T_STAND;
      storedPoss = conf.poss;
    }
    const chainStart = acqStart - storeDur;
    if (!isFree(hand, chainStart, t + C.T_SHAKE)) return null;
    if (acqFrom === "stand" && !bodyFree(perf, acqStart, acqStart + acqDur)) return null;
    if (storeTo === "stand" && !bodyFree(perf, chainStart, chainStart + storeDur)) return null;

    return {
      kind: "shake", ring, perf, handIdx, isNew, isRepeat,
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
      wakiEnter(perf, ring.id, ps + T_STAND + C.T_WAKI, acqStart + C.T_WAKI, wakiSideOf(plan.restock.hand));
      ring.loc = "waki";
      ring.readyAt = ps + T_STAND + C.T_WAKI;
    }

    // 別リングを置く（または逆の手へ持ち替える）
    if (plan.storeDur > 0 && plan.storedPoss) {
      const stored = rings[plan.storedPoss.ring];
      actions.push({ type: "store", perf: perf.id, hand: plan.handIdx, ring: stored.id,
        t: storeStart, dur: plan.storeDur, to: plan.storeTo, midi: stored.midi,
        // 脇を使っている側の手へ渡した＝キャッチする腕を空けるための正しい手順。
        // 採点では「無駄な持ち替え」と区別する（2026-08-25 本人指摘）。
        toParked: !!plan.toParkedArm });
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
        if (plan.storeTo === "waki") wakiEnter(perf, stored.id, storeStart + plan.storeDur, null, wakiSideOf(plan.handIdx));
      }
    }

    // リングを取得
    if (plan.acqDur > 0 && plan.acqVia != null) {
      // 脇の反対側の手で抜いてから、投げる手へ渡す（本人が言う自然な手順）
      const via = perf.hands[plan.acqVia];
      actions.push({ type: "pickup", perf: perf.id, hand: plan.acqVia, ring: ring.id,
        t: acqStart, dur: C.T_WAKI, from: "waki", midi: ring.midi });
      actions.push({ type: "store", perf: perf.id, hand: plan.acqVia, ring: ring.id,
        t: acqStart + C.T_WAKI, dur: C.T_HANDOFF, to: "otherhand", midi: ring.midi, toParked: false });
      via.busy.push([acqStart, acqStart + C.T_WAKI + C.T_HANDOFF]);
      via.poss.push({ ring: ring.id, from: acqStart + C.T_WAKI, to: acqStart + C.T_WAKI + C.T_HANDOFF });
      wakiLeave(perf, ring.id, acqStart);
      hand.poss.push({ ring: ring.id, from: acqStart + plan.acqDur, to: Infinity });
      // 投げ手は全区間を塞いだままにする（保守的）。narrowにすると、後から立てた別の計画が
      // その隙間に入り込み、同じ手が2本持つ状態を作る（実測: 不変条件違反1362件）。
      hand.busy.push([acqStart, acqStart + plan.acqDur]);
      ring.loc = "hand";
      ring.hand = plan.handIdx;
      ring.readyAt = acqStart + plan.acqDur;
    } else if (plan.acqDur > 0) {
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
        throwTime: plan.throwTime,
        // 注意: chordRingはリングID（0もあり得る）なので真偽値としてではなく != null で判定する
        chord: plan.chordRing != null, chordRole: plan.chordRing != null ? "new" : undefined });
      hand.busy.push([plan.throwTime, plan.throwTime + C.T_THROW]);
      airborne.push({ perf: perf.id, from: plan.throwTime, to: t });
      if (cq.id !== perf.id) airborne.push({ perf: cq.id, from: plan.throwTime, to: t });
      closePoss(hand, ring.id, plan.throwTime);
      ch.busy.push([t - C.T_RECOVER, t + C.T_CATCH]);
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
        t, dur: C.T_SHAKE, noteIdx: note.idx, midi: note.midi, repeat: !!plan.isRepeat });
      hand.busy.push([t, t + C.T_SHAKE]);
      if (plan.acqDur === 0 && !holdingAt(hand, t)) {
        hand.poss.push({ ring: ring.id, from: t, to: Infinity });
      }
      ring.readyAt = t + C.T_SHAKE;
      noteResults[note.idx] = { kind: "shake", perf: perf.id, hand: plan.handIdx,
        ring: ring.id, repeat: !!plan.isRepeat };
      if (!plan.isRepeat) {
        shakeCount++;  // 上限（shakeCap）の判定に使う。連打振りは意図した技法なので数えない
        warnings.push({ noteIdx: note.idx, t, midi: note.midi,
          msg: `${fmtTime(t)} の ${TOREI.noteName(note.midi)}: 投げが間に合わず、${TOREI.perfName(perf.id)}がフレーズ末で振って鳴らします（${shakeCount}/${shakeCap}本目）` });
      }
    }
    holdPerf.load++;

    // キャッチ後のパーキング: 次の使用が遠いリングは手から戻し、手と脇を空けておく
    // 和音キャッチ（plan.chordRing）はここでは何もしない: この直後 applyChordPlan が
    // 保持していたリングを専用の分離経路（sep、脇枠を予約済み）で逃がす。
    // ここでも脇へパークすると同じ脇枠を二重予約してしまう。
    const nn = nextNeed(note.midi, t);
    const gap = nn == null ? Infinity : nn - t;
    const after0 = plan.kind === "toss" ? t + C.T_CATCH : t + C.T_SHAKE;
    // 置き場の選択。スタンドは体ごと動くため曲中は原則使わない
    // （手・脇に収まっているうちは戻さない。戻すと次に取り出すのに4秒かかり破綻する）。
    let park = null;
    if (plan.chordRing != null) park = null; // リングID0もあるので != null で判定
    else if (gap > 2.5 && wakiHasRoom(holdPerf, after0, null, wakiSideOf(holdIdx))) park = "waki";
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
        if (park === "waki") wakiEnter(holdPerf, ring.id, after + dur, null, wakiSideOf(holdIdx));
      }
    }
  }

  // 和音キャッチ後、保持していたリングを sep（planSeparationの結果）に従って手から逃がす
  function commitSeparation(sep) {
    const perf = sep.perf, handIdx = sep.handIdx, hand = perf.hands[handIdx];
    const ring = rings[sep.ringId];
    actions.push({ type: "store", perf: perf.id, hand: handIdx, ring: ring.id,
      t: sep.start, dur: sep.dur, to: sep.to, midi: ring.midi, toParked: !!sep.toParked });
    if (sep.to === "stand") bodyOccupy(perf, sep.start, sep.start + sep.dur);
    else hand.busy.push([sep.start, sep.start + sep.dur]);
    closePoss(hand, ring.id, sep.start);
    ring.readyAt = sep.start + sep.dur;
    if (sep.to === "otherhand") {
      const otherIdx = 1 - handIdx;
      const other = perf.hands[otherIdx];
      other.busy.push([sep.start, sep.start + sep.dur]);
      other.poss.push({ ring: ring.id, from: sep.start + sep.dur, to: Infinity });
      ring.loc = "hand";
      ring.hand = otherIdx;
    } else {
      ring.loc = sep.to;
      ring.hand = null;
      if (sep.to === "waki") wakiEnter(perf, ring.id, sep.start + sep.dur, null, wakiSideOf(sep.handIdx));
    }
  }

  // 保持キャッチ和音を確定する: 新しいリングの投げ・キャッチは通常のapplyPlanで処理し、
  // 保持していたリングの音を確定させたうえで、その手から分離する。
  function applyChordPlan(cp) {
    // 新しいリング（複製）による和音の場合、ここでゴースト(id:-1)を実リングへ差し替える
    // （scheduleNoteIndependentlyの isNew 処理と同じ。抜けるとリング参照が壊れる）。
    if (cp.tossPlan.isNew) {
      const real = newRing(cp.newNote.midi, cp.tossPlan.perf.id);
      real.loc = "stand";
      cp.tossPlan.ring = real;
    }
    applyPlan(cp.tossPlan, cp.newNote);
    const t = cp.newNote.t;
    actions.push({ type: "catch", perf: cp.heldPerf.id, hand: cp.heldHand, ring: cp.heldRing.id,
      t, dur: 0, noteIdx: cp.heldNote.idx, midi: cp.heldNote.midi, chord: true, chordRole: "held" });
    noteResults[cp.heldNote.idx] = { kind: "toss", perf: cp.heldPerf.id, hand: cp.heldHand,
      ring: cp.heldRing.id, chord: true };
    cp.heldPerf.load++;
    commitSeparation(cp.sep);
  }

  function fmtTime(t) {
    const m = Math.floor(Math.max(0, t) / 60);
    const s = (Math.max(0, t) % 60).toFixed(1);
    return `${m}:${s.padStart(4, "0")}`;
  }

  preassign();

  /* --- 1音符を独立に割り当てる（和音でない場合の通常経路） --- */
  function scheduleNoteIndependently(note) {
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
    if (!anyToss && canAddRing(note.midi)) {
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
          const p = planShake(ring, perf, h, note, false);
          if (p) candidates.push(p);
        }
      }
      if (canAddRing(note.midi)) {
        for (const perf of perfs) {
          for (let h = 0; h < 2; h++) {
            const ghost = { id: -1, midi: note.midi, owner: perf.id, loc: "stand", readyAt: C.PREP, hand: null };
            const p = planShake(ghost, perf, h, note, true);
            if (p) candidates.push(p);
          }
        }
      }
    }

    for (const c of candidates) c.k = c.cost + (jitter ? rnd() * jitter : 0);
    const best = candidates.sort((a, b) => a.k - b.k)[0] || null;

    if (!best) {
      // 振りが使えなかった理由が「フレーズ末ではない」「上限に達した」なら、それを言う。
      // 単に「間に合いません」だけだと、振りをONにしているのになぜ出ないのか分からない。
      let why = "";
      if (cfg.allowShake) {
        if (!isPhraseEnd(note)) why = "。フレーズ末ではないので振りでの代用は使えません";
        else if (shakeCount >= shakeCap) why = `。振りは既に上限${shakeCap}本に達しています`;
      }
      warnings.push({ noteIdx: note.idx, t: note.t, midi: note.midi,
        msg: `${fmtTime(note.t)} の ${TOREI.noteName(note.midi)}: どの演者も間に合いません（演者を増やす／テンポを落とす／滞空を短くする）${why}` });
      noteResults[note.idx] = { kind: "fail" };
      return;
    }

    if (best.isNew) {
      const real = newRing(note.midi, best.perf.id);
      real.loc = "stand";
      best.ring = real;
    }
    applyPlan(best, note);
  }

  // 同時刻（和音）の音符をグループ化。notesは(t,midi)でソート済みなので連続走査でよい。
  const moments = [];
  for (const note of notes) {
    const last = moments[moments.length - 1];
    if (last && Math.abs(last[0].t - note.t) < EPS) last.push(note);
    else moments.push([note]);
  }

  /* --- メインループ: 時刻順のグループ（単音 or 和音）を割り当てる --- */
  for (const moment of moments) {
    // 和音（同時刻2音以上）はまず「保持キャッチ和音」（1手で2音）を試す。
    // seed>0では確率的にスキップして、乱択リスタートが和音有無の両方を探索できるようにする。
    const tryChord = moment.length >= 2 && (seed === 0 || rnd() > 0.1);
    if (tryChord) {
      let bestPair = null;
      for (let i = 0; i < moment.length; i++) {
        for (let j = i + 1; j < moment.length; j++) {
          const cp = planChordPair(moment[i], moment[j]);
          if (cp && (!bestPair || cp.cost < bestPair.cost)) bestPair = cp;
        }
      }
      if (bestPair) {
        applyChordPlan(bestPair);
        for (const note of moment) {
          if (note !== bestPair.heldNote && note !== bestPair.newNote) scheduleNoteIndependently(note);
        }
        continue;
      }
    }
    for (const note of moment) scheduleNoteIndependently(note);
  }

  actions.sort((a, b) => a.t - b.t);

  /* --- 無駄な脇の往復を取り除く（2026-08-26 本人指摘）---
     「脇に挟んでまた持つ」だけの動作が出ていた。原因は貪欲法の限界で、キャッチした時点では
     その手が後で要るかどうかが分からないため、次の出番が遠い（2.5秒超）だけで挟んでしまう。
     挟んで抜くのに 0.7+0.7＝1.4秒も手を塞ぐので、間にその手が何もしないなら完全な損。
     計画時に先を読むのは難しいので、出来上がった行動列から後で消す。
     消す条件は「同じ手で挟んで同じ手で抜き、その間その手が他に何もしていない」。
     消しても手が空く方向にしか動かないので、他の制約を壊すことはない。 */
  {
    const drop = new Set();
    const tucks = actions.filter(a => a.type === "store" && a.to === "waki" && !a.prep);
    for (const st of tucks) {
      const pk = actions.find(a => a.type === "pickup" && a.from === "waki"
        && a.ring === st.ring && a.perf === st.perf && a.t > st.t);
      if (!pk || pk.hand !== st.hand) continue;   // 逆の手で抜く場合は持ち替えなので残す
      const between = actions.some(a => a !== st && a !== pk
        && a.perf === st.perf && a.hand === st.hand && a.t > st.t - 1e-6 && a.t < pk.t + 1e-6);
      if (between) continue;                       // その手が間に働いている＝挟む意味があった
      drop.add(st); drop.add(pk);
    }
    /* --- 脇を「手の受け渡し」に使っているものを直接の持ち替えに置き換える ---
       挟んで0.7秒後に逆の手で抜く、といった動きが出ていた。脇は入れるのに0.7秒・
       出すのに0.7秒＝計1.4秒も手を塞ぐのに対し、直接渡せば0.4秒で済む。
       挟んだ手が間に何もしていないなら、脇を経由する意味はまったくない。
       置き換えは「抜く時刻から持ち替え時間ぶん」に収める。抜く動作はもともとその手を
       0.7秒塞いでいたので、より短い区間に収めるぶんには他の予定と衝突しない。 */
    for (const st of tucks) {
      if (drop.has(st)) continue;
      const pk = actions.find(a => a.type === "pickup" && a.from === "waki"
        && a.ring === st.ring && a.perf === st.perf && a.t > st.t);
      if (!pk || pk.hand === st.hand) continue;
      const dur = C.T_HANDOFF;
      if (dur >= C.T_WAKI) continue;
      const busy = actions.some(a => a !== st && a !== pk && a.perf === st.perf
        && a.hand === st.hand && a.t > st.t - 1e-6 && a.t < pk.t + dur - 1e-6);
      if (busy) continue;              // 挟んだ手が間に働いている＝脇に置く意味があった
      drop.add(st);
      pk.type = "store";
      pk.to = "otherhand";
      pk.hand = st.hand;               // 渡す側の手の動作として書き直す
      pk.dur = dur;
      delete pk.from;
      pk.toParked = false;
    }

    /* --- 曲の終わりの挟みっぱなしを消す ---
       抜く予定が無く、その後その演者に何の動作も無いなら、挟む意味がない。 */
    const lastT = actions.reduce((m, a) => Math.max(m, a.t), 0);
    for (const st of tucks) {
      if (drop.has(st)) continue;
      const pk = actions.find(a => a.type === "pickup" && a.from === "waki"
        && a.ring === st.ring && a.perf === st.perf && a.t > st.t);
      if (pk) continue;
      // その「手」が後で何もしないなら、空ける必要が無い＝挟む意味がない。
      // 演者の他方の手が働くかどうかは関係ない。
      const after = actions.some(a => a !== st && a.perf === st.perf
        && a.hand === st.hand && a.t > st.t + 1e-6);
      if (after) continue;
      drop.add(st);
      const ring = rings[st.ring];
      ring.loc = "hand"; ring.hand = st.hand;   // 手に持ったまま終わる
    }

    if (drop.size) {
      for (let i = actions.length - 1; i >= 0; i--) if (drop.has(actions[i])) actions.splice(i, 1);
      actions.sort((a, b) => a.t - b.t);
    }
  }

  // 再生・表示の開始点は「開演前の儀式」を除いた最初の動作（2026-08-26 本人指示
  // 「準備が長すぎる。最初の人が投げ始めた瞬間くらいからスタートで」）。
  // スタンドからの取り出し（prep:true）は開演前に済んでいる体で、タイムラインに出さない。
  // 行動自体は残す（Qシートの「準備」行と、開始時の持ち方の導出に使う）。
  const live = actions.filter(a => !a.prep);
  const minT = live.length ? Math.min(0, live[0].t) : 0;

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
/* Qシート: 1人の演者の手順だけを時刻順に抜き出す（稽古で自分のパートを覚えるための表）。
   文言は actionText と揃える。UI側（main.js）はこの配列を表にするだけ。
   行: { t, label(時刻表示), bar(小節.拍 or 準備), hand, text, kind, until } */
/* 開演時に誰が何の音のリングをどこに持っているか（2026-08-25 本人要望）。
   ring.loc / ring.hand は曲を通して書き換わる「最終状態」なので初期配置には使えない。
   準備フェーズ（prep:true）の行動だけを読んで、開演の瞬間の持ち方を組み立てる。
   スタンドから取る→（脇へ挟む）という2手順なので、脇へのstoreがあれば脇、なければその手。 */
TOREI.initialLayout = function (result, nPerformers) {
  const n = nPerformers || (result.rings.reduce((a, r) => Math.max(a, (r.home != null ? r.home : r.owner) + 1), 0));
  const slots = [];
  for (let i = 0; i < n; i++) slots.push({ perf: i, hands: [null, null], waki: [], stand: [] });

  const placed = new Set();
  for (const a of result.actions) {
    if (!a.prep || a.type !== "pickup") continue;
    const ring = result.rings[a.ring];
    const sl = slots[a.perf];
    if (!ring || !sl) continue;
    // 同じリングが脇へ回されるなら、その後のstoreで上書きする
    const tuck = result.actions.find(b => b.prep && b.type === "store" && b.ring === a.ring && b.to === "waki");
    if (tuck) sl.waki.push({ ring, side: 1 - tuck.hand });  // 挟む側は手の反対
    else sl.hands[a.hand] = ring;
    placed.add(a.ring);
  }
  // 準備で誰も取らなかったリングは開演時スタンドに残っている
  for (const r of result.rings) {
    if (placed.has(r.id)) continue;
    const home = r.home != null ? r.home : r.owner;
    if (slots[home]) slots[home].stand.push(r);
  }
  return slots;
};

// 1人分を「右手 ソ ／ 脇 ミ」のような読める文にする
TOREI.layoutText = function (slot) {
  const parts = [];
  if (slot.hands[1]) parts.push(`右手 ${slot.hands[1].label}`);
  if (slot.hands[0]) parts.push(`左手 ${slot.hands[0].label}`);
  for (const w of slot.waki) parts.push(`${["左", "右"][w.side]}脇 ${w.ring.label}`);
  for (const r of slot.stand) parts.push(`スタンド ${r.label}`);
  return parts.length ? parts.join(" ／ ") : "手ぶら";
};

TOREI.cueSheet = function (result, melody, cfg, perfId) {
  const handName = ["左手", "右手"];
  const spb = 60 / melody.bpm;
  const bpb = melody.beatsPerBar || 4;
  const rows = [];
  for (const a of result.actions) {
    // キャッチは受け手の行動。投げは投げ手の行動。両者が別人ならそれぞれの側にだけ出す
    if (a.perf !== perfId) continue;
    const ring = result.rings[a.ring];
    const hand = handName[a.hand];
    let text = null, kind = a.type;
    if (a.type === "pickup") text = `${ring.label} を${a.from === "waki" ? `${["左", "右"][1 - a.hand]}脇から取る` : "スタンドから取る"}`;
    else if (a.type === "store") text = `${ring.label} を${a.to === "waki" ? `${["左", "右"][1 - a.hand]}脇に挟む` : a.to === "otherhand" ? "逆の手へ持ち替える" : "スタンドに掛ける"}`;
    else if (a.type === "throw") {
      const to = a.pass ? `${TOREI.perfName(a.catchPerf)}へパス`
        : a.catchHand !== a.hand ? "自分の逆の手へ" : "自分へ";
      text = `${ring.label} を投げる（高さ${TOREI.throwLevel(a.flight)}）→ ${to}`;
    } else if (a.type === "catch") {
      const from = a.pass ? `${TOREI.perfName(a.throwPerf)}から ` : "";
      if (a.chordRole === "held") text = `持っていた${ring.label}も一緒に鳴る → ♪${TOREI.noteName(a.midi)}（和音）`;
      else if (a.chordRole === "new") text = `${from}${ring.label} をキャッチ → ♪${TOREI.noteName(a.midi)}（和音）`;
      else text = `${from}${ring.label} をキャッチ → ♪${TOREI.noteName(a.midi)}`;
    } else if (a.type === "shake") text = a.repeat
      ? `${ring.label} を続けて振って鳴らす（連打）→ ♪${TOREI.noteName(a.midi)}`
      : `${ring.label} を振って鳴らす → ♪${TOREI.noteName(a.midi)}`;
    if (!text) continue;
    const t = a.t;
    const label = t < 0 ? "準備" : `${Math.floor(t / 60)}:${(t % 60).toFixed(1).padStart(4, "0")}`;
    let bar = "";
    if (t >= -1e-6) {
      const beat = t / spb;
      bar = `${Math.floor(beat / bpb) + 1}小節${(Math.floor(beat) % bpb) + 1}拍`;
    }
    rows.push({ t, until: t + (a.dur || 0), label, bar, hand, text, kind });
  }
  rows.sort((x, y) => x.t - y.t);
  return rows;
};

TOREI.actionText = function (result, melody, cfg) {
  const lines = [];
  lines.push(`投鈴 行動表  (テンポ ${melody.bpm} BPM / 演者 ${cfg.nPerformers}人 / 基本の投げ 高さ${TOREI.throwLevel(cfg.flight)}＝滞空${cfg.flight}秒)`);
  lines.push(`投げの高さ: 1=低く速い(頭上0.6m) 2=0.9m 3=1.2m 4=1.6m 5=高く大きい(2.1m〜)`);
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
    if (a.type === "throw") lines.push(`${m}  ${who}: ${ring.label} を投げる（高さ${TOREI.throwLevel(a.flight)}・滞空 ${a.flight.toFixed(1)}秒${a.pass ? `・${TOREI.perfName(a.catchPerf)}へパス` : a.catchHand !== a.hand ? "・逆の手で受ける" : ""}）`);
    if (a.type === "catch" && a.chordRole === "held") lines.push(`${m}  ${who}: 持っていた${ring.label}も一緒に鳴る → ♪${TOREI.noteName(a.midi)}（保持キャッチ和音）`);
    else if (a.type === "catch" && a.chordRole === "new") lines.push(`${m}  ${who}: ${ring.label} をキャッチ → ♪${TOREI.noteName(a.midi)}（和音：この手が持っていたリングも同時に鳴る）`);
    else if (a.type === "catch") lines.push(`${m}  ${who}: ${ring.label} をキャッチ → ♪${TOREI.noteName(a.midi)}`);
    if (a.type === "shake") lines.push(`${m}  ${who}: ${ring.label} を${a.repeat ? "続けて振って鳴らす（連打）" : "振って鳴らす"} → ♪${TOREI.noteName(a.midi)}${a.repeat ? "" : " ※投げが間に合わない箇所"}`);
  }
  return lines.join("\n");
};
