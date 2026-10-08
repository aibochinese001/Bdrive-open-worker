#!/usr/bin/env node
/**
 * BDrive — 敏感信息正式扫描器
 *
 * 用法：
 *   npm run scan:secrets          # 扫描应入库文件，0 命中退出码 0
 *   npm run scan:secrets -- --json
 *
 * 排除：node_modules/ .wrangler/ .git/ dist/ *.log .dev.vars wrangler.jsonc
 */
import { readdirSync, statSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(import.meta.dirname ?? dirname(fileURLToPath(import.meta.url)), '..');
const JSON_OUT = process.argv.includes('--json');

const SKIP_DIRS = new Set(['node_modules', '.wrangler', '.git', 'dist', '.sessions']);
const SKIP_FILES = /\.(log|tmp|sqlite|sqlite-wal|sqlite-shm|map)$/i;
const SKIP_PATHS = new Set(['.dev.vars', 'wrangler.jsonc', 'package-lock.json', 'formal_secret_scan.mjs']);

const PATTERNS = [
  [/sk-[A-Za-z0-9]{8,}/i, 'OpenAI-style API key'],
  [/ghp_[A-Za-z0-9]{30,}/i, 'GitHub PAT'],
  [/AKIA[0-9A-Z]{16}/, 'AWS access key'],
  [/BEGIN [A-Z ]*PRIVATE KEY/, 'private key'],
  [/cloudflare[_-]?api[_-]?token\s*[=:]\s*["']?[A-Za-z0-9_-]{20,}/i, 'Cloudflare API token'],
  [/\bBearer\s+[A-Za-z0-9._-]{20,}/, 'bearer token'],
  [/["'](api[_-]?key|apikey)["']?\s*[=:]\s*["'][A-Za-z0-9_\-]{16,}["']/i, 'api key assignment'],
  [/["']secret["']?\s*[=:]\s*["'][A-Za-z0-9_\-]{16,}["']/i, 'secret assignment'],
  [/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i, 'UUID (check: D1 id?)'],
  [/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/, 'email'],
];

// 合法豁免：代码中的占位示例/文档示例/非敏感 UUID（如内部常量），按文件+正则精确豁免
const EXEMPT = [
  [/support@example\.com/, 'migrations/0001_init.sql'],
  [/noreply@qq\.com/, 'migrations/0002_email.sql'],
  [/you@example\.com/, 'README.md', 'AGENTS.md', 'scripts/setup.mjs', 'static/login.html'],
  [/yourname@qq\.com/, 'static/admin/admin.js'],
  [/sk-composite/, 'static/css/landing.css'],
  [/chat\.example\.com/, 'src/index.ts', 'src/support-proxy.ts'],
  [/REPLACE_WITH_YOUR_D1_DATABASE_ID/, 'wrangler.jsonc.example'],
  [/bdrive-dev-secret-change-me/, 'src/auth.ts'],
];

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) out.push(...walk(p));
    else if (!SKIP_FILES.test(name) && !SKIP_PATHS.has(name) && st.size <= 2_000_000) out.push(p);
  }
  return out;
}

function isExempt(rel, value) {
  return EXEMPT.some(([re, ...files]) => files.includes(rel) && re.test(value));
}

const hits = [];
for (const f of walk(ROOT)) {
  const rel = relative(ROOT, f).split('\\').join('/');
  let content;
  try { content = readFileSync(f, 'utf8'); } catch { continue; }
  for (const [re, label] of PATTERNS) {
    const m = content.match(re);
    if (m && !isExempt(rel, m[0])) hits.push({ file: rel, label, match: m[0].slice(0, 60) });
  }
}

if (JSON_OUT) {
  console.log(JSON.stringify({ scanned: walk(ROOT).length, hits }, null, 2));
  process.exit(hits.length ? 1 : 0);
}
if (hits.length) {
  console.error(`[scan] ${hits.length} 处敏感命中：`);
  for (const h of hits) console.error(`  ${h.file}: ${h.label} → ${h.match}`);
  process.exit(1);
}
console.log(`[scan] 通过：${walk(ROOT).length} 个文件，0 命中`);
