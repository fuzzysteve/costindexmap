# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this directory.

## What this is

An animated WebGPU heatmap of `evesupport.costIndexArchive` (daily industry cost index snapshots since 2014-07-25), served by Apache + PHP-FPM as part of the fuzzwork site. There is no package manager, bundler or test suite. Public repo: <https://github.com/fuzzysteve/costindexmap> (`data/` and `db.inc.php` are gitignored). See `README.md` for the user-facing description and the data file format.

- `index.php`: page shell. Its only PHP job is emitting `?v=<filemtime>` on `app.js`/`style.css` and `window.CIMAP.dataVersion` (mtime of `data/meta.bin`), which versions the data URLs.
- `app.js`: everything client-side, as one ES module: data loading, the WebGPU pipelines (WGSL is a template string inside it), camera, input, labels, panels.
- `build.php`: CLI-only (returns 404 under FPM). Reads the archive and the SDE map tables and writes `data/*.bin`. The page never queries the DB.
- `db.inc.php`: just `require`s `../api/db.inc.php` (PDO `$dbh`, the same connection the api tools use). Don't copy credentials here.

## Raw data exports

The exact, unrounded archive is published as monthly CSVs, separate from this map:

- Public: <https://www.fuzzwork.co.uk/dump/costindex/>, one `costindex-YYYY-MM.csv.gz` (+ `.md5sum`) per complete UTC month since 2014-07, with columns `solarSystemID,activityID,costIndex,archiveTime` (ISO 8601 UTC). It includes activity 7, which the map skips.
- On disk: `/home/web/fuzzwork/htdocs/dump/costindex/`, with a PHP listing page (`index.php`) in the same style as the SDE dump page.
- Written by `/home/scripts/costindex-dump/export-months.sh`, which exports every finished month that has no file yet (`--force YYYY-MM` redoes one). It's run by `costindex-dump.timer` on the 1st of each month at 02:15, with Discord alerts on failure.

## Running and checking

- Rebuild the data: `php build.php` (about 4 min; prints row/skip/clamp counts). **If it reports any `clamped` rows, the values have outgrown `VMIN`/`VMAX`**: widen them in `build.php` (the page reads them from `meta.bin`, so nothing else needs changing).
- Syntax checks, the only automated checking: `php -l build.php index.php`, `node --check app.js`.
- The site answers on `www.fuzzwork.co.uk` (the bare domain 302s to it). From this server: `curl -sk --resolve www.fuzzwork.co.uk:443:127.0.0.1 https://www.fuzzwork.co.uk/costindexmap/`.
- `.htaccess` rules **never apply to `*.php`** on this vhost: `ProxyPassMatch` sends them straight to PHP-FPM. That's why `build.php` guards itself with a `PHP_SAPI` check. `.htaccess` does work for other files: it sets `no-gzip` plus a cache header on `*.bin`.
- Opcache revalidates every 2s, so PHP edits show up almost immediately.

### Testing in headless Chromium

Use `chromium --headless=new --no-sandbox --enable-unsafe-webgpu --enable-features=Vulkan --use-angle=swiftshader --use-webgpu-adapter=swiftshader --host-resolver-rules="MAP www.fuzzwork.co.uk 127.0.0.1" --ignore-certificate-errors` driven over CDP. Node here is v20, so it needs `node --experimental-websocket` for the global `WebSocket`. Gotchas:

- **Screenshots don't include the WebGPU canvas** (it comes out white/blank even when rendering works), and `drawImage` of the canvas from a later task gives all zeros. To see frames, inject a script before load (`Page.addScriptToEvaluateOnNewDocument`) that patches `GPUCanvasContext.prototype.configure` to add `COPY_SRC`, and wraps `GPUQueue.prototype.submit` to `copyTextureToBuffer` the current texture right after the app's own submit. Then map the buffer and turn it into a PNG through a 2D canvas. A correct frame has the clear colour `(4,5,10)` in empty areas.
- Snap Chromium keeps a persistent profile and **caches the page**: send `Network.setCacheDisabled` or you'll test stale `app.js`.
- Keyboard handlers can receive events whose target is `window`/`document`; check `instanceof Element` before calling `closest`.
- The app reports WebGPU validation errors through `device`'s `uncapturederror` (console) and shader compile errors through the status box.

