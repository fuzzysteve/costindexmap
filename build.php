<?php
/*
 * Builds the data files for the cost index heatmap from
 * evesupport.costIndexArchive and the SDE map tables. CLI only:
 *
 *   php build.php
 *
 * Output (all gzip-compressed, in data/):
 *   meta.bin        JSON: systems, regions, gates, dates, value scale
 *   ci-<act>.bin    one byte per system per day for that activity, day-major
 *                   (row = day, column = system). Byte 0 = no data, 1..255 =
 *                   log-scaled index between VMIN and VMAX. Rows after the
 *                   first are XORed with the previous row, so days where
 *                   little changed compress to almost nothing.
 *
 * Whole days missing from the archive are filled with the previous day and
 * listed in meta "missing", so the page can say so.
 */
declare(strict_types=1);

if (PHP_SAPI !== 'cli') {
    http_response_code(404);
    exit;
}
ini_set('memory_limit', '-1');

require __DIR__ . '/db.inc.php';
/** @var PDO $dbh */
$dbh->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);

const START = '2014-07-25';  // first day in the archive (just after Crius)
const VMIN = 0.0003;         // quantisation range; real values are 0.0004..0.52
const VMAX = 0.6;
const LY = 9.4607e15;        // metres per light year
const ACTIVITIES = [
    1 => 'Manufacturing',
    3 => 'Time efficiency research',
    4 => 'Material efficiency research',
    5 => 'Copying',
    8 => 'Invention',
    11 => 'Reactions',
];

$outDir = __DIR__ . '/data';
if (!is_dir($outDir) && !mkdir($outDir, 0755, true)) {
    fwrite(STDERR, "cannot create $outDir\n");
    exit(1);
}

function logmsg(string $m): void
{
    fwrite(STDERR, '[' . date('H:i:s') . "] $m\n");
}

function writeGz(string $path, string $data): int
{
    $gz = gzencode($data, 9);
    if ($gz === false || file_put_contents("$path.tmp", $gz) !== strlen($gz) || !rename("$path.tmp", $path)) {
        throw new RuntimeException("failed writing $path");
    }
    chmod($path, 0644);
    return strlen($gz);
}

// --- Map: known-space systems, their regions, and stargates -------------------
$systems = $dbh->query(
    'SELECT solarSystemID, solarSystemName, regionID, x, y, z, security
       FROM eve.mapSolarSystems
      WHERE solarSystemID BETWEEN 30000000 AND 30999999
      ORDER BY solarSystemID'
)->fetchAll(PDO::FETCH_NUM);
$N = count($systems);
$idx = [];
$regionIds = [];
$meta = ['id' => [], 'name' => [], 'region' => [], 'sec' => [], 'pos' => []];
foreach ($systems as $i => [$id, $name, $rid, $x, $y, $z, $sec]) {
    $idx[(int)$id] = $i;
    $regionIds[(int)$rid] = true;
    $meta['id'][] = (int)$id;
    $meta['name'][] = $name;
    $meta['region'][] = (int)$rid;
    $meta['sec'][] = round((float)$sec, 2);
    // EVE's map is drawn with x east and z north; y is "up". The page uses
    // y-up with -z forward, so flip z.
    array_push($meta['pos'], round($x / LY, 3), round($y / LY, 3), round(-$z / LY, 3));
}

$regions = [];
$in = implode(',', array_map('intval', array_keys($regionIds)));
foreach ($dbh->query("SELECT regionID, regionName FROM eve.mapRegions WHERE regionID IN ($in) ORDER BY regionName") as [$rid, $rname]) {
    $regions[(int)$rid] = count($regions);
    $regionList[] = $rname;
}
$meta['region'] = array_map(fn($r) => $regions[$r], $meta['region']);

$jumps = [];
foreach ($dbh->query('SELECT fromSolarSystemID, toSolarSystemID FROM eve.mapSolarSystemJumps WHERE fromSolarSystemID < toSolarSystemID') as [$a, $b]) {
    if (isset($idx[(int)$a], $idx[(int)$b])) {
        array_push($jumps, $idx[(int)$a], $idx[(int)$b]);
    }
}
logmsg("$N systems, " . count($regions) . ' regions, ' . (count($jumps) / 2) . ' gates');

