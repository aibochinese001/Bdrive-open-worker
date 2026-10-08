// BDrive 前端公共库
const API = '/api';

// 统一内页页脚（落地页与管理后台不注入）
function injectSiteFooter() {
  if (location.pathname.indexOf('/admin') === 0) return;
  if (document.getElementById('site-footer')) return;
  const f = document.createElement('footer');
  f.id = 'site-footer';
  f.className = 'site-footer';
  f.innerHTML = '© 2026 · 由 <a href="https://opcgrow.org" target="_blank" rel="noopener noreferrer">opcgrow.org</a> 提供技术支持';
  document.body.appendChild(f);
}
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', injectSiteFooter);
else injectSiteFooter();

async function api(path, opts = {}) {
  const init = {
    method: opts.method || 'GET',
    headers: {},
    credentials: 'same-origin',
  };
  if (opts.body !== undefined) {
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(opts.body);
  }
  if (opts.query) {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(opts.query)) {
      if (v !== undefined && v !== null) qs.set(k, v);
    }
    const s = qs.toString();
    if (s) path += (path.includes('?') ? '&' : '?') + s;
  }
  const res = await fetch(API + path, init);
  let data = {};
  try { data = await res.json(); } catch { /* non-json */ }
  if (!res.ok) {
    const err = new Error(data.error || `请求失败 (${res.status})`);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (m) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));
}

function fmtBytes(n) {
  n = Number(n) || 0;
  if (n < 1024) return n + ' B';
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = n / 1024, i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return v.toFixed(v >= 100 ? 0 : v >= 10 ? 1 : 2) + ' ' + units[i];
}

function fmtDate(s) {
  if (!s) return '-';
  return String(s).replace('T', ' ').slice(0, 19);
}

function extOf(name) {
  const m = /\.([a-z0-9]+)$/i.exec(name || '');
  return m ? m[1].toLowerCase() : '';
}

function fileIcon(name, kind) {
  if (kind === 'folder') return { icon: '📁', cls: 'folder' };
  const e = extOf(name);
  const map = {
    jpg: '🖼️', jpeg: '🖼️', png: '🖼️', gif: '🖼️', webp: '🖼️', bmp: '🖼️', svg: '🖼️',
    mp4: '🎬', mov: '🎬', avi: '🎬', mkv: '🎬', webm: '🎬',
    mp3: '🎵', wav: '🎵', flac: '🎵', m4a: '🎵',
    zip: '🗜️', rar: '🗜️', '7z': '🗜️', tar: '🗜️', gz: '🗜️',
    pdf: '📕', doc: '📘', docx: '📘', xls: '📗', xlsx: '📗', ppt: '📙', pptx: '📙',
    txt: '📄', md: '📝',
  };
  return { icon: map[e] || '📄', cls: 'file' };
}

/* ---------- Toast ---------- */
function toast(msg, type = '') {
  let box = document.getElementById('toast');
  if (!box) {
    box = document.createElement('div');
    box.id = 'toast';
    document.body.appendChild(box);
  }
  const el = document.createElement('div');
  el.className = 'toast-item ' + type;
  el.textContent = msg;
  box.appendChild(el);
  setTimeout(() => el.remove(), 2600);
}

/* ---------- Modal ---------- */
function openModal(html, large = false) {
  let mask = document.getElementById('modal-mask');
  if (!mask) {
    mask = document.createElement('div');
    mask.id = 'modal-mask';
    mask.className = 'modal-mask';
    mask.addEventListener('click', (e) => { if (e.target === mask) closeModal(); });
    document.body.appendChild(mask);
  }
  mask.innerHTML = `<div class="modal ${large ? 'modal-lg' : ''}">${html}</div>`;
  mask.classList.add('show');
  return mask.querySelector('.modal');
}
function closeModal() {
  const mask = document.getElementById('modal-mask');
  if (mask) { mask.classList.remove('show'); mask.innerHTML = ''; }
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    toast('已复制', 'success');
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text; document.body.appendChild(ta); ta.select();
    document.execCommand('copy'); ta.remove();
    toast('已复制', 'success');
  }
}

