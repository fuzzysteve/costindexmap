<?php
/*
 * Builds the data files for the cost index heatmap from
 * evesupport.costIndexArchive and the SDE map tables. CLI only:
 *
 *   php build.php                  incremental: re-read the last built day and add
 *                                  any newer ones (seconds). Falls back to a full
 *                                  build when there's no usable previous build.
 *   php build.php --full           rebuild everything with a full table scan (~4 min)
 *   php build.php --since DATE     incremental, but re-read from DATE (YYYY-MM-DD),
 *                                  e.g. after late rows were added to the archive
 *
 * Run nightly by costindexmap-build.timer (unit files in deploy/).
 *
 * Output in data/, all gzip-compressed:
 *   meta.bin   JSON: systems (in column order), regions, stargates, dates, the
 *              value scale, and the list of year files per activity.
 *   ci-<activity>-<year>-<hash>.bin
 *              One byte per system per day for one activity and calendar year
 *              (UTC). Day-major: row = day, column = system in meta order. A year
 *              file can be narrower than the current system list if systems were
 *              added later; its missing columns mean "no data". Byte 0 = no data,
 *              1..255 = log-scaled index between vmin and vmax. Each row is
 *              XORed with the row before it (the first with zeros).
 *              The name carries a content hash, so a file never changes and can be
 *              cached forever. Files no longer referenced are deleted after 2 days.
 *
 * Columns only ever get appended (new SDE systems go on the end), so finished
 * years never need rebuilding. Whole days missing from the archive are filled
 * with the previous day and listed in meta "missing".
 */
declare(strict_types=1);

if (PHP_SAPI !== 'cli') {
    http_response_code(404);
    exit;
}
ini_set('memory_limit', '-1');

const FORMAT = 2;
const START = '2014-07-25';  // first day in the archive (just after Crius)
const VMIN = 0.0003;         // quantisation range; real values are 0.0004..0.52
const VMAX = 0.6;
const LY = 9.4607e15;        // metres per light year
const KEEP_OLD_FILES = 2 * 86400;
const ACTIVITIES = [
    1 => 'Manufacturing',
    3 => 'Time efficiency research',
    4 => 'Material efficiency research',
    5 => 'Copying',
    8 => 'Invention',
    11 => 'Reactions',
];

function usage(): void
{
    fwrite(STDERR, "usage: php build.php [--full | --since YYYY-MM-DD]\n");
}

function logmsg(string $m): void
{
    fwrite(STDERR, '[' . gmdate('H:i:s') . "] $m\n");
}

$full = false;
$since = null;
$args = array_slice($argv, 1);
while ($args) {
    $a = array_shift($args);
    if ($a === '--full') {
        $full = true;
    } elseif ($a === '--since' && $args && preg_match('/^\d{4}-\d{2}-\d{2}$/', $args[0])) {
        $since = array_shift($args);
    } elseif ($a === '--help' || $a === '-h') {
        usage();
        exit(0);
    } else {
        fwrite(STDERR, "unknown or incomplete argument: $a\n");
        usage();
        exit(2);
    }
}

$t0 = microtime(true);
$outDir = __DIR__ . '/data';
if (!is_dir($outDir) && !mkdir($outDir, 0755, true)) {
    fwrite(STDERR, "cannot create $outDir\n");
    exit(1);
}
$lock = fopen("$outDir/.build.lock", 'c');
if (!$lock || !flock($lock, LOCK_EX | LOCK_NB)) {
    fwrite(STDERR, "another build is already running\n");
    exit(1);
}

require __DIR__ . '/db.inc.php';
/** @var PDO $dbh */
$dbh->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);

define('START_TS', (int)strtotime(START . ' 00:00:00 UTC'));

function dayDate(int $d): string
{
    return gmdate('Y-m-d', START_TS + $d * 86400);
}

function dateToDay(string $ymd): int
{
    return intdiv((int)strtotime("$ymd 00:00:00 UTC") - START_TS, 86400);
}

function yearOf(int $d): int
{
    return (int)gmdate('Y', START_TS + $d * 86400);
}

function yearStart(int $y): int
{
    return max(0, intdiv(gmmktime(0, 0, 0, 1, 1, $y) - START_TS, 86400));
}

