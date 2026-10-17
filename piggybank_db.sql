-- phpMyAdmin SQL Dump
-- version 5.2.0
-- https://www.phpmyadmin.net/
--
-- Host: 127.0.0.1:3306
-- Generation Time: Oct 17, 2026 at 07:48 AM
-- Server version: 8.0.30
-- PHP Version: 8.2.0

SET SQL_MODE = "NO_AUTO_VALUE_ON_ZERO";
START TRANSACTION;
SET time_zone = "+00:00";


/*!40101 SET @OLD_CHARACTER_SET_CLIENT=@@CHARACTER_SET_CLIENT */;
/*!40101 SET @OLD_CHARACTER_SET_RESULTS=@@CHARACTER_SET_RESULTS */;
/*!40101 SET @OLD_COLLATION_CONNECTION=@@COLLATION_CONNECTION */;
/*!40101 SET NAMES utf8mb4 */;

--
-- Database: `piggybank_db`
--

DELIMITER $$
--
-- Procedures
--
DROP PROCEDURE IF EXISTS `sp_approve_withdrawal`$$
CREATE DEFINER=`root`@`localhost` PROCEDURE `sp_approve_withdrawal` (IN `p_transaction_id` INT UNSIGNED, IN `p_category_id` INT UNSIGNED)   BEGIN
  DECLARE v_status  VARCHAR(10);
  DECLARE v_expires DATETIME;
  DECLARE v_user_id INT UNSIGNED;

  SELECT status, expires_at, user_id INTO v_status, v_expires, v_user_id
  FROM transactions
  WHERE transaction_id = p_transaction_id AND type = 'withdraw'
  FOR UPDATE;

  IF v_status IS NULL THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Withdrawal not found.';
  END IF;

  IF v_status <> 'pending' THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'This withdrawal is no longer pending.';
  END IF;

  IF v_expires < NOW() THEN
    CALL sp_expire_pending_withdrawals();
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'This request expired. Please start again at the machine.';
  END IF;

  UPDATE transactions
  SET status           = 'completed',
      decided_at       = NOW(),
      transaction_date = NOW(),
      category_id      = COALESCE(p_category_id, category_id)
  WHERE transaction_id = p_transaction_id;

  INSERT INTO access_logs (user_id, transaction_id, event_type, details)
  VALUES (v_user_id, p_transaction_id, 'withdraw_approved', 'Owner approved on the website');

  SELECT servo_open_seconds AS open_seconds
  FROM user_settings WHERE user_id = v_user_id;
END$$

DROP PROCEDURE IF EXISTS `sp_expire_pending_withdrawals`$$
CREATE DEFINER=`root`@`localhost` PROCEDURE `sp_expire_pending_withdrawals` ()   BEGIN
  INSERT INTO access_logs (user_id, transaction_id, event_type, details)
  SELECT user_id, transaction_id, 'withdraw_expired', 'No answer within the time limit'
  FROM transactions
  WHERE status = 'pending' AND expires_at < NOW();

  UPDATE transactions
  SET status = 'cancelled', cancel_reason = 'timeout', decided_at = NOW()
  WHERE status = 'pending' AND expires_at < NOW();
END$$

DROP PROCEDURE IF EXISTS `sp_monthly_report`$$
CREATE DEFINER=`root`@`localhost` PROCEDURE `sp_monthly_report` (IN `p_year` SMALLINT, IN `p_month` TINYINT)   BEGIN
  DECLARE v_user_id  INT UNSIGNED;
  DECLARE v_start    DATE;
  DECLARE v_end      DATE;
  DECLARE v_open     DECIMAL(14,2);
  DECLARE v_income   DECIMAL(14,2);
  DECLARE v_expenses DECIMAL(14,2);
  DECLARE v_budget   DECIMAL(12,2);

  SELECT user_id INTO v_user_id FROM users LIMIT 1;
  SET v_start = STR_TO_DATE(CONCAT(p_year, '-', p_month, '-01'), '%Y-%m-%d');
  SET v_end   = v_start + INTERVAL 1 MONTH;

  SELECT COALESCE(SUM(CASE WHEN type = 'deposit' THEN amount ELSE -amount END), 0)
    INTO v_open
  FROM transactions
  WHERE user_id = v_user_id AND status = 'completed' AND transaction_date < v_start;

  SELECT COALESCE(SUM(CASE WHEN type = 'deposit'  THEN amount END), 0),
         COALESCE(SUM(CASE WHEN type = 'withdraw' THEN amount END), 0)
    INTO v_income, v_expenses
  FROM transactions
  WHERE user_id = v_user_id AND status = 'completed'
    AND transaction_date >= v_start AND transaction_date < v_end;

  SELECT monthly_budget INTO v_budget FROM user_settings WHERE user_id = v_user_id;

  -- 1) Totals
  SELECT v_start                        AS month_start,
         v_open                         AS opening_balance,
         v_income                       AS income,
         v_expenses                     AS expenses,
         v_open + v_income - v_expenses AS closing_balance,
         v_budget                       AS monthly_budget,
         IF(v_budget IS NULL OR v_budget = 0, NULL,
            ROUND(v_expenses / v_budget * 100, 1)) AS budget_used_pct;

  -- 2) By category
  SELECT t.type, c.name AS category_name, c.color_hex,
         COUNT(*) AS transaction_count, SUM(t.amount) AS total_amount
  FROM transactions t
  JOIN categories c ON c.category_id = t.category_id
  WHERE t.user_id = v_user_id AND t.status = 'completed'
    AND t.transaction_date >= v_start AND t.transaction_date < v_end
  GROUP BY t.type, c.name, c.color_hex
  ORDER BY t.type, total_amount DESC;

  -- 3) Every transaction that month
  SELECT t.transaction_id, t.transaction_date, t.type, t.amount,
         c.name AS category_name, t.note
  FROM transactions t
  JOIN categories c ON c.category_id = t.category_id
  WHERE t.user_id = v_user_id AND t.status = 'completed'
    AND t.transaction_date >= v_start AND t.transaction_date < v_end
  ORDER BY t.transaction_date;
