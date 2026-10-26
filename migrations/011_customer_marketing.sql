-- Customer contact details for birthday greetings and marketing emails (only sent with consent; unsubscribe in every email).
ALTER TABLE customers
  ADD COLUMN email          TEXT,
  ADD COLUMN birthday_month SMALLINT CHECK (birthday_month BETWEEN 1 AND 12),
  ADD COLUMN birthday_day   SMALLINT CHECK (birthday_day BETWEEN 1 AND 31),
  ADD COLUMN address        TEXT,
  ADD COLUMN unsubscribed_at TIMESTAMPTZ;
CREATE INDEX customers_birthday_idx ON customers (birthday_month, birthday_day) WHERE erased_at IS NULL;

-- Every marketing / birthday email send, for the history and the audit.
CREATE TABLE email_sends (
  id          SERIAL PRIMARY KEY,
  kind        TEXT NOT NULL CHECK (kind IN ('campaign','birthday','test')),
  subject     TEXT NOT NULL,
  audience    TEXT,
  recipients  INT NOT NULL DEFAULT 0,
  sent        INT NOT NULL DEFAULT 0,
  failed      INT NOT NULL DEFAULT 0,
  error       TEXT,
  user_id     INT REFERENCES users(id),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX email_sends_created_idx ON email_sends (created_at DESC);

-- One birthday greeting per customer per year, however many times the job runs.
CREATE TABLE birthday_greetings (
  customer_id INT NOT NULL REFERENCES customers(id),
  year        INT NOT NULL,
  sent_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (customer_id, year)
);