function writeFile(string $path, string $data): void
{
    if (file_put_contents("$path.tmp", $data) !== strlen($data) || !chmod("$path.tmp", 0644) || !rename("$path.tmp", $path)) {
        throw new RuntimeException("failed writing $path");
    }
}

/** Decode a year file into plain rows, padded to $N columns. */
function readChunk(string $path, int $W, int $rows, int $N): string
{
    $raw = @gzdecode((string)@file_get_contents($path));
    if ($raw === false || strlen($raw) !== $W * $rows) {
        throw new RuntimeException("$path: missing or not $W x $rows bytes");
    }
    $pad = str_repeat("\0", $N - $W);
    $prev = str_repeat("\0", $W);
    $out = [];
    for ($r = 0; $r < $rows; $r++) {
        $prev = substr($raw, $r * $W, $W) ^ $prev;
        $out[] = $prev . $pad;
    }
    return implode('', $out);
}

/** XOR each row with the one before it (the first with zeros). */
function encodeChunk(string $g, int $N, int $rows): string
{
    $prev = str_repeat("\0", $N);
    $out = [];
    for ($r = 0; $r < $rows; $r++) {
        $cur = substr($g, $r * $N, $N);
        $out[] = $cur ^ $prev;
        $prev = $cur;
    }
    return implode('', $out);
}

// --- Previous build ------------------------------------------------------------
$prev = null;
if (is_file("$outDir/meta.bin")) {
    $json = @gzdecode((string)file_get_contents("$outDir/meta.bin"));
    $prev = $json !== false ? json_decode($json, true) : null;
}
if (!$full) {
    $why = match (true) {
        !is_array($prev) => 'no previous build',
        ($prev['format'] ?? 1) !== FORMAT => 'data format changed',
        ($prev['start'] ?? '') !== START || (float)$prev['vmin'] !== VMIN || (float)$prev['vmax'] !== VMAX => 'value scale or start date changed',
        array_column($prev['activities'], 'id') !== array_keys(ACTIVITIES) => 'activity list changed',
        default => null,
    };
    if ($why !== null) {
        logmsg("full rebuild: $why");
        $full = true;
    }
}

// --- Map: known-space systems, regions, stargates ------------------------------
$sde = [];
foreach ($dbh->query(
    'SELECT s.solarSystemID, s.solarSystemName, r.regionName, s.security, s.x, s.y, s.z
       FROM eve.mapSolarSystems s JOIN eve.mapRegions r ON r.regionID = s.regionID
      WHERE s.solarSystemID BETWEEN 30000000 AND 30999999
      ORDER BY s.solarSystemID'
) as [$id, $name, $rname, $sec, $x, $y, $z]) {
    // EVE's map is drawn with x east and z north; y is "up". The page uses
    // y-up with -z forward, so flip z.
    $sde[(int)$id] = [$name, $rname, round((float)$sec, 2), round($x / LY, 3), round($y / LY, 3), round(-$z / LY, 3)];
}

// Column order: kept from the previous build, new systems appended. Systems
// that have left the SDE keep their column and last known details.
$sys = [];
if (!$full) {
    $p = $prev['systems'];
    foreach ($p['id'] as $i => $id) {
        $sys[$id] = $sde[$id] ?? [$p['name'][$i], $prev['regions'][$p['region'][$i]], $p['sec'][$i],
            $p['pos'][$i * 3], $p['pos'][$i * 3 + 1], $p['pos'][$i * 3 + 2]];
    }
}
$added = 0;
foreach ($sde as $id => $row) {
    if (!isset($sys[$id])) {
        $sys[$id] = $row;
        $added++;
    }
}
$ids = array_keys($sys);
$N = count($ids);
$idx = array_flip($ids);
$regionNames = array_values(array_unique(array_column($sys, 1)));
sort($regionNames, SORT_NATURAL | SORT_FLAG_CASE);
$regionIdx = array_flip($regionNames);
$systemsMeta = ['id' => $ids, 'name' => [], 'region' => [], 'sec' => [], 'pos' => []];
foreach ($sys as [$name, $rname, $sec, $x, $y, $z]) {
    $systemsMeta['name'][] = $name;
    $systemsMeta['region'][] = $regionIdx[$rname];
    $systemsMeta['sec'][] = $sec;
    array_push($systemsMeta['pos'], $x, $y, $z);
}