function qparam(k) {
  return new URLSearchParams(location.search).get(k);
}

/* ---------- 鉴权与导航 ---------- */
let _me = null;
async function getMe(force = false) {
  if (_me && !force) return _me;
  try {
    const r = await api('/auth/me');
    _me = r.user;
    return _me;
  } catch (e) {
    return null;
  }
}
function clearMe() { _me = null; }

async function requireLogin() {
  const me = await getMe();
  if (!me) { location.replace('/login.html?redirect=' + encodeURIComponent(location.pathname + location.search)); return null; }
  return me;
}

const NAV_EYE = '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path fill="currentColor" d="M12 5c-5 0-8.6 4.1-9.7 6.3-.2.4-.2.9 0 1.3C3.4 14.9 7 19 12 19s8.6-4.1 9.7-6.4c.2-.4.2-.9 0-1.3C20.6 9.1 17 5 12 5zm0 11.5a4.5 4.5 0 1 1 0-9 4.5 4.5 0 0 1 0 9zm0-2a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5z"/></svg>';
const NAV_EYE_OFF = '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path fill="currentColor" d="M12 6.5c.8 0 1.6.2 2.3.5l-1.9 1.9a2.5 2.5 0 0 0-3.1 3.1l-2.4 2.4C4.9 15 3.7 13.6 3 12.6c-.2-.4-.2-.9 0-1.3C4.1 9.1 7.6 6.5 12 6.5zm8.3-4.1 1 .9L4.4 20.7l-1-.9 2.5-2.5C4.4 16.6 3.4 15.6 2.6 14.6l-.3-.4c-.2-.4-.2-.9 0-1.3C3.4 10.6 7 6.7 12 6.7c1.2 0 2.4.2 3.5.6l2.3-2.3c.8-.7 1.7-1.5 2.5-2.6zm-4.2 5.9 1.4-1.4c.5.7.8 1.5.8 2.4a4.5 4.5 0 0 1-4.5 4.5c-.9 0-1.7-.3-2.4-.8l1.3-1.3a2.5 2.5 0 0 0 3.4-3.4zm-3.2.5 2.6 2.6a2.5 2.5 0 0 0-2.6-2.6z"/></svg>';

// 账号脱敏：邮箱保留前两位与域名，普通昵称仅留首字符；默认在导航中打码
function maskAccount(v) {
  v = String(v || '');
  const at = v.indexOf('@');
  if (at > 0) {
    const name = v.slice(0, at);
    const dom = v.slice(at);
    return (name.length <= 2 ? name[0] : name.slice(0, 2)) + '***' + dom;
  }
  if (v.length <= 2) return '****';
  return v[0] + '***';
}

