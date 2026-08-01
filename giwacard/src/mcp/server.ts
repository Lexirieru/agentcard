import { McpServer } from '@modelcontextprotocol/server'
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio'
import { isAddress, type Address } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'

import { createGiwaPublicClient, createGiwaWalletClient } from '../chain/clients.js'
import { loadKeystore, type Hex } from '../chain/keystore.js'
import { VERSION } from '../version.js'
import { HttpApprovalClient } from './approvals.js'
import type {
  GiwaCardMcpContext,
  VaultPublicClient,
  VaultWalletClient,
} from './context.js'
import { McpToolError, toErrorPayload, toMcpError } from './errors.js'
import { GIWACARD_TOOLS } from './tools/index.js'
import { runTool, toToolResult, type ToolDefinition } from './tools/define.js'

/**
 * `giwacard mcp` — the agent-facing MCP server (KTD-8, R7).
 *
 * ## Transport
 *
 * stdio, and only stdio. The host spawns `npx giwacard mcp` and speaks JSON-RPC
 * over the pipe, which means **stdout is the protocol channel**: a stray
 * `console.log` anywhere under this process corrupts the stream and the host
 * drops the connection. Everything diagnostic goes to stderr. The deprecated
 * HTTP+SSE transport is deliberately not implemented.
 *
 * ## Configuration is lazy
 *
 * The context — keystore, chain clients, daemon connection — is resolved on the
 * first tool call, not at startup, and a failure to resolve it comes back as a
 * `NOT_CONFIGURED` tool error. A server that exits during startup shows up in an
 * MCP host as a dead entry with no explanation; a server that answers every call
 * with "run `giwacard init` and set GIWACARD_VAULT_ADDRESS" tells the agent, and
 * through it the user, exactly what is wrong.
 */

/** How the server obtains its context. Resolved once, then cached. */
export type McpContextProvider =
  | GiwaCardMcpContext
  | (() => GiwaCardMcpContext | Promise<GiwaCardMcpContext>)

export interface CreateMcpServerOptions {
  context: McpContextProvider
  /** Server name reported in `initialize`. */
  name?: string
  version?: string
  /** Override the registered tools. Tests use this; production never should. */
  tools?: readonly ToolDefinition[]
}

/** Name this server reports to an MCP host. */
export const MCP_SERVER_NAME = 'giwacard' as const

function memoize(
  provider: McpContextProvider,
): () => Promise<GiwaCardMcpContext> {
  if (typeof provider !== 'function') {
    const resolved = Promise.resolve(provider)
    return () => resolved
  }
  let cached: Promise<GiwaCardMcpContext> | null = null
  return () => {
    if (cached === null) {
      cached = Promise.resolve(provider()).catch((error: unknown) => {
        // A failed resolve must not be cached: the user may fix the config and
        // retry without restarting the host.
        cached = null
        throw error
      })
    }
    return cached
  }
}

/**
 * Build the MCP server with the R7 tool surface registered.
 *
 * Every tool goes through {@link runTool}, so redaction and the error taxonomy
 * apply uniformly and no handler can opt out of either.
 *
 * @param options.context The runtime context, or a factory resolved on first use.
 * @returns A server ready to `connect()` to a transport.
 */
export function createGiwaCardMcpServer(
  options: CreateMcpServerOptions,
): McpServer {
  const resolveContext = memoize(options.context)
  const server = new McpServer(
    {
      name: options.name ?? MCP_SERVER_NAME,
      version: options.version ?? VERSION,
    },
    { capabilities: { tools: {} } },
  )

  for (const tool of options.tools ?? GIWACARD_TOOLS) {
    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        inputSchema: tool.inputSchema,
        ...(tool.annotations ? { annotations: tool.annotations } : {}),
      },
      async (args: unknown) => {
        let context: GiwaCardMcpContext
        try {
          context = await resolveContext()
        } catch (error) {
          return toToolResult(toErrorPayload(toMcpError(error)), true)
        }
        return runTool(tool, args, context)
      },
    )
  }

  return server
}

/* -------------------------------------------------------------------------- */
/* Context from the environment                                               */
/* -------------------------------------------------------------------------- */

/**
 * Environment the MCP host is expected to pass through.
 *
 * An MCP host launches its servers with a fixed argv and an `env` block, so the
 * environment is the only configuration channel available. `giwacard init` (U7)
 * writes these into the host's config file.
 */
export interface McpEnv {
  /** Deployed `CardVault` proxy address. Required. */
  GIWACARD_VAULT_ADDRESS?: string | undefined
  /** The vault owner whose balance backs the cards. Required. */
  GIWACARD_VAULT_OWNER?: string | undefined
  /** Passphrase that unseals `~/.giwacard/keystore.json`. Required. */
  GIWACARD_PASSPHRASE?: string | undefined
  /** Comma-separated merchants reported by `get_policy`. */
  GIWACARD_MERCHANTS?: string | undefined
  /** Label shown to the owner on approval requests. */
  GIWACARD_AGENT_LABEL?: string | undefined
  /** Dedicated RPC endpoint, if the user has one. */
  GIWACARD_RPC_URL?: string | undefined
  /** Keystore/daemon home. Honoured by the keystore and daemon modules too. */
  GIWACARD_HOME?: string | undefined
  /**
   * Set to `1` to let `cancel_card` submit as the vault owner.
   *
   * Off by default: cancelling is an owner action onchain, and loading the owner
   * key into an agent-facing process widens the blast radius from "one session
   * key's policy" to "the whole vault, including withdrawals".
   */
  GIWACARD_ENABLE_OWNER_ACTIONS?: string | undefined
}

