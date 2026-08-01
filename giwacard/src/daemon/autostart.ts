import { spawn } from 'node:child_process'
import { chmodSync, closeSync, existsSync, openSync, writeSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  DAEMON_FILE_MODE,
  daemonInfoPath,
  daemonLockPath,
  daemonTokenPath,
  ensureDaemonHome,
  readSecretFile,
  removeFileIfPresent,
  type DaemonHomeOptions,
} from './db.js'
import { DaemonStartError, DaemonStartTimeoutError } from './errors.js'
import {
  DAEMON_SERVICE_NAME,
  DEFAULT_DAEMON_PORT,
  type DaemonHealth,
  type DaemonInfo,
} from './server.js'

/**
 * On-demand daemon start (KTD-10).
 *
 * The MCP server (U5) and the CLI (U7) both need a daemon and neither should
 * make the user start one by hand. Both may also be invoked at the same instant
 * — an agent tool call and a terminal command — so this must be a real mutex,
 * not a best-effort check.
 *
 * The sequence is: probe, then take an `O_EXCL` lockfile, then **probe again
 * under the lock**, then spawn. `O_EXCL` create is atomic on POSIX and on
 * Windows, which makes the lock the single arbiter across processes; the
 * second probe closes the window where another process finished starting
 * between our first probe and our lock acquisition. Whoever loses the lock does
 * not spawn anything — it waits for the winner's daemon to answer `/health`.
 */

/** How long a lockfile may sit before it is assumed to be from a crashed run. */
export const DEFAULT_LOCK_STALE_MS = 30_000

/** How long to wait for a daemon (ours or someone else's) to answer. */
export const DEFAULT_START_TIMEOUT_MS = 15_000

/** Per-probe HTTP timeout. Short: a healthy local daemon answers instantly. */
export const DEFAULT_PROBE_TIMEOUT_MS = 1_000

/** Poll interval while waiting for a daemon to come up. */
export const DEFAULT_POLL_INTERVAL_MS = 50

/* -------------------------------------------------------------------------- */
/* Runtime files                                                              */
/* -------------------------------------------------------------------------- */

/** Read `~/.giwacard/daemon.json`, or `null` when no daemon has published one. */
export function readDaemonInfo(options: DaemonHomeOptions = {}): DaemonInfo | null {
  const raw = readSecretFile(daemonInfoPath(options))
  if (raw === null) return null
  try {
    const parsed = JSON.parse(raw) as Partial<DaemonInfo>
    if (
      typeof parsed.url !== 'string' ||
      typeof parsed.port !== 'number' ||
      typeof parsed.pid !== 'number'
    ) {
      return null
    }
    return {
      pid: parsed.pid,
      port: parsed.port,
      hostname: parsed.hostname ?? '127.0.0.1',
      url: parsed.url,
      version: parsed.version ?? '0.0.0',
      startedAt: parsed.startedAt ?? 0,
    }
  } catch {
    // A half-written or hand-edited file is treated as "no daemon", not as an
    // error: the caller's next step is to start one anyway.
    return null
  }
}

/** Read the per-session CSRF token, or `null` when there is none. */
export function readDaemonToken(options: DaemonHomeOptions = {}): string | null {
  const raw = readSecretFile(daemonTokenPath(options))
  if (raw === null) return null
  const trimmed = raw.trim()
  return trimmed === '' ? null : trimmed
}

/* -------------------------------------------------------------------------- */
/* Health probe                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Ask a URL whether a giwacard daemon lives there.
 *
 * Returns `null` for anything that is not unambiguously ours — a dead port, a
 * timeout, or some other service that happens to hold the port. Never throws,
 * because "there is nothing there" is a normal outcome on the start path.
 */