END$$

DROP PROCEDURE IF EXISTS `sp_record_deposit`$$
CREATE DEFINER=`root`@`localhost` PROCEDURE `sp_record_deposit` (IN `p_amount` DECIMAL(12,2))   BEGIN
  DECLARE v_user_id INT UNSIGNED;

  SELECT user_id INTO v_user_id FROM users LIMIT 1;
  IF v_user_id IS NULL THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'No user account exists yet.';
  END IF;

  INSERT INTO transactions (user_id, type, amount, source, status)
  VALUES (v_user_id, 'deposit', p_amount, 'keypad', 'completed');

  SELECT LAST_INSERT_ID() AS transaction_id;
END$$

DROP PROCEDURE IF EXISTS `sp_reject_withdrawal`$$
CREATE DEFINER=`root`@`localhost` PROCEDURE `sp_reject_withdrawal` (IN `p_transaction_id` INT UNSIGNED)   BEGIN
  DECLARE v_user_id INT UNSIGNED;

  SELECT user_id INTO v_user_id
  FROM transactions WHERE transaction_id = p_transaction_id;

  UPDATE transactions
  SET status = 'cancelled', cancel_reason = 'rejected', decided_at = NOW()
  WHERE transaction_id = p_transaction_id AND type = 'withdraw' AND status = 'pending';

  IF ROW_COUNT() = 0 THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'No pending withdrawal with that id.';
  END IF;

  INSERT INTO access_logs (user_id, transaction_id, event_type, details)
  VALUES (v_user_id, p_transaction_id, 'withdraw_rejected', 'Owner rejected on the website');
END$$

DROP PROCEDURE IF EXISTS `sp_request_withdrawal`$$
CREATE DEFINER=`root`@`localhost` PROCEDURE `sp_request_withdrawal` (IN `p_amount` DECIMAL(12,2))   BEGIN
  DECLARE v_user_id INT UNSIGNED;
  DECLARE v_seconds SMALLINT UNSIGNED;
  DECLARE v_tx_id   INT UNSIGNED;
  DECLARE v_expires DATETIME;

  SELECT user_id INTO v_user_id FROM users LIMIT 1;
  IF v_user_id IS NULL THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'No user account exists yet.';
  END IF;

  CALL sp_expire_pending_withdrawals();

  IF EXISTS (SELECT 1 FROM transactions
             WHERE user_id = v_user_id AND type = 'withdraw' AND status = 'pending') THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'A withdrawal is already waiting for approval.';
  END IF;

  SELECT withdraw_approval_seconds INTO v_seconds
  FROM user_settings WHERE user_id = v_user_id;

  SET v_expires = NOW() + INTERVAL v_seconds SECOND;

  INSERT INTO transactions (user_id, type, amount, source, status, expires_at)
  VALUES (v_user_id, 'withdraw', p_amount, 'keypad', 'pending', v_expires);

  SET v_tx_id = LAST_INSERT_ID();

  INSERT INTO access_logs (user_id, transaction_id, event_type, details)
  VALUES (v_user_id, v_tx_id, 'withdraw_requested', 'Waiting for owner approval');

  INSERT INTO notifications (user_id, type, message)
  VALUES (v_user_id, 'withdraw_request',
          CONCAT('Withdrawal request of ', FORMAT(p_amount, 2), ' is waiting for your approval.'));

  SELECT v_tx_id AS transaction_id, v_expires AS expires_at;
END$$

DELIMITER ;

-- --------------------------------------------------------

--
-- Table structure for table `access_logs`
--

DROP TABLE IF EXISTS `access_logs`;
CREATE TABLE IF NOT EXISTS `access_logs` (
  `log_id` int UNSIGNED NOT NULL AUTO_INCREMENT,
  `user_id` int UNSIGNED NOT NULL,
  `transaction_id` int UNSIGNED DEFAULT NULL,
  `event_type` enum('pin_success','pin_failed','lockout','box_opened','box_closed','withdraw_requested','withdraw_approved','withdraw_rejected','withdraw_expired') COLLATE utf8mb4_unicode_ci NOT NULL,
  `event_time` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `details` varchar(255) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  PRIMARY KEY (`log_id`),
  KEY `idx_log_user_time` (`user_id`,`event_time`),
  KEY `idx_log_tx` (`transaction_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- --------------------------------------------------------

--
-- Table structure for table `categories`
--

DROP TABLE IF EXISTS `categories`;
CREATE TABLE IF NOT EXISTS `categories` (
  `category_id` int UNSIGNED NOT NULL AUTO_INCREMENT,
  `user_id` int UNSIGNED NOT NULL,
  `name` varchar(50) COLLATE utf8mb4_unicode_ci NOT NULL,
  `type` enum('deposit','withdraw') COLLATE utf8mb4_unicode_ci NOT NULL,
  `color_hex` char(7) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `icon` varchar(30) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `is_default` tinyint(1) NOT NULL DEFAULT '0' COMMENT 'Seeded categories; Uncategorized cannot be removed',
  `is_active` tinyint(1) NOT NULL DEFAULT '1' COMMENT 'Soft delete: keeps old transactions intact',
  `created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`category_id`),
  UNIQUE KEY `uq_category_user_name_type` (`user_id`,`name`,`type`),
  KEY `idx_category_user_type` (`user_id`,`type`,`is_active`)
) ;

