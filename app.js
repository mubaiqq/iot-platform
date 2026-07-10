const express = require('express');
const path = require('path');
const fs = require('fs');
const os = require('os');
const mysql = require('mysql2/promise');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const cookieParser = require('cookie-parser');
const svgCaptcha = require('svg-captcha');
const { initGlobalMqtt, publishToDevice, waitForDeviceAck } = require('./mqtt_handler');

const app = express();
const PORT = parseInt(process.env.PORT || '3000', 10);
app.set('trust proxy', 1);

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

// ========== Database install/config ==========
const DB_CONFIG_PATH = process.env.DB_CONFIG_PATH || path.join(__dirname, 'data', 'db-config.json');
const SCHEMA_PATH = path.join(__dirname, 'docker/mysql/init/001-schema.sql');
let pool = null;
let dbReady = false;

function getEnvDbConfig() {
  if (!process.env.DB_HOST) return null;
  return {
    host: process.env.DB_HOST,
    port: parseInt(process.env.DB_PORT || '3306', 10),
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'iot_platform'
  };
}

function readSavedDbConfig() {
  try {
    if (!fs.existsSync(DB_CONFIG_PATH)) return null;
    return JSON.parse(fs.readFileSync(DB_CONFIG_PATH, 'utf8'));
  } catch (e) {
    console.error('[安装] 读取数据库配置失败:', e.message);
    return null;
  }
}

function getDbConfig() {
  return getEnvDbConfig() || readSavedDbConfig();
}

function createDbPool(cfg) {
  return mysql.createPool({
    host: cfg.host,
    port: parseInt(cfg.port || '3306', 10),
    user: cfg.user || 'root',
    password: cfg.password || undefined,
    database: cfg.database || 'iot_platform',
    waitForConnections: true,
    connectionLimit: 10
  });
}

async function initDatabasePool() {
  const cfg = getDbConfig();
  if (!cfg) {
    dbReady = false;
    return false;
  }
  const nextPool = createDbPool(cfg);
  await nextPool.query('SELECT 1');
  if (pool) { try { await pool.end(); } catch (e) {} }
  pool = nextPool;
  dbReady = true;
  return true;
}

function splitSqlStatements(sql) {
  return sql
    .replace(/--.*$/gm, '')
    .split(';')
    .map(s => s.trim())
    .filter(Boolean);
}

async function installDatabase(cfg) {
  const database = cfg.database || 'iot_platform';
  const server = await mysql.createConnection({
    host: cfg.host,
    port: parseInt(cfg.port || '3306', 10),
    user: cfg.user || 'root',
    password: cfg.password || undefined,
    multipleStatements: false
  });
  try {
    await server.query('CREATE DATABASE IF NOT EXISTS `'+database.replace(/`/g, '``')+'` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci');
  } catch (e) {
    console.warn('[安装] 自动创建数据库失败，将尝试使用已存在数据库:', e.message);
  } finally {
    await server.end();
  }

  const installPool = createDbPool({ ...cfg, database });
  try {
    const sql = fs.readFileSync(SCHEMA_PATH, 'utf8');
    for (const stmt of splitSqlStatements(sql)) {
      await installPool.query(stmt);
    }
  } finally {
    await installPool.end();
  }

  fs.mkdirSync(path.dirname(DB_CONFIG_PATH), { recursive: true });
  fs.writeFileSync(DB_CONFIG_PATH, JSON.stringify({
    host: cfg.host,
    port: parseInt(cfg.port || '3306', 10),
    user: cfg.user || 'root',
    password: cfg.password || '',
    database
  }, null, 2));

  await initDatabasePool();
  return true;
}

function requireInstalled(req, res, next) {
  if (dbReady || req.path === '/install' || req.path === '/api/install' || req.path === '/api/install/status') return next();
  if (req.path.startsWith('/api/')) return res.status(503).json({ success: false, need_install: true, error: '请先完成数据库安装' });
  return res.redirect('/install');
}

app.use(requireInstalled);
app.use(express.static(path.join(__dirname, 'public')));

// ========== Security Helpers ==========
function generateToken() {
  return crypto.randomBytes(48).toString('hex');
}

function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function createSessionCookieOptions(req) {
  const secure = !!(req?.secure || req?.headers?.['x-forwarded-proto'] === 'https');
  return {
    httpOnly: true,
    secure,
    sameSite: secure ? 'none' : 'lax',
    expires: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000)
  };
}

function createSessionCookie() {
  const token = generateToken();
  const hashedToken = hashToken(token);
  return { token, hashedToken };
}

// Auth middleware
async function requireAuth(req, res, next) {
  const token = req.cookies?.session_token;
  if (!token) return res.status(401).json({ error: '未登录' });
  
  const hashedToken = hashToken(token);
  try {
    const [rows] = await pool.query(
      'SELECT u.id, u.username, u.email, u.role, u.vip_expire, u.status FROM login_tokens t JOIN users u ON t.user_id = u.id WHERE t.token_hash = ? AND u.status = "active"',
      [hashedToken]
    );
    if (rows.length === 0) return res.status(401).json({ error: '登录已过期' });
    req.user = rows[0];
    next();
  } catch (e) {
    res.status(500).json({ error: '服务器错误' });
  }
}

function requireAdmin(req, res, next) {
  if (req.user?.role !== 'admin') return res.status(403).json({ error: '无权限' });
  next();
}


// ========== Install API/Page ==========
app.get('/install', (req, res) => res.sendFile(path.join(__dirname, 'public', 'install.html')));

app.get('/api/install/status', (req, res) => {
  res.json({ installed: !!dbReady });
});

app.post('/api/install', async (req, res) => {
  try {
    if (dbReady) return res.json({ success: true, message: '已安装' });
    const { host, port, user, password, database } = req.body;
    if (!host || !user || !database) {
      return res.status(400).json({ success: false, error: '请填写数据库地址、用户名和数据库名' });
    }
    await installDatabase({ host: String(host).trim(), port: port || 3306, user: String(user).trim(), password: password || '', database: String(database).trim() });
    try { initGlobalMqtt(pool); } catch (e) { console.error('[MQTT] 安装后初始化失败:', e.message); }
    res.json({ success: true, message: '安装完成' });
  } catch (e) {
    console.error('[安装] 失败:', e);
    res.status(500).json({ success: false, error: e.message || '安装失败' });
  }
});

// ========== Captcha API ==========
app.get('/api/captcha', (req, res) => {
  const captcha = svgCaptcha.create({
    size: 4,
    ignoreChars: '0o1ilI',
    noise: 3,
    color: true,
    background: '#f5f6fa',
    width: 120,
    height: 40
  });
  res.cookie('captcha_text', captcha.text, {
    httpOnly: true,
    maxAge: 5 * 60 * 1000,
    sameSite: 'strict'
  });
  res.type('svg');
  res.send(captcha.data);
});

// ========== Settings API ==========
app.get('/api/settings/:key', async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT setting_value FROM settings WHERE setting_key = ?', [req.params.key]);
    res.json({ value: rows[0]?.setting_value || null });
  } catch (e) {
    res.status(500).json({ error: '服务器错误' });
  }
});

app.get('/api/settings', requireAuth, requireAdmin, async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT * FROM settings');
    const settings = {};
    rows.forEach(r => settings[r.setting_key] = r.setting_value);
    res.json(settings);
  } catch (e) {
    res.status(500).json({ error: '服务器错误' });
  }
});

app.post('/api/settings', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { key, value } = req.body;
    await pool.query(
      'INSERT INTO settings (setting_key, setting_value) VALUES (?, ?) ON DUPLICATE KEY UPDATE setting_value = ?',
      [key, value, value]
    );
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: '服务器错误' });
  }
});

// ========== Auth API ==========
app.post('/api/register', async (req, res) => {
  try {
    const { username, email, password, captcha } = req.body;
    
    // Check if registration is open
    const [openRow] = await pool.query('SELECT setting_value FROM settings WHERE setting_key = "register_open"');
    if (openRow[0]?.setting_value !== '1') {
      return res.status(403).json({ error: '注册已关闭' });
    }
    
    // Check captcha
    const [captchaRow] = await pool.query('SELECT setting_value FROM settings WHERE setting_key = "register_captcha"');
    if (captchaRow[0]?.setting_value === '1') {
      const expected = req.cookies?.captcha_text;
      if (!captcha || !expected || captcha.toLowerCase() !== expected.toLowerCase()) {
        return res.status(400).json({ error: '验证码错误' });
      }
    }
    
    // Validate
    if (!username || username.length < 3 || username.length > 20) {
      return res.status(400).json({ error: '用户名长度3-20位' });
    }
    if (!email || !email.includes('@')) {
      return res.status(400).json({ error: '邮箱格式错误' });
    }
    if (!password || password.length < 6) {
      return res.status(400).json({ error: '密码至少6位' });
    }
    
    // Check duplicate
    const [exists] = await pool.query('SELECT id FROM users WHERE username = ? OR email = ?', [username, email]);
    if (exists.length > 0) {
      return res.status(400).json({ error: '用户名或邮箱已存在' });
    }
    
    // Hash password
    const hashedPassword = await bcrypt.hash(password, 10);
    
    // VIP days
    const [vipRow] = await pool.query('SELECT setting_value FROM settings WHERE setting_key = "register_vip_days"');
    const vipDays = parseInt(vipRow[0]?.setting_value) || 0;
    const vipExpire = vipDays > 0 ? new Date(Date.now() + vipDays * 24 * 60 * 60 * 1000) : null;
    
    // Insert user
    const [result] = await pool.query(
      'INSERT INTO users (username, email, password, vip_expire, role) VALUES (?, ?, ?, ?, "user")',
      [username, email, hashedPassword, vipExpire]
    );
    
    // Auto login
    const { token, hashedToken } = createSessionCookie();
    await pool.query('INSERT INTO login_tokens (user_id, token_hash) VALUES (?, ?)', [result.insertId, hashedToken]);
    await pool.query('UPDATE users SET last_login = NOW() WHERE id = ?', [result.insertId]);
    
    res.cookie('session_token', token, createSessionCookieOptions(req));
    
    res.json({ success: true, message: '注册成功' });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: '服务器错误' });
  }
});

