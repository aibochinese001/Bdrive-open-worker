// 网盘主应用
let ME = null;
let STATE = { parentId: null, data: null };

// 视图与分页（偏好本地记忆）
const VIEW_KEY = 'bdrive_view';
const SIZE_KEY = 'bdrive_page_size';
const PAGE_SIZE_OPTIONS = [15, 30, 60];
let VIEW = localStorage.getItem(VIEW_KEY);
if (VIEW !== 'list' && VIEW !== 'grid') {
  VIEW = typeof window !== 'undefined' && window.innerWidth <= 760 ? 'grid' : 'list';
}
let PAGE_SIZE = Number(localStorage.getItem(SIZE_KEY));
if (!PAGE_SIZE_OPTIONS.includes(PAGE_SIZE)) PAGE_SIZE = 15;
let PAGE = 1;

async function init() {
  ME = await renderNav('drive');
  if (!ME) return;
  bindToolbar();
  document.addEventListener('click', closeAllCardMenus);
  await loadFolder(null);
}

function bindToolbar() {
  document.getElementById('btn-upload').addEventListener('click', () =>
    document.getElementById('file-input').click()
  );
  document.getElementById('file-input').addEventListener('change', onPickFiles);
  document.getElementById('btn-folder').addEventListener('click', newFolder);
  document.getElementById('btn-refresh').addEventListener('click', () => loadFolder(STATE.parentId));
  document.getElementById('btn-shares').addEventListener('click', myShares);
  document.getElementById('btn-up').addEventListener('click', goUp);
  document.querySelectorAll('#view-toggle .vt-btn').forEach((b) =>
    b.addEventListener('click', () => setView(b.dataset.view))
  );
  updateViewToggle();
  let searchTimer;
  document.getElementById('search').addEventListener('input', (e) => {
    clearTimeout(searchTimer);
    const q = e.target.value.trim();
    searchTimer = setTimeout(() => (q ? doSearch(q) : loadFolder(STATE.parentId)), 280);
  });
}

function setView(v) {
  if (v !== 'list' && v !== 'grid') return;
  VIEW = v;
  localStorage.setItem(VIEW_KEY, v);
  PAGE = 1;
  updateViewToggle();
  renderList();
}
function updateViewToggle() {
  document.querySelectorAll('#view-toggle .vt-btn').forEach((b) =>
    b.classList.toggle('active', b.dataset.view === VIEW)
  );
}
function setPageSize(n) {
  if (!PAGE_SIZE_OPTIONS.includes(n)) return;
  PAGE_SIZE = n;
  localStorage.setItem(SIZE_KEY, String(n));
  PAGE = 1;
  renderList();
}

// 返回上一级：搜索态先退出搜索回到当前目录；否则按面包屑上溯一层
async function goUp() {
  if (STATE.data && STATE.data.searched) {
    document.getElementById('search').value = '';
    return loadFolder(STATE.parentId);
  }
  const crumbs = (STATE.data && STATE.data.breadcrumbs) || [];
  if (STATE.parentId == null && crumbs.length === 0) return; // 已在根目录
  const target = crumbs.length >= 2 ? Number(crumbs[crumbs.length - 2].id) : null;
  loadFolder(target);
}

function updateUpState() {
  const btn = document.getElementById('btn-up');
  if (!btn) return;
  const searching = !!(STATE.data && STATE.data.searched);
  const atRoot = STATE.parentId == null && ((STATE.data && STATE.data.breadcrumbs) || []).length === 0;
  btn.disabled = !searching && atRoot;
}

async function loadFolder(parentId) {
  STATE.parentId = parentId == null ? null : parentId;
  PAGE = 1;
  document.getElementById('search').value = '';
  try {
    STATE.data = await api('/drive/list', { query: { parent_id: parentId ?? '' } });
    renderAll();
  } catch (e) {
    toast(e.message, 'error');
  }
}

async function doSearch(q) {
  try {
    const r = await api('/drive/search', { query: { q } });
    STATE.data = { ...(STATE.data || {}), folders: [], files: r.files, breadcrumbs: [], parent_id: STATE.parentId, searched: q };
    PAGE = 1;
    renderBreadcrumbs();
    renderList();
  } catch (e) { toast(e.message, 'error'); }
}

function renderAll() {
  renderQuota();
  renderBreadcrumbs();
  renderList();
}

function allItems() {
  const d = STATE.data || {};
  return [...(d.folders || []), ...(d.files || [])];
}