--
-- Dumping data for table `categories`
--

INSERT INTO `categories` (`category_id`, `user_id`, `name`, `type`, `color_hex`, `icon`, `is_default`, `is_active`, `created_at`) VALUES
(1, 1, 'Scholarship', 'deposit', '#12915F', '🏫', 1, 1, '2026-10-08 19:57:35'),
(2, 1, 'Baon', 'deposit', '#F2A413', '🤲', 1, 1, '2026-10-08 19:57:35'),
(3, 1, 'Salary', 'deposit', '#12915F', '💰', 1, 1, '2026-10-08 19:57:35'),
(4, 1, 'Part-time', 'deposit', '#26A69A', '💻', 1, 1, '2026-10-08 19:57:35'),
(5, 1, 'Others', 'deposit', '#78909C', '💬', 1, 1, '2026-10-08 19:57:35'),
(6, 1, 'Uncategorized', 'deposit', '#9E9E9E', '❓', 1, 1, '2026-10-08 19:57:35'),
(7, 1, 'Family', 'withdraw', '#12915F', '🏠', 1, 1, '2026-10-08 19:57:35'),
(8, 1, 'Medicine', 'withdraw', '#D81B60', '💊', 1, 1, '2026-10-08 19:57:35'),
(9, 1, 'Shopping', 'withdraw', '#E91E63', '🛍️', 1, 1, '2026-10-08 19:57:35'),
(10, 1, 'Food', 'withdraw', '#FB8C00', '🍱', 1, 1, '2026-10-08 19:57:35'),
(11, 1, 'Entertainment', 'withdraw', '#3949AB', '🎮', 1, 1, '2026-10-08 19:57:35'),
(12, 1, 'Education', 'withdraw', '#1E88E5', '👨🏻‍🎓', 1, 1, '2026-10-08 19:57:35'),
(13, 1, 'Others', 'withdraw', '#78909C', '💬', 1, 1, '2026-10-08 19:57:35'),
(14, 1, 'Uncategorized', 'withdraw', '#9E9E9E', '❓', 1, 1, '2026-10-08 19:57:35');

--
-- Triggers `categories`
--
DROP TRIGGER IF EXISTS `trg_categories_before_delete`;
DELIMITER $$
CREATE TRIGGER `trg_categories_before_delete` BEFORE DELETE ON `categories` FOR EACH ROW BEGIN
  IF OLD.is_default = TRUE AND OLD.name = 'Uncategorized' THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'The Uncategorized category cannot be deleted.';
  END IF;
END
$$
DELIMITER ;
DROP TRIGGER IF EXISTS `trg_categories_before_update`;
DELIMITER $$
CREATE TRIGGER `trg_categories_before_update` BEFORE UPDATE ON `categories` FOR EACH ROW BEGIN
  IF OLD.name = 'Uncategorized' AND OLD.is_default = TRUE
     AND (NEW.is_active = FALSE OR NEW.name <> OLD.name OR NEW.type <> OLD.type) THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'The Uncategorized category cannot be renamed or deactivated.';
  END IF;
END
$$
DELIMITER ;

-- --------------------------------------------------------

--
-- Table structure for table `notifications`
--

