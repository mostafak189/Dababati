const express  = require('express');
const cors     = require('cors');
const { Pool } = require('pg');
const crypto   = require('crypto');   // built-in — no extra install needed

const app  = express();
const port         = process.env.PORT || 3000;
// Secret used to sign unlock tokens — set TOKEN_SECRET in your env vars (Render → Environment)
const TOKEN_SECRET = process.env.TOKEN_SECRET || 'change-me-in-production';

// ── Database ────────────────────────────────────────────────────────────────
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }   // required for Neon
});

// ── Middleware ───────────────────────────────────────────────────────────────
app.use(cors());
app.use(express.json());

// Serve frontend files
app.use(express.static(__dirname));

// Root route
app.get('/', (req, res) => {
  res.sendFile(__dirname + '/index.html');
});

// ── DB Init — runs once on startup ──────────────────────────────────────────
async function initDB() {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS counter (
        id      INTEGER PRIMARY KEY DEFAULT 1,
        value   INTEGER NOT NULL DEFAULT 0,
        CHECK (id = 1)          -- only one row ever
      );

      -- Seed row if not present
      INSERT INTO counter (id, value) VALUES (1, 0)
        ON CONFLICT (id) DO NOTHING;

      CREATE TABLE IF NOT EXISTS comments (
        id            TEXT PRIMARY KEY,
        parent_id     TEXT REFERENCES comments(id) ON DELETE CASCADE,
        name          TEXT NOT NULL DEFAULT 'ANON',
        text          TEXT NOT NULL,
        reply_to_name TEXT,
        likes         INTEGER NOT NULL DEFAULT 0,
        created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE INDEX IF NOT EXISTS idx_comments_parent  ON comments(parent_id);
      CREATE INDEX IF NOT EXISTS idx_comments_created ON comments(created_at);

      -- Admin PIN table: one row, PIN stored as a bcrypt hash via pgcrypto.
      -- To set your PIN manually in Neon, run:
      --   INSERT INTO admin_pin (id, pin_hash)
      --   VALUES (1, crypt('YOUR_PIN_HERE', gen_salt('bf', 10)))
      --   ON CONFLICT (id) DO UPDATE SET pin_hash = EXCLUDED.pin_hash;
      -- (Make sure the pgcrypto extension is enabled: CREATE EXTENSION IF NOT EXISTS pgcrypto;)
      CREATE EXTENSION IF NOT EXISTS pgcrypto;
      CREATE TABLE IF NOT EXISTS admin_pin (
        id       INTEGER PRIMARY KEY DEFAULT 1,
        pin_hash TEXT    NOT NULL,
        CHECK (id = 1)
      );
    `);
    console.log('✅  Database tables ready');
  } finally {
    client.release();
  }
}

// ── Auto-prune: delete comments/replies older than 3 days ───────────────────
async function pruneOldComments() {
  try {
    const res = await pool.query(
      `DELETE FROM comments WHERE created_at < NOW() - INTERVAL '3 days'`
    );
    if (res.rowCount > 0)
      console.log(`🗑  Pruned ${res.rowCount} expired comment(s)`);
  } catch (err) {
    console.error('Prune error:', err.message);
  }
}
// Run prune every hour
setInterval(pruneOldComments, 60 * 60 * 1000);


// ════════════════════════════════════════════════════════════════════════════
//  TOKEN HELPERS  (HMAC-SHA256, no extra packages)
// ════════════════════════════════════════════════════════════════════════════

// Token payload: "expires:<unix-ms>"  — signed with HMAC-SHA256
function makeToken(ttlMs = 5 * 60 * 1000) {
  const payload = `expires:${Date.now() + ttlMs}`;
  const sig     = crypto.createHmac('sha256', TOKEN_SECRET).update(payload).digest('hex');
  return Buffer.from(`${payload}.${sig}`).toString('base64url');
}

function verifyToken(token) {
  try {
    const raw              = Buffer.from(token, 'base64url').toString();
    const lastDot          = raw.lastIndexOf('.');
    const payload          = raw.slice(0, lastDot);
    const sig              = raw.slice(lastDot + 1);
    const expected         = crypto.createHmac('sha256', TOKEN_SECRET).update(payload).digest('hex');
    if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return false;
    const expiry           = parseInt(payload.split(':')[1], 10);
    return Date.now() < expiry;
  } catch { return false; }
}


// ════════════════════════════════════════════════════════════════════════════
//  AUTH ROUTES
// ════════════════════════════════════════════════════════════════════════════

// POST /auth/pin   body: { pin: "1234" }  →  { token } | 401
app.post('/auth/pin', async (req, res) => {
  const { pin } = req.body;
  if (!pin || !/^\d{4,8}$/.test(pin))
    return res.status(400).json({ error: 'PIN must be 4–8 digits' });

  try {
    const { rows } = await pool.query(
      `SELECT (pin_hash = crypt($1, pin_hash)) AS ok FROM admin_pin WHERE id = 1`,
      [pin]
    );
    if (!rows.length || !rows[0].ok)
      return res.status(401).json({ error: 'Invalid PIN' });

    res.json({ token: makeToken() });
  } catch (err) {
    console.error('PIN check error:', err.message);
    res.status(500).json({ error: 'DB error' });
  }
});

// GET /auth/verify   header: Authorization: Bearer <token>  →  200 | 401
app.get('/auth/verify', (req, res) => {
  const header = req.headers.authorization || '';
  const token  = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (verifyToken(token)) return res.json({ ok: true });
  res.status(401).json({ error: 'Invalid or expired token' });
});


// ════════════════════════════════════════════════════════════════════════════
//  COUNTER ROUTES
// ════════════════════════════════════════════════════════════════════════════

// GET /counter  →  { value: 42 }
app.get('/counter', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT value FROM counter WHERE id = 1');
    res.json({ value: rows[0]?.value ?? 0 });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'DB error' });
  }
});

// POST /counter  body: { value: 43 }  →  { value: 43 }
app.post('/counter', async (req, res) => {
  const value = parseInt(req.body.value, 10);
  if (isNaN(value) || value < 0 || value > 999)
    return res.status(400).json({ error: 'value must be 0–999' });

  try {
    const { rows } = await pool.query(
      'UPDATE counter SET value = $1 WHERE id = 1 RETURNING value',
      [value]
    );
    res.json({ value: rows[0].value });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'DB error' });
  }
});


// ════════════════════════════════════════════════════════════════════════════
//  COMMENTS ROUTES
// ════════════════════════════════════════════════════════════════════════════

// GET /comments  →  full thread tree (top-level + nested replies)
app.get('/comments', async (req, res) => {
  try {
    await pruneOldComments();   // prune on every read too, just in case

    const { rows } = await pool.query(`
      SELECT id, parent_id, name, text, reply_to_name, likes,
             EXTRACT(EPOCH FROM created_at)::BIGINT * 1000 AS ts
      FROM comments
      ORDER BY created_at ASC
    `);

    // Build tree
    const map   = {};
    const roots = [];

    rows.forEach(r => {
      map[r.id] = { ...r, ts: Number(r.ts), replies: [] };
    });
    rows.forEach(r => {
      if (r.parent_id) {
        map[r.parent_id]?.replies.push(map[r.id]);
      } else {
        roots.push(map[r.id]);
      }
    });

    res.json({ comments: roots });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'DB error' });
  }
});

// POST /comments  body: { id, name, text, parentId?, replyToName? }
app.post('/comments', async (req, res) => {
  const { id, name, text, parentId, replyToName } = req.body;

  if (!id || !text?.trim())
    return res.status(400).json({ error: 'id and text are required' });

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
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'Duplicate id' });
    console.error(err);
    res.status(500).json({ error: 'DB error' });
  }
});

// POST /comments/:id/like  →  { id, likes }
app.post('/comments/:id/like', async (req, res) => {
  const { delta } = req.body;  // +1 or -1
  const d = delta === -1 ? -1 : 1;

  try {
    const { rows } = await pool.query(`
      UPDATE comments
      SET    likes = GREATEST(0, likes + $1)
      WHERE  id = $2
      RETURNING id, likes
    `, [d, req.params.id]);

    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    res.json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'DB error' });
  }
});

// DELETE /comments/:id  (optional admin use)
app.delete('/comments/:id', async (req, res) => {
  try {
    await pool.query('DELETE FROM comments WHERE id = $1', [req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'DB error' });
  }
});

// ── Health check ─────────────────────────────────────────────────────────────
app.get('/health', (req, res) => res.json({ status: 'ok' }));

// ── Start ────────────────────────────────────────────────────────────────────
initDB().then(() => {
  app.listen(port, () => console.log(`🚀  Dababati API running on port ${port}`));
}).catch(err => {
  console.error('Failed to init DB:', err);
  process.exit(1);
});