function renderQuota() {
  const q = STATE.data.quota;
  const usedMb = q.used_bytes / 1024 / 1024;
  const pct = Math.min(100, (usedMb / q.quota_mb) * 100);
  const cls = pct >= 98 ? 'full' : pct >= 80 ? 'warn' : '';
  const expire = q.expires_at
    ? `会员有效期至 ${fmtDate(q.expires_at)}`
    : '免费版 · 升级享更大空间';
  document.getElementById('quota-card').innerHTML = `
    <div class="flex" style="justify-content:space-between">
      <strong>${esc(q.tier_name)}</strong>
      <a href="/pricing.html" class="btn btn-sm btn-primary">升级会员</a>
    </div>
    <div class="quota-bar ${cls}"><i style="width:${pct.toFixed(1)}%"></i></div>
    <div class="small muted">${fmtBytes(q.used_bytes)} / ${fmtBytes(q.quota_mb * 1024 * 1024)}
      · 单文件上限 ${fmtBytes(q.max_file_mb * 1024 * 1024)}</div>
    <div class="small muted">${expire}</div>`;
}

function renderBreadcrumbs() {
  const crumbs = STATE.data.breadcrumbs || [];
  const box = document.getElementById('breadcrumb');
  let html = `<a href="javascript:void(0)" data-pid="">全部文件</a>`;
  crumbs.forEach((c) => {
    html += `<span class="sep">/</span><a href="javascript:void(0)" data-pid="${c.id}">${esc(c.name)}</a>`;
  });
  if (STATE.data.searched) html += `<span class="sep">/</span><span>搜索“${esc(STATE.data.searched)}”</span>`;
  box.innerHTML = html;
  box.querySelectorAll('a').forEach((a) =>
    a.addEventListener('click', () => loadFolder(a.dataset.pid ? Number(a.dataset.pid) : null))
  );
  updateUpState();
}

// 统一的操作按钮
function actionsHtml(f) {
  return `
    ${f.kind === 'file' ? `<button class="btn-link" data-a="dl">下载</button>` : ''}
    <button class="btn-link" data-a="share">${f.share_token ? '分享管理' : '分享'}</button>
    <button class="btn-link" data-a="move">移动</button>
    <button class="btn-link" data-a="rename">重命名</button>
    <button class="btn-link danger" data-a="del">删除</button>`;
}

function handleItemAction(act, f) {
  if (act === 'dl') doDownload(f);
  else if (act === 'rename') renameItem(f);
  else if (act === 'move') moveItem(f);
  else if (act === 'share') shareItem(f);
  else if (act === 'del') deleteItem(f);
}

function wireItem(el, f) {
  const kind = f.kind;
  el.querySelector('[data-act=open]').addEventListener('click', () => {
    if (kind === 'folder') loadFolder(f.id);
    else doDownload(f);
  });
  const more = el.querySelector('[data-more]');
  const menu = el.querySelector('.fc-menu');
  if (more && menu) {
    more.addEventListener('click', (ev) => {
      ev.stopPropagation();
      const willOpen = menu.hidden;
      closeAllCardMenus();
      menu.hidden = !willOpen;
    });
  }
  el.querySelectorAll('.file-actions button, .fc-menu button').forEach((b) =>
    b.addEventListener('click', (ev) => {
      ev.stopPropagation();
      if (menu) menu.hidden = true;
      handleItemAction(b.dataset.a, f);
    })
  );
}

function closeAllCardMenus() {
  document.querySelectorAll('.file-list .fc-menu').forEach((m) => { m.hidden = true; });
}

// 生成带省略的页码：[1, '…', p-1, p, p+1, '…', last]
function pageNumbers(cur, last) {
  if (last <= 7) return Array.from({ length: last }, (_, i) => i + 1);
  const set = new Set([1, 2, cur - 1, cur, cur + 1, last - 1, last]);
  const nums = [...set].filter((n) => n >= 1 && n <= last).sort((a, b) => a - b);
  const out = [];
  for (let i = 0; i < nums.length; i += 1) {
    if (i > 0 && nums[i] - nums[i - 1] > 1) out.push('…');
    out.push(nums[i]);
  }
  return out;
}

