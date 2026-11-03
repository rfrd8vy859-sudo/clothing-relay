// ====== 全局状态 ======
// socket 只作为实时增强：即使 socket.io 脚本加载失败，页面和所有按钮也必须可用
const socket = (typeof io === 'function')
  ? io({ transports: ['polling'] })
  : { connected: false, on() {}, connect() {}, emit() {}, disconnect() {} };
let currentRole = null;      // 'merchant' | 'user'
let currentNickname = '';
let currentProducts = [];
let currentAnnouncement = { content: '', updatedAt: 0, updatedBy: '' };
let notifications = [];
let editingProductId = null; // 正在编辑的产品ID

// ====== DOM 工具 ======
const $ = (id) => document.getElementById(id);

function showToast(msg, type = 'info') {
  const toast = $('toast');
  toast.textContent = msg;
  toast.style.background = type === 'error' ? 'rgba(220,53,69,0.9)' :
                           type === 'success' ? 'rgba(40,167,69,0.9)' :
                           'rgba(0,0,0,0.8)';
  toast.style.display = 'block';
  clearTimeout(toast._timer);
  toast._timer = setTimeout(() => { toast.style.display = 'none'; }, 2500);
}

function escapeHtml(s) {
  const div = document.createElement('div');
  div.textContent = s;
  return div.innerHTML;
}

// 所有写操作走 HTTP 短连接，避免隧道掐断长连接导致按钮无响应
let sessionToken = '';

async function api(method, url, body) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15000);
  try {
    const res = await fetch(url, {
      method,
      headers: Object.assign(
        { 'Content-Type': 'application/json' },
        sessionToken ? { 'X-Token': sessionToken } : {}
      ),
      body: body ? JSON.stringify(body) : undefined,
      signal: ctrl.signal,
      cache: 'no-store'
    });
    return await res.json();
  } catch (e) {
    return { success: false, message: '网络请求失败，请检查网络后重试' };
  } finally {
    clearTimeout(timer);
  }
}

// 保留原有调用方式，内部改为 HTTP 请求
function emitAck(event, payload, onResult) {
  const p = (payload || {});
  let req;
  switch (event) {
    case 'add-product': req = api('POST', '/api/products', p); break;
    case 'update-product': req = api('PUT', '/api/products/' + p.id, p); break;
    case 'delete-product': req = api('DELETE', '/api/products/' + p.id); break;
    case 'update-announcement': req = api('POST', '/api/announcement', p); break;
    case 'join-relay': req = api('POST', '/api/relay', p); break;
    case 'cancel-relay': req = api('DELETE', '/api/relay/' + p.productId); break;
    case 'change-password': req = api('POST', '/api/password', p); break;
    case 'clear-notifications': req = api('POST', '/api/notifications/clear'); break;
    default: req = Promise.resolve({ success: false, message: '不支持的操作' });
  }
  req.then(res => {
    onResult(res);
    if (res.success) refreshState();
  });
}

// 连接状态提示（实时推送可选，数据靠轮询同步）
function renderConnStatus() {
  const el = $('conn-status');
  if (!el) return;
  el.textContent = '● 数据已连接，每 5 秒自动同步';
  el.className = 'conn-status ok';
}
renderConnStatus();

function formatTime(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  const pad = n => n < 10 ? '0' + n : n;
  return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// ====== 登录相关 ======
let selectedRole = 'user';

document.querySelectorAll('.role-tab').forEach(tab => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.role-tab').forEach(t => t.classList.remove('active'));
    tab.classList.add('active');
    selectedRole = tab.dataset.role;
    $('password-group').style.display = selectedRole === 'merchant' ? 'block' : 'none';
    $('login-tip').textContent = '';
  });
});

$('login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const nickname = $('nickname').value.trim();
  const password = $('password').value;
  $('login-tip').textContent = '';
  $('login-tip').style.color = '';
  $('login-btn').disabled = true;
  $('login-btn').textContent = '登录中…';

  if (!nickname) {
    $('login-tip').textContent = '请填写昵称';
    $('login-btn').disabled = false;
    $('login-btn').textContent = '登 录';
    return;
  }

  if (selectedRole === 'merchant' && !password) {
    $('login-tip').textContent = '请填写商家密码';
    $('login-btn').disabled = false;
    $('login-btn').textContent = '登 录';
    return;
  }

  const res = await api('POST', '/api/login', {
    nickname,
    password,
    role: selectedRole
  });

  $('login-btn').disabled = false;
  $('login-btn').textContent = '登 录';

  if (res.success) {
    sessionToken = res.token;
    currentRole = selectedRole;
    currentNickname = nickname;
    $('login-tip').textContent = '';
    initApp(res.state);
    socket.connect();
  } else {
    $('login-tip').textContent = res.message;
    $('login-tip').style.color = '#dc3545';
  }
});

