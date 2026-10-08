/* BDrive Service Worker — 根作用域，离线可用与资源缓存 */
const CACHE = 'bdrive-pwa-v9';
const APP_SHELL = [
  '/',
  '/index.html',
  '/drive.html',
  '/login.html',
  '/offline.html',
  '/manifest.webmanifest',
  '/css/style.css',
  '/css/landing.css',
  '/js/common.js',
  '/js/drive.js',
  '/js/pwd-toggle.js',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(APP_SHELL)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

function isHtmlNav(request) {
  return request.mode === 'navigate' || (request.method === 'GET' && request.destination === 'document');
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // 跨源（如客服 iframe）不拦截

  // 接口、短链、分享下载、客服代理：一律走网络，不缓存
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/s/') || url.pathname.startsWith('/support/')) return;

  // 页面导航：网络优先，失败回退缓存，再回退离线页
  if (isHtmlNav(req)) {
    event.respondWith(
      fetch(req)
        .then((res) => {
          if (res && res.status === 200) {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put(req, copy));
          }
          return res;
        })
        .catch(async () => {
          const cached = await caches.match(req, { ignoreSearch: true });
          if (cached) return cached;
          const shell = await caches.match(url.pathname === '/drive.html' ? '/drive.html' : '/index.html');
          return shell || caches.match('/offline.html');
        })
    );
    return;
  }

  // 静态资源：缓存优先，后台更新（stale-while-revalidate）
  if (['style', 'script', 'image', 'font', 'manifest'].includes(req.destination) || /\.(css|js|png|jpg|jpeg|svg|webp|ico|webmanifest)$/.test(url.pathname)) {
    event.respondWith(
      caches.match(req).then((cached) => {
        const network = fetch(req)
          .then((res) => {
            if (res && (res.status === 200 || res.type === 'opaque')) {
              const copy = res.clone();
              caches.open(CACHE).then((c) => c.put(req, copy));
            }
            return res;
          })
          .catch(() => cached);
        return cached || network;
      })
    );
  }
});
