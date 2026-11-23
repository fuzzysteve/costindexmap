# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this directory.

## What this is

An animated WebGPU heatmap of `evesupport.costIndexArchive` (daily industry cost index snapshots since 2014-07-25), served by Apache + PHP-FPM as part of the fuzzwork site. There is no package manager, bundler or test suite. Public repo: <https://github.com/fuzzysteve/costindexmap> (`data/` and `db.inc.php` are gitignored). See `README.md` for the user-facing description and the data file format.

- `index.php`: page shell. Its only PHP job is emitting `?v=<filemtime>` on `app.js`/`style.css` and `window.CIMAP.dataVersion` (mtime of `data/meta.bin`), which versions the `meta.bin` URL. Year files are **not** versioned that way: their names carry a content hash, so they're fetched without `?v=` and cached forever.
- `app.js`: everything client-side, as one ES module: data loading, the WebGPU pipelines (WGSL is a template string inside it), camera, input, labels, panels.
- `build.php`: CLI-only. Reads the archive and the SDE map tables and writes `data/meta.bin` plus one file per activity per calendar year. Incremental by default. The page never queries the DB. It must never be web-reachable; see "Keeping build.php off the web".
- `deploy/`: `costindexmap-build.service`/`.timer`, installed as copies in `/etc/systemd/system/` (copy them again after editing). The timer runs nightly at 19:15 UTC, 45 min after the 18:30 UTC archive snapshot; Discord alerts on failure.
- `db.inc.php`: just `require`s `../api/db.inc.php` (PDO `$dbh`, the same connection the api tools use). Don't copy credentials here.

## Raw data exports

The exact, unrounded archive is published as monthly CSVs, separate from this map:

- Public: <https://www.fuzzwork.co.uk/dump/costindex/>, one `costindex-YYYY-MM.csv.gz` (+ `.md5sum`) per complete UTC month since 2014-07, with columns `solarSystemID,activityID,costIndex,archiveTime` (ISO 8601 UTC). It includes activity 7, which the map skips.
- On disk: `/home/web/fuzzwork/htdocs/dump/costindex/`, with a PHP listing page (`index.php`) in the same style as the SDE dump page.
- Written by `/home/scripts/costindex-dump/export-months.sh`, which exports every finished month that has no file yet (`--force YYYY-MM` redoes one). It's run by `costindex-dump.timer` on the 1st of each month at 02:15, with Discord alerts on failure.

## Running and checking

- Update the data: `php build.php` (incremental, ~7 s: re-reads the last built day plus newer ones and rewrites the current year). `--full` rebuilds everything (~3 min table scan). `--since YYYY-MM-DD` re-reads from a date. Unknown arguments exit 2 without building. A `flock` on `data/.build.lock` stops two builds overlapping.
- The incremental build switches to a full one by itself if `meta.bin` is missing or its `format`, `vmin`/`vmax`, `start` or activity list differ from `build.php`. So after changing any of those, a plain `php build.php` does the right thing.
- **If a build reports any `clamped` rows, the values have outgrown `VMIN`/`VMAX`**. It exits 3, which triggers the Discord alert. Widen them in `build.php` and run it (the change forces a full build; the page reads the scale from `meta.bin`).
- Reading through the `archiveTime` index costs ~70 s per million rows (random primary-key lookups), while a table scan reads all 139M rows in ~2.5 min. That's why the build uses `IGNORE INDEX (cia_at)` for ranges over 120 days.
- Syntax checks, the only automated checking: `php -l build.php index.php`, `node --check app.js`.
- The site answers on `www.fuzzwork.co.uk` (the bare domain 302s to it). From this server: `curl -sk --resolve www.fuzzwork.co.uk:443:127.0.0.1 https://www.fuzzwork.co.uk/costindexmap/`.
- `.htaccess` rules **never apply to `*.php`** on this vhost: `ProxyPassMatch` sends them straight to PHP-FPM. `.htaccess` does work for other files: it sets `no-gzip` on `*.bin`, `max-age=1y, immutable` on the hashed year files, and 1 day on `meta.bin`.
- To test the incremental path safely, copy `build.php` to a scratch directory with a `db.inc.php` that `require`s the absolute path of `../api/db.inc.php` and its own `data/`. A correct incremental build gives files byte-identical to `--full` (same content-hash names), which makes a good regression check.

