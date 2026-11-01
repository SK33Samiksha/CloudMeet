-- CloudMeet database upgrade (version 2)
-- Adds: invite-only meetings, recording expiry, and host-approved recording access.
--
-- You normally do NOT need to run this by hand: the backend upgrades the
-- database automatically the first time it starts. Run it manually only if the
-- backend says it "could not upgrade the database automatically" (for example
-- when the database user is not allowed to ALTER tables):
--
--   mysql -h <host> -u <admin-user> -p cloudmeet < migration_v2.sql
--
-- Run it ONCE. If a column already exists MySQL reports "Duplicate column name"
-- for that line, which is harmless: skip that line and continue with the rest.

ALTER TABLE `meetings`
  ADD COLUMN `access_type` varchar(20) NOT NULL DEFAULT 'ask',
  ADD COLUMN `invited_emails` text DEFAULT NULL;

ALTER TABLE `recordings`
  ADD COLUMN `expires_at` datetime(3) DEFAULT NULL,
  ADD KEY `idx_recordings_expires` (`expires_at`);

CREATE TABLE IF NOT EXISTS `recording_requests` (
  `meeting_id` varchar(50) NOT NULL,
  `user_id` bigint unsigned NOT NULL,
  `name` varchar(100) NOT NULL,
  `requested_at` datetime(3) NOT NULL,
  `status` varchar(20) NOT NULL DEFAULT 'pending',
  PRIMARY KEY (`meeting_id`,`user_id`),
  KEY `idx_recording_requests_status` (`meeting_id`,`status`),
  CONSTRAINT `fk_recording_requests_meeting` FOREIGN KEY (`meeting_id`) REFERENCES `meetings` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_recording_requests_user` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- Existing recordings get no expiry date. To make old ones expire 30 days
-- after they were made, uncomment:
-- UPDATE `recordings` SET `expires_at` = DATE_ADD(`created_at`, INTERVAL 30 DAY) WHERE `expires_at` IS NULL;
