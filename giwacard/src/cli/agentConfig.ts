import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { randomBytes } from 'node:crypto'
import { homedir, platform } from 'node:os'
import { dirname, join } from 'node:path'

import { KEYSTORE_FILE_MODE } from '../chain/keystore.js'
import { CliError } from './errors.js'

/**
 * Step 8 of the wizard: register the giwacard MCP server with the agent host.
 *
 * All three supported hosts use the same `mcpServers` object, so the only real
 * differences are where the file lives and what else is in it. The write is
 * therefore a **merge**, never a replace: these files hold the user's other MCP
 * servers, and clobbering them to add ours would be an unforgivable way to
 * introduce yourself.
 *
 * ## The passphrase question
 *
 * `giwacard mcp` needs `$GIWACARD_PASSPHRASE` to unseal the keystore, and an
 * agent host launches its servers from a config file, so the only way to make it
 * work unattended is to put the passphrase in that file — in plaintext, in a
 * file that is usually world-readable and frequently committed to dotfile repos.
 *
 * KTD-15 says the passphrase is never persisted, so this module never writes it
 * unless the user is asked and says yes ({@link WriteAgentConfigInput.passphrase}
 * is only ever populated from an explicit prompt). When it is omitted the config
 * is still written and the user is told to export the variable themselves. A
 * server that needs one environment variable is a solvable problem; a passphrase
 * silently copied into `~/.cursor/mcp.json` is not.
 */

/** The agent hosts the wizard can configure. */
export const AGENT_HOSTS = ['claude', 'cursor', 'gemini'] as const

/** One supported agent host. */
export type AgentHostId = (typeof AGENT_HOSTS)[number]

/** Key under which every supported host stores its MCP servers. */
export const MCP_SERVERS_KEY = 'mcpServers' as const

/** The name giwacard registers itself under. */
export const MCP_SERVER_ENTRY_NAME = 'giwacard' as const

/** Metadata for one host: its label and where its config file lives. */
export interface AgentHostDescriptor {
  id: AgentHostId
  label: string
  /** Absolute path of the config file on this platform. */
  configPath: string
  /** What the user should be told about this file. */
  note: string
}

/**
 * Resolve a host's config path for the current platform.
 *
 * Claude Desktop is the only one that moves: macOS keeps it under
 * `Application Support`, Windows under `%APPDATA%`, Linux under `~/.config`.
 * Cursor and the Gemini CLI both use a stable dot-directory in `$HOME`.
 */
export function agentHostDescriptor(
  id: AgentHostId,
  options: {
    home?: string
    platform?: NodeJS.Platform
    env?: Record<string, string | undefined>
  } = {},
): AgentHostDescriptor {
  const home = options.home ?? homedir()
  const os = options.platform ?? platform()
  const env = options.env ?? process.env

  switch (id) {
    case 'claude': {
      const path =
        os === 'darwin'
          ? join(
              home,
              'Library',
              'Application Support',
              'Claude',
              'claude_desktop_config.json',
            )
          : os === 'win32'
            ? join(
                env['APPDATA'] ?? join(home, 'AppData', 'Roaming'),
                'Claude',
                'claude_desktop_config.json',
              )
            : join(home, '.config', 'Claude', 'claude_desktop_config.json')
      return {
        id,
        label: 'Claude Desktop',
        configPath: path,
        note: 'Restart Claude Desktop for it to pick up the new server.',
      }
    }
    case 'cursor':
      return {
        id,
        label: 'Cursor',
        configPath: join(home, '.cursor', 'mcp.json'),
        note: 'Cursor reloads MCP servers from Settings > MCP.',
      }
    case 'gemini':
      return {
        id,
        label: 'Gemini CLI',
        configPath: join(home, '.gemini', 'settings.json'),
        note: 'The next `gemini` invocation picks up the new server.',
      }
  }
}

/** All three descriptors, for the wizard's host picker. */
export function allAgentHosts(
  options: Parameters<typeof agentHostDescriptor>[1] = {},
): AgentHostDescriptor[] {
  return AGENT_HOSTS.map((id) => agentHostDescriptor(id, options))
}

/** The `mcpServers` entry giwacard writes. */
export interface McpServerEntry {
  command: string
  args: string[]
  env: Record<string, string>
}

export interface BuildMcpEntryInput {
  vaultAddress: string
  vaultOwner: string
  merchants?: readonly string[]
  agentLabel?: string
  rpcUrl?: string | undefined
  /** giwacard home, when it is not the default `~/.giwacard`. */
  home?: string | undefined
  /**
   * Keystore passphrase, only when the user explicitly opted in to storing it.
   * Omit and the server is configured but will report `NOT_CONFIGURED` until the
   * variable is present in the host's environment.
   */
  passphrase?: string | undefined
}

/**
 * Build the server entry.
 *
 * `npx -y giwacard mcp` rather than an absolute path: the host may outlive this
 * checkout, and KTD-1's whole distribution story is `npx giwacard`.
 */
