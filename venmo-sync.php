<?php
// ─────────────────────────────────────────────────────────────────────────────
// venmo-sync.php  —  Checks Gmail for Venmo payment emails and updates the
// Skate For a Cause 2026 wish tree claimed counts in data.json automatically.
//
// SETUP (do this once):
//   1. Generate a Gmail App Password at https://myaccount.google.com/apppasswords
//      (requires 2-step verification to be turned on)
//   2. Paste the 16-character App Password into GMAIL_PASS below
//   3. Upload this file to GoDaddy public_html/
//   4. In GoDaddy cPanel → Cron Jobs, add:
//        */5 * * * *  php /home/[your-cpanel-user]/public_html/venmo-sync.php
//      (replace [your-cpanel-user] with your actual cPanel username)
// ─────────────────────────────────────────────────────────────────────────────

// Block web access — this should only run via cron
if (php_sapi_name() !== 'cli') {
    http_response_code(403);
    exit('Forbidden');
}

// ── CONFIG ────────────────────────────────────────────────────────────────────
define('GMAIL_USER', 'jordan.tomacelli@gmail.com');
define('GMAIL_PASS', 'edlqvigmpogjhabs');   // 16-char Google App Password
define('DATA_PATH',  __DIR__ . '/run-for-a-cause/data.json');
define('LOG_PATH',   __DIR__ . '/venmo-sync.log');
// ─────────────────────────────────────────────────────────────────────────────

function log_msg(string $msg): void {
    $line = date('Y-m-d H:i:s') . '  ' . $msg . PHP_EOL;
    file_put_contents(LOG_PATH, $line, FILE_APPEND);
    echo $line;
}

// ── Connect to Gmail via IMAP ─────────────────────────────────────────────────
if (!function_exists('imap_open')) {
    log_msg('ERROR: PHP IMAP extension is not enabled. Enable it in GoDaddy cPanel → Select PHP Version → Extensions → imap.');
    exit(1);
}

$imap = @imap_open('{imap.gmail.com:993/imap/ssl}INBOX', GMAIL_USER, GMAIL_PASS);
if (!$imap) {
    log_msg('ERROR: Could not connect to Gmail — ' . imap_last_error());
    log_msg('Make sure GMAIL_PASS is a valid App Password (not your real Gmail password).');
    exit(1);
}

// ── Search for unread Venmo emails ────────────────────────────────────────────
$emails = imap_search($imap, 'UNSEEN FROM "venmo@venmo.com"');

if (!$emails) {
    log_msg('No new Venmo emails.');
    imap_close($imap);
    exit(0);
}

log_msg(count($emails) . ' new Venmo email(s) found.');

// ── Load data.json ────────────────────────────────────────────────────────────
if (!file_exists(DATA_PATH)) {
    log_msg('ERROR: data.json not found at ' . DATA_PATH);
    imap_close($imap);
    exit(1);
}

$data = json_decode(file_get_contents(DATA_PATH), true);
$changed = false;

// ── Process each email ────────────────────────────────────────────────────────
foreach ($emails as $emailNum) {
    $rawBody = getEmailBody($imap, $emailNum);
    $subject = imap_utf8(imap_headerinfo($imap, $emailNum)->subject ?? '');

    log_msg("Processing: \"$subject\"");

    // Only process payment-received emails (not payment-sent confirmations)
    // Venmo subjects for received payments contain "paid you" or "sent you"
    $lowerSubject = strtolower($subject);
    if (strpos($lowerSubject, 'paid you') === false &&
        strpos($lowerSubject, 'sent you') === false &&
        strpos($lowerSubject, 'payment') === false) {
        log_msg("  → Skipping (not a received payment email)");
        imap_setflag_full($imap, (string)$emailNum, '\\Seen');
        continue;
    }

    // Look for the item note we pre-filled: "Seattle Children's Hospital – [item name]:"
    $item = null;
    if (preg_match("/Seattle Children[^\x{2013}\-]*[\x{2013}\-]\s*([^:]+):/u", $rawBody, $matches)) {
        $noteName = trim($matches[1]);
        $item = findItemByName($data, $noteName);
        if ($item) {
            log_msg("  → Matched by note: \"$noteName\" → {$item['name']}");
        }
    }

    // Fallback: scan body for any item name from the wish list
    if (!$item) {
        $item = findItemInBody($data, $rawBody);
        if ($item) {
            log_msg("  → Matched by body scan: {$item['name']}");
        }
    }

    if ($item) {
        $updated = incrementClaimed($data, $item['id']);
        if ($updated) {
            log_msg("  ✅ Claimed count updated: {$item['name']} → {$updated['before']} → {$updated['after']} (of {$item['needed']})");
            $changed = true;
        }
    } else {
        log_msg("  ⚠️  Could not match to a wish list item. Manual update may be needed.");
    }

    // Mark email as read so we don't process it again
    imap_setflag_full($imap, (string)$emailNum, '\\Seen');
}

