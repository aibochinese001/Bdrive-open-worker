// 邮件业务层：读取 SMTP 配置、验证码签发/校验、邮件去重、HTML 模板
import { first, getSetting, getSettings, query, run, type Env } from './lib';
import { sendSmtp, type SmtpConfig, type SmtpSecurity } from './smtp';

const CODE_TTL_MIN = 10;
const RESEND_SECONDS = 60;

export async function getSmtpConfig(db: D1Database): Promise<SmtpConfig | null> {
  const s = await getSettings(db, [
    'smtp_enabled',
    'smtp_host',
    'smtp_port',
    'smtp_security',
    'smtp_user',
    'smtp_pass',
    'smtp_from_name',
  ]);
  if (s.smtp_enabled !== '1') return null;
  if (!s.smtp_host || !s.smtp_user || !s.smtp_pass) return null;
  const port = parseInt(s.smtp_port || '465', 10) || 465;
  const security: SmtpSecurity = s.smtp_security === 'starttls' ? 'starttls' : 'ssl';
  return {
    host: s.smtp_host.trim(),
    port,
    security,
    user: s.smtp_user.trim(),
    pass: s.smtp_pass,
    fromName: s.smtp_from_name || 'BDrive 商务网盘',
  };
}

export async function sendSystemMail(
  env: Env,
  msg: { to: string; subject: string; html: string }
): Promise<void> {
  const cfg = await getSmtpConfig(env.DB);
  if (!cfg) throw new Error('SMTP 未启用或未完整配置');
  await sendSmtp(cfg, { to: msg.to, subject: msg.subject, html: msg.html });
}

// ---------------------------------------------------------------------------
// 邮件去重日志
// ---------------------------------------------------------------------------
export async function hasMail(db: D1Database, key: string): Promise<boolean> {
  const row = await first<{ id: number }>(db, 'SELECT id FROM mail_log WHERE mail_key = ?', [key]);
  return !!row;
}
export async function recordMail(
  db: D1Database,
  key: string,
  toEmail: string,
  subject: string,
  status: 'sent' | 'failed',
  error = ''
): Promise<void> {
  await run(
    db,
    `INSERT OR IGNORE INTO mail_log (mail_key, to_email, subject, status, error) VALUES (?, ?, ?, ?, ?)`,
    [key, toEmail, subject, status, error.slice(0, 500)]
  );
}

