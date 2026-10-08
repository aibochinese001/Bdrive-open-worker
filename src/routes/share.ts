import { Hono } from 'hono';
import { Env, first, query, run } from '../lib';

type ShareRow = {
  id: number;
  token: string;
  user_id: number;
  file_id: number;
  passcode: string | null;
  expires_at: string | null;
  downloads: number;
  max_downloads: number | null;
  status: string;
};
type Row = {
  id: number;
  parent_id: number | null;
  name: string;
  kind: string;
  size: number;
  mime: string;
  r2_key: string | null;
  created_at: string;
};

const app = new Hono<{ Bindings: Env }>();

// 读取有效分享：状态、有效期、提取码
async function loadShare(
  db: D1Database,
  token: string,
  code: string
): Promise<{ share: ShareRow; file: Row } | { error: string; status: 403 | 404 | 410; needPasscode?: boolean }> {
  const row = await first<ShareRow & Row>(
    db,
    `SELECT s.*, f.name, f.parent_id, f.kind, f.size, f.mime, f.r2_key, f.created_at
     FROM shares s JOIN files f ON f.id = s.file_id
     WHERE s.token = ? AND s.status = 'active'`,
    [token]
  );
  if (!row) return { error: '分享链接不存在或已被取消', status: 404 };
  if (row.expires_at && new Date(row.expires_at.replace(' ', 'T') + 'Z').getTime() <= Date.now())
    return { error: '分享链接已过期', status: 410 };
  if (row.passcode && row.passcode !== code)
    return { error: '提取码不正确', status: 403, needPasscode: true };

  return {
    share: {
      id: row.id,
      token: row.token,
      user_id: row.user_id,
      file_id: row.file_id,
      passcode: row.passcode,
      expires_at: row.expires_at,
      downloads: row.downloads,
      max_downloads: row.max_downloads,
      status: row.status,
    },
    file: {
      id: row.file_id,
      parent_id: row.parent_id,
      name: row.name,
      kind: row.kind,
      size: row.size,
      mime: row.mime,
      r2_key: row.r2_key,
      created_at: row.created_at,
    },
  };
}

// 校验某文件是否在分享根目录的子树内
async function inSubtree(db: D1Database, rootId: number, rootKind: string, fileId: number): Promise<boolean> {
  if (rootKind === 'file') return fileId === rootId;
  const row = await first<{ n: number }>(
    db,
    `WITH RECURSIVE subtree(id) AS (
       SELECT id FROM files WHERE id = ?
       UNION ALL
       SELECT f.id FROM files f JOIN subtree s ON f.parent_id = s.id
     )
     SELECT COUNT(*) AS n FROM subtree WHERE id = ?`,
    [rootId, fileId]
  );
  return (row?.n ?? 0) > 0;
}

