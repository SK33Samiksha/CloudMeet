-- CloudMeet database schema (Google Cloud SQL, MySQL 8)
-- Designed by Yogita Kauthankar. Exported from the cloudmeet database.
-- Run once on an empty database:  mysql -h <host> -u <user> -p cloudmeet < schema.sql

CREATE TABLE IF NOT EXISTS `users` (
  `id` bigint unsigned NOT NULL AUTO_INCREMENT,
  `name` varchar(100) NOT NULL,
  `email` varchar(255) NOT NULL,
  `password_hash` varchar(255) NOT NULL,
  `created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  UNIQUE KEY `email` (`email`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS `meetings` (
  `id` varchar(50) NOT NULL,
  `title` varchar(255) NOT NULL,
  `host_user_id` bigint unsigned NOT NULL,
  `host_name` varchar(100) NOT NULL,
  `created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `status` varchar(30) NOT NULL DEFAULT 'active',
  PRIMARY KEY (`id`),
  KEY `idx_meetings_host` (`host_user_id`),
  KEY `idx_meetings_created` (`created_at`),
  CONSTRAINT `fk_meetings_host` FOREIGN KEY (`host_user_id`) REFERENCES `users` (`id`) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS `participants` (
  `id` varchar(100) NOT NULL,
  `meeting_id` varchar(50) NOT NULL,
  `user_id` bigint unsigned NOT NULL,
  `name` varchar(100) NOT NULL,
  `joined_at` datetime(3) NOT NULL,
  `left_at` datetime(3) DEFAULT NULL,
  PRIMARY KEY (`id`),
  KEY `idx_participants_meeting` (`meeting_id`),
  KEY `idx_participants_user` (`user_id`),
  CONSTRAINT `fk_participants_meeting` FOREIGN KEY (`meeting_id`) REFERENCES `meetings` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_participants_user` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS `meeting_viewers` (
  `meeting_id` varchar(50) NOT NULL,
  `user_id` bigint unsigned NOT NULL,
  PRIMARY KEY (`meeting_id`,`user_id`),
  KEY `idx_meeting_viewers_user` (`user_id`),
  CONSTRAINT `fk_meeting_viewers_meeting` FOREIGN KEY (`meeting_id`) REFERENCES `meetings` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_meeting_viewers_user` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS `messages` (
  `id` varchar(100) NOT NULL,
  `meeting_id` varchar(50) NOT NULL,
  `sender_user_id` bigint unsigned NOT NULL,
  `name` varchar(100) NOT NULL,
  `message_text` varchar(1000) NOT NULL,
  `sent_at` datetime(3) NOT NULL,
  PRIMARY KEY (`id`),
  KEY `idx_messages_meeting_time` (`meeting_id`,`sent_at`),
  KEY `idx_messages_sender` (`sender_user_id`),
  CONSTRAINT `fk_messages_meeting` FOREIGN KEY (`meeting_id`) REFERENCES `meetings` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_messages_sender` FOREIGN KEY (`sender_user_id`) REFERENCES `users` (`id`) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS `recordings` (
  `id` varchar(50) NOT NULL,
  `title` varchar(255) NOT NULL,
  `room` varchar(50) NOT NULL,
  `filename` varchar(255) NOT NULL,
  `size` bigint unsigned NOT NULL DEFAULT '0',
  `duration_seconds` int unsigned NOT NULL DEFAULT '0',
  `created_at` datetime(3) NOT NULL,
  `host_id` bigint unsigned NOT NULL,
  `host_name` varchar(100) NOT NULL,
  `storage` varchar(30) NOT NULL DEFAULT 'local',
  `gcs_object` varchar(1024) DEFAULT NULL,
  PRIMARY KEY (`id`),
  KEY `idx_recordings_room` (`room`),
  KEY `idx_recordings_host` (`host_id`),
  KEY `idx_recordings_created` (`created_at`),
  CONSTRAINT `fk_recordings_host` FOREIGN KEY (`host_id`) REFERENCES `users` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `fk_recordings_meeting` FOREIGN KEY (`room`) REFERENCES `meetings` (`id`) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS `recording_views` (
  `id` bigint unsigned NOT NULL AUTO_INCREMENT,
  `recording_id` varchar(50) NOT NULL,
  `user_id` bigint unsigned NOT NULL,
  `name` varchar(100) NOT NULL,
  `watched_at` datetime(3) NOT NULL,
  PRIMARY KEY (`id`),
  KEY `idx_recording_views_recording` (`recording_id`),
  KEY `idx_recording_views_user` (`user_id`),
  KEY `idx_recording_views_recording_user` (`recording_id`,`user_id`),
  CONSTRAINT `fk_recording_views_recording` FOREIGN KEY (`recording_id`) REFERENCES `recordings` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_recording_views_user` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
