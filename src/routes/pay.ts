import { Hono } from 'hono';
import { Env, first, genOrderNo, getSetting, getSettings, json, query, run } from '../lib';
import { requireAuth } from '../auth';
import { PAY_METHODS, buildOrderParams, isPayMethod, normalizeApiUrl, verifyCallbackSign } from '../epay';
import { PlanRow, UserRow, activateMembership } from '../files';
import {
  hasMail,
  orderInvoiceEmail,
  recordMail,
  sendSystemMail,
} from '../mail';

const app = new Hono<{ Bindings: Env }>();

type OrderRow = {
  id: number;
  order_no: string;
  user_id: number;
  plan_id: number;
  plan_key: string;
  plan_name: string;
  amount: number;
  currency: string;
  method: string;
  gateway_type: string;
  status: string;
  trade_no: string | null;
  created_at: string;
  paid_at: string | null;
};

async function enabledMethods(db: D1Database): Promise<{ key: string; label: string; gateway_type: string }[]> {
  const s = await getSettings(
    db,
    PAY_METHODS.flatMap((m) => [`pay_${m.key}_enabled`, `type_${m.key}`])
  );
  return PAY_METHODS.filter((m) => s[`pay_${m.key}_enabled`] === '1').map((m) => ({
    key: m.key,
    label: m.label,
    gateway_type: s[`type_${m.key}`] || m.defaultGatewayType,
  }));
}

async function readEpayConfig(db: D1Database) {
  const s = await getSettings(db, ['epay_api_url', 'epay_pid', 'epay_key']);
  return {
    apiUrl: (s.epay_api_url || '').trim(),
    pid: (s.epay_pid || '').trim(),
    key: (s.epay_key || '').trim(),
  };
}

// 公开：会员方案 + 已启用支付方式
app.get('/plans', async (c) => {
  const plans = await query<PlanRow>(
    c.env.DB,
    'SELECT * FROM membership_plans WHERE status = 1 ORDER BY sort_order, id'
  );
  const methods = await enabledMethods(c.env.DB);
  const freeQuotaMb = parseInt((await getSetting(c.env.DB, 'free_quota_mb', '1024')) || '1024', 10);
  const freeMaxFileMb = parseInt((await getSetting(c.env.DB, 'free_max_file_mb', '100')) || '100', 10);
  return c.json({
    currency: plans[0]?.currency || 'CNY',
    free: {
      name: '免费版',
      price: 0,
      storage_quota_mb: Number.isFinite(freeQuotaMb) && freeQuotaMb > 0 ? freeQuotaMb : 1024,
      max_file_mb: Number.isFinite(freeMaxFileMb) && freeMaxFileMb > 0 ? freeMaxFileMb : 100,
    },
    plans: plans.map((p) => ({
      id: p.id,
      key: p.key,
      name: p.name,
      duration_type: p.duration_type,
      duration_value: p.duration_value,
      price: p.price,
      currency: p.currency,
      storage_quota_mb: p.storage_quota_mb,
      max_file_mb: p.max_file_mb,
      benefits: (p.benefits || '').split('\n').filter(Boolean),
    })),
    methods,
  });
});

// 创建订单并返回易支付跳转参数
app.post('/orders', async (c) => {
  const token = await requireAuth(c);
  if (token instanceof Response) return token;

  const body = await c.req.json().catch(() => ({}));
  const method = String(body.method || '');
  if (!isPayMethod(method)) return c.json({ error: '不支持的支付方式' }, 400);

  const methods = await enabledMethods(c.env.DB);
  const m = methods.find((x) => x.key === method);
  if (!m) return c.json({ error: '该支付方式未开启' }, 400);

  const plan = await first<PlanRow>(
    c.env.DB,
    'SELECT * FROM membership_plans WHERE status = 1 AND ' +
      (body.plan_id ? 'id = ?' : 'key = ?'),
    [body.plan_id ? Number(body.plan_id) : String(body.plan_key || '')]
  );
  if (!plan) return c.json({ error: '会员方案不存在或已下架' }, 404);
  if (plan.price <= 0) return c.json({ error: '该方案暂不支持在线购买' }, 400);

  const cfg = await readEpayConfig(c.env.DB);
  if (!cfg.apiUrl || !cfg.pid || !cfg.key)
    return c.json({ error: '支付通道尚未配置，请稍后再试或联系客服' }, 503);

  const orderNo = genOrderNo();
  await run(
    c.env.DB,
    `INSERT INTO orders (order_no, user_id, plan_id, plan_key, plan_name, amount, currency, method, gateway_type, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')`,
    [orderNo, token.uid, plan.id, plan.key, plan.name, plan.price, plan.currency, method, m.gateway_type]
  );

  const base = new URL(c.req.url).origin;
  const params = buildOrderParams(
    { apiUrl: cfg.apiUrl, pid: cfg.pid, key: cfg.key },
    {
      type: m.gateway_type,
      outTradeNo: orderNo,
      notifyUrl: `${base}/api/payment/callback`,
      returnUrl: `${base}/orders.html?order_no=${orderNo}`,
      name: `${plan.name}会员`,
      money: plan.price.toFixed(2),
    }
  );
  return c.json({ ok: true, submit_url: normalizeApiUrl(cfg.apiUrl), params });
});

