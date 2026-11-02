const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const compression = require('compression');
const sharp = require('sharp');
const { Server } = require('socket.io');

// ====== 数据持久化配置 ======
const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, 'data.json');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' },
  maxHttpBufferSize: 12 * 1024 * 1024,
  // 缩短心跳，减少内网穿透隧道因空闲被断开的情况
  pingInterval: 10000,
  pingTimeout: 15000
});

app.use(compression());
app.use(express.json({ limit: '20mb' }));
app.use(express.static(path.join(__dirname, 'public'), {
  etag: true,
  maxAge: 0,
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('.js') || filePath.endsWith('.css')) {
      // JS/CSS 带版本号 query，可放心长缓存，重复打开无需再走隧道
      res.setHeader('Cache-Control', 'public, max-age=3600');
    } else {
      res.setHeader('Cache-Control', 'public, max-age=0, must-revalidate');
    }
  }
}));

// ====== 商家密码（可在网页内修改，会持久化）======
let merchantPassword = '123456';

// ====== 内存数据存储 ======
// 产品列表
let products = [];
// 接龙记录 { id, productId, userNickname, color, size, timestamp }
let relayEntries = [];
// 公告 { content, updatedAt, updatedBy }
let announcement = { content: '', updatedAt: 0, updatedBy: '' };
// 在线用户 { socketId, nickname, role }
let onlineUsers = new Map();
// 商家通知队列 { id, type, message, productName, userName, timestamp, read }
let merchantNotifications = [];

let nextProductId = 1;
let nextRelayId = 1;
let nextNotifId = 1;

// ====== 持久化：加载 / 保存 ======
function loadData() {
  try {
    // 首次启动且挂载盘为空时，用镜像内置的 data.json 做初始数据
    const seedFile = path.join(__dirname, 'data.json');
    if (!fs.existsSync(DATA_FILE)) {
      if (DATA_FILE !== seedFile && fs.existsSync(seedFile)) {
        fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
        fs.copyFileSync(seedFile, DATA_FILE);
        console.log(`已初始化数据文件: ${DATA_FILE}`);
      } else {
        return;
      }
    }
    const raw = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    if (Array.isArray(raw.products)) products = raw.products;
    if (Array.isArray(raw.relayEntries)) relayEntries = raw.relayEntries;
    if (raw.announcement && typeof raw.announcement === 'object') announcement = raw.announcement;
    if (Array.isArray(raw.merchantNotifications)) merchantNotifications = raw.merchantNotifications;
    if (typeof raw.merchantPassword === 'string' && raw.merchantPassword) merchantPassword = raw.merchantPassword;
    nextProductId = raw.nextProductId || (products.reduce((m, p) => Math.max(m, p.id || 0), 0) + 1);
    nextRelayId = raw.nextRelayId || (relayEntries.reduce((m, e) => Math.max(m, e.id || 0), 0) + 1);
    nextNotifId = raw.nextNotifId || (merchantNotifications.reduce((m, n) => Math.max(m, n.id || 0), 0) + 1);
    console.log(`已加载数据: ${products.length} 个产品, ${relayEntries.length} 条接龙`);
  } catch (e) {
    console.error('加载数据失败:', e.message);
  }
}

function saveData() {
  try {
    const data = { products, relayEntries, announcement, merchantNotifications, merchantPassword, nextProductId, nextRelayId, nextNotifId };
    const tmp = DATA_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(data));
    fs.renameSync(tmp, DATA_FILE);
  } catch (e) {
    console.error('保存数据失败:', e.message);
  }
}

// 延迟合并写入，避免高频 IO
let saveTimer = null;
function scheduleSave() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => { saveTimer = null; saveData(); }, 300);
}

loadData();

// ====== 辅助函数 ======
function getPublicProducts() {
  return products.map(p => {
    const entries = relayEntries.filter(r => r.productId === p.id);
    return {
      id: p.id,
      name: p.name,
      colors: p.colors,
      sizes: p.sizes,
      createdAt: p.createdAt,
      createdBy: p.createdBy,
      updatedAt: p.updatedAt,
      updatedBy: p.updatedBy,
      hasImage: !!p.image,
      relayCount: entries.length,
      relayEntries: entries
    };
  });
}