### Keeping build.php off the web

Three layers, so no single mistake exposes it:
1. **Vhost (what actually protects this server):** a `<LocationMatch "^/costindexmap/(build|db\.inc)\.php">` / `Require all denied` block just before the `.php` `ProxyPassMatch` in `/etc/apache2/sites-available/fuzzwork.conf`, mirrored in `/home/web/conf/servers/fuzzwork.conf`. Apache answers 403 before PHP-FPM is involved.
2. **`build.php` itself:** its first statement returns 404 unless `PHP_SAPI === 'cli'`. Keep that check first; nothing may run before it.
3. **`.htaccess` `FilesMatch` deny:** for other deployments (mod_php or SetHandler FPM). It does nothing here.

Check after any vhost change: `curl -sk --resolve www.fuzzwork.co.uk:443:127.0.0.1 -o /dev/null -w '%{http_code}' https://www.fuzzwork.co.uk/costindexmap/build.php` must print 403. Also try `build.php/x`, `%62uild.php` and POST.
- Opcache revalidates every 2s, so PHP edits show up almost immediately.

### Testing in headless Chromium

Use `chromium --headless=new --no-sandbox --enable-unsafe-webgpu --enable-features=Vulkan --use-angle=swiftshader --use-webgpu-adapter=swiftshader --host-resolver-rules="MAP www.fuzzwork.co.uk 127.0.0.1" --ignore-certificate-errors` driven over CDP. Node here is v20, so it needs `node --experimental-websocket` for the global `WebSocket`. Gotchas:

- **Screenshots don't include the WebGPU canvas** (it comes out white/blank even when rendering works), and `drawImage` of the canvas from a later task gives all zeros. To see frames, inject a script before load (`Page.addScriptToEvaluateOnNewDocument`) that patches `GPUCanvasContext.prototype.configure` to add `COPY_SRC`, and wraps `GPUQueue.prototype.submit` to `copyTextureToBuffer` the current texture right after the app's own submit. Then map the buffer and turn it into a PNG through a 2D canvas. A correct frame has the clear colour `(4,5,10)` in empty areas.
- Snap Chromium keeps a persistent profile and **caches the page**: send `Network.setCacheDisabled` or you'll test stale `app.js`.
- Keyboard handlers can receive events whose target is `window`/`document`; check `instanceof Element` before calling `closest`.
- The app reports WebGPU validation errors through `device`'s `uncapturederror` (console) and shader compile errors through the status box.

## Invariants (keep in sync)

