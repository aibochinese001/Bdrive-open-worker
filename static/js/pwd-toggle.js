/* 密码框小眼睛：默认掩码，点击眼睛才显示明文；自动覆盖动态插入的弹窗 */
(function () {
  var EYE = '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path fill="currentColor" d="M12 5c-5 0-8.6 4.1-9.7 6.3-.2.4-.2.9 0 1.3C3.4 14.9 7 19 12 19s8.6-4.1 9.7-6.4c.2-.4.2-.9 0-1.3C20.6 9.1 17 5 12 5zm0 11.5a4.5 4.5 0 1 1 0-9 4.5 4.5 0 0 1 0 9zm0-2a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5z"/></svg>';
  var EYE_OFF = '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path fill="currentColor" d="M12 6.5c.8 0 1.6.2 2.3.5l-1.9 1.9a2.5 2.5 0 0 0-3.1 3.1l-2.4 2.4C4.9 15 3.7 13.6 3 12.6c-.2-.4-.2-.9 0-1.3C4.1 9.1 7.6 6.5 12 6.5zm8.3-4.1 1 .9L4.4 20.7l-1-.9 2.5-2.5C4.4 16.6 3.4 15.6 2.6 14.6l-.3-.4c-.2-.4-.2-.9 0-1.3C3.4 10.6 7 6.7 12 6.7c1.2 0 2.4.2 3.5.6l2.3-2.3c.8-.7 1.7-1.5 2.5-2.6zm-4.2 5.9 1.4-1.4c.5.7.8 1.5.8 2.4a4.5 4.5 0 0 1-4.5 4.5c-.9 0-1.7-.3-2.4-.8l1.3-1.3a2.5 2.5 0 0 0 3.4-3.4zm-3.2.5 2.6 2.6a2.5 2.5 0 0 0-2.6-2.6z"/></svg>';

  function enhance(input) {
    if (!input || input.tagName !== 'INPUT' || input.getAttribute('type') !== 'password') return;
    if (input.getAttribute('data-pwd-eye')) return;
    input.setAttribute('data-pwd-eye', '1');

    var wrap = document.createElement('span');
    wrap.className = 'pwd-wrap';
    // 继承输入框当前内联显隐状态（如分享提取码框初始 display:none，包裹后仍应隐藏）
    if (input.style.display) wrap.style.display = input.style.display;
    input.parentNode.insertBefore(wrap, input);
    wrap.appendChild(input);
    input.classList.add('pwd-input');

    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'pwd-toggle';
    btn.tabIndex = -1;
    btn.setAttribute('aria-label', '显示密码');
    btn.title = '显示密码';
    btn.innerHTML = EYE;

    var shown = false;
    function toggle() {
      shown = !shown;
      input.type = shown ? 'text' : 'password';
      btn.innerHTML = shown ? EYE_OFF : EYE;
      btn.setAttribute('aria-label', shown ? '隐藏密码' : '显示密码');
      btn.title = shown ? '隐藏密码' : '显示密码';
      btn.classList.toggle('is-on', shown);
      input.focus();
    }
    btn.addEventListener('click', function (e) { e.preventDefault(); toggle(); });
    wrap.appendChild(btn);
  }

  function enhanceAll(root) {
    var scope = root && root.querySelectorAll ? root : document;
    var list = scope.querySelectorAll ? scope.querySelectorAll('input[type=password]') : [];
    for (var i = 0; i < list.length; i++) enhance(list[i]);
    // root 自身可能就是密码框
    if (root && root.nodeType === 1 && root.matches && root.matches('input[type=password]')) enhance(root);
  }

  function init() {
    enhanceAll(document);
    // 监听后续动态插入的密码框（如改密码/重置密码弹窗）
    var mo = new MutationObserver(function (muts) {
      for (var i = 0; i < muts.length; i++) {
        muts[i].addedNodes.forEach(function (node) {
          if (node.nodeType === 1) enhanceAll(node);
        });
      }
    });
    mo.observe(document.documentElement, { childList: true, subtree: true });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
