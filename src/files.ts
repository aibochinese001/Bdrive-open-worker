import { first, getSetting, query, run } from './lib';

export type UserRow = {
  id: number;
  email: string;
  name: string;
  role: string;
  status: string;
  quota_override_mb: number | null;
  membership_tier: string;
  membership_expires_at: string | null;
};

export type PlanRow = {
  id: number;
  key: string;
  name: string;
  duration_type: string;
  duration_value: number;
  price: number;
  currency: string;
  storage_quota_mb: number;
  max_file_mb: number;
  benefits: string;
  sort_order: number;
  status: number;
};

export type QuotaInfo = {
  tier: string;
  tierName: string;
  expiresAt: string | null;
  active: boolean;
  quotaMb: number;
  maxFileMb: number;
  usedBytes: number;
};

export function isMembershipActive(user: Pick<UserRow, 'membership_expires_at'>): boolean {
  return !!user.membership_expires_at && new Date(user.membership_expires_at).getTime() > Date.now();
}

export async function getActivePlan(
  db: D1Database,
  user: Pick<UserRow, 'membership_tier' | 'membership_expires_at'>
): Promise<PlanRow | null> {
  if (!isMembershipActive(user)) return null;
  return await first<PlanRow>(db, 'SELECT * FROM membership_plans WHERE key = ? AND status = 1', [
    user.membership_tier,
  ]);
}

export async function getQuotaInfo(db: D1Database, user: UserRow): Promise<QuotaInfo> {
  const freeQuota = parseInt((await getSetting(db, 'free_quota_mb', '1024')) || '1024', 10);
  const freeMax = parseInt((await getSetting(db, 'free_max_file_mb', '100')) || '100', 10);
  const usedRow = await first<{ s: number }>(
    db,
    "SELECT COALESCE(SUM(size),0) AS s FROM files WHERE user_id = ? AND kind = 'file'",
    [user.id]
  );
  const active = isMembershipActive(user);
  const plan = active
    ? await first<PlanRow>(db, 'SELECT * FROM membership_plans WHERE key = ? AND status = 1', [
        user.membership_tier,
      ])
    : null;

  let quotaMb = freeQuota;
  let maxFileMb = freeMax;
  let tierName = '免费版';
  if (plan) {
    quotaMb = plan.storage_quota_mb;
    maxFileMb = plan.max_file_mb;
    tierName = plan.name;
  }
  if (user.quota_override_mb != null && user.quota_override_mb >= 0) {
    quotaMb = user.quota_override_mb;
  }
  return {
    tier: plan ? plan.key : 'free',
    tierName,
    expiresAt: active ? user.membership_expires_at : null,
    active,
    quotaMb,
    maxFileMb,
    usedBytes: usedRow?.s ?? 0,
  };
}

// 校验同目录下名称不重复
export async function nameExists(
  db: D1Database,
  userId: number,
  parentId: number | null,
  name: string,
  excludeId: number | null = null
): Promise<boolean> {
  const trimmed = name.trim();
  if (parentId == null) {
    const row = await first<{ id: number }>(
      db,
      'SELECT id FROM files WHERE user_id = ? AND parent_id IS NULL AND name = ?' +
        (excludeId ? ' AND id != ?' : '') +
        ' LIMIT 1',
      excludeId ? [userId, trimmed, excludeId] : [userId, trimmed]
    );
    return !!row;
  }
  const row = await first<{ id: number }>(
    db,
    'SELECT id FROM files WHERE user_id = ? AND parent_id = ? AND name = ?' +
      (excludeId ? ' AND id != ?' : '') +
      ' LIMIT 1',
    excludeId ? [userId, parentId, trimmed, excludeId] : [userId, parentId, trimmed]
  );
  return !!row;
}

export type FileRow = {
  id: number;
  user_id: number;
  parent_id: number | null;
  name: string;
  kind: string;
  size: number;
  mime: string;
  r2_key: string | null;
  created_at: string;
  updated_at: string;
};

export async function getUserFile(
  db: D1Database,
  userId: number,
  fileId: number
): Promise<FileRow | null> {
  return await first<FileRow>(db, 'SELECT * FROM files WHERE id = ? AND user_id = ?', [fileId, userId]);
}

// 递归收集某文件夹下的所有后代（含自身），依赖 SQLite 递归 CTE
export async function collectDescendants(
  db: D1Database,
  userId: number,
  folderId: number
): Promise<FileRow[]> {
  return await query<FileRow>(
    db,
    `WITH RECURSIVE subtree(id) AS (
       SELECT id FROM files WHERE id = ? AND user_id = ?
       UNION ALL
       SELECT f.id FROM files f JOIN subtree s ON f.parent_id = s.id WHERE f.user_id = ?
     )
     SELECT f.* FROM files f JOIN subtree s ON f.id = s.id`,
    [folderId, userId, userId]
  );
}

// 计算会员到期时间；forever 返回 null（永久）
export function calcExpiry(
  plan: Pick<PlanRow, 'duration_type' | 'duration_value'>,
  base?: Date | null
): string | null {
  if (plan.duration_type === 'forever') return null;
  const d = base && base.getTime() > Date.now() ? new Date(base) : new Date();
  if (plan.duration_type === 'day') d.setDate(d.getDate() + plan.duration_value);
  else if (plan.duration_type === 'month') d.setMonth(d.getMonth() + plan.duration_value);
  else if (plan.duration_type === 'year') d.setFullYear(d.getFullYear() + plan.duration_value);
  return d.toISOString().replace('T', ' ').slice(0, 19);
}

export async function activateMembership(
  db: D1Database,
  userId: number,
  plan: PlanRow
): Promise<void> {
  const cur = await first<{ membership_expires_at: string | null }>(
    db,
    'SELECT membership_expires_at FROM users WHERE id = ?',
    [userId]
  );
  const base = cur?.membership_expires_at ? new Date(cur.membership_expires_at.replace(' ', 'T') + 'Z') : null;
  const expires = calcExpiry(plan, base);
  await run(
    db,
    "UPDATE users SET membership_tier = ?, membership_expires_at = ?, updated_at = datetime('now') WHERE id = ?",
    [plan.key, expires, userId]
  );
}

// 生成分享 token（12 位）与提取码（4 位）
const TOKEN_CHARS = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
export function genShareToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  let s = '';
  for (const b of bytes) s += TOKEN_CHARS[b % TOKEN_CHARS.length];
  return s;
}
export function genPasscode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(4));
  let s = '';
  for (const b of bytes) s += String(b % 10);
  return s;
}

export function sanitizeFileName(name: string): string {
  // 去掉路径分隔符与控制字符，避免逃逸目录语义
  return name
    .replace(/[\\/]+/g, '_')
    .replace(/[\x00-\x1f]/g, '')
    .replace(/^\.+/, '')
    .trim()
    .slice(0, 200) || '未命名';
}

export function isFolder(row: Pick<FileRow, 'kind'>): boolean {
  return row.kind === 'folder';
}
