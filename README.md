# Cost index history map

An animated WebGPU heatmap of EVE Online's industry system cost indices, from
25 July 2014 (just after Crius introduced them) to the latest daily snapshot.
Live at <https://www.fuzzwork.co.uk/costindexmap/>.

- Every known-space system, coloured and sized by its cost index for the chosen
  activity (manufacturing, TE/ME research, copying, invention, reactions), on a
  log colour scale.
- Pan, rotate/tilt and zoom in 3D; play through time at 1 day/s up to 3 years/s,
  or scrub the timeline.
- Fly to any region or system from the search box. Clicking a system shows its
  full history; a side list shows the ten highest systems on the current day.
- Needs a browser with WebGPU (current Chrome/Edge/Safari, Firefox on Windows).

## Files

| File | What it is |
|---|---|
| `index.php` | The page. Adds cache-busting versions from file modification times. |
| `app.js` | Renderer (WebGPU), camera, controls, labels, panels. |
| `style.css` | Styles. |
| `build.php` | CLI script that builds `data/` from the database. |
| `db.inc.php.example` | Template for `db.inc.php`, the PDO connection `build.php` uses. |
| `data/meta.bin` | Gzipped JSON: systems, regions, stargates, dates, value scale. |
| `data/ci-<activity>.bin` | Gzipped cost index grid for one activity. |

## Setup

1. Serve the directory with PHP 8 (pdo_mysql and zlib are the only extensions used).
2. Copy `db.inc.php.example` to `db.inc.php` and fill in a MySQL/MariaDB user
   that can read an SDE database `eve` (for `mapSolarSystems`, `mapRegions` and
   `mapSolarSystemJumps`) and `evesupport.costIndexArchive`. Fuzzwork's
   [SDE dumps](https://www.fuzzwork.co.uk/dump/) provide the former, and its
   [monthly cost index CSVs](https://www.fuzzwork.co.uk/dump/costindex/) the
   latter (columns `solarSystemID, activityID, costIndex, archiveTime`).
3. Run `php build.php` to create `data/`.

`.htaccess` sends `data/*.bin` without extra compression, since they're already
gzipped. If your server compresses `application/octet-stream`, the page still
works: it only gunzips data that arrives gzipped.

## Updating the data

The page reads only the prebuilt files in `data/`, never the database. To pick
up new days:

```sh
php build.php
```

This takes about 4 minutes. It reads all of `evesupport.costIndexArchive`
(about 139M rows) and the SDE map tables in `eve`, and replaces the files.
Visitors get the new files automatically, because their URLs carry the build
time.

## Data format

`ci-<activity>.bin` is a grid with one row per day and one column per system
(systems in `meta.systems` order), one byte per cell:

- `0` means no data. `1`–`255` is the cost index on a log scale between `vmin` and
  `vmax` from `meta.bin`: `value = exp(ln(vmin) + (byte-1)/254 * ln(vmax/vmin))`.
- Each row after the first is XORed with the row before it, then the whole file is
  gzipped. Most systems don't change level from one day to the next, so this
  compresses well, to 1.4–5 MB per activity.
- Days missing from the archive repeat the previous day and are listed in
  `meta.missing`.

**The values are rounded** to about 3% steps, so this is a display format, not
an archive. The exact data is in the monthly CSV dumps at
<https://www.fuzzwork.co.uk/dump/costindex/>.

## Known gaps in the source data

69 days have no snapshot. The long gap is 22 April – 26 May 2025; the rest are 1–3
day outages, mostly in 2015–2016. Reverse engineering (activity 7, no longer in
the game) is in the archive but not on the map.
