CREATE TABLE IF NOT EXISTS entries (
  id TEXT PRIMARY KEY,
  title TEXT,
  date TEXT,
  month TEXT,
  category TEXT,
  task_type TEXT,
  person TEXT,
  vendor TEXT,
  account TEXT,
  financial_type TEXT,
  payment_status TEXT,
  property TEXT,
  chemical TEXT,
  amount TEXT,
  notes TEXT,
  reminder TEXT,
  reminder_note TEXT,
  link TEXT,
  link_label TEXT,
  tags JSONB DEFAULT '[]'::jsonb,
  attachments JSONB DEFAULT '[]'::jsonb,
  hidden BOOLEAN DEFAULT FALSE,
  recurring BOOLEAN DEFAULT FALSE,
  created_at TEXT,
  logged_by TEXT,
  logged_by_name TEXT,
  updated_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_entries_category ON entries(category);
CREATE INDEX IF NOT EXISTS idx_entries_date ON entries(date);
CREATE INDEX IF NOT EXISTS idx_entries_payment_status ON entries(payment_status);

CREATE TABLE IF NOT EXISTS dropdowns (
  key TEXT PRIMARY KEY,
  value JSONB
);