app.post('/api/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    
    if (!username || !password) {
      return res.status(400).json({ error: '请输入用户名和密码' });
    }
    
    const [rows] = await pool.query(
      'SELECT * FROM users WHERE username = ? OR email = ?',
      [username, username]
    );
    
    if (rows.length === 0) {
      return res.status(401).json({ error: '用户名或密码错误' });
    }
    
    const user = rows[0];
    
    if (user.status === 'banned') {
      return res.status(403).json({ error: '账号已被封禁' });
    }
    
    const valid = await bcrypt.compare(password, user.password);
    if (!valid) {
      return res.status(401).json({ error: '用户名或密码错误' });
    }
    
    // Generate token
    const { token, hashedToken } = createSessionCookie();
    // 检查多设备登录设置
    const [mlSetting] = await pool.query('SELECT setting_value FROM user_settings WHERE user_id = ? AND setting_key = "multi_login"', [user.id]);
    if (mlSetting.length === 0 || mlSetting[0].setting_value === '0') {
      await pool.query('DELETE FROM login_tokens WHERE user_id = ?', [user.id]);
    }
    await pool.query('INSERT INTO login_tokens (user_id, token_hash) VALUES (?, ?)', [user.id, hashedToken]);
    await pool.query('UPDATE users SET last_login = NOW() WHERE id = ?', [user.id]);
    
    res.cookie('session_token', token, createSessionCookieOptions(req));
    
    res.json({ 
      success: true, 
      user: { id: user.id, username: user.username, role: user.role, vip_expire: user.vip_expire }
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: '服务器错误' });
  }
});

app.post('/api/logout', async (req, res) => {
  const token = req.cookies?.session_token;
  if (token) {
    try {
      await pool.query('DELETE FROM login_tokens WHERE token_hash = ?', [hashToken(token)]);
    } catch(e) {}
  }
  res.clearCookie('session_token');
  res.json({ success: true });
});

app.get('/api/me', requireAuth, async (req, res) => {
  try {
    const [userRows] = await pool.query(
      'SELECT id, username, email, role, status, vip_expire, created_at, last_login FROM users WHERE id = ?',
      [req.user.id]
    );
    if (!userRows.length) return res.status(404).json({ error: '用户不存在' });
    const u = userRows[0];

    // Device stats
    const [deviceStats] = await pool.query(
      'SELECT COUNT(*) as total, SUM(CASE WHEN last_heartbeat > DATE_SUB(NOW(), INTERVAL 35 SECOND) THEN 1 ELSE 0 END) as online, SUM(CASE WHEN device_type="controller" THEN 1 ELSE 0 END) as controllers, SUM(CASE WHEN device_type="sensor" THEN 1 ELSE 0 END) as sensors FROM devices WHERE user_id = ?',
      [req.user.id]
    );
    const stats = deviceStats[0] || { total: 0, online: 0, controllers: 0, sensors: 0 };

    // Login count (from login_tokens)
    const [tokenCount] = await pool.query(
      'SELECT COUNT(*) as cnt FROM login_tokens WHERE user_id = ?',
      [req.user.id]
    );

    // VIP info
    const now = new Date();
    const isVip = u.vip_expire && new Date(u.vip_expire) > now;
    const vipDays = isVip ? Math.ceil((new Date(u.vip_expire) - now) / 86400000) : 0;

    res.json({
      success: true,
      user: {
        id: u.id,
        username: u.username,
        email: u.email,
        role: u.role,
        status: u.status,
        created_at: u.created_at,
        last_login: u.last_login,
        is_vip: isVip,
        vip_expire: u.vip_expire,
        vip_days_remaining: vipDays,
        device_total: parseInt(stats.total) || 0,
        device_online: parseInt(stats.online) || 0,
        device_controllers: parseInt(stats.controllers) || 0,
        device_sensors: parseInt(stats.sensors) || 0,
        active_sessions: tokenCount[0]?.cnt || 0
      }
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: '获取失败' });
  }
});

// ========== User Management API (Admin) ==========
const ROOT_ADMIN_ID = 1;
const impersonationTickets = new Map();
const IMPERSONATION_TTL_MS = 5 * 60 * 1000;
function isRootAdmin(user) {
  return Number(user?.id) === ROOT_ADMIN_ID;
}
function canImpersonateUser(adminUser, targetUser) {
  if (!adminUser || !targetUser) return false;
  if (isRootAdmin(adminUser)) return true;
  return targetUser.role === 'user' && Number(targetUser.id) !== ROOT_ADMIN_ID;
}

app.get('/api/users', requireAuth, requireAdmin, async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(50, Math.max(5, parseInt(req.query.limit) || 20));
    const search = (req.query.search || '').trim();
    const offset = (page - 1) * limit;
    
    let where = '1=1';
    let params = [];
    if (search) {
      where = '(u.username LIKE ? OR u.email LIKE ?)';
      params = [`%${search}%`, `%${search}%`];
    }
    
    const [countRows] = await pool.query(`SELECT COUNT(*) as total FROM users u WHERE ${where}`, params);
    const total = countRows[0].total;
    
    const [rows] = await pool.query(
      `SELECT u.id, u.username, u.email, u.role, u.status, u.vip_expire, u.created_at, u.last_login,
              COALESCE(d.device_count, 0) AS device_count,
              COALESCE(t.active_sessions, 0) AS active_sessions
       FROM users u
       LEFT JOIN (SELECT user_id, COUNT(*) AS device_count FROM devices GROUP BY user_id) d ON d.user_id = u.id
       LEFT JOIN (SELECT user_id, COUNT(*) AS active_sessions FROM login_tokens GROUP BY user_id) t ON t.user_id = u.id
       WHERE ${where}
       ORDER BY u.id DESC
       LIMIT ? OFFSET ?`,
      [...params, limit, offset]
    );
    
    res.json({ users: rows, total, page, limit, currentUser: { id: req.user.id, role: req.user.role, is_root_admin: isRootAdmin(req.user) } });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: '服务器错误' });
  }
});

app.put('/api/users/:id', requireAuth, requireAdmin, async (req, res) => {
  try {
    const targetId = Number(req.params.id);
    const { role, status, vip_expire } = req.body;
    const root = isRootAdmin(req.user);

    const [[target]] = await pool.query('SELECT id, username, role, status FROM users WHERE id = ?', [targetId]);
    if (!target) return res.status(404).json({ success: false, error: '用户不存在' });

    if (role !== undefined && !['user', 'admin'].includes(role)) {
      return res.status(400).json({ success: false, error: '角色参数无效' });
    }
    if (status !== undefined && !['active', 'banned'].includes(status)) {
      return res.status(400).json({ success: false, error: '状态参数无效' });
    }

    // Root admin is the platform owner. Promoted admins can manage normal users, but cannot edit admins/root.
    if (targetId === ROOT_ADMIN_ID && !root) {
      return res.status(403).json({ success: false, error: '无权操作创始管理员' });
    }
    if (target.role === 'admin' && !root) {
      return res.status(403).json({ success: false, error: '普通管理员不能修改其他管理员' });
    }
    if (role === 'admin' && !root) {
      return res.status(403).json({ success: false, error: '只有创始管理员可以授予管理员权限' });
    }
    if (targetId === req.user.id && (status === 'banned' || (role && role !== req.user.role))) {
      return res.status(400).json({ success: false, error: '不能封禁或降级当前登录账号' });
    }
    if (targetId === ROOT_ADMIN_ID && (status === 'banned' || role === 'user')) {
      return res.status(400).json({ success: false, error: '创始管理员不能被封禁或降级' });
    }

    const updates = [];
    const params = [];
    if (role !== undefined) { updates.push('role = ?'); params.push(role); }
    if (status !== undefined) { updates.push('status = ?'); params.push(status); }
    if (vip_expire !== undefined) { updates.push('vip_expire = ?'); params.push(vip_expire || null); }
    
    if (updates.length === 0) return res.status(400).json({ success: false, error: '无更新内容' });
    
    params.push(targetId);
    await pool.query(`UPDATE users SET ${updates.join(', ')} WHERE id = ?`, params);

    if (status === 'banned') {
      await pool.query('DELETE FROM login_tokens WHERE user_id = ?', [targetId]);
    }
    res.json({ success: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ success: false, error: '服务器错误' });
  }
});

app.delete('/api/users/:id', requireAuth, requireAdmin, async (req, res) => {
  const conn = await pool.getConnection();
  try {
    const targetId = Number(req.params.id);
    const root = isRootAdmin(req.user);
    const [[target]] = await conn.query('SELECT id, username, role FROM users WHERE id = ?', [targetId]);
    if (!target) return res.status(404).json({ success: false, error: '用户不存在' });
    if (targetId === req.user.id) return res.status(400).json({ success: false, error: '不能删除当前登录账号' });
    if (targetId === ROOT_ADMIN_ID) return res.status(403).json({ success: false, error: '创始管理员不能删除' });
    if (target.role === 'admin' && !root) return res.status(403).json({ success: false, error: '普通管理员不能删除其他管理员' });

    await conn.beginTransaction();
    const [devices] = await conn.query('SELECT id FROM devices WHERE user_id = ?', [targetId]);
    const deviceIds = devices.map(d => d.id);
    if (deviceIds.length) {
      await conn.query('DELETE FROM device_logs WHERE device_id IN (?)', [deviceIds]);
      await conn.query('DELETE FROM device_commands WHERE device_id IN (?)', [deviceIds]);
    }
    await conn.query('DELETE FROM devices WHERE user_id = ?', [targetId]);
    await conn.query('DELETE FROM login_tokens WHERE user_id = ?', [targetId]);
    await conn.query('DELETE FROM user_settings WHERE user_id = ?', [targetId]);
    await conn.query('DELETE FROM llm_configs WHERE user_id = ?', [targetId]);
    await conn.query('DELETE FROM users WHERE id = ?', [targetId]);
    await conn.commit();
    res.json({ success: true });
  } catch (e) {
    try { await conn.rollback(); } catch (_) {}
    console.error(e);
    res.status(500).json({ success: false, error: '服务器错误' });
  } finally {
    conn.release();
  }
});

