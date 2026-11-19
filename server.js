'use strict';
/**
 * 秋天工坊 · 卡密网关
 * 零依赖 Node 服务：门禁页 + 卡密系统 + 管理后台
 * 部署：Render / Railway / 任意 Node 18+ 主机
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = parseInt(process.env.PORT || '3000', 10);
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');
const PUBLIC_DIR = path.join(__dirname, 'public');
const INDEX_FILE = path.join(PUBLIC_DIR, 'index.html');
const ADMIN_FILE = path.join(PUBLIC_DIR, 'admin.html');
const GATE_FILE = path.join(PUBLIC_DIR, 'gate.html');

const UPSTASH_URL = (process.env.UPSTASH_REDIS_REST_URL || '').replace(/\/+$/, '');
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || '';
const REDIS_KEY = process.env.REDIS_KEY || 'qiutian_gate_db';

const ADMIN_ENV_PASSWORD = (process.env.ADMIN_PASSWORD || '').trim();
const SITE_TITLE = process.env.SITE_TITLE || '秋天工坊';

const SESSION_ROLE_USER = 'user';
const SESSION_ROLE_ADMIN = 'admin';
const USER_SESSION_MS_COUNT = 12 * 3600e3;      // 次数卡：单次会话 12 小时
const USER_SESSION_MS_FOREVER = 30 * 86400e3;   // 永久卡：会话 30 天
const ADMIN_SESSION_MS = 12 * 3600e3;

const TYPES = {
  count:   { label: '次数卡', unit: '次',   def: 30, ms: null },
  hour:    { label: '小时卡', unit: '小时', def: 1,  ms: 3600e3 },
  day:     { label: '天卡',   unit: '天',   def: 1,  ms: 86400e3 },
  week:    { label: '周卡',   unit: '周',   def: 1,  ms: 7 * 86400e3 },
  month:   { label: '月卡',   unit: '月',   def: 1,  ms: 30 * 86400e3 },
  forever: { label: '永久卡', unit: '',     def: 0,  ms: null },
};

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

const now = () => Date.now();

/* ---------------------------------------------------------------- 存储 */

let db = {
  version: 1,
  publicMode: false,
  adminHash: null,
  adminSalt: null,
  keys: [],
  sessions: [],
  logs: [],
  createdAt: now(),
};

function ensureDir() {
  try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch (_) {}
}

async function redisGet() {
  const r = await fetch(`${UPSTASH_URL}/get/${encodeURIComponent(REDIS_KEY)}`, {
    headers: { Authorization: `Bearer ${UPSTASH_TOKEN}` },
  });
  if (!r.ok) throw new Error('redis get ' + r.status);
  const j = await r.json();
  return j.result ? JSON.parse(j.result) : null;
}

async function redisSet(value) {
  const r = await fetch(`${UPSTASH_URL}/set/${encodeURIComponent(REDIS_KEY)}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${UPSTASH_TOKEN}`, 'Content-Type': 'text/plain' },
    body: JSON.stringify(value),
  });
  if (!r.ok) throw new Error('redis set ' + r.status);
}

const REDIS_MODE = Boolean(UPSTASH_URL && UPSTASH_TOKEN);

// remoteLoaded：是否成功从云端读过一次。没读成功之前绝不往云端写，免得用空库把线上卡密冲掉。
const storageState = {
  mode: REDIS_MODE ? 'redis' : 'file',
  remoteLoaded: !REDIS_MODE,
  remoteHealthy: !REDIS_MODE,
  lastError: '',
};

function writeLocalDB() {
  ensureDir();
  const tmp = DB_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(db), 'utf8');
  fs.renameSync(tmp, DB_FILE);
}

function readLocalDB() {
  try {
    ensureDir();
    if (fs.existsSync(DB_FILE)) {
      const raw = fs.readFileSync(DB_FILE, 'utf8');
      if (raw.trim()) return JSON.parse(raw);
    }
  } catch (_) {}
  return null;
}