// 图片单独接口：避免把 base64 大图塞进登录/同步响应（弱网和隧道会截断大响应）
// 支持 ?w=480 返回压缩缩略图，列表页显著减少流量、加快加载
const thumbCache = new Map();
const THUMB_MAX_ENTRIES = 300;

app.get('/api/image/:id', async (req, res) => {
  try {
    const p = products.find(x => x.id === Number(req.params.id));
    if (!p || !p.image) return res.status(404).end();
    if (!p.image.startsWith('data:')) return res.redirect(p.image);
    const m = p.image.match(/^data:([^;]+);base64,(.+)$/);
    if (!m) return res.status(404).end();
    let buf = Buffer.from(m[2], 'base64');
    let type = m[1];

    const w = Number(req.query.w);
    if (w && w > 0 && w <= 800) {
      const key = `${p.id}:${p.updatedAt || p.createdAt}:${w}`;
      const cached = thumbCache.get(key);
      if (cached) {
        buf = cached;
        type = 'image/jpeg';
      } else {
        buf = await sharp(buf).rotate()
          .resize({ width: w, withoutEnlargement: true })
          .jpeg({ quality: 62, mozjpeg: true })
          .toBuffer();
        type = 'image/jpeg';
        if (thumbCache.size >= THUMB_MAX_ENTRIES) thumbCache.clear();
        thumbCache.set(key, buf);
      }
    }
    res.setHeader('Content-Type', type);
    res.setHeader('Cache-Control', 'public, max-age=31536000');
    res.end(buf);
  } catch (e) {
    res.status(500).end();
  }
});

function getMerchantState() {
  return {
    products: getPublicProducts(),
    announcement,
    notifications: merchantNotifications
  };
}

function getUserState() {
  return {
    products: getPublicProducts(),
    announcement
  };
}

// ====== HTTP API（短连接，隧道/弱网下比长连接稳定）======
const sessions = new Map();

function createSession(user) {
  const token = crypto.randomUUID();
  sessions.set(token, user);
  return token;
}

function auth(req, role) {
  const token = req.headers['x-token'];
  const s = token ? sessions.get(token) : null;
  if (!s) return null;
  if (role && s.role !== role) return null;
  return s;
}

app.post('/api/login', (req, res) => {
  const { nickname, password, role } = req.body || {};
  if (!nickname || !nickname.trim()) return res.json({ success: false, message: '请填写昵称' });
  if (role === 'merchant') {
    if (password !== merchantPassword) return res.json({ success: false, message: '商家密码错误' });
    const token = createSession({ nickname: nickname.trim(), role: 'merchant' });
    return res.json({ success: true, token, state: getMerchantState() });
  }
  const token = createSession({ nickname: nickname.trim(), role: 'user' });
  res.json({ success: true, token, state: getUserState() });
});

app.get('/api/state', (req, res) => {
  const s = auth(req);
  if (!s) return res.json({ success: false, message: '登录已失效，请重新登录' });
  res.json({ success: true, state: s.role === 'merchant' ? getMerchantState() : getUserState() });
});

app.post('/api/products', (req, res) => {
  const s = auth(req, 'merchant');
  if (!s) return res.json({ success: false, message: '无权限' });
  const { name, image, colors, sizes } = req.body || {};
  if (!name || !name.trim()) return res.json({ success: false, message: '请填写产品名称' });
  const product = {
    id: nextProductId++,
    name: name.trim(),
    image: image || '',
    colors: Array.isArray(colors) ? colors.filter(c => c) : [],
    sizes: Array.isArray(sizes) ? sizes.filter(x => x) : [],
    createdAt: Date.now(),
    createdBy: s.nickname
  };
  products.push(product);
  scheduleSave();
  io.emit('products-updated', getPublicProducts());
  res.json({ success: true, product });
});

app.put('/api/products/:id', (req, res) => {
  const s = auth(req, 'merchant');
  if (!s) return res.json({ success: false, message: '无权限' });
  const p = products.find(x => x.id === Number(req.params.id));
  if (!p) return res.json({ success: false, message: '产品不存在' });
  const { name, image, colors, sizes } = req.body || {};
  if (name) p.name = name.trim();
  if (typeof image === 'string' && image) p.image = image;
  if (Array.isArray(colors)) p.colors = colors.filter(c => c);
  if (Array.isArray(sizes)) p.sizes = sizes.filter(x => x);
  p.updatedAt = Date.now();
  p.updatedBy = s.nickname;
  scheduleSave();
  io.emit('products-updated', getPublicProducts());
  res.json({ success: true, product: p });
});

