/**
 * `giwacard daemon` — the local approval coordinator (KTD-10, KTD-16).
 *
 * An agent whose card request fits its session key's onchain policy just mints.
 * A request that exceeds the policy cannot be minted at all, so it is queued
 * here instead, where the human owner reviews it. Approving produces an owner
 * EIP-712 signature — made by the owner's own client, never by this daemon,
 * which holds no key — and the signature is stored until a mint consumes it.
 *
 * The daemon ships inside the npm package precisely so `npx giwacard` gets a
 * working approval flow with nothing else to install: it is Hono over SQLite,
 * bound to loopback, with its state in the same 0700 `~/.giwacard/` directory as
 * the keystore.
 *
 * ## Layout
 *
 * - `errors.ts`   — typed errors, each carrying an HTTP status.
 * - `db.ts`       — `~/.giwacard` paths, 0600 file discipline, SQLite schema.
 * - `queue.ts`    — the queue itself: create, list, resolve, consume, expiry.
 * - `server.ts`   — Hono routes, Origin + CSRF guards, loopback bind.
 * - `autostart.ts`— port probe + `O_EXCL` lock so U5/U7 can start it on demand.
 */

export * from './errors.js'
export * from './db.js'
export * from './queue.js'
export * from './server.js'
export * from './autostart.js'
