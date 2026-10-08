import { Hono } from 'hono';
import { Env, first, json, query, run, stmt, genOrderNo as _no, randHex } from '../lib';
import { requireAuth } from '../auth';
import {
  FileRow,
  UserRow,
  collectDescendants,
  genPasscode,
  genShareToken,
  getQuotaInfo,
  getUserFile,
  nameExists,
  sanitizeFileName,
} from '../files';

const app = new Hono<{ Bindings: Env }>();

type ShareRow = {
  id: number;
  token: string;
  file_id: number;
  passcode: string | null;
  expires_at: string | null;
  downloads: number;
  max_downloads: number | null;
  status: string;
  created_at: string;
};

async function loadUser(c: any): Promise<UserRow | Response> {
  const token = await requireAuth(c);
  if (token instanceof Response) return token;
  const user = await first<UserRow>(c.env.DB, 'SELECT * FROM users WHERE id = ?', [token.uid]);
  if (!user) return json({ error: '账号不存在' }, 401);
  return user;
}

// 递归向上查祖先，返回面包屑（根 → 当前父级）
async function breadcrumbs(db: D1Database, parentId: number | null): Promise<{ id: number; name: string }[]> {
  if (parentId == null) return [];
  const rows = await query<{ id: number; name: string; depth: number }>(
    db,
    `WITH RECURSIVE chain(id, name, parent_id, depth) AS (
       SELECT id, name, parent_id, 0 FROM files WHERE id = ?
       UNION ALL
       SELECT f.id, f.name, f.parent_id, ch.depth + 1
       FROM files f JOIN chain ch ON ch.parent_id = f.id
     )
     SELECT id, name, depth FROM chain ORDER BY depth DESC`,
    [parentId]
  );
  return rows.map((r) => ({ id: r.id, name: r.name }));
}

function serializeFile(f: FileRow & { share_token?: string | null }) {
  return {
    id: f.id,
    parent_id: f.parent_id,
    name: f.name,
    kind: f.kind,
    size: f.size,
    mime: f.mime,
    created_at: f.created_at,
    updated_at: f.updated_at,
    share_token: f.share_token ?? null,
  };
}

// ---- 列表 ----
app.get('/list', async (c) => {
  const user = await loadUser(c);
  if (user instanceof Response) return user;

  const pidParam = c.req.query('parent_id');
  let parentId: number | null = null;
  if (pidParam !== undefined && pidParam !== '' && pidParam !== '0') {
    parentId = parseInt(pidParam, 10);
    if (!Number.isInteger(parentId)) return c.json({ error: '目录参数无效' }, 400);
    const parent = await getUserFile(c.env.DB, user.id, parentId);
    if (!parent || parent.kind !== 'folder') return c.json({ error: '目录不存在' }, 404);
  }

  const crumbs = await breadcrumbs(c.env.DB, parentId);
  const rows = await query<FileRow & { share_token: string | null }>(
    c.env.DB,
    `SELECT f.*, sh.token AS share_token
     FROM files f
     LEFT JOIN shares sh ON sh.file_id = f.id AND sh.status = 'active'
     WHERE f.user_id = ? AND ${parentId == null ? 'f.parent_id IS NULL' : 'f.parent_id = ?'}
     ORDER BY f.kind DESC, f.id DESC`,
    parentId == null ? [user.id] : [user.id, parentId]
  );
  const quota = await getQuotaInfo(c.env.DB, user);

  return c.json({
    parent_id: parentId,
    breadcrumbs: crumbs,
    folders: rows.filter((r) => r.kind === 'folder').map(serializeFile),
    files: rows.filter((r) => r.kind === 'file').map(serializeFile),
    quota: {
      tier: quota.tier,
      tier_name: quota.tierName,
      expires_at: quota.expiresAt,
      quota_mb: quota.quotaMb,
      max_file_mb: quota.maxFileMb,
      used_bytes: quota.usedBytes,
    },
  });
});

// ---- 搜索 ----
app.get('/search', async (c) => {
  const user = await loadUser(c);
  if (user instanceof Response) return user;
  const q = String(c.req.query('q') || '').trim().slice(0, 100);
  if (!q) return c.json({ files: [] });
  const like = '%' + q.replace(/[%_]/g, (m) => '\\' + m) + '%';
  const rows = await query<FileRow>(
    c.env.DB,
    "SELECT * FROM files WHERE user_id = ? AND name LIKE ? ESCAPE '\\' ORDER BY id DESC LIMIT 50",
    [user.id, like]
  );
  return c.json({ files: rows.map(serializeFile) });
});

