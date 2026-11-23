# Dockyard – Project Management Tool (CodeAlpha Task 3)

A collaborative Trello/Asana-style tool built for the CodeAlpha Full Stack Development internship.

## Features
- Register / log in (bcrypt-hashed passwords, JWT auth)
- Create group projects and invite teammates by email
- Kanban board with To do / In progress / Done lanes and drag-and-drop
- Task cards with description, assignee and due date (overdue highlighting)
- Comments inside each task
- **Bonus:** notifications (assignments, status changes, comments, invites) and real-time updates over WebSockets (Socket.io)

## Tech stack
- Frontend: HTML, CSS, vanilla JavaScript
- Backend: Node.js, Express.js, Socket.io
- Database: SQLite (via better-sqlite3): users, projects, project_members, tasks, comments, notifications

## Run locally
```bash
npm install
npm start
# open http://localhost:3000
```
Optional environment variables: `PORT`, `JWT_SECRET` (set this to a long random string), `DB_FILE`.

To see real-time updates, register two users in two browsers, create a project with one, invite the other by email, then move a task on one screen.

## REST API
| Method | Endpoint | Purpose |
|---|---|---|
| POST | /api/auth/register, /api/auth/login | Create account / log in |
| GET | /api/me | Current user |
| GET, POST | /api/projects | List / create projects |
| GET, DELETE | /api/projects/:id | Project with members and tasks / delete (owner only) |
| POST | /api/projects/:id/members | Invite a registered user by email |
| POST | /api/projects/:id/tasks | Create a task |
| PATCH, DELETE | /api/tasks/:id | Update (status, assignee, due date...) / delete |
| GET, POST | /api/tasks/:id/comments | List / add comments |
| GET | /api/notifications | Latest notifications |
| POST | /api/notifications/read | Mark all as read |

## Submission checklist (CodeAlpha)
1. Push to a GitHub repo named `CodeAlpha_ProjectManagementTool`
2. Record a short video walkthrough and post it on LinkedIn with the repo link, tagging @CodeAlpha
3. Submit through the form shared in your WhatsApp group