app.delete('/api/products/:id', (req, res) => {
  const s = auth(req, 'merchant');
  if (!s) return res.json({ success: false, message: '无权限' });
  const id = Number(req.params.id);
  const idx = products.findIndex(x => x.id === id);
  if (idx === -1) return res.json({ success: false, message: '产品不存在' });
  products.splice(idx, 1);
  relayEntries = relayEntries.filter(r => r.productId !== id);
  scheduleSave();
  io.emit('products-updated', getPublicProducts());
  res.json({ success: true });
});

app.post('/api/announcement', (req, res) => {
  const s = auth(req, 'merchant');
  if (!s) return res.json({ success: false, message: '无权限' });
  announcement = { content: (req.body || {}).content || '', updatedAt: Date.now(), updatedBy: s.nickname };
  scheduleSave();
  io.emit('announcement-updated', announcement);
  res.json({ success: true, announcement });
});

app.post('/api/relay', (req, res) => {
  const s = auth(req, 'user');
  if (!s) return res.json({ success: false, message: '请先以用户身份登录' });
  const { productId, color, size } = req.body || {};
  const product = products.find(p => p.id === productId);
  if (!product) return res.json({ success: false, message: '产品不存在' });
  const existing = relayEntries.find(r => r.productId === productId && r.userNickname === s.nickname);
  let message;
  if (existing) {
    existing.color = color;
    existing.size = size;
    existing.timestamp = Date.now();
    message = '已更新您的接龙信息';
  } else {
    relayEntries.push({
      id: nextRelayId++,
      productId,
      userNickname: s.nickname,
      color,
      size,
      timestamp: Date.now()
    });
    message = '接龙成功';
  }
  scheduleSave();
  io.emit('products-updated', getPublicProducts());
  res.json({ success: true, message });
});

app.delete('/api/relay/:productId', (req, res) => {
  const s = auth(req, 'user');
  if (!s) return res.json({ success: false, message: '请先以用户身份登录' });
  const productId = Number(req.params.productId);
  const product = products.find(p => p.id === productId);
  if (!product) return res.json({ success: false, message: '产品不存在' });
  const idx = relayEntries.findIndex(r => r.productId === productId && r.userNickname === s.nickname);
  if (idx === -1) return res.json({ success: false, message: '您还没有接龙此产品' });
  relayEntries.splice(idx, 1);
  scheduleSave();
  io.emit('products-updated', getPublicProducts());
  const notif = {
    id: nextNotifId++,
    type: 'cancel-relay',
    message: `用户「${s.nickname}」取消了产品「${product.name}」的接龙`,
    productName: product.name,
    userName: s.nickname,
    timestamp: Date.now(),
    read: false
  };
  merchantNotifications.unshift(notif);
  if (merchantNotifications.length > 50) merchantNotifications.pop();
  scheduleSave();
  io.to('merchants').emit('merchant-notification', notif);
  res.json({ success: true, message: '已取消接龙' });
});

app.post('/api/password', (req, res) => {
  const s = auth(req, 'merchant');
  if (!s) return res.json({ success: false, message: '无权限' });
  const { oldPassword, newPassword } = req.body || {};
  if (oldPassword !== merchantPassword) return res.json({ success: false, message: '原密码不正确' });
  if (!newPassword || newPassword.length < 4) return res.json({ success: false, message: '新密码至少 4 位' });
  merchantPassword = newPassword;
  scheduleSave();
  res.json({ success: true });
});

app.post('/api/notifications/clear', (req, res) => {
  const s = auth(req, 'merchant');
  if (!s) return res.json({ success: false, message: '无权限' });
  merchantNotifications = [];
  scheduleSave();
  io.to('merchants').emit('notifications-updated', merchantNotifications);
  res.json({ success: true });
});

app.post('/api/logout', (req, res) => {
  const token = req.headers['x-token'];
  if (token) sessions.delete(token);
  res.json({ success: true });
});


