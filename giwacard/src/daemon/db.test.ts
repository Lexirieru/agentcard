import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  DAEMON_DB_FILE_NAME,
  DAEMON_FILE_MODE,
  DAEMON_SCHEMA_VERSION,
  daemonDbPath,
  daemonHome,
  daemonInfoPath,
  daemonLockPath,
  daemonTokenPath,
  ensureDaemonHome,
  fileMode,
  generateDaemonToken,
  hardenDaemonDatabaseFiles,
  migrateDaemonDatabase,
  openDaemonDatabase,
  readSecretFile,
  removeFileIfPresent,
  writeSecretFile,
  type SqlDatabase,
} from './db.js'
import { DaemonSchemaVersionError } from './errors.js'

let dir: string
const open: SqlDatabase[] = []

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'giwacard-daemon-db-'))
})

afterEach(() => {
  while (open.length > 0) {
    try {
      open.pop()?.close()
    } catch {
      // already closed
    }
  }
  rmSync(dir, { recursive: true, force: true })
})

async function openDb(): Promise<SqlDatabase> {
  const db = await openDaemonDatabase({ dir })
  open.push(db)
  return db
}

describe('paths', () => {
  test('all daemon files live inside the giwacard home', () => {
    expect(daemonHome({ dir })).toBe(dir)
    expect(daemonDbPath({ dir })).toBe(join(dir, 'daemon.db'))
    expect(daemonTokenPath({ dir })).toBe(join(dir, 'daemon-token'))
    expect(daemonInfoPath({ dir })).toBe(join(dir, 'daemon.json'))
    expect(daemonLockPath({ dir })).toBe(join(dir, 'daemon.lock'))
  })

  test('defaults to the keystore home when nothing is configured', () => {
    const previous = process.env['GIWACARD_HOME']
    delete process.env['GIWACARD_HOME']
    try {
      expect(daemonHome()).toMatch(/[/\\]\.giwacard$/)
    } finally {
      if (previous !== undefined) process.env['GIWACARD_HOME'] = previous
    }
  })

  test('honours $GIWACARD_HOME, so the daemon follows the keystore', () => {
    const previous = process.env['GIWACARD_HOME']
    process.env['GIWACARD_HOME'] = dir
    try {
      expect(daemonHome()).toBe(dir)
      expect(daemonDbPath()).toBe(join(dir, DAEMON_DB_FILE_NAME))
    } finally {
      if (previous === undefined) delete process.env['GIWACARD_HOME']
      else process.env['GIWACARD_HOME'] = previous
    }
  })

  test('ensureDaemonHome creates the directory as 0700 (KTD-15)', () => {
    const nested = join(dir, 'nested', 'home')
    ensureDaemonHome({ dir: nested })
    expect(statSync(nested).mode & 0o777).toBe(0o700)
  })
})

describe('secret files', () => {
  test('are written 0600 even under a permissive umask', () => {
    const previousUmask = process.umask(0o000)
    try {
      const path = join(dir, 'secret')
      writeSecretFile(path, 'shhh')
      expect(fileMode(path)).toBe(DAEMON_FILE_MODE)
      expect(readSecretFile(path)).toBe('shhh')
    } finally {
      process.umask(previousUmask)
    }
  })

  test('overwrite atomically and tighten an already-loose file', () => {
    const path = join(dir, 'secret')
    writeSecretFile(path, 'first')
    writeSecretFile(path, 'second')
    expect(readSecretFile(path)).toBe('second')
    expect(fileMode(path)).toBe(DAEMON_FILE_MODE)
    // No temp files left behind.
    expect(existsSync(`${path}.tmp`)).toBe(false)
  })

  test('reading an absent file yields null rather than throwing', () => {
    expect(readSecretFile(join(dir, 'nope'))).toBeNull()
    expect(fileMode(join(dir, 'nope'))).toBeNull()
    expect(removeFileIfPresent(join(dir, 'nope'))).toBe(false)
  })

  test('generateDaemonToken returns 32 bytes of hex', () => {
    const a = generateDaemonToken()
    const b = generateDaemonToken()
    expect(a).toMatch(/^[0-9a-f]{64}$/)
    expect(a).not.toBe(b)
  })
})

describe('database', () => {
  test('creates the schema and records its version', async () => {
    const db = await openDb()
    const row = db
      .prepare(`SELECT value FROM schema_meta WHERE key = 'schema_version'`)
      .get() as { value: string }
    expect(row.value).toBe(String(DAEMON_SCHEMA_VERSION))
  })

  test('the database file and its WAL sidecars are 0600 (KTD-15)', async () => {
    const previousUmask = process.umask(0o000)
    try {
      await openDb()
      const path = daemonDbPath({ dir })
      expect(fileMode(path)).toBe(DAEMON_FILE_MODE)
      for (const suffix of ['-wal', '-shm']) {
        const mode = fileMode(`${path}${suffix}`)
        if (mode !== null) expect(mode).toBe(DAEMON_FILE_MODE)
      }
    } finally {
      process.umask(previousUmask)
    }
  })

  test('is idempotent: reopening an existing database is a no-op', async () => {
    const first = await openDb()
    first
      .prepare(
        `INSERT INTO approval_requests
           (id, session_key, status, request_json, created_at, expires_at)
         VALUES ('a', '0xabc', 'pending', '{}', 1, 2)`,
      )
      .run()
    first.close()
    open.pop()

    const second = await openDb()
    const row = second
      .prepare('SELECT COUNT(*) AS n FROM approval_requests')
      .get() as { n: number }
    expect(Number(row.n)).toBe(1)
  })

  test('a :memory: database does not touch the filesystem', async () => {
    const db = await openDaemonDatabase({ path: ':memory:' })
    open.push(db)
    db.exec("INSERT INTO schema_meta (key, value) VALUES ('probe', '1')")
    expect(existsSync(join(dir, DAEMON_DB_FILE_NAME))).toBe(false)
  })

  test('refuses a database written by a newer giwacard', async () => {
    const db = await openDb()
    db.prepare(
      `INSERT INTO schema_meta (key, value) VALUES ('schema_version', ?)
       ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
    ).run(String(DAEMON_SCHEMA_VERSION + 1))

    expect(() => migrateDaemonDatabase(db, 'x')).toThrow(DaemonSchemaVersionError)
    try {
      migrateDaemonDatabase(db, 'x')
    } catch (error) {
      expect((error as DaemonSchemaVersionError).code).toBe(
        'DAEMON_DB_UNSUPPORTED_VERSION',
      )
    }
  })

  test('the status CHECK constraint rejects an unknown lifecycle value', async () => {
    const db = await openDb()
    expect(() =>
      db
        .prepare(
          `INSERT INTO approval_requests
             (id, session_key, status, request_json, created_at, expires_at)
           VALUES ('a', '0xabc', 'maybe', '{}', 1, 2)`,
        )
        .run(),
    ).toThrow()
  })

  test('hardenDaemonDatabaseFiles tolerates missing sidecars', () => {
    const path = join(dir, 'absent.db')
    expect(() => hardenDaemonDatabaseFiles(path)).not.toThrow()
  })

  test('writeSecretFile output survives a round trip through readFileSync', () => {
    const path = join(dir, 'token')
    writeSecretFile(path, 'abc\n')
    expect(readFileSync(path, 'utf8')).toBe('abc\n')
  })
})