function goPage(p) {
  const total = allItems().length;
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  PAGE = Math.min(Math.max(1, p), pages);
  renderList();
  document.getElementById('list-card').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function renderPager(total) {
  const box = document.getElementById('pager');
  if (!box) return;
  if (total === 0) { box.innerHTML = ''; return; }
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  if (PAGE > pages) PAGE = pages;
  const nums = pageNumbers(PAGE, pages);
  const btns = nums
    .map((n) =>
      n === '…'
        ? `<span class="pg-ellipsis">…</span>`
        : `<button type="button" class="pg ${n === PAGE ? 'active' : ''}" data-pg="${n}">${n}</button>`
    )
    .join('');
  const start = (PAGE - 1) * PAGE_SIZE + 1;
  const end = Math.min(total, PAGE * PAGE_SIZE);
  box.innerHTML = `
    <div class="pg-info small muted">共 ${total} 项 · ${start}-${end}</div>
    <div class="pg-btns">
      <button type="button" class="pg pg-prev" data-pg="${PAGE - 1}" ${PAGE <= 1 ? 'disabled' : ''}>上一页</button>
      ${btns}
      <button type="button" class="pg pg-next" data-pg="${PAGE + 1}" ${PAGE >= pages ? 'disabled' : ''}>下一页</button>
    </div>
    <select id="pg-size" class="pg-size" aria-label="每页数量">
      ${PAGE_SIZE_OPTIONS.map((n) => `<option value="${n}" ${n === PAGE_SIZE ? 'selected' : ''}>${n} 条/页</option>`).join('')}
    </select>`;
  box.querySelectorAll('[data-pg]').forEach((b) =>
    b.addEventListener('click', () => { if (!b.disabled) goPage(Number(b.dataset.pg)); })
  );
  box.querySelector('#pg-size').addEventListener('change', (e) => setPageSize(Number(e.target.value)));
}

function renderList() {
  const box = document.getElementById('file-list');
  const items = allItems();
  const isSearch = !!(STATE.data && STATE.data.searched);
  box.classList.toggle('is-grid', VIEW === 'grid');
  if (!items.length) {
    box.innerHTML = `<div class="empty"><div class="big">📂</div>${
      isSearch ? '没有找到匹配的文件' : '这个目录还是空的，点击上方上传文件或新建文件夹'}</div>`;
    renderPager(0);
    return;
  }

  const slice = items.slice((PAGE - 1) * PAGE_SIZE, PAGE * PAGE_SIZE);

  if (VIEW === 'grid') {
    box.innerHTML = slice
      .map((f) => {
        const fi = fileIcon(f.name, f.kind);
        const meta = f.kind === 'folder' ? '文件夹' : fmtBytes(f.size) + ' · ' + fmtDate(f.updated_at || f.created_at);
        return `<div class="file-card" data-id="${f.id}" data-kind="${f.kind}">
          <button type="button" class="fc-more" data-more aria-label="更多操作">⋯</button>
          <div class="fc-open" data-act="open">
            <div class="ficon big ${fi.cls}">${fi.icon}</div>
            <div class="fc-name" title="${esc(f.name)}">${esc(f.name)}</div>
            <div class="fc-meta">${meta}</div>
          </div>
          <div class="fc-menu" hidden>${actionsHtml(f)}</div>
        </div>`;
      })
      .join('');
  } else {
    box.innerHTML = slice
      .map((f) => {
        const fi = fileIcon(f.name, f.kind);
        return `<div class="file-row" data-id="${f.id}" data-kind="${f.kind}">
          <div class="ficon ${fi.cls}">${fi.icon}</div>
          <div class="file-main" data-act="open">
            <div class="file-name ${f.kind === 'folder' ? 'link' : ''}">${esc(f.name)}</div>
            <div class="file-meta">${f.kind === 'folder' ? '文件夹' : fmtBytes(f.size) + ' · ' + fmtDate(f.updated_at || f.created_at)}</div>
          </div>
          <div class="file-actions">${actionsHtml(f)}</div>
        </div>`;
      })
      .join('');
  }

  box.querySelectorAll('.file-row, .file-card').forEach((el) => {
    const id = Number(el.dataset.id);
    const f = items.find((x) => x.id === id);
    if (f) wireItem(el, f);
  });
  renderPager(items.length);
}

function doDownload(f) {
  authenticatedDownload(`${API}/drive/${f.id}/download`, f.name);
}

async function onPickFiles(e) {
  const list = Array.from(e.target.files || []);
  e.target.value = '';
  if (!list.length) return;
  const quota = STATE.data.quota;
  for (const file of list) {
    if (file.size > quota.max_file_mb * 1024 * 1024) {
      toast(`「${file.name}」超过单文件上限 ${fmtBytes(quota.max_file_mb * 1024 * 1024)}`, 'error');
      return;
    }
  }
  let box = document.getElementById('upload-box');
  if (!box) {
    box = document.createElement('div');
    box.id = 'upload-box';
    box.className = 'card progress-box';
    document.querySelector('.container').insertBefore(box, document.getElementById('list-card'));
  }
  for (const file of list) await uploadOne(file, box);
  await loadFolder(STATE.parentId);
  setTimeout(() => { if (box && !box.children.length) box.remove(); }, 1500);
}

async function uploadOne(file, box) {
  const item = document.createElement('div');
  item.className = 'progress-item';
  item.innerHTML = `<div class="pi-head"><span class="name">${esc(file.name)}</span>
    <span class="pct">0%</span></div>
    <div class="progress-track"><i style="width:0%"></i></div>`;
  box.appendChild(item);
  const pctEl = item.querySelector('.pct');
  const bar = item.querySelector('i');
  try {
    await uploadFile({
      file,
      parentId: STATE.parentId,
      onProgress: (loaded, total) => {
        const p = Math.round((loaded / total) * 100);
        pctEl.textContent = p + '%';
        bar.style.width = p + '%';
      },
    });
    pctEl.textContent = '完成 ✓';
    bar.style.width = '100%';
    bar.style.background = 'var(--success)';
    setTimeout(() => item.remove(), 2500);
  } catch (e) {
    pctEl.textContent = '失败：' + e.message;
    pctEl.style.color = 'var(--danger)';
    toast(`「${file.name}」${e.message}`, 'error');
  }
}

async function newFolder() {
  const m = openModal(`
    <h3>新建文件夹</h3>
    <label>文件夹名称</label>
    <input type="text" id="f-name" placeholder="请输入名称" autofocus />
    <div class="modal-foot">
      <button class="btn" id="m-cancel">取消</button>
      <button class="btn btn-primary" id="m-ok">创建</button>
    </div>`);
  m.querySelector('#m-cancel').onclick = closeModal;
  const input = m.querySelector('#f-name');
  const submit = async () => {
    const name = input.value.trim();
    if (!name) return toast('名称不能为空', 'error');
    try {
      await api('/drive/folder', { method: 'POST', body: { name, parent_id: STATE.parentId } });
      closeModal(); toast('已创建', 'success'); await loadFolder(STATE.parentId);
    } catch (e) { toast(e.message, 'error'); }
  };
  m.querySelector('#m-ok').onclick = submit;
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });
  setTimeout(() => input.focus(), 50);
}