// ====== Socket.io 连接处理 ======
io.on('connection', (socket) => {
  let currentUser = null;
  const respond = (fn, data) => { if (typeof fn === 'function') fn(data); };

  // 商家登录
  socket.on('merchant-login', ({ nickname, password }, callback) => {
    if (!nickname || !nickname.trim()) {
      return respond(callback, { success: false, message: '请填写昵称' });
    }
    if (password !== merchantPassword) {
      return respond(callback, { success: false, message: '商家密码错误' });
    }
    currentUser = { socketId: socket.id, nickname: nickname.trim(), role: 'merchant' };
    onlineUsers.set(socket.id, currentUser);
    socket.join('merchants');
    respond(callback, { success: true, state: getMerchantState() });
    io.emit('online-changed', { count: onlineUsers.size });
  });

  // 用户登录
  socket.on('user-login', ({ nickname }, callback) => {
    if (!nickname || !nickname.trim()) {
      return respond(callback, { success: false, message: '请填写昵称' });
    }
    currentUser = { socketId: socket.id, nickname: nickname.trim(), role: 'user' };
    onlineUsers.set(socket.id, currentUser);
    respond(callback, { success: true, state: getUserState() });
    io.emit('online-changed', { count: onlineUsers.size });
  });

  // 登出
  socket.on('logout', () => {
    onlineUsers.delete(socket.id);
    currentUser = null;
    socket.leave('merchants');
    io.emit('online-changed', { count: onlineUsers.size });
  });

  // 断开连接
  socket.on('disconnect', () => {
    onlineUsers.delete(socket.id);
    io.emit('online-changed', { count: onlineUsers.size });
  });

  // ====== 商家：添加产品 ======
  socket.on('add-product', (data, callback) => {
    if (!currentUser || currentUser.role !== 'merchant') {
      return respond(callback, { success: false, message: '无权限' });
    }
    const { name, image, colors, sizes } = data;
    if (!name || !name.trim()) {
      return respond(callback, { success: false, message: '请填写产品名称' });
    }
    const product = {
      id: nextProductId++,
      name: name.trim(),
      image: image || '',
      colors: Array.isArray(colors) ? colors.filter(c => c) : [],
      sizes: Array.isArray(sizes) ? sizes.filter(s => s) : [],
      createdAt: Date.now(),
      createdBy: currentUser.nickname
    };
    products.push(product);
    respond(callback, { success: true, product });
    scheduleSave();
    io.emit('products-updated', getPublicProducts());
  });

  // ====== 商家：修改产品 ======
  socket.on('update-product', (data, callback) => {
    if (!currentUser || currentUser.role !== 'merchant') {
      return respond(callback, { success: false, message: '无权限' });
    }
    const { id, name, image, colors, sizes } = data;
    const idx = products.findIndex(p => p.id === id);
    if (idx === -1) {
      return respond(callback, { success: false, message: '产品不存在' });
    }
    products[idx].name = (name || products[idx].name).trim();
    if (image !== undefined) products[idx].image = image;
    if (Array.isArray(colors)) products[idx].colors = colors.filter(c => c);
    if (Array.isArray(sizes)) products[idx].sizes = sizes.filter(s => s);
    products[idx].updatedAt = Date.now();
    products[idx].updatedBy = currentUser.nickname;
    respond(callback, { success: true, product: products[idx] });
    scheduleSave();
    io.emit('products-updated', getPublicProducts());
  });

  // ====== 商家：删除产品 ======
  socket.on('delete-product', ({ id }, callback) => {
    if (!currentUser || currentUser.role !== 'merchant') {
      return respond(callback, { success: false, message: '无权限' });
    }
    const idx = products.findIndex(p => p.id === id);
    if (idx === -1) {
      return respond(callback, { success: false, message: '产品不存在' });
    }
    const removed = products.splice(idx, 1)[0];
    // 同时删除相关接龙记录
    relayEntries = relayEntries.filter(r => r.productId !== id);
    respond(callback, { success: true });
    scheduleSave();
    io.emit('products-updated', getPublicProducts());
  });

  // ====== 商家：更新公告 ======
  socket.on('update-announcement', ({ content }, callback) => {
    if (!currentUser || currentUser.role !== 'merchant') {
      return respond(callback, { success: false, message: '无权限' });
    }
    announcement = {
      content: content || '',
      updatedAt: Date.now(),
      updatedBy: currentUser.nickname
    };
    respond(callback, { success: true, announcement });
    scheduleSave();
    io.emit('announcement-updated', announcement);
  });

  // ====== 用户：接龙 ======
  socket.on('join-relay', ({ productId, color, size }, callback) => {
    if (!currentUser || currentUser.role !== 'user') {
      return respond(callback, { success: false, message: '请先以用户身份登录' });
    }
    const product = products.find(p => p.id === productId);
    if (!product) {
      return respond(callback, { success: false, message: '产品不存在' });
    }
    // 同一用户同一产品只能接龙一次，更新即可
    const existing = relayEntries.find(
      r => r.productId === productId && r.userNickname === currentUser.nickname
    );
    if (existing) {
      existing.color = color;
      existing.size = size;
      existing.timestamp = Date.now();
      respond(callback, { success: true, entry: existing, message: '已更新您的接龙信息' });
    } else {
      const entry = {
        id: nextRelayId++,
        productId,
        userNickname: currentUser.nickname,
        color,
        size,
        timestamp: Date.now()
      };
      relayEntries.push(entry);
      respond(callback, { success: true, entry, message: '接龙成功' });
    }
    scheduleSave();
    io.emit('products-updated', getPublicProducts());
  });

  // ====== 用户：取消接龙 ======
  socket.on('cancel-relay', ({ productId }, callback) => {
    if (!currentUser || currentUser.role !== 'user') {
      return respond(callback, { success: false, message: '请先以用户身份登录' });
    }
    const product = products.find(p => p.id === productId);
    if (!product) {
      return respond(callback, { success: false, message: '产品不存在' });
    }
    const idx = relayEntries.findIndex(
      r => r.productId === productId && r.userNickname === currentUser.nickname
    );
    if (idx === -1) {
      return respond(callback, { success: false, message: '您还没有接龙此产品' });
    }
    relayEntries.splice(idx, 1);
    respond(callback, { success: true, message: '已取消接龙' });
    io.emit('products-updated', getPublicProducts());
    scheduleSave();
    // 给所有商家发送通知
    const notif = {
      id: nextNotifId++,
      type: 'cancel-relay',
      message: `用户「${currentUser.nickname}」取消了产品「${product.name}」的接龙`,
      productName: product.name,
      userName: currentUser.nickname,
      timestamp: Date.now(),
      read: false
    };
    merchantNotifications.unshift(notif);
    if (merchantNotifications.length > 50) merchantNotifications.pop();
    io.to('merchants').emit('merchant-notification', notif);
  });

  // ====== 商家：修改密码 ======
  socket.on('change-password', ({ oldPassword, newPassword }, callback) => {
    if (!currentUser || currentUser.role !== 'merchant') {
      return respond(callback, { success: false, message: '无权限' });
    }
    if (oldPassword !== merchantPassword) {
      return respond(callback, { success: false, message: '原密码不正确' });
    }
    if (!newPassword || newPassword.length < 4) {
      return respond(callback, { success: false, message: '新密码至少 4 位' });
    }
    merchantPassword = newPassword;
    respond(callback, { success: true });
    scheduleSave();
  });

  // 商家标记通知已读
  socket.on('mark-notification-read', ({ id }, callback) => {
    if (!currentUser || currentUser.role !== 'merchant') {
      return respond(callback, { success: false, message: '无权限' });
    }
    const n = merchantNotifications.find(x => x.id === id);
    if (n) n.read = true;
    respond(callback, { success: true });
    scheduleSave();
    io.to('merchants').emit('notifications-updated', merchantNotifications);
  });

  // 商家清空所有通知
  socket.on('clear-notifications', (_, callback) => {
    if (!currentUser || currentUser.role !== 'merchant') {
      return respond(callback, { success: false, message: '无权限' });
    }
    merchantNotifications = [];
    respond(callback, { success: true });
    scheduleSave();
    io.to('merchants').emit('notifications-updated', merchantNotifications);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`服装接龙服务已启动: http://localhost:${PORT}`);
  console.log(`商家密码: ${merchantPassword}`);
  console.log(`数据文件: ${DATA_FILE}`);
});

// 进程退出前落盘，防止丢数据
function shutdown() {
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
  saveData();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
