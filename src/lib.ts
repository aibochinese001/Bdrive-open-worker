// 共享工具：D1 助手、设置读写、MD5、响应封装
export type Env = {
  DB: D1Database;
  BUCKET: R2Bucket;
  ASSETS: Fetcher;
  SESSION_SECRET?: string;
  BASE_URL?: string;
};

export async function query<T = Record<string, unknown>>(
  db: D1Database,
  sql: string,
  params: unknown[] = []
): Promise<T[]> {
  const result = await db.prepare(sql).bind(...params).all();
  return (result.results ?? []) as T[];
}

export async function first<T = Record<string, unknown>>(
  db: D1Database,
  sql: string,
  params: unknown[] = []
): Promise<T | null> {
  const result = await db.prepare(sql).bind(...params).all();
  const rows = (result.results ?? []) as T[];
  return rows.length ? rows[0] : null;
}

export async function run(db: D1Database, sql: string, params: unknown[] = []): Promise<D1Result> {
  return await db.prepare(sql).bind(...params).run();
}

export async function batchRun(db: D1Database, statements: D1PreparedStatement[]): Promise<D1Result[]> {
  return await db.batch(statements);
}

export function stmt(db: D1Database, sql: string, params: unknown[] = []): D1PreparedStatement {
  return db.prepare(sql).bind(...params);
}

export async function getSetting(db: D1Database, key: string, def = ''): Promise<string> {
  const row = await first<{ value: string }>(db, 'SELECT value FROM settings WHERE key = ?', [key]);
  return row ? row.value ?? def : def;
}

export async function setSetting(db: D1Database, key: string, value: string): Promise<void> {
  await run(
    db,
    `INSERT INTO settings (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`,
    [key, value]
  );
}

export async function getSettings(db: D1Database, keys: string[]): Promise<Record<string, string>> {
  if (!keys.length) return {};
  const placeholders = keys.map(() => '?').join(',');
  const rows = await query<{ key: string; value: string }>(
    db,
    `SELECT key, value FROM settings WHERE key IN (${placeholders})`,
    keys
  );
  const map: Record<string, string> = {};
  for (const k of keys) map[k] = '';
  for (const r of rows) map[r.key] = r.value;
  return map;
}

export function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

export function html(content: string, status = 200): Response {
  return new Response(content, {
    status,
    headers: { 'content-type': 'text/html; charset=utf-8' },
  });
}

export function randHex(len: number): string {
  const bytes = crypto.getRandomValues(new Uint8Array(len));
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

// 订单号：日期 + 随机
export function genOrderNo(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  const ymd = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}${p(d.getHours())}${p(
    d.getMinutes()
  )}${p(d.getSeconds())}`;
  return ymd + randHex(6).toUpperCase();
}

export function bufToHex(buf: Uint8Array): string {
  return Array.from(buf)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

export function hexToBuf(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return bytes;
}

export function esc(s: unknown): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// ---------------------------------------------------------------------------
// MD5 (纯 JS, RFC 1321) — WebCrypto 无 MD5，易支付签名需要；按 UTF-8 字节计算
// ---------------------------------------------------------------------------
function rotl32(x: number, c: number): number {
  return ((x << c) | (x >>> (32 - c))) | 0;
}

// RFC 1321 每轮移位量
const MD5_S = [
  7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
  5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
  4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
  6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
];
// K[i] = floor(abs(sin(i + 1)) * 2^32)
const MD5_K = [
  0xd76aa478, 0xe8c7b756, 0x242070db, 0xc1bdceee,
  0xf57c0faf, 0x4787c62a, 0xa8304613, 0xfd469501,
  0x698098d8, 0x8b44f7af, 0xffff5bb1, 0x895cd7be,
  0x6b901122, 0xfd987193, 0xa679438e, 0x49b40821,
  0xf61e2562, 0xc040b340, 0x265e5a51, 0xe9b6c7aa,
  0xd62f105d, 0x02441453, 0xd8a1e681, 0xe7d3fbc8,
  0x21e1cde6, 0xc33707d6, 0xf4d50d87, 0x455a14ed,
  0xa9e3e905, 0xfcefa3f8, 0x676f02d9, 0x8d2a4c8a,
  0xfffa3942, 0x8771f681, 0x6d9d6122, 0xfde5380c,
  0xa4beea44, 0x4bdecfa9, 0xf6bb4b60, 0xbebfbc70,
  0x289b7ec6, 0xeaa127fa, 0xd4ef3085, 0x04881d05,
  0xd9d4d039, 0xe6db99e5, 0x1fa27cf8, 0xc4ac5665,
  0xf4292244, 0x432aff97, 0xab9423a7, 0xfc93a039,
  0x655b59c3, 0x8f0ccc92, 0xffeff47d, 0x85845dd1,
  0x6fa87e4f, 0xfe2ce6e0, 0xa3014314, 0x4e0811a1,
  0xf7537e82, 0xbd3af235, 0x2ad7d2bb, 0xeb86d391,
];

function md5Block(state: number[], block: Uint8Array, base: number): void {
  const M = new Array<number>(16);
  for (let k = 0; k < 16; k += 1) {
    const o = base + k * 4;
    M[k] = (block[o] | (block[o + 1] << 8) | (block[o + 2] << 16) | (block[o + 3] << 24)) | 0;
  }
  let a = state[0], b = state[1], c = state[2], d = state[3];
  for (let i = 0; i < 64; i += 1) {
    let f: number, g: number;
    if (i < 16) { f = (b & c) | (~b & d); g = i; }
    else if (i < 32) { f = (d & b) | (~d & c); g = (5 * i + 1) % 16; }
    else if (i < 48) { f = b ^ c ^ d; g = (3 * i + 5) % 16; }
    else { f = c ^ (b | ~d); g = (7 * i) % 16; }
    f = (f + a + MD5_K[i] + M[g]) | 0;
    a = d;
    d = c;
    c = b;
    b = (b + rotl32(f, MD5_S[i])) | 0;
  }
  state[0] = (state[0] + a) | 0;
  state[1] = (state[1] + b) | 0;
  state[2] = (state[2] + c) | 0;
  state[3] = (state[3] + d) | 0;
}

export function md5(input: string): string {
  const bytes = new TextEncoder().encode(input);
  // 填充：追加 0x80，补 0 到长度 ≡ 56 (mod 64)，再追加 64 位小端位长
  let paddedLen = bytes.length + 1;
  while (paddedLen % 64 !== 56) paddedLen += 1;
  paddedLen += 8;
  const buf = new Uint8Array(paddedLen);
  buf.set(bytes, 0);
  buf[bytes.length] = 0x80;
  const bitLen = bytes.length * 8;
  const low = bitLen >>> 0;
  const high = Math.floor(bitLen / 0x100000000) >>> 0;
  for (let j = 0; j < 4; j += 1) buf[paddedLen - 8 + j] = (low >>> (8 * j)) & 0xff;
  for (let j = 0; j < 4; j += 1) buf[paddedLen - 4 + j] = (high >>> (8 * j)) & 0xff;

  const state = [0x67452301, 0xefcdab89 | 0, 0x98badcfe | 0, 0x10325476];
  for (let off = 0; off < paddedLen; off += 64) md5Block(state, buf, off);

  let out = '';
  for (let w = 0; w < 4; w += 1) {
    const word = state[w] >>> 0;
    for (let j = 0; j < 4; j += 1) {
      out += ((word >>> (8 * j)) & 0xff).toString(16).padStart(2, '0');
    }
  }
  return out;
}