function required(env: McpEnv, key: keyof McpEnv, what: string): string {
  const value = env[key]
  if (value === undefined || value.trim() === '') {
    throw new McpToolError(
      'NOT_CONFIGURED',
      `The giwacard MCP server has no ${what} configured ($${key} is unset). ` +
        'Ask the user to run `giwacard init`, which writes the MCP server ' +
        'config with the right environment.',
      { details: { variable: key } },
    )
  }
  return value.trim()
}

function requiredAddress(env: McpEnv, key: keyof McpEnv, what: string): Address {
  const value = required(env, key, what)
  if (!isAddress(value)) {
    throw new McpToolError(
      'NOT_CONFIGURED',
      `$${key} is not a valid EVM address, so the giwacard MCP server cannot ` +
        'reach the vault. Ask the user to re-run `giwacard init`.',
      { details: { variable: key } },
    )
  }
  return value as Address
}

function parseMerchants(raw: string | undefined): Address[] {
  if (!raw) return []
  return raw
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => isAddress(entry)) as Address[]
}

/**
 * Build the production context: keystore, chain clients, approval daemon.
 *
 * The session private key is read here and handed straight to viem, which keeps
 * it inside the transport's signing path. It is never returned, never logged and
 * never placed in a tool result (KTD-7) — no code path exists from a tool
 * handler back to this value.
 *
 * @throws {McpToolError} `NOT_CONFIGURED` when the environment or keystore is
 * incomplete, phrased for an agent to relay to its user.
 */
export async function createContextFromEnv(
  env: McpEnv = process.env as McpEnv,
): Promise<GiwaCardMcpContext> {
  const vaultAddress = requiredAddress(env, 'GIWACARD_VAULT_ADDRESS', 'vault address')
  const vaultOwner = requiredAddress(env, 'GIWACARD_VAULT_OWNER', 'vault owner')
  const passphrase = required(env, 'GIWACARD_PASSPHRASE', 'keystore passphrase')

  const keystoreOptions = env.GIWACARD_HOME ? { dir: env.GIWACARD_HOME } : {}
  let sessionPrivateKey: Hex | undefined
  let ownerPrivateKey: Hex | undefined
  try {
    const keystore = loadKeystore(passphrase, keystoreOptions)
    sessionPrivateKey = keystore.sessionPrivateKey
    ownerPrivateKey = keystore.ownerPrivateKey
  } catch (error) {
    throw new McpToolError(
      'NOT_CONFIGURED',
      'The giwacard keystore could not be opened. The passphrase in ' +
        '$GIWACARD_PASSPHRASE is wrong, or there is no keystore yet — ask the ' +
        'user to run `giwacard init`.',
      { cause: error },
    )
  }

  if (!sessionPrivateKey) {
    throw new McpToolError(
      'NOT_CONFIGURED',
      'The giwacard keystore has no session key. Ask the user to run ' +
        '`giwacard init` to create and register one.',
    )
  }

  const transport = env.GIWACARD_RPC_URL
    ? { transport: { url: env.GIWACARD_RPC_URL } }
    : {}
  const publicClient = createGiwaPublicClient(transport) as unknown as VaultPublicClient
  const sessionClient = createGiwaWalletClient({
    account: privateKeyToAccount(sessionPrivateKey),
    ...transport,
  }) as unknown as VaultWalletClient

  const ownerEnabled = env.GIWACARD_ENABLE_OWNER_ACTIONS === '1'
  const ownerClient =
    ownerEnabled && ownerPrivateKey
      ? (createGiwaWalletClient({
          account: privateKeyToAccount(ownerPrivateKey),
          ...transport,
        }) as unknown as VaultWalletClient)
      : undefined

  return {
    vaultAddress,
    vaultOwner,
    publicClient,
    sessionClient,
    ownerClient,
    approvals: new HttpApprovalClient(
      env.GIWACARD_HOME ? { daemon: { dir: env.GIWACARD_HOME } } : {},
    ),
    knownMerchants: parseMerchants(env.GIWACARD_MERCHANTS),
    agentLabel: env.GIWACARD_AGENT_LABEL ?? 'mcp-agent',
  }
}

/* -------------------------------------------------------------------------- */
/* `giwacard mcp`                                                             */
/* -------------------------------------------------------------------------- */

export interface RunMcpCommandOptions {
  env?: McpEnv
  /** Injected in tests so no real pipe is opened. */
  transport?: ConstructorParameters<typeof StdioServerTransport> extends never
    ? never
    : Parameters<McpServer['connect']>[0]
  /** Diagnostics sink. Never stdout — that is the protocol channel. */
  stderr?: NodeJS.WritableStream
}

/**
 * Entry point behind `giwacard mcp`.
 *
 * Connects over stdio and resolves when the host closes the connection.
 *
 * @returns The process exit code.
 */
export async function runMcpCommand(
  options: RunMcpCommandOptions = {},
): Promise<number> {
  const stderr = options.stderr ?? process.stderr
  const env = options.env ?? (process.env as McpEnv)

  const server = createGiwaCardMcpServer({
    context: () => createContextFromEnv(env),
  })

  const transport = options.transport ?? new StdioServerTransport()

  try {
    await server.connect(transport)
  } catch (error) {
    stderr.write(
      `giwacard mcp failed to start: ${
        error instanceof Error ? error.message : String(error)
      }\n`,
    )
    return 1
  }

  stderr.write(`giwacard mcp v${VERSION} ready on stdio\n`)

  await new Promise<void>((resolve) => {
    const shutdown = () => {
      process.off('SIGINT', shutdown)
      process.off('SIGTERM', shutdown)
      resolve()
    }
    process.once('SIGINT', shutdown)
    process.once('SIGTERM', shutdown)
    transport.onclose = shutdown
  })

  await server.close()
  return 0
}
