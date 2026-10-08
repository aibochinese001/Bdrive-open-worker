// 定时任务：会员到期前 3 天邮件提醒（每天运行，幂等）
import { first, getSetting, query, type Env } from './lib';
import {
  expiryReminderEmail,
  hasMail,
  recordMail,
  sendSystemMail,
  toCST,
} from './mail';

type DueUser = {
  id: number;
  email: string;
  membership_tier: string;
  membership_expires_at: string;
};

export async function sendExpiryReminders(env: Env): Promise<{ scanned: number; sent: number; skipped: number; failed: number }> {
  const result = { scanned: 0, sent: 0, skipped: 0, failed: 0 };
  const users = await query<DueUser>(
    env.DB,
    `SELECT id, email, membership_tier, membership_expires_at FROM users
     WHERE status='active'
       AND membership_tier <> 'free'
       AND membership_expires_at IS NOT NULL
       AND datetime(membership_expires_at) > datetime('now')
       AND datetime(membership_expires_at) <= datetime('now','+3 days')
     ORDER BY membership_expires_at ASC
     LIMIT 300`
  );
  result.scanned = users.length;
  const brand = (await getSetting(env.DB, 'site_name', 'BDrive 商务网盘')) || 'BDrive 商务网盘';
  const baseUrl = (env.BASE_URL || 'https://your-worker.workers.dev').replace(/\/$/, '');

  for (const u of users) {
    const expiryDay = u.membership_expires_at.slice(0, 10); // YYYY-MM-DD（UTC）
    const mailKey = `expiry:${u.id}:${expiryDay}`;
    if (await hasMail(env.DB, mailKey)) {
      result.skipped += 1;
      continue;
    }
    const plan = await first<{ name: string }>(
      env.DB,
      'SELECT name FROM membership_plans WHERE key=? LIMIT 1',
      [u.membership_tier]
    );
    const planName = plan?.name || u.membership_tier;
    const daysLeft = Math.max(
      1,
      Math.ceil((new Date(u.membership_expires_at.replace(' ', 'T') + 'Z').getTime() - Date.now()) / 86400000)
    );
    const subject = '【BDrive】会员即将到期提醒';
    try {
      await sendSystemMail(env, {
        to: u.email,
        subject,
        html: expiryReminderEmail(brand, {
          planName,
          expiryLocal: toCST(u.membership_expires_at),
          daysLeft,
          url: baseUrl + '/pricing.html',
        }),
      });
      await recordMail(env.DB, mailKey, u.email, subject, 'sent');
      result.sent += 1;
    } catch (e) {
      await recordMail(env.DB, mailKey, u.email, subject, 'failed', e instanceof Error ? e.message : String(e));
      result.failed += 1;
    }
  }
  console.log('expiry reminders', JSON.stringify(result));
  return result;
}

export default {
  async scheduled(
    controller: ScheduledController,
    env: Env,
    ctx: ExecutionContext
  ): Promise<void> {
    ctx.waitUntil(sendExpiryReminders(env));
  },
};
