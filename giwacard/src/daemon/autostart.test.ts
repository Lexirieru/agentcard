import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  DAEMON_FILE_MODE,
  daemonInfoPath,
  daemonLockPath,
  daemonTokenPath,
  fileMode,
  writeSecretFile,
} from './db.js'
import { DaemonStartTimeoutError } from './errors.js'
import {
  acquireDaemonLock,
  clearDaemonRuntimeFiles,
  defaultDaemonCommand,
  ensureDaemonRunning,
  probeDaemon,
  readDaemonInfo,
  readDaemonToken,
  resolveCliEntry,
  type DaemonLaunchContext,
} from './autostart.js'
import { startDaemon, type DaemonHandle } from './server.js'

const HERE = dirname(fileURLToPath(import.meta.url))

let dir: string
const daemons: DaemonHandle[] = []
const servers: Server[] = []

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'giwacard-daemon-autostart-'))
})

afterEach(async () => {
  while (daemons.length > 0) await daemons.pop()?.stop()
  while (servers.length > 0) {
    const server = servers.pop()
    await new Promise<void>((resolve) => {
      server?.closeAllConnections?.()
      server?.close(() => resolve())
    })
  }
  rmSync(dir, { recursive: true, force: true })
})

async function startTracked(): Promise<DaemonHandle> {
  const handle = await startDaemon({ dir, port: 0 })
  daemons.push(handle)
  return handle
}

/* -------------------------------------------------------------------------- */

describe('lockfile', () => {
  test('acquiring writes a 0600 lockfile', () => {
    const lock = acquireDaemonLock({ dir })
    expect(lock).not.toBeNull()
    expect(lock?.path).toBe(daemonLockPath({ dir }))
    expect(fileMode(daemonLockPath({ dir }))).toBe(DAEMON_FILE_MODE)
    lock?.release()
  })

  test('a second acquire while held returns null', () => {
    const first = acquireDaemonLock({ dir })
    const second = acquireDaemonLock({ dir })
    expect(first).not.toBeNull()
    expect(second).toBeNull()
    first?.release()
  })

  test('releasing frees the lock and removes the file', () => {
    const first = acquireDaemonLock({ dir })
    first?.release()
    expect(fileMode(daemonLockPath({ dir }))).toBeNull()

    const second = acquireDaemonLock({ dir })
    expect(second).not.toBeNull()
    second?.release()
  })

  test('release is idempotent', () => {
    const lock = acquireDaemonLock({ dir })
    lock?.release()
    lock?.release()
    expect(acquireDaemonLock({ dir })).not.toBeNull()
  })

  test('a lock from a dead process is reclaimed', () => {
    // pid 2^22 is above the default max on both Linux and macOS.
    writeSecretFile(
      daemonLockPath({ dir }),
      JSON.stringify({ pid: 4_194_303, startedAt: Date.now() }),
    )
    const lock = acquireDaemonLock({ dir })
    expect(lock).not.toBeNull()
    lock?.release()
  })

  test('a stale lock from a live process is reclaimed after the timeout', () => {
    writeSecretFile(
      daemonLockPath({ dir }),
      JSON.stringify({ pid: process.pid, startedAt: Date.now() - 120_000 }),
    )
    expect(acquireDaemonLock({ dir, staleMs: 60_000 })).not.toBeNull()
  })

  test('a fresh lock from a live process is respected', () => {
    writeSecretFile(
      daemonLockPath({ dir }),
      JSON.stringify({ pid: process.pid, startedAt: Date.now() }),
    )
    expect(acquireDaemonLock({ dir, staleMs: 60_000 })).toBeNull()
  })

  test('a corrupt lockfile is reclaimed rather than wedging auto-start forever', () => {
    writeSecretFile(daemonLockPath({ dir }), 'not json at all')
    const lock = acquireDaemonLock({ dir })
    expect(lock).not.toBeNull()
    lock?.release()
  })

  test('exactly one of several concurrent OS processes wins the lock', async () => {
    const script = join(dir, 'race.ts')
    writeFileSync(
      script,
      [
        `import { acquireDaemonLock } from ${JSON.stringify(join(HERE, 'autostart.ts'))}`,
        `const lock = acquireDaemonLock({ dir: process.env.GIWACARD_TEST_HOME })`,
        `process.stdout.write(lock ? 'ACQUIRED' : 'BLOCKED')`,
        // Hold the lock while the other processes make their attempt, so no one
        // can win merely by arriving after the previous winner exited.
        `if (lock) await new Promise((r) => setTimeout(r, 1500))`,
      ].join('\n'),
    )

    const results = await Promise.all(
      Array.from({ length: 3 }, () =>
        new Promise<string>((resolve, reject) => {
          const child = spawn(process.execPath, [script], {
            env: { ...process.env, GIWACARD_TEST_HOME: dir },
            stdio: ['ignore', 'pipe', 'pipe'],
          })
          let out = ''
          let err = ''
          child.stdout.on('data', (chunk: Buffer) => (out += chunk.toString()))
          child.stderr.on('data', (chunk: Buffer) => (err += chunk.toString()))
          child.on('error', reject)
          child.on('close', (code) =>
            code === 0 ? resolve(out.trim()) : reject(new Error(err || `exit ${code}`)),
          )
        }),
      ),
    )

    expect(results.filter((r) => r === 'ACQUIRED')).toHaveLength(1)
    expect(results.filter((r) => r === 'BLOCKED')).toHaveLength(2)
  }, 30_000)
})

