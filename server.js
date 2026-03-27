const express  = require('express');
const cors     = require('cors');
const { Pool } = require('pg');
const crypto   = require('crypto');

const app  = express();
const port = process.env.PORT || 3000;
const TOKEN_SECRET = process.env.TOKEN_SECRET || 'change-me-in-production';

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));

app.get('/', (req, res) => {
  res.sendFile(__dirname + '/index.html');
});

async function initDB() {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS counter (id INTEGER PRIMARY KEY DEFAULT 1, value INTEGER NOT NULL DEFAULT 0, CHECK (id = 1));
      INSERT INTO counter (id, value) VALUES (1, 0) ON CONFLICT (id) DO NOTHING;

      CREATE TABLE IF NOT EXISTS comments (
        id TEXT PRIMARY KEY,
        parent_id TEXT REFERENCES comments(id) ON DELETE CASCADE,
        name TEXT NOT NULL DEFAULT 'ANON',
        text TEXT NOT NULL,
        reply_to_name TEXT,
        likes INTEGER NOT NULL DEFAULT 0,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE INDEX IF NOT EXISTS idx_comments_parent ON comments(parent_id);
      CREATE INDEX IF NOT EXISTS idx_comments_created ON comments(created_at);

      CREATE EXTENSION IF NOT EXISTS pgcrypto;
      CREATE TABLE IF NOT EXISTS admin_pin (
        id INTEGER PRIMARY KEY DEFAULT 1,
        pin_hash TEXT NOT NULL,
        CHECK (id = 1)
      );
    `);
    console.log('Database tables ready');
  } finally {
    client.release();
  }
}

setInterval(async () => {
  try {
    await pool.query(`DELETE FROM comments WHERE created_at < NOW() - INTERVAL '3 days'`);
  } catch (e) {
    console.error('Failed to prune old comments:', e);
  }
}, 3600000);

function makeToken(ttlMs=300000) {
  const payload = `expires:${Date.now()+ttlMs}`;
  const sig = crypto.createHmac('sha256', TOKEN_SECRET).update(payload).digest('hex');
  return Buffer.from(`${payload}.${sig}`).toString('base64url');
}

function verifyToken(token) {
  try {
    const raw = Buffer.from(token, 'base64url').toString();
    const lastDot = raw.lastIndexOf('.');
    const payload = raw.slice(0,lastDot);
    const sig = raw.slice(lastDot+1);
    const expected = crypto.createHmac('sha256', TOKEN_SECRET).update(payload).digest('hex');
    if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return false;
    const expiry = parseInt(payload.split(':')[1],10);
    return Date.now() < expiry;
  } catch { return false; }
}

app.post('/auth/pin', async (req, res) => {
  const { pin } = req.body;
  if (!pin || !/^\d{4,8}$/.test(pin))
    return res.status(400).json({ error: 'PIN must be 4–8 digits' });
  try {
    const { rows } = await pool.query(`SELECT (pin_hash = crypt($1, pin_hash)) AS ok FROM admin_pin WHERE id = 1`, [pin]);
    if (!rows.length || !rows[0].ok) return res.status(401).json({ error: 'Invalid PIN' });
    res.json({ token: makeToken() });
  } catch (e) {
    console.error('PIN check error:', e);
    res.status(500).json({ error: 'DB error' });
  }
});

app.get('/auth/verify', (req, res) => {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (verifyToken(token)) return res.json({ ok: true });
  res.status(401).json({ error: 'Invalid or expired token' });
});

app.get('/counter', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT value FROM counter WHERE id=1');
    res.json({ value: rows[0]?.value ?? 0 });
  } catch (e) {
    res.status(500).json({ error: 'DB error' });
  }
});

app.post('/counter', async (req, res) => {
  const value = parseInt(req.body.value, 10);
  if (isNaN(value) || value < 0 || value > 999)
    return res.status(400).json({ error: 'value must be 0–999' });
  try {
    const { rows } = await pool.query('UPDATE counter SET value=$1 WHERE id=1 RETURNING value', [value]);
    res.json({ value: rows[0].value });
  } catch (e) {
    res.status(500).json({ error: 'DB error' });
  }
});

app.get('/comments', async (req, res) => {
  try {
    await pool.query(`DELETE FROM comments WHERE created_at < NOW() - INTERVAL '3 days'`);
    const { rows } = await pool.query(`
      SELECT id, parent_id, name, text, reply_to_name, likes,
              EXTRACT(EPOCH FROM created_at)::BIGINT * 1000 AS ts
      FROM comments ORDER BY created_at ASC
    `);
    const map = {};
    const roots = [];
    rows.forEach(r => { map[r.id] = {...r, ts: Number(r.ts), replies: []}; });
    rows.forEach(r => {
      if(r.parent_id) map[r.parent_id]?.replies.push(map[r.id]);
      else roots.push(map[r.id]);
    });
    res.json({ comments: roots });
  } catch (e) {
    res.status(500).json({ error: 'DB error' });
  }
});

app.post('/comments', async (req, res) => {
  const { id, name, text, parentId, replyToName } = req.body;
  if (!id || !text?.trim())
    return res.status(400).json({ error: 'id and text required' });
  const safeName = (name || 'ANON').slice(0, 30);
  const safeText = text.trim().slice(0, 500);

  try {
    const { rows } = await pool.query(`
      INSERT INTO comments (id, parent_id, name, text, reply_to_name)
      VALUES ($1, $2, $3, $4, $5)
      RETURNING id, parent_id, name, text, reply_to_name, likes,
                EXTRACT(EPOCH FROM created_at)::BIGINT * 1000 AS ts
    `, [id, parentId || null, safeName, safeText, replyToName || null]);
    const row = rows[0];
    res.json({ ...row, ts: Number(row.ts), replies: [] });
  } catch (e) {
    if (e.code === '23505') return res.status(409).json({ error: 'Duplicate id' });
    res.status(500).json({ error: 'DB error' });
  }
});

app.post('/comments/:id/like', async (req, res) => {
  const { delta } = req.body;
  const d = delta === -1 ? -1 : 1;
  try {
    const { rows } = await pool.query(`
      UPDATE comments SET likes = GREATEST(0, likes + $1) WHERE id = $2 RETURNING id, likes
    `, [d, req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    res.json(rows[0]);
  } catch (e) {
    res.status(500).json({ error: 'DB error' });
  }
});

// DELETE /comments/:id authorized by token header
app.delete('/comments/:id', async (req, res) => {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (!verifyToken(token)) return res.status(401).json({ error: 'Unauthorized' });
  try {
    await pool.query('DELETE FROM comments WHERE id = $1', [req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'DB error' });
  }
});

app.get('/health', (req, res) => res.json({ status: 'ok' }));

initDB().then(() => {
  app.listen(port, () => console.log(`🚀  Dababati API running on port ${port}`));
}).catch(err => {
  console.error('Failed to init DB:', err);
  process.exit(1);
});
