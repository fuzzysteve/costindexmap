<?php
// Cost index heatmap: WebGPU view of evesupport.costIndexArchive.
// Data files in data/ are produced by `php build.php` (CLI only).
$v = static fn(string $f): int => @filemtime(__DIR__ . "/$f") ?: 0;
$dataVersion = $v('data/meta.bin');
?><!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Cost Index History Map</title>
<meta name="description" content="Animated WebGPU heatmap of EVE Online industry system cost indices since July 2014.">
<link rel="stylesheet" href="style.css?v=<?= $v('style.css') ?>">
</head>
<body>
<canvas id="gpu" aria-label="Map of New Eden coloured by industry cost index"></canvas>
<div id="labels" aria-hidden="true"></div>
<div id="tooltip" hidden></div>

<header class="panel" id="controls">
  <h1><a href="/" title="Fuzzwork">Fuzzwork</a> · Cost index history</h1>
  <div class="row">
    <label for="activity">Activity</label>
    <select id="activity"></select>
  </div>
  <form class="row" id="searchForm" autocomplete="off">
    <label for="search">Go to</label>
    <input id="search" list="places" placeholder="Region or system" spellcheck="false">
    <datalist id="places"></datalist>
    <button type="submit">Go</button>
  </form>
  <div class="row toggles">
    <label><input type="checkbox" id="gates" checked> Gates</label>
    <label><input type="checkbox" id="showLabels" checked> Labels</label>
    <label><input type="checkbox" id="loop"> Loop</label>
    <label title="From the 2023-09-12 patch most quiet systems sit on the game's 0.14% minimum"><input type="checkbox" id="fadeFloor" checked> Fade 0.14%</label>
    <button type="button" id="reset" title="Reset view">Reset view</button>
  </div>
  <div class="row">
    <label for="glow">Glow</label>
    <input type="range" id="glow" min="0.2" max="3" step="0.05" value="1">
  </div>
  <p class="help">Drag to pan · right-drag or shift-drag to rotate &amp; tilt · scroll or pinch to zoom · click a system for its history · double-click to focus · space plays</p>
</header>

<aside class="panel" id="side">
  <section id="info" hidden>
    <button type="button" id="infoClose" class="close" aria-label="Close">×</button>
    <h2 id="infoName"></h2>
    <p id="infoMeta" class="muted"></p>
    <p id="infoValue" class="big"></p>
    <canvas id="spark" width="300" height="80" aria-label="History of this system's cost index"></canvas>
    <p id="sparkRange" class="muted small"></p>
  </section>
  <section>
    <h2>Highest on this day</h2>
    <ol id="top"></ol>
  </section>
</aside>

<footer class="panel" id="timebar">
  <button type="button" id="play" aria-label="Play">▶</button>
  <div class="date">
    <span id="date">—</span>
    <span id="gap" class="muted small" hidden>no snapshot: previous day shown</span>
    <a id="event" class="small" hidden target="_blank" rel="noopener"></a>
  </div>
  <div id="timelineWrap">
    <input type="range" id="timeline" min="0" max="0" step="1" value="0" aria-label="Date">
    <div id="marks"></div>
  </div>
  <div class="speed">
    <label for="speed">Speed</label>
    <input type="range" id="speed" min="0" max="100" step="1" value="50">
    <span id="speedLabel" class="small"></span>
  </div>
</footer>

<div class="panel" id="legend">
  <div id="legendBar"></div>
  <div id="legendTicks"></div>
  <div class="muted small">System cost index (log scale)</div>
  <div class="muted small">Since 12 Sep 2023 the game's minimum is 0.14%</div>
</div>

<div id="status" role="status">Loading…</div>

<script>window.CIMAP = { dataVersion: <?= json_encode($dataVersion) ?> };</script>
<script type="module" src="app.js?v=<?= $v('app.js') ?>"></script>
</body>
</html>