async function renderNav(active) {
  const me = await getMe();
  if (!me) { location.replace('/login.html'); return null; }
  const links = [
    { key: 'drive', href: '/drive.html', label: '我的网盘' },
    { key: 'pricing', href: '/pricing.html', label: '会员升级' },
    { key: 'orders', href: '/orders.html', label: '我的订单' },
  ];
  if (me.role === 'admin') links.push({ key: 'admin', href: '/admin/index.html', label: '管理后台' });
  const nav = document.createElement('div');
  nav.className = 'nav';
  nav.innerHTML = `
    <a class="nav-brand" href="/drive.html"><span class="logo">☁</span><span>BDrive</span></a>
    <button class="nav-toggle" id="nav-toggle" type="button" aria-label="打开菜单" aria-expanded="false" aria-controls="nav-collapse">
      <span></span><span></span><span></span>
    </button>
    <div class="nav-collapse" id="nav-collapse">
      <div class="nav-links">
        ${links.map((l) => `<a href="${l.href}" class="${l.key === active ? 'active' : ''}">${l.label}</a>`).join('')}
      </div>
      <div class="nav-user">
        <span class="badge badge-blue">${esc(me.tier_name || '免费版')}</span>
        <span class="nav-acct">
          <span class="email" id="nav-acct-text"></span>
          <button type="button" class="nav-acct-eye" id="nav-acct-eye" aria-label="显示账号" title="显示账号"></button>
        </span>
        <button class="btn btn-sm" id="nav-pwd">改密码</button>
        <button class="btn btn-sm" id="nav-logout">退出</button>
      </div>
    </div>`;
  document.body.prepend(nav);

  // 账号默认打码，点小眼睛才显示完整账号
  const acctFull = me.name || me.email || '';
  const acctText = nav.querySelector('#nav-acct-text');
  const acctEye = nav.querySelector('#nav-acct-eye');
  let acctShown = false;
  const renderAcct = () => {
    acctText.textContent = acctShown ? acctFull : maskAccount(acctFull);
    acctEye.innerHTML = acctShown ? NAV_EYE_OFF : NAV_EYE;
    acctEye.setAttribute('aria-label', acctShown ? '隐藏账号' : '显示账号');
    acctEye.title = acctShown ? '隐藏账号' : '显示账号';
    acctEye.classList.toggle('is-on', acctShown);
  };
  renderAcct();
  acctEye.addEventListener('click', (e) => { e.stopPropagation(); acctShown = !acctShown; renderAcct(); });

  // 移动端汉堡菜单
  const toggleBtn = nav.querySelector('#nav-toggle');
  const collapse = nav.querySelector('#nav-collapse');
  const closeMenu = () => {
    nav.classList.remove('nav-open');
    toggleBtn.setAttribute('aria-expanded', 'false');
    toggleBtn.setAttribute('aria-label', '打开菜单');
  };
  toggleBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    const open = nav.classList.toggle('nav-open');
    toggleBtn.setAttribute('aria-expanded', String(open));
    toggleBtn.setAttribute('aria-label', open ? '关闭菜单' : '打开菜单');
  });
  // 点击菜单项后收起
  collapse.querySelectorAll('a').forEach((a) => a.addEventListener('click', closeMenu));
  // 点击菜单外部收起
  document.addEventListener('click', (e) => { if (!nav.contains(e.target)) closeMenu(); });
  // 切回桌面宽屏时重置
  window.addEventListener('resize', () => { if (window.innerWidth > 760) closeMenu(); });

  nav.querySelector('#nav-pwd').addEventListener('click', openPasswordModal);
  nav.querySelector('#nav-logout').addEventListener('click', async () => {
    try { await api('/auth/logout', { method: 'POST' }); } catch {}
    clearMe();
    location.href = '/login.html';
  });
  return me;
}

/* ---------- 分片/直传上传（带进度，XHR） ---------- */
function uploadFile({ file, parentId, onProgress, signal }) {
  return new Promise((resolve, reject) => {
    const qs = new URLSearchParams({
      name: file.name,
      size: String(file.size),
      mime: file.type || 'application/octet-stream',
    });
    if (parentId) qs.set('parent_id', parentId);
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', `${API}/drive/upload?${qs.toString()}`);
    xhr.withCredentials = true;
    xhr.upload.onprogress = (e) => { if (e.lengthComputable && onProgress) onProgress(e.loaded, e.total); };
    xhr.onload = () => {
      let data = {};
      try { data = JSON.parse(xhr.responseText); } catch {}
      if (xhr.status >= 200 && xhr.status < 300) resolve(data);
      else reject(new Error(data.error || `上传失败 (${xhr.status})`));
    };
    xhr.onerror = () => reject(new Error('网络错误，上传中断'));
    if (signal) signal.addEventListener('abort', () => xhr.abort());
    xhr.send(file);
  });
}

// 带登录态下载（fetch → blob）
async function authenticatedDownload(url, fallbackName) {
  try {
    const res = await fetch(url, { credentials: 'same-origin' });
    if (!res.ok) {
      let d = {}; try { d = await res.json(); } catch {}
      throw new Error(d.error || '下载失败');
    }
    const blob = await res.blob();
    const href = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = href;
    const cd = res.headers.get('content-disposition') || '';
    const m = /filename\*=UTF-8''([^;]+)/i.exec(cd);
    a.download = m ? decodeURIComponent(m[1]) : fallbackName || 'download';
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(href), 60000);
  } catch (e) {
    toast(e.message, 'error');
  }
}

