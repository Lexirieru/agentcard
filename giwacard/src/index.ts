/**
 * `giwacard` — agent-native virtual cards on GIWA Sepolia.
 *
 * This is the library surface. The CLI (`giwacard`) and the two long-running
 * services — the approval daemon (`giwacard daemon`) and the MCP server
 * (`giwacard mcp`) — are built on top of it.
 */

export * from './chain/giwaSepolia.js'
export * from './chain/clients.js'
export * from './chain/keystore.js'
export * from './chain/cardVaultAbi.js'
export * from './daemon/index.js'
export * from './mcp/index.js'
export { VERSION } from './version.js'