// 把云端数据和本地数据合并，谁新谁留下，避免任何一边被空数据冲掉
function mergeRemote(remote, localWins) {
  if (!remote || typeof remote !== 'object') return;

  const keyMap = new Map();
  const firstKeys = localWins ? (remote.keys || []) : (db.keys || []);
  const secondKeys = localWins ? (db.keys || []) : (remote.keys || []);
  firstKeys.forEach((k) => { if (k && k.code) keyMap.set(k.code, k); });
  secondKeys.forEach((k) => { if (k && k.code) keyMap.set(k.code, k); });
  if (keyMap.size) db.keys = Array.from(keyMap.values());
  else if (Array.isArray(remote.keys)) db.keys = remote.keys;

  const sessMap = new Map();
  (db.sessions || []).forEach((s) => { if (s && s.token) sessMap.set(s.token, s); });
  (remote.sessions || []).forEach((s) => { if (s && s.token && !sessMap.has(s.token)) sessMap.set(s.token, s); });
  db.sessions = Array.from(sessMap.values());

  const logMap = new Map();
  [...(db.logs || []), ...(remote.logs || [])].forEach((l) => {
    if (l && l.t) logMap.set(l.t + '|' + l.type + '|' + (l.detail || ''), l);
  });
  db.logs = Array.from(logMap.values()).sort((a, b) => b.t - a.t).slice(0, 500);

  const localModeAt = db.publicModeAt || 0;
  const remoteModeAt = remote.publicModeAt || 0;
  if (localModeAt || remoteModeAt) {
    db.publicMode = localModeAt > remoteModeAt ? !!db.publicMode : !!remote.publicMode;
    db.publicModeAt = Math.max(localModeAt, remoteModeAt);
  } else if (!localWins) {
    db.publicMode = !!remote.publicMode;
  }

  if (remote.adminHash) { db.adminHash = remote.adminHash; db.adminSalt = remote.adminSalt; }
  db.createdAt = db.createdAt || remote.createdAt || now();
  db.version = remote.version || db.version;
}

async function loadDB() {
  if (REDIS_MODE) {
    try {
      const remote = await redisGet();
      storageState.remoteLoaded = true;
      storageState.remoteHealthy = true;
      storageState.lastError = '';
      if (remote) {
        mergeRemote(remote, false);
      } else {
        // 云端是空的：如果本机还有缓存（同一台机器重启），先推上去
        const local = readLocalDB();
        if (local && Array.isArray(local.keys) && local.keys.length) {
          db = Object.assign(db, local);
          await redisSet(db);
        }
      }
      return;
    } catch (e) {
      storageState.remoteLoaded = false;
      storageState.remoteHealthy = false;
      storageState.lastError = e.message;
      console.error('[db] redis load failed:', e.message);
      // 云端读不到：先用本地缓存顶上，但一个字都不往云端写
      const local = readLocalDB();
      if (local) db = Object.assign(db, local);
      return;
    }
  }
  const local = readLocalDB();
  if (local) db = Object.assign(db, local);
}

let saveQueue = Promise.resolve();
function saveDB() {
  saveQueue = saveQueue.then(async () => {
    try {
      if (REDIS_MODE) {
        if (!storageState.remoteLoaded) {
          // 还没成功读过云端 → 只落本地缓存，等重连后再说
          writeLocalDB();
          return;
        }
        await redisSet(db);
        storageState.remoteHealthy = true;
        storageState.lastError = '';
        writeLocalDB();
        return;
      }
      writeLocalDB();
    } catch (e) {
      storageState.remoteHealthy = false;
      storageState.lastError = e.message;
      console.error('[db] save failed:', e.message);
      try { writeLocalDB(); } catch (_) {}
    }
  });
  return saveQueue;
}

