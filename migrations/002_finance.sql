-- Phase 2: finance and savings goals. All money is stored as whole cents (AUD) to avoid rounding errors.

CREATE TABLE transactions (
  id            SERIAL PRIMARY KEY,
  user_id       INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  date          DATE NOT NULL,
  amount_cents  INT NOT NULL CHECK (amount_cents <> 0),   -- positive = money in, negative = money out
  description   TEXT NOT NULL CHECK (length(description) BETWEEN 1 AND 300),
  category      TEXT NOT NULL,
  kind          TEXT NOT NULL CHECK (kind IN ('income','expense','transfer')),
  notes         TEXT NOT NULL DEFAULT '',
  source        TEXT NOT NULL DEFAULT 'manual' CHECK (source IN ('manual','csv','agent','bill')),
  import_hash   TEXT,                                      -- stops the same CSV row being imported twice
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, import_hash)
);
CREATE INDEX transactions_user_date ON transactions (user_id, date DESC);

-- Your own rules: if the description contains `pattern`, use `category`. Checked before the built-in rules.
CREATE TABLE category_rules (
  id          SERIAL PRIMARY KEY,
  user_id     INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  pattern     TEXT NOT NULL CHECK (length(pattern) BETWEEN 2 AND 100),
  category    TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, pattern)
);

CREATE TABLE budgets (
  id            SERIAL PRIMARY KEY,
  user_id       INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  category      TEXT NOT NULL,
  period        TEXT NOT NULL CHECK (period IN ('weekly','monthly')),
  amount_cents  INT NOT NULL CHECK (amount_cents > 0),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, category, period)
);

CREATE TABLE bills (
  id                  SERIAL PRIMARY KEY,
  user_id             INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name                TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  amount_cents        INT NOT NULL CHECK (amount_cents > 0),
  frequency           TEXT NOT NULL CHECK (frequency IN ('weekly','fortnightly','monthly','quarterly','yearly','once')),
  next_due            DATE NOT NULL,
  category            TEXT NOT NULL DEFAULT 'Bills & Utilities',
  is_subscription     BOOLEAN NOT NULL DEFAULT false,
  remind_days_before  INT NOT NULL DEFAULT 3 CHECK (remind_days_before BETWEEN 0 AND 30),
  active              BOOLEAN NOT NULL DEFAULT true,
  last_paid           DATE,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE debts (
  id                  SERIAL PRIMARY KEY,
  user_id             INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name                TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  balance_cents       INT NOT NULL CHECK (balance_cents >= 0),
  interest_rate       NUMERIC(5,2) NOT NULL DEFAULT 0 CHECK (interest_rate >= 0 AND interest_rate <= 100), -- % per year
  min_payment_cents   INT NOT NULL DEFAULT 0 CHECK (min_payment_cents >= 0),
  payment_frequency   TEXT NOT NULL DEFAULT 'monthly' CHECK (payment_frequency IN ('weekly','fortnightly','monthly')),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Your usual take-home pay. Used when there isn't enough transaction history yet.
CREATE TABLE finance_settings (
  user_id           INT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  income_cents      INT CHECK (income_cents IS NULL OR income_cents >= 0),
  income_frequency  TEXT CHECK (income_frequency IN ('weekly','fortnightly','monthly')),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE goals (
  id                SERIAL PRIMARY KEY,
  user_id           INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name              TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  kind              TEXT NOT NULL DEFAULT 'savings' CHECK (kind IN ('savings','emergency_fund','house_deposit','business','debt_payoff','other')),
  target_cents      INT NOT NULL CHECK (target_cents > 0),
  start_date        DATE NOT NULL,
  target_date       DATE,
  status            TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','paused','achieved','archived')),
  notes             TEXT NOT NULL DEFAULT '',
  milestones_hit    INT[] NOT NULL DEFAULT '{}',   -- 25, 50, 75, 100 (%)
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE goal_contributions (
  id            SERIAL PRIMARY KEY,
  goal_id       INT NOT NULL REFERENCES goals(id) ON DELETE CASCADE,
  date          DATE NOT NULL,
  amount_cents  INT NOT NULL CHECK (amount_cents <> 0),   -- negative = withdrawal
  note          TEXT NOT NULL DEFAULT '',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX goal_contributions_goal ON goal_contributions (goal_id, date);
