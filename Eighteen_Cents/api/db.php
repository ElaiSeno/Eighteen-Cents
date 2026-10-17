<?php
declare(strict_types=1);
$host = 'localhost';
$dbname = 'piggybank_db'; // Change to your exact phpMyAdmin database name
$username = 'root';
$password = 'LucidDreamz7801'; // Change if your MySQL has a password
try {
    $pdo = new PDO("mysql:host=$host;dbname=$dbname;charset=utf8mb4", $username, $password, [
        PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
        PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
        PDO::ATTR_EMULATE_PREPARES => false
    ]);
} catch (PDOException $e) {
    error_log($e->getMessage());
    http_response_code(500);
    header('Content-Type: application/json; charset=utf-8');
    echo json_encode(['error' => 'Database connection failed. Check api/db.php settings.']);
    exit;
}