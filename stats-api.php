<?php
declare(strict_types=1);

// --- CORS ---
$origin = $_SERVER['HTTP_ORIGIN'] ?? '';
if ($origin) { header('Access-Control-Allow-Origin: ' . $origin); header('Vary: Origin'); }
else { header('Access-Control-Allow-Origin: *'); }
header('Access-Control-Allow-Methods: GET, POST, OPTIONS');
header('Access-Control-Allow-Headers: Content-Type');
header('Content-Type: application/json; charset=utf-8');
if (($_SERVER['REQUEST_METHOD'] ?? '') === 'OPTIONS') { http_response_code(204); exit; }
// --- /CORS ---

// DB bootstrap
require_once dirname(__DIR__, 2) . '/editor/db.php'; // $pdo
try { ensureTables($pdo); }
catch (Throwable $e) { http_response_code(500); echo json_encode(['ok'=>false,'error'=>'Init error: '.$e->getMessage()]); exit; }

$method = $_SERVER['REQUEST_METHOD'] ?? 'GET';
$action = $_GET['action'] ?? ($_POST['action'] ?? ($method === 'POST' ? 'event' : 'summary'));

try {
  switch ($action) {
    case 'ping':   echo json_encode(['ok'=>true,'pong'=>'stats']); break;
    case 'event':  handleEvent($pdo); break;
    case 'events': listEvents($pdo);  break;
    case 'summary':
    default:       summary($pdo);     break;
  }
} catch(Throwable $e) {
  http_response_code(500);
  echo json_encode(['ok'=>false,'error'=>$e->getMessage()]);
}

// -------- functions --------
function ensureTables(PDO $pdo): void {
  $pdo->exec('CREATE TABLE IF NOT EXISTS stats_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts TEXT NOT NULL,
    date TEXT NOT NULL,
    domain TEXT NOT NULL,
    type TEXT NOT NULL,
    item TEXT,
    referrer TEXT,
    ip TEXT,
    country TEXT,
    ua TEXT,
    ua_hash TEXT,
    UNIQUE (ts, domain, type, item) ON CONFLICT IGNORE
  )');
  $pdo->exec('CREATE TABLE IF NOT EXISTS stats_unique (
    date TEXT NOT NULL,
    domain TEXT NOT NULL,
    ip TEXT NOT NULL,
    ua_hash TEXT NOT NULL,
    PRIMARY KEY (date, domain, ip, ua_hash) ON CONFLICT IGNORE
  )');
  $pdo->exec('CREATE TABLE IF NOT EXISTS geo_cache (
    ip TEXT PRIMARY KEY,
    country TEXT,
    city TEXT,
    updated_at TEXT NOT NULL
  )');
}

