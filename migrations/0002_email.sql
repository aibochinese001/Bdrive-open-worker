-- BDrive 0002: 邮箱验证码、邮件发送日志、SMTP 默认配置

-- 邮箱验证码（改密码等）。验证码仅存 SHA-256 哈希
CREATE TABLE IF NOT EXISTS email_codes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL,
  purpose TEXT NOT NULL DEFAULT 'change_password', -- change_password
  code_hash TEXT NOT NULL,
  expires_at TEXT NOT NULL,                        -- UTC: datetime('now','+10 minutes')
  consumed INTEGER NOT NULL DEFAULT 0,
  attempts INTEGER NOT NULL DEFAULT 0,
  ip TEXT NOT NULL DEFAULT '',
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_email_codes_lookup
  ON email_codes(email, purpose, consumed, expires_at);

-- 邮件发送日志（幂等去重：到期提醒每周期一次、订单发票每单一次）
CREATE TABLE IF NOT EXISTS mail_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  mail_key TEXT NOT NULL,                          -- 如 expiry:<uid>:<到期日> / invoice:<order_no>
  to_email TEXT NOT NULL,
  subject TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'sent',             -- sent | failed
  error TEXT NOT NULL DEFAULT '',
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS uniq_mail_key ON mail_log(mail_key);

-- SMTP（QQ 邮箱）默认设置
INSERT OR IGNORE INTO settings (key, value) VALUES
  ('smtp_enabled', '0'),
  ('smtp_host', 'smtp.qq.com'),
  ('smtp_port', '465'),
  ('smtp_security', 'ssl'),    -- ssl=465 直连 TLS | starttls=587
  ('smtp_user', ''),           -- 发信邮箱地址，如 noreply@qq.com
  ('smtp_pass', ''),           -- QQ 邮箱「授权码」（非登录密码）
  ('smtp_from_name', 'BDrive 商务网盘');