- **Byte encoding**: `build.php` (`VMIN`, `VMAX`, `1 + round((ln v - ln VMIN) * 254 / ln(VMAX/VMIN))`, 0 = no data) ↔ `qToValue`/`valueToN` in `app.js` ↔ `level()` in the WGSL (`(q - 1) / 254`). The page reads `vmin`/`vmax` from `meta.bin`; don't hard-code them in JS.
- **Grid layout**: each activity is split into calendar-year files (`meta.years[]`: `year`, `start` day, `days`, `width`, `files{activity: name}`). Each file is day-major (`row * width + column`), with every row XORed with the previous one (the first with zeros). `loadActivity` fetches the years in parallel, undoes the XOR, copies each into the CPU array (`data`, `N × D`) and uploads it into one `r8unorm` texture at `origin.y = start`. The WebGPU default `maxTextureDimension2D` is 8192, and D reaches 8192 around January 2037; `initGpu` checks the adapter limit.
- **Columns only grow**: system order is the previous build's order with new SDE systems appended, so finished years never need rebuilding. A year file can therefore be narrower than `N`; build (`readChunk` pads) and page (row-by-row copy) both treat missing columns as "no data". Never reorder columns without `--full`. Systems that leave the SDE keep their column and last known details.
- **Names are content hashes** (`ci-<act>-<year>-<sha256:12>.bin`), so a file under a given name never changes. `meta.bin` is written last; files that are no longer referenced are deleted 2 days later, so a page that loaded the previous `meta.bin` can still fetch everything it needs.
- **Uniform buffer**: the WGSL `struct U` ↔ the offsets written in `render()` (`uf`/`uu`/`ui` views over one 128-byte `ArrayBuffer`: vp 0–15, viewport 16–17, day0/day1 18–19, frac 20, size 21, sel/hov 22–23, gain 24, lineGain 25, tLo/tHi 26–27, floorQ 28, floorDay 29 (u32), fade 30, pad 31).
- **Coordinates**: positions are SDE metres / 9.4607e15 (light years) with z negated (`build.php`), so with yaw 0 the view has EVE's map orientation (x east, z north). Camera is an orbit camera (`target`, `dist`, `yaw`, `pitch`); `pitch` is clamped short of straight down because `lookAt` uses world-up.
- **Colour**: `INFERNO` stops are shared by the WGSL `ramp()` and the CSS legend/sparkline (`rampCss`), both offset by `RAMP_FLOOR` so the lowest values stay visible on the dark background. The display range is `SHOW_MIN`–`SHOW_MAX` (0.05%–20%), separate from the encoding range.
- Rendering is additive blending with no depth buffer, so draw order doesn't matter.

## Data facts this code relies on

- The archive is written by `/home/scripts/priceexport/update_cost_index.py`, once a day at 18:00 UTC (rows stamped ~18:30 UTC). Early rows have other times (the first is 01:35). `archiveTime` is UTC.
- Only known-space systems (`30000000`–`30999999`, 5,485 including Pochven and Zarzakh) have indices. All 5,485 appear every day; the count grew from 5,431 to 5,485 over the years.
- Activities: 1, 3, 4, 5, 8, 11 are mapped. Activity 7 (Reverse Engineering, ~554k rows, retired from the game) is skipped by `build.php`.
- Values run 0.0004–0.5176. **From 2023-09-12 the game floors every index at exactly 0.0014** (0.14%). The patch notes for that day (21.05 #2, "2023-09-12.1") only say "We have adjusted the System Cost Index formula to make it more volatile"; the floor isn't documented, but the archive shows it. Since then about 63% (manufacturing) to 88% (reactions) of systems sit exactly on it, and none fall between 0.0014 and the edge of its rounding band. So `byte === floorQ && day >= floorDay` means "exactly the game minimum". Before that date there was no floor, and values that round to the same byte are real values.
- The page treats that floor specially: `FLOOR_VALUE`/`EVENTS` in `app.js` drive the "(game minimum)" label, the optional fade (`level().z` in the WGSL, "Fade 0.14%" checkbox), and the timeline/sparkline markers. `EVENTS[0].date` is also the floor start date. Add more `EVENTS` entries to mark other changes.
- 69 days are missing (the long gap is 2025-04-22 to 2025-05-26). 2022-12-21 and 2024-01-19 look like stale repeats of the previous day. A few days have two snapshots; when that happens the build keeps whichever row comes last in the scan.
- `TO_DAYS(archiveTime) - TO_DAYS('2014-07-25')` is the day index everywhere.

## Related pieces elsewhere

- Monthly CSV exports: see "Raw data exports" above. The script's systemd unit files are kept next to it.
- Full SQL export (zstd) of the table: `/home/web/backups/costIndexArchive-20261123.sql.zst`, copied to OneDrive at `fuzzwork:server-backups/costIndexArchive/`. `evesupport` is deliberately not in the nightly off-site backup (`/home/scripts/backup/offsite-backup.sh`).
- When streaming big MariaDB result sets into a slow consumer, raise `net_write_timeout` or write to disk first: the server's 60s default killed an earlier export mid-table.
- The map data is rebuilt every night by `costindexmap-build.timer` (incremental, seconds).
