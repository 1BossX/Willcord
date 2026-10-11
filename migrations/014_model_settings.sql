-- Model connection chosen in the console. The API key is stored encrypted with
-- a key file in the data directory, so a copy of the database alone (a backup)
-- does not carry it. One row at most; without it the environment decides.
CREATE TABLE model_settings (
 id INTEGER PRIMARY KEY CHECK(id=1),
 provider TEXT NOT NULL, name TEXT NOT NULL,
 api_key_enc TEXT, key_hint TEXT,
 updated_at INTEGER NOT NULL
);