describe('probe', () => {
  test('returns null when nothing is listening', async () => {
    expect(await probeDaemon('http://127.0.0.1:1', { timeoutMs: 500 })).toBeNull()
  })

  test('recognises a running giwacard daemon', async () => {
    const daemon = await startTracked()
    const health = await probeDaemon(daemon.url)
    expect(health?.service).toBe('giwacard-daemon')
    expect(health?.pid).toBe(process.pid)
  })

  test('needs no token, so it works before the caller has read one', async () => {
    const daemon = await startTracked()
    rmSync(daemonTokenPath({ dir }), { force: true })
    expect(await probeDaemon(daemon.url)).not.toBeNull()
  })

  test('refuses to adopt some other service holding the port', async () => {
    const server = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ service: 'something-else', status: 'ok' }))
    })
    servers.push(server)
    await new Promise<void>((resolve) =>
      server.listen({ host: '127.0.0.1', port: 0 }, () => resolve()),
    )
    const { port } = server.address() as { port: number }
    expect(await probeDaemon(`http://127.0.0.1:${port}`)).toBeNull()
  })

  test('gives up rather than hanging on a socket that never answers', async () => {
    const server = createServer(() => {
      /* never responds */
    })
    servers.push(server)
    await new Promise<void>((resolve) =>
      server.listen({ host: '127.0.0.1', port: 0 }, () => resolve()),
    )
    const { port } = server.address() as { port: number }
    const started = Date.now()
    expect(
      await probeDaemon(`http://127.0.0.1:${port}`, { timeoutMs: 200 }),
    ).toBeNull()
    expect(Date.now() - started).toBeLessThan(3_000)
  })
})

describe('runtime discovery', () => {
  test('reads back the port and token a running daemon published', async () => {
    const daemon = await startTracked()
    expect(readDaemonInfo({ dir })?.port).toBe(daemon.port)
    expect(readDaemonInfo({ dir })?.url).toBe(daemon.url)
    expect(readDaemonToken({ dir })).toBe(daemon.token)
  })

  test('returns null when no daemon has ever run', () => {
    expect(readDaemonInfo({ dir })).toBeNull()
    expect(readDaemonToken({ dir })).toBeNull()
  })

  test('treats a corrupt or half-written info file as "no daemon"', () => {
    writeSecretFile(daemonInfoPath({ dir }), '{"pid":')
    expect(readDaemonInfo({ dir })).toBeNull()
    writeSecretFile(daemonInfoPath({ dir }), '{"pid": 1}')
    expect(readDaemonInfo({ dir })).toBeNull()
  })

  test('clearDaemonRuntimeFiles removes every runtime artefact', async () => {
    const daemon = await startTracked()
    acquireDaemonLock({ dir })
    clearDaemonRuntimeFiles({ dir })
    expect(fileMode(daemonInfoPath({ dir }))).toBeNull()
    expect(fileMode(daemonTokenPath({ dir }))).toBeNull()
    expect(fileMode(daemonLockPath({ dir }))).toBeNull()
    expect(daemon.port).toBeGreaterThan(0)
  })
})