$('logout-btn').addEventListener('click', () => {
  api('POST', '/api/logout');
  sessionToken = '';
  socket.emit('logout');
  currentRole = null;
  currentNickname = '';
  $('app').classList.add('hidden');
  $('login-page').classList.remove('hidden');
  $('nickname').value = '';
  $('password').value = '';
});

// ====== 商家修改密码 ======
$('change-password-btn').addEventListener('click', () => {
  $('old-password').value = '';
  $('new-password').value = '';
  $('password-modal').style.display = 'flex';
});

$('password-cancel-btn').addEventListener('click', () => {
  $('password-modal').style.display = 'none';
});

$('password-save-btn').addEventListener('click', () => {
  const oldPassword = $('old-password').value;
  const newPassword = $('new-password').value;
  if (!oldPassword || !newPassword) {
    showToast('请填写原密码和新密码', 'error');
    return;
  }
  if (newPassword.length < 4) {
    showToast('新密码至少 4 位', 'error');
    return;
  }
  emitAck('change-password', { oldPassword, newPassword }, (res) => {
    if (res.success) {
      showToast('密码修改成功，请牢记新密码', 'success');
      $('password-modal').style.display = 'none';
      $('password').value = '';
    } else {
      showToast(res.message, 'error');
    }
  });
});

// ====== 初始化应用 ======
function initApp(state) {
  $('login-page').classList.add('hidden');
  $('app').classList.remove('hidden');

  $('role-badge').textContent = currentRole === 'merchant' ? '商家' : '用户';
  $('role-badge').className = 'role-badge ' + currentRole;
  $('user-info').textContent = `👤 ${currentNickname}`;

  // 商家专用元素
  const isMerchant = currentRole === 'merchant';
  $('add-product-btn').style.display = isMerchant ? 'inline-block' : 'none';
  $('edit-announcement-btn').style.display = isMerchant ? 'inline-block' : 'none';
  $('change-password-btn').style.display = isMerchant ? 'inline-block' : 'none';
  $('notification-section').style.display = isMerchant ? 'block' : 'none';

  // 加载初始数据
  currentProducts = state.products || [];
  currentAnnouncement = state.announcement || { content: '', updatedAt: 0, updatedBy: '' };
  notifications = state.notifications || [];

  renderAnnouncement();
  renderProducts();
  if (isMerchant) renderNotifications();
}

// ====== 实时事件监听 ======
socket.on('products-updated', (products) => {
  currentProducts = products;
  renderProducts();
});

socket.on('announcement-updated', (ann) => {
  currentAnnouncement = ann;
  renderAnnouncement();
});

socket.on('merchant-notification', (notif) => {
  if (currentRole !== 'merchant') return;
  notifications.unshift(notif);
  renderNotifications();
  showToast('🔔 收到新通知：' + notif.message, 'info');
});

socket.on('notifications-updated', (list) => {
  notifications = list;
  renderNotifications();
});

socket.on('online-changed', ({ count }) => {
  $('online-count').textContent = `在线: ${count}`;
});

// ====== 数据同步（HTTP 轮询）======
function applyState(state) {
  if (state.products) { currentProducts = state.products; renderProducts(); }
  if (state.announcement) { currentAnnouncement = state.announcement; renderAnnouncement(); }
  if (state.notifications && currentRole === 'merchant') {
    notifications = state.notifications;
    renderNotifications();
  }
}

async function refreshState() {
  if (!sessionToken) return;
  const res = await api('GET', '/api/state');
  if (res.success) applyState(res.state);
}

// 每 5 秒同步一次，保证商家更新后用户端能看到最新数据
setInterval(() => {
  if (currentRole) refreshState();
}, 5000);

