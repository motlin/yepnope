CREATE TABLE phone_pairing (
 id TEXT PRIMARY KEY NOT NULL,
 session_id TEXT NOT NULL UNIQUE REFERENCES session(id) ON DELETE CASCADE,
 code_hash TEXT NOT NULL,
 expires_at INTEGER NOT NULL,
 attempts INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX phone_pairing_expiry_idx ON phone_pairing(expires_at);