// --- Cost index archive -------------------------------------------------------
$D = 1 + (int)$dbh->query("SELECT TO_DAYS(MAX(archiveTime)) - TO_DAYS('" . START . "') FROM evesupport.costIndexArchive")->fetchColumn();
logmsg("$D days from " . START);

$buf = [];
foreach (ACTIVITIES as $a => $_) {
    $buf[$a] = str_repeat("\0", $D * $N);
}
$present = array_fill(0, $D, false);
$lnMin = log(VMIN);
$scale = 254 / (log(VMAX) - $lnMin);

// Stream the whole table unbuffered. Keep the connection patient: a slow
// client otherwise trips net_write_timeout (60s) mid-scan.
$dbh->exec('SET SESSION net_write_timeout = 3600');
$dbh->setAttribute(PDO::MYSQL_ATTR_USE_BUFFERED_QUERY, false);
$st = $dbh->query(
    "SELECT solarSystemID, activityID, TO_DAYS(archiveTime) - TO_DAYS('" . START . "'), costIndex
       FROM evesupport.costIndexArchive"
);
$rows = $skipped = $clamped = 0;
while ($r = $st->fetch(PDO::FETCH_NUM)) {
    $rows++;
    $sys = $idx[(int)$r[0]] ?? null;
    $a = (int)$r[1];
    $d = (int)$r[2];
    if ($sys === null || !isset($buf[$a]) || $d < 0 || $d >= $D || $r[3] === null || (float)$r[3] <= 0) {
        $skipped++;
        continue;
    }
    $q = (int)round(1 + (log((float)$r[3]) - $lnMin) * $scale);
    if ($q < 1 || $q > 255) {
        $clamped++;
        $q = max(1, min(255, $q));
    }
    $buf[$a][$d * $N + $sys] = chr($q);
    $present[$d] = true;
    if ($rows % 20000000 === 0) {
        logmsg(sprintf('%dM rows', $rows / 1e6));
    }
}
$st->closeCursor();
$dbh->setAttribute(PDO::MYSQL_ATTR_USE_BUFFERED_QUERY, true);
logmsg("$rows rows read, $skipped skipped, $clamped clamped");

// Days with no snapshot at all: hold the previous day's values.
$missing = [];
for ($d = 1; $d < $D; $d++) {
    if (!$present[$d]) {
        $missing[] = $d;
        foreach ($buf as $a => $_) {
            $buf[$a] = substr_replace($buf[$a], substr($buf[$a], ($d - 1) * $N, $N), $d * $N, $N);
        }
    }
}
logmsg(count($missing) . ' missing days held from the previous day');

// --- Write --------------------------------------------------------------------
foreach ($buf as $a => $b) {
    $prev = substr($b, 0, $N);
    $parts = [$prev];
    for ($d = 1; $d < $D; $d++) {
        $cur = substr($b, $d * $N, $N);
        $parts[] = $cur ^ $prev;
        $prev = $cur;
    }
    $size = writeGz("$outDir/ci-$a.bin", implode('', $parts));
    logmsg(sprintf('ci-%d.bin: %.1f MB', $a, $size / 1e6));
    unset($buf[$a], $parts);
}

$meta = [
    'built' => gmdate('Y-m-d H:i') . ' UTC',
    'start' => START,
    'days' => $D,
    'missing' => $missing,
    'vmin' => VMIN,
    'vmax' => VMAX,
    'activities' => array_map(fn($id, $name) => ['id' => $id, 'name' => $name], array_keys(ACTIVITIES), ACTIVITIES),
    'regions' => $regionList,
    'systems' => $meta,
    'jumps' => $jumps,
];
$size = writeGz("$outDir/meta.bin", json_encode($meta, JSON_THROW_ON_ERROR | JSON_UNESCAPED_UNICODE));
logmsg(sprintf('meta.bin: %.1f MB; done', $size / 1e6));
