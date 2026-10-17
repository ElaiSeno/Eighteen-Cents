<?php
declare(strict_types=1);

header('Content-Type: application/json; charset=utf-8');
require_once __DIR__ . '/db.php';
require_once __DIR__ . '/auth.php';

const OWNER_USER_ID = 1;
const MACHINE_API_KEY = 'CEighteenCents_ESP32_9fK7mQ2vX8pL5nR4_Tx2026';
const DEFAULT_PIN = '7801';   // used until you change the PIN on the website

function respond(array $data, int $status = 200): void {
    http_response_code($status);
    echo json_encode($data);
    exit;
}

function readJson(): array {
    $data = json_decode(file_get_contents('php://input') ?: '', true);
    if (!is_array($data)) {
        respond(['error' => 'Invalid JSON body.'], 400);
    }
    return $data;
}

// ESP32 requests prove themselves with the API key.
function requireMachineKey(): void {
    $provided = $_SERVER['HTTP_X_API_KEY'] ?? '';
    if (!hash_equals(MACHINE_API_KEY, $provided)) {
        respond(['error' => 'Unauthorized machine request.'], 401);
    }
}

// Website requests need a signed-in owner session.
function requireOwnerSession(): void {
    $uid = logged_in_user_id();
    if ($uid === null) {
        respond(['error' => 'Please log in.'], 401);
    }
    if ($uid !== OWNER_USER_ID) {
        respond(['error' => 'Not allowed.'], 403);
    }
}

// Finds the real column names of the categories table, so adding and editing
// categories works even if a column is named slightly differently.
function categoryColumns(PDO $pdo): array {
    static $cols = null;
    if ($cols === null) {
        $cols = [];
        foreach ($pdo->query("SHOW COLUMNS FROM categories") as $row) {
            $cols[strtolower($row['Field'])] = $row['Field'];
        }
    }
    return $cols;
}

function pickColumn(array $cols, array $names): ?string {
    foreach ($names as $n) {
        if (isset($cols[$n])) {
            return $cols[$n];
        }
    }
    return null;
}

// Small key/value table for dashboard settings. Created on first save.
function ensureSettingsTable(PDO $pdo): void {
    $pdo->exec(
        "CREATE TABLE IF NOT EXISTS app_settings (
            user_id INT NOT NULL,
            setting_key VARCHAR(64) NOT NULL,
            setting_value VARCHAR(255) NOT NULL,
            updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
                ON UPDATE CURRENT_TIMESTAMP,
            PRIMARY KEY (user_id, setting_key)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4"
    );
}

// Machine deposits and withdrawals are saved WITHOUT a category.
// This makes sure transactions.category_id is allowed to be empty.
function ensureCategoryNullable(PDO $pdo): void {
    $col = $pdo->query("SHOW COLUMNS FROM transactions LIKE 'category_id'")
               ->fetch(PDO::FETCH_ASSOC);

    if ($col && strtoupper((string)$col['Null']) === 'NO') {
        $pdo->exec(
            "ALTER TABLE transactions MODIFY category_id "
            . $col['Type'] . " NULL DEFAULT NULL"
        );
    }
}

// The saved (hashed) withdraw PIN, or null if it was never changed.
function getStoredPinHash(PDO $pdo): ?string {
    try {
        $s = $pdo->prepare(
            "SELECT setting_value FROM app_settings
             WHERE user_id = ? AND setting_key = 'withdraw_pin_hash'"
        );
        $s->execute([OWNER_USER_ID]);
        $row = $s->fetch(PDO::FETCH_ASSOC);
        return $row ? (string)$row['setting_value'] : null;
    } catch (PDOException $e) {
        return null;   // table does not exist yet
    }
}

function pinMatches(PDO $pdo, string $pin): bool {
    $hash = getStoredPinHash($pdo);
    if ($hash === null) {
        return hash_equals(DEFAULT_PIN, $pin);
    }
    return password_verify($pin, $hash);
}

function readCategoryInput(array $data): array {
    $name = trim((string)($data['name'] ?? ''));
    $icon = trim((string)($data['icon'] ?? ''));
    $color = strtoupper(trim((string)($data['color_hex'] ?? '')));

    if ($name === '' || mb_strlen($name) > 40) {
        respond(['error' => 'Category name must be 1 to 40 characters.'], 400);
    }
    if ($icon === '' || mb_strlen($icon) > 12) {
        respond(['error' => 'Pick an emoji for the category.'], 400);
    }
    if (!preg_match('/^#[0-9A-F]{6}$/', $color)) {
        $color = '#20243A';
    }

    return [$name, $icon, $color];
}

