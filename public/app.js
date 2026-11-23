const $ = (sel, el = document) => el.querySelector(sel);
const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const STATUSES = [
  ['todo', 'To do'],
  ['doing', 'In progress'],
  ['done', 'Done']
];

const state = {
  token: localStorage.getItem('token'),
  user: null,
  projects: [],
  projectId: null,
  project: null,
  members: [],
  tasks: [],
  notifications: [],
  openTaskId: null,
  socket: null,
  authMode: 'login'
};

/* ---------- api ---------- */

async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch('/api' + path, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(state.token ? { Authorization: 'Bearer ' + state.token } : {})
    },
    body: body ? JSON.stringify(body) : undefined
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (res.status === 401 && state.token) logout();
    throw new Error(data.error || 'Something went wrong. Try again.');
  }
  return data;
}

function toast(text) {
  const el = $('#toast');
  el.textContent = text;
  el.hidden = false;
  clearTimeout(toast.t);
  toast.t = setTimeout(() => (el.hidden = true), 4000);
}

/* ---------- auth ---------- */

function showAuth() {
  $('#app-view').hidden = true;
  $('#auth-view').hidden = false;
}

function setAuthMode(mode) {
  state.authMode = mode;
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.dataset.mode === mode));
  $('#name-field').hidden = mode !== 'register';
  $('#name-field input').required = mode === 'register';
  $('#auth-submit').textContent = mode === 'register' ? 'Create account' : 'Log in';
  $('#auth-error').textContent = '';
}

document.querySelectorAll('.tab').forEach((t) => t.addEventListener('click', () => setAuthMode(t.dataset.mode)));

$('#auth-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = Object.fromEntries(new FormData(e.target));
  try {
    const data = await api('/auth/' + state.authMode, { method: 'POST', body: form });
    state.token = data.token;
    localStorage.setItem('token', data.token);
    e.target.reset();
    await boot();
  } catch (err) {
    $('#auth-error').textContent = err.message;
  }
});

function logout() {
  localStorage.removeItem('token');
  state.token = null;
  state.user = null;
  state.projectId = null;
  state.socket?.disconnect();
  state.socket = null;
  showAuth();
}
$('#logout').addEventListener('click', logout);

/* ---------- boot ---------- */

async function boot() {
  if (!state.token) return showAuth();
  try {
    state.user = (await api('/me')).user;
  } catch {
    return showAuth();
  }
  $('#auth-view').hidden = true;
  $('#app-view').hidden = false;
  $('#me-name').textContent = state.user.name;
  connectSocket();
  await loadProjects();
  await loadNotifications();
  if (state.projects.length && !state.projectId) await selectProject(state.projects[0].id);
  else renderProject();
}

function connectSocket() {
  state.socket?.disconnect();
  state.socket = io({ auth: { token: state.token } });
  state.socket.on('project:update', async (p) => {
    if (p.deleted && p.projectId === state.projectId && !p.taskId) {
      state.projectId = null;
      await loadProjects();
      return renderProject();
    }
    await loadProjects();
    if (p.projectId === state.projectId) {
      await loadProject();
      if (state.openTaskId && (!p.taskId || p.taskId === state.openTaskId)) await loadComments();
    }
  });
  state.socket.on('notification', async (n) => {
    toast(n.text);
    await loadNotifications();
  });
}

/* ---------- projects ---------- */

async function loadProjects() {
  state.projects = (await api('/projects')).projects;
  renderProjectList();
}

function renderProjectList() {
  $('#project-list').innerHTML = state.projects.length
    ? state.projects
        .map(
          (p) =>
            `<li><button data-id="${p.id}" class="${p.id === state.projectId ? 'active' : ''}">${esc(p.name)}</button></li>`
        )
        .join('')
    : '<li class="muted" style="color:#9fb0c3">No projects yet.</li>';
}

$('#project-list').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-id]');
  if (btn) selectProject(Number(btn.dataset.id));
});

$('#new-project-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    const { project } = await api('/projects', { method: 'POST', body: { name: new FormData(e.target).get('name') } });
    e.target.reset();
    await loadProjects();
    await selectProject(project.id);
  } catch (err) {
    toast(err.message);
  }
});

