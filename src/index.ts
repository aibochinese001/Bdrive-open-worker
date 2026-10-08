import { Hono } from 'hono';
import type { Env } from './lib';
import authRoutes from './routes/auth';
import driveRoutes from './routes/drive';
import shareRoutes from './routes/share';
import payRoutes from './routes/pay';
import adminRoutes from './routes/admin';
import scheduledHandler from './cron';
import { supportRoutes } from './support-proxy';

type AppEnv = { Bindings: Env };

const app = new Hono<AppEnv>();

app.use('*', async (c, next) => {
  await next();
  c.header('X-Content-Type-Options', 'nosniff');
  c.header('X-Frame-Options', 'SAMEORIGIN');
  c.header('Referrer-Policy', 'strict-origin-when-cross-origin');
});

app.get('/health', (c) => c.json({ ok: true, service: 'bdrive', time: new Date().toISOString() }));

app.route('/api/auth', authRoutes);
app.route('/api', payRoutes);
app.route('/api/drive', driveRoutes);
app.route('/api/public', shareRoutes);
app.route('/api/admin', adminRoutes);

// 在线客服同源反向代理（/support/* → https://chat.example.com/*），解决第三方 iframe 被拦截
app.route('/support', supportRoutes);
app.get('/support', (c) => c.redirect('/support/', 302));

// 短链分享：/s/<token> → 分享页
app.get('/s/:token', (c) => {
  const token = encodeURIComponent(c.req.param('token'));
  return c.redirect(`/share.html?token=${token}`, 302);
});

app.all('*', async (c) => {
  if (c.req.path.startsWith('/api/')) return c.json({ error: '接口不存在' }, 404);
  const asset = await c.env.ASSETS.fetch(c.req.raw.clone()).catch(() => null);
  if (asset && asset.status !== 404) return asset;
  return c.redirect('/login.html', 302);
});

app.onError((err, c) => {
  console.error('Unhandled error:', err);
  if (c.req.path.startsWith('/api/')) {
    return c.json({ error: '服务器内部错误' }, 500);
  }
  return c.text('服务器内部错误', 500);
});

// 所有非 API 页面交给静态资源
app.all('*', (c) => c.env.ASSETS.fetch(c.req.raw.clone()));

export default {
  fetch: app.fetch,
  scheduled: scheduledHandler.scheduled,
};
