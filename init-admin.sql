-- Smart Home - 重置 admin 密码为 123456
-- 执行: mysql -uroot -p smart_home_web < init-admin.sql

-- 删除现有 admin 用户（如果存在）
DELETE FROM users WHERE username = 'admin';

-- 插入新的 admin 用户，密码为 123456
-- 密码哈希: bcrypt("123456")
INSERT INTO users (id, username, password_hash, nickname, role, is_active, created_at, updated_at) 
VALUES (
    1, 
    'admin', 
    '$2b$12$LQv3c1yqBWVHxkd0LHAkCOYz6TtxMQJqhN8/LewKyNiAYMyzJ/IiK', 
    '管理员', 
    'admin', 
    1, 
    NOW(), 
    NOW()
);

-- 验证
SELECT id, username, nickname, role, is_active FROM users WHERE username = 'admin';