// ====== 公告渲染 ======
function renderAnnouncement() {
  const ann = currentAnnouncement;
  if (ann.content) {
    $('announcement-text').textContent = ann.content;
    $('announcement-text').style.display = 'inline';
    $('announcement-empty').style.display = 'none';
  } else {
    $('announcement-text').style.display = 'none';
    $('announcement-empty').style.display = 'inline';
  }
  $('announcement-meta').textContent = ann.updatedAt
    ? `最后更新：${formatTime(ann.updatedAt)} · ${ann.updatedBy || ''}`
    : '';
}

// 公告编辑
let editingAnnouncement = false;
$('edit-announcement-btn').addEventListener('click', () => {
  editingAnnouncement = true;
  $('announcement-view').style.display = 'none';
  $('announcement-editor').style.display = 'block';
  $('announcement-editor').value = currentAnnouncement.content || '';
  $('edit-announcement-btn').style.display = 'none';
  $('save-announcement-btn').style.display = 'inline-block';
  $('cancel-announcement-btn').style.display = 'inline-block';
  $('announcement-editor').focus();
});

$('cancel-announcement-btn').addEventListener('click', () => {
  editingAnnouncement = false;
  $('announcement-view').style.display = 'block';
  $('announcement-editor').style.display = 'none';
  $('edit-announcement-btn').style.display = 'inline-block';
  $('save-announcement-btn').style.display = 'none';
  $('cancel-announcement-btn').style.display = 'none';
});

$('save-announcement-btn').addEventListener('click', () => {
  const content = $('announcement-editor').value.trim();
  emitAck('update-announcement', { content }, (res) => {
    if (res.success) {
      showToast('公告已更新', 'success');
      editingAnnouncement = false;
      $('announcement-view').style.display = 'block';
      $('announcement-editor').style.display = 'none';
      $('edit-announcement-btn').style.display = 'inline-block';
      $('save-announcement-btn').style.display = 'none';
      $('cancel-announcement-btn').style.display = 'none';
    } else {
      showToast(res.message, 'error');
    }
  });
});

// ====== 通知渲染 ======
function renderNotifications() {
  const list = $('notification-list');
  if (!notifications.length) {
    list.innerHTML = '<span class="empty-tip">暂无通知</span>';
    return;
  }
  list.innerHTML = notifications.map(n => `
    <div class="notification-item ${n.read ? '' : 'unread'}">
      <span>${escapeHtml(n.message)}</span>
      <span class="notif-time">${formatTime(n.timestamp)}</span>
    </div>
  `).join('');
}

$('clear-notifications-btn').addEventListener('click', () => {
  showConfirm('提示', '确定要清空所有通知吗？', () => {
    emitAck('clear-notifications', {}, (res) => {
      if (res.success) showToast('已清空', 'success');
    });
  });
});

// ====== 产品渲染 ======
let searchKeyword = '';

// 关键词按空格拆分，全部命中名称/颜色/尺码才算匹配
function productMatches(p, keyword) {
  const words = keyword.toLowerCase().split(/\s+/).filter(Boolean);
  const hay = [p.name || '', ...(p.colors || []), ...(p.sizes || [])].join(' ').toLowerCase();
  return words.every(w => hay.includes(w));
}