app.post('/api/admin/impersonate/:id', requireAuth, requireAdmin, async (req, res) => {
  try {
    const targetId = Number(req.params.id);
    if (targetId === Number(req.user.id)) return res.status(400).json({ success: false, error: '不能代登录当前账号' });
    const [[target]] = await pool.query('SELECT id, username, email, role, status FROM users WHERE id = ?', [targetId]);
    if (!target) return res.status(404).json({ success: false, error: '用户不存在' });
    if (target.status !== 'active') return res.status(403).json({ success: false, error: '该用户已被封禁，不能登录' });
    if (!canImpersonateUser(req.user, target)) {
      return res.status(403).json({ success: false, error: '普通管理员只能登录普通用户账号' });
    }

    const ticket = generateToken();
    impersonationTickets.set(ticket, {
      admin_id: req.user.id,
      admin_role: req.user.role,
      admin_is_root: isRootAdmin(req.user),
      target_id: target.id,
      target_role: target.role,
      created_at: Date.now(),
      expires_at: Date.now() + IMPERSONATION_TTL_MS,
      used: false
    });
    setTimeout(() => impersonationTickets.delete(ticket), IMPERSONATION_TTL_MS);
    const url = `/admin/impersonate-login?ticket=${encodeURIComponent(ticket)}`;
    res.json({ success: true, url, full_url: `${req.protocol}://${req.get('host')}${url}`, expires_in: Math.floor(IMPERSONATION_TTL_MS / 1000) });
  } catch (e) {
    console.error('[Impersonate Error]', e);
    res.status(500).json({ success: false, error: '创建登录授权失败' });
  }
});

app.get('/admin/impersonate-login', async (req, res) => {
  try {
    const ticket = typeof req.query.ticket === 'string' ? req.query.ticket : '';
    if (!ticket || ticket.length < 32) return res.status(403).send('登录授权无效');
    const item = impersonationTickets.get(ticket);
    // 一次性链接：无论成功失败，读取后立即删除，防重放。
    impersonationTickets.delete(ticket);
    if (!item || item.used || Date.now() > item.expires_at) {
      return res.status(403).send('登录授权已过期或已使用，请回到管理员后台重新生成');
    }
    item.used = true;

    const [[adminUser]] = await pool.query('SELECT id, role, status FROM users WHERE id = ?', [item.admin_id]);
    if (!adminUser || adminUser.status !== 'active' || adminUser.role !== 'admin') return res.status(403).send('授权管理员状态无效');
    const [[target]] = await pool.query('SELECT id, username, role, status FROM users WHERE id = ?', [item.target_id]);
    if (!target) return res.status(404).send('用户不存在');
    if (target.status !== 'active') return res.status(403).send('该用户已被封禁，不能登录');
    if (!canImpersonateUser(adminUser, target)) return res.status(403).send('无权登录该用户');
    if (Number(adminUser.id) === Number(target.id)) return res.status(403).send('不能代登录当前账号');

    const { token, hashedToken } = createSessionCookie();
    await pool.query('INSERT INTO login_tokens (user_id, token_hash) VALUES (?, ?)', [target.id, hashedToken]);
    await pool.query('UPDATE users SET last_login = NOW() WHERE id = ?', [target.id]);
    res.cookie('session_token', token, createSessionCookieOptions(req));
    res.redirect('/user');
  } catch (e) {
    console.error('[Impersonate Login Error]', e);
    res.status(500).send('代登录失败');
  }
});

// Admin dashboard summary
app.get('/api/admin/dashboard', requireAuth, requireAdmin, async (req, res) => {
  try {
    const [[deviceStats]] = await pool.query(`
      SELECT
        COUNT(*) AS total,
        SUM(CASE WHEN last_heartbeat > DATE_SUB(NOW(), INTERVAL 35 SECOND) THEN 1 ELSE 0 END) AS online,
        SUM(CASE WHEN device_type = 'controller' THEN 1 ELSE 0 END) AS controllers,
        SUM(CASE WHEN device_type = 'sensor' THEN 1 ELSE 0 END) AS sensors,
        SUM(CASE WHEN created_at >= CURDATE() THEN 1 ELSE 0 END) AS new_today
      FROM devices
    `);
    const [[userStats]] = await pool.query(`
      SELECT
        COUNT(*) AS total,
        SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END) AS active,
        SUM(CASE WHEN role = 'admin' THEN 1 ELSE 0 END) AS admins,
        SUM(CASE WHEN vip_expire IS NOT NULL AND vip_expire > NOW() THEN 1 ELSE 0 END) AS vip,
        SUM(CASE WHEN created_at >= CURDATE() THEN 1 ELSE 0 END) AS new_today
      FROM users
    `);
    const [[logStats]] = await pool.query(`
      SELECT
        COUNT(*) AS total,
        SUM(CASE WHEN created_at >= CURDATE() THEN 1 ELSE 0 END) AS today,
        SUM(CASE WHEN log_type = 'watering' THEN 1 ELSE 0 END) AS watering,
        SUM(CASE WHEN log_type = 'watering_judge' THEN 1 ELSE 0 END) AS ai_judge
      FROM device_logs
    `);
    const [[pendingStats]] = await pool.query('SELECT COUNT(*) AS total FROM esp32_pending_devices');
    const [[mysqlVersion]] = await pool.query('SELECT VERSION() AS version');
    const [mqttRows] = await pool.query('SELECT setting_key, setting_value FROM settings WHERE setting_key LIKE "mqtt_%"');
    const mqttConfig = {};
    mqttRows.forEach(r => { mqttConfig[r.setting_key] = r.setting_value; });

    const totalDevices = Number(deviceStats.total) || 0;
    const onlineDevices = Number(deviceStats.online) || 0;
    const offlineDevices = Math.max(totalDevices - onlineDevices, 0);

    res.json({
      success: true,
      stats: {
        devices: {
          total: totalDevices,
          online: onlineDevices,
          offline: offlineDevices,
          controllers: Number(deviceStats.controllers) || 0,
          sensors: Number(deviceStats.sensors) || 0,
          new_today: Number(deviceStats.new_today) || 0,
          online_rate: totalDevices ? Math.round(onlineDevices / totalDevices * 100) : 0
        },
        users: {
          total: Number(userStats.total) || 0,
          active: Number(userStats.active) || 0,
          admins: Number(userStats.admins) || 0,
          vip: Number(userStats.vip) || 0,
          new_today: Number(userStats.new_today) || 0
        },
        logs: {
          total: Number(logStats.total) || 0,
          today: Number(logStats.today) || 0,
          watering: Number(logStats.watering) || 0,
          ai_judge: Number(logStats.ai_judge) || 0
        },
        pending_devices: Number(pendingStats.total) || 0
      },
      system: {
        node_version: process.version,
        mysql_version: mysqlVersion.version,
        platform: `${os.type()} ${os.release()}`,
        uptime_seconds: Math.floor(process.uptime()),
        memory: {
          rss: process.memoryUsage().rss,
          heap_used: process.memoryUsage().heapUsed,
          heap_total: process.memoryUsage().heapTotal
        }
      },
      services: {
        app: '正常',
        database: '正常',
        mqtt: mqttConfig.mqtt_broker ? '已配置' : '未配置',
        mqtt_broker: mqttConfig.mqtt_broker || ''
      },
      now: new Date().toISOString()
    });
  } catch (e) {
    console.error('[Admin Dashboard Error]', e);
    res.status(500).json({ success: false, error: '获取仪表盘数据失败' });
  }
});

// ========== Account API (Self-management) ==========
app.put('/api/account/username', requireAuth, async (req, res) => {
  try {
    const { username } = req.body;
    const userId = req.user.id;
    
    if (!username || username.length < 3 || username.length > 20) {
      return res.status(400).json({ error: '用户名长度3-20位' });
    }
    if (!/^[a-zA-Z0-9_]+$/.test(username)) {
      return res.status(400).json({ error: '用户名只能包含字母、数字、下划线' });
    }
    
    // Check duplicate
    const [exists] = await pool.query('SELECT id FROM users WHERE username = ? AND id != ?', [username, userId]);
    if (exists.length > 0) {
      return res.status(400).json({ error: '用户名已存在' });
    }
    
    await pool.query('UPDATE users SET username = ? WHERE id = ?', [username, userId]);
    
    // Clear session to force re-login
    res.clearCookie('session_token');
    res.json({ success: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: '服务器错误' });
  }
});

app.put('/api/account/password', requireAuth, async (req, res) => {
  try {
    const { oldPassword, newPassword } = req.body;
    const userId = req.user.id;
    
    if (!oldPassword || !newPassword) {
      return res.status(400).json({ error: '请填写完整信息' });
    }
    if (newPassword.length < 6) {
      return res.status(400).json({ error: '新密码至少6位' });
    }
    
    // Get current password
    const [rows] = await pool.query('SELECT password FROM users WHERE id = ?', [userId]);
    if (rows.length === 0) {
      return res.status(404).json({ error: '用户不存在' });
    }
    
    // Verify old password
    const valid = await bcrypt.compare(oldPassword, rows[0].password);
    if (!valid) {
      return res.status(401).json({ error: '当前密码错误' });
    }
    
    // Hash new password and update
    const hashedPassword = await bcrypt.hash(newPassword, 10);
    await pool.query('UPDATE users SET password = ? WHERE id = ?', [hashedPassword, userId]);
    
    // Clear session to force re-login
    res.clearCookie('session_token');
    res.json({ success: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: '服务器错误' });
  }
});

// Multi-device login setting
app.get('/api/account/multi-login', requireAuth, async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT setting_value FROM user_settings WHERE user_id = ? AND setting_key = "multi_login"', [req.user.id]);
    const enabled = rows.length > 0 ? rows[0].setting_value === '1' : false;
    res.json({ success: true, enabled });
  } catch (e) {
    res.status(500).json({ error: '获取失败' });
  }
});

app.put('/api/account/multi-login', requireAuth, async (req, res) => {
  try {
    const { enabled } = req.body;
    const val = enabled ? '1' : '0';
    await pool.query(
      'INSERT INTO user_settings (user_id, setting_key, setting_value) VALUES (?, "multi_login", ?) ON DUPLICATE KEY UPDATE setting_value = ?',
      [req.user.id, val, val]
    );
    // If disabling, clear other sessions (keep current)
    if (!enabled) {
      const token = req.cookies?.session_token;
      if (token) {
        const hashed = hashToken(token);
        await pool.query('DELETE FROM login_tokens WHERE user_id = ? AND token_hash != ?', [req.user.id, hashed]);
      }
    }
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: '设置失败' });
  }
});

// ========== LLM Config API ==========
// Admin: get all global configs (user_id IS NULL)
app.get('/api/admin/llm-configs', requireAuth, requireAdmin, async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT * FROM llm_configs WHERE user_id IS NULL ORDER BY is_default DESC, id ASC');
    res.json({ configs: rows });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: '服务器错误' });
  }
});

// User: get user's custom configs
app.get('/api/user/llm-configs', requireAuth, async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT * FROM llm_configs WHERE user_id = ? ORDER BY is_default DESC, id ASC', [req.user.id]);
    res.json({ configs: rows });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: '服务器错误' });
  }
});