async function selectProject(id) {
  state.projectId = id;
  renderProjectList();
  await loadProject();
}

async function loadProject() {
  try {
    const data = await api('/projects/' + state.projectId);
    state.project = data.project;
    state.members = data.members;
    state.tasks = data.tasks;
  } catch {
    state.projectId = null;
  }
  renderProject();
}

function renderProject() {
  const open = !!state.projectId && !!state.project;
  $('#empty-state').hidden = open;
  $('#project-body').hidden = !open;
  if (!open) {
    $('#project-title').textContent = 'Pick a project';
    $('#project-sub').textContent = '';
    return;
  }
  $('#project-title').textContent = state.project.name;
  $('#project-sub').textContent = `${state.members.length} member${state.members.length === 1 ? '' : 's'} · ${state.tasks.length} task${state.tasks.length === 1 ? '' : 's'}`;
  $('#member-list').innerHTML = state.members.map((m) => `<li title="${esc(m.email)}">${esc(m.name)}</li>`).join('');
  $('#delete-project').hidden = state.project.owner_id !== state.user.id;
  renderBoard();
}

$('#delete-project').addEventListener('click', async () => {
  if (!confirm('Delete this project and all its tasks? This cannot be undone.')) return;
  try {
    await api('/projects/' + state.projectId, { method: 'DELETE' });
    state.projectId = null;
    await loadProjects();
    renderProject();
  } catch (err) {
    toast(err.message);
  }
});

$('#invite-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    await api(`/projects/${state.projectId}/members`, { method: 'POST', body: { email: new FormData(e.target).get('email') } });
    e.target.reset();
    $('#board-error').textContent = '';
    toast('Teammate added.');
    await loadProject();
  } catch (err) {
    $('#board-error').textContent = err.message;
  }
});

/* ---------- board ---------- */

function dueLabel(task) {
  if (!task.due_date) return '';
  const overdue = task.status !== 'done' && task.due_date < new Date().toISOString().slice(0, 10);
  return `<span class="${overdue ? 'overdue' : ''}">${overdue ? 'Overdue: ' : 'Due '}${esc(task.due_date)}</span>`;
}

function renderBoard() {
  $('#board').innerHTML = STATUSES.map(([key, label]) => {
    const tasks = state.tasks.filter((t) => t.status === key);
    const cards = tasks.length
      ? tasks
          .map(
            (t) => `<button class="card" draggable="true" data-id="${t.id}">
              <p class="card-title">${esc(t.title)}</p>
              <div class="card-meta">
                ${t.assignee_name ? `<span>${esc(t.assignee_name)}</span>` : '<span>Unassigned</span>'}
                ${dueLabel(t)}
                ${t.comment_count ? `<span>${t.comment_count} comment${t.comment_count === 1 ? '' : 's'}</span>` : ''}
              </div>
            </button>`
          )
          .join('')
      : '<p class="lane-empty">Drop a task here.</p>';
    return `<section class="lane" data-status="${key}">
      <h3>${label} <span class="count">${tasks.length}</span></h3>
      <div class="cards">${cards}</div>
    </section>`;
  }).join('');
}

$('#new-task-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    await api(`/projects/${state.projectId}/tasks`, { method: 'POST', body: { title: new FormData(e.target).get('title') } });
    e.target.reset();
    $('#board-error').textContent = '';
    await loadProject();
  } catch (err) {
    $('#board-error').textContent = err.message;
  }
});

/* drag and drop between lanes */
let dragId = null;
const board = $('#board');

