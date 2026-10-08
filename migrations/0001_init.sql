-- BDrive 商务网盘 — 初始化数据库
-- 0001_init.sql

-- 系统设置（键值表）
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL DEFAULT '',
  updated_at TEXT DEFAULT (datetime('now'))
);

-- 用户
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT UNIQUE NOT NULL,
  password TEXT NOT NULL,
  name TEXT NOT NULL DEFAULT '',
  role TEXT NOT NULL DEFAULT 'user',          -- user | admin
  status TEXT NOT NULL DEFAULT 'active',      -- active | banned
  quota_override_mb INTEGER,                  -- 管理员手动配额覆盖（MB），NULL 取套餐
  membership_tier TEXT NOT NULL DEFAULT 'free',
  membership_expires_at TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_users_role ON users(role);
CREATE INDEX IF NOT EXISTS idx_users_status ON users(status);

-- 会员套餐
CREATE TABLE IF NOT EXISTS membership_plans (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  key TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  duration_type TEXT NOT NULL DEFAULT 'month', -- day | month | year | forever
  duration_value INTEGER NOT NULL DEFAULT 1,
  price REAL NOT NULL DEFAULT 0,
  currency TEXT NOT NULL DEFAULT 'CNY',
  storage_quota_mb INTEGER NOT NULL DEFAULT 10240,
  max_file_mb INTEGER NOT NULL DEFAULT 1024,
  benefits TEXT DEFAULT '',                    -- 权益说明，换行分隔
  sort_order INTEGER NOT NULL DEFAULT 0,
  status INTEGER NOT NULL DEFAULT 1,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

-- 文件 / 文件夹（逻辑目录树，对象体存 R2）
CREATE TABLE IF NOT EXISTS files (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  parent_id INTEGER,                           -- NULL 表示根目录
  name TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'file',           -- file | folder
  size INTEGER NOT NULL DEFAULT 0,
  mime TEXT NOT NULL DEFAULT 'application/octet-stream',
  r2_key TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_files_user_parent ON files(user_id, parent_id);
CREATE INDEX IF NOT EXISTS idx_files_parent ON files(parent_id);
CREATE INDEX IF NOT EXISTS idx_files_user_name ON files(user_id, name);
-- 同名同级去重（SQLite 中 NULL 互不相等，根目录与子目录需分别建唯一索引）
CREATE UNIQUE INDEX IF NOT EXISTS uniq_files_root
  ON files(user_id, name) WHERE parent_id IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uniq_files_nested
  ON files(user_id, parent_id, name) WHERE parent_id IS NOT NULL;

-- 分享链接（文件或文件夹）
CREATE TABLE IF NOT EXISTS shares (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  token TEXT UNIQUE NOT NULL,
  user_id INTEGER NOT NULL,
  file_id INTEGER NOT NULL,
  passcode TEXT,                               -- 提取码，NULL 表示无码
  expires_at TEXT,                             -- NULL 永久有效
  downloads INTEGER NOT NULL DEFAULT 0,
  max_downloads INTEGER,                       -- NULL 不限次
  status TEXT NOT NULL DEFAULT 'active',       -- active | revoked
  created_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (file_id) REFERENCES files(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_shares_user ON shares(user_id);
CREATE INDEX IF NOT EXISTS idx_shares_file ON shares(file_id);

-- 支付订单
CREATE TABLE IF NOT EXISTS orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_no TEXT UNIQUE NOT NULL,
  user_id INTEGER NOT NULL,
  plan_id INTEGER NOT NULL,
  plan_key TEXT NOT NULL,
  plan_name TEXT NOT NULL DEFAULT '',
  amount REAL NOT NULL,
  currency TEXT NOT NULL DEFAULT 'CNY',
  method TEXT NOT NULL,                        -- wxpay | alipay | ecny | usdt
  gateway_type TEXT NOT NULL,                  -- 提交给易支付的 type 原始值
  status TEXT NOT NULL DEFAULT 'pending',      -- pending | paid | closed
  trade_no TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  paid_at TEXT,
  FOREIGN KEY (user_id) REFERENCES users(id)
);
CREATE INDEX IF NOT EXISTS idx_orders_user ON orders(user_id, id DESC);
CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);

-- ---------------------------------------------------------------------------
-- 默认设置
-- ---------------------------------------------------------------------------
INSERT OR IGNORE INTO settings (key, value) VALUES
  ('site_name', 'BDrive 商务网盘'),
  ('site_slogan', '安全、高速的企业级云存储与文件分享平台'),
  ('free_quota_mb', '1024'),
  ('free_max_file_mb', '100'),
  ('support_email', 'support@example.com'),
  ('epay_api_url', ''),
  ('epay_pid', ''),
  ('epay_key', ''),
  ('pay_wxpay_enabled', '1'),
  ('pay_alipay_enabled', '1'),
  ('pay_ecny_enabled', '1'),
  ('pay_usdt_enabled', '1'),
  ('type_wxpay', 'wxpay'),
  ('type_alipay', 'alipay'),
  ('type_ecny', 'dcep'),
  ('type_usdt', 'usdt');

-- ---------------------------------------------------------------------------
-- 默认会员套餐
-- ---------------------------------------------------------------------------
INSERT OR IGNORE INTO membership_plans
  (key, name, duration_type, duration_value, price, currency, storage_quota_mb, max_file_mb, benefits, sort_order, status)
VALUES
  ('monthly', '月度会员', 'month', 1, 19.00, 'CNY', 102400, 2048,
   '100 GB 存储空间' || char(10) || '单文件最大 2 GB' || char(10) || '极速上传下载' || char(10) || '分享链接自定义有效期',
   1, 1),
  ('quarterly', '季度会员', 'month', 3, 49.00, 'CNY', 307200, 5120,
   '300 GB 存储空间' || char(10) || '单文件最大 5 GB' || char(10) || '极速上传下载' || char(10) || '分享链接自定义有效期' || char(10) || '优先客服支持',
   2, 1),
  ('annual', '年度会员', 'year', 1, 168.00, 'CNY', 1048576, 10240,
   '1 TB 存储空间' || char(10) || '单文件最大 10 GB' || char(10) || '极速上传下载' || char(10) || '分享链接自定义有效期' || char(10) || '专属 VIP 客服' || char(10) || '企业级文件安全保障',
   3, 1);
