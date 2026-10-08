import { sign, verify } from 'hono/jwt';
import type { Context } from 'hono';
import { bufToHex, hexToBuf, type Env } from './lib';
import { first, json } from './lib';

export type JWTPayload = {
  uid: number;
  email: string;
  role: string;
  name: string;
  exp: number;
};

const FALLBACK_SECRET = 'bdrive-dev-secret-change-me';
const COOKIE = 'bd_session';

export function getSecret(env: Env): string {
  return env.SESSION_SECRET || FALLBACK_SECRET;
}

async function pbkdf2Hex(password: string, salt: Uint8Array, iterations: number): Promise<string> {
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(password),
    'PBKDF2',
    false,
    ['deriveBits']
  );
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: salt as BufferSource, iterations, hash: 'SHA-256' },
    keyMaterial,
    256
  );
  return bufToHex(new Uint8Array(bits));
}

export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const hash = await pbkdf2Hex(password, salt, 100000);
  return `${bufToHex(salt)}:${hash}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [saltHex, hash] = stored.split(':');
  if (!saltHex || !hash) return false;
  const computed = await pbkdf2Hex(password, hexToBuf(saltHex), 100000);
  if (computed.length !== hash.length) return false;
  let diff = 0;
  for (let i = 0; i < computed.length; i++) diff |= computed.charCodeAt(i) ^ hash.charCodeAt(i);
  return diff === 0;
}

export async function issueToken(
  env: Env,
  user: { id: number; email: string; role: string; name: string }
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return await sign(
    { uid: user.id, email: user.email, role: user.role, name: user.name, exp: now + 60 * 60 * 24 * 30 },
    getSecret(env),
    'HS256'
  );
}

export async function verifyToken(env: Env, token: string): Promise<JWTPayload | null> {
  try {
    const payload = await verify(token, getSecret(env), 'HS256');
    return payload as unknown as JWTPayload;
  } catch {
    return null;
  }
}

export function authCookie(token: string): string {
  return `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000`;
}

export function clearCookie(): string {
  return `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
}

export function getCookie(request: Request, name: string): string | null {
  const header = request.headers.get('Cookie') || '';
  for (const part of header.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return v.join('=');
  }
  return null;
}

export async function currentUser(env: Env, request: Request): Promise<JWTPayload | null> {
  const token = getCookie(request, COOKIE);
  if (!token) return null;
  return await verifyToken(env, token);
}

// 校验邮箱格式
export function isValidEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) && email.length <= 200;
}

// 必须登录；并校验账号未被封禁
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function requireAuth(c: Context<any>): Promise<JWTPayload | Response> {
  const token = await currentUser(c.env, c.req.raw);
  if (!token) return json({ error: '请先登录' }, 401);
  const row = await first<{ role: string; status: string; name: string }>(
    c.env.DB,
    'SELECT role, status, name FROM users WHERE id = ?',
    [token.uid]
  );
  if (!row) return json({ error: '账号不存在' }, 401);
  if (row.status === 'banned') return json({ error: '账号已被封禁，请联系管理员' }, 403);
  token.role = row.role;
  token.name = row.name;
  return token;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function requireAdmin(c: Context<any>): Promise<JWTPayload | Response> {
  const result = await requireAuth(c);
  if (result instanceof Response) return result;
  if (result.role !== 'admin') return json({ error: '需要管理员权限' }, 403);
  return result;
}
