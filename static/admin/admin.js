// 管理后台 SPA
let ME = null;
let PAGE = { users: 1, orders: 1, files: 1, shares: 1 };
let FILTER = { users: '', orders: '', files: '' };
let PLANS_CACHE = [];

async function init() {
  ME = await getMe(true);
  if (!ME) return location.replace('/login.html?redirect=' + encodeURIComponent('/admin/index.html'));
  if (ME.role !== 'admin') {
    document.getElementById('main').innerHTML =
      '<div class="empty"><div class="big">⛔</div>无管理员权限</div>';
    return;
  }
  document.getElementById('admin-email').textContent = ME.email;
  document.querySelectorAll('#side a').forEach((a) =>
    a.addEventListener('click', () => switchTab(a.dataset.tab))
  );
  await loadPlansCache();
  switchTab('dashboard');
}

async function loadPlansCache() {
  try { const r = await api('/admin/plans'); PLANS_CACHE = r.plans; } catch { PLANS_CACHE = []; }
}

function switchTab(tab) {
  document.querySelectorAll('#side a').forEach((a) =>
    a.classList.toggle('active', a.dataset.tab === tab)
  );
  ({ dashboard: renderDashboard, users: renderUsers, plans: renderPlansTab, orders: renderOrders,
     files: renderFiles, shares: renderShares, settings: renderSettings }[tab])();
}

function setMain(html) { document.getElementById('main').innerHTML = html; }

function pager(total, size, cur, onGo) {
  const pages = Math.max(1, Math.ceil(total / size));
  return `<div class="pager">
    <span class="small muted">共 ${total} 条 · 第 ${cur}/${pages} 页</span>
    <button class="btn btn-sm" data-go="${cur - 1}" ${cur <= 1 ? 'disabled' : ''}>上一页</button>
    <button class="btn btn-sm" data-go="${cur + 1}" ${cur >= pages ? 'disabled' : ''}>下一页</button>
  </div>`;
}
function bindPager(el, onGo) {
  el.querySelectorAll('[data-go]').forEach((b) =>
    b.addEventListener('click', () => { const p = parseInt(b.dataset.go, 10); if (p >= 1) onGo(p); })
  );
}

/* ---------------- 仪表盘 ---------------- */
async function renderDashboard() {
  setMain('<div class="empty">加载中…</div>');
  const s = await api('/admin/stats');
  setMain(`
    <h2>数据概览</h2>
    <div class="stat-grid">
      <div class="stat-card"><div class="label">注册用户</div><div class="value">${s.users}</div><div class="sub">封禁 ${s.banned}</div></div>
      <div class="stat-card"><div class="label">文件数量</div><div class="value">${s.files}</div><div class="sub">文件夹 ${s.folders}</div></div>
      <div class="stat-card"><div class="label">存储占用</div><div class="value" style="font-size:20px">${fmtBytes(s.storage_bytes)}</div><div class="sub">R2 实际对象</div></div>
      <div class="stat-card"><div class="label">有效分享</div><div class="value">${s.active_shares}</div></div>
      <div class="stat-card"><div class="label">订单总数</div><div class="value">${s.orders}</div><div class="sub">已支付 ${s.paid_orders}</div></div>
      <div class="stat-card"><div class="label">累计收入</div><div class="value">¥${Number(s.revenue).toFixed(2)}</div><div class="sub">今日 ¥${Number(s.today_revenue).toFixed(2)} / ${s.today_orders} 单</div></div>
    </div>
    <div class="card">
      <h3>快捷入口</h3>
      <div class="flex" style="gap:10px;flex-wrap:wrap">
        <button class="btn" data-go="users">用户管理</button>
        <button class="btn" data-go="plans">套餐配置</button>
        <button class="btn" data-go="orders">订单查询</button>
        <button class="btn" data-go="settings">支付/站点设置</button>
      </div>
    </div>`);
  document.querySelectorAll('[data-go]').forEach((b) => {
    if (['users', 'plans', 'orders', 'settings'].includes(b.dataset.go))
      b.onclick = () => switchTab(b.dataset.go);
  });
}