// Admin: add global config
app.post('/api/admin/llm-configs', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { name, api_url, api_key, model_id } = req.body;
    if (!name || !api_url || !api_key || !model_id) return res.status(400).json({ error: '所有字段必填' });
    // If first one, make it default
    const [existing] = await pool.query('SELECT COUNT(*) as cnt FROM llm_configs WHERE user_id IS NULL');
    const isDefault = existing[0].cnt === 0 ? 1 : 0;
    const [result] = await pool.query(
      'INSERT INTO llm_configs (user_id, name, api_url, api_key, model_id, is_default) VALUES (NULL, ?, ?, ?, ?, ?)',
      [name, api_url, api_key, model_id, isDefault]
    );
    res.json({ id: result.insertId, is_default: isDefault });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: '服务器错误' });
  }
});

// User: add custom config
app.post('/api/user/llm-configs', requireAuth, async (req, res) => {
  try {
    const { name, api_url, api_key, model_id } = req.body;
    if (!name || !api_url || !api_key || !model_id) return res.status(400).json({ error: '所有字段必填' });
    const [existing] = await pool.query('SELECT COUNT(*) as cnt FROM llm_configs WHERE user_id = ?', [req.user.id]);
    const isDefault = existing[0].cnt === 0 ? 1 : 0;
    const [result] = await pool.query(
      'INSERT INTO llm_configs (user_id, name, api_url, api_key, model_id, is_default) VALUES (?, ?, ?, ?, ?, ?)',
      [req.user.id, name, api_url, api_key, model_id, isDefault]
    );
    res.json({ id: result.insertId, is_default: isDefault });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: '服务器错误' });
  }
});

// Admin: update global config
app.put('/api/admin/llm-configs/:id', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { name, api_url, api_key, model_id } = req.body;
    await pool.query('UPDATE llm_configs SET name=?, api_url=?, api_key=?, model_id=? WHERE id=? AND user_id IS NULL',
      [name, api_url, api_key, model_id, req.params.id]);
    res.json({ success: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: '服务器错误' });
  }
});

// User: update custom config
app.put('/api/user/llm-configs/:id', requireAuth, async (req, res) => {
  try {
    const { name, api_url, api_key, model_id } = req.body;
    await pool.query('UPDATE llm_configs SET name=?, api_url=?, api_key=?, model_id=? WHERE id=? AND user_id=?',
      [name, api_url, api_key, model_id, req.params.id, req.user.id]);
    res.json({ success: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: '服务器错误' });
  }
});

// Admin: set default
app.put('/api/admin/llm-configs/:id/default', requireAuth, requireAdmin, async (req, res) => {
  try {
    await pool.query('UPDATE llm_configs SET is_default=0 WHERE user_id IS NULL');
    await pool.query('UPDATE llm_configs SET is_default=1 WHERE id=? AND user_id IS NULL', [req.params.id]);
    res.json({ success: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: '服务器错误' });
  }
});

// User: set default
app.put('/api/user/llm-configs/:id/default', requireAuth, async (req, res) => {
  try {
    await pool.query('UPDATE llm_configs SET is_default=0 WHERE user_id=?', [req.user.id]);
    await pool.query('UPDATE llm_configs SET is_default=1 WHERE id=? AND user_id=?', [req.params.id, req.user.id]);
    res.json({ success: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: '服务器错误' });
  }
});

// Admin: delete global config
app.delete('/api/admin/llm-configs/:id', requireAuth, requireAdmin, async (req, res) => {
  try {
    const [row] = await pool.query('SELECT is_default FROM llm_configs WHERE id=? AND user_id IS NULL', [req.params.id]);
    if (!row.length) return res.status(404).json({ error: '未找到' });
    await pool.query('DELETE FROM llm_configs WHERE id=? AND user_id IS NULL', [req.params.id]);
    // If deleted was default, set new default
    if (row[0].is_default) {
      const [first] = await pool.query('SELECT id FROM llm_configs WHERE user_id IS NULL ORDER BY id ASC LIMIT 1');
      if (first.length) await pool.query('UPDATE llm_configs SET is_default=1 WHERE id=?', [first[0].id]);
    }
    res.json({ success: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: '服务器错误' });
  }
});

// User: delete custom config
app.delete('/api/user/llm-configs/:id', requireAuth, async (req, res) => {
  try {
    const [row] = await pool.query('SELECT is_default FROM llm_configs WHERE id=? AND user_id=?', [req.params.id, req.user.id]);
    if (!row.length) return res.status(404).json({ error: '未找到' });
    await pool.query('DELETE FROM llm_configs WHERE id=? AND user_id=?', [req.params.id, req.user.id]);
    if (row[0].is_default) {
      const [first] = await pool.query('SELECT id FROM llm_configs WHERE user_id=? ORDER BY id ASC LIMIT 1', [req.user.id]);
      if (first.length) await pool.query('UPDATE llm_configs SET is_default=1 WHERE id=?', [first[0].id]);
    }
    res.json({ success: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: '服务器错误' });
  }
});

// Shared: test LLM config (accepts body, no DB lookup needed)
app.post('/api/llm-test', requireAuth, async (req, res) => {
  try {
    const { api_url, api_key, model_id } = req.body;
    if (!api_url || !api_key || !model_id) return res.status(400).json({ error: '缺少参数' });
    // 自动拼接：如果用户填的地址已包含 /chat/completions 则不重复追加
    let baseUrl = api_url.replace(/\/+$/, '');
    if (!baseUrl.endsWith('/chat/completions')) baseUrl += '/chat/completions';
    const resp = await fetch(baseUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${api_key}` },
      body: JSON.stringify({ model: model_id, messages: [{ role: 'user', content: '你好' }], max_tokens: 200 }),
      signal: AbortSignal.timeout(30000)
    });
    const data = await resp.json();
    console.log('[LLM Test] raw response:', JSON.stringify(data).slice(0, 500));
    if (data.error) return res.json({ success: false, error: data.error.message || JSON.stringify(data.error) });
    // 兼容多种返回格式
    let reply = null;
    if (data.choices && data.choices.length > 0) {
      const c = data.choices[0];
      reply = c.message?.content || c.text || c.content || null;
    }
    // 兼容部分 API 直接返回 content / result 字段
    if (!reply && data.content) reply = data.content;
    if (!reply && data.result) reply = data.result;
    if (!reply) reply = '[模型返回为空，原始数据: ' + JSON.stringify(data).slice(0, 200) + ']';
    res.json({ success: true, reply });
  } catch (e) {
    res.json({ success: false, error: e.message });
  }
});

// Shared: fetch model list from OpenAI-compatible API
app.post('/api/llm-models', requireAuth, async (req, res) => {
  try {
    const { api_url, api_key } = req.body;
    if (!api_url || !api_key) return res.status(400).json({ error: '缺少参数' });
    const url = api_url.replace(/\/+$/, '') + '/models';
    const resp = await fetch(url, {
      headers: { 'Authorization': `Bearer ${api_key}` },
      signal: AbortSignal.timeout(15000)
    });
    const data = await resp.json();
    if (data.error) return res.json({ success: false, error: data.error.message || JSON.stringify(data.error) });
    const models = (data.data || []).map(m => m.id).sort();
    res.json({ success: true, models });
  } catch (e) {
    res.json({ success: false, error: e.message });
  }
});

// ========== User Settings API ==========
app.get('/api/user/settings/:key', requireAuth, async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT setting_value FROM user_settings WHERE user_id = ? AND setting_key = ?', [req.user.id, req.params.key]);
    res.json({ value: rows[0]?.setting_value || null });
  } catch (e) {
    res.status(500).json({ error: '服务器错误' });
  }
});

app.post('/api/user/settings', requireAuth, async (req, res) => {
  try {
    const entries = Object.entries(req.body);
    for (const [key, value] of entries) {
      await pool.query(
        'INSERT INTO user_settings (user_id, setting_key, setting_value) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE setting_value = ?',
        [req.user.id, key, value || null, value || null]
      );
    }
    res.json({ success: true });
  } catch (e) {
    console.error('[User Settings Error]', e.message, e.code);
    res.status(500).json({ error: e.message });
  }
});

// ========== QWeather API ==========
// Search city by name
app.get('/api/weather/search', requireAuth, async (req, res) => {
  try {
    const location = req.query.location?.trim();
    if (!location) return res.status(400).json({ error: '请输入城市名称' });
    // Admin uses global key, user uses own key
    let apiKey;
    if (req.user.role === 'admin') {
      const [rows] = await pool.query('SELECT setting_value FROM settings WHERE setting_key = "qweather_api_key"');
      apiKey = rows[0]?.setting_value;
    } else {
      const [rows] = await pool.query('SELECT setting_value FROM user_settings WHERE user_id = ? AND setting_key = "qweather_api_key"', [req.user.id]);
      apiKey = rows[0]?.setting_value;
    }
    if (!apiKey) return res.status(400).json({ error: '未配置和风天气 API Key，请先在设置中添加' });

    const url = `https://geoapi.qweather.com/v2/city/lookup?location=${encodeURIComponent(location)}&key=${apiKey}&number=10&lang=zh`;
    const resp = await fetch(url, { signal: AbortSignal.timeout(10000) });
    const data = await resp.json();
    if (data.code !== '200') return res.json({ success: false, error: data.message || '搜索失败' });

    const locations = (data.location || []).map(loc => ({
      id: loc.id, name: loc.name,
      adm1: loc.adm1 || '', adm2: loc.adm2 || '', country: loc.country || '',
      fullName: `${loc.country || ''} ${loc.adm1 || ''} ${loc.adm2 || ''} ${loc.name || ''}`.trim()
    }));
    res.json({ success: true, locations });
  } catch (e) {
    res.json({ success: false, error: e.message });
  }
});

// Get current weather + 3-day forecast
app.get('/api/weather/now', requireAuth, async (req, res) => {
  try {
    const locationId = req.query.location?.trim();
    if (!locationId) return res.status(400).json({ error: '缺少 location 参数' });
    let apiKey;
    if (req.user.role === 'admin') {
      const [rows] = await pool.query('SELECT setting_value FROM settings WHERE setting_key = "qweather_api_key"');
      apiKey = rows[0]?.setting_value;
    } else {
      const [rows] = await pool.query('SELECT setting_value FROM user_settings WHERE user_id = ? AND setting_key = "qweather_api_key"', [req.user.id]);
      apiKey = rows[0]?.setting_value;
    }
    if (!apiKey) return res.status(400).json({ error: '未配置和风天气 API Key，请先在设置中添加' });

    // Fetch current weather and 3-day forecast in parallel
    const [nowResp, forecastResp] = await Promise.all([
      fetch(`https://api.qweather.com/v7/weather/now?location=${locationId}&key=${apiKey}&lang=zh&unit=m`, { signal: AbortSignal.timeout(10000) }),
      fetch(`https://api.qweather.com/v7/weather/3d?location=${locationId}&key=${apiKey}&lang=zh&unit=m`, { signal: AbortSignal.timeout(10000) })
    ]);
    const nowData = await nowResp.json();
    const forecastData = await forecastResp.json();

    if (nowData.code !== '200') return res.json({ success: false, error: nowData.message || '获取天气失败' });

    const now = nowData.now || {};
    const daily = (forecastData.code === '200') ? (forecastData.daily || []) : [];

    res.json({
      success: true,
      updateTime: nowData.updateTime || '',
      fxLink: nowData.fxLink || '',
      now: {
        temp: now.temp, feelsLike: now.feelsLike, text: now.text, icon: now.icon,
        windDir: now.windDir, windScale: now.windScale, windSpeed: now.windSpeed,
        humidity: now.humidity, precip: now.precip, pressure: now.pressure,
        vis: now.vis, cloud: now.cloud
      },
      forecast: daily.map(d => ({
        date: d.fxDate, textDay: d.textDay, textNight: d.textNight,
        tempMax: d.tempMax, tempMin: d.tempMin, iconDay: d.iconDay,
        humidity: d.humidity, precip: d.precip,
        windDirDay: d.windDirDay, windScaleDay: d.windScaleDay,
        sunrise: d.sunrise, sunset: d.sunset, uvIndex: d.uvIndex
      }))
    });
  } catch (e) {
    res.json({ success: false, error: e.message });
  }
});

// Test QWeather API key
app.post('/api/weather/test', requireAuth, async (req, res) => {
  try {
    const { api_key } = req.body;
    if (!api_key) return res.status(400).json({ error: '请提供 API Key' });
    // Test by searching Beijing
    const url = `https://geoapi.qweather.com/v2/city/lookup?location=北京&key=${api_key}&number=1`;
    const resp = await fetch(url, { signal: AbortSignal.timeout(10000) });
    const data = await resp.json();
    if (data.code === '200' && data.location?.length > 0) {
      res.json({ success: true, message: `测试成功，找到: ${data.location[0].name}` });
    } else {
      res.json({ success: false, error: data.message || 'Key 无效' });
    }
  } catch (e) {
    res.json({ success: false, error: e.message });
  }
});

// ========== MQTT Config API ==========
const MQTT_KEYS = ['mqtt_broker','mqtt_port','mqtt_protocol','mqtt_username','mqtt_password','mqtt_client_id','mqtt_keepalive','mqtt_clean_session','mqtt_qos'];

app.get('/api/mqtt/config', requireAuth, requireAdmin, async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT setting_key, setting_value FROM settings WHERE setting_key LIKE "mqtt_%"');
    const config = {};
    rows.forEach(r => { config[r.setting_key] = r.setting_value; });
    res.json({ success: true, config });
  } catch (e) {
    res.status(500).json({ success: false, error: '服务器错误' });
  }
});

