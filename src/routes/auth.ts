import { Hono } from 'hono';
import { Env, first, getSetting, run } from '../lib';
import {
  authCookie,
  clearCookie,
  hashPassword,
  isValidEmail,
  requireAuth,
  verifyPassword,
  issueToken,
} from '../auth';
import { getQuotaInfo, type UserRow } from '../files';
import {
  CodeRateLimited,
  consumeEmailCode,
  issueEmailCode,
  passwordCodeEmail,
  sendSystemMail,
} from '../mail';

const app = new Hono<{ Bindings: Env }>();

async function publicMe(env: Env, userId: number) {
  const user = await first<UserRow>(env.DB, 'SELECT * FROM users WHERE id = ?', [userId]);
  if (!user) return null;
  const quota = await getQuotaInfo(env.DB, user);
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    role: user.role,
    status: user.status,
    membership_tier: quota.tier,
    tier_name: quota.tierName,
    membership_expires_at: quota.expiresAt,
    quota_mb: quota.quotaMb,
    max_file_mb: quota.maxFileMb,
    used_bytes: quota.usedBytes,
  };
}

app.post('/register', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const email = String(body.email || '').trim().toLowerCase();
  const password = String(body.password || '');
  const name = String(body.name || '').trim().slice(0, 50);

  if (!isValidEmail(email)) return c.json({ error: '邮箱格式不正确' }, 400);
  if (password.length < 6 || password.length > 100)
    return c.json({ error: '密码长度需为 6-100 位' }, 400);

  const exists = await first<{ id: number }>(c.env.DB, 'SELECT id FROM users WHERE email = ?', [email]);
  if (exists) return c.json({ error: '该邮箱已注册' }, 409);

  const hash = await hashPassword(password);
  const result = await run(
    c.env.DB,
    'INSERT INTO users (email, password, name) VALUES (?, ?, ?)',
    [email, hash, name || email.split('@')[0]]
  );
  const id = Number(result.meta.last_row_id);
  const token = await issueToken(c.env, { id, email, role: 'user', name: name || email.split('@')[0] });

  const res = c.json({ ok: true, user: await publicMe(c.env, id) });
  res.headers.append('Set-Cookie', authCookie(token));
  return res;
});

app.post('/login', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const email = String(body.email || '').trim().toLowerCase();
  const password = String(body.password || '');
  if (!email || !password) return c.json({ error: '请输入邮箱和密码' }, 400);

  const user = await first<UserRow & { password: string }>(
    c.env.DB,
    'SELECT * FROM users WHERE email = ?',
    [email]
  );
  if (!user) return c.json({ error: '邮箱或密码错误' }, 401);
  const ok = await verifyPassword(password, user.password);
  if (!ok) return c.json({ error: '邮箱或密码错误' }, 401);
  if (user.status === 'banned') return c.json({ error: '账号已被封禁，请联系管理员' }, 403);

  const token = await issueToken(c.env, { id: user.id, email: user.email, role: user.role, name: user.name });
  const res = c.json({ ok: true, user: await publicMe(c.env, user.id) });
  res.headers.append('Set-Cookie', authCookie(token));
  return res;
});

app.post('/logout', (c) => {
  const res = c.json({ ok: true });
  res.headers.append('Set-Cookie', clearCookie());
  return res;
});

app.get('/me', async (c) => {
  const token = await requireAuth(c);
  if (token instanceof Response) return token;
  const me = await publicMe(c.env, token.uid);
  if (!me) return c.json({ error: '账号不存在' }, 404);
  return c.json({ user: me });
});

// ---- 修改密码（邮箱验证码，验证码仅发往账号绑定邮箱）----
app.post('/password/code', async (c) => {
  const token = await requireAuth(c);
  if (token instanceof Response) return token;
  const user = await first<{ email: string }>(c.env.DB, 'SELECT email FROM users WHERE id = ?', [token.uid]);
  if (!user) return c.json({ error: '账号不存在' }, 404);
  const ip = c.req.header('CF-Connecting-IP') || '';
  try {
    const { code } = await issueEmailCode(c.env.DB, user.email, 'change_password', ip);
    const brand = (await getSetting(c.env.DB, 'site_name', 'BDrive 商务网盘')) || 'BDrive 商务网盘';
    await sendSystemMail(c.env, {
      to: user.email,
      subject: '【BDrive】修改密码验证码',
      html: passwordCodeEmail(brand, code),
    });
    return c.json({ ok: true, hint: '验证码已发送至账号绑定邮箱' });
  } catch (e) {
    if (e instanceof CodeRateLimited) return c.json({ error: e.message }, 429);
    return c.json({ error: '邮件发送失败，请稍后重试或联系管理员检查 SMTP 配置' }, 502);
  }
});

app.post('/password/change', async (c) => {
  const token = await requireAuth(c);
  if (token instanceof Response) return token;
  const body = await c.req.json().catch(() => ({}));
  const code = String(body.code || '').trim();
  const newPassword = String(body.new_password || '');
  if (!/^\d{6}$/.test(code)) return c.json({ error: '请输入 6 位邮箱验证码' }, 400);
  if (newPassword.length < 6 || newPassword.length > 100)
    return c.json({ error: '新密码长度需为 6-100 位' }, 400);

  const user = await first<{ email: string }>(c.env.DB, 'SELECT email FROM users WHERE id = ?', [token.uid]);
  if (!user) return c.json({ error: '账号不存在' }, 404);
  const okCode = await consumeEmailCode(c.env.DB, user.email, code, 'change_password');
  if (!okCode) return c.json({ error: '验证码错误或已过期' }, 400);

  const hash = await hashPassword(newPassword);
  await run(c.env.DB, 'UPDATE users SET password=?, updated_at=datetime(\'now\') WHERE id=?', [
    hash,
    token.uid,
  ]);
  return c.json({ ok: true });
});

app.get('/site', async (c) => {
  const keys = ['site_name', 'site_slogan', 'support_email'];
  const rows = await Promise.all(keys.map((k) => getSetting(c.env.DB, k, '')));
  return c.json({
    site_name: rows[0],
    site_slogan: rows[1],
    support_email: rows[2],
  });
});

export default app;