/* ---------------- 用户 ---------------- */
async function renderUsers() {
  setMain(`
    <h2>用户管理</h2>
    <div class="tool-row">
      <input type="text" id="u-q" placeholder="搜索邮箱 / 昵称" value="${esc(FILTER.users)}" />
      <button class="btn btn-primary" id="u-search">搜索</button>
    </div>
    <div class="card"><div class="table-wrap"><div id="u-body" class="empty">加载中…</div></div></div>`);
  const input = document.getElementById('u-q');
  const doSearch = () => { FILTER.users = input.value.trim(); PAGE.users = 1; loadUsers(); };
  document.getElementById('u-search').onclick = doSearch;
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') doSearch(); });
  await loadUsers();
}

async function loadUsers() {
  const body = document.getElementById('u-body');
  const r = await api('/admin/users', { query: { q: FILTER.users, page: PAGE.users, size: 20 } });
  body.innerHTML = `<table class="data">
    <thead><tr><th>ID</th><th>邮箱/昵称</th><th>角色</th><th>状态</th><th>套餐</th><th>空间用量</th><th>注册时间</th><th>操作</th></tr></thead>
    <tbody>${r.users.map((u) => `
      <tr data-id="${u.id}">
        <td>${u.id}</td>
        <td class="wrap"><div>${esc(u.email)}</div><div class="small muted">${esc(u.name || '')}</div></td>
        <td>${u.role === 'admin' ? '<span class="badge badge-amber">管理员</span>' : '<span class="badge badge-gray">用户</span>'}</td>
        <td>${statusBadge(u.status)}</td>
        <td>${u.membership_expires_at && new Date(u.membership_expires_at.replace(' ', 'T') + 'Z') > new Date()
            ? `<strong>${esc(u.membership_tier)}</strong><div class="small muted">至 ${fmtDate(u.membership_expires_at)}</div>`
            : '<span class="badge badge-gray">免费</span>'}
            ${u.quota_override_mb != null ? `<div class="small muted">自定义配额 ${u.quota_override_mb}MB</div>` : ''}</td>
        <td>${fmtBytes(u.used_bytes)}<div class="small muted">${u.file_count} 项</div></td>
        <td>${fmtDate(u.created_at)}</td>
        <td class="wrap">
          <button class="btn-link" data-a="member">会员</button>
          <button class="btn-link" data-a="quota">配额</button>
          <button class="btn-link" data-a="pwd">密码</button>
          <button class="btn-link" data-a="role">${u.role === 'admin' ? '取消管理员' : '设管理员'}</button>
          <button class="btn-link" data-a="status">${u.status === 'banned' ? '解封' : '封禁'}</button>
          <button class="btn-link danger" data-a="del">删除</button>
        </td>
      </tr>`).join('') || '<tr><td colspan="8" class="empty">无用户</td></tr>'}
    </tbody></table>
    <div id="u-pager"></div>`;
  document.querySelectorAll('#u-body tbody tr').forEach((tr) => {
    const id = Number(tr.dataset.id);
    const u = r.users.find((x) => x.id === id);
    tr.querySelectorAll('[data-a]').forEach((b) =>
      b.addEventListener('click', () => userAction(b.dataset.a, u))
    );
  });
  const p = document.getElementById('u-pager');
  p.innerHTML = pager(r.total, 20, PAGE.users, (n) => { PAGE.users = n; loadUsers(); });
  bindPager(p, (n) => { PAGE.users = n; loadUsers(); });
}