// ---------------------------------------------------------------------------
// 邮箱验证码（仅存哈希）
// ---------------------------------------------------------------------------
async function sha256Hex(s: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

function gen6Code(): string {
  const buf = new Uint32Array(1);
  crypto.getRandomValues(buf);
  return String(buf[0] % 1000000).padStart(6, '0');
}

export class CodeRateLimited extends Error {}

// 签发验证码；返回发送用验证码与脱敏邮箱
export async function issueEmailCode(
  db: D1Database,
  email: string,
  purpose = 'change_password',
  ip = ''
): Promise<{ code: string }> {
  const recent = await first<{ created_at: string }>(
    db,
    `SELECT created_at FROM email_codes WHERE email=? AND purpose=?
     ORDER BY id DESC LIMIT 1`,
    [email, purpose]
  );
  if (recent?.created_at) {
    const last = new Date(recent.created_at.replace(' ', 'T') + 'Z').getTime();
    if (Date.now() - last < RESEND_SECONDS * 1000) throw new CodeRateLimited('发送过于频繁，请 60 秒后再试');
  }
  const code = gen6Code();
  const codeHash = await sha256Hex(`${purpose}:${email}:${code}`);
  // 旧的未消费验证码作废，保证只有最新一封有效
  await run(
    db,
    `UPDATE email_codes SET consumed=1 WHERE email=? AND purpose=? AND consumed=0`,
    [email, purpose]
  );
  await run(
    db,
    `INSERT INTO email_codes (email, purpose, code_hash, expires_at, ip)
     VALUES (?, ?, ?, datetime('now','+${CODE_TTL_MIN} minutes'), ?)`,
    [email, purpose, codeHash, ip]
  );
  return { code };
}

// 校验验证码，成功即标记消费
export async function consumeEmailCode(
  db: D1Database,
  email: string,
  code: string,
  purpose = 'change_password'
): Promise<boolean> {
  const rows = await query<{ id: number; code_hash: string; attempts: number }>(
    db,
    `SELECT id, code_hash, attempts FROM email_codes
     WHERE email=? AND purpose=? AND consumed=0 AND datetime(expires_at) > datetime('now')
     ORDER BY id DESC LIMIT 1`,
    [email, purpose]
  );
  const row = rows[0];
  if (!row) return false;
  const expect = await sha256Hex(`${purpose}:${email}:${code}`);
  let match = expect.length === row.code_hash.length;
  if (match) {
    let diff = 0;
    for (let i = 0; i < expect.length; i++) {
      diff |= expect.charCodeAt(i) ^ row.code_hash.charCodeAt(i);
    }
    match = diff === 0;
  }
  if (!match) {
    const attempts = row.attempts + 1;
    if (attempts >= 5) {
      await run(db, `UPDATE email_codes SET consumed=1, attempts=? WHERE id=?`, [attempts, row.id]);
    } else {
      await run(db, `UPDATE email_codes SET attempts=? WHERE id=?`, [attempts, row.id]);
    }
    return false;
  }
  await run(db, `UPDATE email_codes SET consumed=1 WHERE id=?`, [row.id]);
  return true;
}

// ---------------------------------------------------------------------------
// 时间：UTC 存储 -> UTC+8 展示
// ---------------------------------------------------------------------------
export function toCST(utcText: string): string {
  const d = new Date(utcText.replace(' ', 'T') + 'Z');
  if (Number.isNaN(d.getTime())) return utcText;
  const cst = new Date(d.getTime() + 8 * 3600 * 1000);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${cst.getUTCFullYear()}-${p(cst.getUTCMonth() + 1)}-${p(cst.getUTCDate())} ${p(
    cst.getUTCHours()
  )}:${p(cst.getUTCMinutes())}`;
}

// ---------------------------------------------------------------------------
// 邮件 HTML 模板
// ---------------------------------------------------------------------------
function layout(brand: string, title: string, body: string, url = '/'): string {
  const link = url.startsWith('http') ? url : 'https://your-worker.workers.dev' + url;
  return `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#0a1024;font-family:-apple-system,'Segoe UI','Microsoft YaHei',Helvetica,Arial,sans-serif;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#0a1024;padding:28px 12px;">
    <tr><td align="center">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#101832;border:1px solid #2a3563;border-radius:16px;overflow:hidden;">
        <tr><td style="background:linear-gradient(135deg,#3b82f6,#8b5cf6);padding:24px 28px;">
          <div style="font-size:20px;font-weight:800;color:#fff;">☁ ${brand}</div>
        </td></tr>
        <tr><td style="padding:30px 28px;color:#d7def5;">
          <h1 style="margin:0 0 16px;font-size:20px;color:#fff;">${title}</h1>
          ${body}
        </td></tr>
        <tr><td style="padding:0 28px 28px;">
          <a href="${link}" style="display:inline-block;background:linear-gradient(135deg,#3b82f6,#8b5cf6);color:#fff;text-decoration:none;font-weight:600;padding:12px 26px;border-radius:10px;">打开 BDrive</a>
        </td></tr>
        <tr><td style="padding:18px 28px;border-top:1px solid #2a3563;color:#7e8bb5;font-size:12px;line-height:1.7;">
          这是一封由 ${brand} 自动发送的邮件，请勿直接回复。如非本人操作，请忽略本邮件或联系客服。
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;
}

export function passwordCodeEmail(brand: string, code: string): string {
  const body = `
    <p style="line-height:1.8;margin:0 0 14px;">你正在进行 <b style="color:#fff;">修改登录密码</b> 操作，验证码为：</p>
    <div style="text-align:center;margin:8px 0 22px;">
      <span style="display:inline-block;font-size:34px;font-weight:800;letter-spacing:10px;color:#fff;background:rgba(99,102,241,.18);border:1px solid #4b57a8;border-radius:12px;padding:14px 22px 14px 32px;">${code}</span>
    </div>
    <p style="line-height:1.8;margin:0;color:#9fb0d4;font-size:13px;">验证码 ${CODE_TTL_MIN} 分钟内有效，请勿泄露给任何人。BDrive 工作人员不会向你索取验证码。</p>`;
  return layout(brand, '修改密码验证码', body, '/drive.html');
}

export function expiryReminderEmail(
  brand: string,
  p: { planName: string; expiryLocal: string; daysLeft: number; url: string }
): string {
  const body = `
    <p style="line-height:1.8;margin:0 0 12px;">你好，你的 <b style="color:#fff;">${p.planName}</b> 会员将于 <b style="color:#fff;">${p.expiryLocal}</b>（北京时间）到期，距今约 ${p.daysLeft} 天。</p>
    <p style="line-height:1.8;margin:0 0 12px;">到期后账号将自动回落到免费版存储额度，已有文件不会被删除，但在用量回落到免费额度内之前无法继续上传。</p>
    <p style="line-height:1.8;margin:0 0 20px;color:#c3cff2;">如需继续享受大容量与高速服务，欢迎提前续费。</p>`;
  return layout(brand, '会员即将到期提醒', body, p.url);
}

const METHOD_LABEL: Record<string, string> = {
  wxpay: '微信支付',
  alipay: '支付宝',
  ecny: '数字人民币',
  usdt: 'USDT',
};

export function orderInvoiceEmail(
  brand: string,
  o: { order_no: string; plan_name: string; amount: number; currency: string; method: string; paid_at: string | null }
): string {
  const sym = (o.currency || 'CNY') === 'CNY' ? '¥' : '';
  const paidLocal = o.paid_at ? toCST(o.paid_at) : '-';
  const body = `
    <p style="line-height:1.8;margin:0 0 16px;">感谢你的购买，会员权益已开通。以下是本次订单凭证：</p>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;background:rgba(255,255,255,.03);border:1px solid #2a3563;border-radius:10px;overflow:hidden;margin-bottom:20px;">
      ${[
        ['订单号', o.order_no],
        ['套餐', o.plan_name],
        ['支付方式', METHOD_LABEL[o.method] || o.method],
        ['支付时间', paidLocal + '（北京时间）'],
      ]
        .map(
          ([k, v]) =>
            `<tr><td style="padding:11px 16px;color:#9fb0d4;border-bottom:1px solid #22305c;width:110px;">${k}</td><td style="padding:11px 16px;color:#fff;border-bottom:1px solid #22305c;">${v}</td></tr>`
        )
        .join('')}
      <tr><td style="padding:13px 16px;color:#9fb0d4;">实付金额</td><td style="padding:13px 16px;color:#fff;font-size:20px;font-weight:800;">${sym}${Number(o.amount).toFixed(2)}</td></tr>
    </table>
    <p style="line-height:1.8;margin:0;color:#9fb0d4;font-size:13px;">你可以随时在「我的网盘 → 我的订单」中查看订单详情。</p>`;
  return layout(brand, '订单支付成功凭证（Invoice）', body, '/orders.html');
}
