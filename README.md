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

## Raw data

The map shows rounded values. The exact archive is exported every month as
gzipped CSV at <https://www.fuzzwork.co.uk/dump/costindex/>: one file per
calendar month (UTC) since July 2014, each with an MD5 checksum. Columns:
`solarSystemID, activityID, costIndex, archiveTime`. A new file appears on the
1st of each month, once the previous month is complete.

## Files

| File | What it is |
|---|---|
| `index.php` | The page. Adds cache-busting versions from file modification times. |
| `app.js` | Renderer (WebGPU), camera, controls, labels, panels. |
| `style.css` | Styles. |
| `build.php` | CLI script that builds `data/` from the database. |
| `db.inc.php.example` | Template for `db.inc.php`, the PDO connection `build.php` uses. |
| `deploy/` | systemd service and timer that run `build.php` nightly. |
| `data/meta.bin` | Gzipped JSON: systems, regions, stargates, dates, value scale, list of year files. |
| `data/ci-<activity>-<year>-<hash>.bin` | Gzipped cost index grid for one activity and calendar year. |

## Setup

1. Serve the directory with PHP 8 (pdo_mysql and zlib are the only extensions used).
2. Copy `db.inc.php.example` to `db.inc.php` and fill in a MySQL/MariaDB user
   that can read an SDE database `eve` (for `mapSolarSystems`, `mapRegions` and
   `mapSolarSystemJumps`) and `evesupport.costIndexArchive`. Fuzzwork's
   [SDE dumps](https://www.fuzzwork.co.uk/dump/) provide the former, and its
   [monthly cost index CSVs](https://www.fuzzwork.co.uk/dump/costindex/) the
   latter (columns `solarSystemID, activityID, costIndex, archiveTime`).
3. Run `php build.php` to create `data/`. To keep it current, install the units in
   `deploy/` (adjust the path), or run `php build.php` from cron once a day.
4. Make sure `build.php` and `db.inc.php` can't be requested over the web. The
   included `.htaccess` denies them, but only if your PHP setup honours
   `.htaccess` for `.php` files. With `ProxyPassMatch` to PHP-FPM it doesn't,
   so add the `<LocationMatch>` from the comment in `.htaccess` to your vhost.
   `build.php` also refuses to run outside the command line (it returns 404),
   so this is a second layer, not the only one.

`.htaccess` sends `data/*.bin` without extra compression, since they're already
gzipped. If your server compresses `application/octet-stream`, the page still
works: it only gunzips data that arrives gzipped.

## Updating the data

The page reads only the prebuilt files in `data/`, never the database.

```sh
php build.php                    # incremental: a few seconds
php build.php --full             # rebuild everything: about 3 minutes
php build.php --since 2025-12-01 # re-read the archive from a date
```

The incremental build re-reads the last day it built plus any newer days, and
rewrites only the current year's files. It falls back to a full build on its own
when there's no previous build, or when the value scale, data format or activity
list has changed. If new systems appear in the SDE, they're added as new columns,
and the build re-reads the archive from their first appearance. On
fuzzwork.co.uk, `costindexmap-build.timer` runs it every night at 19:15 UTC, after
the 18:30 UTC snapshot.

Use `--since` if older rows in the archive were added or corrected. Long ranges
scan the table rather than using the date index, which is faster for more than a
few months.

Visitors pick up new data automatically: `meta.bin` is requested with the build
time in the URL, and year files have a content hash in their names, so a finished
year is downloaded once and then cached by the browser for good.

## Data format

Each activity is split into one file per calendar year (UTC), listed in
`meta.years` with its first day (`start`, counted from 2014-07-25), number of days
and `width`. A file is a grid with one row per day and one column per system,
one byte per cell:

- Columns follow `meta.systems` order. New systems are only ever added at the
  end, so a year built before a system existed is narrower (`width` is less than
  the number of systems); treat its missing columns as "no data".
- `0` means no data. `1`–`255` is the cost index on a log scale between `vmin` and
  `vmax` from `meta.bin`: `value = exp(ln(vmin) + (byte-1)/254 * ln(vmax/vmin))`.
- Each row is XORed with the row before it (the first with zeros), then the file
  is gzipped. Most systems don't change level from one day to the next, so this
  compresses well: 1.4–5 MB per activity across all years, and only the current
  year's file (well under 1 MB) changes from day to day.
- File names end in a hash of their content, so a name never refers to different
  data. Files that are no longer referenced are deleted two days after they're
  replaced.
- Days missing from the archive repeat the previous day and are listed in
  `meta.missing`.

**The values are rounded** to about 3% steps, so this is a display format, not
an archive. The exact data is in the monthly CSV dumps at
<https://www.fuzzwork.co.uk/dump/costindex/>.

## Known gaps in the source data

69 days have no snapshot. The long gap is 22 April – 26 May 2025; the rest are 1–3
day outages, mostly in 2015–2016. Reverse engineering (activity 7, no longer in
the game) is in the archive but not on the map.