function dispositionFor(mime: string, name: string, forceDownload: boolean): string {
  const filenameStar = encodeURIComponent(name).replace(/['()]/g, '');
  const inlineable = /^(video\/|audio\/|image\/|application\/pdf|text\/)/i.test(mime);
  const kind = !forceDownload && inlineable ? 'inline' : 'attachment';
  return `${kind}; filename*=UTF-8''${filenameStar}`;
}

// 分享元信息（GET：无码直出；有码仅返回 need_passcode）
app.get('/share/:token', async (c) => {
  const code = String(c.req.query('code') || '');
  const result = await loadShare(c.env.DB, c.req.param('token'), code);
  if ('error' in result) {
    return c.json({ error: result.error, need_passcode: result.needPasscode }, result.status);
  }
  const { share, file } = result;
  return c.json({
    ok: true,
    need_passcode: false,
    file: { id: file.id, name: file.name, kind: file.kind, size: file.size, mime: file.mime },
    share: {
      expires_at: share.expires_at,
      downloads: share.downloads,
      max_downloads: share.max_downloads,
    },
  });
});

// 文件夹分享：列目录
app.get('/share/:token/list', async (c) => {
  const code = String(c.req.query('code') || '');
  const result = await loadShare(c.env.DB, c.req.param('token'), code);
  if ('error' in result) return c.json({ error: result.error }, result.status);
  const { share, file: root } = result;
  if (root.kind !== 'file' && root.kind !== 'folder') return c.json({ error: '链接无效' }, 400);

  let folderId = root.id;
  const fParam = c.req.query('folder');
  if (fParam) {
    folderId = parseInt(fParam, 10);
    if (!Number.isInteger(folderId) || !(await inSubtree(c.env.DB, root.id, root.kind, folderId)))
      return c.json({ error: '目录不可访问' }, 403);
  } else if (root.kind === 'file') {
    return c.json({ root_kind: 'file', folders: [], files: [root] });
  }

  const rows = await query<Row>(
    c.env.DB,
    `SELECT f.* FROM files f
     JOIN shares s ON s.id = ?
     WHERE f.user_id = s.user_id AND f.parent_id = ?
     ORDER BY f.kind DESC, f.id DESC`,
    [share.id, folderId]
  );
  return c.json({
    root_kind: root.kind,
    root_name: root.name,
    folder_id: folderId,
    folders: rows.filter((r) => r.kind === 'folder').map((r) => ({ id: r.id, name: r.name })),
    files: rows
      .filter((r) => r.kind === 'file')
      .map((r) => ({ id: r.id, name: r.name, size: r.size, mime: r.mime })),
  });
});

// 分享下载
app.get('/share/:token/download/:fileId', async (c) => {
  const code = String(c.req.query('code') || '');
  const forceDownload = c.req.query('dl') === '1';
  const result = await loadShare(c.env.DB, c.req.param('token'), code);
  if ('error' in result) return c.json({ error: result.error }, result.status);
  const { share, file: root } = result;

  const fileId = parseInt(c.req.param('fileId'), 10);
  if (!Number.isInteger(fileId) || !(await inSubtree(c.env.DB, root.id, root.kind, fileId)))
    return c.json({ error: '文件不可访问' }, 403);
  const target =
    root.kind === 'file' && root.id === fileId
      ? root
      : await first<Row>(
          c.env.DB,
          `SELECT f.* FROM files f JOIN shares s ON s.id = ? WHERE f.id = ? AND f.user_id = s.user_id`,
          [share.id, fileId]
        );
  if (!target || target.kind !== 'file' || !target.r2_key)
    return c.json({ error: '文件不存在' }, 404);

  // 次数限制（原子占用一次下载额度）
  if (share.max_downloads != null) {
    const upd = await run(
      c.env.DB,
      'UPDATE shares SET downloads = downloads + 1 WHERE id = ? AND status = ? AND (max_downloads IS NULL OR downloads < max_downloads)',
      [share.id, share.status]
    );
    if (!upd.meta.changes) return c.json({ error: '该分享下载次数已达上限' }, 410);
  } else {
    await run(c.env.DB, 'UPDATE shares SET downloads = downloads + 1 WHERE id = ?', [share.id]);
  }

  const disposition = dispositionFor(target.mime, target.name, forceDownload);
  const range = c.req.header('range') || c.req.header('Range');
  if (range) {
    const m = /bytes=(\d*)-(\d*)/.exec(range);
    if (m) {
      const total = target.size;
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
      if (s >= total || s > e)
        return new Response(null, { status: 416, headers: { 'content-range': `bytes */${total}` } });
      const length = e - s + 1;
      const obj = await c.env.BUCKET.get(target.r2_key, { range: { offset: s, length } });
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

  const obj = await c.env.BUCKET.get(target.r2_key);
  if (!obj) return c.json({ error: '文件对象丢失' }, 410);
  const headers = new Headers();
  obj.writeHttpMetadata(headers);
  headers.set('etag', obj.httpEtag);
  headers.set('content-disposition', disposition);
  headers.set('accept-ranges', 'bytes');
  headers.set('cache-control', 'private, max-age=3600');
  return new Response(obj.body, { status: 200, headers });
});

export default app;