app.post('/api/mqtt/config', requireAuth, requireAdmin, async (req, res) => {
  try {
    const entries = Object.entries(req.body).filter(([k]) => MQTT_KEYS.includes(k));
    if (entries.length === 0) return res.status(400).json({ success: false, error: '无有效配置' });
    for (const [key, value] of entries) {
      await pool.query(
        'INSERT INTO settings (setting_key, setting_value) VALUES (?, ?) ON DUPLICATE KEY UPDATE setting_value = ?',
        [key, value ?? '', value ?? '']
      );
    }
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ success: false, error: '保存失败' });
  }
});

app.post('/api/mqtt/test', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { broker, port, protocol, username, password, client_id } = req.body;
    if (!broker) return res.json({ success: false, error: '请填写 Broker 地址' });
    const proto = protocol || 'mqtt';
    const p = port || '1883';
    let url = `${proto}://${broker}:${p}`;
    const opts = { connectTimeout: 8000 };
    if (username) opts.username = username;
    if (password) opts.password = password;
    if (client_id) opts.clientId = client_id + '_' + Math.random().toString(16).slice(2, 8);
    else opts.clientId = 'mubaiyun_test_' + Math.random().toString(16).slice(2, 8);
    opts.clean = true;
    const mqtt = require('mqtt');
    const client = mqtt.connect(url, opts);
    let done = false;
    const timer = setTimeout(() => { if (!done) { done = true; client.end(true); res.json({ success: false, error: '连接超时 (8s)' }); } }, 8500);
    client.on('connect', () => {
      if (done) return; done = true; clearTimeout(timer); client.end();
      res.json({ success: true, message: `连接成功 (${broker}:${p})` });
    });
    client.on('error', (err) => {
      if (done) return; done = true; clearTimeout(timer); client.end(true);
      res.json({ success: false, error: err.message || '连接失败' });
    });
  } catch (e) {
    res.json({ success: false, error: e.message });
  }
});

// ========== MQTT User Test API ==========
// Store active MQTT test sessions
const mqttSessions = new Map();

// Get admin MQTT config for users
app.get('/api/mqtt/user-config', requireAuth, async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT setting_key, setting_value FROM settings WHERE setting_key LIKE "mqtt_%"');
    const config = {};
    rows.forEach(r => { config[r.setting_key] = r.setting_value; });
    if (!config.mqtt_broker) return res.json({ success: false, error: '管理员尚未配置MQTT' });
    res.json({ success: true, config });
  } catch (e) {
    res.status(500).json({ success: false, error: '服务器错误' });
  }
});

// Connect to MQTT broker
app.post('/api/mqtt/connect', requireAuth, async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT setting_key, setting_value FROM settings WHERE setting_key LIKE "mqtt_%"');
    const cfg = {};
    rows.forEach(r => { cfg[r.setting_key] = r.setting_value; });
    if (!cfg.mqtt_broker) return res.json({ success: false, error: '管理员尚未配置MQTT Broker' });

    const proto = cfg.mqtt_protocol || 'mqtt';
    const port = cfg.mqtt_port || '1883';
    const url = `${proto}://${cfg.mqtt_broker}:${port}`;
    const sessionId = 's_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

    const opts = { connectTimeout: 8000 };
    if (cfg.mqtt_username) opts.username = cfg.mqtt_username;
    if (cfg.mqtt_password) opts.password = cfg.mqtt_password;
    opts.clientId = (cfg.mqtt_client_id || 'mubaiyun') + '_' + req.user.id + '_' + Math.random().toString(16).slice(2, 6);
    opts.clean = cfg.mqtt_clean_session !== '0';
    if (cfg.mqtt_keepalive) opts.keepalive = parseInt(cfg.mqtt_keepalive) || 60;

    const mqtt = require('mqtt');
    const client = mqtt.connect(url, opts);

    const sseListeners = [];
    const session = { client, sseListeners, createdAt: Date.now() };
    mqttSessions.set(sessionId, session);

    // Auto-cleanup after 30 min
    session.timer = setTimeout(() => {
      try { client.end(true); } catch(e) {}
      mqttSessions.delete(sessionId);
    }, 30 * 60 * 1000);

    let connected = false;
    const connectTimeout = setTimeout(() => {
      if (!connected) {
        try { client.end(true); } catch(e) {}
        mqttSessions.delete(sessionId);
        res.json({ success: false, error: '连接超时' });
      }
    }, 9000);

    client.on('connect', () => {
      connected = true;
      clearTimeout(connectTimeout);
      res.json({ success: true, sessionId, broker: `${cfg.mqtt_broker}:${port}` });
    });

    client.on('error', (err) => {
      if (!connected) {
        connected = true;
        clearTimeout(connectTimeout);
        mqttSessions.delete(sessionId);
        res.json({ success: false, error: err.message || '连接失败' });
      }
    });

    client.on('message', (topic, message, packet) => {
      const msg = {
        type: 'message',
        topic,
        payload: message.toString(),
        qos: packet.qos,
        retain: packet.retain,
        time: new Date().toISOString()
      };
      sseListeners.forEach(fn => fn(msg));
    });

    client.on('close', () => {
      sseListeners.forEach(fn => fn({ type: 'disconnect' }));
      mqttSessions.delete(sessionId);
    });

  } catch (e) {
    res.json({ success: false, error: e.message });
  }
});

// SSE stream for messages
app.get('/api/mqtt/stream/:sessionId', requireAuth, (req, res) => {
  const session = mqttSessions.get(req.params.sessionId);
  if (!session) return res.status(404).end();

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive'
  });
  res.write('data: {"type":"connected"}\n\n');

  const send = (data) => {
    try { res.write(`data: ${JSON.stringify(data)}\n\n`); } catch(e) {}
  };
  session.sseListeners.push(send);

  // Heartbeat every 15s
  const hb = setInterval(() => {
    try { res.write(': heartbeat\n\n'); } catch(e) {}
  }, 15000);

  req.on('close', () => {
    clearInterval(hb);
    const idx = session.sseListeners.indexOf(send);
    if (idx >= 0) session.sseListeners.splice(idx, 1);
  });
});

// Subscribe to topic
app.post('/api/mqtt/subscribe', requireAuth, (req, res) => {
  const { sessionId, topic, qos } = req.body;
  const session = mqttSessions.get(sessionId);
  if (!session) return res.json({ success: false, error: '会话已过期，请重新连接' });
  const q = parseInt(qos) || 0;
  session.client.subscribe(topic, { qos: q }, (err) => {
    if (err) return res.json({ success: false, error: err.message });
    res.json({ success: true, topic, qos: q });
  });
});

// Unsubscribe from topic
app.post('/api/mqtt/unsubscribe', requireAuth, (req, res) => {
  const { sessionId, topic } = req.body;
  const session = mqttSessions.get(sessionId);
  if (!session) return res.json({ success: false, error: '会话已过期' });
  session.client.unsubscribe(topic, (err) => {
    if (err) return res.json({ success: false, error: err.message });
    res.json({ success: true });
  });
});

// Publish message
app.post('/api/mqtt/publish', requireAuth, (req, res) => {
  const { sessionId, topic, payload, qos, retain } = req.body;
  const session = mqttSessions.get(sessionId);
  if (!session) return res.json({ success: false, error: '会话已过期，请重新连接' });
  const q = parseInt(qos) || 0;
  session.client.publish(topic, payload || '', { qos: q, retain: !!retain }, (err) => {
    if (err) return res.json({ success: false, error: err.message });
    res.json({ success: true });
  });
});