function renderProducts() {
  const grid = $('products-grid');
  if (!currentProducts.length) {
    grid.innerHTML = '<span class="empty-tip">暂无产品</span>';
    return;
  }

  const keyword = searchKeyword.trim();
  const list = keyword ? currentProducts.filter(p => productMatches(p, keyword)) : currentProducts;
  if (!list.length) {
    grid.innerHTML = `<span class="empty-tip">没有找到与「${escapeHtml(keyword)}」相关的产品</span>`;
    return;
  }

  const isMerchant = currentRole === 'merchant';
  grid.innerHTML = list.map(p => {
    const myEntry = p.relayEntries.find(e => e.userNickname === currentNickname);
    const relayListHtml = p.relayEntries.length
      ? p.relayEntries.map(e =>
          `<div class="relay-list-item">· ${escapeHtml(e.userNickname)} - ${escapeHtml(e.color||'-')} / ${escapeHtml(e.size||'-')}</div>`
        ).join('')
      : '';

    const actionsHtml = isMerchant
      ? `
        <button class="btn btn-sm btn-ghost" onclick="openRelayList(${p.id})">接龙名单 ${p.relayCount}</button>
        <button class="btn btn-sm btn-primary" onclick="openEditProduct(${p.id})">修改</button>
        <button class="btn btn-sm btn-danger" onclick="deleteProduct(${p.id})">删除</button>
      `
      : myEntry
        ? `
          <button class="btn btn-sm btn-primary" onclick="openRelayModal(${p.id})">修改接龙</button>
          <button class="btn btn-sm btn-ghost" onclick="cancelRelay(${p.id})">取消接龙</button>
        `
        : `<button class="btn btn-sm btn-primary" onclick="openRelayModal(${p.id})">接龙</button>`;

    return `
      <div class="product-card">
        ${p.hasImage
          ? `<img src="/api/image/${p.id}?v=${p.updatedAt || p.createdAt}&w=400" class="product-image" alt="${escapeHtml(p.name)}" loading="lazy">`
          : `<div class="product-image">暂无图片</div>`}
        <div class="product-body">
          <div class="product-name">${escapeHtml(p.name)}</div>
          ${p.colors.length ? `
            <div class="product-options">
              <div class="option-label">颜色</div>
              <div class="option-tags">${p.colors.map(c => `<span class="option-tag">${escapeHtml(c)}</span>`).join('')}</div>
            </div>` : ''}
          ${p.sizes.length ? `
            <div class="product-options">
              <div class="option-label">尺码</div>
              <div class="option-tags">${p.sizes.map(s => `<span class="option-tag">${escapeHtml(s)}</span>`).join('')}</div>
            </div>` : ''}
          <div class="relay-count">已有 ${p.relayCount} 人接龙</div>
          ${relayListHtml ? `<div class="relay-list">${relayListHtml}</div>` : ''}
          <div class="product-actions">${actionsHtml}</div>
        </div>
      </div>
    `;
  }).join('');
}

// ====== 搜索栏 ======
$('product-search').addEventListener('input', (e) => {
  searchKeyword = e.target.value;
  $('product-search-clear').style.display = searchKeyword ? 'block' : 'none';
  renderProducts();
});

$('product-search-clear').addEventListener('click', () => {
  $('product-search').value = '';
  searchKeyword = '';
  $('product-search-clear').style.display = 'none';
  renderProducts();
  $('product-search').focus();
});

// ====== 商家查看接龙名单 ======
function openRelayList(productId) {
  const p = currentProducts.find(x => x.id === productId);
  if (!p) return;
  $('relay-list-title').textContent = `接龙名单 · ${p.name}（共 ${p.relayEntries.length} 人）`;
  const list = $('relay-detail-list');
  if (!p.relayEntries.length) {
    list.innerHTML = '<span class="empty-tip" style="display:block;padding:16px;">暂无接龙</span>';
  } else {
    list.innerHTML = p.relayEntries.map((e, i) => `
      <div class="relay-detail-item">
        <span class="relay-detail-index">${i + 1}</span>
        <span class="relay-detail-name">${escapeHtml(e.userNickname)}</span>
        <span class="relay-detail-spec">${escapeHtml(e.color || '-')} / ${escapeHtml(e.size || '-')}</span>
        <span class="relay-detail-time">${formatTime(e.timestamp)}</span>
      </div>
    `).join('');
  }
  $('relay-list-modal').style.display = 'flex';
}

$('relay-list-close-btn').addEventListener('click', () => {
  $('relay-list-modal').style.display = 'none';
});

// ====== 产品：添加 / 编辑 ======
let editColors = [];
let editSizes = [];
let editImageData = null;

$('add-product-btn').addEventListener('click', () => {
  openProductModal(null);
});

function openProductModal(productId) {
  editingProductId = productId;
  $('product-modal-title').textContent = productId ? '修改产品' : '上架产品';
  $('product-name').value = '';
  editColors = [];
  editSizes = [];
  editImageData = null;   // null = 未更换图片
  renderColorTags();
  renderSizeTags();
  $('image-preview').innerHTML = '<span class="image-placeholder">点击上传图片</span>';
  $('product-image').value = '';

  if (productId) {
    const p = currentProducts.find(x => x.id === productId);
    if (p) {
      $('product-name').value = p.name;
      editColors = [...p.colors];
      editSizes = [...p.sizes];
      renderColorTags();
      renderSizeTags();
      if (p.hasImage) {
        $('image-preview').innerHTML = `<img src="/api/image/${p.id}?v=${p.updatedAt || p.createdAt}" alt="preview">`;
      }
    }
  }
  $('product-modal').style.display = 'flex';
}