function userAction(act, u) {
  if (act === 'role') {
    const role = u.role === 'admin' ? 'user' : 'admin';
    confirmModal(`确认将 ${u.email} ${role === 'admin' ? '设为管理员' : '取消管理员权限'}？`, async () => {
      await api(`/admin/users/${u.id}/role`, { method: 'POST', body: { role } });
      toast('已更新', 'success'); loadUsers();
    });
  } else if (act === 'status') {
    const status = u.status === 'banned' ? 'active' : 'banned';
    confirmModal(`确认${status === 'banned' ? '封禁' : '解封'} ${u.email}？`, async () => {
      await api(`/admin/users/${u.id}/status`, { method: 'POST', body: { status } });
      toast('已更新', 'success'); loadUsers();
    });
  } else if (act === 'del') {
    confirmModal(`确认删除用户 ${u.email}？其全部文件与订单将被删除且不可恢复！`, async () => {
      await api(`/admin/users/${u.id}`, { method: 'DELETE' });
      toast('已删除', 'success'); loadUsers();
    }, '确认删除');
  } else if (act === 'quota') {
    openModal(`<h3>编辑空间配额 — ${esc(u.email)}</h3>
      <p class="small muted">留空表示跟随会员套餐；填写数值（MB）将强制覆盖。1024 MB = 1 GB。</p>
      <input type="number" id="q-mb" min="0" value="${u.quota_override_mb ?? ''}" placeholder="跟随套餐" />
      <div class="modal-foot"><button class="btn" id="m-c">取消</button><button class="btn btn-primary" id="m-ok">保存</button></div>`);
    document.getElementById('m-c').onclick = closeModal;
    document.getElementById('m-ok').onclick = async () => {
      await api(`/admin/users/${u.id}/quota`, { method: 'POST', body: { quota_mb: document.getElementById('q-mb').value } });
      closeModal(); toast('已保存', 'success'); loadUsers();
    };
  } else if (act === 'pwd') {
    openModal(`<h3>重置密码 — ${esc(u.email)}</h3>
      <input type="password" id="p-w" placeholder="新密码（至少 6 位）" />
      <div class="modal-foot"><button class="btn" id="m-c">取消</button><button class="btn btn-primary" id="m-ok">重置</button></div>`);
    document.getElementById('m-c').onclick = closeModal;
    document.getElementById('m-ok').onclick = async () => {
      try {
        await api(`/admin/users/${u.id}/password`, { method: 'POST', body: { password: document.getElementById('p-w').value } });
        closeModal(); toast('密码已重置', 'success');
      } catch (e) { toast(e.message, 'error'); }
    };
  } else if (act === 'member') {
    const active = u.membership_expires_at && new Date(u.membership_expires_at.replace(' ', 'T') + 'Z') > new Date();
    const defVal = active ? (u.membership_expires_at || '').replace(' ', 'T').slice(0, 16) : '';
    openModal(`<h3>设置会员 — ${esc(u.email)}</h3>
      <label>套餐</label>
      <select id="m-tier">
        <option value="free">免费（清除会员）</option>
        ${PLANS_CACHE.map((p) => `<option value="${p.key}" ${p.key === u.membership_tier && active ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}
      </select>
      <label>到期时间（本地时间；选套餐时留空则立即到期）</label>
      <input type="datetime-local" id="m-exp" value="${defVal}" step="60" />
      <div class="modal-foot"><button class="btn" id="m-c">取消</button><button class="btn btn-primary" id="m-ok">保存</button></div>`);
    document.getElementById('m-c').onclick = closeModal;
    document.getElementById('m-ok').onclick = async () => {
      const tier = document.getElementById('m-tier').value;
      const exp = document.getElementById('m-exp').value;
      try {
        await api(`/admin/users/${u.id}/membership`, { method: 'POST', body: { tier, expires_at: exp } });
        closeModal(); toast('已保存', 'success'); loadUsers();
      } catch (e) { toast(e.message, 'error'); }
    };
  }
}

function confirmModal(text, onOk, okText = '确认') {
  const m = openModal(`<h3>请确认</h3><p>${text}</p>
    <div class="modal-foot"><button class="btn" id="m-c">取消</button>
    <button class="btn btn-danger" id="m-ok">${okText}</button></div>`);
  m.querySelector('#m-c').onclick = closeModal;
  m.querySelector('#m-ok').onclick = async () => { try { await onOk(); } catch (e) { toast(e.message, 'error'); } };
}

/* ---------------- 套餐 ---------------- */
async function renderPlansTab() {
  await loadPlansCache();
  setMain(`
    <div class="flex" style="justify-content:space-between">
      <h2 style="margin:0">会员套餐</h2>
      <button class="btn btn-primary" id="p-add">＋ 新建套餐</button>
    </div>
    <div class="card mt16"><div class="table-wrap" id="p-body" class="empty">加载中…</div></div>`);
  document.getElementById('p-add').onclick = () => editPlan(null);
  const body = document.getElementById('p-body');
  body.innerHTML = `<table class="data">
    <thead><tr><th>ID</th><th>标识</th><th>名称</th><th>时长</th><th>价格</th><th>空间</th><th>单文件</th><th>排序</th><th>状态</th><th>操作</th></tr></thead>
    <tbody>${PLANS_CACHE.map((p) => `<tr data-id="${p.id}">
      <td>${p.id}</td><td>${esc(p.key)}</td><td>${esc(p.name)}</td>
      <td>${durationText(p)}</td><td>¥${Number(p.price).toFixed(2)}</td>
      <td>${fmtBytes(p.storage_quota_mb * 1024 * 1024)}</td>
      <td>${fmtBytes(p.max_file_mb * 1024 * 1024)}</td>
      <td>${p.sort_order}</td>
      <td>${p.status ? '<span class="badge badge-green">上架</span>' : '<span class="badge badge-gray">下架</span>'}</td>
      <td><button class="btn-link" data-a="edit">编辑</button><button class="btn-link danger" data-a="del">删除</button></td>
    </tr>`).join('') || '<tr><td colspan="10" class="empty">暂无套餐</td></tr>'}</tbody></table>`;
  body.querySelectorAll('tbody tr').forEach((tr) => {
    const p = PLANS_CACHE.find((x) => x.id === Number(tr.dataset.id));
    tr.querySelector('[data-a=edit]').onclick = () => editPlan(p);
    tr.querySelector('[data-a=del]').onclick = () =>
      confirmModal(`确认删除套餐「${p.name}」？已有订单的套餐将自动转为下架而非删除。`, async () => {
        await api(`/admin/plans/${p.id}`, { method: 'DELETE' });
        toast('已处理', 'success'); await loadPlansCache(); renderPlansTab();
      });
  });
}

function durationText(p) {
  if (p.duration_type === 'forever') return '永久';
  return p.duration_value + { day: ' 天', month: ' 个月', year: ' 年' }[p.duration_type];
}

function editPlan(p) {
  const isNew = !p;
  p = p || { key: '', name: '', duration_type: 'month', duration_value: 1, price: 0, storage_quota_mb: 10240, max_file_mb: 1024, benefits: '', sort_order: 0, status: 1 };
  openModal(`<h3>${isNew ? '新建套餐' : '编辑套餐'}</h3>
    ${isNew ? `<label>唯一标识（英文，如 monthly）</label><input id="f-key" value="${esc(p.key)}" placeholder="monthly" />` : ''}
    <label>名称</label><input id="f-name" value="${esc(p.name)}" />
    <div class="grid-2">
      <div><label>时长类型</label>
        <select id="f-dtype">
          <option value="day" ${p.duration_type === 'day' ? 'selected' : ''}>天</option>
          <option value="month" ${p.duration_type === 'month' ? 'selected' : ''}>月</option>
          <option value="year" ${p.duration_type === 'year' ? 'selected' : ''}>年</option>
          <option value="forever" ${p.duration_type === 'forever' ? 'selected' : ''}>永久</option>
        </select></div>
      <div><label>时长数值</label><input type="number" id="f-dval" value="${p.duration_value}" min="1" /></div>
    </div>
    <div class="grid-2">
      <div><label>价格（元）</label><input type="number" id="f-price" value="${p.price}" min="0" step="0.01" /></div>
      <div><label>排序</label><input type="number" id="f-sort" value="${p.sort_order}" /></div>
    </div>
    <div class="grid-2">
      <div><label>存储配额（MB）</label><input type="number" id="f-quota" value="${p.storage_quota_mb}" min="1" /></div>
      <div><label>单文件上限（MB）</label><input type="number" id="f-max" value="${p.max_file_mb}" min="1" /></div>
    </div>
    <label>权益说明（每行一条）</label><textarea id="f-ben" rows="3">${esc(p.benefits)}</textarea>
    <label class="switch-row"><input type="checkbox" id="f-status" style="width:auto" ${p.status ? 'checked' : ''} /> 上架销售</label>
    <div class="modal-foot"><button class="btn" id="m-c">取消</button><button class="btn btn-primary" id="m-ok">保存</button></div>`, true);
  document.getElementById('m-c').onclick = closeModal;
  document.getElementById('m-ok').onclick = async () => {
    const body = {
      key: isNew ? document.getElementById('f-key').value : p.key,
      name: document.getElementById('f-name').value,
      duration_type: document.getElementById('f-dtype').value,
      duration_value: document.getElementById('f-dval').value,
      price: document.getElementById('f-price').value,
      sort_order: document.getElementById('f-sort').value,
      storage_quota_mb: document.getElementById('f-quota').value,
      max_file_mb: document.getElementById('f-max').value,
      benefits: document.getElementById('f-ben').value,
      status: document.getElementById('f-status').checked ? 1 : 0,
    };
    try {
      if (isNew) await api('/admin/plans', { method: 'POST', body });
      else await api(`/admin/plans/${p.id}`, { method: 'PUT', body });
      closeModal(); toast('已保存', 'success'); await loadPlansCache(); renderPlansTab();
    } catch (e) { toast(e.message, 'error'); }
  };
}

/* ---------------- 订单 ---------------- */
async function renderOrders() {
  setMain(`<h2>订单管理</h2>
    <div class="tool-row">
      <select id="o-f">
        <option value="">全部状态</option>
        <option value="pending" ${FILTER.orders === 'pending' ? 'selected' : ''}>待支付</option>
        <option value="paid" ${FILTER.orders === 'paid' ? 'selected' : ''}>已支付</option>
        <option value="closed" ${FILTER.orders === 'closed' ? 'selected' : ''}>已关闭</option>
      </select>
      <button class="btn btn-primary" id="o-go">查询</button>
    </div>
    <div class="card"><div class="table-wrap" id="o-body" class="empty">加载中…</div></div>`);
  document.getElementById('o-go').onclick = () => {
    FILTER.orders = document.getElementById('o-f').value; PAGE.orders = 1; loadOrders();
  };
  await loadOrders();
}
async function loadOrders() {
  const r = await api('/admin/orders', { query: { status: FILTER.orders, page: PAGE.orders, size: 20 } });
  const body = document.getElementById('o-body');
  body.innerHTML = `<table class="data">
    <thead><tr><th>ID</th><th>订单号</th><th>用户</th><th>方案</th><th>金额</th><th>方式</th><th>状态</th><th>第三方流水</th><th>创建</th><th>支付</th></tr></thead>
    <tbody>${r.orders.map((o) => `<tr>
      <td>${o.id}</td><td class="wrap">${esc(o.order_no)}</td><td>${esc(o.user_email)}</td>
      <td>${esc(o.plan_name)}</td><td>¥${Number(o.amount).toFixed(2)}</td>
      <td>${payIcon(o.method)} ${payLabel(o.method)}</td><td>${statusBadge(o.status)}</td>
      <td class="wrap small">${esc(o.trade_no || '-')}</td><td class="small">${fmtDate(o.created_at)}</td><td class="small">${fmtDate(o.paid_at)}</td>
    </tr>`).join('') || '<tr><td colspan="10" class="empty">无订单</td></tr>'}</tbody></table>
    <div id="o-pager"></div>`;
  const p = document.getElementById('o-pager');
  p.innerHTML = pager(r.total, 20, PAGE.orders);
  bindPager(p, (n) => { PAGE.orders = n; loadOrders(); });
}

/* ---------------- 文件 ---------------- */
async function renderFiles() {
  setMain(`<h2>文件管理</h2>
    <div class="tool-row">
      <input id="f-q" value="${esc(FILTER.files)}" placeholder="按文件名搜索" />
      <button class="btn btn-primary" id="f-go">搜索</button>
    </div>
    <div class="card"><div class="table-wrap" id="f-body" class="empty">加载中…</div></div>`);
  document.getElementById('f-go').onclick = () => { FILTER.files = document.getElementById('f-q').value.trim(); PAGE.files = 1; loadFiles(); };
  document.getElementById('f-q').addEventListener('keydown', (e) => { if (e.key === 'Enter') document.getElementById('f-go').click(); });
  await loadFiles();
}
async function loadFiles() {
  const r = await api('/admin/files', { query: { q: FILTER.files, page: PAGE.files, size: 20 } });
  const body = document.getElementById('f-body');
  body.innerHTML = `<table class="data">
    <thead><tr><th>ID</th><th>归属用户</th><th>名称</th><th>类型</th><th>大小</th><th>创建</th><th>操作</th></tr></thead>
    <tbody>${r.files.map((f) => `<tr data-id="${f.id}">
      <td>${f.id}</td><td>${esc(f.user_email)}</td>
      <td class="wrap">${f.kind === 'folder' ? '📁 ' : ''}${esc(f.name)}</td>
      <td>${f.kind === 'file' ? esc(f.mime) : '文件夹'}</td>
      <td>${f.kind === 'file' ? fmtBytes(f.size) : '-'}</td>
      <td class="small">${fmtDate(f.created_at)}</td>
      <td><button class="btn-link danger" data-del="${f.id}">删除</button></td>
    </tr>`).join('') || '<tr><td colspan="7" class="empty">无文件</td></tr>'}</tbody></table>
    <div id="f-pager"></div>`;
  body.querySelectorAll('[data-del]').forEach((b) => {
    b.onclick = () => confirmModal('确认删除该项目？若为文件夹将递归删除其全部内容。', async () => {
      await api(`/admin/files/${b.dataset.del}`, { method: 'DELETE' });
      toast('已删除', 'success'); loadFiles();
    });
  });
  const p = document.getElementById('f-pager');
  p.innerHTML = pager(r.total, 20, PAGE.files);
  bindPager(p, (n) => { PAGE.files = n; loadFiles(); });
}

/* ---------------- 分享 ---------------- */
async function renderShares() {
  setMain(`<h2>分享管理</h2><div class="card"><div class="table-wrap" id="s-body" class="empty">加载中…</div></div>`);
  const r = await api('/admin/shares', { query: { page: PAGE.shares, size: 20 } });
  const body = document.getElementById('s-body');
  body.innerHTML = `<table class="data">
    <thead><tr><th>ID</th><th>用户</th><th>文件</th><th>链接</th><th>提取码</th><th>有效期</th><th>次数</th><th>状态</th><th>操作</th></tr></thead>
    <tbody>${r.shares.map((s) => `<tr>
      <td>${s.id}</td><td>${esc(s.user_email)}</td><td class="wrap">${esc(s.file_name)}</td>
      <td><a href="/s/${s.token}" target="_blank">/s/${s.token.slice(0, 10)}…</a></td>
      <td>${s.passcode ? esc(s.passcode) : '无'}</td>
      <td>${s.expires_at ? fmtDate(s.expires_at) : '永久'}</td>
      <td>${s.downloads}${s.max_downloads != null ? '/' + s.max_downloads : ''}</td>
      <td>${statusBadge(s.status)}</td>
      <td>${s.status === 'active' ? `<button class="btn-link danger" data-rev="${s.id}">撤销</button>` : '-'}</td>
    </tr>`).join('') || '<tr><td colspan="9" class="empty">暂无分享</td></tr>'}</tbody></table>
    <div id="s-pager"></div>`;
  body.querySelectorAll('[data-rev]').forEach((b) =>
    b.onclick = async () => {
      await api(`/admin/shares/${b.dataset.rev}`, { method: 'DELETE' });
      toast('已撤销', 'success'); renderShares();
    });
  const p = document.getElementById('s-pager');
  p.innerHTML = pager(r.total, 20, PAGE.shares);
  bindPager(p, (n) => { PAGE.shares = n; renderShares(); });
}

/* ---------------- 设置 ---------------- */
async function renderSettings() {
  setMain('<div class="empty">加载中…</div>');
  const r = await api('/admin/settings');
  const s = r.settings;
  const methods = [
    { key: 'wxpay', label: '微信支付' },
    { key: 'alipay', label: '支付宝' },
    { key: 'ecny', label: '数字人民币' },
    { key: 'usdt', label: 'USDT' },
  ];
  setMain(`<h2>系统设置</h2>
    <div class="grid-2">
      <div class="card">
        <h3>站点与免费版</h3>
        <label>站点名称</label><input id="set-site_name" value="${esc(s.site_name)}" />
        <label>站点标语</label><input id="set-site_slogan" value="${esc(s.site_slogan)}" />
        <label>客服邮箱</label><input id="set-support_email" value="${esc(s.support_email)}" />
        <div class="grid-2">
          <div><label>免费版空间（MB）</label><input type="number" id="set-free_quota_mb" value="${esc(s.free_quota_mb)}" /></div>
          <div><label>免费版单文件（MB）</label><input type="number" id="set-free_max_file_mb" value="${esc(s.free_max_file_mb)}" /></div>
        </div>
      </div>
      <div class="card">
        <div style="display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap">
          <h3 style="margin:0">易支付（EPay）配置</h3>
          <a class="btn btn-success btn-sm" href="https://apicn.payone.uk" target="_blank" rel="noopener noreferrer">开通商户 ↗</a>
        </div>
        <label>网关地址（到站点根目录即可，自动补 submit.php）</label>
        <input id="set-epay_api_url" value="${esc(s.epay_api_url)}" placeholder="https://pay.example.com" />
        <div class="grid-2">
          <div><label>商户 PID</label><input id="set-epay_pid" value="${esc(s.epay_pid)}" /></div>
          <div><label>商户密钥 KEY</label><input id="set-epay_key" type="password" value="${esc(s.epay_key)}" placeholder="留空不修改请重新填写" autocomplete="new-password" /></div>
        </div>
        <p class="field-hint">异步通知地址（在易支付后台填写）：<code id="notify-url"></code></p>
      </div>
    </div>

    <div class="card mt16">
      <h3>支付方式与通道代码</h3>
      <p class="small muted">勾选启用的支付方式；通道代码为提交给易支付的 <code>type</code> 参数，微信通常 wxpay、支付宝 alipay；数字人民币/USDT 各服务商可能不同（如 dcep、bank、usdt），按你的易支付后台填写。</p>
      <table class="data">
        <thead><tr><th>启用</th><th>支付方式</th><th>易支付 type 通道代码</th></tr></thead>
        <tbody>${methods.map((m) => `
          <tr>
            <td><input type="checkbox" id="en-${m.key}" style="width:auto" ${s[`pay_${m.key}_enabled`] === '1' ? 'checked' : ''} /></td>
            <td>${m.label}</td>
            <td><input id="set-type_${m.key}" value="${esc(s[`type_${m.key}`])}" style="max-width:220px" /></td>
          </tr>`).join('')}</tbody>
      </table>
    </div>

    <div class="card mt16">
      <h3>QQ 邮箱 SMTP（发信服务）</h3>
      <p class="small muted">用于发送改密码验证码、会员到期提醒与订单发票邮件。QQ 邮箱需在「设置 → 账号 → POP3/IMAP/SMTP」开启服务并生成 <b>授权码</b>（填授权码，不是邮箱登录密码）。推荐 <code>smtp.qq.com</code> + 端口 <code>465</code> + SSL。</p>
      <label style="display:flex;align-items:center;gap:8px;font-weight:600;">
        <input type="checkbox" id="set-smtp_enabled" style="width:auto" ${s.smtp_enabled === '1' ? 'checked' : ''} /> 启用邮件发送
      </label>
      <div class="grid-2">
        <div><label>SMTP 服务器</label><input id="set-smtp_host" value="${esc(s.smtp_host)}" placeholder="smtp.qq.com" /></div>
        <div><label>端口</label><input id="set-smtp_port" type="number" value="${esc(s.smtp_port)}" placeholder="465" /></div>
      </div>
      <div class="grid-2">
        <div><label>加密方式</label>
          <select id="set-smtp_security" style="width:100%;padding:9px 11px;border:1px solid var(--border,#d5dbe8);border-radius:8px;">
            <option value="ssl" ${s.smtp_security !== 'starttls' ? 'selected' : ''}>SSL（端口 465，推荐）</option>
            <option value="starttls" ${s.smtp_security === 'starttls' ? 'selected' : ''}>STARTTLS（端口 587）</option>
          </select>
        </div>
        <div><label>发信人名称</label><input id="set-smtp_from_name" value="${esc(s.smtp_from_name)}" placeholder="BDrive 商务网盘" /></div>
      </div>
      <div class="grid-2">
        <div><label>发信邮箱（账号）</label><input id="set-smtp_user" type="email" value="${esc(s.smtp_user)}" placeholder="yourname@qq.com" /></div>
        <div><label>SMTP 授权码</label><input id="set-smtp_pass" type="password" autocomplete="new-password" placeholder="${r.smtp_pass_configured ? '已配置，留空不修改' : '填写 QQ 邮箱授权码'}" /></div>
      </div>
      <div class="flex-end mt16" style="gap:10px;flex-wrap:wrap;">
        <input id="smtp-test-to" type="email" placeholder="测试收件邮箱" style="max-width:230px;padding:9px 11px;border:1px solid var(--border,#d5dbe8);border-radius:8px;" />
        <button class="btn" id="smtp-test-btn" type="button">发送测试邮件</button>
      </div>
    </div>

    <div class="flex-end mt16"><button class="btn btn-primary" id="save-settings" style="padding:10px 28px">保存全部设置</button></div>`);

  document.getElementById('notify-url').textContent = location.origin + '/api/payment/callback';

  document.getElementById('notify-url').textContent = location.origin + '/api/payment/callback';
  document.getElementById('save-settings').onclick = async () => {
    const payload = {};
    ['site_name', 'site_slogan', 'support_email', 'free_quota_mb', 'free_max_file_mb', 'epay_api_url', 'epay_pid'].forEach((k) => {
      payload[k] = document.getElementById('set-' + k).value.trim();
    });
    const keyVal = document.getElementById('set-epay_key').value.trim();
    if (keyVal) payload.epay_key = keyVal; // 密钥留空则不覆盖
    methods.forEach((m) => {
      payload[`pay_${m.key}_enabled`] = document.getElementById('en-' + m.key).checked ? '1' : '0';
      payload[`type_${m.key}`] = document.getElementById('set-type_' + m.key).value.trim();
    });
    // SMTP
    payload.smtp_enabled = document.getElementById('set-smtp_enabled').checked ? '1' : '0';
    ['smtp_host', 'smtp_port', 'smtp_security', 'smtp_user', 'smtp_from_name'].forEach((k) => {
      payload[k] = document.getElementById('set-' + k).value.trim();
    });
    const smtpPass = document.getElementById('set-smtp_pass').value.trim();
    if (smtpPass) payload.smtp_pass = smtpPass; // 授权码留空不覆盖
    try {
      await api('/admin/settings', { method: 'PUT', body: { settings: payload } });
      toast('设置已保存', 'success');
    } catch (e) { toast(e.message, 'error'); }
  };

  document.getElementById('smtp-test-btn').onclick = async () => {
    const to = document.getElementById('smtp-test-to').value.trim();
    if (!to) return toast('请先填写测试收件邮箱', 'error');
    const btn = document.getElementById('smtp-test-btn');
    btn.disabled = true; const oldTxt = btn.textContent; btn.textContent = '发送中…';
    try {
      await api('/admin/email/test', { method: 'POST', body: { to } });
      toast('测试邮件已发送，请查收', 'success');
    } catch (e) { toast(e.message, 'error'); }
    finally { btn.disabled = false; btn.textContent = oldTxt; }
  };
}

init();
