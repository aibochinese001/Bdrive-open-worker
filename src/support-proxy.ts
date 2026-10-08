/**
 * 在线客服同源反向代理
 *
 * 背景：部分 App 内置 WebView 会拦截「跨站（第三方）iframe」，即使目标站点未设置
 * X-Frame-Options / CSP 也无法直接嵌入 https://chat.example.com。
 * 方案：由本站 Worker 把客服站反向代理到同源路径 /support/*，iframe 改为加载
 * /support/，跨站即变同源，任何 WebView 均可内嵌。
 *
 * - 透传 method / query / multipart 文件上传 / 关键请求头
 * - 对返回的 HTML / JS 做地址改写：把客服站绝对地址与根路径资源改写成 /support 前缀
 * - JSON / 图片等二进制原样透传，不做改写
 */
import { Hono } from 'hono';

const UPSTREAM = 'https://chat.example.com';
const PREFIX = '/support';

// 改写 HTML / JS 中指向客服站的地址，保证后续请求仍走同源代理
function rewriteDoc(text: string): string {
  let out = text.split(UPSTREAM).join(PREFIX);
  // 标签属性中的根路径：href="/x" src="/x" action="/x"
  out = out.replace(/\b(href|src|action)\s*=\s*(["'])\/(?!\/)/gi, (_m, attr, q) => `${attr}=${q}${PREFIX}/`);
  // 内联脚本中的根路径字符串：'/api/...'、"/api/..."（fetch('/api/chat')、'/api/meta'）
  out = out.replace(/(["'])\/api\//g, (_m, q) => `${q}${PREFIX}/api/`);
  return out;
}

const HOP_BY_HOP = [
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailer', 'transfer-encoding', 'upgrade',
  'content-encoding', 'content-length', 'host', 'set-cookie',
];

export const supportRoutes = new Hono();

supportRoutes.all('*', async (c) => {
  const reqUrl = new URL(c.req.url);
  const subPath = reqUrl.pathname.startsWith(PREFIX) ? reqUrl.pathname.slice(PREFIX.length) : reqUrl.pathname;
  const target = UPSTREAM + (subPath || '/') + reqUrl.search;

  const fwd = new Headers(c.req.raw.headers);
  HOP_BY_HOP.forEach((h) => fwd.delete(h));
  // 让上游认为是其站内的同源请求
  fwd.set('origin', UPSTREAM);
  fwd.set('referer', UPSTREAM + '/');

  const init: RequestInit = { method: c.req.method, headers: fwd, redirect: 'manual' };
  if (c.req.method !== 'GET' && c.req.method !== 'HEAD') {
    init.body = c.req.raw.body;
    // @ts-expect-error 透传流式请求体（multipart 上传）
    init.duplex = 'half';
  }

  let upstream: Response;
  try {
    upstream = await fetch(target, init);
  } catch (e) {
    console.error('support proxy fetch failed:', e);
    return c.json({ error: '客服服务暂时不可用，请稍后再试或通过新窗口联系' }, 502);
  }

  // 上游重定向：改写 Location 后透传
  const loc = upstream.headers.get('location');
  if (loc) {
    let n = loc;
    if (n.startsWith(UPSTREAM)) n = PREFIX + n.slice(UPSTREAM.length);
    else if (n.startsWith('/')) n = PREFIX + n;
    return new Response(null, { status: upstream.status, headers: { location: n } });
  }

  const ct = upstream.headers.get('content-type') || '';
  const isDoc = /text\/html|javascript|ecmascript/i.test(ct);

  const outHeaders = new Headers();
  upstream.headers.forEach((v, k) => {
    const lk = k.toLowerCase();
    if (HOP_BY_HOP.includes(lk)) return;
    outHeaders.set(k, v);
  });

  if (isDoc) {
    const text = await upstream.text();
    outHeaders.set('content-type', ct.includes('charset') ? ct : ct + '; charset=utf-8');
    return new Response(rewriteDoc(text), { status: upstream.status, headers: outHeaders });
  }

  // 二进制 / JSON 等原样流式透传
  return new Response(upstream.body, { status: upstream.status, headers: outHeaders });
});