function openEditProduct(id) { openProductModal(id); }

$('product-cancel-btn').addEventListener('click', () => {
  $('product-modal').style.display = 'none';
});

$('product-save-btn').addEventListener('click', () => {
  const name = $('product-name').value.trim();
  if (!name) { showToast('请填写产品名称', 'error'); return; }

  const payload = {
    name,
    image: editImageData,
    colors: editColors,
    sizes: editSizes
  };

  if (editingProductId) {
    payload.id = editingProductId;
    emitAck('update-product', payload, (res) => {
      if (res.success) {
        showToast('产品已更新', 'success');
        $('product-modal').style.display = 'none';
      } else {
        showToast(res.message, 'error');
      }
    });
  } else {
    emitAck('add-product', payload, (res) => {
      if (res.success) {
        showToast('产品已上架', 'success');
        $('product-modal').style.display = 'none';
      } else {
        showToast(res.message, 'error');
      }
    });
  }
});

// 删除产品
function deleteProduct(id) {
  const p = currentProducts.find(x => x.id === id);
  if (!p) return;
  showConfirm('删除产品', `确定要删除产品「${p.name}」吗？相关接龙记录也会被清除。`, () => {
    emitAck('delete-product', { id }, (res) => {
      if (res.success) {
        showToast('产品已删除', 'success');
      } else {
        showToast(res.message, 'error');
      }
    });
  });
}

// ====== 图片上传 ======
// 压缩图片，避免超过 Socket.io 传输上限
function compressImage(file, maxDim, quality) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      let w = img.naturalWidth;
      let h = img.naturalHeight;
      const scale = Math.min(1, maxDim / Math.max(w, h));
      w = Math.round(w * scale);
      h = Math.round(h * scale);
      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, w, h);
      ctx.drawImage(img, 0, 0, w, h);
      resolve(canvas.toDataURL('image/jpeg', quality));
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('图片读取失败')); };
    img.src = url;
  });
}

$('product-image').addEventListener('change', (e) => {
  const file = e.target.files[0];
  if (!file) return;
  if (!file.type.startsWith('image/')) {
    showToast('请选择图片文件', 'error');
    return;
  }
  compressImage(file, 900, 0.72)
    .then((data) => {
      editImageData = data;
      $('image-preview').innerHTML = `<img src="${editImageData}" alt="preview">`;
    })
    .catch(() => showToast('图片处理失败，请重试', 'error'));
});

// ====== 颜色/尺码标签 ======
function renderColorTags() {
  $('color-list').innerHTML = editColors.map((c, i) =>
    `<span class="tag" onclick="removeColor(${i})">${escapeHtml(c)} <span class="tag-remove">×</span></span>`
  ).join('');
}
function renderSizeTags() {
  $('size-list').innerHTML = editSizes.map((s, i) =>
    `<span class="tag" onclick="removeSize(${i})">${escapeHtml(s)} <span class="tag-remove">×</span></span>`
  ).join('');
}
function removeColor(i) { editColors.splice(i, 1); renderColorTags(); }
function removeSize(i) { editSizes.splice(i, 1); renderSizeTags(); }

$('color-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    const v = e.target.value.trim();
    if (v && !editColors.includes(v)) {
      editColors.push(v);
      renderColorTags();
    }
    e.target.value = '';
  }
});
$('size-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    const v = e.target.value.trim();
    if (v && !editSizes.includes(v)) {
      editSizes.push(v);
      renderSizeTags();
    }
    e.target.value = '';
  }
});

// ====== 接龙弹窗 ======
let relayProductId = null;
let relaySelectedColor = '';
let relaySelectedSize = '';

