import { Hono } from 'hono';
import { Env, first, getSettings, query, run } from '../lib';
import { hashPassword, requireAdmin, type JWTPayload } from '../auth';
import { PlanRow } from '../files';

const app = new Hono<{ Bindings: Env; Variables: { admin: JWTPayload } }>();

app.use('*', async (c, next) => {
  const admin = await requireAdmin(c);
  if (admin instanceof Response) return admin;
  c.set('admin', admin);
  await next();
});

const SETTING_KEYS = [
  'site_name',
  'site_slogan',
  'support_email',
  'free_quota_mb',
  'free_max_file_mb',
  'epay_api_url',
  'epay_pid',
  'epay_key',
  'pay_wxpay_enabled',
  'pay_alipay_enabled',
  'pay_ecny_enabled',
  'pay_usdt_enabled',
  'type_wxpay',
  'type_alipay',
  'type_ecny',
  'type_usdt',
  'smtp_enabled',
  'smtp_host',
  'smtp_port',
  'smtp_security',
  'smtp_user',
  'smtp_pass',
  'smtp_from_name',
];

function paging(c: any): { page: number; size: number; offset: number } {
  const page = Math.max(1, parseInt(c.req.query('page') || '1', 10) || 1);
  const size = Math.min(100, Math.max(1, parseInt(c.req.query('size') || '20', 10) || 20));
  return { page, size, offset: (page - 1) * size };
}

// ---- 仪表盘 ----
app.get('/stats', async (c) => {
  const [users, banned, files, folders, shares, orders, paidOrders] = await Promise.all([
    first<{ n: number }>(c.env.DB, 'SELECT COUNT(*) n FROM users'),
    first<{ n: number }>(c.env.DB, "SELECT COUNT(*) n FROM users WHERE status='banned'"),
    first<{ n: number; s: number }>(c.env.DB, "SELECT COUNT(*) n, COALESCE(SUM(size),0) s FROM files WHERE kind='file'"),
    first<{ n: number }>(c.env.DB, "SELECT COUNT(*) n FROM files WHERE kind='folder'"),
    first<{ n: number }>(c.env.DB, "SELECT COUNT(*) n FROM shares WHERE status='active'"),
    first<{ n: number }>(c.env.DB, 'SELECT COUNT(*) n FROM orders'),
    first<{ n: number; s: number }>(c.env.DB, "SELECT COUNT(*) n, COALESCE(SUM(amount),0) s FROM orders WHERE status='paid'"),
  ]);
  const today = await first<{ n: number; s: number }>(
    c.env.DB,
    "SELECT COUNT(*) n, COALESCE(SUM(amount),0) s FROM orders WHERE status='paid' AND date(paid_at)=date('now')"
  );
  return c.json({
    users: users?.n ?? 0,
    banned: banned?.n ?? 0,
    files: files?.n ?? 0,
    folders: folders?.n ?? 0,
    storage_bytes: files?.s ?? 0,
    active_shares: shares?.n ?? 0,
    orders: orders?.n ?? 0,
    paid_orders: paidOrders?.n ?? 0,
    revenue: paidOrders?.s ?? 0,
    today_orders: today?.n ?? 0,
    today_revenue: today?.s ?? 0,
  });
});

// ---- 用户管理 ----
app.get('/users', async (c) => {
  const { page, size, offset } = paging(c);
  const q = String(c.req.query('q') || '').trim();
  const where = q ? 'WHERE email LIKE ? OR name LIKE ?' : '';
  const params = q ? [`%${q}%`, `%${q}%`] : [];
  const total = await first<{ n: number }>(c.env.DB, `SELECT COUNT(*) n FROM users ${where}`, params);
  const users = await query<any>(
    c.env.DB,
    `SELECT u.id, u.email, u.name, u.role, u.status, u.quota_override_mb,
            u.membership_tier, u.membership_expires_at, u.created_at,
            COALESCE((SELECT SUM(f.size) FROM files f WHERE f.user_id = u.id AND f.kind='file'),0) AS used_bytes,
            (SELECT COUNT(*) FROM files f WHERE f.user_id = u.id) AS file_count
     FROM users u ${where}
     ORDER BY u.id DESC LIMIT ? OFFSET ?`,
    [...params, size, offset]
  );
  return c.json({ users, total: total?.n ?? 0, page, size });
});