function handleEvent(PDO $pdo): void {
  $raw = file_get_contents('php://input');
  $data = [];
  if ($raw !== '' && $raw !== false) {
    $tmp = json_decode($raw, true);
    if (json_last_error() === JSON_ERROR_NONE && is_array($tmp)) {
      $data = $tmp;
    } else {
      parse_str($raw, $form);
      if (!empty($form)) $data = $form;
    }
  }
  if (!$data) { $data = $_POST ?: $_GET; }

  $type = strtolower(trim($data['type'] ?? ''));
  if (!in_array($type, ['visit','click','download'], true)) { echo json_encode(['ok'=>false,'error'=>'Bad type']); return; }

  $domain = '';
  if (!empty($data['domain'])) { $domain = parse_url('//'.preg_replace('~^https?://~i','', $data['domain']), PHP_URL_HOST) ?: ''; }
  if (!$domain) { $domain = parse_url($_SERVER['HTTP_ORIGIN'] ?? ($_SERVER['HTTP_REFERER'] ?? ''), PHP_URL_HOST) ?: ''; }
  $domain = preg_replace('~^www\.~i','', $domain);
  if (!$domain) { echo json_encode(['ok'=>false,'error'=>'No domain']); return; }

  $referrer = trim($data['referrer'] ?? '');
  $item = trim($data['path'] ?? ($data['url'] ?? ''));
  $ts = gmdate('c');
  $date = gmdate('Y-m-d');

  $ip = $_SERVER['HTTP_CF_CONNECTING_IP'] ?? ($_SERVER['HTTP_X_FORWARDED_FOR'] ?? ($_SERVER['REMOTE_ADDR'] ?? 'Unknown'));
  if (strpos($ip, ',') !== false) { $ip = trim(explode(',', $ip)[0]); }
  $ua = $_SERVER['HTTP_USER_AGENT'] ?? '';
  $ua_hash = substr(sha1($ua), 0, 16);

  $geo = geoLookup($pdo, $ip);
  $country = $geo['country'] ?? 'Unknown';

  $stmt = $pdo->prepare('INSERT OR IGNORE INTO stats_events
    (ts,date,domain,type,item,referrer,ip,country,ua,ua_hash)
    VALUES (:ts,:date,:domain,:type,:item,:ref,:ip,:country,:ua,:uah)');
  $stmt->execute([':ts'=>$ts, ':date'=>$date, ':domain'=>$domain, ':type'=>$type, ':item'=>$item, ':ref'=>$referrer, ':ip'=>$ip, ':country'=>$country, ':ua'=>$ua, ':uah'=>$ua_hash]);

  if ($type === 'visit') {
    $stmt = $pdo->prepare('INSERT OR IGNORE INTO stats_unique (date,domain,ip,ua_hash) VALUES (:date,:domain,:ip,:uah)');
    $stmt->execute([':date'=>$date, ':domain'=>$domain, ':ip'=>$ip, ':uah'=>$ua_hash]);
  }

  echo json_encode(['ok'=>true]);
}

function summary(PDO $pdo): void {
  $domainsFilter = [];
  if (!empty($_GET['domains'])) {
    foreach (explode(',', (string)$_GET['domains']) as $d) {
      $d = trim($d);
      if ($d === '') continue;
      $host = parse_url((stripos($d,'://')===false ? 'http://' : '') . $d, PHP_URL_HOST) ?: $d;
      $host = preg_replace('~^www\.~i','', $host);
      $domainsFilter[] = $host;
    }
  }

  $domains = [];
  foreach ($pdo->query('SELECT DISTINCT domain FROM stats_events')->fetchAll(PDO::FETCH_COLUMN) as $d) {
    if (!$domainsFilter || in_array($d, $domainsFilter, true)) $domains[] = $d;
  }

  $result = ['domains'=>[], 'overall'=>['unique_visitors'=>0,'visits'=>0,'clicks'=>0,'downloads'=>0,'top_referrers'=>[],'top_countries'=>[]]];
  $scalar = function(string $sql, array $p=[]) use($pdo){ $s=$pdo->prepare($sql); $s->execute($p); return (int)($s->fetchColumn() ?: 0); };

  foreach ($domains as $dom) {
    $block = [
      'unique_visitors' => $scalar('SELECT COUNT(*) FROM stats_unique WHERE domain=?', [$dom]),
      'visits'          => $scalar('SELECT COUNT(*) FROM stats_events WHERE domain=? AND type="visit"', [$dom]),
      'clicks'          => $scalar('SELECT COUNT(*) FROM stats_events WHERE domain=? AND type="click"', [$dom]),
      'downloads'       => $scalar('SELECT COUNT(*) FROM stats_events WHERE domain=? AND type="download"', [$dom]),
      'top_referrers'   => aggDict($pdo, 'SELECT referrer, COUNT(*) c FROM stats_events WHERE domain=? AND referrer!="" GROUP BY referrer ORDER BY c DESC LIMIT 10', [$dom]),
      'top_countries'   => aggDict($pdo, 'SELECT country, COUNT(*) c FROM stats_events WHERE domain=? GROUP BY country ORDER BY c DESC LIMIT 10', [$dom]),
    ];
    $result['domains'][$dom] = $block;
    foreach (['unique_visitors','visits','clicks','downloads'] as $k) $result['overall'][$k] += $block[$k];
    $result['overall']['top_referrers'] = mergeAgg($result['overall']['top_referrers'], $block['top_referrers']);
    $result['overall']['top_countries'] = mergeAgg($result['overall']['top_countries'], $block['top_countries']);
  }
  arsort($result['overall']['top_referrers']); arsort($result['overall']['top_countries']);
  echo json_encode(['ok'=>true] + $result);
}

function aggDict(PDO $pdo, string $sql, array $p=[]): array {
  $s=$pdo->prepare($sql); $s->execute($p);
  $out=[]; while($r=$s->fetch(PDO::FETCH_ASSOC)){ $key=$r['referrer'] ?? ($r['country'] ?? ''); $out[$key?:'—']=(int)($r['c']??0); }
  return $out;
}
function mergeAgg(array $a, array $b): array { foreach($b as $k=>$v){ $a[$k]=($a[$k]??0)+$v; } return $a; }

function listEvents(PDO $pdo): void {
  $domain = '';
  if (!empty($_GET['domain'])) {
    $d = trim((string)$_GET['domain']);
    $host = parse_url((stripos($d,'://')===false ? 'http://' : '') . $d, PHP_URL_HOST) ?: $d;
    $domain = preg_replace('~^www\.~i','', $host);
  }
  $limit = max(1, min(1000, (int)($_GET['limit'] ?? 200)));

  if ($domain) {
    $stmt = $pdo->prepare('SELECT ts,domain,type,item,referrer,country,ip FROM stats_events WHERE domain=? ORDER BY id DESC LIMIT ?');
    $stmt->execute([$domain, $limit]);
  } else {
    $stmt = $pdo->prepare('SELECT ts,domain,type,item,referrer,country,ip FROM stats_events ORDER BY id DESC LIMIT ?');
    $stmt->execute([$limit]);
  }
  echo json_encode(['ok'=>true,'events'=>$stmt->fetchAll(PDO::FETCH_ASSOC) ?: []]);
}

function geoLookup(PDO $pdo, string $ip): array {
  if (!$ip || strtolower($ip)==='unknown') return ['country'=>'Unknown','city'=>'Unknown'];
  $s=$pdo->prepare('SELECT country,city,updated_at FROM geo_cache WHERE ip=?'); $s->execute([$ip]);
  if ($row=$s->fetch(PDO::FETCH_ASSOC)) { if (strtotime($row['updated_at'].' +30 days')>time()) return ['country'=>$row['country']?:'Unknown','city'=>$row['city']?:'Unknown']; }
  $country='Unknown'; $city='Unknown';
  $url="https://ipapi.co/{$ip}/json/"; $ch=curl_init($url);
  curl_setopt($ch,CURLOPT_RETURNTRANSFER,true); curl_setopt($ch,CURLOPT_TIMEOUT,3); curl_setopt($ch,CURLOPT_SSL_VERIFYPEER,false);
  $resp=curl_exec($ch); curl_close($ch);
  if ($resp){ $j=json_decode($resp,true); if(!empty($j)){ $country=$j['country_name']??($j['country']??'Unknown'); $city=$j['city']??'Unknown'; } }
  $s=$pdo->prepare('INSERT OR REPLACE INTO geo_cache (ip,country,city,updated_at) VALUES (?,?,?,?)'); $s->execute([$ip,$country,$city,gmdate('c')]);
  return ['country'=>$country,'city'=>$city];
}