function renameItem(f) {
  const m = openModal(`
    <h3>重命名</h3>
    <input type="text" id="r-name" value="${esc(f.name)}" />
    <div class="modal-foot">
      <button class="btn" id="m-cancel">取消</button>
      <button class="btn btn-primary" id="m-ok">保存</button>
    </div>`);
  m.querySelector('#m-cancel').onclick = closeModal;
  m.querySelector('#m-ok').onclick = async () => {
    try {
      await api(`/drive/${f.id}/rename`, { method: 'POST', body: { name: m.querySelector('#r-name').value } });
      closeModal(); toast('已重命名', 'success'); await loadFolder(STATE.parentId);
    } catch (e) { toast(e.message, 'error'); }
  };
}

function deleteItem(f) {
  const m = openModal(`
    <h3>删除确认</h3>
    <p>确定删除 <strong>${esc(f.name)}</strong> 吗？${
      f.kind === 'folder' ? '文件夹内的全部内容将一并删除，' : ''}且不可恢复。</p>
    <div class="modal-foot">
      <button class="btn" id="m-cancel">取消</button>
      <button class="btn btn-danger" id="m-ok">确认删除</button>
    </div>`);
  m.querySelector('#m-cancel').onclick = closeModal;
  m.querySelector('#m-ok').onclick = async () => {
    try {
      const r = await api(`/drive/${f.id}`, { method: 'DELETE' });
      closeModal(); toast(`已删除 ${r.deleted} 项`, 'success'); await loadFolder(STATE.parentId);
    } catch (e) { toast(e.message, 'error'); }
  };
}

