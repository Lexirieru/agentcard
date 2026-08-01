import { describe, expect, test } from 'bun:test'

import {
  agentHostDescriptor,
  AGENT_HOSTS,
  allAgentHosts,
  buildMcpServerEntry,
  DEFAULT_AGENT_HOST,
  MCP_SERVER_ENTRY_NAME,
  MCP_SERVERS_KEY,
  passphraseInstructions,
  resolveAgentHostId,
  writeAgentConfig,
  type AgentConfigFs,
} from './agentConfig.js'
import { CliError } from './errors.js'

const VAULT = '0x1111111111111111111111111111111111111111'
const OWNER = '0x2222222222222222222222222222222222222222'
const MERCHANT = '0x3333333333333333333333333333333333333333'

/** An in-memory filesystem, so no test writes to a real dotfile. */
function memoryFs(seed: Record<string, string> = {}): AgentConfigFs & {
  files: Record<string, string>
} {
  const files: Record<string, string> = { ...seed }
  return {
    files,
    exists: (path) => Object.hasOwn(files, path),
    read: (path) => files[path] ?? '',
    write: (path, contents) => {
      files[path] = contents
    },
    mkdir: () => {},
  }
}

describe('host descriptors', () => {
  test('covers both Claudes, cursor and gemini', () => {
    expect(AGENT_HOSTS).toEqual([
      'claude-code',
      'claude-desktop',
      'cursor',
      'gemini',
    ])
    expect(allAgentHosts({ home: '/home/u', platform: 'linux' })).toHaveLength(4)
  })

  test('claude desktop moves per platform', () => {
    expect(
      agentHostDescriptor('claude-desktop', { home: '/home/u', platform: 'darwin' })
        .configPath,
    ).toContain('Library/Application Support/Claude')
    expect(
      agentHostDescriptor('claude-desktop', { home: '/home/u', platform: 'linux' })
        .configPath,
    ).toContain('.config/Claude')
    expect(
      agentHostDescriptor('claude-desktop', {
        home: 'C:\\u',
        platform: 'win32',
        env: { APPDATA: 'C:\\u\\AppData\\Roaming' },
      }).configPath,
    ).toContain('Claude')
  })

  test('claude code is per project, not per user', () => {
    // The whole point of splitting the hosts: this is a different file from
    // Claude Desktop's, and it does not live in $HOME.
    const code = agentHostDescriptor('claude-code', {
      home: '/home/u',
      platform: 'linux',
      cwd: '/work/project',
    })
    expect(code.configPath).toBe('/work/project/.mcp.json')
    expect(code.label).toBe('Claude Code')
    expect(code.configPath).not.toBe(
      agentHostDescriptor('claude-desktop', { home: '/home/u', platform: 'linux' })
        .configPath,
    )
  })

  test('cursor and gemini use stable dot-directories', () => {
    expect(
      agentHostDescriptor('cursor', { home: '/home/u', platform: 'linux' }).configPath,
    ).toBe('/home/u/.cursor/mcp.json')
    expect(
      agentHostDescriptor('gemini', { home: '/home/u', platform: 'linux' }).configPath,
    ).toBe('/home/u/.gemini/settings.json')
  })
})

describe('resolveAgentHostId', () => {
  test('accepts every supported id, case- and space-insensitively', () => {
    for (const id of AGENT_HOSTS) {
      expect(resolveAgentHostId(id)).toBe(id)
      expect(resolveAgentHostId(` ${id.toUpperCase()} `)).toBe(id)
    }
  })

  test('refuses bare "claude" and names both files', () => {
    // Guessing here is the original bug: a Claude Code user was silently given
    // Claude Desktop's config and a server their agent never saw.
    let thrown: unknown
    try {
      resolveAgentHostId('claude')
    } catch (error) {
      thrown = error
    }
    expect(thrown).toBeInstanceOf(CliError)
    const message = (thrown as CliError).message
    expect(message).toContain('ambiguous')
    expect(message).toContain('claude-code')
    expect(message).toContain('claude-desktop')
    expect(message).toContain('.mcp.json')
    expect(message).toContain('claude_desktop_config.json')
  })

  test('an unknown host lists the supported ones', () => {
    const error = (() => {
      try {
        resolveAgentHostId('emacs')
      } catch (caught) {
        return caught as CliError
      }
      throw new Error('expected a CliError')
    })()
    expect(error.code).toBe('INVALID_ARGUMENT')
    expect(error.hint).toContain('claude-code, claude-desktop, cursor, gemini')
  })

  test('the unattended default is a real host id', () => {
    expect(AGENT_HOSTS).toContain(DEFAULT_AGENT_HOST)
  })
})

