#!/usr/bin/env node
/**
 * BDrive 商务网盘 — 一次性部署准备脚本（确定性）
 *
 * 流程：whoami 确认登录 → 创建/复用 D1 bdrive-db → 回填 wrangler.jsonc 的
 * database_id → 应用 migrations/0001_init.sql + 0002_email.sql → 打印 secrets 与部署指引。
 *
 * 用法：
 *   npm run setup            # 交互式指引
 *   npm run setup -- --json  # 输出 JSON（便于 CI/Agent 解析）
 *
 * 前置：已登录 Cloudflare（npx wrangler login）。
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const JSON_OUT = process.argv.includes('--json');
const DB_NAME = 'bdrive-db';
const WRANGLER_CFG = join(ROOT, 'wrangler.jsonc');
const WRANGLER_EXAMPLE = join(ROOT, 'wrangler.jsonc.example');
const MIGRATIONS = ['0001_init.sql', '0002_email.sql'];
const PLACEHOLDER = 'REPLACE_WITH_YOUR_D1_DATABASE_ID';

function log(msg, data) {
  if (JSON_OUT) return;
  console.log(msg);
  if (data !== undefined) console.log(data);
}
function result(obj) {
  if (JSON_OUT) { console.log(JSON.stringify(obj, null, 2)); process.exit(obj.ok ? 0 : 1); }
  if (!obj.ok) { console.error('\n[setup] 失败：' + (obj.error || '未知错误')); process.exit(1); }
}

function sh(args, opts = {}) {
  const cmd = process.platform === 'win32' ? 'npx.cmd' : 'npx';
  return execFileSync(cmd, args, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts });
}

log('== BDrive setup ==\n');

// 1. 确认登录
try {
  const who = sh(['wrangler', 'whoami']);
  log('[1/4] Cloudflare 登录确认：OK');
  if (!JSON_OUT) console.log(who.split('\n').slice(0, 3).join('\n'));
} catch (e) {
  result({ ok: false, step: 1, error: '未登录 Cloudflare，请先运行 npx wrangler login' });
  return;
}

// 2. 创建/复用 D1，取 database_id
let databaseId = null;
try {
  const createOut = sh(['wrangler', 'd1', 'create', DB_NAME]);
  const m = createOut.match(/database_id[=:]\s*["']?([0-9a-f-]{36})/i) || createOut.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i);
  if (m) databaseId = m[1];
} catch (e) {
  // 已存在时可能报错，尝试从现有配置读取
  const stderr = String(e.stderr || e.message);
  log('[2/4] 创建 D1 返回非零退出（可能已存在）：' + stderr.split('\n')[0]);
}
if (!databaseId) {
  const cur = readWrangler();
  if (cur && cur !== PLACEHOLDER) databaseId = cur;
}
if (!databaseId) {
  // 兜底：wrangler d1 list 里按名字匹配
  try {
    const list = sh(['wrangler', 'd1', 'list', '--json']);
    const rows = JSON.parse(list);
    const hit = (rows || []).find((r) => r.name === DB_NAME || r.database_name === DB_NAME);
    if (hit) databaseId = hit.uuid || hit.database_id;
  } catch (_) { /* ignore */ }
}
if (!databaseId) {
  result({ ok: false, step: 2, error: '无法确定 D1 database_id，请手动运行 npx wrangler d1 create ' + DB_NAME });
  return;
}
log('[2/4] D1 就绪：' + DB_NAME + ' → ' + databaseId);

// 3. 回填 wrangler.jsonc
function readWrangler() {
  if (!existsSync(WRANGLER_CFG)) return null;
  const raw = readFileSync(WRANGLER_CFG, 'utf8').replace(/^\s*\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
  try { return JSON.parse(raw); } catch (_) { return null; }
}
try {
  if (!existsSync(WRANGLER_CFG) && existsSync(WRANGLER_EXAMPLE)) {
    writeFileSync(WRANGLER_CFG, readFileSync(WRANGLER_EXAMPLE, 'utf8'));
  }
  if (existsSync(WRANGLER_CFG)) {
    let raw = readFileSync(WRANGLER_CFG, 'utf8');
    if (raw.includes(PLACEHOLDER)) {
      raw = raw.split(PLACEHOLDER).join(databaseId);
      writeFileSync(WRANGLER_CFG, raw);
      log('[3/4] wrangler.jsonc：database_id 已回填');
    } else {
      log('[3/4] wrangler.jsonc：已包含 database_id，跳过回填');
    }
  } else {
    result({ ok: false, step: 3, error: 'wrangler.jsonc 与 wrangler.jsonc.example 均不存在' });
    return;
  }
} catch (e) {
  result({ ok: false, step: 3, error: '回填 wrangler.jsonc 失败：' + e.message });
  return;
}

// 4. 应用 migrations
for (const f of MIGRATIONS) {
  const p = join(ROOT, 'migrations', f);
  if (!existsSync(p)) { result({ ok: false, step: 4, error: '缺少迁移文件 ' + f }); return; }
  try {
    sh(['wrangler', 'd1', 'execute', DB_NAME, '--remote', '--file=' + p]);
    log('[4/4] 迁移已应用：' + f);
  } catch (e) {
    const stderr = String(e.stderr || e.message);
    if (/already exists|no such table|duplicate/i.test(stderr)) {
      log('[4/4] ' + f + ' 已应用过，跳过：' + stderr.split('\n')[0]);
    } else {
      result({ ok: false, step: 4, error: '迁移 ' + f + ' 失败：' + stderr.split('\n')[0] });
      return;
    }
  }
}

result({
  ok: true,
  database_name: DB_NAME,
  database_id: databaseId,
  wrangler_jsonc: 'database_id 已回填（若首次）',
  next: [
    'npx wrangler secret put SESSION_SECRET   # 随机 32+ 字节，必填',
    'npx wrangler deploy',
    '注册账号后用 SQL 提升为管理员：',
    'npx wrangler d1 execute bdrive-db --remote --command "UPDATE users SET role=\'admin\' WHERE email=\'you@example.com\'"',
  ],
});