export function buildMcpServerEntry(
  input: BuildMcpEntryInput,
): McpServerEntry {
  const env: Record<string, string> = {
    GIWACARD_VAULT_ADDRESS: input.vaultAddress,
    GIWACARD_VAULT_OWNER: input.vaultOwner,
  }
  if (input.merchants && input.merchants.length > 0) {
    env['GIWACARD_MERCHANTS'] = input.merchants.join(',')
  }
  if (input.agentLabel) env['GIWACARD_AGENT_LABEL'] = input.agentLabel
  if (input.rpcUrl) env['GIWACARD_RPC_URL'] = input.rpcUrl
  if (input.home) env['GIWACARD_HOME'] = input.home
  if (input.passphrase) env['GIWACARD_PASSPHRASE'] = input.passphrase

  return {
    command: 'npx',
    args: ['-y', 'giwacard', 'mcp'],
    env,
  }
}

/** What {@link writeAgentConfig} did. */
export interface WriteAgentConfigResult {
  host: AgentHostDescriptor
  path: string
  /** True when the file did not exist and was created. */
  created: boolean
  /** True when a `giwacard` entry was already there and got overwritten. */
  replaced: boolean
  /** Other MCP servers left untouched. Proof the merge did not clobber. */
  preservedServers: string[]
  /** True when the passphrase was written into the file. */
  passphraseStored: boolean
}

export interface WriteAgentConfigInput extends BuildMcpEntryInput {
  host: AgentHostDescriptor
  /** Injected by tests. Defaults to the real filesystem. */
  fs?: AgentConfigFs
}

/** The filesystem operations this module needs. Injected in tests. */
export interface AgentConfigFs {
  exists(path: string): boolean
  read(path: string): string
  write(path: string, contents: string): void
  mkdir(path: string): void
}

/** The real filesystem, writing atomically with 0600 on the final file. */
export const realAgentConfigFs: AgentConfigFs = {
  exists: (path) => existsSync(path),
  read: (path) => readFileSync(path, 'utf8'),
  mkdir: (path) => {
    mkdirSync(path, { recursive: true })
  },
  write: (path, contents) => {
    const tmp = `${path}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`
    try {
      writeFileSync(tmp, contents, { mode: KEYSTORE_FILE_MODE })
      chmodSync(tmp, KEYSTORE_FILE_MODE)
      renameSync(tmp, path)
      // 0600 even when the file already existed with looser bits: it may now
      // carry a passphrase the user opted into storing.
      chmodSync(path, KEYSTORE_FILE_MODE)
    } catch (error) {
      if (existsSync(tmp)) rmSync(tmp, { force: true })
      throw error
    }
  },
}

/**
 * Merge the giwacard MCP server into an agent host's config file.
 *
 * @throws {CliError} `INVALID_ARGUMENT` when the existing file is not JSON. The
 * wizard reports it and moves on rather than overwriting a file it cannot parse
 * — a hand-edited config with a trailing comma is still the user's config.
 */
export function writeAgentConfig(
  input: WriteAgentConfigInput,
): WriteAgentConfigResult {
  const io = input.fs ?? realAgentConfigFs
  const path = input.host.configPath

  let existing: Record<string, unknown> = {}
  const created = !io.exists(path)
  if (!created) {
    const raw = io.read(path)
    if (raw.trim() !== '') {
      try {
        const parsed: unknown = JSON.parse(raw)
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
          throw new Error('not an object')
        }
        existing = parsed as Record<string, unknown>
      } catch (cause) {
        throw new CliError(
          'INVALID_ARGUMENT',
          `${input.host.label}'s config at ${path} is not valid JSON, so ` +
            'giwacard will not rewrite it.',
          {
            hint:
              `Fix the JSON (or move the file aside) and re-run \`giwacard init\`. ` +
              'Nothing was changed.',
            cause,
          },
        )
      }
    }
  }

  const currentServersRaw = existing[MCP_SERVERS_KEY]
  const servers: Record<string, unknown> =
    typeof currentServersRaw === 'object' &&
    currentServersRaw !== null &&
    !Array.isArray(currentServersRaw)
      ? { ...(currentServersRaw as Record<string, unknown>) }
      : {}

  const replaced = Object.hasOwn(servers, MCP_SERVER_ENTRY_NAME)
  const preservedServers = Object.keys(servers).filter(
    (name) => name !== MCP_SERVER_ENTRY_NAME,
  )

  servers[MCP_SERVER_ENTRY_NAME] = buildMcpServerEntry(input)

  const next = { ...existing, [MCP_SERVERS_KEY]: servers }

  if (created) io.mkdir(dirname(path))
  io.write(path, `${JSON.stringify(next, null, 2)}\n`)

  return {
    host: input.host,
    path,
    created,
    replaced,
    preservedServers,
    passphraseStored: Boolean(input.passphrase),
  }
}

/**
 * What to tell the user after writing a config without the passphrase.
 *
 * A named export because it is the compensating instruction for a deliberate
 * omission — if this text ever stops being printed, the default setup silently
 * produces an MCP server that cannot open its own keystore.
 */
export function passphraseInstructions(host: AgentHostDescriptor): string {
  return [
    `The giwacard MCP server needs your keystore passphrase to sign as the`,
    `session key. It was NOT written into ${host.configPath}.`,
    '',
    `Export it in the environment ${host.label} launches from:`,
    '',
    '  export GIWACARD_PASSPHRASE=...',
    '',
    'Or re-run `giwacard init` and answer yes when asked to store it.',
  ].join('\n')
}
