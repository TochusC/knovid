CREATE TABLE knovid_users (
  id uuid PRIMARY KEY,
  email text NOT NULL UNIQUE CHECK (email = lower(email)),
  display_name text NOT NULL CHECK (length(display_name) BETWEEN 1 AND 80),
  password_hash text NOT NULL,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE knovid_sessions (
  token_hash text PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES knovid_users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL
);
CREATE INDEX knovid_sessions_user_idx ON knovid_sessions(user_id);
CREATE INDEX knovid_sessions_expiry_idx ON knovid_sessions(expires_at);

CREATE TABLE knovid_auth_limits (
  key text PRIMARY KEY,
  window_start timestamptz NOT NULL DEFAULT now(),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0)
);

CREATE TABLE knovid_credit_accounts (
  user_id uuid PRIMARY KEY REFERENCES knovid_users(id),
  balance integer NOT NULL DEFAULT 0 CHECK (balance >= 0),
  reserved integer NOT NULL DEFAULT 0 CHECK (reserved >= 0 AND reserved <= balance),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE knovid_project_owners (
  project_id text PRIMARY KEY CHECK (length(project_id) BETWEEN 1 AND 200),
  user_id uuid NOT NULL REFERENCES knovid_users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, user_id)
);
CREATE INDEX knovid_project_owners_user_idx ON knovid_project_owners(user_id, project_id);

CREATE TABLE knovid_credit_reservations (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES knovid_credit_accounts(user_id),
  operation_key text NOT NULL CHECK (length(operation_key) BETWEEN 1 AND 200),
  project_id text NOT NULL,
  revision integer CHECK (revision >= 1),
  revision_id text CHECK (length(revision_id) BETWEEN 1 AND 200),
  scene_id text,
  amount integer NOT NULL CHECK (amount > 0),
  captured_amount integer,
  state text NOT NULL DEFAULT 'reserved' CHECK (state IN ('reserved', 'captured', 'released')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, operation_key),
  UNIQUE (id, user_id),
  CHECK (revision IS NOT NULL OR revision_id IS NOT NULL),
  FOREIGN KEY (project_id,user_id) REFERENCES knovid_project_owners(project_id,user_id),
  CHECK ((state = 'captured' AND captured_amount IS NOT NULL AND captured_amount BETWEEN 0 AND amount)
    OR (state IN ('reserved', 'released') AND captured_amount IS NULL))
);
CREATE INDEX knovid_reservations_pending_idx ON knovid_credit_reservations(created_at) WHERE state = 'reserved';

CREATE TABLE knovid_credit_ledger (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES knovid_credit_accounts(user_id),
  event_key text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('grant', 'reserve', 'capture', 'release')),
  reservation_id uuid,
  delta_balance integer NOT NULL,
  delta_reserved integer NOT NULL,
  balance_after integer NOT NULL CHECK (balance_after >= 0),
  reserved_after integer NOT NULL CHECK (reserved_after >= 0 AND reserved_after <= balance_after),
  reason text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, event_key),
  FOREIGN KEY (reservation_id,user_id) REFERENCES knovid_credit_reservations(id,user_id),
  CHECK (
    (kind = 'grant' AND reservation_id IS NULL AND delta_balance > 0 AND delta_reserved = 0)
    OR (kind = 'reserve' AND reservation_id IS NOT NULL AND delta_balance = 0 AND delta_reserved > 0)
    OR (kind = 'capture' AND reservation_id IS NOT NULL AND delta_balance <= 0 AND delta_reserved < 0)
    OR (kind = 'release' AND reservation_id IS NOT NULL AND delta_balance = 0 AND delta_reserved < 0)
  )
);
CREATE INDEX knovid_credit_ledger_page_idx ON knovid_credit_ledger(user_id, id DESC);

CREATE FUNCTION knovid_reject_ledger_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Credit ledger is append-only' USING ERRCODE = '55000';
END;
$$;
CREATE TRIGGER knovid_credit_ledger_immutable
BEFORE UPDATE OR DELETE OR TRUNCATE ON knovid_credit_ledger
FOR EACH STATEMENT EXECUTE FUNCTION knovid_reject_ledger_mutation();