DROP TABLE IF EXISTS `notifications`;
CREATE TABLE IF NOT EXISTS `notifications` (
  `notification_id` int UNSIGNED NOT NULL AUTO_INCREMENT,
  `user_id` int UNSIGNED NOT NULL,
  `type` enum('low_balance','budget_exceeded','goal_reached','failed_pin','withdraw_request') COLLATE utf8mb4_unicode_ci NOT NULL,
  `message` varchar(255) COLLATE utf8mb4_unicode_ci NOT NULL,
  `is_read` tinyint(1) NOT NULL DEFAULT '0',
  `created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`notification_id`),
  KEY `idx_notif_user_read` (`user_id`,`is_read`,`created_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- --------------------------------------------------------

--
-- Table structure for table `savings_goals`
--

DROP TABLE IF EXISTS `savings_goals`;
CREATE TABLE IF NOT EXISTS `savings_goals` (
  `goal_id` int UNSIGNED NOT NULL AUTO_INCREMENT,
  `user_id` int UNSIGNED NOT NULL,
  `goal_name` varchar(100) COLLATE utf8mb4_unicode_ci NOT NULL,
  `target_amount` decimal(12,2) NOT NULL,
  `saved_amount` decimal(12,2) NOT NULL DEFAULT '0.00',
  `target_date` date DEFAULT NULL,
  `status` enum('active','achieved','cancelled') COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'active',
  `created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`goal_id`),
  KEY `idx_goal_user_status` (`user_id`,`status`)
) ;

-- --------------------------------------------------------

--
-- Table structure for table `transactions`
--

DROP TABLE IF EXISTS `transactions`;
CREATE TABLE IF NOT EXISTS `transactions` (
  `transaction_id` int UNSIGNED NOT NULL AUTO_INCREMENT,
  `user_id` int UNSIGNED NOT NULL,
  `category_id` int UNSIGNED DEFAULT NULL COMMENT 'Auto-filled with Uncategorized by trigger when NULL',
  `type` enum('deposit','withdraw') COLLATE utf8mb4_unicode_ci NOT NULL,
  `amount` decimal(12,2) NOT NULL COMMENT 'Always positive; type decides the sign',
  `note` varchar(255) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `source` enum('keypad','web') COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'keypad',
  `status` enum('pending','approved','completed','cancelled','failed') COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'pending',
  `expires_at` datetime DEFAULT NULL COMMENT 'Pending withdrawals auto-cancel after this time',
  `decided_at` datetime DEFAULT NULL COMMENT 'When owner approved/rejected, or when it timed out',
  `cancel_reason` enum('rejected','timeout','other') COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `transaction_date` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`transaction_id`),
  KEY `idx_tx_user_date` (`user_id`,`transaction_date`),
  KEY `idx_tx_category` (`category_id`),
  KEY `idx_tx_user_type_status` (`user_id`,`type`,`status`),
  KEY `idx_tx_status_expiry` (`status`,`expires_at`)
) ;

--
-- Dumping data for table `transactions`
--

INSERT INTO `transactions` (`transaction_id`, `user_id`, `category_id`, `type`, `amount`, `note`, `source`, `status`, `expires_at`, `decided_at`, `cancel_reason`, `transaction_date`, `created_at`, `updated_at`) VALUES
(1, 1, 1, 'deposit', '66.00', NULL, 'keypad', 'completed', NULL, NULL, NULL, '2026-10-13 07:09:02', '2026-10-13 07:09:02', '2026-10-13 07:09:02'),
(2, 1, 1, 'deposit', '88.00', 'Tuition', 'keypad', 'completed', NULL, NULL, NULL, '2026-10-13 07:55:26', '2026-10-13 07:55:26', '2026-10-13 22:35:56'),
(3, 1, 13, 'withdraw', '88.00', NULL, 'keypad', 'approved', NULL, '2026-10-13 18:35:26', NULL, '2026-10-13 07:56:03', '2026-10-13 07:56:03', '2026-10-13 18:46:49'),
(4, 1, 1, 'deposit', '88.00', NULL, 'keypad', 'completed', NULL, NULL, NULL, '2026-10-13 07:59:00', '2026-10-13 07:59:00', '2026-10-13 07:59:00'),
(5, 1, 1, 'deposit', '55.00', NULL, 'keypad', 'completed', NULL, NULL, NULL, '2026-10-13 18:26:12', '2026-10-13 18:26:12', '2026-10-13 18:26:12'),
(6, 1, 7, 'withdraw', '89.00', NULL, 'keypad', 'approved', NULL, '2026-10-13 18:55:01', NULL, '2026-10-13 18:54:55', '2026-10-13 18:54:55', '2026-10-13 18:55:01'),
(7, 1, 14, 'withdraw', '88.00', NULL, 'keypad', 'approved', NULL, '2026-10-13 22:22:42', NULL, '2026-10-13 22:22:39', '2026-10-13 22:22:39', '2026-10-13 22:22:42'),
(8, 1, 6, 'deposit', '55.00', NULL, 'keypad', 'completed', NULL, NULL, NULL, '2026-10-15 08:21:08', '2026-10-15 08:21:08', '2026-10-15 08:21:08'),
(9, 1, 11, 'withdraw', '77.00', 'Top ML', 'keypad', 'approved', NULL, '2026-10-15 08:21:43', NULL, '2026-10-15 08:21:33', '2026-10-15 08:21:33', '2026-10-15 08:25:49'),
(10, 1, 14, 'withdraw', '10.00', NULL, 'keypad', 'pending', NULL, NULL, NULL, '2026-10-15 08:24:40', '2026-10-15 08:24:40', '2026-10-15 08:24:40'),
(11, 1, 6, 'deposit', '711.00', NULL, 'keypad', 'completed', NULL, NULL, NULL, '2026-10-15 08:43:40', '2026-10-15 08:43:40', '2026-10-15 08:43:40'),
(12, 1, 9, 'withdraw', '99.00', 'Parcel', 'keypad', 'approved', NULL, '2026-10-15 08:44:22', NULL, '2026-10-15 08:44:18', '2026-10-15 08:44:18', '2026-10-15 08:44:42'),
(13, 1, 14, 'withdraw', '99.00', NULL, 'keypad', 'pending', NULL, NULL, NULL, '2026-10-15 08:46:27', '2026-10-15 08:46:27', '2026-10-15 08:46:27'),
(14, 1, 2, 'deposit', '101.00', 'baon', 'keypad', 'completed', NULL, NULL, NULL, '2026-10-15 20:43:22', '2026-10-15 20:43:22', '2026-10-15 20:43:46'),
(15, 1, 14, 'withdraw', '88.00', NULL, 'keypad', 'approved', NULL, '2026-10-15 20:44:41', NULL, '2026-10-15 20:44:27', '2026-10-15 20:44:27', '2026-10-15 20:44:41'),
(16, 1, 14, 'withdraw', '55.00', NULL, 'keypad', 'approved', NULL, '2026-10-15 20:45:20', NULL, '2026-10-15 20:45:16', '2026-10-15 20:45:16', '2026-10-15 20:45:20');

--
-- Triggers `transactions`
--
DROP TRIGGER IF EXISTS `trg_tx_before_insert`;
DELIMITER $$
CREATE TRIGGER `trg_tx_before_insert` BEFORE INSERT ON `transactions` FOR EACH ROW BEGIN
  DECLARE v_cat_type VARCHAR(10);
  DECLARE v_cat_user INT UNSIGNED;
  DECLARE v_balance  DECIMAL(14,2);
  DECLARE v_default_cat INT UNSIGNED;

  IF NEW.category_id IS NULL THEN
    SELECT category_id INTO v_default_cat
    FROM categories
    WHERE user_id = NEW.user_id AND name = 'Uncategorized' AND type = NEW.type
    LIMIT 1;

    SET NEW.category_id = v_default_cat;
  END IF;

  SELECT type, user_id INTO v_cat_type, v_cat_user
  FROM categories WHERE category_id = NEW.category_id;

  IF v_cat_type IS NULL OR v_cat_type <> NEW.type THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'Category type does not match transaction type.';
  END IF;

  IF v_cat_user <> NEW.user_id THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'Category does not belong to this user.';
  END IF;

  IF NEW.type = 'withdraw' AND NEW.status IN ('pending','completed') THEN
    SELECT COALESCE(SUM(CASE WHEN type = 'deposit' THEN amount ELSE -amount END), 0)
      INTO v_balance
    FROM transactions
    WHERE user_id = NEW.user_id AND status IN ('pending','completed');

    IF NEW.amount > v_balance THEN
      SIGNAL SQLSTATE '45000'
        SET MESSAGE_TEXT = 'Insufficient balance for this withdrawal.';
    END IF;
  END IF;
END
$$
DELIMITER ;
DROP TRIGGER IF EXISTS `trg_tx_before_update`;
DELIMITER $$
CREATE TRIGGER `trg_tx_before_update` BEFORE UPDATE ON `transactions` FOR EACH ROW BEGIN
  DECLARE v_cat_type VARCHAR(10);
  DECLARE v_cat_user INT UNSIGNED;

  IF OLD.status <> 'pending' AND (
        NEW.amount           <> OLD.amount
     OR NEW.type             <> OLD.type
     OR NEW.status           <> OLD.status
     OR NEW.transaction_date <> OLD.transaction_date
  ) THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'Finished transactions can only have their category or note edited.';
  END IF;

  IF NEW.category_id IS NULL THEN
    SET NEW.category_id = OLD.category_id;
  END IF;

  SELECT type, user_id INTO v_cat_type, v_cat_user
  FROM categories WHERE category_id = NEW.category_id;

  IF v_cat_type IS NULL OR v_cat_type <> NEW.type THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'Category type does not match transaction type.';
  END IF;

  IF v_cat_user <> NEW.user_id THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'Category does not belong to this user.';
  END IF;
END
$$
DELIMITER ;

-- --------------------------------------------------------

--
-- Table structure for table `users`
--

DROP TABLE IF EXISTS `users`;
CREATE TABLE IF NOT EXISTS `users` (
  `user_id` int UNSIGNED NOT NULL AUTO_INCREMENT,
  `full_name` varchar(100) COLLATE utf8mb4_unicode_ci NOT NULL,
  `email` varchar(150) COLLATE utf8mb4_unicode_ci NOT NULL,
  `password_hash` varchar(255) COLLATE utf8mb4_unicode_ci NOT NULL COMMENT 'Website login (bcrypt/argon2)',
  `withdraw_pin_hash` varchar(255) COLLATE utf8mb4_unicode_ci NOT NULL COMMENT 'Keypad PIN for withdrawals (hashed)',
  `created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`user_id`),
  UNIQUE KEY `uq_users_email` (`email`)
) ENGINE=InnoDB AUTO_INCREMENT=2 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