## Invariants (keep in sync)

- **Byte encoding**: `build.php` (`VMIN`, `VMAX`, `1 + round((ln v - ln VMIN) * 254 / ln(VMAX/VMIN))`, 0 = no data) ↔ `qToValue`/`valueToN` in `app.js` ↔ `level()` in the WGSL (`(q - 1) / 254`). The page reads `vmin`/`vmax` from `meta.bin`; don't hard-code them in JS.
- **Grid layout**: `ci-*.bin` is day-major (`day * N + system`), XOR-delta per row. `loadActivity` undoes the delta in place and uploads one `r8unorm` texture of `N × D` (systems × days). The WebGPU default `maxTextureDimension2D` is 8192, and D reaches 8192 around January 2037; `initGpu` checks the adapter limit.
- **Uniform buffer**: the WGSL `struct U` ↔ the offsets written in `render()` (`uf`/`uu`/`ui` views over one 112-byte `ArrayBuffer`: vp 0–15, viewport 16–17, day0/day1 18–19, frac 20, size 21, sel/hov 22–23, gain 24, lineGain 25, tLo/tHi 26–27).
- **Coordinates**: positions are SDE metres / 9.4607e15 (light years) with z negated (`build.php`), so with yaw 0 the view has EVE's map orientation (x east, z north). Camera is an orbit camera (`target`, `dist`, `yaw`, `pitch`); `pitch` is clamped short of straight down because `lookAt` uses world-up.
- **Colour**: `INFERNO` stops are shared by the WGSL `ramp()` and the CSS legend/sparkline (`rampCss`), both offset by `RAMP_FLOOR` so the lowest values stay visible on the dark background. The display range is `SHOW_MIN`–`SHOW_MAX` (0.05%–20%), separate from the encoding range.
- Rendering is additive blending with no depth buffer, so draw order doesn't matter.

## Data facts this code relies on

- The archive is written by `/home/scripts/priceexport/update_cost_index.py`, once a day at 18:00 UTC (rows stamped ~18:30 UTC). Early rows have other times (the first is 01:35). `archiveTime` is UTC.
- Only known-space systems (`30000000`–`30999999`, 5,485 including Pochven and Zarzakh) have indices. All 5,485 appear every day; the count grew from 5,431 to 5,485 over the years.
- Activities: 1, 3, 4, 5, 8, 11 are mapped. Activity 7 (Reverse Engineering, ~554k rows, retired from the game) is skipped by `build.php`.
- Values run 0.0004–0.5176. The 0.14% floor only appears in later years; early data goes lower.
- 69 days are missing (the long gap is 2025-04-22 to 2025-05-26). 2022-12-21 and 2024-01-19 look like stale repeats of the previous day. A few days have two snapshots; when that happens the build keeps whichever row comes last in the scan.
- `TO_DAYS(archiveTime) - TO_DAYS('2014-07-25')` is the day index everywhere.

## Related pieces elsewhere

- Monthly CSV exports: see "Raw data exports" above. The script's systemd unit files are kept next to it.
- Full SQL export (zstd) of the table: `/home/web/backups/costIndexArchive-20261123.sql.zst`, copied to OneDrive at `fuzzwork:server-backups/costIndexArchive/`. `evesupport` is deliberately not in the nightly off-site backup (`/home/scripts/backup/offsite-backup.sh`).
- When streaming big MariaDB result sets into a slow consumer, raise `net_write_timeout` or write to disk first: the server's 60s default killed an earlier export mid-table.
- The map data is **not** rebuilt automatically. It only changes when someone runs `php build.php`.
