
import express from 'express';
import cors from 'cors';
import multer from 'multer';
import path from 'path';
import { fileURLToPath } from 'url';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import sqlite3 from 'sqlite3';
import { open } from 'sqlite';
import { createServer } from 'http';
import { Server as SocketIOServer } from 'socket.io';
import { v4 as uuidv4 } from 'uuid';

// __dirname workaround for ES modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ENV (fallbacks)
const JWT_SECRET = process.env.JWT_SECRET || 'dev_secret_change_me';
const PORT = process.env.PORT || 4000;
const ORIGIN = process.env.ORIGIN || `http://localhost:${PORT}`;

const app = express();
const httpServer = createServer(app);
const io = new SocketIOServer(httpServer, {
  cors: { origin: '*', methods: ['GET','POST'] }
});

app.use(cors({ origin: '*'}));
app.use(express.json({ limit: '10mb' }));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));
app.use('/', express.static(path.join(__dirname, '../frontend/public')));

// SQLite init
let db;
(async () => {
  db = await open({
    filename: path.join(__dirname, 'db', 'luno.db'),
    driver: sqlite3.Database
  });
  await db.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      username TEXT UNIQUE NOT NULL,
      password TEXT NOT NULL,
      avatar TEXT DEFAULT ''
    );
    CREATE TABLE IF NOT EXISTS relations (
      follower_id TEXT,
      followee_id TEXT,
      PRIMARY KEY (follower_id, followee_id),
      FOREIGN KEY (follower_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (followee_id) REFERENCES users(id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS posts (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      caption TEXT DEFAULT '',
      media_type TEXT NOT NULL, -- 'video' or 'image'
      media_url TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS likes (
      user_id TEXT,
      post_id TEXT,
      PRIMARY KEY (user_id, post_id),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (post_id) REFERENCES posts(id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS comments (
      id TEXT PRIMARY KEY,
      post_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (post_id) REFERENCES posts(id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      from_id TEXT NOT NULL,
      to_id TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      FOREIGN KEY (from_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (to_id) REFERENCES users(id) ON DELETE CASCADE
    );
  `);
})();

// Multer setup for media uploads
const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, path.join(__dirname, 'uploads')),
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname || '').toLowerCase();
    cb(null, uuidv4() + ext);
  }
});
const upload = multer({ storage });

// Helpers
function signToken(user) {
  return jwt.sign({ id: user.id, username: user.username }, JWT_SECRET, { expiresIn: '7d' });
}
function auth(req, res, next) {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'No token' });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch (e) {
    return res.status(401).json({ error: 'Invalid token' });
  }
}

// Auth routes
app.post('/api/auth/register', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'username & password required' });
  const hash = await bcrypt.hash(password, 10);
  const id = uuidv4();
  try {
    await db.run('INSERT INTO users (id, username, password) VALUES (?, ?, ?)', [id, username, hash]);
    const token = signToken({ id, username });
    res.json({ token, user: { id, username } });
  } catch (e) {
    res.status(400).json({ error: 'Username taken' });
  }
});

app.post('/api/auth/login', async (req, res) => {
  const { username, password } = req.body;
  const user = await db.get('SELECT * FROM users WHERE username = ?', [username]);
  if (!user) return res.status(400).json({ error: 'Invalid credentials' });
  const ok = await bcrypt.compare(password, user.password);
  if (!ok) return res.status(400).json({ error: 'Invalid credentials' });
  const token = signToken(user);
  res.json({ token, user: { id: user.id, username: user.username, avatar: user.avatar } });
});

// Profile
app.get('/api/users/me', auth, async (req, res) => {
  const me = await db.get('SELECT id, username, avatar FROM users WHERE id = ?', [req.user.id]);
  const stats = await db.get(`
    SELECT
      (SELECT COUNT(*) FROM relations WHERE followee_id = ?) AS followers,
      (SELECT COUNT(*) FROM relations WHERE follower_id = ?) AS following,
      (SELECT COUNT(*) FROM posts WHERE user_id = ?) AS posts
  `, [req.user.id, req.user.id, req.user.id]);
  res.json({ ...me, ...stats });
});

app.post('/api/users/avatar', auth, upload.single('avatar'), async (req, res) => {
  const rel = '/uploads/' + req.file.filename;
  await db.run('UPDATE users SET avatar = ? WHERE id = ?', [rel, req.user.id]);
  res.json({ avatar: rel });
});

// Follow
app.post('/api/users/:id/follow', auth, async (req, res) => {
  const toFollow = req.params.id;
  if (toFollow === req.user.id) return res.status(400).json({ error: 'Cannot follow yourself' });
  try {
    await db.run('INSERT INTO relations (follower_id, followee_id) VALUES (?, ?)', [req.user.id, toFollow]);
    res.json({ ok: true });
  } catch {
    res.json({ ok: true });
  }
});
app.post('/api/users/:id/unfollow', auth, async (req, res) => {
  const toUnfollow = req.params.id;
  await db.run('DELETE FROM relations WHERE follower_id = ? AND followee_id = ?', [req.user.id, toUnfollow]);
  res.json({ ok: true });
});

// Posts
app.post('/api/posts', auth, upload.single('media'), async (req, res) => {
  const mediaUrl = '/uploads/' + req.file.filename;
  const mediaType = (req.file.mimetype || '').startsWith('video') ? 'video' : 'image';
  const id = uuidv4();
  const created = Date.now();
  await db.run('INSERT INTO posts (id, user_id, caption, media_type, media_url, created_at) VALUES (?, ?, ?, ?, ?, ?)', 
    [id, req.user.id, req.body.caption || '', mediaType, mediaUrl, created]);
  res.json({ id, mediaType, mediaUrl, caption: req.body.caption || '', created_at: created });
});

app.get('/api/feed', auth, async (req, res) => {
  // Simple feed: posts from self and followees, newest first
  const posts = await db.all(`
    SELECT p.*, u.username, u.avatar,
      (SELECT COUNT(*) FROM likes l WHERE l.post_id = p.id) AS likes,
      EXISTS(SELECT 1 FROM likes l WHERE l.post_id = p.id AND l.user_id = ?) AS liked
    FROM posts p
    JOIN users u ON u.id = p.user_id
    WHERE p.user_id = ? OR p.user_id IN (SELECT followee_id FROM relations WHERE follower_id = ?)
    ORDER BY created_at DESC
    LIMIT 100;
  `, [req.user.id, req.user.id, req.user.id]);
  res.json(posts);
});

app.post('/api/posts/:id/like', auth, async (req, res) => {
  const pid = req.params.id;
  try {
    await db.run('INSERT INTO likes (user_id, post_id) VALUES (?, ?)', [req.user.id, pid]);
  } catch {}
  res.json({ ok: true });
});
app.post('/api/posts/:id/unlike', auth, async (req, res) => {
  const pid = req.params.id;
  await db.run('DELETE FROM likes WHERE user_id = ? AND post_id = ?', [req.user.id, pid]);
  res.json({ ok: true });
});

app.get('/api/posts/:id/comments', auth, async (req, res) => {
  const pid = req.params.id;
  const rows = await db.all(`
    SELECT c.*, u.username, u.avatar FROM comments c
    JOIN users u ON u.id = c.user_id
    WHERE c.post_id = ?
    ORDER BY created_at ASC
  `, [pid]);
  res.json(rows);
});
app.post('/api/posts/:id/comment', auth, async (req, res) => {
  const pid = req.params.id;
  const id = uuidv4();
  const created = Date.now();
  await db.run('INSERT INTO comments (id, post_id, user_id, content, created_at) VALUES (?, ?, ?, ?, ?)', 
    [id, pid, req.user.id, req.body.content || '', created]);
  res.json({ id, content: req.body.content || '', created_at: created });
});

// Messages (simplified DM)
io.on('connection', (socket) => {
  socket.on('auth', (token) => {
    try {
      const user = jwt.verify(token, JWT_SECRET);
      socket.data.user = user;
      socket.join(user.id);
      socket.emit('authed', { id: user.id, username: user.username });
    } catch {
      socket.emit('error', 'auth_failed');
    }
  });
  socket.on('dm', async ({ to, content }) => {
    const user = socket.data.user;
    if (!user) return;
    const id = uuidv4();
    const created = Date.now();
    // persist into sqlite
    await db.run('INSERT INTO messages (id, from_id, to_id, content, created_at) VALUES (?, ?, ?, ?, ?)', 
      [id, user.id, to, content, created]);
    io.to(to).to(user.id).emit('dm', { id, from: user.id, to, content, created_at: created });
  });
});

httpServer.listen(PORT, () => {
  console.log('Luno server running on ' + PORT);
});