$jumps = [];
foreach ($dbh->query('SELECT fromSolarSystemID, toSolarSystemID FROM eve.mapSolarSystemJumps WHERE fromSolarSystemID < toSolarSystemID') as [$a, $b]) {
    if (isset($idx[(int)$a], $idx[(int)$b])) {
        array_push($jumps, $idx[(int)$a], $idx[(int)$b]);
    }
}

// --- Which days to (re)build ---------------------------------------------------
$maxDay = (int)$dbh->query("SELECT TO_DAYS(MAX(archiveTime)) - TO_DAYS('" . START . "') FROM evesupport.costIndexArchive")->fetchColumn();
if ($full) {
    $fromDay = 0;
    $toDay = $maxDay;
    $missing = [];
} else {
    $lastBuilt = (int)$prev['days'] - 1;
    $fromDay = $since === null ? $lastBuilt : max(0, min($lastBuilt, dateToDay($since)));
    $toDay = max($maxDay, $lastBuilt);
    // New systems may already have archive rows that earlier builds skipped
    // (ESI can report a system before the SDE has it): re-read from their first
    // row. This lookup is cheap because solarSystemID leads the primary key.
    if ($added > 0) {
        $newIds = implode(',', array_map('intval', array_slice($ids, $N - $added)));
        $first = $dbh->query("SELECT TO_DAYS(MIN(archiveTime)) - TO_DAYS('" . START . "')
                                FROM evesupport.costIndexArchive WHERE solarSystemID IN ($newIds)")->fetchColumn();
        if ($first !== null && (int)$first < $fromDay) {
            $fromDay = max(0, (int)$first);
            logmsg("$added new system(s) have archive rows from " . dayDate($fromDay) . '; re-reading from there');
        }
    }
    $missing = array_values(array_filter($prev['missing'], fn($d) => $d < $fromDay));
}
logmsg(sprintf('%s build: %s .. %s, %d systems (%d new), %d gates',
    $full ? 'full' : 'incremental', dayDate($fromDay), dayDate($toDay), $N, $full ? 0 : $added, count($jumps) / 2));

// --- Load / create the year grids ----------------------------------------------
$prevYears = [];
if (!$full) {
    foreach ($prev['years'] as $py) {
        $prevYears[(int)$py['year']] = $py;
    }
}
$dirty = range(yearOf($fromDay), yearOf($toDay));
$need = $dirty;
if ($fromDay > 0) {
    $need[] = yearOf($fromDay - 1);   // its last day may be needed to fill a gap
}
$grid = $gStart = $gRows = [];
foreach (array_unique($need) as $y) {
    $gStart[$y] = yearStart($y);
    $gRows[$y] = min(yearStart($y + 1) - 1, $toDay) - $gStart[$y] + 1;
    foreach (ACTIVITIES as $a => $_) {
        if (isset($prevYears[$y])) {
            $py = $prevYears[$y];
            $g = readChunk("$outDir/{$py['files'][$a]}", (int)$py['width'], (int)$py['days'], $N);
            $grid[$y][$a] = $g . str_repeat("\0", ($gRows[$y] - (int)$py['days']) * $N);
        } else {
            $grid[$y][$a] = str_repeat("\0", $gRows[$y] * $N);
        }
    }
}

// --- Read the archive ----------------------------------------------------------
$dayYear = [];
for ($d = $fromDay; $d <= $toDay; $d++) {
    $dayYear[$d] = yearOf($d);
}
$lnMin = log(VMIN);
$scale = 254 / (log(VMAX) - $lnMin);

// Short ranges go through the archiveTime index (a day takes seconds). Long
// ones scan the table instead: through the index each row is a random primary
// key lookup, ~70s per million rows, while a scan reads all 139M in ~2.5 min.
// Keep the connection patient: a slow client otherwise trips net_write_timeout
// (60s) mid-scan.
$sql = "SELECT solarSystemID, activityID, TO_DAYS(archiveTime) - TO_DAYS('" . START . "'), costIndex
          FROM evesupport.costIndexArchive";
if (!$full) {
    if ($toDay - $fromDay > 120) {
        $sql .= ' IGNORE INDEX (cia_at)';
    }
    $sql .= " WHERE archiveTime >= '" . dayDate($fromDay) . "'";
}
$dbh->exec('SET SESSION net_write_timeout = 3600');
$dbh->setAttribute(PDO::MYSQL_ATTR_USE_BUFFERED_QUERY, false);
$st = $dbh->query($sql);
$rows = $skipped = $clamped = 0;
$present = [];
while ($r = $st->fetch(PDO::FETCH_NUM)) {
    $rows++;
    $c = $idx[(int)$r[0]] ?? null;
    $a = (int)$r[1];
    $d = (int)$r[2];
    if ($c === null || !isset(ACTIVITIES[$a]) || $d < $fromDay || $d > $toDay || $r[3] === null || (float)$r[3] <= 0) {
        $skipped++;
        continue;
    }
    $q = (int)round(1 + (log((float)$r[3]) - $lnMin) * $scale);
    if ($q < 1 || $q > 255) {
        $clamped++;
        $q = max(1, min(255, $q));
    }
    $y = $dayYear[$d];
    $grid[$y][$a][($d - $gStart[$y]) * $N + $c] = chr($q);
    $present[$d] = true;
    if ($rows % 20000000 === 0) {
        logmsg(sprintf('%dM rows', $rows / 1e6));
    }
}
$st->closeCursor();
$dbh->setAttribute(PDO::MYSQL_ATTR_USE_BUFFERED_QUERY, true);

// Days with no snapshot at all: hold the previous day's values.
$newMissing = 0;
for ($d = max(1, $fromDay); $d <= $toDay; $d++) {
    if (isset($present[$d])) {
        continue;
    }
    $missing[] = $d;
    $newMissing++;
    $py = yearOf($d - 1);
    $y = $dayYear[$d];
    foreach (ACTIVITIES as $a => $_) {
        $row = substr($grid[$py][$a], ($d - 1 - $gStart[$py]) * $N, $N);
        $grid[$y][$a] = substr_replace($grid[$y][$a], $row, ($d - $gStart[$y]) * $N, $N);
    }
}
logmsg("$rows rows read, $skipped skipped, $clamped clamped, $newMissing day(s) with no snapshot");

// --- Write changed years, then meta --------------------------------------------
$years = [];
foreach ($prevYears as $y => $py) {
    if (!in_array($y, $dirty, true)) {
        $years[$y] = $py;
    }
}
$written = 0;
foreach ($dirty as $y) {
    $files = [];
    foreach (ACTIVITIES as $a => $_) {
        $gz = gzencode(encodeChunk($grid[$y][$a], $N, $gRows[$y]), 9);
        $name = sprintf('ci-%d-%d-%s.bin', $a, $y, substr(hash('sha256', $gz), 0, 12));
        // Always (re)write: atomic, and never trusts a file just because it exists.
        writeFile("$outDir/$name", $gz);
        $written++;
        $files[$a] = $name;
    }
    $years[$y] = ['year' => $y, 'start' => $gStart[$y], 'days' => $gRows[$y], 'width' => $N, 'files' => $files];
    unset($grid[$y]);
}
ksort($years);

$meta = [
    'format' => FORMAT,
    'built' => gmdate('Y-m-d H:i') . ' UTC',
    'start' => START,
    'days' => $toDay + 1,
    'missing' => $missing,
    'vmin' => VMIN,
    'vmax' => VMAX,
    'activities' => array_map(fn($id, $name) => ['id' => $id, 'name' => $name], array_keys(ACTIVITIES), ACTIVITIES),
    'regions' => $regionNames,
    'systems' => $systemsMeta,
    'jumps' => $jumps,
    'years' => array_values($years),
];
writeFile("$outDir/meta.bin", gzencode(json_encode($meta, JSON_THROW_ON_ERROR | JSON_UNESCAPED_UNICODE), 9));

// Files no longer referenced: keep them a while for pages that loaded the old meta.
$keep = [];
foreach ($years as $py) {
    foreach ($py['files'] as $f) {
        $keep[$f] = true;
    }
}
$removed = 0;
foreach (glob("$outDir/ci-*.bin") ?: [] as $f) {
    if (!isset($keep[basename($f)]) && filemtime($f) < time() - KEEP_OLD_FILES) {
        unlink($f);
        $removed++;
    }
}
logmsg(sprintf('done in %.1fs: %d year(s) rebuilt, %d file(s) written, %d old file(s) removed',
    microtime(true) - $t0, count($dirty), $written, $removed));

if ($clamped > 0) {
    fwrite(STDERR, "WARNING: $clamped values fell outside VMIN..VMAX and were clamped; widen them and run --full\n");
    exit(3);
}