// 我的订单
app.get('/orders', async (c) => {
  const token = await requireAuth(c);
  if (token instanceof Response) return token;
  const rows = await query<OrderRow>(
    c.env.DB,
    'SELECT * FROM orders WHERE user_id = ? ORDER BY id DESC LIMIT 100',
    [token.uid]
  );
  return c.json({ orders: rows });
});

// 查询单个订单状态
app.get('/orders/:orderNo', async (c) => {
  const token = await requireAuth(c);
  if (token instanceof Response) return token;
  const order = await first<OrderRow>(
    c.env.DB,
    'SELECT * FROM orders WHERE order_no = ? AND user_id = ?',
    [c.req.param('orderNo'), token.uid]
  );
  if (!order) return c.json({ error: '订单不存在' }, 404);
  return c.json({ order });
});

// 待支付订单重新发起支付
app.post('/orders/:orderNo/pay', async (c) => {
  const token = await requireAuth(c);
  if (token instanceof Response) return token;
  const order = await first<OrderRow>(
    c.env.DB,
    'SELECT * FROM orders WHERE order_no = ? AND user_id = ?',
    [c.req.param('orderNo'), token.uid]
  );
  if (!order) return c.json({ error: '订单不存在' }, 404);
  if (order.status === 'paid') return c.json({ error: '订单已支付' }, 400);

  const cfg = await readEpayConfig(c.env.DB);
  if (!cfg.apiUrl || !cfg.pid || !cfg.key)
    return c.json({ error: '支付通道尚未配置，请稍后再试或联系客服' }, 503);

  const base = new URL(c.req.url).origin;
  const params = buildOrderParams(
    { apiUrl: cfg.apiUrl, pid: cfg.pid, key: cfg.key },
    {
      type: order.gateway_type,
      outTradeNo: order.order_no,
      notifyUrl: `${base}/api/payment/callback`,
      returnUrl: `${base}/orders.html?order_no=${order.order_no}`,
      name: `${order.plan_name}会员`,
      money: Number(order.amount).toFixed(2),
    }
  );
  return c.json({ ok: true, submit_url: normalizeApiUrl(cfg.apiUrl), params });
});

// 易支付异步通知（GET / POST 均可能）
async function handleCallback(c: any): Promise<Response> {
  let data: Record<string, string> = {};
  if (c.req.method === 'POST') {
    const form = await c.req.parseBody().catch(() => ({}));
    for (const [k, v] of Object.entries(form)) data[k] = String(v);
  } else {
    const q = c.req.queries();
    for (const [k, v] of Object.entries(q)) data[k] = Array.isArray(v) ? v[0] : String(v);
  }

  const sign = String(data.sign || '');
  const outTradeNo = String(data.out_trade_no || '');
  const tradeNo = String(data.trade_no || '');
  const tradeStatus = String(data.trade_status || '');
  const money = parseFloat(String(data.money || '0'));

  const cfg = await readEpayConfig(c.env.DB);
  if (!cfg.key) return new Response('fail: not configured');
  if (!sign || !verifyCallbackSign(data, cfg.key, sign)) return new Response('fail: sign error');

  const order = await first<OrderRow>(c.env.DB, 'SELECT * FROM orders WHERE order_no = ?', [outTradeNo]);
  if (!order) return new Response('fail: order not found');
  // 金额校验，防止篡改
  if (Math.abs(money - Number(order.amount)) > 0.001) return new Response('fail: amount mismatch');

  if (tradeStatus === 'TRADE_SUCCESS' && order.status === 'pending') {
    const paid = await run(
      c.env.DB,
      "UPDATE orders SET status='paid', trade_no=?, paid_at=datetime('now') WHERE id=? AND status='pending'",
      [tradeNo, order.id]
    );
    // changes=1 才真正抢到该订单的兑付权（幂等）
    if (paid.meta.changes === 1) {
      const plan = await first<PlanRow>(c.env.DB, 'SELECT * FROM membership_plans WHERE id = ?', [order.plan_id]);
      if (plan) await activateMembership(c.env.DB, order.user_id, plan);

      // 订单发票邮件（幂等；失败不影响支付结果）
      const mailKey = `invoice:${order.order_no}`;
      try {
        if (!(await hasMail(c.env.DB, mailKey))) {
          const buyer = await first<{ email: string }>(
            c.env.DB,
            'SELECT email FROM users WHERE id=?',
            [order.user_id]
          );
          if (buyer?.email) {
            const brand = (await getSetting(c.env.DB, 'site_name', 'BDrive 商务网盘')) || 'BDrive 商务网盘';
            const paidAt = new Date().toISOString().replace('T', ' ').slice(0, 19);
            const subject = '【BDrive】订单支付成功凭证';
            await sendSystemMail(c.env, {
              to: buyer.email,
              subject,
              html: orderInvoiceEmail(brand, {
                order_no: order.order_no,
                plan_name: order.plan_name,
                amount: Number(order.amount),
                currency: order.currency,
                method: order.method,
                paid_at: paidAt,
              }),
            });
            await recordMail(c.env.DB, mailKey, buyer.email, subject, 'sent');
          }
        }
      } catch (mailErr) {
        await recordMail(
          c.env.DB,
          mailKey,
          order.order_no,
          '订单发票',
          'failed',
          mailErr instanceof Error ? mailErr.message : String(mailErr)
        );
      }
    }
  }
  return new Response('success');
}
app.post('/payment/callback', handleCallback);
app.get('/payment/callback', handleCallback);

export default app;