// Disconnect
app.post('/api/mqtt/disconnect', requireAuth, (req, res) => {
  const { sessionId } = req.body;
  const session = mqttSessions.get(sessionId);
  if (!session) return res.json({ success: true });
  clearTimeout(session.timer);
  try { session.client.end(false); } catch(e) {}
  mqttSessions.delete(sessionId);
  res.json({ success: true });
});

// ========== Device API ==========
// Device type mapping by code prefix
function getDeviceType(code) {
  const prefix = code.charAt(0).toUpperCase();
  if (prefix === 'K') return { type: 'controller', model: 'K系列控制器' };
  if (prefix === 'C') return { type: 'sensor', model: 'C系列传感器' };
  return null;
}

function getDeviceIcon(type, model) {
  if (type === 'controller') return 'fa-faucet-drip';
  return 'fa-microchip';
}

// Add device
app.post('/api/devices', requireAuth, async (req, res) => {
  try {
    const { device_code, device_name } = req.body;
    if (!device_code || !device_code.trim()) return res.json({ success: false, error: '请输入设备码' });
    const code = device_code.trim();
    const info = getDeviceType(code);
    if (!info) return res.json({ success: false, error: '设备码格式错误，K开头为控制器，C开头为传感器' });
    const name = (device_name && device_name.trim()) || info.model + ' ' + code.slice(-4);
    const [existing] = await pool.query('SELECT id FROM devices WHERE device_code = ?', [code]);
    if (existing.length > 0) return res.json({ success: false, error: '该设备码已被注册' });
    await pool.query(
      'INSERT INTO devices (user_id, device_code, device_name, device_type, device_model, settings) VALUES (?, ?, ?, ?, ?, ?)',
      [req.user.id, code, name, info.type, info.model, JSON.stringify({})]
    );
    res.json({ success: true, message: '设备添加成功' });
  } catch (e) {
    res.status(500).json({ success: false, error: '添加失败' });
  }
});

// ========== Admin Device Management API ==========
app.get('/api/admin/devices', requireAuth, requireAdmin, async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(50, Math.max(5, parseInt(req.query.limit) || 20));
    const search = (req.query.search || '').trim();
    const type = (req.query.type || '').trim();
    const status = (req.query.status || '').trim();
    const offset = (page - 1) * limit;
    const now = Date.now();

    const whereParts = ['1=1'];
    const params = [];
    if (search) {
      whereParts.push('(d.device_code LIKE ? OR d.device_name LIKE ? OR u.username LIKE ? OR u.email LIKE ?)');
      params.push(`%${search}%`, `%${search}%`, `%${search}%`, `%${search}%`);
    }
    if (['controller', 'sensor'].includes(type)) {
      whereParts.push('d.device_type = ?');
      params.push(type);
    }
    if (status === 'online') {
      whereParts.push('d.last_heartbeat > DATE_SUB(NOW(), INTERVAL 35 SECOND)');
    } else if (status === 'offline') {
      whereParts.push('(d.last_heartbeat IS NULL OR d.last_heartbeat <= DATE_SUB(NOW(), INTERVAL 35 SECOND))');
    }
    const where = whereParts.join(' AND ');

    const [countRows] = await pool.query(
      `SELECT COUNT(*) AS total FROM devices d JOIN users u ON u.id = d.user_id WHERE ${where}`,
      params
    );
    const total = Number(countRows[0]?.total) || 0;

    const [rows] = await pool.query(
      `SELECT d.id, d.user_id, d.device_code, d.device_name, d.device_type, d.device_model,
              d.status, d.last_seen, d.last_heartbeat, d.sensor_data, d.settings, d.created_at,
              u.username, u.email,
              COALESCE(l.log_count, 0) AS log_count
       FROM devices d
       JOIN users u ON u.id = d.user_id
       LEFT JOIN (SELECT device_id, COUNT(*) AS log_count FROM device_logs GROUP BY device_id) l ON l.device_id = d.id
       WHERE ${where}
       ORDER BY d.created_at DESC
       LIMIT ? OFFSET ?`,
      [...params, limit, offset]
    );

    const devices = rows.map(r => {
      let sensorData = null;
      let settings = {};
      try { sensorData = typeof r.sensor_data === 'string' ? JSON.parse(r.sensor_data) : (r.sensor_data || null); } catch (_) { sensorData = null; }
      try { settings = typeof r.settings === 'string' ? JSON.parse(r.settings) : (r.settings || {}); } catch (_) { settings = {}; }
      const hbTime = r.last_heartbeat ? new Date(r.last_heartbeat).getTime() : 0;
      const isOnline = hbTime && (now - hbTime) < 35000;
      return {
        ...r,
        settings,
        sensor_data: sensorData,
        status: isOnline ? 'online' : 'offline',
        seconds_since_heartbeat: hbTime ? Math.max(0, Math.round((now - hbTime) / 1000)) : null,
        icon: getDeviceIcon(r.device_type, r.device_model)
      };
    });

    const [[stats]] = await pool.query(`
      SELECT
        COUNT(*) AS total,
        SUM(CASE WHEN last_heartbeat > DATE_SUB(NOW(), INTERVAL 35 SECOND) THEN 1 ELSE 0 END) AS online,
        SUM(CASE WHEN device_type = 'controller' THEN 1 ELSE 0 END) AS controllers,
        SUM(CASE WHEN device_type = 'sensor' THEN 1 ELSE 0 END) AS sensors,
        SUM(CASE WHEN created_at >= CURDATE() THEN 1 ELSE 0 END) AS new_today
      FROM devices
    `);

    res.json({
      success: true,
      devices,
      total,
      page,
      limit,
      stats: {
        total: Number(stats.total) || 0,
        online: Number(stats.online) || 0,
        offline: Math.max((Number(stats.total) || 0) - (Number(stats.online) || 0), 0),
        controllers: Number(stats.controllers) || 0,
        sensors: Number(stats.sensors) || 0,
        new_today: Number(stats.new_today) || 0
      }
    });
  } catch (e) {
    console.error('[Admin Devices Error]', e);
    res.status(500).json({ success: false, error: '获取设备列表失败' });
  }
});

app.put('/api/admin/devices/:id', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { device_name } = req.body;
    if (device_name === undefined || !String(device_name).trim()) {
      return res.status(400).json({ success: false, error: '设备名称不能为空' });
    }
    const [result] = await pool.query('UPDATE devices SET device_name = ? WHERE id = ?', [String(device_name).trim(), req.params.id]);
    if (result.affectedRows === 0) return res.status(404).json({ success: false, error: '设备不存在' });
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ success: false, error: '更新失败' });
  }
});

app.delete('/api/admin/devices/:id', requireAuth, requireAdmin, async (req, res) => {
  const conn = await pool.getConnection();
  try {
    const [[device]] = await conn.query('SELECT id, device_code FROM devices WHERE id = ?', [req.params.id]);
    if (!device) return res.status(404).json({ success: false, error: '设备不存在' });
    await conn.beginTransaction();
    await conn.query('DELETE FROM device_logs WHERE device_id = ?', [req.params.id]);
    await conn.query('DELETE FROM device_commands WHERE device_id = ?', [req.params.id]);
    await conn.query('DELETE FROM devices WHERE id = ?', [req.params.id]);
    await conn.commit();
    res.json({ success: true });
  } catch (e) {
    try { await conn.rollback(); } catch (_) {}
    res.status(500).json({ success: false, error: '删除失败' });
  } finally {
    conn.release();
  }
});

// List user's devices
app.get('/api/devices', requireAuth, async (req, res) => {
  try {
    const [rows] = await pool.query(
      'SELECT id, device_code, device_name, device_type, device_model, status, last_seen, last_heartbeat, sensor_data, settings, created_at FROM devices WHERE user_id = ? ORDER BY created_at DESC',
      [req.user.id]
    );
    const now = Date.now();
    const devices = rows.map(r => {
      const settings = typeof r.settings === 'string' ? JSON.parse(r.settings) : (r.settings || {});
      const sensorData = typeof r.sensor_data === 'string' ? JSON.parse(r.sensor_data) : (r.sensor_data || null);
      // Online if heartbeat within 35 seconds
      const hbTime = r.last_heartbeat ? new Date(r.last_heartbeat).getTime() : 0;
      const isOnline = (now - hbTime) < 35000;
      return { ...r, settings, sensor_data: sensorData, status: isOnline ? 'online' : 'offline', icon: getDeviceIcon(r.device_type, r.device_model) };
    });
    res.json({ success: true, devices });
  } catch (e) {
    res.status(500).json({ success: false, error: '获取失败' });
  }
});

// Get single device
app.get('/api/devices/:id', requireAuth, async (req, res) => {
  try {
    const [rows] = await pool.query(
      'SELECT id, device_code, device_name, device_type, device_model, status, last_seen, last_heartbeat, sensor_data, settings, created_at FROM devices WHERE id = ? AND user_id = ?',
      [req.params.id, req.user.id]
    );
    if (rows.length === 0) return res.json({ success: false, error: '设备不存在' });
    const d = rows[0];
    d.settings = typeof d.settings === 'string' ? JSON.parse(d.settings) : (d.settings || {});
    d.sensor_data = typeof d.sensor_data === 'string' ? JSON.parse(d.sensor_data) : (d.sensor_data || null);
    // Online if heartbeat within 35 seconds
    const hbTime = d.last_heartbeat ? new Date(d.last_heartbeat).getTime() : 0;
    d.status = (Date.now() - hbTime) < 35000 ? 'online' : 'offline';
    d.icon = getDeviceIcon(d.device_type, d.device_model);
    res.json({ success: true, device: d });
  } catch (e) {
    res.status(500).json({ success: false, error: '获取失败' });
  }
});

