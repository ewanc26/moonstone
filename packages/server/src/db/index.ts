import Database from 'better-sqlite3'
import fs from 'node:fs'
import path from 'node:path'

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const SCHEMA = `
-- ── account-manager ──────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS actor (
  did           TEXT PRIMARY KEY NOT NULL,
  handle        TEXT UNIQUE,
  createdAt     TEXT NOT NULL,
  takedownRef   TEXT,
  deactivatedAt TEXT,
  deleteAfter   TEXT
);

CREATE TABLE IF NOT EXISTS account (
  did              TEXT PRIMARY KEY NOT NULL,
  email            TEXT UNIQUE NOT NULL,
  passwordScrypt   TEXT NOT NULL,
  emailConfirmedAt TEXT,
  invitesDisabled  INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS refresh_token (
  id              TEXT PRIMARY KEY NOT NULL,
  did             TEXT NOT NULL,
  appPasswordName TEXT,
  expiresAt       TEXT NOT NULL,
  nextId          TEXT
);
CREATE INDEX IF NOT EXISTS refresh_token_did ON refresh_token(did);

CREATE TABLE IF NOT EXISTS app_password (
  did            TEXT NOT NULL,
  name           TEXT NOT NULL,
  passwordScrypt TEXT NOT NULL,
  createdAt      TEXT NOT NULL,
  privileged     INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (did, name)
);

CREATE TABLE IF NOT EXISTS email_token (
  purpose     TEXT NOT NULL,
  did         TEXT NOT NULL,
  token       TEXT NOT NULL,
  requestedAt TEXT NOT NULL,
  PRIMARY KEY (purpose, did)
);

CREATE TABLE IF NOT EXISTS invite_code (
  code          TEXT PRIMARY KEY NOT NULL,
  availableUses INTEGER NOT NULL,
  disabled      INTEGER NOT NULL DEFAULT 0,
  forAccount    TEXT NOT NULL,
  createdBy     TEXT NOT NULL,
  createdAt     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS invite_code_for_account ON invite_code(forAccount);

CREATE TABLE IF NOT EXISTS invite_code_use (
  code   TEXT NOT NULL,
  usedBy TEXT NOT NULL,
  usedAt TEXT NOT NULL,
  PRIMARY KEY (code, usedBy)
);

CREATE TABLE IF NOT EXISTS signing_key (
  did           TEXT PRIMARY KEY NOT NULL,
  privateKeyJwk TEXT NOT NULL,
  createdAt     TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS reserved_keypair (
  did           TEXT PRIMARY KEY NOT NULL,
  privateKeyJwk TEXT NOT NULL,
  createdAt     TEXT NOT NULL
);

-- ── actor-store (repo + records + blobs, DID-scoped in shared DB) ─────────

CREATE TABLE IF NOT EXISTS repo_root (
  did       TEXT PRIMARY KEY NOT NULL,
  cid       TEXT NOT NULL,
  rev       TEXT NOT NULL,
  indexedAt TEXT NOT NULL
);

-- Raw MST + commit blocks; each block is tied to the DID that owns it.
CREATE TABLE IF NOT EXISTS repo_block (
  did     TEXT NOT NULL,
  cid     TEXT NOT NULL,
  repoRev TEXT NOT NULL,
  size    INTEGER NOT NULL,
  content BLOB NOT NULL,
  PRIMARY KEY (did, cid)
);
CREATE INDEX IF NOT EXISTS repo_block_rev ON repo_block(did, repoRev);

-- Indexed record URIs (at://did/collection/rkey)
CREATE TABLE IF NOT EXISTS record (
  uri        TEXT PRIMARY KEY NOT NULL,
  did        TEXT NOT NULL,
  cid        TEXT NOT NULL,
  collection TEXT NOT NULL,
  rkey       TEXT NOT NULL,
  repoRev    TEXT NOT NULL,
  indexedAt  TEXT NOT NULL,
  takedownRef TEXT
);
CREATE INDEX IF NOT EXISTS record_did ON record(did);
CREATE INDEX IF NOT EXISTS record_did_collection ON record(did, collection);

-- Backlinks for follow/block/like/repost uniqueness enforcement
CREATE TABLE IF NOT EXISTS backlink (
  uri    TEXT NOT NULL,
  path   TEXT NOT NULL,
  linkTo TEXT NOT NULL,
  PRIMARY KEY (uri, path)
);
CREATE INDEX IF NOT EXISTS backlink_path_linkto ON backlink(path, linkTo);

-- Blob metadata (one row per unique CID per DID)
CREATE TABLE IF NOT EXISTS blob (
  did        TEXT NOT NULL,
  cid        TEXT NOT NULL,
  mimeType   TEXT NOT NULL,
  size       INTEGER NOT NULL,
  tempKey    TEXT,
  createdAt  TEXT NOT NULL,
  takedownRef TEXT,
  PRIMARY KEY (did, cid)
);

-- Many-to-many: which blobs are referenced by which records
CREATE TABLE IF NOT EXISTS record_blob (
  did       TEXT NOT NULL,
  blobCid   TEXT NOT NULL,
  recordUri TEXT NOT NULL,
  PRIMARY KEY (did, blobCid, recordUri)
);
CREATE INDEX IF NOT EXISTS record_blob_uri ON record_blob(recordUri);

-- User preferences (app.bsky.actor.putPreferences)
CREATE TABLE IF NOT EXISTS account_pref (
  did     TEXT NOT NULL,
  name    TEXT NOT NULL,
  valueJson TEXT NOT NULL,
  PRIMARY KEY (did, name)
);

-- ── sequencer ─────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS repo_seq (
  seq         INTEGER PRIMARY KEY AUTOINCREMENT,
  did         TEXT NOT NULL,
  eventType   TEXT NOT NULL,
  event       BLOB NOT NULL,
  invalidated INTEGER NOT NULL DEFAULT 0,
  sequencedAt TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS repo_seq_did ON repo_seq(did);
CREATE INDEX IF NOT EXISTS repo_seq_sequenced_at ON repo_seq(sequencedAt);
`

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

export function openDb(directory: string): Database.Database {
  fs.mkdirSync(directory, { recursive: true })
  const db = new Database(path.join(directory, 'account.db'))
  db.pragma('journal_mode = WAL')
  db.pragma('synchronous = NORMAL')
  db.pragma('foreign_keys = ON')
  db.exec(SCHEMA)
  return db
}

export type Db = Database.Database
