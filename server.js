const express  = require('express');
const cors     = require('cors');
const { Pool } = require('pg');
const crypto   = require('crypto');

const app  = express();
const port         = process.env.PORT || 3000;
const TOKEN_SECRET = process.env.TOKEN_SECRET || 'change-me-in-production';

// ── Database ─────────────────────────────────────────────────────────────────
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// ── Middleware ────────────────────────────────────────────────────────────────
app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));

app.get('/', (req, res) => res.sendFile(__dirname + '/index.html'));

// ── DB Init ───────────────────────────────────────────────────────────────────
async function initDB() {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE EXTENSION IF NOT EXISTS pgcrypto;

      CREATE TABLE IF NOT EXISTS counter (
        id    INTEGER PRIMARY KEY DEFAULT 1,
        value INTEGER NOT NULL DEFAULT 0,
        CHECK (id = 1)
      );
      INSERT INTO counter (id, value) VALUES (1, 0) ON CONFLICT (id) DO NOTHING;

      CREATE TABLE IF NOT EXISTS comments (
        id            TEXT        PRIMARY KEY,
        parent_id     TEXT        REFERENCES comments(id) ON DELETE CASCADE,
        name          TEXT        NOT NULL DEFAULT 'ANON',
        text          TEXT        NOT NULL,
        reply_to_name TEXT,
        likes         INTEGER     NOT NULL DEFAULT 0,
        -- FIX: store a delete token per comment so the author can delete their own
        delete_token  TEXT        NOT NULL DEFAULT '',
        created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      -- Add delete_token column if upgrading an existing DB
      ALTER TABLE comments ADD COLUMN IF NOT EXISTS delete_token TEXT NOT NULL DEFAULT '';

      CREATE INDEX IF NOT EXISTS idx_comments_parent  ON comments(parent_id);
      CREATE INDEX IF NOT EXISTS idx_comments_created ON comments(created_at);

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

// ── Auto-prune ────────────────────────────────────────────────────────────────
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
setInterval(pruneOldComments, 60 * 60 * 1000);

// ── Token helpers ─────────────────────────────────────────────────────────────
function makeToken(ttlMs = 5 * 60 * 1000) {
  const payload = `expires:${Date.now() + ttlMs}`;
  const sig     = crypto.createHmac('sha256', TOKEN_SECRET).update(payload).digest('hex');
  return Buffer.from(`${payload}.${sig}`).toString('base64url');
}

function verifyToken(token) {
  try {
    const raw     = Buffer.from(token, 'base64url').toString();
    const lastDot = raw.lastIndexOf('.');
    const payload = raw.slice(0, lastDot);
    const sig     = raw.slice(lastDot + 1);
    const expected = crypto.createHmac('sha256', TOKEN_SECRET).update(payload).digest('hex');
    if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return false;
    const expiry  = parseInt(payload.split(':')[1], 10);
    return Date.now() < expiry;
  } catch { return false; }
}

// ── AUTH ──────────────────────────────────────────────────────────────────────
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

    // FIX: give admin a longer-lived token (30 minutes)
    res.json({ token: makeToken(30 * 60 * 1000) });
  } catch (err) {
    console.error('PIN check error:', err.message);
    res.status(500).json({ error: 'DB error' });
  }
});

app.get('/auth/verify', (req, res) => {
  const header = req.headers.authorization || '';
  const token  = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (verifyToken(token)) return res.json({ ok: true });
  res.status(401).json({ error: 'Invalid or expired token' });
});

// ── COUNTER ───────────────────────────────────────────────────────────────────
app.get('/counter', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT value FROM counter WHERE id = 1');
    res.json({ value: rows[0]?.value ?? 0 });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'DB error' });
  }
});

app.post('/counter', async (req, res) => {
  const value = parseInt(req.body.value, 10);
  if (isNaN(value) || value < 0 || value > 999)
    return res.status(400).json({ error: 'value must be 0–999' });
  try {
    const { rows } = await pool.query(
      'UPDATE counter SET value = $1 WHERE id = 1 RETURNING value', [value]
    );
    res.json({ value: rows[0].value });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'DB error' });
  }
});

// ── COMMENTS ──────────────────────────────────────────────────────────────────
app.get('/comments', async (req, res) => {
  try {
    await pruneOldComments();
    const { rows } = await pool.query(`
      SELECT id, parent_id, name, text, reply_to_name, likes,
             EXTRACT(EPOCH FROM created_at)::BIGINT * 1000 AS ts
      FROM comments
      ORDER BY created_at ASC
    `);
    // NOTE: delete_token is intentionally NOT returned to the client here
    // (it was already given to the author at creation time)
    const map = {}, roots = [];
    rows.forEach(r => { map[r.id] = { ...r, ts: Number(r.ts), replies: [] }; });
    rows.forEach(r => {
      if (r.parent_id) map[r.parent_id]?.replies.push(map[r.id]);
      else roots.push(map[r.id]);
    });
    res.json({ comments: roots });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'DB error' });
  }
});