// 目录选择器（移动）
function moveItem(f) {
  let target = STATE.parentId;
  const m = openModal(`
    <h3>移动「${esc(f.name)}」</h3>
    <div id="mv-crumb" class="breadcrumb" style="margin-bottom:8px"></div>
    <div id="mv-list" class="file-list" style="max-height:340px;overflow:auto;border:1px solid var(--border);border-radius:8px"></div>
    <div class="modal-foot">
      <button class="btn" id="m-cancel">取消</button>
      <button class="btn btn-primary" id="m-ok">移动到当前目录</button>
    </div>`);
  m.querySelector('#m-cancel').onclick = closeModal;

  async function renderPicker(dirId) {
    target = dirId;
    const r = await api('/drive/list', { query: { parent_id: dirId ?? '' } });
    const crumb = m.querySelector('#mv-crumb');
    let h = `<a href="javascript:void(0)" data-p="">全部文件</a>`;
    (r.breadcrumbs || []).forEach((c) => { h += `<span class="sep">/</span><a data-p="${c.id}">${esc(c.name)}</a>`; });
    crumb.innerHTML = h;
    crumb.querySelectorAll('a').forEach((a) => a.onclick = () => renderPicker(a.dataset.p ? Number(a.dataset.p) : null));

    const list = m.querySelector('#mv-list');
    const folders = r.folders.filter((x) => x.id !== f.id);
    list.innerHTML = folders.length
      ? folders.map((x) => {
          const fi = fileIcon(x.name, 'folder');
          return `<div class="file-row" data-id="${x.id}">
            <div class="ficon ${fi.cls}">${fi.icon}</div>
            <div class="file-main"><div class="file-name">${esc(x.name)}</div></div>
            <button class="btn-link">进入 →</button></div>`;
        }).join('')
      : `<div class="empty" style="padding:30px">该目录下没有子文件夹</div>`;
    list.querySelectorAll('.file-row').forEach((el) =>
      el.onclick = () => renderPicker(Number(el.dataset.id))
    );
  }
  m.querySelector('#m-ok').onclick = async () => {
    try {
      await api(`/drive/${f.id}/move`, { method: 'POST', body: { parent_id: target } });
      closeModal(); toast('已移动', 'success'); await loadFolder(STATE.parentId);
    } catch (e) { toast(e.message, 'error'); }
  };
  renderPicker(STATE.parentId);
}

// 分享
async function shareItem(f) {
  let existing = null;
  try {
    // 先尝试创建/复用；若已存在接口直接返回已有分享
  } catch {}
  const m = openModal(`
    <h3>分享「${esc(f.name)}」</h3>
    <div id="share-existing"></div>
    <div id="share-form">
      <label class="switch-row" style="margin-top:4px">
        <input type="checkbox" id="sh-code" style="width:auto" /> 设置提取码
      </label>
      <input type="password" id="sh-passcode" maxlength="4" inputmode="numeric" autocomplete="off" placeholder="留空则随机生成 4 位数字" style="display:none" />
      <label>有效期</label>
      <select id="sh-expire">
        <option value="">永久有效</option>
        <option value="1">1 天</option>
        <option value="7" selected>7 天</option>
        <option value="30">30 天</option>
        <option value="90">90 天</option>
        <option value="365">1 年</option>
      </select>
      <label>下载次数限制（选填）</label>
      <input type="number" id="sh-max" min="1" placeholder="不限制" />
    </div>
    <div class="modal-foot">
      <button class="btn" id="m-cancel">取消</button>
      <button class="btn btn-primary" id="m-ok">${f.share_token ? '查看分享' : '创建分享'}</button>
    </div>`);

  const codeCk = m.querySelector('#sh-code');
  const codeIn = m.querySelector('#sh-passcode');
  // 密码框已被小眼睛脚本包裹进 .pwd-wrap；显隐需同时作用于外层包裹和输入框本身
  const syncCodeView = () => {
    const show = codeCk.checked;
    const wrap = codeIn.closest('.pwd-wrap') || codeIn;
    wrap.style.display = show ? 'block' : 'none';
    wrap.style.marginTop = show ? '8px' : '';
    if (show) codeIn.style.display = 'block';
  };
  codeCk.addEventListener('change', syncCodeView);
  m.querySelector('#m-cancel').onclick = closeModal;

  // 已有分享 → 展示
  if (f.share_token) {
    showShareInfo(f.share_token, m, true);
    return;
  }
  m.querySelector('#m-ok').onclick = async () => {
    const body = {
      with_passcode: codeCk.checked,
      passcode: codeIn.value.trim(),
      expires_days: m.querySelector('#sh-expire').value,
      max_downloads: m.querySelector('#sh-max').value,
    };
    try {
      const r = await api(`/drive/${f.id}/share`, { method: 'POST', body });
      showShareInfo(r.share.token, m, false, r.share.passcode);
      await loadFolder(STATE.parentId);
    } catch (e) { toast(e.message, 'error'); }
  };
}

