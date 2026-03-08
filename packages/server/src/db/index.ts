import Database from 'better-sqlite3'
import fs from 'node:fs'
import path from 'node:path'

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const SCHEMA = `
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

CREATE TABLE IF NOT EXISTS repo_root (
  did       TEXT PRIMARY KEY NOT NULL,
  cid       TEXT NOT NULL,
  rev       TEXT NOT NULL,
  indexedAt TEXT NOT NULL
);
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
