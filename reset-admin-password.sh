#!/bin/bash
# Smart Home - 重置 admin 密码为 123456

cd /opt/projects/smart-home

# 新的密码哈希 (123456)
NEW_HASH='\$2b\$12\$LQv3c1yqBWVHxkd0LHAkCOYz6TtxMQJqhN8/LewKyNiAYMyzJ/IiK'

docker compose exec -T mysql mysql -uroot -p"${MYSQL_ROOT_PASSWORD}" -e "
USE smart_home_web;
UPDATE users SET password_hash='$NEW_HASH' WHERE username='admin';
SELECT 'Password reset successful' as result;
"

echo "Admin password reset to: 123456"