function payLabel(key) {
  return { wxpay: '微信支付', alipay: '支付宝', ecny: '数字人民币', usdt: 'USDT' }[key] || key;
}
function payIcon(key) {
  return { wxpay: '💚', alipay: '💙', ecny: '¥', usdt: '₮' }[key] || '💰';
}
function statusBadge(s) {
  if (s === 'paid') return '<span class="badge badge-green">已支付</span>';
  if (s === 'pending') return '<span class="badge badge-amber">待支付</span>';
  if (s === 'closed') return '<span class="badge badge-gray">已关闭</span>';
  if (s === 'active') return '<span class="badge badge-green">正常</span>';
  if (s === 'banned') return '<span class="badge badge-red">已封禁</span>';
  if (s === 'revoked') return '<span class="badge badge-gray">已取消</span>';
  return esc(s);
}

/* ---------- 修改密码（邮箱验证码） ---------- */
async function openPasswordModal() {
  const me = await getMe();
  if (!me) return;
  const box = openModal(`
    <div style="margin-bottom:16px;">
      <h3 style="margin:0 0 6px;">修改登录密码</h3>
      <p class="small muted" style="margin:0;">验证码将发送至账号绑定邮箱：<b>${esc(me.email)}</b></p>
    </div>
    <label>邮箱验证码</label>
    <div style="display:flex;gap:10px;">
      <input id="pwd-code" inputmode="numeric" maxlength="6" placeholder="6 位验证码" style="flex:1;" />
      <button class="btn" id="pwd-send" type="button" style="white-space:nowrap;">发送验证码</button>
    </div>
    <label>新密码</label>
    <input id="pwd-new" type="password" autocomplete="new-password" placeholder="6-100 位" />
    <label>确认新密码</label>
    <input id="pwd-confirm" type="password" autocomplete="new-password" placeholder="再次输入新密码" />
    <div class="flex-end mt16" style="gap:10px;">
      <button class="btn" id="pwd-cancel" type="button">取消</button>
      <button class="btn btn-primary" id="pwd-ok" type="button">确认修改</button>
    </div>`);

  const sendBtn = box.querySelector('#pwd-send');
  let left = 0, timer = null;
  const startCountdown = () => {
    left = 60; sendBtn.disabled = true;
    sendBtn.textContent = left + 's 后重发';
    timer = setInterval(() => {
      left -= 1;
      if (left <= 0) { clearInterval(timer); sendBtn.disabled = false; sendBtn.textContent = '发送验证码'; }
      else sendBtn.textContent = left + 's 后重发';
    }, 1000);
  };

  sendBtn.addEventListener('click', async () => {
    sendBtn.disabled = true;
    try {
      await api('/auth/password/code', { method: 'POST' });
      toast('验证码已发送至绑定邮箱', 'success');
      startCountdown();
    } catch (e) {
      sendBtn.disabled = false;
      toast(e.message, 'error');
    }
  });

  box.querySelector('#pwd-cancel').addEventListener('click', closeModal);
  box.querySelector('#pwd-ok').addEventListener('click', async () => {
    const code = box.querySelector('#pwd-code').value.trim();
    const np = box.querySelector('#pwd-new').value;
    const cp = box.querySelector('#pwd-confirm').value;
    if (!/^\d{6}$/.test(code)) return toast('请输入 6 位验证码', 'error');
    if (np.length < 6 || np.length > 100) return toast('新密码需 6-100 位', 'error');
    if (np !== cp) return toast('两次输入的新密码不一致', 'error');
    const okBtn = box.querySelector('#pwd-ok');
    okBtn.disabled = true;
    try {
      await api('/auth/password/change', { method: 'POST', body: { code, new_password: np } });
      toast('密码修改成功', 'success');
      closeModal();
    } catch (e) {
      toast(e.message, 'error');
      okBtn.disabled = false;
    }
  });
}