function showShareInfo(token, m, loadDetail, knownCode) {
  const url = location.origin + '/s/' + token;
  m.querySelector('#share-form')?.style.setProperty('display', 'none');
  const okBtn = m.querySelector('#m-ok');
  if (okBtn) okBtn.style.display = 'none';
  const box = m.querySelector('#share-existing');
  box.innerHTML = `<div id="share-detail" class="small muted">加载中…</div>`;
  (async () => {
    let detail = '';
    if (loadDetail) {
      try {
        const r = await api(`/public/share/${token}`);
        detail = `提取码：${r.need_passcode ? '<strong>见下方</strong>' : '无'} · 下载 ${r.share.downloads} 次`;
      } catch { /* 有码时公开接口不带 code 会 403，忽略 */ }
    }
    box.innerHTML = `
      <label>分享链接</label>
      <div class="copy-box"><span style="flex:1">${esc(url)}</span>
        <button class="btn btn-sm" id="cp-link">复制</button></div>
      <div id="code-area" class="mt8"></div>
      <div class="small muted mt8">${detail}</div>
      <div class="modal-foot">
        <button class="btn btn-danger" id="sh-revoke">取消分享</button>
        <a class="btn btn-primary" href="/share.html?token=${token}" target="_blank">打开分享页</a>
      </div>`;
    box.querySelector('#cp-link').onclick = () => copyText(url);
    box.querySelector('#sh-revoke').onclick = async () => {
      // 需要分享 id；从“我的分享”中查
      try {
        const r = await api('/drive/shares/list');
        const sh = r.shares.find((x) => x.token === token);
        if (sh) await api(`/drive/shares/${sh.id}`, { method: 'DELETE' });
        closeModal(); toast('已取消分享', 'success'); await loadFolder(STATE.parentId);
      } catch (e) { toast(e.message, 'error'); }
    };
    const codeArea = box.querySelector('#code-area');
    if (knownCode) {
      codeArea.innerHTML = `<label>提取码</label>
        <div class="copy-box"><span style="flex:1">${esc(knownCode)}</span>
        <button class="btn btn-sm" id="cp-code">复制</button></div>`;
      codeArea.querySelector('#cp-code').onclick = () => copyText(knownCode);
    }
  })();
}

async function myShares() {
  let r;
  try { r = await api('/drive/shares/list'); } catch (e) { return toast(e.message, 'error'); }
  const m = openModal(`
    <h3>我的分享</h3>
    <div class="table-wrap"><table class="data">
      <thead><tr><th>文件</th><th>链接/提取码</th><th>有效期</th><th>次数</th><th></th></tr></thead>
      <tbody>${
        r.shares.length
          ? r.shares.map((s) => `<tr>
              <td class="wrap">${esc(s.file_name)}</td>
              <td><a href="/s/${s.token}" target="_blank">/s/${s.token.slice(0, 8)}…</a>${
                s.passcode ? `<div class="small muted">码 ${esc(s.passcode)}</div>` : ''}</td>
              <td>${s.expires_at ? fmtDate(s.expires_at) : '永久'}</td>
              <td>${s.downloads}${s.max_downloads != null ? '/' + s.max_downloads : ''}</td>
              <td><button class="btn-link danger" data-id="${s.id}">取消</button></td>
            </tr>`).join('')
          : `<tr><td colspan="5" class="empty" style="padding:30px">暂无分享</td></tr>`
      }</tbody></table></div>
    <div class="modal-foot"><button class="btn" id="m-cancel">关闭</button></div>`, true);
  m.querySelector('#m-cancel').onclick = closeModal;
  m.querySelectorAll('button[data-id]').forEach((b) =>
    b.onclick = async () => {
      try {
        await api(`/drive/shares/${b.dataset.id}`, { method: 'DELETE' });
        closeModal(); toast('已取消分享', 'success'); await loadFolder(STATE.parentId);
      } catch (e) { toast(e.message, 'error'); }
    }
  );
}

init();
