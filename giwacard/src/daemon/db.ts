import { randomBytes } from 'node:crypto'
import {
  chmodSync,
  existsSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'

import {
  ensureKeystoreDir,
  keystoreDir,
  KEYSTORE_DIR_MODE,
  KEYSTORE_FILE_MODE,
} from '../chain/keystore.js'
import { DaemonSchemaVersionError, SqliteUnavailableError } from './errors.js'

/**
 * Storage for the over-policy approval queue (KTD-10) and the runtime files the
 * CLI/MCP server need to find and authenticate against a running daemon.
 *
 * Everything lives in the same `~/.giwacard/` directory as the keystore, under
 * the same discipline (KTD-15): the directory is 0700 and every file the daemon
 * writes is 0600. Directory creation is delegated to the keystore module so the
 * chmod dance exists in exactly one place.
 */

/* -------------------------------------------------------------------------- */
/* Paths                                                                      */
/* -------------------------------------------------------------------------- */

/** SQLite database holding the approval queue. */
export const DAEMON_DB_FILE_NAME = 'daemon.db' as const
/** Per-session CSRF token (KTD-16). Owner-readable only. */
export const DAEMON_TOKEN_FILE_NAME = 'daemon-token' as const
/** Where a running daemon publishes its port/pid so callers can find it. */
export const DAEMON_INFO_FILE_NAME = 'daemon.json' as const
/** Auto-start mutex, so concurrent callers spawn exactly one daemon. */
export const DAEMON_LOCK_FILE_NAME = 'daemon.lock' as const

/** File mode for everything the daemon writes. Same as the keystore's (0600). */
export const DAEMON_FILE_MODE = KEYSTORE_FILE_MODE
/** Directory mode for `~/.giwacard` (0700). */
export const DAEMON_DIR_MODE = KEYSTORE_DIR_MODE

/** Schema version written into `schema_meta`. */
export const DAEMON_SCHEMA_VERSION = 1 as const

/** Locates the `~/.giwacard` directory. `dir` wins, then `$GIWACARD_HOME`. */
export interface DaemonHomeOptions {
  /** Override the giwacard home directory. Defaults to the keystore's. */
  dir?: string
}

/** The giwacard home directory: option > `$GIWACARD_HOME` > `~/.giwacard`. */
export function daemonHome(options: DaemonHomeOptions = {}): string {
  return keystoreDir(options.dir !== undefined ? { dir: options.dir } : {})
}

/** Create `~/.giwacard` with mode 0700 if it does not exist. */
export function ensureDaemonHome(options: DaemonHomeOptions = {}): string {
  return ensureKeystoreDir(options.dir !== undefined ? { dir: options.dir } : {})
}

/** Absolute path of the approval-queue database. */
export function daemonDbPath(options: DaemonHomeOptions = {}): string {
  return join(daemonHome(options), DAEMON_DB_FILE_NAME)
}

/** Absolute path of the per-session CSRF token file. */
export function daemonTokenPath(options: DaemonHomeOptions = {}): string {
  return join(daemonHome(options), DAEMON_TOKEN_FILE_NAME)
}

/** Absolute path of the runtime info file (`{ pid, port, url, ... }`). */
export function daemonInfoPath(options: DaemonHomeOptions = {}): string {
  return join(daemonHome(options), DAEMON_INFO_FILE_NAME)
}

/** Absolute path of the auto-start lockfile. */
export function daemonLockPath(options: DaemonHomeOptions = {}): string {
  return join(daemonHome(options), DAEMON_LOCK_FILE_NAME)
}

/* -------------------------------------------------------------------------- */
/* Secret-file helpers                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Write a 0600 file atomically inside `~/.giwacard`.
 *
 * `writeFileSync`'s `mode` option is masked by the process umask, so the mode is
 * re-applied with an explicit `chmod` — on both the temp file and the final
 * name, since `rename` preserves the source's bits but the destination may
 * already exist with looser ones.
 */
export function writeSecretFile(path: string, contents: string): string {
  const tmp = `${path}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`
  try {
    writeFileSync(tmp, contents, { mode: DAEMON_FILE_MODE })
    chmodSync(tmp, DAEMON_FILE_MODE)
    renameSync(tmp, path)
    chmodSync(path, DAEMON_FILE_MODE)
  } catch (error) {
    if (existsSync(tmp)) rmSync(tmp, { force: true })
    throw error
  }
  return path
}

/** Read a file written by {@link writeSecretFile}, or `null` when absent. */
export function readSecretFile(path: string): string | null {
  try {
    return readFileSync(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

/** Delete a file, reporting whether there was anything to delete. */
export function removeFileIfPresent(path: string): boolean {
  try {
    unlinkSync(path)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

/** Permission bits of a path, e.g. `0o600`. `null` when it does not exist. */
export function fileMode(path: string): number | null {
  try {
    return statSync(path).mode & 0o777
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

/**
 * Re-apply 0600 to the database and its SQLite sidecars.
 *
 * SQLite creates `-wal` / `-shm` / `-journal` itself, with the process umask
 * applied, so they must be tightened after the fact. The containing directory is
 * 0700 regardless, but defence in depth is cheap here.
 */
export function hardenDaemonDatabaseFiles(path: string): void {
  for (const suffix of ['', '-wal', '-shm', '-journal']) {
    const candidate = `${path}${suffix}`
    if (existsSync(candidate)) chmodSync(candidate, DAEMON_FILE_MODE)
  }
}

/** Generate a fresh CSRF token: 32 bytes of CSPRNG output, hex-encoded. */
export function generateDaemonToken(): string {
  return randomBytes(32).toString('hex')
}

/* -------------------------------------------------------------------------- */
/* Minimal SQLite surface                                                     */
/* -------------------------------------------------------------------------- */

/** Values a bound parameter may take. */
export type SqlValue = string | number | bigint | null | Uint8Array

/** Result of a mutating statement. Drivers disagree on number vs bigint. */
export interface SqlRunResult {
  changes?: number | bigint
  lastInsertRowid?: number | bigint
}

/** The prepared-statement subset both drivers implement identically. */
export interface SqlStatement {
  get(...params: SqlValue[]): unknown
  all(...params: SqlValue[]): unknown[]
  run(...params: SqlValue[]): SqlRunResult
}

/**
 * The database subset this module needs.
 *
 * Deliberately tiny: `bun:sqlite`'s `Database` and `node:sqlite`'s
 * `DatabaseSync` both satisfy it structurally, which is what lets the daemon run
 * under either runtime without a compatibility shim per call site.
 */
export interface SqlDatabase {
  prepare(sql: string): SqlStatement
  exec(sql: string): void
  close(): void
}

type SqliteOpener = (path: string) => SqlDatabase

let cachedOpener: SqliteOpener | null = null

/**
 * Resolve an embedded SQLite driver.
 *
 * `bun:sqlite` first (KTD-10's stated choice, and what `bun test` runs on), then
 * Node's built-in `node:sqlite` for `npx giwacard` on Node >= 22.5. The
 * specifiers are held in `string`-typed variables so bundlers leave them as
 * runtime imports rather than trying to resolve a runtime-only module.
 */
export async function loadSqliteOpener(): Promise<SqliteOpener> {
  if (cachedOpener) return cachedOpener

  const errors: unknown[] = []

  if (typeof (globalThis as { Bun?: unknown }).Bun !== 'undefined') {
    const specifier: string = 'bun:sqlite'
    try {
      const mod = (await import(specifier)) as {
        Database: new (path: string, options?: { create?: boolean }) => unknown
      }
      cachedOpener = (path) =>
        new mod.Database(path, { create: true }) as SqlDatabase
      return cachedOpener
    } catch (error) {
      errors.push(error)
    }
  }

  const specifier: string = 'node:sqlite'
  try {
    const mod = (await import(specifier)) as {
      DatabaseSync: new (path: string) => unknown
    }
    cachedOpener = (path) => new mod.DatabaseSync(path) as SqlDatabase
    return cachedOpener
  } catch (error) {
    errors.push(error)
  }

  throw new SqliteUnavailableError(errors[errors.length - 1])
}

/** Reset the cached driver. Tests only. */
export function resetSqliteOpenerCache(): void {
  cachedOpener = null
}

/* -------------------------------------------------------------------------- */
/* Schema                                                                     */
/* -------------------------------------------------------------------------- */

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS schema_meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS approval_requests (
  id                    TEXT PRIMARY KEY,
  session_key           TEXT    NOT NULL,
  agent                 TEXT,
  status                TEXT    NOT NULL CHECK (
                          status IN ('pending', 'approved', 'denied', 'expired')
                        ),
  reason                TEXT,
  request_json          TEXT    NOT NULL,
  idempotency_key       TEXT,
  created_at            INTEGER NOT NULL,
  expires_at            INTEGER NOT NULL,
  resolved_at           INTEGER,
  resolved_by           TEXT,
  decision_note         TEXT,
  owner_signature       TEXT,
  signature_consumed_at INTEGER,
  card_id               TEXT,
  mint_tx_hash          TEXT
);

-- Idempotency is scoped per session key: two different agents may legitimately
-- pick the same key, and one must not shadow the other's request.
CREATE UNIQUE INDEX IF NOT EXISTS approval_requests_idempotency
  ON approval_requests (session_key, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

-- Backs the per-session-key rate-limit count.
CREATE INDEX IF NOT EXISTS approval_requests_session_created
  ON approval_requests (session_key, created_at);

-- Backs "list pending" and the deterministic expiry sweep.
CREATE INDEX IF NOT EXISTS approval_requests_status_expires
  ON approval_requests (status, expires_at);
`

/**
 * Create tables/indexes if needed and check the schema version.
 *
 * Forward-compatible reads are not attempted: a database written by a newer
 * giwacard may have columns this build would silently drop on write.
 */
export function migrateDaemonDatabase(db: SqlDatabase, path: string): void {
  db.exec(SCHEMA_SQL)

  const row = db
    .prepare(`SELECT value FROM schema_meta WHERE key = 'schema_version'`)
    .get() as { value?: unknown } | undefined | null

  const found = row && typeof row.value === 'string' ? Number(row.value) : null

  if (found !== null && Number.isFinite(found)) {
    if (found > DAEMON_SCHEMA_VERSION) {
      throw new DaemonSchemaVersionError(found, DAEMON_SCHEMA_VERSION, path)
    }
    return
  }

  db.prepare(
    `INSERT INTO schema_meta (key, value) VALUES ('schema_version', ?)
     ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
  ).run(String(DAEMON_SCHEMA_VERSION))
}

export interface OpenDaemonDatabaseOptions extends DaemonHomeOptions {
  /** Full path to the database file. Overrides `dir`. `:memory:` is allowed. */
  path?: string
}

/**
 * Open (creating if needed) the approval-queue database.
 *
 * WAL is enabled so a reader (the CLI listing pending requests) never blocks the
 * writer, and the resulting sidecar files are chmod'd back down to 0600.
 */
export async function openDaemonDatabase(
  options: OpenDaemonDatabaseOptions = {},
): Promise<SqlDatabase> {
  const explicit = options.path
  const inMemory =
    explicit === ':memory:' || (explicit?.startsWith('file::memory:') ?? false)

  // Only touch the filesystem for on-disk databases; a `:memory:` database in a
  // test must not conjure a real `~/.giwacard`.
  const path = inMemory
    ? (explicit as string)
    : (explicit ?? join(ensureDaemonHome(options), DAEMON_DB_FILE_NAME))

  const open = await loadSqliteOpener()
  const db = open(path)

  if (!inMemory) db.exec('PRAGMA journal_mode = WAL;')
  db.exec('PRAGMA busy_timeout = 5000;')
  db.exec('PRAGMA foreign_keys = ON;')

  try {
    migrateDaemonDatabase(db, path)
  } catch (error) {
    db.close()
    throw error
  }

  if (!inMemory) hardenDaemonDatabaseFiles(path)
  return db
}
