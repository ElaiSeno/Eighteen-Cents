<?php
declare(strict_types=1);

require_once __DIR__ . '/api/db.php';
require_once __DIR__ . '/api/auth.php';

// Already signed in? Go straight to the dashboard.
if (logged_in_user_id() !== null) {
    header('Location: dashboard.php');
    exit;
}

$error = '';
$email = '';

if ($_SERVER['REQUEST_METHOD'] === 'POST') {
    $email = trim((string)($_POST['email'] ?? ''));
    $password = (string)($_POST['password'] ?? '');

    $userId = attempt_login($pdo, $email, $password);

    if ($userId !== null) {
        app_session_start(false);
        session_regenerate_id(true);
        $_SESSION['user_id'] = $userId;

        header('Location: dashboard.php');
        exit;
    }

    $error = 'Wrong email or password.';
}
?>
<!DOCTYPE html>
<html lang="en">

<head>

    <meta charset="UTF-8">

    <meta name="viewport"
          content="width=device-width, initial-scale=1.0">

    <title>Eighteen Cents - Login Form</title>

    <link rel="stylesheet"
          href="Assets/CSS/background.css">

    <link rel="stylesheet"
          href="Assets/CSS/login.css">

</head>

<body>

    <div class="wrapper">

        <div class="login-wrap">

            <div class="login-form">

                <div class="login-header">
                    <h2>Welcome Back</h2>
                    <p>Login to your Eighteen Cents account</p>
                </div>

                <?php if ($error !== ''): ?>
                    <p role="alert"
                       style="margin:0 0 12px;padding:10px 12px;border-radius:12px;background:rgba(244,79,29,.14);color:#F44F1D;font-size:13px;font-weight:600;text-align:center">
                        <?= htmlspecialchars($error, ENT_QUOTES, 'UTF-8') ?>
                    </p>
                <?php endif; ?>

                <form id="login-form" method="post" action="Login.php">
                    <!-- EMAIL -->
                    <div class="input-group">
                        <label for="email">
                            Email
                        </label>
                        <input
                            type="email"
                            id="email"
                            name="email"
                            placeholder="example@gmail.com"
                            value="<?= htmlspecialchars($email, ENT_QUOTES, 'UTF-8') ?>"
                            required
                        >
                    </div>
                    <!-- PASSWORD -->
                    <div class="input-group">

                        <label for="password">
                            Password
                        </label>

                        <input
                            type="password"
                            id="password"
                            name="password"
                            placeholder="Password"
                            required
                        >
                    </div>
                    <!-- LOGIN BUTTON -->
                    <button
                        type="submit"
                        class="login-button"
                    >
                        Login
                    </button>
                </form>
            </div>
        </div>
    </div>


    <script src="Assets/Js/background-load.js"></script>

</body>

</html>