// 云端掉线后自动重连：连上就恢复读写，云端空则把本地缓存推回去
if (REDIS_MODE) {
  const retryTimer = setInterval(async () => {
    if (storageState.remoteLoaded) return;
    try {
      const remote = await redisGet();
      storageState.remoteLoaded = true;
      storageState.remoteHealthy = true;
      storageState.lastError = '';
      if (remote) {
        mergeRemote(remote, true);
      }
      await redisSet(db);
      console.log('[db] redis reconnected');
    } catch (e) {
      storageState.lastError = e.message;
    }
  }, Number(process.env.REDIS_RETRY_MS || 60000));
  if (retryTimer.unref) retryTimer.unref();
}

/* ---------------------------------------------------------------- 工具 */

function hashPassword(pw, salt) {
  return crypto.scryptSync(String(pw), salt, 32).toString('hex');
}

function makeSalt() { return crypto.randomBytes(16).toString('hex'); }

function verifyAdminPassword(pw) {
  if (ADMIN_ENV_PASSWORD) {
    const a = Buffer.from(String(pw));
    const b = Buffer.from(ADMIN_ENV_PASSWORD);
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
  }
  if (!db.adminHash || !db.adminSalt) return false;
  const got = hashPassword(pw, db.adminSalt);
  const a = Buffer.from(got); const b = Buffer.from(db.adminHash);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function randomCode(prefix, groups, len) {
  const g = Math.max(1, Math.min(6, groups || 3));
  const l = Math.max(3, Math.min(8, len || 4));
  const parts = [];
  for (let i = 0; i < g; i++) {
    let s = '';
    const bytes = crypto.randomBytes(l);
    for (let k = 0; k < l; k++) s += ALPHABET[bytes[k] % ALPHABET.length];
    parts.push(s);
  }
  const body = parts.join('-');
  return prefix ? `${prefix}-${body}` : body;
}

function normalizeCode(s) {
  return String(s || '').trim().toUpperCase().replace(/\s+/g, '');
}

function keyStatus(k) {
  if (!k) return 'missing';
  if (k.disabled) return 'disabled';
  if (!k.activatedAt) return 'unused';
  if (k.type === 'count') return (k.usesLeft > 0) ? 'active' : 'used_up';
  if (k.type === 'forever') return 'active';
  return (now() < k.expiresAt) ? 'active' : 'expired';
}

const STATUS_LABEL = {
  unused: '未激活', active: '生效中', expired: '已过期',
  used_up: '已用完', disabled: '已停用', missing: '不存在',
};

function pushLog(type, detail) {
  db.logs.unshift({ t: now(), type, detail });
  if (db.logs.length > 500) db.logs.length = 500;
}

function cleanSessions() {
  const t = now();
  const before = db.sessions.length;
  db.sessions = db.sessions.filter((s) => s.exp > t);
  return before - db.sessions.length;
}

function parseCookies(req) {
  const out = {};
  const raw = req.headers.cookie || '';
  raw.split(';').forEach((p) => {
    const i = p.indexOf('=');
    if (i < 0) return;
    const k = p.slice(0, i).trim();
    const v = p.slice(i + 1).trim();
    if (k) out[k] = decodeURIComponent(v);
  });
  return out;
}

function clientIp(req) {
  const f = req.headers['x-forwarded-for'];
  if (f) return String(f).split(',')[0].trim();
  return req.socket.remoteAddress || '';
}

function readBody(req, limit = 512 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new Error('too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); } catch (_) { resolve({ __raw: raw }); }
    });
    req.on('error', reject);
  });
}

function json(res, status, obj, extraHeaders) {
  const body = JSON.stringify(obj);
  res.writeHead(status, Object.assign({
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(body),
  }, extraHeaders || {}));
  res.end(body);
}