app.post('/users/:id/role', async (c) => {
  const id = parseInt(c.req.param('id'), 10);
  const body = await c.req.json();
  const role = body.role === 'admin' ? 'admin' : 'user';
  await run(c.env.DB, "UPDATE users SET role=?, updated_at=datetime('now') WHERE id=?", [role, id]);
  return c.json({ ok: true });
});

app.post('/users/:id/status', async (c) => {
  const id = parseInt(c.req.param('id'), 10);
  const body = await c.req.json();
  const status = body.status === 'banned' ? 'banned' : 'active';
  if (id === (c.get('admin') as { uid: number }).uid)
    return c.json({ error: '不能封禁当前登录账号' }, 400);
  await run(c.env.DB, 'UPDATE users SET status=? WHERE id=?', [status, id]);
  return c.json({ ok: true });
});

app.post('/users/:id/quota', async (c) => {
  const id = parseInt(c.req.param('id'), 10);
  const body = await c.req.json();
  let quota: number | null = null;
  if (body.quota_mb !== null && body.quota_mb !== undefined && body.quota_mb !== '') {
    quota = Math.max(0, parseInt(body.quota_mb, 10));
    if (!Number.isFinite(quota)) return c.json({ error: '配额格式不正确' }, 400);
  }
  await run(c.env.DB, 'UPDATE users SET quota_override_mb=? WHERE id=?', [quota, id]);
  return c.json({ ok: true });
});

app.post('/users/:id/membership', async (c) => {
  const id = parseInt(c.req.param('id'), 10);
  const body = await c.req.json();
  if (body.tier === 'free' || !body.tier) {
    await run(c.env.DB, "UPDATE users SET membership_tier='free', membership_expires_at=NULL WHERE id=?", [id]);
    return c.json({ ok: true });
  }
  const plan = await first<PlanRow>(c.env.DB, 'SELECT * FROM membership_plans WHERE key=?', [body.tier]);
  if (!plan) return c.json({ error: '套餐不存在' }, 404);
  let expires: string | null = null;
  if (body.expires_at) {
    const d = new Date(String(body.expires_at).replace(' ', 'T'));
    if (isNaN(d.getTime())) return c.json({ error: '到期时间格式不正确' }, 400);
    expires = d.toISOString().replace('T', ' ').slice(0, 19);
  }
  await run(c.env.DB, 'UPDATE users SET membership_tier=?, membership_expires_at=? WHERE id=?', [
    plan.key,
    expires,
    id,
  ]);
  return c.json({ ok: true });
});

app.post('/users/:id/password', async (c) => {
  const id = parseInt(c.req.param('id'), 10);
  const body = await c.req.json();
  const password = String(body.password || '');
  if (password.length < 6 || password.length > 100)
    return c.json({ error: '密码长度需为 6-100 位' }, 400);
  const hash = await hashPassword(password);
  await run(c.env.DB, 'UPDATE users SET password=? WHERE id=?', [hash, id]);
  return c.json({ ok: true });
});

app.delete('/users/:id', async (c) => {
  const id = parseInt(c.req.param('id'), 10);
  if (id === (c.get('admin') as { uid: number }).uid)
    return c.json({ error: '不能删除当前登录账号' }, 400);
  const keys = (
    await query<{ r2_key: string }>(
      c.env.DB,
      "SELECT r2_key FROM files WHERE user_id=? AND kind='file' AND r2_key IS NOT NULL",
      [id]
    )
  ).map((r) => r.r2_key);
  for (let i = 0; i < keys.length; i += 100) await c.env.BUCKET.delete(keys.slice(i, i + 100));
  await run(c.env.DB, 'DELETE FROM shares WHERE user_id=?', [id]);
  await run(c.env.DB, 'DELETE FROM files WHERE user_id=?', [id]);
  await run(c.env.DB, 'DELETE FROM orders WHERE user_id=?', [id]);
  await run(c.env.DB, 'DELETE FROM users WHERE id=?', [id]);
  return c.json({ ok: true });
});

// ---- 套餐 CRUD ----
app.get('/plans', async (c) => {
  const plans = await query<PlanRow>(
    c.env.DB,
    'SELECT * FROM membership_plans ORDER BY sort_order, id'
  );
  return c.json({ plans });
});