function openRelayModal(productId) {
  const p = currentProducts.find(x => x.id === productId);
  if (!p) return;
  relayProductId = productId;
  relaySelectedColor = '';
  relaySelectedSize = '';

  // 如果已有接龙记录，预填
  const myEntry = p.relayEntries.find(e => e.userNickname === currentNickname);
  if (myEntry) {
    relaySelectedColor = myEntry.color;
    relaySelectedSize = myEntry.size;
    $('relay-modal-title').textContent = '修改接龙信息';
  } else {
    $('relay-modal-title').textContent = '参与接龙';
  }

  $('relay-product-info').innerHTML = `产品：<strong>${escapeHtml(p.name)}</strong>`;

  const colorHtml = p.colors.length
    ? p.colors.map(c => `<div class="option-item ${c === relaySelectedColor ? 'selected' : ''}" data-val="${escapeHtml(c)}" onclick="selectRelayColor('${escapeHtml(c).replace(/'/g,"\\'")}')">${escapeHtml(c)}</div>`).join('')
    : '<span class="empty-tip" style="padding:0;">商家暂未设置颜色</span>';
  const sizeHtml = p.sizes.length
    ? p.sizes.map(s => `<div class="option-item ${s === relaySelectedSize ? 'selected' : ''}" data-val="${escapeHtml(s)}" onclick="selectRelaySize('${escapeHtml(s).replace(/'/g,"\\'")}')">${escapeHtml(s)}</div>`).join('')
    : '<span class="empty-tip" style="padding:0;">商家暂未设置尺码</span>';

  $('relay-color-options').innerHTML = colorHtml;
  $('relay-size-options').innerHTML = sizeHtml;
  $('relay-modal').style.display = 'flex';
}

function selectRelayColor(c) {
  relaySelectedColor = c;
  document.querySelectorAll('#relay-color-options .option-item').forEach(el => {
    el.classList.toggle('selected', el.dataset.val === c);
  });
}
function selectRelaySize(s) {
  relaySelectedSize = s;
  document.querySelectorAll('#relay-size-options .option-item').forEach(el => {
    el.classList.toggle('selected', el.dataset.val === s);
  });
}

$('relay-cancel-btn').addEventListener('click', () => {
  $('relay-modal').style.display = 'none';
});

$('relay-confirm-btn').addEventListener('click', () => {
  const p = currentProducts.find(x => x.id === relayProductId);
  if (!p) return;

  if (p.colors.length && !relaySelectedColor) {
    showToast('请选择颜色', 'error');
    return;
  }
  if (p.sizes.length && !relaySelectedSize) {
    showToast('请选择尺码', 'error');
    return;
  }

  const isUpdate = p.relayEntries.some(e => e.userNickname === currentNickname);
  const actionText = isUpdate ? '更新' : '接龙';
  const detail = `产品：${p.name}\n颜色：${relaySelectedColor || '无'}\n尺码：${relaySelectedSize || '无'}`;

  showConfirm(`确认${actionText}`, `确定要${actionText}吗？\n\n${detail}`, () => {
    emitAck('join-relay', {
      productId: relayProductId,
      color: relaySelectedColor,
      size: relaySelectedSize
    }, (res) => {
      if (res.success) {
        showToast(res.message, 'success');
        $('relay-modal').style.display = 'none';
      } else {
        showToast(res.message, 'error');
      }
    });
  });
});

// ====== 取消接龙 ======
function cancelRelay(productId) {
  const p = currentProducts.find(x => x.id === productId);
  if (!p) return;
  showConfirm('取消接龙', `确定要取消产品「${p.name}」的接龙吗？商家会收到通知。`, () => {
    emitAck('cancel-relay', { productId }, (res) => {
      if (res.success) {
        showToast('已取消接龙', 'success');
      } else {
        showToast(res.message, 'error');
      }
    });
  });
}

// ====== 通用确认弹窗 ======
let confirmCallback = null;

function showConfirm(title, body, onOk) {
  $('confirm-title').textContent = title;
  $('confirm-body').textContent = body;
  confirmCallback = onOk;
  $('confirm-modal').style.display = 'flex';
}

$('confirm-cancel-btn').addEventListener('click', () => {
  $('confirm-modal').style.display = 'none';
  confirmCallback = null;
});

$('confirm-ok-btn').addEventListener('click', () => {
  if (confirmCallback) confirmCallback();
  $('confirm-modal').style.display = 'none';
  confirmCallback = null;
});

// 点击遮罩关闭弹窗
document.querySelectorAll('.modal-overlay').forEach(overlay => {
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) overlay.style.display = 'none';
  });
});

// 初始化在线数显示
socket.on('connect', () => {
  $('online-count').textContent = '在线: 0';
});