function html(res, status, body) {
  res.writeHead(status, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function setCookie(name, value, maxAgeSec, req) {
  const secure = (req.headers['x-forwarded-proto'] || '').includes('https') || !!process.env.FORCE_SECURE_COOKIE;
  return `${name}=${encodeURIComponent(value)}; Path=/; Max-Age=${Math.floor(maxAgeSec)}; HttpOnly; SameSite=Lax${secure ? '; Secure' : ''}`;
}

/* ---------------------------------------------------------------- 限速 */

const rate = new Map();
function rateLimit(key, max, windowMs) {
  const t = now();
  const rec = rate.get(key) || { count: 0, reset: t + windowMs };
  if (t > rec.reset) { rec.count = 0; rec.reset = t + windowMs; }
  rec.count += 1;
  rate.set(key, rec);
  if (rate.size > 5000) rate.clear();
  return rec.count <= max;
}

/* ---------------------------------------------------------------- 会话 */

function createSession(code, role, ms, req) {
  cleanSessions();
  const token = crypto.randomBytes(24).toString('hex');
  db.sessions.push({
    token, code: code || null, role,
    createdAt: now(), exp: now() + ms,
    ip: clientIp(req).slice(0, 60),
    ua: String(req.headers['user-agent'] || '').slice(0, 160),
  });
  return token;
}

function findSession(token) {
  if (!token) return null;
  const s = db.sessions.find((x) => x.token === token);
  if (!s) return null;
  if (s.exp <= now()) return null;
  return s;
}

function dropSession(token) {
  db.sessions = db.sessions.filter((s) => s.token !== token);
}

/* ---------------------------------------------------------------- 门禁判定 */

function gateState(req) {
  const cookies = parseCookies(req);
  if (db.publicMode) return { ok: true, via: 'public' };
  const s = findSession(cookies.zs_token);
  if (!s || s.role !== SESSION_ROLE_USER) return { ok: false, via: null };
  const k = db.keys.find((x) => x.code === s.code);
  const st = keyStatus(k);
  if (st === 'active') {
    // 时长卡到期则吊销会话
    return { ok: true, via: 'key', code: s.code, status: st };
  }
  if (st === 'expired' || st === 'used_up' || st === 'disabled') {
    dropSession(s.token);
    saveDB();
    return { ok: false, via: null, reason: STATUS_LABEL[st] };
  }
  return { ok: false, via: null };
}

/* ---------------------------------------------------------------- 卡密操作 */

function activateKey(k) {
  k.activatedAt = now();
  k.firstIp = k.firstIp || null;
  if (k.type === 'count') k.usesLeft = k.value;
  else if (k.type === 'forever') k.expiresAt = null;
  else k.expiresAt = k.activatedAt + k.value * TYPES[k.type].ms;
}

function consumeKey(code, req) {
  const k = db.keys.find((x) => x.code === normalizeCode(code));
  if (!k) return { ok: false, message: '卡密不存在，检查一下有没有输错' };
  if (k.disabled) return { ok: false, message: '这张卡已经停用了' };

  if (!k.activatedAt) {
    activateKey(k);
    k.firstIp = clientIp(req).slice(0, 60);
    k.firstUA = String(req.headers['user-agent'] || '').slice(0, 160);
    pushLog('activate', `${k.code} 首次激活（${TYPES[k.type].label}）`);
  }

  const st = keyStatus(k);
  if (st === 'expired') return { ok: false, message: '这张卡已经过期了' };
  if (st === 'used_up') return { ok: false, message: '这张卡的次数已经用完了' };

  k.lastUsedAt = now();
  k.usedCount = (k.usedCount || 0) + 1;

  let sessionMs = USER_SESSION_MS_FOREVER;
  if (k.type === 'count') {
    k.usesLeft = Math.max(0, (k.usesLeft || 0) - 1);
    sessionMs = USER_SESSION_MS_COUNT;
  } else if (k.type !== 'forever') {
    sessionMs = Math.max(60e3, k.expiresAt - now());
  }
  pushLog('login', `${k.code} 验证通过（${TYPES[k.type].label}）`);
  return { ok: true, key: k, sessionMs };
}

function keyView(k) {
  const st = keyStatus(k);
  return {
    code: k.code,
    type: k.type,
    typeLabel: TYPES[k.type] ? TYPES[k.type].label : k.type,
    value: k.value,
    unit: TYPES[k.type] ? TYPES[k.type].unit : '',
    status: st,
    statusLabel: STATUS_LABEL[st] || st,
    note: k.note || '',
    createdAt: k.createdAt,
    activatedAt: k.activatedAt || null,
    expiresAt: k.expiresAt || null,
    usesLeft: k.type === 'count' ? (k.usesLeft || 0) : null,
    usedCount: k.usedCount || 0,
    lastUsedAt: k.lastUsedAt || null,
    disabled: !!k.disabled,
  };
}

/* ---------------------------------------------------------------- 页面缓存 */

let INDEX_HTML = '';
let GATE_HTML = '';
let ADMIN_HTML = '';

const TUNING_SCRIPT = `<script>(function(){try{var a=document.createElement('a');a.href='/admin';a.setAttribute('aria-label','管理');a.textContent='\\u2699';a.style.cssText='position:fixed;right:14px;bottom:14px;width:36px;height:36px;display:flex;align-items:center;justify-content:center;border-radius:50%;background:rgba(28,18,10,.55);color:#f0c992;font-size:18px;line-height:1;text-decoration:none;z-index:2147483000;opacity:.4;transition:opacity .2s,transform .2s;backdrop-filter:blur(6px);border:1px solid rgba(240,201,146,.25)';a.onmouseenter=function(){a.style.opacity='1';a.style.transform='scale(1.06)'};a.onmouseleave=function(){a.style.opacity='.4';a.style.transform='none'};document.body.appendChild(a);}catch(e){}})();</script>`;

function loadTemplates() {
  INDEX_HTML = fs.readFileSync(INDEX_FILE, 'utf8');
  const i = INDEX_HTML.lastIndexOf('</body>');
  INDEX_HTML = i > 0 ? INDEX_HTML.slice(0, i) + TUNING_SCRIPT + INDEX_HTML.slice(i) : INDEX_HTML + TUNING_SCRIPT;
  GATE_HTML = fs.readFileSync(GATE_FILE, 'utf8');
  ADMIN_HTML = fs.readFileSync(ADMIN_FILE, 'utf8');
  console.log('[site] templates loaded, index bytes =', Buffer.byteLength(INDEX_HTML));
}

/* ---------------------------------------------------------------- 路由 */

async function handleApi(req, res, url) {
  const p = url.pathname;
  const cookies = parseCookies(req);
  const ip = clientIp(req);

  /* ---- 门禁：状态 ---- */
  if (p === '/api/gate/status' && req.method === 'GET') {
    const st = gateState(req);
    return json(res, 200, {
      publicMode: !!db.publicMode,
      authorized: st.ok,
      title: SITE_TITLE,
    });
  }

  /* ---- 门禁：提交卡密 ---- */
  if (p === '/api/gate/verify' && req.method === 'POST') {
    if (!rateLimit('v:' + ip, 12, 10 * 60e3)) {
      return json(res, 429, { ok: false, message: '试太多次了，过几分钟再来' });
    }
    const body = await readBody(req);
    const code = normalizeCode(body.code);
    if (!code) return json(res, 400, { ok: false, message: '先填卡密' });
    const r = consumeKey(code, req);
    if (!r.ok) {
      await saveDB();
      return json(res, 200, { ok: false, message: r.message });
    }
    const token = createSession(r.key.code, SESSION_ROLE_USER, r.sessionMs, req);
    await saveDB();
    return json(res, 200, {
      ok: true,
      message: '验证通过',
      typeLabel: TYPES[r.key.type].label,
      expiresAt: r.key.type === 'count' ? null : (r.key.expiresAt || null),
      usesLeft: r.key.type === 'count' ? r.key.usesLeft : null,
    }, { 'Set-Cookie': setCookie('zs_token', token, r.sessionMs / 1000, req) });
  }

  /* ---- 门禁：退出 ---- */
  if (p === '/api/gate/logout' && req.method === 'POST') {
    dropSession(cookies.zs_token);
    await saveDB();
    return json(res, 200, { ok: true }, { 'Set-Cookie': setCookie('zs_token', '', 1, req) });
  }

  /* ---- 管理：登录 ---- */
  if (p === '/api/admin/login' && req.method === 'POST') {
    if (!rateLimit('a:' + ip, 8, 10 * 60e3)) {
      return json(res, 429, { ok: false, message: '试太多次了，过十分钟再来' });
    }
    const body = await readBody(req);
    if (!verifyAdminPassword(body.password || '')) {
      pushLog('admin_fail', `密码错误（${ip}）`);
      await saveDB();
      return json(res, 401, { ok: false, message: '口令不对' });
    }
    const token = createSession('__admin__', SESSION_ROLE_ADMIN, ADMIN_SESSION_MS, req);
    pushLog('admin_login', `管理员登录（${ip}）`);
    await saveDB();
    return json(res, 200, { ok: true }, { 'Set-Cookie': setCookie('zs_admin', token, ADMIN_SESSION_MS / 1000, req) });
  }

  /* ---- 以下需要管理员 ---- */
  const needAdmin = p.startsWith('/api/admin/');
  let adminSession = null;
  if (needAdmin) {
    adminSession = findSession(cookies.zs_admin);
    if (!adminSession || adminSession.role !== SESSION_ROLE_ADMIN) {
      return json(res, 401, { ok: false, message: '请先登录管理口令' });
    }
  }

  if (p === '/api/admin/logout' && req.method === 'POST') {
    dropSession(cookies.zs_admin);
    await saveDB();
    return json(res, 200, { ok: true }, { 'Set-Cookie': setCookie('zs_admin', '', 1, req) });
  }

  if (p === '/api/admin/state' && req.method === 'GET') {
    const stats = { total: db.keys.length, unused: 0, active: 0, expired: 0, used_up: 0, disabled: 0 };
    db.keys.forEach((k) => {
      const st = keyStatus(k);
      if (stats[st] !== undefined) stats[st] += 1;
    });
    // 本次会话到期时间（前端展示）
    return json(res, 200, {
      ok: true,
      publicMode: !!db.publicMode,
      stats,
      online: db.sessions.filter((s) => s.role === SESSION_ROLE_USER && s.exp > now()).length,
      passwordFromEnv: !!ADMIN_ENV_PASSWORD,
      storage: storageState.mode,
      storageDetail: {
        remoteLoaded: storageState.remoteLoaded,
        remoteHealthy: storageState.remoteHealthy,
        error: storageState.lastError ? 'cloud-unreachable' : '',
      },
      types: Object.keys(TYPES).map((k) => ({ key: k, label: TYPES[k].label, unit: TYPES[k].unit, def: TYPES[k].def })),
    });
  }

  /* 公益模式 */
  if (p === '/api/admin/public' && req.method === 'POST') {
    const body = await readBody(req);
    db.publicMode = !!body.enabled;
    db.publicModeAt = now();
    pushLog('public', db.publicMode ? '开启公益模式' : '关闭公益模式');
    await saveDB();
    return json(res, 200, { ok: true, publicMode: db.publicMode });
  }

  /* 卡密列表 */
  if (p === '/api/admin/keys' && req.method === 'GET') {
    let list = db.keys.slice();
    const q = normalizeCode(url.searchParams.get('q') || '');
    const status = url.searchParams.get('status') || '';
    const type = url.searchParams.get('type') || '';
    if (q) list = list.filter((k) => k.code.includes(q) || (k.note || '').toUpperCase().includes(q));
    if (status) list = list.filter((k) => keyStatus(k) === status);
    if (type) list = list.filter((k) => k.type === type);
    list.sort((a, b) => b.createdAt - a.createdAt);
    const total = list.length;
    const limit = Math.min(500, parseInt(url.searchParams.get('limit') || '200', 10));
    return json(res, 200, { ok: true, total, keys: list.slice(0, limit).map(keyView) });
  }

  /* 生成卡密 */
  if (p === '/api/admin/keys/generate' && req.method === 'POST') {
    const body = await readBody(req);
    const type = String(body.type || '');
    if (!TYPES[type]) return json(res, 400, { ok: false, message: '卡类型不对' });
    const count = Math.max(1, Math.min(200, parseInt(body.count || 1, 10)));
    let value = parseInt(body.value, 10);
    if (isNaN(value)) value = TYPES[type].def;
    if (type === 'count') value = Math.max(1, Math.min(100000, value));
    if (['hour', 'day', 'week', 'month'].includes(type)) value = Math.max(1, Math.min(1000, value));
    if (type === 'forever') value = 0;
    const prefix = String(body.prefix || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8);
    const note = String(body.note || '').slice(0, 60);
    const groups = Math.max(1, Math.min(6, parseInt(body.groups || 3, 10)));
    const len = Math.max(3, Math.min(8, parseInt(body.len || 4, 10)));

    const made = [];
    let guard = 0;
    while (made.length < count && guard < count * 40) {
      guard++;
      const code = randomCode(prefix, groups, len);
      if (db.keys.some((k) => k.code === code)) continue;
      const k = {
        code, type, value, note,
        createdAt: now(),
        activatedAt: null, expiresAt: null,
        usesLeft: type === 'count' ? value : null,
        usedCount: 0, disabled: false,
      };
      db.keys.push(k);
      made.push(code);
    }
    pushLog('generate', `生成 ${made.length} 张${TYPES[type].label}${prefix ? '，前缀 ' + prefix : ''}`);
    await saveDB();
    return json(res, 200, { ok: true, codes: made, typeLabel: TYPES[type].label });
  }

  /* 启用 / 停用 / 删除 / 延期 */
  const m = p.match(/^\/api\/admin\/keys\/([^/]+)(?:\/(toggle|delete|extend))?$/);
  if (m) {
    const code = normalizeCode(decodeURIComponent(m[1]));
    const action = m[2] || '';
    const k = db.keys.find((x) => x.code === code);
    if (!k) return json(res, 404, { ok: false, message: '没有这张卡' });

    if (action === 'toggle' && req.method === 'POST') {
      k.disabled = !k.disabled;
      pushLog('toggle', `${code} ${k.disabled ? '停用' : '恢复'}`);
      await saveDB();
      return json(res, 200, { ok: true, key: keyView(k) });
    }
    if (action === 'delete' && req.method === 'POST') {
      db.keys = db.keys.filter((x) => x.code !== code);
      db.sessions = db.sessions.filter((s) => s.code !== code);
      pushLog('delete', `${code} 已删除`);
      await saveDB();
      return json(res, 200, { ok: true });
    }
    if (action === 'extend' && req.method === 'POST') {
      const body = await readBody(req);
      const amount = Math.max(1, Math.min(100000, parseInt(body.amount || 1, 10)));
      if (k.type === 'count') {
        if (!k.activatedAt) { activateKey(k); k.usesLeft = (k.usesLeft || 0) + amount; }
        else { k.usesLeft = (k.usesLeft || 0) + amount; }
      } else if (k.type === 'forever') {
        return json(res, 400, { ok: false, message: '永久卡不用延期' });
      } else {
        const base = Math.max(now(), k.expiresAt || now());
        k.expiresAt = base + amount * TYPES[k.type].ms;
        if (!k.activatedAt) k.activatedAt = now();
      }
      pushLog('extend', `${code} 延期 ${amount}`);
      await saveDB();
      return json(res, 200, { ok: true, key: keyView(k) });
    }
    return json(res, 400, { ok: false, message: '不支持的操作' });
  }

  /* 修改管理口令 */
  if (p === '/api/admin/password' && req.method === 'POST') {
    const body = await readBody(req);
    if (ADMIN_ENV_PASSWORD) {
      return json(res, 400, { ok: false, message: '口令由环境变量 ADMIN_PASSWORD 决定，请在部署面板里改' });
    }
    if (!verifyAdminPassword(body.old || '')) return json(res, 400, { ok: false, message: '原口令不对' });
    const np = String(body.next || '');
    if (np.length < 6) return json(res, 400, { ok: false, message: '新口令至少 6 位' });
    db.adminSalt = makeSalt();
    db.adminHash = hashPassword(np, db.adminSalt);
    pushLog('admin_password', '管理口令已修改');
    await saveDB();
    return json(res, 200, { ok: true });
  }

  /* 清空会话 / 全部卡密 */
  if (p === '/api/admin/sessions/clear' && req.method === 'POST') {
    db.sessions = db.sessions.filter((s) => s.role === SESSION_ROLE_ADMIN);
    pushLog('sessions_clear', '清空所有用户会话');
    await saveDB();
    return json(res, 200, { ok: true });
  }

  /* 导出 / 导入 */
  if (p === '/api/admin/export' && req.method === 'GET') {
    return json(res, 200, { ok: true, db });
  }

  if (p === '/api/admin/import' && req.method === 'POST') {
    const body = await readBody(req);
    const data = body && body.db ? body.db : body;
    if (!data || !Array.isArray(data.keys)) return json(res, 400, { ok: false, message: '文件内容不对' });
    db.keys = data.keys;
    db.publicMode = !!data.publicMode;
    db.publicModeAt = now();
    if (Array.isArray(data.sessions)) db.sessions = data.sessions;
    if (data.adminHash && data.adminSalt && !ADMIN_ENV_PASSWORD) {
      db.adminHash = data.adminHash; db.adminSalt = data.adminSalt;
    }
    pushLog('import', `导入数据：${db.keys.length} 张卡`);
    await saveDB();
    return json(res, 200, { ok: true, keys: db.keys.length });
  }

  return json(res, 404, { ok: false, message: '接口不存在' });
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://' + (req.headers.host || 'localhost'));
    const p = url.pathname;

    if (p.startsWith('/api/')) return await handleApi(req, res, url);

    if (req.method !== 'GET' && req.method !== 'HEAD') {
      return html(res, 405, 'Method Not Allowed');
    }

    // 管理后台
    if (p === '/admin' || p === '/admin/' || p === '/admin.html') {
      return html(res, 200, ADMIN_HTML);
    }

    // 首页：门禁
    if (p === '/' || p === '/index.html') {
      const st = gateState(req);
      if (st.ok) {
        res.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'no-store',
          'Content-Length': Buffer.byteLength(INDEX_HTML),
        });
        return res.end(req.method === 'HEAD' ? undefined : INDEX_HTML);
      }
      return html(res, 200, GATE_HTML);
    }

    if (p === '/healthz') return json(res, 200, { ok: true, t: now(), storage: storageState.mode, remote: storageState.mode === 'redis' ? (storageState.remoteHealthy ? 'ok' : 'down') : 'n/a' });

    if (p === '/favicon.ico') { res.writeHead(204); return res.end(); }

    return html(res, 404, '<h1>404</h1>');
  } catch (e) {
    console.error('[req]', e && e.stack || e);
    try { json(res, 500, { ok: false, message: '服务器开小差了' }); } catch (_) {}
  }
});

(async function boot() {
  await loadDB();
  loadTemplates();

  // 没设置环境变量口令、数据里也没有 → 生成一个随机口令并落盘
  if (!ADMIN_ENV_PASSWORD && !db.adminHash) {
    const pw = crypto.randomBytes(6).toString('base64').replace(/[^A-Za-z0-9]/g, '').slice(0, 10);
    db.adminSalt = makeSalt();
    db.adminHash = hashPassword(pw, db.adminSalt);
    ensureDir();
    try { fs.writeFileSync(path.join(DATA_DIR, 'admin-password.txt'), pw + '\n', 'utf8'); } catch (_) {}
    console.log('==============================================');
    console.log('  首次启动，已生成管理口令：' + pw);
    console.log('  已保存到 data/admin-password.txt');
    console.log('  建议在部署面板设置环境变量 ADMIN_PASSWORD 自定义');
    console.log('==============================================');
    await saveDB();
  } else if (!db.publicMode && !db.createdAt) {
    db.createdAt = now();
  }

  server.listen(PORT, () => {
    console.log(`[gate] listening on :${PORT}  storage=${(UPSTASH_URL && UPSTASH_TOKEN) ? 'redis' : 'file'}`);
  });
})();