board.addEventListener('dragstart', (e) => {
  const card = e.target.closest('.card');
  if (!card) return;
  dragId = Number(card.dataset.id);
  card.classList.add('dragging');
  e.dataTransfer.effectAllowed = 'move';
  e.dataTransfer.setData('text/plain', String(dragId));
});
board.addEventListener('dragend', (e) => {
  e.target.closest('.card')?.classList.remove('dragging');
  board.querySelectorAll('.lane').forEach((l) => l.classList.remove('over'));
});
board.addEventListener('dragover', (e) => {
  const lane = e.target.closest('.lane');
  if (!lane) return;
  e.preventDefault();
  board.querySelectorAll('.lane').forEach((l) => l.classList.toggle('over', l === lane));
});
board.addEventListener('drop', async (e) => {
  const lane = e.target.closest('.lane');
  if (!lane || dragId === null) return;
  e.preventDefault();
  const task = state.tasks.find((t) => t.id === dragId);
  const status = lane.dataset.status;
  dragId = null;
  if (!task || task.status === status) return;
  task.status = status; // optimistic update
  renderBoard();
  try {
    await api('/tasks/' + task.id, { method: 'PATCH', body: { status } });
  } catch (err) {
    toast(err.message);
    await loadProject();
  }
});

board.addEventListener('click', (e) => {
  const card = e.target.closest('.card');
  if (card) openTask(Number(card.dataset.id));
});

/* ---------- task dialog ---------- */

const dialog = $('#task-dialog');
const taskForm = $('#task-form');

function openTask(id) {
  const task = state.tasks.find((t) => t.id === id);
  if (!task) return;
  state.openTaskId = id;
  taskForm.title.value = task.title;
  taskForm.description.value = task.description;
  taskForm.status.value = task.status;
  taskForm.due_date.value = task.due_date || '';
  taskForm.assignee_id.innerHTML =
    '<option value="">Unassigned</option>' +
    state.members.map((m) => `<option value="${m.id}">${esc(m.name)}</option>`).join('');
  taskForm.assignee_id.value = task.assignee_id || '';
  dialog.showModal();
  loadComments();
}

async function loadComments() {
  if (!state.openTaskId) return;
  try {
    const { comments } = await api(`/tasks/${state.openTaskId}/comments`);
    $('#comment-list').innerHTML = comments.length
      ? comments
          .map(
            (c) => `<li><span class="who">${esc(c.user_name)}</span><time>${esc(c.created_at)} UTC</time><br>${esc(c.body)}</li>`
          )
          .join('')
      : '<li class="muted">No comments yet. Start the discussion below.</li>';
    const list = $('#comment-list');
    list.scrollTop = list.scrollHeight;
  } catch {
    /* task may have been deleted */
  }
}

taskForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = Object.fromEntries(new FormData(taskForm));
  try {
    await api('/tasks/' + state.openTaskId, { method: 'PATCH', body: f });
    dialog.close();
    await loadProject();
  } catch (err) {
    toast(err.message);
  }
});

$('#delete-task').addEventListener('click', async () => {
  if (!confirm('Delete this task?')) return;
  try {
    await api('/tasks/' + state.openTaskId, { method: 'DELETE' });
    dialog.close();
    await loadProject();
  } catch (err) {
    toast(err.message);
  }
});

$('#close-dialog').addEventListener('click', () => dialog.close());
dialog.addEventListener('close', () => (state.openTaskId = null));

$('#comment-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    await api(`/tasks/${state.openTaskId}/comments`, { method: 'POST', body: { body: new FormData(e.target).get('body') } });
    e.target.reset();
    await loadComments();
    await loadProject();
  } catch (err) {
    toast(err.message);
  }
});

/* ---------- notifications ---------- */

async function loadNotifications() {
  state.notifications = (await api('/notifications')).notifications;
  const unread = state.notifications.filter((n) => !n.is_read).length;
  const badge = $('#bell-count');
  badge.textContent = unread;
  badge.hidden = unread === 0;
  $('#bell-list').innerHTML = state.notifications.length
    ? state.notifications
        .map((n) => `<li class="${n.is_read ? '' : 'unread'}">${esc(n.text)}</li>`)
        .join('')
    : '<li class="empty-note">Nothing yet. Assignments and comments will show up here.</li>';
}

$('#bell').addEventListener('click', () => {
  $('#bell-panel').hidden = !$('#bell-panel').hidden;
});
$('#mark-read').addEventListener('click', async () => {
  await api('/notifications/read', { method: 'POST' });
  await loadNotifications();
});
document.addEventListener('click', (e) => {
  if (!e.target.closest('.bell-wrap')) $('#bell-panel').hidden = true;
});

/* ---------- start ---------- */
setAuthMode('login');
boot();