function parsePlan(body: any): Record<string, unknown> | string {
  const name = String(body.name || '').trim();
  if (!name) return '套餐名称不能为空';
  const durationType = ['day', 'month', 'year', 'forever'].includes(body.duration_type)
    ? body.duration_type
    : 'month';
  const durationValue = Math.max(1, parseInt(body.duration_value, 10) || 1);
  const price = Math.max(0, parseFloat(body.price) || 0);
  const storageQuotaMb = Math.max(1, parseInt(body.storage_quota_mb, 10) || 1024);
  const maxFileMb = Math.max(1, parseInt(body.max_file_mb, 10) || 100);
  const benefits = String(body.benefits || '').slice(0, 2000);
  const sortOrder = parseInt(body.sort_order, 10) || 0;
  const status = body.status === 0 || body.status === '0' ? 0 : 1;
  return { name, duration_type: durationType, duration_value: durationValue, price, currency: 'CNY', storage_quota_mb: storageQuotaMb, max_file_mb: maxFileMb, benefits, sort_order: sortOrder, status };
}

app.post('/plans', async (c) => {
  const body = await c.req.json();
  const parsed = parsePlan(body);
  if (typeof parsed === 'string') return c.json({ error: parsed }, 400);
  const key = String(body.key || '').trim().replace(/[^a-z0-9_]/gi, '_').toLowerCase() || `plan_${Date.now()}`;
  try {
    const r = await run(
      c.env.DB,
      `INSERT INTO membership_plans (key, name, duration_type, duration_value, price, currency, storage_quota_mb, max_file_mb, benefits, sort_order, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [key, parsed.name, parsed.duration_type, parsed.duration_value, parsed.price, parsed.currency,
       parsed.storage_quota_mb, parsed.max_file_mb, parsed.benefits, parsed.sort_order, parsed.status]
    );
    return c.json({ ok: true, id: Number(r.meta.last_row_id) });
  } catch (e) {
    return c.json({ error: '套餐标识已存在' }, 409);
  }
});

app.put('/plans/:id', async (c) => {
  const id = parseInt(c.req.param('id'), 10);
  const body = await c.req.json();
  const parsed = parsePlan(body);
  if (typeof parsed === 'string') return c.json({ error: parsed }, 400);
  await run(
    c.env.DB,
    `UPDATE membership_plans SET name=?, duration_type=?, duration_value=?, price=?, storage_quota_mb=?, max_file_mb=?, benefits=?, sort_order=?, status=?, updated_at=datetime('now') WHERE id=?`,
    [parsed.name, parsed.duration_type, parsed.duration_value, parsed.price,
     parsed.storage_quota_mb, parsed.max_file_mb, parsed.benefits, parsed.sort_order, parsed.status, id]
  );
  return c.json({ ok: true });
});

app.delete('/plans/:id', async (c) => {
  const id = parseInt(c.req.param('id'), 10);
  const used = await first<{ n: number }>(c.env.DB, 'SELECT COUNT(*) n FROM orders WHERE plan_id=?', [id]);
  if ((used?.n ?? 0) > 0) {
    await run(c.env.DB, 'UPDATE membership_plans SET status=0 WHERE id=?', [id]);
    return c.json({ ok: true, archived: true });
  }
  await run(c.env.DB, 'DELETE FROM membership_plans WHERE id=?', [id]);
  return c.json({ ok: true, archived: false });
});

// ---- 订单 ----
app.get('/orders', async (c) => {
  const { page, size, offset } = paging(c);
  const status = String(c.req.query('status') || '').trim();
  const where = status ? 'WHERE o.status=?' : '';
  const params: unknown[] = status ? [status] : [];
  const total = await first<{ n: number }>(
    c.env.DB,
    `SELECT COUNT(*) n FROM orders o ${where}`,
    params
  );
  const orders = await query<any>(
    c.env.DB,
    `SELECT o.*, u.email AS user_email FROM orders o
     JOIN users u ON u.id=o.user_id ${where}
     ORDER BY o.id DESC LIMIT ? OFFSET ?`,
    [...params, size, offset]
  );
  return c.json({ orders, total: total?.n ?? 0, page, size });
});

// ---- 文件 ----
app.get('/files', async (c) => {
  const { page, size, offset } = paging(c);
  const q = String(c.req.query('q') || '').trim();
  const where = q ? 'WHERE f.name LIKE ?' : '';
  const params = q ? [`%${q}%`] : [];
  const total = await first<{ n: number }>(c.env.DB, `SELECT COUNT(*) n FROM files f ${where}`, params);
  const files = await query<any>(
    c.env.DB,
    `SELECT f.id, f.user_id, f.parent_id, f.name, f.kind, f.size, f.mime, f.created_at,
            u.email AS user_email
     FROM files f JOIN users u ON u.id=f.user_id ${where}
     ORDER BY f.id DESC LIMIT ? OFFSET ?`,
    [...params, size, offset]
  );
  return c.json({ files, total: total?.n ?? 0, page, size });
});

app.delete('/files/:id', async (c) => {
  const id = parseInt(c.req.param('id'), 10);
  const rows = await query<{ id: number; r2_key: string | null; kind: string; user_id: number }>(
    c.env.DB,
    `WITH RECURSIVE subtree(id) AS (
       SELECT id FROM files WHERE id=?
       UNION ALL
       SELECT f.id FROM files f JOIN subtree s ON f.parent_id=s.id
     )
     SELECT f.id, f.r2_key, f.kind, f.user_id FROM files f JOIN subtree s ON f.id=s.id`,
    [id]
  );
  if (!rows.length) return c.json({ error: '文件不存在' }, 404);
  const userId = rows[0].user_id;
  const keys = rows.filter((r) => r.kind === 'file' && r.r2_key).map((r) => r.r2_key!) as string[];
  const ids = rows.map((r) => r.id);
  for (let i = 0; i < keys.length; i += 100) await c.env.BUCKET.delete(keys.slice(i, i + 100));
  for (let i = 0; i < ids.length; i += 50) {
    const ph = ids.slice(i, i + 50).map(() => '?').join(',');
    await run(c.env.DB, `DELETE FROM shares WHERE file_id IN (${ph})`, ids.slice(i, i + 50));
    await run(c.env.DB, `DELETE FROM files WHERE id IN (${ph}) AND user_id=?`, [
      ...ids.slice(i, i + 50),
      userId,
    ]);
  }
  return c.json({ ok: true });
});

// ---- 分享 ----
app.get('/shares', async (c) => {
  const { page, size, offset } = paging(c);
  const shares = await query<any>(
    c.env.DB,
    `SELECT s.*, f.name AS file_name, u.email AS user_email
     FROM shares s JOIN files f ON f.id=s.file_id JOIN users u ON u.id=s.user_id
     ORDER BY s.id DESC LIMIT ? OFFSET ?`,
    [size, offset]
  );
  const total = await first<{ n: number }>(c.env.DB, 'SELECT COUNT(*) n FROM shares');
  return c.json({ shares, total: total?.n ?? 0, page, size });
});

app.delete('/shares/:id', async (c) => {
  const id = parseInt(c.req.param('id'), 10);
  await run(c.env.DB, "UPDATE shares SET status='revoked' WHERE id=?", [id]);
  return c.json({ ok: true });
});

// ---- 系统设置 ----
app.get('/settings', async (c) => {
  const s = await getSettings(c.env.DB, SETTING_KEYS);
  // 授权码不回传明文，仅以是否已配置标记
  const smtpPassConfigured = s.smtp_pass ? '1' : '';
  s.smtp_pass = '';
  return c.json({ settings: s, keys: SETTING_KEYS, smtp_pass_configured: smtpPassConfigured });
});

app.put('/settings', async (c) => {
  const body = await c.req.json();
  const updates = body.settings && typeof body.settings === 'object' ? body.settings : body;
  const entries = Object.entries(updates).filter(([k]) => SETTING_KEYS.includes(k));
  if (!entries.length) return c.json({ error: '没有可保存的设置项' }, 400);
  for (const [k, v] of entries) {
    // SMTP 授权码留空表示不修改
    if (k === 'smtp_pass' && String(v ?? '') === '') continue;
    await run(
      c.env.DB,
      `INSERT INTO settings (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=datetime('now')`,
      [k, String(v ?? '')]
    );
  }
  return c.json({ ok: true, saved: entries.map(([k]) => k) });
});

// 发送 SMTP 测试邮件
app.post('/email/test', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const to = String(body.to || '').trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) return c.json({ error: '请填写正确的收件邮箱' }, 400);
  try {
    const { sendSystemMail } = await import('../mail');
    await sendSystemMail(c.env, {
      to,
      subject: 'BDrive SMTP 发信测试',
      html: '<p style="color:#0f172a;line-height:1.8">这是一封来自 BDrive 管理后台的 SMTP 测试邮件。<br/>如果你收到此邮件，说明 QQ 邮箱 SMTP 已配置成功，验证码、到期提醒与订单发票邮件均可正常发送。</p>',
    });
    return c.json({ ok: true });
  } catch (e) {
    return c.json({ error: '发送失败：' + (e instanceof Error ? e.message : String(e)) }, 502);
  }
});

export default app;
