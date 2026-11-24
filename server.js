/* Polam Direct — farmer-to-consumer marketplace
 * Zero-dependency Node server: built-in http + node:sqlite + crypto.
 * Run: node server.js   →  http://127.0.0.1:3000
 */
'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '127.0.0.1';
const COOKIE_SECURE = process.env.COOKIE_SECURE === '1';
const PUBLIC_DIR = path.join(__dirname, 'public');
const DATA_DIR = path.join(__dirname, 'data');
const SESSION_MS = 30 * 24 * 3600 * 1000;

/* ---------------- Catalog ---------------- */
const CATALOG = JSON.parse(fs.readFileSync(path.join(PUBLIC_DIR, 'data', 'catalog.json'), 'utf8'));
const ITEMS = new Map(CATALOG.items.map(i => [i.key, i]));
const CATEGORIES = new Set(CATALOG.categories.map(c => c.key));
const UNITS = new Set(CATALOG.units.map(u => u.key));
const DISTRICTS = new Set(CATALOG.districts.map(d => d.key));
const LANGS = new Set(['te', 'en', 'hi']);

/* ---------------- Database ---------------- */
fs.mkdirSync(DATA_DIR, { recursive: true });
const db = new DatabaseSync(path.join(DATA_DIR, 'market.db'));
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    role TEXT NOT NULL CHECK (role IN ('farmer','consumer')),
    name TEXT NOT NULL,
    phone TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    district TEXT NOT NULL,
    village TEXT NOT NULL DEFAULT '',
    lang TEXT NOT NULL DEFAULT 'te',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS products (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    farmer_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    catalog_key TEXT,
    name TEXT NOT NULL,
    category TEXT NOT NULL,
    unit TEXT NOT NULL,
    price REAL NOT NULL,
    quantity REAL NOT NULL,
    organic INTEGER NOT NULL DEFAULT 0,
    harvest_date TEXT,
    description TEXT NOT NULL DEFAULT '',
    active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_products_farmer ON products(farmer_id);
  CREATE TABLE IF NOT EXISTS orders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    consumer_id INTEGER NOT NULL REFERENCES users(id),
    farmer_id INTEGER NOT NULL REFERENCES users(id),
    status TEXT NOT NULL DEFAULT 'placed',
    delivery_method TEXT NOT NULL,
    address TEXT NOT NULL DEFAULT '',
    payment_method TEXT NOT NULL,
    note TEXT NOT NULL DEFAULT '',
    total REAL NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_orders_consumer ON orders(consumer_id);
  CREATE INDEX IF NOT EXISTS idx_orders_farmer ON orders(farmer_id);
  CREATE TABLE IF NOT EXISTS order_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
    product_id INTEGER NOT NULL REFERENCES products(id),
    catalog_key TEXT,
    name TEXT NOT NULL,
    unit TEXT NOT NULL,
    price REAL NOT NULL,
    qty REAL NOT NULL
  );