// ---- 新建文件夹 ----
app.post('/folder', async (c) => {
  const user = await loadUser(c);
  if (user instanceof Response) return user;
  const body = await c.req.json().catch(() => ({}));
  const name = sanitizeFileName(String(body.name || ''));
  if (!name) return c.json({ error: '文件夹名称不能为空' }, 400);
  let parentId: number | null = body.parent_id ? parseInt(body.parent_id, 10) : null;
  if (parentId != null) {
    if (!Number.isInteger(parentId)) return c.json({ error: '目录参数无效' }, 400);
    const parent = await getUserFile(c.env.DB, user.id, parentId);
    if (!parent || parent.kind !== 'folder') return c.json({ error: '目标目录不存在' }, 404);
  }
  if (await nameExists(c.env.DB, user.id, parentId, name))
    return c.json({ error: '同名文件夹/文件已存在' }, 409);

  const result = await run(
    c.env.DB,
    'INSERT INTO files (user_id, parent_id, name, kind) VALUES (?, ?, ?, ?)',
    [user.id, parentId, name, 'folder']
  );
  return c.json({ ok: true, id: Number(result.meta.last_row_id) });
});

// ---- 上传文件（流式直传 R2） ----
app.put('/upload', async (c) => {
  const user = await loadUser(c);
  if (user instanceof Response) return user;

  const qParent = c.req.query('parent_id');
  let parentId: number | null = qParent && qParent !== '0' ? parseInt(qParent, 10) : null;
  if (parentId != null && !Number.isInteger(parentId))
    return c.json({ error: '目录参数无效' }, 400);
  if (parentId != null) {
    const parent = await getUserFile(c.env.DB, user.id, parentId);
    if (!parent || parent.kind !== 'folder') return c.json({ error: '目标目录不存在' }, 404);
  }

  const rawName = c.req.query('name') || '未命名文件';
  const name = sanitizeFileName(decodeURIComponent(rawName));
  const declaredSize = parseInt(c.req.query('size') || '0', 10);
  if (!Number.isFinite(declaredSize) || declaredSize <= 0)
    return c.json({ error: '缺少文件大小参数' }, 400);

  const quota = await getQuotaInfo(c.env.DB, user);
  const maxBytes = quota.maxFileMb * 1024 * 1024;
  const quotaBytes = quota.quotaMb * 1024 * 1024;
  if (declaredSize > maxBytes)
    return c.json({ error: `单文件不能超过 ${quota.maxFileMb} MB，升级会员可上传更大文件` }, 413);
  if (quota.usedBytes + declaredSize > quotaBytes)
    return c.json({ error: '存储空间不足，请升级会员或清理文件' }, 507);

  if (await nameExists(c.env.DB, user.id, parentId, name))
    return c.json({ error: '同名文件已存在，请先重命名或删除原文件' }, 409);

  const mime = (c.req.query('mime') || 'application/octet-stream').slice(0, 200);
  const r2Key = `u${user.id}/${randHex(16)}/${name}`;

  // 流式写入 R2
  const obj = await c.env.BUCKET.put(r2Key, c.req.raw.body, {
    httpMetadata: { contentType: mime },
  });
  const actualSize = obj.size;
  if (actualSize !== declaredSize) {
    await c.env.BUCKET.delete(r2Key);
    return c.json({ error: '上传大小与声明不一致，请重试' }, 400);
  }
  if (quota.usedBytes + actualSize > quotaBytes) {
    await c.env.BUCKET.delete(r2Key);
    return c.json({ error: '存储空间不足，请升级会员或清理文件' }, 507);
  }

  const result = await run(
    c.env.DB,
    'INSERT INTO files (user_id, parent_id, name, kind, size, mime, r2_key) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [user.id, parentId, name, 'file', actualSize, mime, r2Key]
  );
  const created = await first<FileRow>(c.env.DB, 'SELECT * FROM files WHERE id = ?', [
    Number(result.meta.last_row_id),
  ]);
  return c.json({ ok: true, file: created ? serializeFile(created) : null });
});

