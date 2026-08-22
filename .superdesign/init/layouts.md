# Shared Layouts

The app has one static document shell and no shared layout component files.

## Application Shell

- Path: `index.html`
- Description: Header, stage simulation, transport/config controls, warnings, combined piano-roll/action timeline, and footer.

```html
<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>投鈴 — ハンドベル・ジャグリング シミュレーター</title>
<link rel="stylesheet" href="css/style.css">
</head>
<body>
<header>
  <div class="title-block">
    <h1>投鈴<span class="reading">とうれい</span></h1>
    <p class="tagline">投げてから、鳴るまで。</p>
  </div>
  <p class="subtitle">ハンドベル・ジャグリング 編成シミュレーター<br>
    <span class="note">メロディを置くと、演者が「いつ・どのリングを投げるか」を逆算します</span></p>
</header>
<main>
  <section id="stage-wrap"><canvas id="stage"></canvas></section>
  <section id="transport">
    <button id="btn-play" class="primary">▶ 再生</button>
    <label>テンポ <input type="number" id="inp-bpm" min="40" max="180" value="90" step="2"> BPM</label>
    <label>曲 <select id="sel-preset"></select></label>
    <button id="btn-clear">全消去</button>
    <span class="spacer"></span>
    <button id="btn-load-midi">MIDI読み込み</button>
    <input type="file" id="inp-midi-file" accept=".mid,.midi,audio/midi" hidden>
    <button id="btn-midi">MIDI書き出し</button>
    <button id="btn-copy">行動表をコピー</button>
  </section>
  <section id="config">
    <label>演者 <input type="number" id="inp-performers" min="1" max="5" value="3"> 人</label>
    <label>滞空時間 <input type="range" id="inp-flight" min="0.7" max="1.4" step="0.05" value="1.2"><span id="flight-val">1.2</span> 秒<span id="flight-height" class="sub-note"></span></label>
    <label>脇に挟める数 <input type="number" id="inp-waki" min="0" max="3" value="1"> 本</label>
    <label>スタンド持ち替え <input type="number" id="inp-stand" min="1" max="8" step="0.5" value="2"> 秒</label>
    <label>パッシング <select id="sel-pass"><option value="more" selected>多め</option><option value="natural">自然に</option><option value="off">なし</option></select></label>
    <label>同音リング最大 <input type="number" id="inp-dup" min="1" max="3" value="2"> 本</label>
    <label class="check"><input type="checkbox" id="inp-shake" checked> 間に合わない音は手元で振って鳴らす</label>
  </section>
  <div id="ring-summary"></div>
  <div id="notice" hidden></div>
  <div id="warnings" hidden></div>
  <section id="score-area">
    <div class="score-row">
      <div class="gutter-col"><canvas id="pr-gutter"></canvas><div id="tl-gutter"></div></div>
      <div id="scroll-area"><canvas id="pianoroll"></canvas><canvas id="timeline"></canvas><div id="playhead" hidden></div></div>
    </div>
    <p class="hint">上の段（楽譜）はクリックで追加・ドラッグで移動・その場でクリックすると削除。下の段は自動計算された各演者の行動。</p>
  </section>
</main>
<footer><p>投鈴 β — キャッチの瞬間にベルが鳴るジャグリングの編成を試すための道具。</p></footer>
</body>
</html>
```
