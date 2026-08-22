/* 投鈴 — ハンドベル音源（Web Audio 加算合成）
   ハンドベルの構造: 基音 + 12度上に強い部分音 + 高次のきらめき。減衰は長め。 */
"use strict";

TOREI.audio = (() => {
  let ctx = null;
  let master = null;
  let session = null; // 再生セッション用バス。切断すれば予約済みの音も止まる

  function ensure() {
    if (!ctx) {
      ctx = new (window.AudioContext || window.webkitAudioContext)();
      master = ctx.createDynamicsCompressor();
      master.threshold.value = -14;
      master.ratio.value = 6;
      const gain = ctx.createGain();
      gain.gain.value = 0.8;
      master.connect(gain);
      gain.connect(ctx.destination);
    }
    if (ctx.state === "suspended") ctx.resume();
    return ctx;
  }

  function beginSession() {
    ensure();
    endSession();
    session = ctx.createGain();
    session.connect(master);
    return session;
  }

  function endSession() {
    if (session) {
      try { session.disconnect(); } catch (e) {}
      session = null;
    }
  }

  function bus() { return session || master; }

  /* 部分音: 比率と音量。ハンドベルはハム音(1)とオクターブ+5度(3)が特徴的 */
  const PARTIALS = [
    { ratio: 1.0, gain: 0.85, decay: 2.6 },
    { ratio: 2.0, gain: 0.30, decay: 1.6 },
    { ratio: 3.01, gain: 0.22, decay: 1.1 },
    { ratio: 4.16, gain: 0.10, decay: 0.7 },
    { ratio: 5.43, gain: 0.06, decay: 0.5 },
  ];

  function bell(midi, when, velocity) {
    ensure();
    const f0 = 440 * Math.pow(2, (midi - 69) / 12);
    const v = velocity == null ? 1 : velocity;
    const t = Math.max(when, ctx.currentTime + 0.005);

    for (const p of PARTIALS) {
      const osc = ctx.createOscillator();
      const g = ctx.createGain();
      osc.type = "sine";
      osc.frequency.value = f0 * p.ratio;
      // ごく僅かなデチューンで金属らしい揺らぎ
      osc.detune.value = (Math.sin(midi * 7.3 + p.ratio * 13) * 4);
      const peak = p.gain * v * 0.5;
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(peak, t + 0.008);
      g.gain.exponentialRampToValueAtTime(0.0005, t + p.decay);
      osc.connect(g);
      g.connect(bus());
      osc.start(t);
      osc.stop(t + p.decay + 0.1);
    }

    // 打音（キャッチの衝撃）: 短いノイズ
    const nBuf = ctx.createBuffer(1, ctx.sampleRate * 0.03, ctx.sampleRate);
    const data = nBuf.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / data.length);
    const noise = ctx.createBufferSource();
    noise.buffer = nBuf;
    const nf = ctx.createBiquadFilter();
    nf.type = "bandpass";
    nf.frequency.value = f0 * 3;
    nf.Q.value = 1.2;
    const ng = ctx.createGain();
    ng.gain.value = 0.12 * v;
    noise.connect(nf); nf.connect(ng); ng.connect(bus());
    noise.start(t);
  }

  return { ensure, bell, beginSession, endSession, get ctx() { return ctx; } };
})();
