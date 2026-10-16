-- Component library. `def` holds the full ComponentDef (src/shared/component.ts);
-- the other columns are copies of its fields for listing and filtering.
CREATE TABLE IF NOT EXISTS parts (
  id           text PRIMARY KEY,
  name         text NOT NULL,
  category     text NOT NULL,
  manufacturer text,
  description  text NOT NULL,
  source       text NOT NULL DEFAULT 'builtin',
  def          jsonb NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS parts_category_idx ON parts (category);
