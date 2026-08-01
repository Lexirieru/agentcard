import { getAddress, isAddress, type Address } from 'viem'
import { z } from 'zod'

import type { GiwaCardMcpContext } from '../context.js'
import {
  McpToolError,
  toErrorPayload,
  toMcpError,
  type McpErrorPayload,
} from '../errors.js'
import { redact, redactSecrets } from '../redact.js'

/**
 * The shape every GiwaCard MCP tool is defined in, and the single place a tool
 * result is allowed to become an MCP payload.
 *
 * Every tool goes through {@link runTool}, which does three things no individual
 * tool is trusted to remember:
 *
 * 1. Funnels every thrown value through {@link toMcpError}, so a failure is
 *    always a stable code with an actionable message and never a stack.
 * 2. Runs both redaction layers over the result — success *and* failure alike.
 *    An error message is text an agent reads, so it is exactly as capable of
 *    leaking a key as a success payload, and historically more likely to.
 * 3. Serialises the redacted object into the text block, so the text an agent
 *    reads and the structured content it parses can never disagree.
 *
 * A tool that wants to bypass any of this has to not be a tool.
 */

/** A tool's business logic: validated args in, plain JSON-ish result out. */
export type ToolHandler<Args> = (
  args: Args,
  context: GiwaCardMcpContext,
) => Promise<unknown>

/** MCP behaviour hints. `readOnlyHint` here means "sends no transaction". */
export interface ToolAnnotations {
  readOnlyHint?: boolean
  destructiveHint?: boolean
  idempotentHint?: boolean
  openWorldHint?: boolean
}

/**
 * A tool, ready to bind to an `McpServer`.
 *
 * Deliberately **not** generic in its argument type. A registry of tools with
 * six different argument types has no useful common supertype — `Args` appears
 * in the handler's parameter position, which makes the type invariant, and
 * every attempt to store them together collapses into `never` or `any`. Erasing
 * the argument type once, at the {@link defineTool} boundary where the schema
 * and the handler are still visibly matched, is both safer and far less noisy
 * than propagating the generic through the registry and the server.
 */
export interface ToolDefinition {
  /** Wire name (snake_case), exactly as R7 lists it. */
  name: string
  title: string
  description: string
  inputSchema: z.ZodType
  annotations?: ToolAnnotations
  /** Args arrive already validated against `inputSchema` by the SDK. */
  handler: ToolHandler<unknown>
}

/**
 * Define a tool with its argument type inferred from its schema.
 *
 * The single cast below is the whole erasure: inside `definition.handler` the
 * argument is fully typed from `Schema`, and the SDK guarantees the value has
 * been validated against that same schema before the handler runs.
 */
export function defineTool<Schema extends z.ZodType>(definition: {
  name: string
  title: string
  description: string
  inputSchema: Schema
  annotations?: ToolAnnotations
  handler: ToolHandler<z.infer<Schema>>
}): ToolDefinition {
  return {
    name: definition.name,
    title: definition.title,
    description: definition.description,
    inputSchema: definition.inputSchema,
    ...(definition.annotations ? { annotations: definition.annotations } : {}),
    handler: (args, context) =>
      definition.handler(args as z.infer<Schema>, context),
  }
}

/**
 * The MCP `CallToolResult` subset this package emits.
 *
 * A `type` rather than an `interface` on purpose: the SDK's result type carries
 * an index signature, and TypeScript only gives implicit index signatures to
 * type aliases. As an interface this is not assignable to `CallToolResult`.
 */
export type ToolResult = {
  content: { type: 'text'; text: string }[]
  structuredContent: Record<string, unknown>
  isError?: boolean
}

/** Wrap a successful payload so every result has the same `ok` discriminator. */
function successEnvelope(value: unknown): Record<string, unknown> {
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    return { ok: true, ...(value as Record<string, unknown>) }
  }
  return { ok: true, result: value }
}

/**
 * Render any payload as a redacted MCP tool result.
 *
 * Exported so tests can assert the exact bytes an agent would receive.
 */
export function toToolResult(
  payload: Record<string, unknown> | McpErrorPayload,
  isError = false,
): ToolResult {
  const structured = redact(payload) as Record<string, unknown>
  // The text block is serialized from the already-redacted object and then
  // swept again: cheap, idempotent, and it closes the gap where a value only
  // looks key-shaped once it has been stringified.
  const text = redactSecrets(JSON.stringify(structured, null, 2))
  return {
    content: [{ type: 'text', text }],
    structuredContent: structured,
    ...(isError ? { isError: true } : {}),
  }
}

/**
 * Execute a tool's handler and turn whatever happens into a redacted result.
 *
 * Never throws: an MCP tool that throws gives the agent a protocol error with
 * no code to branch on, which is the one outcome the taxonomy exists to avoid.
 */
export async function runTool(
  definition: ToolDefinition,
  args: unknown,
  context: GiwaCardMcpContext,
): Promise<ToolResult> {
  try {
    const payload = await definition.handler(args, context)
    return toToolResult(successEnvelope(payload))
  } catch (error) {
    const mapped = toMcpError(error, {
      sessionKey: context.sessionClient.account.address,
    })
    return toToolResult(toErrorPayload(mapped), true)
  }
}

/* -------------------------------------------------------------------------- */
/* Shared input parsing                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Amounts cross the wire as decimal strings, never as JSON numbers.
 *
 * A gUSD amount in base units routinely exceeds `Number.MAX_SAFE_INTEGER`, and
 * a silently-rounded cap is a spend bug, not a display bug.
 */
export const amountSchema = z
  .string()
  .regex(/^\d+$/, 'expected a decimal integer string in token base units')

/** A 0x-prefixed 20-byte address, checksummed on the way in. */
export const addressSchema = z
  .string()
  .refine((value) => isAddress(value), 'expected a 0x-prefixed EVM address')

/** Card ids are `uint256`; they cross the wire as decimal strings too. */
export const cardIdSchema = z
  .string()
  .regex(/^\d+$/, 'expected a decimal card id')

/** Parse a validated decimal string into a positive `bigint`. */
export function parseAmount(value: string, field: string): bigint {
  const parsed = BigInt(value)
  if (parsed <= 0n) {
    throw new McpToolError(
      'INVALID_REQUEST',
      `${field} must be greater than zero.`,
      { details: { field } },
    )
  }
  return parsed
}

/** Normalise a validated address to its checksummed form. */
export function parseAddress(value: string): Address {
  return getAddress(value)
}