export async function probeDaemon(
  url: string,
  options: { timeoutMs?: number } = {},
): Promise<DaemonHealth | null> {
  const controller = new AbortController()
  const timer = setTimeout(
    () => controller.abort(),
    options.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS,
  )
  try {
    const response = await fetch(`${url}/health`, {
      signal: controller.signal,
      headers: { accept: 'application/json' },
    })
    if (!response.ok) return null
    const body = (await response.json()) as Partial<DaemonHealth>
    if (body.service !== DAEMON_SERVICE_NAME) return null
    return {
      service: DAEMON_SERVICE_NAME,
      version: typeof body.version === 'string' ? body.version : '0.0.0',
      pid: typeof body.pid === 'number' ? body.pid : 0,
      status: 'ok',
    }
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

/* -------------------------------------------------------------------------- */
/* Lock                                                                       */
/* -------------------------------------------------------------------------- */

/** A held auto-start lock. Release it in a `finally`. */
export interface DaemonLock {
  path: string
  release(): void
}

interface LockPayload {
  pid: number
  startedAt: number
}

function readLockPayload(path: string): LockPayload | null {
  const raw = readSecretFile(path)
  if (raw === null) return null
  try {
    const parsed = JSON.parse(raw) as Partial<LockPayload>
    if (typeof parsed.pid !== 'number' || typeof parsed.startedAt !== 'number') {
      return null
    }
    return { pid: parsed.pid, startedAt: parsed.startedAt }
  } catch {
    return null
  }
}

/** Whether a pid is still alive. Signal 0 checks without delivering anything. */
function processAlive(pid: number): boolean {
  if (pid <= 0 || pid === process.pid) return pid === process.pid
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    // EPERM means it exists but belongs to someone else — still alive.
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/**
 * Try to take the auto-start lock. Returns `null` if someone else holds it.
 *
 * The lock is an `O_EXCL` create, which is the atomic primitive that makes this
 * safe between processes. A lock whose owner is dead, or which is older than
 * `staleMs`, is reclaimed — otherwise a crash mid-start would wedge auto-start
 * until the user deleted a file they have never heard of.
 */
export function acquireDaemonLock(
  options: DaemonHomeOptions & { staleMs?: number; now?: () => number } = {},
): DaemonLock | null {
  ensureDaemonHome(options)
  const path = daemonLockPath(options)
  const staleMs = options.staleMs ?? DEFAULT_LOCK_STALE_MS
  const now = options.now ?? (() => Date.now())

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(path, 'wx', DAEMON_FILE_MODE)
      try {
        writeSync(
          fd,
          `${JSON.stringify({ pid: process.pid, startedAt: now() } satisfies LockPayload)}\n`,
        )
      } finally {
        closeSync(fd)
      }
      chmodSync(path, DAEMON_FILE_MODE)
      let released = false
      return {
        path,
        release: () => {
          if (released) return
          released = true
          removeFileIfPresent(path)
        },
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      if (attempt === 1) return null

      const payload = readLockPayload(path)
      const stale =
        payload === null ||
        now() - payload.startedAt > staleMs ||
        !processAlive(payload.pid)
      if (!stale) return null
      removeFileIfPresent(path)
    }
  }
  return null
}

/* -------------------------------------------------------------------------- */
/* Ensure running                                                             */
/* -------------------------------------------------------------------------- */

/** A reachable daemon, with everything a caller needs to talk to it. */
export interface DaemonConnection {
  url: string
  port: number
  /** CSRF token from `~/.giwacard/daemon-token`. */
  token: string
  /** Pid the daemon reports for itself. */
  pid: number
  version: string
  /** True when this call is the one that started the daemon. */
  started: boolean
}

/** Context handed to a custom {@link EnsureDaemonOptions.launch}. */
export interface DaemonLaunchContext {
  port: number
  /** Resolved `~/.giwacard`, so a launcher can point the child at the same home. */
  home: string
  dir: string | undefined
  command: readonly string[]
}

export interface EnsureDaemonOptions extends DaemonHomeOptions {
  /** Port the daemon should bind if it has to be started. */
  port?: number
  /** Total budget for "find or start a daemon". */
  timeoutMs?: number
  probeTimeoutMs?: number
  pollIntervalMs?: number
  staleLockMs?: number
  /** Override the spawn. Injected by tests; also lets U5/U7 supervise the child. */
  launch?: (context: DaemonLaunchContext) => void | Promise<void>
  /** Override the spawn argv. Defaults to `<runtime> <cli entry> daemon --port N`. */
  command?: readonly string[]
  /** Extra environment for the spawned daemon. */
  env?: Record<string, string>
  now?: () => number
  sleep?: (ms: number) => Promise<void>
}

const defaultSleep = (ms: number) =>
  new Promise<void>((done) => setTimeout(done, ms))

/**
 * Locate the `giwacard` bin entry to spawn.
 *
 * Two layouts matter: the published package (`dist/index.js` next to
 * `dist/cli.js`) and this repo (`src/daemon/autostart.ts`, with `src/cli.ts` two
 * levels up). Both are probed from this module's own URL so a linked checkout
 * and an installed copy behave the same.
 */
export function resolveCliEntry(): string | null {
  const here = fileURLToPath(import.meta.url)
  const dir = dirname(here)
  const candidates = [
    join(dir, 'cli.js'),
    join(dir, '..', 'cli.js'),
    join(dir, '..', 'cli.ts'),
    join(dir, '..', '..', 'dist', 'cli.js'),
  ]
  for (const candidate of candidates) {
    const full = resolve(candidate)
    if (existsSync(full)) return full
  }
  return null
}

/** The argv auto-start uses when the caller does not supply one. */
export function defaultDaemonCommand(port: number): readonly string[] {
  const fromEnv = process.env['GIWACARD_DAEMON_COMMAND']
  if (fromEnv && fromEnv.trim() !== '') {
    return [...fromEnv.trim().split(/\s+/), '--port', String(port)]
  }
  const entry = resolveCliEntry()
  if (entry === null) {
    throw new DaemonStartError(
      'Could not locate the giwacard CLI entry point to start a daemon. ' +
        'Start it manually with `giwacard daemon`, or set $GIWACARD_DAEMON_COMMAND.',
    )
  }
  return [process.execPath, entry, 'daemon', '--port', String(port)]
}

/**
 * Spawn a detached daemon.
 *
 * Detached with `stdio: 'ignore'` and `unref()`d so the daemon outlives the
 * short-lived CLI/MCP process that happened to need it — the queue has to stay
 * up while the owner walks over to review a request.
 */
function spawnDaemon(context: DaemonLaunchContext, env?: Record<string, string>): void {
  const [command, ...args] = context.command
  if (command === undefined) {
    throw new DaemonStartError('Empty daemon command.')
  }
  const child = spawn(command, args, {
    detached: true,
    stdio: 'ignore',
    env: {
      ...process.env,
      ...(context.dir !== undefined ? { GIWACARD_HOME: context.dir } : {}),
      ...env,
    },
  })
  child.on('error', () => {
    // Swallowed on purpose: the authoritative signal is whether /health starts
    // answering, and an unhandled 'error' event would crash the parent.
  })
  child.unref()
}

/**
 * Return a live daemon, starting one if necessary.
 *
 * Concurrent callers converge on exactly one daemon process: only the holder of
 * the `O_EXCL` lock spawns, and it re-probes under the lock first.
 */
export async function ensureDaemonRunning(
  options: EnsureDaemonOptions = {},
): Promise<DaemonConnection> {
  const homeOptions: DaemonHomeOptions =
    options.dir !== undefined ? { dir: options.dir } : {}
  const port = options.port ?? DEFAULT_DAEMON_PORT
  const timeoutMs = options.timeoutMs ?? DEFAULT_START_TIMEOUT_MS
  const probeTimeoutMs = options.probeTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS
  const now = options.now ?? (() => Date.now())
  const sleep = options.sleep ?? defaultSleep
  const deadline = now() + timeoutMs

  const connect = async (): Promise<DaemonConnection | null> => {
    const info = readDaemonInfo(homeOptions)
    if (info === null) return null
    const token = readDaemonToken(homeOptions)
    if (token === null) return null
    const health = await probeDaemon(info.url, { timeoutMs: probeTimeoutMs })
    if (health === null) return null
    return {
      url: info.url,
      port: info.port,
      token,
      pid: health.pid,
      version: health.version,
      started: false,
    }
  }

  const waitForDaemon = async (): Promise<DaemonConnection | null> => {
    for (;;) {
      const connection = await connect()
      if (connection) return connection
      if (now() >= deadline) return null
      await sleep(pollIntervalMs)
    }
  }

  const existing = await connect()
  if (existing) return existing

  const lock = acquireDaemonLock({
    ...homeOptions,
    ...(options.staleLockMs !== undefined ? { staleMs: options.staleLockMs } : {}),
    ...(options.now !== undefined ? { now: options.now } : {}),
  })

  if (lock === null) {
    // Someone else is mid-start. Do not spawn a second daemon — just wait for
    // theirs. This is the branch that keeps the count at one.
    const connection = await waitForDaemon()
    if (connection) return connection
    throw new DaemonStartTimeoutError(timeoutMs)
  }

  try {
    // Re-probe under the lock: a daemon may have finished starting between our
    // first probe and the moment we took the lock.
    const raced = await connect()
    if (raced) return raced

    const home = ensureDaemonHome(homeOptions)
    const command = options.command ?? defaultDaemonCommand(port)
    const context: DaemonLaunchContext = {
      port,
      home,
      dir: options.dir,
      command,
    }

    if (options.launch) await options.launch(context)
    else spawnDaemon(context, options.env)

    const connection = await waitForDaemon()
    if (connection === null) throw new DaemonStartTimeoutError(timeoutMs)
    return { ...connection, started: true }
  } finally {
    lock.release()
  }
}

/** Remove stale runtime files. Used when a daemon is known to be gone. */
export function clearDaemonRuntimeFiles(options: DaemonHomeOptions = {}): void {
  removeFileIfPresent(daemonInfoPath(options))
  removeFileIfPresent(daemonTokenPath(options))
  removeFileIfPresent(daemonLockPath(options))
}