describe('the server entry', () => {
  test('launches through npx and carries the vault environment', () => {
    const entry = buildMcpServerEntry({
      vaultAddress: VAULT,
      vaultOwner: OWNER,
      merchants: [MERCHANT],
      agentLabel: 'giwacard-agent',
    })
    expect(entry.command).toBe('npx')
    expect(entry.args).toEqual(['-y', 'giwacard', 'mcp'])
    expect(entry.env['GIWACARD_VAULT_ADDRESS']).toBe(VAULT)
    expect(entry.env['GIWACARD_VAULT_OWNER']).toBe(OWNER)
    expect(entry.env['GIWACARD_MERCHANTS']).toBe(MERCHANT)
  })

  test('omits the passphrase unless one is explicitly supplied (KTD-15)', () => {
    const withoutIt = buildMcpServerEntry({ vaultAddress: VAULT, vaultOwner: OWNER })
    expect(withoutIt.env['GIWACARD_PASSPHRASE']).toBeUndefined()

    const withIt = buildMcpServerEntry({
      vaultAddress: VAULT,
      vaultOwner: OWNER,
      passphrase: 'hunter2hunter2',
    })
    expect(withIt.env['GIWACARD_PASSPHRASE']).toBe('hunter2hunter2')
  })
})

describe('writing the config', () => {
  const host = agentHostDescriptor('cursor', { home: '/home/u', platform: 'linux' })

  test('creates the file when there is none', () => {
    const fs = memoryFs()
    const result = writeAgentConfig({
      host,
      vaultAddress: VAULT,
      vaultOwner: OWNER,
      fs,
    })
    expect(result.created).toBe(true)
    expect(result.replaced).toBe(false)
    expect(result.passphraseStored).toBe(false)

    const written = JSON.parse(fs.files[host.configPath] as string) as Record<
      string,
      Record<string, unknown>
    >
    expect(written[MCP_SERVERS_KEY]?.[MCP_SERVER_ENTRY_NAME]).toBeDefined()
  })

  test('merges without clobbering other MCP servers or other top-level keys', () => {
    const fs = memoryFs({
      [host.configPath]: JSON.stringify({
        someOtherSetting: true,
        [MCP_SERVERS_KEY]: {
          filesystem: { command: 'npx', args: ['@x/fs'] },
          github: { command: 'gh-mcp' },
        },
      }),
    })

    const result = writeAgentConfig({
      host,
      vaultAddress: VAULT,
      vaultOwner: OWNER,
      fs,
    })
    expect(result.created).toBe(false)
    expect(result.replaced).toBe(false)
    expect(result.preservedServers.sort()).toEqual(['filesystem', 'github'])

    const written = JSON.parse(fs.files[host.configPath] as string) as Record<
      string,
      unknown
    >
    expect(written['someOtherSetting']).toBe(true)
    expect([...Object.keys(written[MCP_SERVERS_KEY] as object)].sort()).toEqual([
      'filesystem',
      'github',
      'giwacard',
    ])
  })

  test('replacing an existing giwacard entry is reported as such', () => {
    const fs = memoryFs({
      [host.configPath]: JSON.stringify({
        [MCP_SERVERS_KEY]: { giwacard: { command: 'old' } },
      }),
    })
    const result = writeAgentConfig({
      host,
      vaultAddress: VAULT,
      vaultOwner: OWNER,
      fs,
    })
    expect(result.replaced).toBe(true)
    expect(result.preservedServers).toEqual([])
  })

  test('refuses to rewrite a file it cannot parse', () => {
    const fs = memoryFs({ [host.configPath]: '{ this is not json' })
    let thrown: unknown
    try {
      writeAgentConfig({ host, vaultAddress: VAULT, vaultOwner: OWNER, fs })
    } catch (error) {
      thrown = error
    }
    expect(thrown).toBeInstanceOf(CliError)
    expect((thrown as CliError).code).toBe('INVALID_ARGUMENT')
    // The user's file is left exactly as it was.
    expect(fs.files[host.configPath]).toBe('{ this is not json')
  })

  test('an empty existing file is treated as an empty object, not a parse error', () => {
    const fs = memoryFs({ [host.configPath]: '   \n' })
    const result = writeAgentConfig({
      host,
      vaultAddress: VAULT,
      vaultOwner: OWNER,
      fs,
    })
    expect(result.created).toBe(false)
    expect(JSON.parse(fs.files[host.configPath] as string)).toHaveProperty(
      MCP_SERVERS_KEY,
    )
  })

  test('the compensating instruction names the variable and the file', () => {
    const text = passphraseInstructions(host)
    expect(text).toContain('GIWACARD_PASSPHRASE')
    expect(text).toContain(host.configPath)
    expect(text).toContain('NOT written')
  })
})
