/*
 Navicat Premium Dump SQL

 Source Server         : mysql8
 Source Server Type    : MySQL
 Source Server Version : 80045 (8.0.45)
 Source Host           : localhost:3306
 Source Schema         : smart_home_web

 Target Server Type    : MySQL
 Target Server Version : 80045 (8.0.45)
 File Encoding         : 65001

 Date: 21/03/2026 12:20:42
*/

SET NAMES utf8mb4;
SET FOREIGN_KEY_CHECKS = 0;

-- ----------------------------
-- Table structure for alembic_version
-- ----------------------------
DROP TABLE IF EXISTS `alembic_version`;
CREATE TABLE `alembic_version` (
  `version_num` varchar(32) COLLATE utf8mb4_unicode_ci NOT NULL,
  PRIMARY KEY (`version_num`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ----------------------------
-- Records of alembic_version
-- ----------------------------
BEGIN;
INSERT INTO `alembic_version` (`version_num`) VALUES ('e01b9892fbe7');
COMMIT;

-- ----------------------------
-- Table structure for system_config
-- ----------------------------
DROP TABLE IF EXISTS `system_config`;
CREATE TABLE `system_config` (
  `id` int NOT NULL AUTO_INCREMENT,
  `key` varchar(64) COLLATE utf8mb4_unicode_ci NOT NULL,
  `value` text COLLATE utf8mb4_unicode_ci NOT NULL,
  `updated_at` datetime DEFAULT (now()),
  PRIMARY KEY (`id`),
  UNIQUE KEY `ix_system_config_key` (`key`),
  KEY `ix_system_config_id` (`id`)
) ENGINE=InnoDB AUTO_INCREMENT=10 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ----------------------------
-- Records of system_config
-- ----------------------------
BEGIN;
INSERT INTO `system_config` (`id`, `key`, `value`, `updated_at`) VALUES (1, 'jwt_expire_hours', '24', '2026-03-19 22:55:27');
INSERT INTO `system_config` (`id`, `key`, `value`, `updated_at`) VALUES (2, 'password_min_length', '6', '2026-03-19 22:55:27');
INSERT INTO `system_config` (`id`, `key`, `value`, `updated_at`) VALUES (3, 'ollama_base_url', 'http://localhost:11434', '2026-03-19 22:57:17');
INSERT INTO `system_config` (`id`, `key`, `value`, `updated_at`) VALUES (4, 'dify_base_url', 'http://localhost:5001', '2026-03-19 22:57:17');
INSERT INTO `system_config` (`id`, `key`, `value`, `updated_at`) VALUES (5, 'ha_base_url', 'http://localhost:8123', '2026-03-19 22:57:17');
INSERT INTO `system_config` (`id`, `key`, `value`, `updated_at`) VALUES (6, 'influxdb_url', 'http://localhost:8086', '2026-03-19 22:57:17');
INSERT INTO `system_config` (`id`, `key`, `value`, `updated_at`) VALUES (7, 'influxdb_org', 'smart-home', '2026-03-19 22:57:17');
INSERT INTO `system_config` (`id`, `key`, `value`, `updated_at`) VALUES (8, 'influxdb_bucket', 'smart-home-data', '2026-03-19 22:57:17');
INSERT INTO `system_config` (`id`, `key`, `value`, `updated_at`) VALUES (9, 'allow_registration', 'true', '2026-03-19 22:57:17');
COMMIT;

-- ----------------------------
-- Table structure for users
-- ----------------------------
DROP TABLE IF EXISTS `users`;
CREATE TABLE `users` (
  `id` int NOT NULL AUTO_INCREMENT,
  `username` varchar(64) COLLATE utf8mb4_unicode_ci NOT NULL,
  `password_hash` varchar(128) COLLATE utf8mb4_unicode_ci NOT NULL,
  `nickname` varchar(64) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `role` enum('user','admin') COLLATE utf8mb4_unicode_ci NOT NULL,
  `created_at` datetime DEFAULT CURRENT_TIMESTAMP,
  `updated_at` datetime DEFAULT CURRENT_TIMESTAMP,
  `avatar` varchar(256) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `is_active` tinyint(1) NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `ix_users_username` (`username`),
  KEY `ix_users_id` (`id`)
) ENGINE=InnoDB AUTO_INCREMENT=9 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ----------------------------
-- Records of users
-- ----------------------------
BEGIN;
INSERT INTO `users` (`id`, `username`, `password_hash`, `nickname`, `role`, `created_at`, `updated_at`, `avatar`, `is_active`) VALUES (1, 'admin', '$2b$12$/HeotQQklf4tfnlV0InVXuk6pd60NB.BjGSb9dGHwE.Bwi4GbICHa', '管理员', 'admin', '2026-03-18 21:58:04', '2026-03-19 21:21:44', NULL, 1);
INSERT INTO `users` (`id`, `username`, `password_hash`, `nickname`, `role`, `created_at`, `updated_at`, `avatar`, `is_active`) VALUES (2, 'test', '$2b$12$cdAJv62aEdgT8KcDRODiM.wOKtxbsdm.efK2DeaIJRxtGfj1OYHAa', '测试', 'user', '2026-03-19 15:16:18', '2026-03-19 21:21:49', '', 1);
INSERT INTO `users` (`id`, `username`, `password_hash`, `nickname`, `role`, `created_at`, `updated_at`, `avatar`, `is_active`) VALUES (4, 'zhangsan', '$2b$12$Cgbhr4lxvjpHXeUHHVdWROwXfnzOKX1If3qVmXQLaSTLrn1j.cVo6', '张三', 'user', '2026-03-19 21:20:07', '2026-03-19 21:20:07', '', 1);
COMMIT;

SET FOREIGN_KEY_CHECKS = 1;