// Update device (name, settings)
app.put('/api/devices/:id', requireAuth, async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT * FROM devices WHERE id = ? AND user_id = ?', [req.params.id, req.user.id]);
    if (rows.length === 0) return res.json({ success: false, error: '设备不存在' });
    const device = rows[0];
    const { device_name, settings } = req.body;
    const isVip = req.user.role === 'admin' || (req.user.vip_expire && new Date(req.user.vip_expire) > new Date());
    if (settings !== undefined && !isVip) {
      if (settings.weather_api === 'official') {
        return res.json({ success: false, error: 'VIP已过期，不能使用官方天气API，请续费VIP或改用自定义API' });
      }
      if (settings.llm_api === 'official') {
        return res.json({ success: false, error: 'VIP已过期，不能使用官方大模型，请续费VIP或改用自定义模型' });
      }
    }
    const updates = [];
    const params = [];
    if (device_name !== undefined) { updates.push('device_name = ?'); params.push(device_name.trim()); }
    if (settings !== undefined) { updates.push('settings = ?'); params.push(JSON.stringify(settings)); }
    if (updates.length === 0) return res.json({ success: false, error: '无更新内容' });
    params.push(req.params.id, req.user.id);
    await pool.query(`UPDATE devices SET ${updates.join(', ')} WHERE id = ? AND user_id = ?`, params);

    // 传感器设置保存后，立即通过 MQTT 下发到设备；设备离线时会在下次心跳后由 mqtt_handler 再补发。
    if (settings !== undefined && device.device_type === 'sensor') {
      const sensorCfg = settings.sensor_config || {};
      publishToDevice(device.device_code, {
        command: 'sensor_config',
        sleep_seconds: Math.max(30, parseInt(sensorCfg.sleep_seconds || settings.sleep_seconds || 30, 10) || 30),
        dry_adc: sensorCfg.dry_adc !== null && sensorCfg.dry_adc !== undefined ? Number(sensorCfg.dry_adc) : undefined,
        wet_adc: sensorCfg.wet_adc !== null && sensorCfg.wet_adc !== undefined ? Number(sensorCfg.wet_adc) : undefined
      });
    }

    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ success: false, error: '更新失败' });
  }
});

// Delete device
app.delete('/api/devices/:id', requireAuth, async (req, res) => {
  try {
    const [result] = await pool.query('DELETE FROM devices WHERE id = ? AND user_id = ?', [req.params.id, req.user.id]);
    if (result.affectedRows === 0) return res.json({ success: false, error: '设备不存在' });
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ success: false, error: '删除失败' });
  }
});

// Device heartbeat (public - no auth, device sends this)
app.post('/api/devices/heartbeat', async (req, res) => {
  try {
    const { device_code, timestamp, sensor_data } = req.body;
    if (!device_code) return res.json({ success: false, error: '缺少设备码' });
    const code = device_code.trim();
    const now = new Date();
    const hbTime = timestamp ? new Date(timestamp) : now;
    const sensorStr = sensor_data ? JSON.stringify(sensor_data) : null;
    const [result] = await pool.query(
      'UPDATE devices SET last_heartbeat = ?, last_seen = ?, sensor_data = IFNULL(?, sensor_data) WHERE device_code = ?',
      [hbTime, hbTime, sensorStr, code]
    );
    if (result.affectedRows === 0) return res.json({ success: false, error: '设备未注册' });
    res.json({ success: true, server_time: now.toISOString() });
  } catch (e) {
    res.status(500).json({ success: false, error: '心跳失败' });
  }
});

// Serve modal pages with POST data injected
function serveModalPage(filePath, postData, res) {
  try {
    let html = fs.readFileSync(path.join(__dirname, filePath), 'utf8');
    html = html.replace('__POST_DATA__', JSON.stringify(postData));
    res.send(html);
  } catch (e) {
    res.status(500).send('页面加载失败');
  }
}

app.post('/user/pages/device_setting', requireAuth, async (req, res) => {
  const { device_id } = req.body;
  const [rows] = await pool.query('SELECT * FROM devices WHERE id = ? AND user_id = ?', [device_id, req.user.id]);
  if (!rows.length) return res.status(404).send('设备不存在');
  const d = rows[0];
  d.settings = typeof d.settings === 'string' ? JSON.parse(d.settings) : (d.settings || {});
  // Get admin weather API config
  const [adminWeather] = await pool.query('SELECT setting_value FROM settings WHERE setting_key = "qweather_api_key"');
  const hasAdminWeather = !!(adminWeather[0]?.setting_value);
  // Get user weather API key
  const [userWeather] = await pool.query('SELECT setting_value FROM user_settings WHERE user_id = ? AND setting_key = "qweather_api_key"', [req.user.id]);
  const hasUserWeather = !!(userWeather[0]?.setting_value);
  // Get user's own LLM configs (not admin's)
  const [llmRows] = await pool.query('SELECT id, name, model_id FROM llm_configs WHERE user_id = ?', [req.user.id]);
  // User VIP status
  const isVip = req.user.vip_expire && new Date(req.user.vip_expire) > new Date();
  serveModalPage('public/user/pages/device_setting.html', {
    device: d,
    hasAdminWeather,
    hasUserWeather,
    llmConfigs: llmRows,
    isVip
  }, res);
});

app.post('/user/pages/sensor_setting', requireAuth, async (req, res) => {
  const { device_id } = req.body;
  const [rows] = await pool.query('SELECT id, device_name, device_code, device_type, settings FROM devices WHERE id = ? AND user_id = ?', [device_id, req.user.id]);
  if (!rows.length) return res.status(404).send('设备不存在');
  const d = rows[0];
  d.settings = typeof d.settings === 'string' ? JSON.parse(d.settings) : (d.settings || {});
  serveModalPage('public/user/pages/sensor_setting.html', { device: d }, res);
});

app.post('/user/pages/device_prompt', requireAuth, async (req, res) => {
  const { device_id } = req.body;
  const [rows] = await pool.query('SELECT id, device_name, device_code, device_type, settings FROM devices WHERE id = ? AND user_id = ?', [device_id, req.user.id]);
  if (!rows.length) return res.status(404).send('设备不存在');
  const d = rows[0];
  d.settings = typeof d.settings === 'string' ? JSON.parse(d.settings) : (d.settings || {});
  // 加载该用户的所有传感器设备
  const [sensors] = await pool.query(
    'SELECT id, device_code, device_name, sensor_data FROM devices WHERE user_id = ? AND device_type = "sensor" ORDER BY created_at',
    [req.user.id]
  );
  sensors.forEach(s => {
    s.sensor_data = typeof s.sensor_data === 'string' ? JSON.parse(s.sensor_data) : (s.sensor_data || {});
  });
  serveModalPage('public/user/pages/device_prompt.html', { device: d, sensors }, res);
});

app.post('/user/pages/device_log', requireAuth, async (req, res) => {
  const { device_id } = req.body;
  const [rows] = await pool.query('SELECT id, device_name FROM devices WHERE id = ? AND user_id = ?', [device_id, req.user.id]);
  if (!rows.length) return res.status(404).send('设备不存在');
  serveModalPage('public/user/pages/device_log.html', { device: rows[0] }, res);
});

// Admin uses the same log page UI as user device detail, but can open logs for any device.
app.post('/admin/pages/device_log', requireAuth, requireAdmin, async (req, res) => {
  const { device_id } = req.body;
  const [rows] = await pool.query('SELECT id, device_name, device_code FROM devices WHERE id = ?', [device_id]);
  if (!rows.length) return res.status(404).send('设备不存在');
  serveModalPage('public/user/pages/device_log.html', { device: rows[0] }, res);
});

// 计划任务页面
app.post('/user/pages/device_schedule', requireAuth, async (req, res) => {
  const { device_id } = req.body;
  const [rows] = await pool.query('SELECT id, device_name, device_code, settings FROM devices WHERE id = ? AND user_id = ?', [device_id, req.user.id]);
  if (!rows.length) return res.status(404).send('设备不存在');
  const d = rows[0];
  d.settings = typeof d.settings === 'string' ? JSON.parse(d.settings) : (d.settings || {});
  serveModalPage('public/user/pages/device_schedule.html', {
    device_id: d.id,
    device_name: d.device_name,
    device_code: d.device_code,
    schedules: d.settings.schedules || []
  }, res);
});

// ========== Device Commands API ==========
// 获取设备待执行指令
app.get('/api/device-commands', requireAuth, async (req, res) => {
  try {
    const { device_id } = req.query;
    const [rows] = await pool.query(
      'SELECT * FROM device_commands WHERE device_id = ? AND status = "pending" ORDER BY created_at DESC',
      [device_id]
    );
    res.json({ commands: rows });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: '服务器错误' });
  }
});

// 标记指令已执行
app.post('/api/device-commands/ack', requireAuth, async (req, res) => {
  try {
    const { command_id } = req.body;
    await pool.query('UPDATE device_commands SET status = "done" WHERE id = ?', [command_id]);
    res.json({ success: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: '服务器错误' });
  }
});

// ========== Watering Judge API ==========

// 获取设备日志
app.get('/api/device-logs', requireAuth, async (req, res) => {
  try {
    const { device_id } = req.query;
    if (!device_id) return res.status(400).json({ success: false, error: '缺少设备ID' });

    let deviceWhere = 'id = ? AND user_id = ?';
    let deviceParams = [device_id, req.user.id];
    if (req.user.role === 'admin') {
      deviceWhere = 'id = ?';
      deviceParams = [device_id];
    }

    const [devices] = await pool.query(`SELECT id, device_name, device_code FROM devices WHERE ${deviceWhere}`, deviceParams);
    if (!devices.length) return res.status(404).json({ success: false, error: '设备不存在或无权限' });

    const [rows] = await pool.query(
      'SELECT * FROM device_logs WHERE device_id = ? ORDER BY created_at DESC LIMIT 50',
      [device_id]
    );
    res.json({ success: true, device: devices[0], logs: rows });
  } catch (e) {
    console.error(e);
    res.status(500).json({ success: false, error: '服务器错误' });
  }
});

// 保存设备日志
app.post('/api/device-logs', requireAuth, async (req, res) => {
  try {
    const { device_id, log_type, content, result, prompt_content, ai_response } = req.body;
    await pool.query(
      'INSERT INTO device_logs (device_id, log_type, content, result, prompt_content, ai_response) VALUES (?, ?, ?, ?, ?, ?)',
      [device_id, log_type, content, result || null, prompt_content || null, ai_response || null]
    );
    res.json({ success: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: '服务器错误' });
  }
});

// 手动浇水API
app.post('/api/manual-watering', requireAuth, async (req, res) => {
  try {
    const { device_id, action, duration } = req.body;
    const userId = req.user.id;
    
    // 获取设备信息
    const [devices] = await pool.query(
      'SELECT id, device_name, device_code FROM devices WHERE id = ? AND user_id = ?',
      [device_id, userId]
    );
    
    if (!devices.length) {
      return res.status(404).json({ error: '设备不存在' });
    }
    
    const device = devices[0];
    
    // 通过MQTT发送手动浇水指令（匹配ESP32固件格式）
    publishToDevice(device.device_code, {
      water: action === 'start',
      duration: duration || 30
    });
    
    res.json({ success: true, message: '手动浇水指令已发送' });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: '服务器错误' });
  }
});

