const express = require('express');
const cors    = require('cors');
const { Pool } = require('pg');

const app  = express();
const port = process.env.PORT || 3000;

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
