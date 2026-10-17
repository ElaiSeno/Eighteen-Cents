<?php
declare(strict_types=1);

// Shared login/session helpers.
// Put this file in the "api" folder (Eighteen_Cents/api/auth.php).

function app_session_start(bool $readOnly = false): void {
    if (session_status() === PHP_SESSION_ACTIVE) {
        return;
    }

    ini_set('session.gc_maxlifetime', '28800');   // signed in for up to 8 hours
    session_name('EIGHTEEN_SESSION');
    session_set_cookie_params([
        'lifetime' => 0,          // until the browser closes
        'path'     => '/',
        'httponly' => true,
        'samesite' => 'Lax'
    ]);

    // read_and_close lets the dashboard poll without the session file being locked
    session_start($readOnly ? ['read_and_close' => true] : []);
}

// The logged-in user's ID, or null when nobody is signed in.
function logged_in_user_id(): ?int {
    app_session_start(true);
    return isset($_SESSION['user_id']) ? (int)$_SESSION['user_id'] : null;
}

// Checks the email and password against the users table.
// Returns the user's ID, or null if they are wrong.
function attempt_login(PDO $pdo, string $email, string $password): ?int {
    if ($email === '' || $password === '') {
        return null;
    }

    try {
        $cols = [];
        foreach ($pdo->query("SHOW COLUMNS FROM users") as $row) {
            $cols[strtolower($row['Field'])] = $row['Field'];
        }

        $pick = function (array $names) use ($cols): ?string {
            foreach ($names as $n) {
                if (isset($cols[$n])) {
                    return $cols[$n];
                }
            }
            return null;
        };

        $idCol    = $pick(['user_id', 'id']);
        $emailCol = $pick(['email']);
        $passCol  = $pick(['password_hash', 'password', 'pass_hash', 'passwd']);

        if (!$idCol || !$emailCol || !$passCol) {
            error_log('Login: the users table needs an id, email and password column.');
            return null;
        }

        $stmt = $pdo->prepare(
            "SELECT `$idCol` AS uid, `$passCol` AS pw
             FROM users WHERE `$emailCol` = ? LIMIT 1"
        );
        $stmt->execute([$email]);
        $user = $stmt->fetch();

        if (!$user) {
            usleep(400000);
            return null;
        }

        $stored = (string)$user['pw'];
        $looksHashed = preg_match('/^\$(2[aby]|argon2i|argon2id)\$/', $stored) === 1;

        if ($looksHashed) {
            $ok = password_verify($password, $stored);
        } else {
            // Old plain-text password: accept it once, then store a safe hash instead.
            $ok = hash_equals($stored, $password);
            if ($ok) {
                try {
                    $up = $pdo->prepare("UPDATE users SET `$passCol` = ? WHERE `$idCol` = ?");
                    $up->execute([password_hash($password, PASSWORD_DEFAULT), $user['uid']]);
                } catch (PDOException $e) {
                    error_log($e->getMessage());
                }
            }
        }

        if (!$ok) {
            usleep(400000);
            return null;
        }

        return (int)$user['uid'];

    } catch (PDOException $e) {
        error_log($e->getMessage());
        return null;
    }
}
