const path = require('path');
const http = require('http');
const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { Server } = require('socket.io');
const db = require('./db');

const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'change-this-secret-in-production';
if (!process.env.JWT_SECRET) {
  console.warn('JWT_SECRET is not set. Using an insecure default; set it before deploying.');
}

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

/* ---------- helpers ---------- */

const signToken = (user) => jwt.sign({ id: user.id }, JWT_SECRET, { expiresIn: '7d' });
const publicUser = (u) => ({ id: u.id, name: u.name, email: u.email });
const isMember = (projectId, userId) =>
  !!db.prepare('SELECT 1 FROM project_members WHERE project_id = ? AND user_id = ?').get(projectId, userId);

function notify(userId, projectId, text) {
  const info = db
    .prepare('INSERT INTO notifications (user_id, project_id, text) VALUES (?, ?, ?)')
    .run(userId, projectId, text);
  io.to('user:' + userId).emit('notification', { id: info.lastInsertRowid, text, projectId });
}

const broadcast = (projectId, extra = {}) => io.to('project:' + projectId).emit('project:update', { projectId, ...extra });

function auth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(payload.id);
    if (!user) throw new Error('no user');
    req.user = user;
    next();
  } catch {
    res.status(401).json({ error: 'Please log in again.' });
  }
}

function projectAccess(req, res, next) {
  const projectId = Number(req.params.id);
  if (!isMember(projectId, req.user.id)) return res.status(404).json({ error: 'Project not found.' });
  req.projectId = projectId;
  next();
}

function taskAccess(req, res, next) {
  const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(Number(req.params.id));
  if (!task || !isMember(task.project_id, req.user.id)) return res.status(404).json({ error: 'Task not found.' });
  req.task = task;
  next();
}

/* ---------- auth ---------- */

app.post('/api/auth/register', (req, res) => {
  const { name, email, password } = req.body || {};
  if (!name?.trim() || !email?.trim() || !password || password.length < 6) {
    return res.status(400).json({ error: 'Enter your name, email and a password of at least 6 characters.' });
  }
  const cleanEmail = email.trim().toLowerCase();
  if (db.prepare('SELECT id FROM users WHERE email = ?').get(cleanEmail)) {
    return res.status(409).json({ error: 'That email is already registered. Try logging in.' });
  }
  const info = db
    .prepare('INSERT INTO users (name, email, password_hash) VALUES (?, ?, ?)')
    .run(name.trim(), cleanEmail, bcrypt.hashSync(password, 10));
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(info.lastInsertRowid);
  res.status(201).json({ token: signToken(user), user: publicUser(user) });
});

app.post('/api/auth/login', (req, res) => {
  const { email, password } = req.body || {};
  const user = db.prepare('SELECT * FROM users WHERE email = ?').get((email || '').trim().toLowerCase());
  if (!user || !bcrypt.compareSync(password || '', user.password_hash)) {
    return res.status(401).json({ error: 'Email or password is incorrect.' });
  }
  res.json({ token: signToken(user), user: publicUser(user) });
});

app.get('/api/me', auth, (req, res) => res.json({ user: publicUser(req.user) }));

/* ---------- projects ---------- */

app.get('/api/projects', auth, (req, res) => {
  const rows = db
    .prepare(
      `SELECT p.id, p.name, p.description, p.owner_id
       FROM projects p JOIN project_members m ON m.project_id = p.id
       WHERE m.user_id = ? ORDER BY p.created_at DESC, p.id DESC`
    )
    .all(req.user.id);
  res.json({ projects: rows });
});