// ---- 下载（支持 Range，便于视频/音频拖动） ----
app.get('/:id/download', async (c) => {
  const user = await loadUser(c);
  if (user instanceof Response) return user;
  const id = parseInt(c.req.param('id'), 10);
  const file = await getUserFile(c.env.DB, user.id, id);
  if (!file || file.kind !== 'file' || !file.r2_key) return c.json({ error: '文件不存在' }, 404);

  const range = c.req.header('range') || c.req.header('Range');
  const filenameStar = encodeURIComponent(file.name).replace(/['()]/g, '');
  const disposition = `attachment; filename*=UTF-8''${filenameStar}`;

  if (range) {
    const m = /bytes=(\d*)-(\d*)/.exec(range);
    if (m) {
      const total = file.size;
      let s: number;
      let e: number;
      if (m[1] !== '') {
        s = parseInt(m[1], 10);
        e = m[2] !== '' ? Math.min(parseInt(m[2], 10), total - 1) : total - 1;
      } else {
        const suffix = Math.max(0, parseInt(m[2], 10) || 0);
        s = Math.max(0, total - suffix);
        e = total - 1;
      }
      if (s >= total || s > e) {
        return new Response(null, {
          status: 416,
          headers: { 'content-range': `bytes */${total}` },
        });
      }
      const length = e - s + 1;
      const obj = await c.env.BUCKET.get(file.r2_key, { range: { offset: s, length } });
      if (!obj) return c.json({ error: '文件对象丢失' }, 410);
      const headers = new Headers();
      obj.writeHttpMetadata(headers);
      headers.set('etag', obj.httpEtag);
      headers.set('content-disposition', disposition);
      headers.set('accept-ranges', 'bytes');
      headers.set('content-range', `bytes ${s}-${e}/${total}`);
      headers.set('content-length', String(length));
      return new Response(obj.body, { status: 206, headers });
    }
  }

  const obj = await c.env.BUCKET.get(file.r2_key);
  if (!obj) return c.json({ error: '文件对象丢失' }, 410);
  const headers = new Headers();
  obj.writeHttpMetadata(headers);
  headers.set('etag', obj.httpEtag);
  headers.set('content-disposition', disposition);
  headers.set('accept-ranges', 'bytes');
  headers.set('cache-control', 'private, max-age=3600');
  return new Response(obj.body, { status: 200, headers });
});

// ---- 重命名 ----
app.post('/:id/rename', async (c) => {
  const user = await loadUser(c);
  if (user instanceof Response) return user;
  const id = parseInt(c.req.param('id'), 10);
  const file = await getUserFile(c.env.DB, user.id, id);
  if (!file) return c.json({ error: '文件不存在' }, 404);
  const body = await c.req.json().catch(() => ({}));
  const name = sanitizeFileName(String(body.name || ''));
  if (!name) return c.json({ error: '名称不能为空' }, 400);
  if (await nameExists(c.env.DB, user.id, file.parent_id, name, id))
    return c.json({ error: '同名文件/文件夹已存在' }, 409);
  await run(c.env.DB, "UPDATE files SET name = ?, updated_at = datetime('now') WHERE id = ?", [name, id]);
  return c.json({ ok: true });
});

// ---- 移动 ----
app.post('/:id/move', async (c) => {
  const user = await loadUser(c);
  if (user instanceof Response) return user;
  const id = parseInt(c.req.param('id'), 10);
  const file = await getUserFile(c.env.DB, user.id, id);
  if (!file) return c.json({ error: '文件不存在' }, 404);

  const body = await c.req.json().catch(() => ({}));
  let targetParent: number | null =
    body.parent_id === null || body.parent_id === 0 || body.parent_id === undefined
      ? null
      : parseInt(body.parent_id, 10);

  if ((targetParent ?? id) === id) return c.json({ error: '不能移动到自身' }, 400);
  if (targetParent != null) {
    if (!Number.isInteger(targetParent)) return c.json({ error: '目标目录无效' }, 400);
    const target = await getUserFile(c.env.DB, user.id, targetParent);
    if (!target || target.kind !== 'folder') return c.json({ error: '目标目录不存在' }, 404);
    // 防止移入自己的子孙目录
    if (file.kind === 'folder') {
      const descendants = await collectDescendants(c.env.DB, user.id, id);
      if (descendants.some((d) => d.id === targetParent))
        return c.json({ error: '不能移动到其子目录内' }, 400);
    }
  }
  if (file.parent_id === targetParent) return c.json({ ok: true, changed: false });
  if (await nameExists(c.env.DB, user.id, targetParent, file.name, id))
    return c.json({ error: '目标目录已存在同名项目' }, 409);

  await run(c.env.DB, "UPDATE files SET parent_id = ?, updated_at = datetime('now') WHERE id = ?", [
    targetParent,
    id,
  ]);
  return c.json({ ok: true, changed: true });
});

// ---- 删除（文件夹递归） ----
app.delete('/:id', async (c) => {
  const user = await loadUser(c);
  if (user instanceof Response) return user;
  const id = parseInt(c.req.param('id'), 10);
  const file = await getUserFile(c.env.DB, user.id, id);
  if (!file) return c.json({ error: '文件不存在' }, 404);

  const all = file.kind === 'folder' ? await collectDescendants(c.env.DB, user.id, id) : [file];
  const keys = all.filter((f) => f.kind === 'file' && f.r2_key).map((f) => f.r2_key!) as string[];
  const ids = all.map((f) => f.id);

  // 删除 R2 对象（分批，每批 <= 100）
  for (let i = 0; i < keys.length; i += 100) {
    await c.env.BUCKET.delete(keys.slice(i, i + 100));
  }
  // 删除 D1 行（先显式撤销分享，不依赖外键级联）
  for (let i = 0; i < ids.length; i += 50) {
    const chunk = ids.slice(i, i + 50);
    const ph = chunk.map(() => '?').join(',');
    await run(c.env.DB, `DELETE FROM shares WHERE file_id IN (${ph})`, chunk);
    await run(c.env.DB, `DELETE FROM files WHERE id IN (${ph})`, chunk);
  }
  return c.json({ ok: true, deleted: ids.length });
});

// ---- 创建 / 查询分享 ----
app.post('/:id/share', async (c) => {
  const user = await loadUser(c);
  if (user instanceof Response) return user;
  const id = parseInt(c.req.param('id'), 10);
  const file = await getUserFile(c.env.DB, user.id, id);
  if (!file) return c.json({ error: '文件不存在' }, 404);

  // 已有有效分享则直接返回
  const existing = await first<ShareRow>(
    c.env.DB,
    "SELECT * FROM shares WHERE file_id = ? AND user_id = ? AND status = 'active' LIMIT 1",
    [id, user.id]
  );
  if (existing) return c.json({ ok: true, share: existing, reused: true });

  const body = await c.req.json().catch(() => ({}));
  let passcode: string | null = null;
  if (body.with_passcode) {
    passcode = typeof body.passcode === 'string' && /^\d{4}$/.test(body.passcode)
      ? body.passcode
      : genPasscode();
  }
  let expiresAt: string | null = null;
  const days = parseInt(body.expires_days, 10);
  if (Number.isInteger(days) && days > 0 && days <= 3650) {
    const d = new Date(Date.now() + days * 86400_000);
    expiresAt = d.toISOString().replace('T', ' ').slice(0, 19);
  }
  let maxDownloads: number | null = null;
  if (Number.isInteger(body.max_downloads) && body.max_downloads > 0) {
    maxDownloads = Math.min(body.max_downloads, 1_000_000);
  }

  const token = genShareToken();
  const result = await run(
    c.env.DB,
    'INSERT INTO shares (token, user_id, file_id, passcode, expires_at, max_downloads) VALUES (?, ?, ?, ?, ?, ?)',
    [token, user.id, id, passcode, expiresAt, maxDownloads]
  );
  const share = await first<ShareRow>(c.env.DB, 'SELECT * FROM shares WHERE id = ?', [
    Number(result.meta.last_row_id),
  ]);
  return c.json({ ok: true, share, reused: false });
});

app.get('/shares/list', async (c) => {
  const user = await loadUser(c);
  if (user instanceof Response) return user;
  const rows = await query<ShareRow & { file_name: string; file_kind: string; file_size: number }>(
    c.env.DB,
    `SELECT s.*, f.name AS file_name, f.kind AS file_kind, f.size AS file_size
     FROM shares s JOIN files f ON f.id = s.file_id
     WHERE s.user_id = ? AND s.status = 'active'
     ORDER BY s.id DESC LIMIT 200`,
    [user.id]
  );
  return c.json({ shares: rows });
});

app.delete('/shares/:sid', async (c) => {
  const user = await loadUser(c);
  if (user instanceof Response) return user;
  const sid = parseInt(c.req.param('sid'), 10);
  await run(c.env.DB, "UPDATE shares SET status = 'revoked' WHERE id = ? AND user_id = ?", [sid, user.id]);
  return c.json({ ok: true });
});

export default app;
