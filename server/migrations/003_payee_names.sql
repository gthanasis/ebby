-- A name someone gives a payee the bank only knows by a number, such as an IRIS payment to a phone. Keyed by the payee
-- as worked out from the bank's text (merchantName), so every payment to it, past and future, takes the name.
CREATE TABLE payee_names (
  user_id bigint NOT NULL DEFAULT app_user() REFERENCES users(id) ON DELETE CASCADE,
  payee text NOT NULL,
  name text NOT NULL,
  PRIMARY KEY (user_id, payee)
);
ALTER TABLE payee_names ENABLE ROW LEVEL SECURITY;
ALTER TABLE payee_names FORCE ROW LEVEL SECURITY;
CREATE POLICY own_rows ON payee_names USING (user_id = app_user()) WITH CHECK (user_id = app_user());