try {
    if ($_SERVER['REQUEST_METHOD'] === 'GET') {
        requireOwnerSession();

        $stmt = $pdo->prepare(
            "SELECT transaction_id, category_id, type, amount, note,
                    source, status, expires_at, decided_at, cancel_reason,
                    transaction_date, created_at, updated_at,
                    TIMESTAMPDIFF(SECOND, created_at, NOW()) AS age_seconds
             FROM transactions
             WHERE user_id = ?
             ORDER BY transaction_date DESC, transaction_id DESC
             LIMIT 500"
        );
        $stmt->execute([OWNER_USER_ID]);
        $transactions = $stmt->fetchAll();

        // Categories for the edit window.
        // If this query fails, the dashboard still works without categories.
        $categories = [];
        try {
            $c = $pdo->prepare(
                "SELECT * FROM categories
                 WHERE user_id = ? AND is_active = 1
                 ORDER BY category_id ASC"
            );
            $c->execute([OWNER_USER_ID]);
            $categories = $c->fetchAll();
        } catch (PDOException $e) {
            error_log($e->getMessage());
        }

        // Saved dashboard settings (the table does not exist until the first save).
        // The PIN is never sent to the browser.
        $settings = [];
        try {
            $s = $pdo->prepare(
                "SELECT setting_key, setting_value FROM app_settings WHERE user_id = ?"
            );
            $s->execute([OWNER_USER_ID]);
            foreach ($s->fetchAll() as $row) {
                if ($row['setting_key'] === 'withdrawal_approval_seconds') {
                    $settings[$row['setting_key']] = $row['setting_value'];
                }
            }
        } catch (PDOException $e) {
            // no settings saved yet
        }

        respond([
            'transactions' => $transactions,
            'categories' => $categories,
            'settings' => (object)$settings
        ]);
    }

    if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
        header('Allow: GET, POST');
        respond(['error' => 'Method not allowed.'], 405);
    }

    $data = readJson();
    $action = $data['action'] ?? '';

    // Everything the website does needs a signed-in session.
    $websiteActions = [
        'decide_withdrawal', 'update_transaction', 'update_note',
        'create_category', 'update_category', 'update_setting', 'change_pin'
    ];
    if (in_array($action, $websiteActions, true)) {
        requireOwnerSession();
    }

    // ESP32: create a transaction.
    // Deposits complete immediately; withdrawals start as pending.
    // Neither gets a category: you choose one later on the website.
    if ($action === 'machine_transaction') {
        requireMachineKey();

        $type = $data['type'] ?? '';
        $amount = filter_var($data['amount'] ?? null, FILTER_VALIDATE_FLOAT);
        $note = trim((string)($data['note'] ?? ''));

        if (!in_array($type, ['Deposit', 'Withdraw'], true)) {
            respond(['error' => 'Invalid transaction type.'], 400);
        }

        if ($amount === false || $amount <= 0 || !is_finite((float)$amount)) {
            respond(['error' => 'Invalid amount.'], 400);
        }

        if (mb_strlen($note) > 255) {
            respond(['error' => 'Note is too long.'], 400);
        }

        try {
            ensureCategoryNullable($pdo);
        } catch (PDOException $e) {
            error_log($e->getMessage());
            respond([
                'error' => 'transactions.category_id must allow NULL. Run: ALTER TABLE transactions MODIFY category_id INT NULL;'
            ], 500);
        }

        $status = ($type === 'Withdraw') ? 'pending' : 'completed';

        $stmt = $pdo->prepare(
            "INSERT INTO transactions
             (user_id, category_id, type, amount, note, source, status,
              transaction_date, created_at, updated_at)
             VALUES (?, NULL, ?, ?, ?, 'keypad', ?, NOW(), NOW(), NOW())"
        );

        $stmt->execute([
            OWNER_USER_ID,
            $type,
            number_format((float)$amount, 2, '.', ''),
            $note !== '' ? $note : null,
            $status
        ]);

        respond([
            'success' => true,
            'transaction_id' => (int)$pdo->lastInsertId(),
            'status' => $status,
            'message' => 'Transaction created.'
        ], 201);
    }

    // ESP32: check the withdraw PIN typed on the keypad.
    if ($action === 'verify_pin') {
        requireMachineKey();

        $pin = (string)($data['pin'] ?? '');
        $valid = preg_match('/^\d{1,16}$/', $pin) === 1 && pinMatches($pdo, $pin);

        if (!$valid) {
            usleep(400000);   // slows down guessing
        }

        respond(['success' => true, 'valid' => $valid]);
    }

    // ESP32: check the status of one exact withdrawal request.
    if ($action === 'withdrawal_status') {
        requireMachineKey();

        $id = filter_var(
            $data['transaction_id'] ?? null,
            FILTER_VALIDATE_INT
        );

        if (!$id || $id < 1) {
            respond(['error' => 'Invalid transaction ID.'], 400);
        }

        $stmt = $pdo->prepare(
            "SELECT status FROM transactions
             WHERE transaction_id = ? AND user_id = ? AND type = 'Withdraw'
             LIMIT 1"
        );
        $stmt->execute([$id, OWNER_USER_ID]);
        $tx = $stmt->fetch();

        if (!$tx) {
            respond(['error' => 'Withdrawal request not found.'], 404);
        }

        respond(['success' => true, 'status' => $tx['status']]);
    }

    // Website: approve, reject or expire a pending withdrawal.
    if ($action === 'decide_withdrawal') {
        $id = filter_var(
            $data['transaction_id'] ?? null,
            FILTER_VALIDATE_INT
        );
        $decision = $data['decision'] ?? '';
        $reason = trim((string)($data['reason'] ?? ''));

        if (!$id || $id < 1 ||
            !in_array($decision, ['approve', 'reject', 'expire'], true)) {
            respond(['error' => 'Invalid request.'], 400);
        }

        $newStatus = ($decision === 'approve') ? 'approved' : 'cancelled';

        $cancelReason = null;
        if ($decision === 'expire') {
            $cancelReason = 'Expired';
        } elseif ($decision === 'reject' && $reason !== '') {
            $cancelReason = mb_substr($reason, 0, 255);
        }

        $stmt = $pdo->prepare(
            "UPDATE transactions
             SET status = ?, cancel_reason = ?,
                 decided_at = NOW(), updated_at = NOW()
             WHERE transaction_id = ? AND user_id = ?
               AND type = 'Withdraw' AND status = 'pending'"
        );
        $stmt->execute([$newStatus, $cancelReason, $id, OWNER_USER_ID]);

        if ($stmt->rowCount() !== 1) {
            respond([
                'error' => 'Request was already decided or was not found.'
            ], 409);
        }

        respond([
            'success' => true,
            'status' => $newStatus,
            'message' => 'Withdrawal ' . $newStatus . '.'
        ]);
    }

    // ESP32: mark an approved withdrawal completed after claiming.
    if ($action === 'complete_withdrawal') {
        requireMachineKey();

        $id = filter_var(
            $data['transaction_id'] ?? null,
            FILTER_VALIDATE_INT
        );

        if (!$id || $id < 1) {
            respond(['error' => 'Invalid transaction ID.'], 400);
        }

        $stmt = $pdo->prepare(
            "UPDATE transactions
             SET status = 'completed', updated_at = NOW()
             WHERE transaction_id = ? AND user_id = ?
               AND type = 'Withdraw' AND status = 'approved'"
        );
        $stmt->execute([$id, OWNER_USER_ID]);

        if ($stmt->rowCount() === 1) {
            respond(['success' => true, 'status' => 'completed']);
        }

        // Make retries safe if the database already says completed.
        $check = $pdo->prepare(
            "SELECT status FROM transactions
             WHERE transaction_id = ? AND user_id = ?
               AND type = 'Withdraw'"
        );
        $check->execute([$id, OWNER_USER_ID]);
        $tx = $check->fetch();

        if ($tx && $tx['status'] === 'completed') {
            respond(['success' => true, 'status' => 'completed']);
        }

        respond(['error' => 'Withdrawal is not approved.'], 409);
    }

    // Website: change the withdraw PIN (needs the current PIN).
    if ($action === 'change_pin') {
        $current = (string)($data['current_pin'] ?? '');
        $new = (string)($data['new_pin'] ?? '');

        if (preg_match('/^\d{4,8}$/', $new) !== 1) {
            respond(['error' => 'The new PIN must be 4 to 8 digits.'], 400);
        }

        if (!pinMatches($pdo, $current)) {
            usleep(400000);
            respond(['error' => 'Current PIN is wrong.'], 403);
        }

        ensureSettingsTable($pdo);
        $pdo->prepare(
            "INSERT INTO app_settings (user_id, setting_key, setting_value)
             VALUES (?, 'withdraw_pin_hash', ?)
             ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value)"
        )->execute([OWNER_USER_ID, password_hash($new, PASSWORD_DEFAULT)]);

        respond(['success' => true, 'message' => 'PIN changed.']);
    }

    // Website: save a dashboard setting.
    if ($action === 'update_setting') {
        $key = (string)($data['key'] ?? '');
        $value = filter_var($data['value'] ?? null, FILTER_VALIDATE_INT);

        // allowed settings and their min/max
        $rules = ['withdrawal_approval_seconds' => [10, 300]];

        if (!isset($rules[$key])) {
            respond(['error' => 'Unknown setting.'], 400);
        }

        [$min, $max] = $rules[$key];
        if ($value === false || $value < $min || $value > $max) {
            respond(['error' => "Value must be between $min and $max."], 400);
        }

        ensureSettingsTable($pdo);
        $pdo->prepare(
            "INSERT INTO app_settings (user_id, setting_key, setting_value)
             VALUES (?, ?, ?)
             ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value)"
        )->execute([OWNER_USER_ID, $key, (string)$value]);

        respond(['success' => true, 'message' => 'Setting saved.']);
    }

    // Website: add a new category.
    if ($action === 'create_category') {
        [$name, $icon, $color] = readCategoryInput($data);
        $type = $data['type'] ?? '';

        if (!in_array($type, ['Deposit', 'Withdraw'], true)) {
            respond(['error' => 'Invalid category type.'], 400);
        }

        $cols = categoryColumns($pdo);
        $nameCol = pickColumn($cols, ['name', 'category_name', 'title']);
        $iconCol = pickColumn($cols, ['icon', 'emoji']);
        $colorCol = pickColumn($cols, ['color_hex', 'color']);

        if (!$nameCol || !$iconCol) {
            respond(['error' => 'The categories table needs a name column and an icon column.'], 500);
        }

        $dup = $pdo->prepare(
            "SELECT category_id FROM categories
             WHERE user_id = ? AND type = ? AND is_active = 1
               AND LOWER(`$nameCol`) = LOWER(?) LIMIT 1"
        );
        $dup->execute([OWNER_USER_ID, $type, $name]);
        if ($dup->fetch()) {
            respond(['error' => 'That category already exists.'], 409);
        }

        // placeholders are listed in the same order as their values
        $fields = ['user_id' => '?', 'type' => '?', $nameCol => '?', $iconCol => '?'];
        $values = [OWNER_USER_ID, $type, $name, $icon];

        if ($colorCol) {
            $fields[$colorCol] = '?';
            $values[] = $color;
        }
        if (isset($cols['is_active']))  { $fields[$cols['is_active']] = '1'; }
        if (isset($cols['is_default'])) { $fields[$cols['is_default']] = '0'; }
        if (isset($cols['created_at'])) { $fields[$cols['created_at']] = 'NOW()'; }
        if (isset($cols['updated_at'])) { $fields[$cols['updated_at']] = 'NOW()'; }

        $sql = "INSERT INTO categories ("
             . implode(', ', array_map(fn($c) => "`$c`", array_keys($fields)))
             . ") VALUES (" . implode(', ', array_values($fields)) . ")";

        try {
            $pdo->prepare($sql)->execute($values);
        } catch (PDOException $e) {
            error_log($e->getMessage());
            respond(['error' => 'Could not save the category. Check the PHP error log (the emoji may need a utf8mb4 column).'], 500);
        }

        respond([
            'success' => true,
            'category_id' => (int)$pdo->lastInsertId(),
            'message' => 'Category added.'
        ], 201);
    }

    // Website: change a category's name, emoji and color. Its type never changes.
    if ($action === 'update_category') {
        $id = filter_var($data['category_id'] ?? null, FILTER_VALIDATE_INT);
        if (!$id || $id < 1) {
            respond(['error' => 'Invalid category ID.'], 400);
        }

        [$name, $icon, $color] = readCategoryInput($data);

        $cols = categoryColumns($pdo);
        $nameCol = pickColumn($cols, ['name', 'category_name', 'title']);
        $iconCol = pickColumn($cols, ['icon', 'emoji']);
        $colorCol = pickColumn($cols, ['color_hex', 'color']);

        if (!$nameCol || !$iconCol) {
            respond(['error' => 'The categories table needs a name column and an icon column.'], 500);
        }

        $find = $pdo->prepare(
            "SELECT type FROM categories WHERE category_id = ? AND user_id = ?"
        );
        $find->execute([$id, OWNER_USER_ID]);
        $cat = $find->fetch();

        if (!$cat) {
            respond(['error' => 'Category not found.'], 404);
        }

        $dup = $pdo->prepare(
            "SELECT category_id FROM categories
             WHERE user_id = ? AND type = ? AND is_active = 1
               AND LOWER(`$nameCol`) = LOWER(?) AND category_id <> ? LIMIT 1"
        );
        $dup->execute([OWNER_USER_ID, $cat['type'], $name, $id]);
        if ($dup->fetch()) {
            respond(['error' => 'Another category already has that name.'], 409);
        }

        $sets = ["`$nameCol` = ?", "`$iconCol` = ?"];
        $values = [$name, $icon];

        if ($colorCol) {
            $sets[] = "`$colorCol` = ?";
            $values[] = $color;
        }
        if (isset($cols['updated_at'])) {
            $sets[] = "`" . $cols['updated_at'] . "` = NOW()";
        }

        $values[] = $id;
        $values[] = OWNER_USER_ID;

        try {
            $pdo->prepare(
                "UPDATE categories SET " . implode(', ', $sets) .
                " WHERE category_id = ? AND user_id = ?"
            )->execute($values);
        } catch (PDOException $e) {
            error_log($e->getMessage());
            respond(['error' => 'Could not save the category. Check the PHP error log (the emoji may need a utf8mb4 column).'], 500);
        }

        respond(['success' => true, 'message' => 'Category updated.']);
    }

    // Website: edit the category and note of a transaction.
    // The amount and type are never changed here.
    if ($action === 'update_transaction') {
        $id = filter_var($data['transaction_id'] ?? null, FILTER_VALIDATE_INT);
        $note = trim((string)($data['note'] ?? ''));
        $categoryId = filter_var($data['category_id'] ?? null, FILTER_VALIDATE_INT);

        if (!$id || $id < 1 || mb_strlen($note) > 255) {
            respond(['error' => 'Invalid transaction ID or note.'], 400);
        }

        $find = $pdo->prepare(
            "SELECT type, category_id FROM transactions
             WHERE transaction_id = ? AND user_id = ?"
        );
        $find->execute([$id, OWNER_USER_ID]);
        $tx = $find->fetch();

        if (!$tx) {
            respond(['error' => 'Transaction not found.'], 404);
        }

        if ($categoryId) {
            $check = $pdo->prepare(
                "SELECT category_id FROM categories
                 WHERE category_id = ? AND user_id = ?
                   AND is_active = 1 AND type = ?"
            );
            $check->execute([$categoryId, OWNER_USER_ID, $tx['type']]);
            if (!$check->fetch()) {
                respond(['error' => 'Invalid category.'], 400);
            }
        } else {
            // no category chosen: keep whatever it has now (possibly none)
            $categoryId = $tx['category_id'] !== null ? (int)$tx['category_id'] : null;
        }

        $stmt = $pdo->prepare(
            "UPDATE transactions
             SET category_id = ?, note = ?, updated_at = NOW()
             WHERE transaction_id = ? AND user_id = ?"
        );
        $stmt->execute([
            $categoryId,
            $note !== '' ? $note : null,
            $id,
            OWNER_USER_ID
        ]);

        respond(['success' => true, 'message' => 'Transaction updated.']);
    }

    // Existing website note-editing feature.
    if ($action === 'update_note') {
        $id = filter_var(
            $data['transaction_id'] ?? null,
            FILTER_VALIDATE_INT
        );
        $note = trim((string)($data['note'] ?? ''));

        if (!$id || $id < 1 || mb_strlen($note) > 255) {
            respond(['error' => 'Invalid transaction ID or note.'], 400);
        }

        $stmt = $pdo->prepare(
            "UPDATE transactions SET note = ?, updated_at = NOW()
             WHERE transaction_id = ? AND user_id = ?"
        );
        $stmt->execute([$note !== '' ? $note : null, $id, OWNER_USER_ID]);

        if ($stmt->rowCount() === 0) {
            $check = $pdo->prepare(
                "SELECT transaction_id FROM transactions
                 WHERE transaction_id = ? AND user_id = ?"
            );
            $check->execute([$id, OWNER_USER_ID]);
            if (!$check->fetch()) {
                respond(['error' => 'Transaction not found.'], 404);
            }
        }

        respond(['success' => true, 'message' => 'Note updated.']);
    }

    respond(['error' => 'Unknown action.'], 400);

} catch (PDOException $e) {
    error_log($e->getMessage());
    respond(['error' => 'Database operation failed. Check PHP error log and schema.'], 500);
}