--
-- Dumping data for table `users`
--

INSERT INTO `users` (`user_id`, `full_name`, `email`, `password_hash`, `withdraw_pin_hash`, `created_at`, `updated_at`) VALUES
(1, 'Jomar Udtohan', 'admin@piggybank.local', '$2y$10$FvTXNyWirycXr.lTsvxdeu4dXyEevy3JcR1AcI6nTet/11fwzJsw6', '$2b$10$Yo3MZAEd4hJkvKprBgIJAu2qt0i0GnBZEVfRHh97CmfBNiGQSyZbu', '2026-10-08 19:57:35', '2026-10-13 22:20:47');

--
-- Triggers `users`
--
DROP TRIGGER IF EXISTS `trg_users_after_insert`;
DELIMITER $$
CREATE TRIGGER `trg_users_after_insert` AFTER INSERT ON `users` FOR EACH ROW BEGIN
  INSERT INTO user_settings (user_id) VALUES (NEW.user_id);

  INSERT INTO categories (user_id, name, type, color_hex, is_default) VALUES
    (NEW.user_id, 'Scholarship',   'deposit',  '#2E7D32', TRUE),
    (NEW.user_id, 'Baon',          'deposit',  '#43A047', TRUE),
    (NEW.user_id, 'Salary',        'deposit',  '#00897B', TRUE),
    (NEW.user_id, 'Part-time',     'deposit',  '#26A69A', TRUE),
    (NEW.user_id, 'Others',        'deposit',  '#78909C', TRUE),
    (NEW.user_id, 'Uncategorized', 'deposit',  '#9E9E9E', TRUE),
    (NEW.user_id, 'Family',        'withdraw', '#E53935', TRUE),
    (NEW.user_id, 'Medicine',      'withdraw', '#D81B60', TRUE),
    (NEW.user_id, 'Shopping',      'withdraw', '#8E24AA', TRUE),
    (NEW.user_id, 'Food',          'withdraw', '#FB8C00', TRUE),
    (NEW.user_id, 'Entertainment', 'withdraw', '#3949AB', TRUE),
    (NEW.user_id, 'Education',     'withdraw', '#1E88E5', TRUE),
    (NEW.user_id, 'Others',        'withdraw', '#78909C', TRUE),
    (NEW.user_id, 'Uncategorized', 'withdraw', '#9E9E9E', TRUE);
