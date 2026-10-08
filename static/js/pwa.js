/* BDrive PWA 注册（在所有页面引入） */
(function () {
  if (!('serviceWorker' in navigator)) return;
  function register() {
    navigator.serviceWorker.register('/sw.js').catch(function (e) {
      console.warn('SW register failed:', e);
    });
  }
  if (document.readyState === 'loading') {
    window.addEventListener('load', register);
  } else {
    register();
  }

  // 新版本 Service Worker 就绪时提示刷新
  var refreshing = false;
  navigator.serviceWorker.addEventListener('controllerchange', function () {
    if (refreshing) return;
    refreshing = true;
    location.reload();
  });
})();
