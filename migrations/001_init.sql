-- Phase 1: users, sessions, tasks, memory, AI chat, permissions, approvals, audit log.

CREATE TABLE users (
  id            SERIAL PRIMARY KEY,
  email         TEXT NOT NULL UNIQUE,
  display_name  TEXT NOT NULL DEFAULT 'Me',
  password_hash TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Only a SHA-256 hash of the session token is stored, never the token itself.
CREATE TABLE sessions (
  id          SERIAL PRIMARY KEY,
  user_id     INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash  TEXT NOT NULL UNIQUE,
  user_agent  TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at  TIMESTAMPTZ NOT NULL
);

CREATE TABLE tasks (
  id            SERIAL PRIMARY KEY,
  user_id       INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title         TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 300),
  notes         TEXT NOT NULL DEFAULT '',
  priority      TEXT NOT NULL DEFAULT 'medium' CHECK (priority IN ('low','medium','high','urgent')),
  status        TEXT NOT NULL DEFAULT 'todo' CHECK (status IN ('todo','done','cancelled')),
  due_date      DATE,                 -- local Melbourne calendar date
  due_time      TIME,                 -- optional local time
  estimate_min  INT CHECK (estimate_min IS NULL OR estimate_min BETWEEN 1 AND 1440),
  recurrence    TEXT CHECK (recurrence IS NULL OR recurrence IN ('daily','weekdays','weekly','fortnightly','monthly')),
  is_habit      BOOLEAN NOT NULL DEFAULT false,
  remind_at     TIMESTAMPTZ,          -- delivered by the scheduler in Phase 4
  completed_at  TIMESTAMPTZ,
  parent_id     INT REFERENCES tasks(id) ON DELETE SET NULL, -- previous occurrence of a recurring task
  created_by    TEXT NOT NULL DEFAULT 'user' CHECK (created_by IN ('user','agent')),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX tasks_user_status_due ON tasks (user_id, status, due_date);

-- Long-term memory the agent may read and write. You can inspect, edit, export and delete it.
CREATE TABLE memory_items (
  id          SERIAL PRIMARY KEY,
  user_id     INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  category    TEXT NOT NULL CHECK (category IN ('preference','goal','budget','bill','schedule','content_style','project','other')),
  key         TEXT NOT NULL CHECK (length(key) BETWEEN 1 AND 100),
  value       TEXT NOT NULL CHECK (length(value) BETWEEN 1 AND 2000),
  source      TEXT NOT NULL DEFAULT 'user' CHECK (source IN ('user','agent')),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, category, key)
);

CREATE TABLE conversations (
  id          SERIAL PRIMARY KEY,
  user_id     INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title       TEXT NOT NULL DEFAULT 'New chat',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Full API message content (text, tool calls, tool results) so the agent loop can resume exactly.
CREATE TABLE chat_messages (
  id               SERIAL PRIMARY KEY,
  conversation_id  INT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  role             TEXT NOT NULL CHECK (role IN ('user','assistant')),
  content          JSONB NOT NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX chat_messages_conv ON chat_messages (conversation_id, id);

-- Per-tool permission: 'allow' runs immediately, 'approve' waits for you, 'deny' blocks it.
CREATE TABLE tool_permissions (
  user_id     INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  tool_name   TEXT NOT NULL,
  mode        TEXT NOT NULL CHECK (mode IN ('allow','approve','deny')),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, tool_name)
);

-- Actions the agent proposed that need your explicit approval.
CREATE TABLE pending_actions (
  id               SERIAL PRIMARY KEY,
  user_id          INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  conversation_id  INT REFERENCES conversations(id) ON DELETE SET NULL,
  tool_name        TEXT NOT NULL,
  input            JSONB NOT NULL,
  summary          TEXT NOT NULL,
  status           TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected','failed')),
  result           JSONB,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  decided_at       TIMESTAMPTZ
);

CREATE TABLE audit_log (
  id          BIGSERIAL PRIMARY KEY,
  user_id     INT REFERENCES users(id) ON DELETE SET NULL,
  actor       TEXT NOT NULL CHECK (actor IN ('user','agent','system')),
  action      TEXT NOT NULL,
  detail      JSONB NOT NULL DEFAULT '{}',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX audit_log_user_time ON audit_log (user_id, created_at DESC);

-- Encrypted secrets (OAuth tokens etc.) for later phases. Values are AES-256-GCM ciphertext.
CREATE TABLE secrets (
  user_id     INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  ciphertext  TEXT NOT NULL,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, name)
);