`);
db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(Date.now());

/* ---------------- Helpers ---------------- */
class ApiError extends Error {
  constructor(status, code, params) { super(code); this.status = status; this.code = code; this.params = params; }
}
const bad = (code, params) => new ApiError(400, code, params);
const round2 = v => Math.round(v * 100) / 100;
const sha256 = s => crypto.createHash('sha256').update(s).digest('hex');
const str = (v, minLen, maxLen) => {
  const s = typeof v === 'string' ? v.trim().replace(/\s+/g, ' ') : '';
  return s.length >= minLen && s.length <= maxLen ? s : null;
};
const normPhone = v => {
  let d = String(v || '').replace(/\D/g, '');
  if (d.length === 12 && d.startsWith('91')) d = d.slice(2);
  return /^[6-9]\d{9}$/.test(d) ? d : null;
};

function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  return `${salt.toString('hex')}:${crypto.scryptSync(pw, salt, 64).toString('hex')}`;
}
const DUMMY_HASH = hashPassword('timing-equaliser');
function verifyPassword(pw, stored) {
  const [s, h] = stored.split(':');
  const calc = crypto.scryptSync(pw, Buffer.from(s, 'hex'), 64), want = Buffer.from(h, 'hex');
  return want.length === calc.length && crypto.timingSafeEqual(want, calc);
}

function parseCookies(header) {
  const out = {};
  (header || '').split(';').forEach(p => {
    const i = p.indexOf('=');
    if (i > 0) out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim());
  });
  return out;
}
function sessionCookie(token, maxAgeSec) {
  return `sid=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSec}${COOKIE_SECURE ? '; Secure' : ''}`;
}
function createSession(res, userId) {
  const token = crypto.randomBytes(32).toString('hex');
  db.prepare('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)').run(sha256(token), userId, Date.now() + SESSION_MS);
  res.setHeader('Set-Cookie', sessionCookie(token, SESSION_MS / 1000));
}
function currentUser(req) {
  const sid = parseCookies(req.headers.cookie).sid;
  if (!sid || !/^[a-f0-9]{64}$/.test(sid)) return null;
  return db.prepare(`SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id
                     WHERE s.token_hash = ? AND s.expires_at > ?`).get(sha256(sid), Date.now()) || null;
}
const publicUser = u => u && ({ id: u.id, role: u.role, name: u.name, phone: u.phone, district: u.district, village: u.village, lang: u.lang });

// Simple in-memory login rate limit: 10 attempts / 15 min per IP+phone.
const attempts = new Map();
function rateLimit(key) {
  const now = Date.now(), win = 15 * 60 * 1000;
  const list = (attempts.get(key) || []).filter(t => now - t < win);
  if (list.length >= 10) throw new ApiError(429, 'err_rate');
  list.push(now);
  attempts.set(key, list);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', c => {
      size += c.length;
      if (size > 100000) { reject(new ApiError(413, 'err_generic')); req.destroy(); }
      else chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')) || {}); }
      catch (e) { reject(bad('err_generic')); }
    });
    req.on('error', reject);
  });
}

function send(res, status, body, headers = {}) {
  const data = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
  res.end(data);
}

/* ---------------- Domain ---------------- */
function shapeProduct(p) {
  return {
    id: p.id, farmer_id: p.farmer_id, catalog_key: p.catalog_key, name: p.name, category: p.category, unit: p.unit,
    price: p.price, quantity: p.quantity, organic: !!p.organic, harvest_date: p.harvest_date, description: p.description,
    created_at: p.created_at,
    farmer: p.farmer_name !== undefined ? { id: p.farmer_id, name: p.farmer_name, district: p.district, village: p.village } : undefined
  };
}

function marketPrices() {
  const rows = db.prepare(`SELECT catalog_key, unit, ROUND(AVG(price), 1) AS avg, MIN(price) AS min, COUNT(*) AS n
                           FROM products WHERE active = 1 AND quantity > 0 AND catalog_key IS NOT NULL
                           GROUP BY catalog_key, unit`).all();
  return Object.fromEntries(rows.map(r => [`${r.catalog_key}|${r.unit}`, { avg: r.avg, min: r.min, n: r.n }]));
}

function validateProduct(b) {
  let catalog_key = b.catalog_key || null, name, category;
  if (catalog_key) {
    const it = ITEMS.get(catalog_key);
    if (!it) throw bad('err_product');
    name = it.en; category = it.cat;
  } else {
    name = str(b.name, 2, 60);
    category = b.category;
    if (!name || !CATEGORIES.has(category)) throw bad('err_product');
  }
  if (!UNITS.has(b.unit)) throw bad('err_product');
  const price = Number(b.price);
  if (!Number.isFinite(price) || price <= 0 || price > 1e6) throw bad('err_price');
  const quantity = Number(b.quantity);
  if (!Number.isFinite(quantity) || quantity < 0 || quantity > 1e6) throw bad('err_qty');
  const harvest_date = /^\d{4}-\d{2}-\d{2}$/.test(b.harvest_date || '') ? b.harvest_date : null;
  return {
    catalog_key, name, category, unit: b.unit, price: round2(price), quantity: round2(quantity),
    organic: b.organic ? 1 : 0, harvest_date, description: String(b.description || '').trim().slice(0, 500)
  };
}

function placeOrder(user, body) {
  const items = Array.isArray(body.items) ? body.items : [];
  if (!items.length || items.length > 50) throw bad('err_cart_empty');
  const delivery = body.delivery_method === 'delivery' ? 'delivery' : 'pickup';
  const address = String(body.address || '').trim().slice(0, 300);
  if (delivery === 'delivery' && address.length < 5) throw bad('err_address');
  const payment = body.payment_method === 'upi' ? 'upi' : 'cod';
  const note = String(body.note || '').trim().slice(0, 300);

  const want = new Map();
  for (const it of items) {
    const id = Number(it.product_id), qty = Number(it.qty);
    if (!Number.isInteger(id) || !Number.isFinite(qty) || qty <= 0 || qty > 100000) throw bad('err_qty');
    want.set(id, round2((want.get(id) || 0) + qty));
  }

  db.exec('BEGIN IMMEDIATE');
  try {
    const getP = db.prepare('SELECT * FROM products WHERE id = ? AND active = 1');
    const byFarmer = new Map();
    for (const [id, qty] of want) {
      const p = getP.get(id);
      if (!p) throw new ApiError(409, 'err_stock', { name: '#' + id, key: null, product_id: id });
      if (p.farmer_id === user.id) throw new ApiError(403, 'err_forbidden');
      if (p.quantity + 1e-9 < qty) throw new ApiError(409, 'err_stock', { name: p.name, key: p.catalog_key, product_id: id, available: p.quantity });
      if (!byFarmer.has(p.farmer_id)) byFarmer.set(p.farmer_id, []);
      byFarmer.get(p.farmer_id).push({ p, qty });
    }
    const insOrder = db.prepare(`INSERT INTO orders (consumer_id, farmer_id, delivery_method, address, payment_method, note, total)
                                 VALUES (?, ?, ?, ?, ?, ?, ?)`);
    const insItem = db.prepare(`INSERT INTO order_items (order_id, product_id, catalog_key, name, unit, price, qty)
                                VALUES (?, ?, ?, ?, ?, ?, ?)`);
    const decStock = db.prepare(`UPDATE products SET quantity = ROUND(quantity - ?, 2), updated_at = datetime('now') WHERE id = ?`);
    const ids = [];
    for (const [farmerId, lines] of byFarmer) {
      const total = round2(lines.reduce((s, l) => s + l.p.price * l.qty, 0));
      const oid = Number(insOrder.run(user.id, farmerId, delivery, address, payment, note, total).lastInsertRowid);
      for (const { p, qty } of lines) {
        insItem.run(oid, p.id, p.catalog_key, p.name, p.unit, p.price, qty);
        decStock.run(qty, p.id);
      }
      ids.push(oid);
    }
    db.exec('COMMIT');
    return ids;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

function restoreStock(orderId) {
  const items = db.prepare('SELECT product_id, qty FROM order_items WHERE order_id = ?').all(orderId);
  const upd = db.prepare(`UPDATE products SET quantity = ROUND(quantity + ?, 2), updated_at = datetime('now') WHERE id = ?`);
  items.forEach(i => upd.run(i.qty, i.product_id));
}

function attachItems(orders) {
  if (!orders.length) return orders;
  const ids = orders.map(o => o.id);
  const items = db.prepare(`SELECT * FROM order_items WHERE order_id IN (${ids.map(() => '?').join(',')})`).all(...ids);
  const by = new Map(ids.map(id => [id, []]));
  items.forEach(i => by.get(i.order_id).push({ product_id: i.product_id, catalog_key: i.catalog_key, name: i.name, unit: i.unit, price: i.price, qty: i.qty }));
  return orders.map(o => ({ ...o, items: by.get(o.id) }));
}

/* ---------------- Route handlers ---------------- */
const H = {
  async register({ body, res }) {
    const role = body.role;
    if (role !== 'farmer' && role !== 'consumer') throw bad('err_role');
    const name = str(body.name, 2, 60);
    if (!name) throw bad('err_name');
    const phone = normPhone(body.phone);
    if (!phone) throw bad('err_phone');
    if (typeof body.password !== 'string' || body.password.length < 6 || body.password.length > 100) throw bad('err_password');
    if (!DISTRICTS.has(body.district)) throw bad('err_district');
    const village = str(body.village || '', 0, 80) ?? '';
    const lang = LANGS.has(body.lang) ? body.lang : 'te';
    if (db.prepare('SELECT 1 FROM users WHERE phone = ?').get(phone)) throw new ApiError(409, 'err_phone_taken');
    const r = db.prepare(`INSERT INTO users (role, name, phone, password_hash, district, village, lang) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(role, name, phone, hashPassword(body.password), body.district, village, lang);
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(Number(r.lastInsertRowid));
    createSession(res, user.id);
    return { user: publicUser(user) };
  },

  async login({ body, req, res }) {
    const phone = normPhone(body.phone);
    rateLimit(`${req.socket.remoteAddress}|${phone || 'x'}`);
    const pw = typeof body.password === 'string' ? body.password : '';
    const user = phone ? db.prepare('SELECT * FROM users WHERE phone = ?').get(phone) : null;
    const okPw = verifyPassword(pw, user ? user.password_hash : DUMMY_HASH);
    if (!user || !okPw) throw new ApiError(401, 'err_login');
    createSession(res, user.id);
    return { user: publicUser(user) };
  },

  async logout({ req, res }) {
    const sid = parseCookies(req.headers.cookie).sid;
    if (sid) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha256(sid));
    res.setHeader('Set-Cookie', sessionCookie('', 0));
    return { ok: true };
  },

  async me({ user }) { return { user: publicUser(user) }; },

  async updateMe({ user, body }) {
    const name = body.name !== undefined ? str(body.name, 2, 60) : user.name;
    if (!name) throw bad('err_name');
    const district = body.district !== undefined ? body.district : user.district;
    if (!DISTRICTS.has(district)) throw bad('err_district');
    const village = body.village !== undefined ? (str(body.village, 0, 80) ?? '') : user.village;
    const lang = LANGS.has(body.lang) ? body.lang : user.lang;
    db.prepare('UPDATE users SET name = ?, district = ?, village = ?, lang = ? WHERE id = ?').run(name, district, village, lang, user.id);
    return { user: publicUser(db.prepare('SELECT * FROM users WHERE id = ?').get(user.id)) };
  },

  async stats() {
    return db.prepare(`SELECT (SELECT COUNT(*) FROM users WHERE role = 'farmer') AS farmers,
                              (SELECT COUNT(*) FROM products WHERE active = 1 AND quantity > 0) AS products,
                              (SELECT COUNT(DISTINCT u.district) FROM products p JOIN users u ON u.id = p.farmer_id WHERE p.active = 1) AS districts`).get();
  },

  async listProducts({ url }) {
    const sp = url.searchParams, where = ['p.active = 1'], args = [];
    const ids = sp.get('ids');
    if (ids !== null) {
      const list = ids.split(',').map(Number).filter(Number.isInteger).slice(0, 100);
      if (!list.length) return { products: [], market: marketPrices() };
      where.push(`p.id IN (${list.map(() => '?').join(',')})`);
      args.push(...list);
    } else {
      where.push('p.quantity > 0');
    }
    const cat = sp.get('category');
    if (cat && CATEGORIES.has(cat)) { where.push('p.category = ?'); args.push(cat); }
    const dist = sp.get('district');
    if (dist && DISTRICTS.has(dist)) { where.push('u.district = ?'); args.push(dist); }
    if (sp.get('organic') === '1') where.push('p.organic = 1');
    const farmer = Number(sp.get('farmer'));
    if (Number.isInteger(farmer) && farmer > 0) { where.push('p.farmer_id = ?'); args.push(farmer); }
    const q = (sp.get('q') || '').trim().slice(0, 60);
    if (q) {
      const ql = q.toLowerCase();
      const keys = CATALOG.items.filter(i => [i.en, i.te, i.hi].some(n => n.toLowerCase().includes(ql))).map(i => i.key);
      const like = `%${q}%`;
      const parts = ['p.name LIKE ?', 'u.name LIKE ?', 'u.village LIKE ?', 'p.description LIKE ?'];
      args.push(like, like, like, like);
      if (keys.length) { parts.push(`p.catalog_key IN (${keys.map(() => '?').join(',')})`); args.push(...keys); }
      where.push(`(${parts.join(' OR ')})`);
    }
    const order = { price_asc: 'p.price ASC', price_desc: 'p.price DESC' }[sp.get('sort')] || 'p.updated_at DESC, p.id DESC';
    const rows = db.prepare(`SELECT p.*, u.name AS farmer_name, u.district, u.village
                             FROM products p JOIN users u ON u.id = p.farmer_id
                             WHERE ${where.join(' AND ')} ORDER BY ${order} LIMIT 200`).all(...args);
    return { products: rows.map(shapeProduct), market: marketPrices() };
  },

  async getProduct({ params }) {
    const p = db.prepare(`SELECT p.*, u.name AS farmer_name, u.district, u.village FROM products p JOIN users u ON u.id = p.farmer_id
                          WHERE p.id = ? AND p.active = 1`).get(Number(params[0]));
    if (!p) throw new ApiError(404, 'err_not_found');
    const more = db.prepare(`SELECT p.*, u.name AS farmer_name, u.district, u.village FROM products p JOIN users u ON u.id = p.farmer_id
                             WHERE p.farmer_id = ? AND p.id != ? AND p.active = 1 AND p.quantity > 0 ORDER BY p.updated_at DESC LIMIT 6`).all(p.farmer_id, p.id);
    return { product: shapeProduct(p), more: more.map(shapeProduct), market: marketPrices() };
  },

  async prices() { return { market: marketPrices() }; },

  /* ---- farmer ---- */
  async myProducts({ user }) {
    const rows = db.prepare('SELECT * FROM products WHERE farmer_id = ? AND active = 1 ORDER BY updated_at DESC, id DESC').all(user.id);
    return { products: rows.map(shapeProduct), market: marketPrices() };
  },

  async createProduct({ user, body }) {
    const p = validateProduct(body);
    const r = db.prepare(`INSERT INTO products (farmer_id, catalog_key, name, category, unit, price, quantity, organic, harvest_date, description)
                          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(user.id, p.catalog_key, p.name, p.category, p.unit, p.price, p.quantity, p.organic, p.harvest_date, p.description);
    return { product: shapeProduct(db.prepare('SELECT * FROM products WHERE id = ?').get(Number(r.lastInsertRowid))) };
  },

  async updateProduct({ user, body, params }) {
    const id = Number(params[0]);
    const cur = db.prepare('SELECT * FROM products WHERE id = ? AND active = 1').get(id);
    if (!cur) throw new ApiError(404, 'err_not_found');
    if (cur.farmer_id !== user.id) throw new ApiError(403, 'err_forbidden');
    const p = validateProduct(body);
    db.prepare(`UPDATE products SET catalog_key = ?, name = ?, category = ?, unit = ?, price = ?, quantity = ?, organic = ?,
                harvest_date = ?, description = ?, updated_at = datetime('now') WHERE id = ?`)
      .run(p.catalog_key, p.name, p.category, p.unit, p.price, p.quantity, p.organic, p.harvest_date, p.description, id);
    return { product: shapeProduct(db.prepare('SELECT * FROM products WHERE id = ?').get(id)) };
  },

  async deleteProduct({ user, params }) {
    const id = Number(params[0]);
    const cur = db.prepare('SELECT * FROM products WHERE id = ? AND active = 1').get(id);
    if (!cur) throw new ApiError(404, 'err_not_found');
    if (cur.farmer_id !== user.id) throw new ApiError(403, 'err_forbidden');
    db.prepare(`UPDATE products SET active = 0, updated_at = datetime('now') WHERE id = ?`).run(id);
    return { ok: true };
  },

  async farmerOrders({ user }) {
    const rows = db.prepare(`SELECT o.*, c.name AS customer_name, c.phone AS customer_phone, c.district AS customer_district, c.village AS customer_village
                             FROM orders o JOIN users c ON c.id = o.consumer_id WHERE o.farmer_id = ? ORDER BY o.id DESC LIMIT 200`).all(user.id);
    return { orders: attachItems(rows) };
  },

  async farmerSummary({ user }) {
    const id = user.id;
    return db.prepare(`SELECT
        (SELECT COUNT(*) FROM products WHERE farmer_id = ? AND active = 1 AND quantity > 0) AS active,
        (SELECT COUNT(*) FROM orders WHERE farmer_id = ? AND status = 'placed') AS pending,
        (SELECT COALESCE(SUM(total), 0) FROM orders WHERE farmer_id = ? AND status = 'delivered') AS earned,
        (SELECT COALESCE(SUM(total), 0) FROM orders WHERE farmer_id = ? AND status = 'delivered'
           AND strftime('%Y-%m', updated_at) = strftime('%Y-%m', 'now')) AS month,
        (SELECT COUNT(*) FROM orders WHERE farmer_id = ?) AS total_orders`).get(id, id, id, id, id);
  },

  async farmerUpdateOrder({ user, body, params }) {
    const id = Number(params[0]);
    const o = db.prepare('SELECT * FROM orders WHERE id = ?').get(id);
    if (!o) throw new ApiError(404, 'err_not_found');
    if (o.farmer_id !== user.id) throw new ApiError(403, 'err_forbidden');
    const NEXT = { placed: ['accepted', 'rejected'], accepted: ['ready', 'rejected'], ready: ['delivered'] };
    if (!(NEXT[o.status] || []).includes(body.status)) throw new ApiError(409, 'err_status');
    db.exec('BEGIN IMMEDIATE');
    try {
      db.prepare(`UPDATE orders SET status = ?, updated_at = datetime('now') WHERE id = ?`).run(body.status, id);
      if (body.status === 'rejected') restoreStock(id);
      db.exec('COMMIT');
    } catch (e) { db.exec('ROLLBACK'); throw e; }
    return { ok: true };
  },

  /* ---- consumer ---- */
  async createOrder({ user, body }) { return { order_ids: placeOrder(user, body) }; },

  async myOrders({ user }) {
    const rows = db.prepare(`SELECT o.*, f.name AS farmer_name, f.phone AS farmer_phone, f.district AS farmer_district, f.village AS farmer_village
                             FROM orders o JOIN users f ON f.id = o.farmer_id WHERE o.consumer_id = ? ORDER BY o.id DESC LIMIT 200`).all(user.id);
    return { orders: attachItems(rows) };
  },

  async cancelOrder({ user, params }) {
    const id = Number(params[0]);
    const o = db.prepare('SELECT * FROM orders WHERE id = ?').get(id);
    if (!o) throw new ApiError(404, 'err_not_found');
    if (o.consumer_id !== user.id) throw new ApiError(403, 'err_forbidden');
    if (o.status !== 'placed') throw new ApiError(409, 'err_status');
    db.exec('BEGIN IMMEDIATE');
    try {
      db.prepare(`UPDATE orders SET status = 'cancelled', updated_at = datetime('now') WHERE id = ?`).run(id);
      restoreStock(id);
      db.exec('COMMIT');
    } catch (e) { db.exec('ROLLBACK'); throw e; }
    return { ok: true };
  }
};

// [method, pattern, handler, requiredRole: null = public, 'any' = logged in, 'farmer' | 'consumer']
const ROUTES = [
  ['POST', /^\/api\/register$/, H.register, null],
  ['POST', /^\/api\/login$/, H.login, null],
  ['POST', /^\/api\/logout$/, H.logout, null],
  ['GET', /^\/api\/me$/, H.me, 'any'],
  ['PATCH', /^\/api\/me$/, H.updateMe, 'any'],
  ['GET', /^\/api\/stats$/, H.stats, null],
  ['GET', /^\/api\/products$/, H.listProducts, null],
  ['GET', /^\/api\/products\/(\d+)$/, H.getProduct, null],
  ['GET', /^\/api\/prices$/, H.prices, null],
  ['GET', /^\/api\/farmer\/products$/, H.myProducts, 'farmer'],
  ['POST', /^\/api\/farmer\/products$/, H.createProduct, 'farmer'],
  ['PUT', /^\/api\/farmer\/products\/(\d+)$/, H.updateProduct, 'farmer'],
  ['DELETE', /^\/api\/farmer\/products\/(\d+)$/, H.deleteProduct, 'farmer'],
  ['GET', /^\/api\/farmer\/orders$/, H.farmerOrders, 'farmer'],
  ['GET', /^\/api\/farmer\/summary$/, H.farmerSummary, 'farmer'],
  ['PATCH', /^\/api\/farmer\/orders\/(\d+)$/, H.farmerUpdateOrder, 'farmer'],
  ['POST', /^\/api\/orders$/, H.createOrder, 'consumer'],
  ['GET', /^\/api\/orders$/, H.myOrders, 'consumer'],
  ['POST', /^\/api\/orders\/(\d+)\/cancel$/, H.cancelOrder, 'consumer']
];

async function handleApi(req, res, url) {
  const route = ROUTES.find(([m, re]) => m === req.method && re.test(url.pathname));
  if (!route) {
    const pathExists = ROUTES.some(([, re]) => re.test(url.pathname));
    throw new ApiError(pathExists ? 405 : 404, 'err_not_found');
  }
  const [method, re, handler, role] = route;
  let body = {};
  if (method !== 'GET') {
    // JSON-only mutations: blocks cross-site form posts (CSRF) together with SameSite cookies.
    if (!(req.headers['content-type'] || '').startsWith('application/json')) throw new ApiError(415, 'err_generic');
    body = await readBody(req);
  }
  const user = currentUser(req);
  if (role && !user) throw new ApiError(401, 'err_auth');
  if (role && role !== 'any' && user.role !== role) throw new ApiError(403, 'err_forbidden');
  const result = await handler({ req, res, url, params: url.pathname.match(re).slice(1), body, user });
  send(res, 200, result);
}

/* ---------------- Static files ---------------- */
const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json'
};
function serveStatic(req, res, url) {
  if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); return res.end(); }
  let rel;
  try { rel = decodeURIComponent(url.pathname); } catch (e) { res.writeHead(400); return res.end(); }
  if (rel === '/' || rel === '') rel = '/index.html';
  const file = path.resolve(PUBLIC_DIR, '.' + rel);
  if (!file.startsWith(PUBLIC_DIR + path.sep)) { res.writeHead(403); return res.end(); }
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) { res.writeHead(404, { 'Content-Type': 'text/plain' }); return res.end('Not found'); }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
      'Cache-Control': 'no-cache'
    });
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(file).pipe(res);
  });
}

/* ---------------- Server ---------------- */
const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'same-origin',
  'X-Frame-Options': 'DENY',
  'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'"
};

const server = http.createServer(async (req, res) => {
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.setHeader(k, v);
  const url = new URL(req.url, 'http://localhost');
  try {
    if (url.pathname.startsWith('/api/')) await handleApi(req, res, url);
    else serveStatic(req, res, url);
  } catch (e) {
    if (e instanceof ApiError) return send(res, e.status, { error: e.code, params: e.params || {} });
    console.error(e);
    send(res, 500, { error: 'err_generic' });
  }
});

/* ---------------- Demo seed (first run only) ---------------- */
function seed() {
  if (db.prepare('SELECT COUNT(*) AS n FROM users').get().n > 0) return;
  const pw = hashPassword('demo1234');
  const addUser = (role, name, phone, district, village, lang) => Number(db.prepare(
    'INSERT INTO users (role, name, phone, password_hash, district, village, lang) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(role, name, phone, pw, district, village, lang).lastInsertRowid);
  const day = n => new Date(Date.now() - n * 864e5).toISOString().slice(0, 10);
  const addP = (farmer, key, price, qty, organic, ageDays, description) => {
    const it = ITEMS.get(key);
    db.prepare(`INSERT INTO products (farmer_id, catalog_key, name, category, unit, price, quantity, organic, harvest_date, description)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(farmer, key, it.en, it.cat, it.unit, price, qty, organic ? 1 : 0, day(ageDays), description);
  };

  const f1 = addUser('farmer', 'Venkata Ramaiah', '9000000001', 'guntur', 'Tenali', 'te');
  const f2 = addUser('farmer', 'Lakshmi Devi', '9000000002', 'east_godavari', 'Kadiyam', 'te');
  const f3 = addUser('farmer', 'Srinivasa Reddy', '9000000003', 'anantapur', 'Dharmavaram', 'te');
  const f4 = addUser('farmer', 'Padmavathi', '9000000004', 'annamayya', 'Madanapalle', 'en');
  const c1 = addUser('consumer', 'Anil Kumar', '9000000009', 'visakhapatnam', 'MVP Colony', 'te');

  addP(f1, 'tomato', 20, 150, false, 1, 'Firm, ripe tomatoes picked yesterday.');
  addP(f1, 'green_chilli', 40, 60, false, 1, 'Spicy Guntur green chillies.');
  addP(f1, 'brinjal', 28, 80, true, 2, 'Purple brinjal grown with vermicompost.');
  addP(f1, 'dry_chilli', 180, 200, false, 20, 'Sun-dried Guntur red chillies (Teja).');
  addP(f1, 'turmeric', 140, 50, true, 30, 'Duggirala turmeric fingers, dried and polished.');
  addP(f2, 'banana', 45, 90, false, 0, 'Chakkarakeli bananas from the Godavari delta.');
  addP(f2, 'coconut', 25, 300, false, 2, 'Mature coconuts for cooking.');
  addP(f2, 'papaya', 30, 70, true, 1, '');
  addP(f2, 'gongura', 10, 120, true, 0, 'Fresh gongura for pachadi.');
  addP(f2, 'spinach', 10, 100, true, 0, '');
  addP(f2, 'rice', 58, 500, false, 25, 'New crop Sona Masuri, single polished.');
  addP(f3, 'groundnut', 95, 400, false, 15, 'Bold groundnut kernels from Anantapur.');
  addP(f3, 'sweet_orange', 50, 250, false, 3, 'Juicy mosambi from our orchard.');
  addP(f3, 'ragi', 48, 150, true, 40, 'Millet grown without chemicals.');
  addP(f3, 'red_gram', 135, 120, false, 35, '');
  addP(f3, 'honey', 450, 20, true, 10, 'Raw forest honey, unprocessed.');
  addP(f4, 'tomato', 16, 300, false, 0, 'Madanapalle tomatoes, bulk available.');
  addP(f4, 'carrot', 38, 90, false, 1, '');
  addP(f4, 'cabbage', 22, 120, false, 1, '');
  addP(f4, 'milk', 60, 40, false, 0, 'Fresh buffalo milk, delivered every morning.');
  addP(f4, 'eggs', 110, 30, false, 0, 'Free-range country chicken eggs.');

  const consumer = db.prepare('SELECT * FROM users WHERE id = ?').get(c1);
  const pid = (farmer, key) => db.prepare('SELECT id FROM products WHERE farmer_id = ? AND catalog_key = ?').get(farmer, key).id;
  const [o1] = placeOrder(consumer, { items: [{ product_id: pid(f1, 'tomato'), qty: 5 }, { product_id: pid(f1, 'green_chilli'), qty: 1 }],
    delivery_method: 'delivery', address: 'Flat 12, MVP Colony, Visakhapatnam', payment_method: 'upi', note: 'Please deliver before 10 AM' });
  const [o2] = placeOrder(consumer, { items: [{ product_id: pid(f1, 'dry_chilli'), qty: 2 }], delivery_method: 'pickup', payment_method: 'cod' });
  db.prepare(`UPDATE orders SET status = 'delivered' WHERE id = ?`).run(o2);
  placeOrder(consumer, { items: [{ product_id: pid(f2, 'banana'), qty: 2 }, { product_id: pid(f2, 'gongura'), qty: 3 }],
    delivery_method: 'pickup', payment_method: 'cod' });
  void o1;
  console.log('Seeded demo data (password for all demo accounts: demo1234)');
}
seed();

server.listen(PORT, HOST, () => console.log(`Polam Direct running at http://${HOST}:${PORT}`));