END
$$
DELIMITER ;
DROP TRIGGER IF EXISTS `trg_users_single_account`;
DELIMITER $$
CREATE TRIGGER `trg_users_single_account` BEFORE INSERT ON `users` FOR EACH ROW BEGIN
  IF (SELECT COUNT(*) FROM users) >= 1 THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'This piggy bank supports only one user account.';
  END IF;
END
$$
DELIMITER ;

-- --------------------------------------------------------

--
-- Table structure for table `user_settings`
--

DROP TABLE IF EXISTS `user_settings`;
CREATE TABLE IF NOT EXISTS `user_settings` (
  `setting_id` int UNSIGNED NOT NULL AUTO_INCREMENT,
  `user_id` int UNSIGNED NOT NULL,
  `currency_code` char(3) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'PHP',
  `currency_symbol` varchar(5) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT '₱',
  `timezone` varchar(50) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'Asia/Manila',
  `date_format` varchar(20) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'MMM DD, YYYY',
  `time_format` enum('12h','24h') COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT '12h',
  `theme` enum('light','dark') COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'light',
  `max_pin_attempts` tinyint UNSIGNED NOT NULL DEFAULT '3',
  `lockout_minutes` smallint UNSIGNED NOT NULL DEFAULT '5',
  `servo_open_seconds` tinyint UNSIGNED NOT NULL DEFAULT '10',
  `withdraw_approval_seconds` smallint UNSIGNED NOT NULL DEFAULT '60' COMMENT 'How long the owner has to approve a withdrawal',
  `low_balance_alert` decimal(12,2) DEFAULT NULL,
  `monthly_budget` decimal(12,2) DEFAULT NULL,
  `updated_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`setting_id`),
  UNIQUE KEY `uq_settings_user` (`user_id`)
) ;

--
-- Dumping data for table `user_settings`
--

INSERT INTO `user_settings` (`setting_id`, `user_id`, `currency_code`, `currency_symbol`, `timezone`, `date_format`, `time_format`, `theme`, `max_pin_attempts`, `lockout_minutes`, `servo_open_seconds`, `withdraw_approval_seconds`, `low_balance_alert`, `monthly_budget`, `updated_at`) VALUES
(1, 1, 'PHP', '₱', 'Asia/Manila', 'MMM DD, YYYY', '12h', 'light', 3, 5, 10, 60, NULL, NULL, '2026-10-08 19:57:35');

-- --------------------------------------------------------

--
-- Stand-in structure for view `v_daily_summary`
-- (See below for the actual view)
--
DROP VIEW IF EXISTS `v_daily_summary`;
CREATE TABLE IF NOT EXISTS `v_daily_summary` (
`user_id` int unsigned
,`day` date
,`income` decimal(34,2)
,`expenses` decimal(34,2)
);

-- --------------------------------------------------------

--
-- Stand-in structure for view `v_monthly_category_report`
-- (See below for the actual view)
--
DROP VIEW IF EXISTS `v_monthly_category_report`;
CREATE TABLE IF NOT EXISTS `v_monthly_category_report` (
`user_id` int unsigned
,`month` varchar(7)
,`type` enum('deposit','withdraw')
,`category_name` varchar(50)
,`color_hex` char(7)
,`transaction_count` bigint
,`total_amount` decimal(34,2)
,`pct_of_type` decimal(39,1)
);

-- --------------------------------------------------------

--
-- Stand-in structure for view `v_monthly_report`
-- (See below for the actual view)
--
DROP VIEW IF EXISTS `v_monthly_report`;
CREATE TABLE IF NOT EXISTS `v_monthly_report` (
`user_id` int unsigned
,`month` varchar(7)
,`income` decimal(34,2)
,`expenses` decimal(34,2)
,`net` decimal(34,2)
,`deposit_count` decimal(23,0)
,`withdraw_count` decimal(23,0)
,`ending_balance` decimal(56,2)
,`monthly_budget` decimal(12,2)
,`budget_used_pct` decimal(39,1)
);

-- --------------------------------------------------------

--
-- Stand-in structure for view `v_pending_withdrawals`
-- (See below for the actual view)
--
DROP VIEW IF EXISTS `v_pending_withdrawals`;
CREATE TABLE IF NOT EXISTS `v_pending_withdrawals` (
`transaction_id` int unsigned
,`user_id` int unsigned
,`amount` decimal(12,2)
,`requested_at` datetime
,`expires_at` datetime
,`seconds_left` bigint
);

-- --------------------------------------------------------

--
-- Stand-in structure for view `v_summary`
-- (See below for the actual view)
--
DROP VIEW IF EXISTS `v_summary`;
CREATE TABLE IF NOT EXISTS `v_summary` (
`user_id` int unsigned
,`total_income` decimal(34,2)
,`total_expenses` decimal(34,2)
,`balance` decimal(34,2)
);

-- --------------------------------------------------------

--
-- Stand-in structure for view `v_transaction_history`
-- (See below for the actual view)
--
DROP VIEW IF EXISTS `v_transaction_history`;
CREATE TABLE IF NOT EXISTS `v_transaction_history` (
`transaction_id` int unsigned
,`user_id` int unsigned
,`type` enum('deposit','withdraw')
,`amount` decimal(12,2)
,`category_name` varchar(50)
,`color_hex` char(7)
,`note` varchar(255)
,`source` enum('keypad','web')
,`status` enum('pending','approved','completed','cancelled','failed')
,`cancel_reason` enum('rejected','timeout','other')
,`transaction_date` datetime
);

-- --------------------------------------------------------

--
-- Structure for view `v_daily_summary`
--
DROP TABLE IF EXISTS `v_daily_summary`;

DROP VIEW IF EXISTS `v_daily_summary`;
CREATE ALGORITHM=UNDEFINED DEFINER=`root`@`localhost` SQL SECURITY DEFINER VIEW `v_daily_summary`  AS SELECT `transactions`.`user_id` AS `user_id`, cast(`transactions`.`transaction_date` as date) AS `day`, sum((case when (`transactions`.`type` = 'deposit') then `transactions`.`amount` else 0 end)) AS `income`, sum((case when (`transactions`.`type` = 'withdraw') then `transactions`.`amount` else 0 end)) AS `expenses` FROM `transactions` WHERE (`transactions`.`status` = 'completed') GROUP BY `transactions`.`user_id`, cast(`transactions`.`transaction_date` as date)  ;

-- --------------------------------------------------------

--
-- Structure for view `v_monthly_category_report`
--
DROP TABLE IF EXISTS `v_monthly_category_report`;

DROP VIEW IF EXISTS `v_monthly_category_report`;
CREATE ALGORITHM=UNDEFINED DEFINER=`root`@`localhost` SQL SECURITY DEFINER VIEW `v_monthly_category_report`  AS SELECT `x`.`user_id` AS `user_id`, `x`.`month` AS `month`, `x`.`type` AS `type`, `x`.`category_name` AS `category_name`, `x`.`color_hex` AS `color_hex`, `x`.`transaction_count` AS `transaction_count`, `x`.`total_amount` AS `total_amount`, round(((`x`.`total_amount` / sum(`x`.`total_amount`) OVER (PARTITION BY `x`.`user_id`,`x`.`month`,`x`.`type` ) ) * 100),1) AS `pct_of_type` FROM (select `t`.`user_id` AS `user_id`,date_format(`t`.`transaction_date`,'%Y-%m') AS `month`,`t`.`type` AS `type`,`c`.`name` AS `category_name`,`c`.`color_hex` AS `color_hex`,count(0) AS `transaction_count`,sum(`t`.`amount`) AS `total_amount` from (`transactions` `t` join `categories` `c` on((`c`.`category_id` = `t`.`category_id`))) where (`t`.`status` = 'completed') group by `t`.`user_id`,date_format(`t`.`transaction_date`,'%Y-%m'),`t`.`type`,`c`.`name`,`c`.`color_hex`) AS `x``x`  ;

-- --------------------------------------------------------

--
-- Structure for view `v_monthly_report`
--
DROP TABLE IF EXISTS `v_monthly_report`;

DROP VIEW IF EXISTS `v_monthly_report`;
CREATE ALGORITHM=UNDEFINED DEFINER=`root`@`localhost` SQL SECURITY DEFINER VIEW `v_monthly_report`  AS SELECT `m`.`user_id` AS `user_id`, `m`.`month` AS `month`, `m`.`income` AS `income`, `m`.`expenses` AS `expenses`, `m`.`net` AS `net`, `m`.`deposit_count` AS `deposit_count`, `m`.`withdraw_count` AS `withdraw_count`, sum(`m`.`net`) OVER (PARTITION BY `m`.`user_id` ORDER BY `m`.`month` ) AS `ending_balance`, `s`.`monthly_budget` AS `monthly_budget`, (case when ((`s`.`monthly_budget` is null) or (`s`.`monthly_budget` = 0)) then NULL else round(((`m`.`expenses` / `s`.`monthly_budget`) * 100),1) end) AS `budget_used_pct` FROM ((select `transactions`.`user_id` AS `user_id`,date_format(`transactions`.`transaction_date`,'%Y-%m') AS `month`,sum((case when (`transactions`.`type` = 'deposit') then `transactions`.`amount` else 0 end)) AS `income`,sum((case when (`transactions`.`type` = 'withdraw') then `transactions`.`amount` else 0 end)) AS `expenses`,sum((case when (`transactions`.`type` = 'deposit') then `transactions`.`amount` else -(`transactions`.`amount`) end)) AS `net`,sum((`transactions`.`type` = 'deposit')) AS `deposit_count`,sum((`transactions`.`type` = 'withdraw')) AS `withdraw_count` from `transactions` where (`transactions`.`status` = 'completed') group by `transactions`.`user_id`,date_format(`transactions`.`transaction_date`,'%Y-%m')) `m` join `user_settings` `s` on((`s`.`user_id` = `m`.`user_id`)))  ;

-- --------------------------------------------------------

--
-- Structure for view `v_pending_withdrawals`
--
DROP TABLE IF EXISTS `v_pending_withdrawals`;

DROP VIEW IF EXISTS `v_pending_withdrawals`;
CREATE ALGORITHM=UNDEFINED DEFINER=`root`@`localhost` SQL SECURITY DEFINER VIEW `v_pending_withdrawals`  AS SELECT `transactions`.`transaction_id` AS `transaction_id`, `transactions`.`user_id` AS `user_id`, `transactions`.`amount` AS `amount`, `transactions`.`created_at` AS `requested_at`, `transactions`.`expires_at` AS `expires_at`, greatest(timestampdiff(SECOND,now(),`transactions`.`expires_at`),0) AS `seconds_left` FROM `transactions` WHERE ((`transactions`.`type` = 'withdraw') AND (`transactions`.`status` = 'pending') AND (`transactions`.`expires_at` > now()))  ;

-- --------------------------------------------------------

--
-- Structure for view `v_summary`
--
DROP TABLE IF EXISTS `v_summary`;

DROP VIEW IF EXISTS `v_summary`;
CREATE ALGORITHM=UNDEFINED DEFINER=`root`@`localhost` SQL SECURITY DEFINER VIEW `v_summary`  AS SELECT `transactions`.`user_id` AS `user_id`, coalesce(sum((case when (`transactions`.`type` = 'deposit') then `transactions`.`amount` end)),0) AS `total_income`, coalesce(sum((case when (`transactions`.`type` = 'withdraw') then `transactions`.`amount` end)),0) AS `total_expenses`, coalesce(sum((case when (`transactions`.`type` = 'deposit') then `transactions`.`amount` else -(`transactions`.`amount`) end)),0) AS `balance` FROM `transactions` WHERE (`transactions`.`status` = 'completed') GROUP BY `transactions`.`user_id``user_id`  ;

-- --------------------------------------------------------

--
-- Structure for view `v_transaction_history`
--
DROP TABLE IF EXISTS `v_transaction_history`;

DROP VIEW IF EXISTS `v_transaction_history`;
CREATE ALGORITHM=UNDEFINED DEFINER=`root`@`localhost` SQL SECURITY DEFINER VIEW `v_transaction_history`  AS SELECT `t`.`transaction_id` AS `transaction_id`, `t`.`user_id` AS `user_id`, `t`.`type` AS `type`, `t`.`amount` AS `amount`, `c`.`name` AS `category_name`, `c`.`color_hex` AS `color_hex`, `t`.`note` AS `note`, `t`.`source` AS `source`, `t`.`status` AS `status`, `t`.`cancel_reason` AS `cancel_reason`, `t`.`transaction_date` AS `transaction_date` FROM (`transactions` `t` left join `categories` `c` on((`c`.`category_id` = `t`.`category_id`)))  ;

--
-- Constraints for dumped tables
--

--
-- Constraints for table `access_logs`
--
ALTER TABLE `access_logs`
  ADD CONSTRAINT `fk_log_tx` FOREIGN KEY (`transaction_id`) REFERENCES `transactions` (`transaction_id`) ON DELETE SET NULL ON UPDATE CASCADE,
  ADD CONSTRAINT `fk_log_user` FOREIGN KEY (`user_id`) REFERENCES `users` (`user_id`) ON DELETE CASCADE ON UPDATE CASCADE;

--
-- Constraints for table `categories`
--
ALTER TABLE `categories`
  ADD CONSTRAINT `fk_category_user` FOREIGN KEY (`user_id`) REFERENCES `users` (`user_id`) ON DELETE CASCADE ON UPDATE CASCADE;

--
-- Constraints for table `notifications`
--
ALTER TABLE `notifications`
  ADD CONSTRAINT `fk_notif_user` FOREIGN KEY (`user_id`) REFERENCES `users` (`user_id`) ON DELETE CASCADE ON UPDATE CASCADE;

--
-- Constraints for table `savings_goals`
--
ALTER TABLE `savings_goals`
  ADD CONSTRAINT `fk_goal_user` FOREIGN KEY (`user_id`) REFERENCES `users` (`user_id`) ON DELETE CASCADE ON UPDATE CASCADE;

--
-- Constraints for table `transactions`
--
ALTER TABLE `transactions`
  ADD CONSTRAINT `fk_tx_category` FOREIGN KEY (`category_id`) REFERENCES `categories` (`category_id`) ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT `fk_tx_user` FOREIGN KEY (`user_id`) REFERENCES `users` (`user_id`) ON DELETE CASCADE ON UPDATE CASCADE;

--
-- Constraints for table `user_settings`
--
ALTER TABLE `user_settings`
  ADD CONSTRAINT `fk_settings_user` FOREIGN KEY (`user_id`) REFERENCES `users` (`user_id`) ON DELETE CASCADE ON UPDATE CASCADE;

DELIMITER $$
--
-- Events
--
DROP EVENT IF EXISTS `ev_expire_pending_withdrawals`$$
CREATE DEFINER=`root`@`localhost` EVENT `ev_expire_pending_withdrawals` ON SCHEDULE EVERY 5 SECOND STARTS '2026-10-08 19:57:35' ON COMPLETION NOT PRESERVE ENABLE DO CALL sp_expire_pending_withdrawals()$$

DELIMITER ;
COMMIT;

/*!40101 SET CHARACTER_SET_CLIENT=@OLD_CHARACTER_SET_CLIENT */;
/*!40101 SET CHARACTER_SET_RESULTS=@OLD_CHARACTER_SET_RESULTS */;
/*!40101 SET COLLATION_CONNECTION=@OLD_COLLATION_CONNECTION */;