app.post('/api/projects', auth, (req, res) => {
  const { name, description } = req.body || {};
  if (!name?.trim()) return res.status(400).json({ error: 'Give the project a name.' });
  const create = () => {
    db.exec('BEGIN');
    try {
      const info = db
        .prepare('INSERT INTO projects (name, description, owner_id) VALUES (?, ?, ?)')
        .run(name.trim(), (description || '').trim(), req.user.id);
      db.prepare('INSERT INTO project_members (project_id, user_id, role) VALUES (?, ?, ?)').run(
        info.lastInsertRowid,
        req.user.id,
        'owner'
      );
      db.exec('COMMIT');
      return info.lastInsertRowid;
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  };
  const id = create();
  io.in('user:' + req.user.id).socketsJoin('project:' + id);
  res.status(201).json({ project: db.prepare('SELECT * FROM projects WHERE id = ?').get(id) });
});

app.get('/api/projects/:id', auth, projectAccess, (req, res) => {
  const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(req.projectId);
  const members = db
    .prepare(
      `SELECT u.id, u.name, u.email, m.role FROM users u
       JOIN project_members m ON m.user_id = u.id WHERE m.project_id = ? ORDER BY u.name`
    )
    .all(req.projectId);
  const tasks = db
    .prepare(
      `SELECT t.*, u.name AS assignee_name,
              (SELECT COUNT(*) FROM comments c WHERE c.task_id = t.id) AS comment_count
       FROM tasks t LEFT JOIN users u ON u.id = t.assignee_id
       WHERE t.project_id = ? ORDER BY t.id`
    )
    .all(req.projectId);
  res.json({ project, members, tasks });
});

app.delete('/api/projects/:id', auth, projectAccess, (req, res) => {
  const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(req.projectId);
  if (project.owner_id !== req.user.id) return res.status(403).json({ error: 'Only the project owner can delete it.' });
  db.prepare('DELETE FROM projects WHERE id = ?').run(req.projectId);
  broadcast(req.projectId, { deleted: true });
  res.json({ ok: true });
});

app.post('/api/projects/:id/members', auth, projectAccess, (req, res) => {
  const email = (req.body?.email || '').trim().toLowerCase();
  const invitee = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
  if (!invitee) return res.status(404).json({ error: 'No registered user has that email. Ask them to sign up first.' });
  if (isMember(req.projectId, invitee.id)) return res.status(409).json({ error: 'That person is already on this project.' });
  db.prepare('INSERT INTO project_members (project_id, user_id) VALUES (?, ?)').run(req.projectId, invitee.id);
  io.in('user:' + invitee.id).socketsJoin('project:' + req.projectId);
  const project = db.prepare('SELECT name FROM projects WHERE id = ?').get(req.projectId);
  notify(invitee.id, req.projectId, `${req.user.name} added you to "${project.name}".`);
  broadcast(req.projectId);
  res.status(201).json({ member: publicUser(invitee) });
});

/* ---------- tasks ---------- */

app.post('/api/projects/:id/tasks', auth, projectAccess, (req, res) => {
  const { title, description, assignee_id, due_date } = req.body || {};
  if (!title?.trim()) return res.status(400).json({ error: 'Give the task a title.' });
  let assignee = null;
  if (assignee_id) {
    if (!isMember(req.projectId, Number(assignee_id))) return res.status(400).json({ error: 'Assignee must be on this project.' });
    assignee = Number(assignee_id);
  }
  const info = db
    .prepare(
      'INSERT INTO tasks (project_id, title, description, assignee_id, created_by, due_date) VALUES (?, ?, ?, ?, ?, ?)'
    )
    .run(req.projectId, title.trim(), (description || '').trim(), assignee, req.user.id, due_date || null);
  if (assignee && assignee !== req.user.id) {
    notify(assignee, req.projectId, `${req.user.name} assigned you "${title.trim()}".`);
  }
  broadcast(req.projectId);
  res.status(201).json({ id: info.lastInsertRowid });
});

app.patch('/api/tasks/:id', auth, taskAccess, (req, res) => {
  const task = req.task;
  const body = req.body || {};
  const next = {
    title: body.title !== undefined ? String(body.title).trim() : task.title,
    description: body.description !== undefined ? String(body.description).trim() : task.description,
    status: body.status !== undefined ? body.status : task.status,
    due_date: body.due_date !== undefined ? body.due_date || null : task.due_date,
    assignee_id: body.assignee_id !== undefined ? (body.assignee_id ? Number(body.assignee_id) : null) : task.assignee_id
  };
  if (!next.title) return res.status(400).json({ error: 'A task needs a title.' });
  if (!['todo', 'doing', 'done'].includes(next.status)) return res.status(400).json({ error: 'Unknown status.' });
  if (next.assignee_id && !isMember(task.project_id, next.assignee_id)) {
    return res.status(400).json({ error: 'Assignee must be on this project.' });
  }
  db.prepare(
    'UPDATE tasks SET title = ?, description = ?, status = ?, due_date = ?, assignee_id = ? WHERE id = ?'
  ).run(next.title, next.description, next.status, next.due_date, next.assignee_id, task.id);

  if (next.assignee_id && next.assignee_id !== task.assignee_id && next.assignee_id !== req.user.id) {
    notify(next.assignee_id, task.project_id, `${req.user.name} assigned you "${next.title}".`);
  }
  if (next.status !== task.status && task.assignee_id && task.assignee_id !== req.user.id) {
    notify(task.assignee_id, task.project_id, `${req.user.name} moved "${next.title}" to ${next.status}.`);
  }
  broadcast(task.project_id, { taskId: task.id });
  res.json({ ok: true });
});

app.delete('/api/tasks/:id', auth, taskAccess, (req, res) => {
  db.prepare('DELETE FROM tasks WHERE id = ?').run(req.task.id);
  broadcast(req.task.project_id, { taskId: req.task.id, deleted: true });
  res.json({ ok: true });
});

/* ---------- comments ---------- */

app.get('/api/tasks/:id/comments', auth, taskAccess, (req, res) => {
  const comments = db
    .prepare(
      `SELECT c.id, c.body, c.created_at, u.id AS user_id, u.name AS user_name
       FROM comments c JOIN users u ON u.id = c.user_id WHERE c.task_id = ? ORDER BY c.id`
    )
    .all(req.task.id);
  res.json({ comments });
});

app.post('/api/tasks/:id/comments', auth, taskAccess, (req, res) => {
  const body = (req.body?.body || '').trim();
  if (!body) return res.status(400).json({ error: 'Write a comment first.' });
  db.prepare('INSERT INTO comments (task_id, user_id, body) VALUES (?, ?, ?)').run(req.task.id, req.user.id, body);
  const people = new Set([req.task.assignee_id, req.task.created_by]);
  people.delete(req.user.id);
  people.delete(null);
  people.forEach((uid) => notify(uid, req.task.project_id, `${req.user.name} commented on "${req.task.title}".`));
  broadcast(req.task.project_id, { taskId: req.task.id });
  res.status(201).json({ ok: true });
});

/* ---------- notifications ---------- */

app.get('/api/notifications', auth, (req, res) => {
  const notifications = db
    .prepare('SELECT id, project_id, text, is_read, created_at FROM notifications WHERE user_id = ? ORDER BY id DESC LIMIT 30')
    .all(req.user.id);
  res.json({ notifications });
});

app.post('/api/notifications/read', auth, (req, res) => {
  db.prepare('UPDATE notifications SET is_read = 1 WHERE user_id = ?').run(req.user.id);
  res.json({ ok: true });
});

/* ---------- real-time ---------- */

io.use((socket, next) => {
  try {
    const payload = jwt.verify(socket.handshake.auth?.token, JWT_SECRET);
    socket.userId = payload.id;
    next();
  } catch {
    next(new Error('unauthorized'));
  }
});

io.on('connection', (socket) => {
  socket.join('user:' + socket.userId);
  db.prepare('SELECT project_id FROM project_members WHERE user_id = ?')
    .all(socket.userId)
    .forEach((r) => socket.join('project:' + r.project_id));
});

server.listen(PORT, () => console.log(`Project tool running at http://localhost:${PORT}`));