describe('ensureDaemonRunning', () => {
  test('adopts an already-running daemon without launching anything', async () => {
    const daemon = await startTracked()
    let launches = 0

    const connection = await ensureDaemonRunning({
      dir,
      launch: () => {
        launches++
      },
    })

    expect(launches).toBe(0)
    expect(connection.started).toBe(false)
    expect(connection.url).toBe(daemon.url)
    expect(connection.token).toBe(daemon.token)
    expect(connection.pid).toBe(process.pid)
  })

  test('two concurrent callers produce exactly one daemon', async () => {
    let launches = 0
    const launch = async () => {
      launches++
      daemons.push(await startDaemon({ dir, port: 0 }))
    }

    const [first, second] = await Promise.all([
      ensureDaemonRunning({ dir, launch, pollIntervalMs: 10, timeoutMs: 10_000 }),
      ensureDaemonRunning({ dir, launch, pollIntervalMs: 10, timeoutMs: 10_000 }),
    ])

    expect(launches).toBe(1)
    expect(daemons).toHaveLength(1)
    expect(first.url).toBe(second.url)
    expect(first.token).toBe(second.token)
    // Exactly one caller may claim to have started it.
    expect([first.started, second.started].filter(Boolean)).toHaveLength(1)
  })

  test('five concurrent callers still produce exactly one daemon', async () => {
    let launches = 0
    const launch = async () => {
      launches++
      daemons.push(await startDaemon({ dir, port: 0 }))
    }

    const connections = await Promise.all(
      Array.from({ length: 5 }, () =>
        ensureDaemonRunning({ dir, launch, pollIntervalMs: 10, timeoutMs: 10_000 }),
      ),
    )

    expect(launches).toBe(1)
    expect(new Set(connections.map((c) => c.url)).size).toBe(1)
    expect(connections.filter((c) => c.started)).toHaveLength(1)
  })

  test('releases the lock afterwards, so a later call can start again', async () => {
    const launch = async () => {
      daemons.push(await startDaemon({ dir, port: 0 }))
    }
    await ensureDaemonRunning({ dir, launch, pollIntervalMs: 10 })
    expect(fileMode(daemonLockPath({ dir }))).toBeNull()
  })

  test('starts a daemon when the published info points at a dead port', async () => {
    // Leftovers from a daemon that died without cleaning up.
    writeSecretFile(
      daemonInfoPath({ dir }),
      JSON.stringify({ pid: 1, port: 1, hostname: '127.0.0.1', url: 'http://127.0.0.1:1' }),
    )
    writeSecretFile(daemonTokenPath({ dir }), 'stale-token\n')

    let launches = 0
    const connection = await ensureDaemonRunning({
      dir,
      probeTimeoutMs: 300,
      pollIntervalMs: 10,
      launch: async () => {
        launches++
        daemons.push(await startDaemon({ dir, port: 0 }))
      },
    })

    expect(launches).toBe(1)
    expect(connection.started).toBe(true)
    expect(connection.token).not.toBe('stale-token')
  })

  test('times out with a typed error when the daemon never comes up', async () => {
    await expect(
      ensureDaemonRunning({
        dir,
        timeoutMs: 250,
        pollIntervalMs: 20,
        probeTimeoutMs: 50,
        launch: () => {
          /* deliberately starts nothing */
        },
      }),
    ).rejects.toThrow(DaemonStartTimeoutError)
  })

  test('the lock is released even when start times out', async () => {
    await ensureDaemonRunning({
      dir,
      timeoutMs: 200,
      pollIntervalMs: 20,
      probeTimeoutMs: 50,
      launch: () => {},
    }).catch(() => undefined)

    expect(fileMode(daemonLockPath({ dir }))).toBeNull()
  })

  test('the launch context carries the port and home the child should use', async () => {
    const seen: DaemonLaunchContext[] = []
    await ensureDaemonRunning({
      dir,
      port: 45999,
      pollIntervalMs: 10,
      command: ['echo', 'noop'],
      launch: async (context) => {
        seen.push(context)
        daemons.push(await startDaemon({ dir, port: 0 }))
      },
    })

    expect(seen).toHaveLength(1)
    expect(seen[0]?.port).toBe(45999)
    expect(seen[0]?.home).toBe(dir)
    expect(seen[0]?.dir).toBe(dir)
    expect(seen[0]?.command).toEqual(['echo', 'noop'])
  })
})

describe('real spawn (the path U5/U7 take)', () => {
  test('spawns a detached daemon process and adopts it on the next call', async () => {
    // `--port 0` lets the child pick a free port and publish it, so the test
    // cannot collide with anything already listening.
    const first = await ensureDaemonRunning({
      dir,
      port: 0,
      timeoutMs: 25_000,
      pollIntervalMs: 100,
    })

    try {
      expect(first.started).toBe(true)
      // A genuinely separate OS process, not this one.
      expect(first.pid).not.toBe(process.pid)
      expect(first.pid).toBeGreaterThan(0)
      expect(first.token).toMatch(/^[0-9a-f]{64}$/)

      const second = await ensureDaemonRunning({ dir, port: 0 })
      expect(second.started).toBe(false)
      expect(second.pid).toBe(first.pid)
      expect(second.url).toBe(first.url)
    } finally {
      try {
        process.kill(first.pid, 'SIGTERM')
      } catch {
        // already gone
      }
    }
  }, 30_000)
})

describe('spawn command resolution', () => {
  test('finds this repo CLI entry point', () => {
    const entry = resolveCliEntry()
    expect(entry).not.toBeNull()
    expect(entry).toMatch(/cli\.(ts|js)$/)
  })

  test('defaults to running the CLI daemon subcommand on this runtime', () => {
    const command = defaultDaemonCommand(1234)
    expect(command[0]).toBe(process.execPath)
    expect(command).toContain('daemon')
    expect(command.slice(-2)).toEqual(['--port', '1234'])
  })

  test('honours $GIWACARD_DAEMON_COMMAND', () => {
    const previous = process.env['GIWACARD_DAEMON_COMMAND']
    process.env['GIWACARD_DAEMON_COMMAND'] = 'bunx giwacard daemon'
    try {
      expect(defaultDaemonCommand(99)).toEqual([
        'bunx',
        'giwacard',
        'daemon',
        '--port',
        '99',
      ])
    } finally {
      if (previous === undefined) delete process.env['GIWACARD_DAEMON_COMMAND']
      else process.env['GIWACARD_DAEMON_COMMAND'] = previous
    }
  })
})
