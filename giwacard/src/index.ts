/**
 * `giwacard` — agent-native virtual cards on GIWA Sepolia.
 *
 * This is the library surface. The CLI (`giwacard`), the MCP server and the
 * approval daemon are built on top of it in later units.
 */

export * from './chain/giwaSepolia.js'
export * from './chain/clients.js'
export * from './chain/keystore.js'
export * from './daemon/index.js'
export { VERSION } from './version.js'