// 浇水判断API - 异步处理
app.post('/api/watering-judge', requireAuth, async (req, res) => {
  const { device_id, device_code } = req.body;
  const userId = req.user.id;
  
  // 立即返回，异步处理
  res.json({ success: true, message: '请求已接收，正在异步处理...' });
  
  // 异步处理
  (async () => {
    try {
      // 1. 获取设备信息和设置
      let devices;
      if (device_id) {
        [devices] = await pool.query(
          'SELECT id, device_name, device_code, settings FROM devices WHERE id = ? AND user_id = ?',
          [device_id, userId]
        );
      } else if (device_code) {
        [devices] = await pool.query(
          'SELECT id, device_name, device_code, settings FROM devices WHERE device_code = ? AND user_id = ?',
          [device_code, userId]
        );
      } else {
        return;
      }
      if (!devices.length) return;
      const device = devices[0];
      const deviceId = device.id;
      const settings = typeof device.settings === 'string' ? JSON.parse(device.settings) : (device.settings || {});
      
      // 2. 获取天气数据
      let weatherInfo = '天气数据获取失败';
      const weatherSource = settings.weather_source || 'official';
      const location = settings.location || '';
      
      if (!location) {
        weatherInfo = '设备未设置所在地，无法获取天气';
      } else {
        let apiKey = null;
        if (weatherSource === 'official') {
          const [adminWeather] = await pool.query('SELECT setting_value FROM settings WHERE setting_key = "qweather_api_key"');
          apiKey = adminWeather[0]?.setting_value;
        } else {
          const [userWeather] = await pool.query(
            'SELECT setting_value FROM user_settings WHERE user_id = ? AND setting_key = "qweather_api_key"',
            [userId]
          );
          apiKey = userWeather[0]?.setting_value;
        }
        
        if (apiKey) {
          try {
            const geoRes = await fetch('https://geoapi.qweather.com/v2/city/lookup?location=' + encodeURIComponent(location) + '&key=' + apiKey);
            const geoData = await geoRes.json();
            if (geoData.code === '200' && geoData.location && geoData.location.length) {
              const cityId = geoData.location[0].id;
              const weatherRes = await fetch('https://devapi.qweather.com/v7/weather/now?location=' + cityId + '&key=' + apiKey);
              const weatherData = await weatherRes.json();
              if (weatherData.code === '200') {
                const now = weatherData.now;
                weatherInfo = '当前天气：' + now.text + '，温度' + now.temp + '℃，湿度' + now.humidity + '%，风向' + now.windDir + '，风力' + now.windScale + '级';
              }
            }
          } catch (e) {
            console.error('天气API错误:', e.message);
          }
        } else {
          weatherInfo = '未配置天气API Key';
        }
      }
      
      // 3. 获取大模型配置
      let llmConfig = null;
      const llmSource = settings.llm_source || 'official';
      
      if (llmSource === 'official') {
        const [adminLlm] = await pool.query('SELECT * FROM llm_configs WHERE user_id IS NULL AND is_default = 1 LIMIT 1');
        if (adminLlm.length) llmConfig = adminLlm[0];
      } else {
        const modelId = llmSource.replace('custom_', '');
        const [userLlm] = await pool.query('SELECT * FROM llm_configs WHERE id = ? AND user_id = ?', [modelId, userId]);
        if (userLlm.length) llmConfig = userLlm[0];
      }
      
      if (!llmConfig) {
        await pool.query(
          'INSERT INTO device_logs (device_id, log_type, content, result) VALUES (?, ?, ?, ?)',
          [deviceId, 'watering_judge', '大模型配置未找到', JSON.stringify({ error: '未配置大模型' })]
        );
        return;
      }
      
      // 4. 编辑提示词
      const prompt = '你是一个智能浇花助手。根据当前天气情况，判断是否需要给植物浇水。\n\n当前天气信息：\n' + weatherInfo + '\n\n设备名称：' + device.device_name + '\n设备位置：' + (settings.location || '未设置') + '\n\n请根据天气情况（温度、湿度、是否下雨等）判断是否需要浇水，并返回以下JSON格式：\n{"should_water": true或false, "reason": "简短的原因说明（20字以内）"}\n\n只返回JSON，不要其他文字。';
      
      // 5. 调用大模型API
      let aiResult = null;
      try {
        const llmRes = await fetch(llmConfig.api_url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': 'Bearer ' + llmConfig.api_key
          },
          body: JSON.stringify({
            model: llmConfig.model_id,
            messages: [
              { role: 'system', content: '你是一个智能浇花助手，只返回JSON格式结果。' },
              { role: 'user', content: prompt }
            ],
            temperature: 0.3
          })
        });
        
        const llmData = await llmRes.json();
        const content = llmData.choices && llmData.choices[0] && llmData.choices[0].message ? llmData.choices[0].message.content : '';
        
        // 解析JSON
        try {
          const jsonMatch = content.match(/\{[\s\S]*\}/);
          if (jsonMatch) {
            aiResult = JSON.parse(jsonMatch[0]);
          }
        } catch (e) {
          console.error('解析AI结果失败:', e.message);
        }
      } catch (e) {
        console.error('调用大模型失败:', e.message);
      }
      
      // 6. 保存到日志
      const logContent = aiResult
        ? '浇水判断：' + (aiResult.should_water ? '需要浇水' : '无需浇水') + '，原因：' + aiResult.reason
        : 'AI判断失败';
      
      await pool.query(
        'INSERT INTO device_logs (device_id, log_type, content, result) VALUES (?, ?, ?, ?)',
        [deviceId, 'watering_judge', logContent, JSON.stringify(aiResult || { error: 'AI判断失败' })]
      );
      
      // 7. 保存指令到设备指令表
      if (aiResult) {
        const commandData = {
          command: 'watering',
          should_water: aiResult.should_water,
          reason: aiResult.reason,
          timestamp: new Date().toISOString()
        };
        await pool.query(
          'INSERT INTO device_commands (device_id, command_type, command_data) VALUES (?, ?, ?)',
          [deviceId, 'watering', JSON.stringify(commandData)]
        );
      }
      
      console.log('[浇水判断] 设备 ' + device.device_code + ' 完成: ' + logContent);
      
    } catch (e) {
      console.error('浇水判断处理错误:', e.message);
    }
  })();
});


// ========== Pages ==========
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'public/admin', 'index.html')));
app.get('/admin/', (req, res) => res.sendFile(path.join(__dirname, 'public/admin', 'index.html')));
app.get('/admin/login', (req, res) => res.sendFile(path.join(__dirname, 'public/auth', 'admin-login.html')));
app.get('/user', (req, res) => res.sendFile(path.join(__dirname, 'public/user', 'index.html')));
app.get('/user/', (req, res) => res.sendFile(path.join(__dirname, 'public/user', 'index.html')));
app.get('/login', (req, res) => res.sendFile(path.join(__dirname, 'public/auth', 'login.html')));
app.get('/register', (req, res) => res.sendFile(path.join(__dirname, 'public/auth', 'register.html')));
app.get('/user/device/:id', requireAuth, (req, res) => res.sendFile(path.join(__dirname, 'public/user/pages/device_detail.html')));

// ========== ESP32 设备注册 ==========
// ESP32配网后自动注册（无需登录）
app.post('/api/esp32/register', async (req, res) => {
  try {
    const { device_code, username } = req.body;
    if (!device_code) return res.json({ success: false, error: '缺少device_code' });
    
    // 检查设备码是否已存在于设备表
    const [existing] = await pool.query('SELECT id FROM devices WHERE device_code = ?', [device_code]);
    if (existing.length) return res.json({ success: true, message: '设备已存在' });
    
    // 检查是否已在待绑定表中
    const [pending] = await pool.query('SELECT id FROM esp32_pending_devices WHERE device_code = ?', [device_code]);
    if (pending.length) return res.json({ success: true, message: '已在待绑定列表' });
    
    // 插入待绑定表
    await pool.query(
      'INSERT INTO esp32_pending_devices (device_code, username) VALUES (?, ?)',
      [device_code, username || null]
    );
    
    console.log(`[ESP32] 新设备注册: ${device_code}, 用户: ${username || '未填写'}`);
    res.json({ success: true });
  } catch (e) {
    console.error('[ESP32] 注册错误:', e.message);
    res.status(500).json({ success: false, error: e.message });
  }
});

// 查询当前用户的待绑定设备（需登录）
app.get('/api/esp32/pending', requireAuth, async (req, res) => {
  try {
    const username = req.user.username;
    const [rows] = await pool.query(
      'SELECT id, device_code, created_at FROM esp32_pending_devices WHERE username = ? OR username IS NULL OR username = \'\' ORDER BY created_at DESC',
      [username]
    );
    res.json({ success: true, devices: rows });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// 删除待绑定设备（添加设备成功后调用）
app.delete('/api/esp32/pending/:id', requireAuth, async (req, res) => {
  try {
    await pool.query('DELETE FROM esp32_pending_devices WHERE id = ?', [req.params.id]);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// ESP32代码页面
app.get('/user/pages/esp32_code', requireAuth, (req, res) => res.sendFile(path.join(__dirname, 'public/user/pages/esp32_code.html')));
// ESP32固件源码（纯文本）
app.get('/api/esp32/firmware', requireAuth, (req, res) => {
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.sendFile(path.join(__dirname, 'public/esp32_firmware.ino'));
});
// 传感器固件源码
app.get('/api/esp32/sensor-firmware', requireAuth, (req, res) => {
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.sendFile(path.join(__dirname, 'public/esp32_sensor_firmware.ino'));
});

async function startServer() {
  try {
    if (await initDatabasePool()) {
      console.log('[数据库] 已连接');
      initGlobalMqtt(pool);
      pool.query('DELETE FROM login_tokens WHERE created_at < DATE_SUB(NOW(), INTERVAL 365 DAY)').then(([r]) => {
        if (r.affectedRows > 0) console.log('[清理] 已清理 ' + r.affectedRows + ' 条过期token');
      }).catch(() => {});
    } else {
      console.log('[安装] 未检测到数据库配置，请访问 /install 完成安装');
    }
  } catch (e) {
    dbReady = false;
    console.error('[数据库] 连接失败，请访问 /install 重新配置:', e.message);
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`木白云iot平台已启动: http://localhost:${PORT}`);
  });
}

startServer();