// FIX: POST /comments — generate and return a delete_token for the author
app.post('/comments', async (req, res) => {
  const { id, name, text, parentId, replyToName } = req.body;

  // FIX: validate all required fields properly
  if (!id || typeof id !== 'string' || id.length > 40)
    return res.status(400).json({ error: 'Invalid id' });
  if (!text || !text.trim())
    return res.status(400).json({ error: 'text is required' });

  const safeName  = (name || 'ANON').trim().slice(0, 30) || 'ANON';
  const safeText  = text.trim().slice(0, 500);
  // FIX: Generate a random delete token — returned once to the author, never again
  const deleteToken = crypto.randomBytes(24).toString('base64url');

  try {
    const { rows } = await pool.query(`
      INSERT INTO comments (id, parent_id, name, text, reply_to_name, delete_token)
      VALUES ($1, $2, $3, $4, $5, $6)
      RETURNING id, parent_id, name, text, reply_to_name, likes,
                delete_token,
                EXTRACT(EPOCH FROM created_at)::BIGINT * 1000 AS ts
    `, [id, parentId || null, safeName, safeText, replyToName || null, deleteToken]);

    const row = rows[0];
    // FIX: return deleteToken to the client once so they can store it locally
    res.status(201).json({ ...row, ts: Number(row.ts), replies: [], deleteToken: row.delete_token });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'Duplicate id — please try again' });
    console.error('Insert comment error:', err);
    res.status(500).json({ error: 'DB error: ' + err.message });
  }
});

// POST /comments/:id/like
app.post('/comments/:id/like', async (req, res) => {
  const d = req.body.delta === -1 ? -1 : 1;
  try {
    const { rows } = await pool.query(`
      UPDATE comments SET likes = GREATEST(0, likes + $1) WHERE id = $2 RETURNING id, likes
    `, [d, req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    res.json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'DB error' });
  }
});

// FIX: DELETE /comments/:id
// Accepts either:
//   a) { deleteToken: "..." }  — author self-delete
//   b) { pin: "1234" }         — admin delete with PIN
app.delete('/comments/:id', async (req, res) => {
  const { deleteToken, pin } = req.body || {};
  const commentId = req.params.id;

  // --- Path A: author self-delete via deleteToken ---
  if (deleteToken) {
    try {
      const { rows } = await pool.query(
        'SELECT id FROM comments WHERE id = $1 AND delete_token = $2',
        [commentId, deleteToken]
      );
      if (!rows.length)
        return res.status(403).json({ error: 'Invalid delete token' });

      await pool.query('DELETE FROM comments WHERE id = $1', [commentId]);
      return res.json({ ok: true, deleted: commentId });
    } catch (err) {
      console.error('Delete (token) error:', err);
      return res.status(500).json({ error: 'DB error' });
    }
  }

  // --- Path B: admin delete via PIN ---
  if (pin) {
    if (!/^\d{4,8}$/.test(pin))
      return res.status(400).json({ error: 'PIN must be 4–8 digits' });
    try {
      const { rows: pinRows } = await pool.query(
        `SELECT (pin_hash = crypt($1, pin_hash)) AS ok FROM admin_pin WHERE id = 1`,
        [pin]
      );
      if (!pinRows.length || !pinRows[0].ok)
        return res.status(401).json({ error: 'Invalid PIN' });

      const { rowCount } = await pool.query('DELETE FROM comments WHERE id = $1', [commentId]);
      if (!rowCount) return res.status(404).json({ error: 'Comment not found' });
      return res.json({ ok: true, deleted: commentId });
    } catch (err) {
      console.error('Delete (pin) error:', err);
      return res.status(500).json({ error: 'DB error' });
    }
  }

  return res.status(400).json({ error: 'Provide deleteToken (author) or pin (admin)' });
});

// ── Health ────────────────────────────────────────────────────────────────────
app.get('/health', (req, res) => res.json({ status: 'ok' }));

// ── Start ─────────────────────────────────────────────────────────────────────
initDB().then(() => {
  app.listen(port, () => console.log(`🚀  Dababati API on port ${port}`));
}).catch(err => {
  console.error('Failed to init DB:', err);
  process.exit(1);
});