imap_close($imap);

// ── Save data.json if anything changed ───────────────────────────────────────
if ($changed) {
    $data['lastUpdated'] = date('c');
    file_put_contents(DATA_PATH, json_encode($data, JSON_PRETTY_PRINT | JSON_UNESCAPED_UNICODE));
    log_msg('data.json saved.');
} else {
    log_msg('No changes to data.json.');
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function getEmailBody($imap, int $emailNum): string {
    $structure = imap_fetchstructure($imap, $emailNum);
    $body = '';

    if (!isset($structure->parts)) {
        // Single-part message
        $body = imap_body($imap, $emailNum);
        $body = decodeBody($body, $structure->encoding ?? 0);
    } else {
        // Multipart — try plain text parts first (section 1, then 1.1)
        foreach (['1', '1.1', '2', '1.2'] as $section) {
            $part = imap_fetchbody($imap, $emailNum, $section);
            if (!empty(trim($part))) {
                $body .= decodeBody($part, 0) . ' ';
            }
        }
    }

    // Strip HTML tags for easier text matching
    $body = html_entity_decode(strip_tags($body), ENT_QUOTES | ENT_HTML5, 'UTF-8');
    return $body;
}

function decodeBody(string $body, int $encoding): string {
    if ($encoding === 3) return base64_decode($body);
    if ($encoding === 4) return quoted_printable_decode($body);
    return $body;
}

function normalize(string $str): string {
    return strtolower(preg_replace('/[^a-z0-9 ]/i', '', $str));
}

function findItemByName(array &$data, string $searchName): ?array {
    $normSearch = normalize($searchName);
    $searchPrefix = substr($normSearch, 0, 25);
    foreach ($data['groups'] as &$group) {
        foreach ($group['items'] as &$item) {
            $normItem = normalize($item['amazonKey'] ?? $item['name']);
            $itemPrefix = substr($normItem, 0, 25);
            if (strpos($normSearch, $itemPrefix) !== false || strpos($normItem, $searchPrefix) !== false) {
                return $item;
            }
        }
    }
    return null;
}

function findItemInBody(array &$data, string $body): ?array {
    $normBody = normalize($body);
    $bestMatch = null;
    $bestLen = 0;
    foreach ($data['groups'] as &$group) {
        foreach ($group['items'] as &$item) {
            $normName = normalize($item['name']);
            // Only match on names with at least 10 chars to avoid false positives
            if (strlen($normName) >= 10 && strpos($normBody, $normName) !== false) {
                if (strlen($normName) > $bestLen) {
                    $bestMatch = $item;
                    $bestLen = strlen($normName);
                }
            }
        }
    }
    return $bestMatch;
}

function incrementClaimed(array &$data, string $itemId): ?array {
    foreach ($data['groups'] as &$group) {
        foreach ($group['items'] as &$item) {
            if ($item['id'] === $itemId) {
                $before = $item['claimed'];
                $item['claimed'] = min($item['claimed'] + 1, $item['needed']);
                return ['before' => $before, 'after' => $item['claimed']];
            }
        }
    }
    return null;
}
