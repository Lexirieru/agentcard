/**
 * Two-layer redaction for everything the MCP server hands back to an agent
 * (KTD-7, R10, R10b).
 *
 * Shape and approach mirror `references/imessage-agent-template/src/lib/redact.ts`
 * (MIT — Copyright (c) the imessage-agent-template authors), which masks card
 * secrets out of tool results before they are added to a model conversation.
 * The threat here is the same one turned inside out: that template stops a card
 * *number* reaching the model; this one stops the *key that spends the card*.
 *
 * ## Why two layers
 *
 * Layer (a), {@link redactFields}, walks a structured result and blanks any
 * value whose *field name* is secret-shaped. It is precise and it is what
 * catches the well-known offenders — `ownerSignature` off a daemon record,
 * `sessionPrivateKey` off a keystore blob.
 *
 * Layer (b), {@link redactSecrets}, is a regex sweep over the *serialized*
 * result. It exists because layer (a) can only see the names it was told about:
 * a key pasted into a free-text `message`, an error whose `cause` stringified a
 * whole config object, a field somebody adds next quarter. Layer (b) does not
 * care where the secret came from — it recognises the shape.
 *
 * Neither layer alone is sufficient, which is the whole point: a denylist fails
 * open on unknown names, and a regex fails open on unknown shapes. Run both,
 * always, via {@link redact}.
 */

/** What every redacted value is replaced with. Stable, so tests can assert it. */
export const REDACTED = '[redacted]' as const

/* -------------------------------------------------------------------------- */
/* Layer (a): field-name denylist                                             */
/* -------------------------------------------------------------------------- */

/**
 * Field names that are secret outright, compared after normalisation
 * ({@link normalizeFieldName} strips `_`, `-` and case).
 *
 * Note what is deliberately *absent*: bare `token`. On a card result `token` is
 * the ERC-20 the card settles in — a public address the agent legitimately
 * needs. The secret-bearing compounds (`daemonToken`, `accessToken`, …) are
 * matched by {@link SECRET_NAME_FRAGMENTS} instead.
 */
export const SECRET_FIELD_NAMES: ReadonlySet<string> = new Set([
  'privatekey',
  'private',
  'ownerprivatekey',
  'sessionprivatekey',
  'secretkey',
  'signingkey',
  'key',
  'sk',
  'mnemonic',
  'seed',
  'seedphrase',
  'passphrase',
  'password',
  'secret',
  'signature',
  'sig',
  'ownersignature',
  'authorization',
  'auth',
  'cookie',
  'ciphertext',
  'keystore',
  'daemontoken',
  'csrftoken',
  'cvv',
  'cvc',
  'pan',
  'cardnumber',
  'xpayment',
])

/**
 * Substrings that make any containing field name secret.
 *
 * Catches the compounds a flat set would miss — `ownerPrivateKey`,
 * `x_api_key`, `refresh_token`, `db_credentials` — without swallowing `token`
 * on its own.
 */
export const SECRET_NAME_FRAGMENTS: readonly string[] = [
  'privatekey',
  'secretkey',
  'signingkey',
  'apikey',
  'accesstoken',
  'refreshtoken',
  'bearertoken',
  'sessiontoken',
  'authtoken',
  'apitoken',
  'credential',
  'passphrase',
  'password',
  'mnemonic',
  'seedphrase',
  'signature',
]

/** Lowercase a field name and drop separators, so `owner_signature` matches. */
export function normalizeFieldName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, '')
}

/** Whether a field name is secret under the denylist. */
export function isSecretFieldName(name: string): boolean {
  const normalized = normalizeFieldName(name)
  if (normalized === '') return false
  if (SECRET_FIELD_NAMES.has(normalized)) return true
  return SECRET_NAME_FRAGMENTS.some((fragment) => normalized.includes(fragment))
}

/**
 * Deep-copy a structured value, replacing every secret-named field's value with
 * {@link REDACTED}.
 *
 * `bigint` is normalised to a decimal string on the way through: JSON cannot
 * carry it, and a tool result that throws on `JSON.stringify` would take the
 * backstop down with it. Cycles are broken with a marker rather than an
 * exception, for the same reason.
 */
export function redactFields<T>(value: T): unknown {
  return redactFieldsInner(value, new WeakSet<object>())
}

function redactFieldsInner(value: unknown, seen: WeakSet<object>): unknown {
  if (value === null || value === undefined) return value
  if (typeof value === 'bigint') return value.toString()
  if (typeof value !== 'object') return value

  if (seen.has(value)) return '[circular]'
  seen.add(value)

  if (Array.isArray(value)) {
    return value.map((entry) => redactFieldsInner(entry, seen))
  }

  // Errors, Dates, Maps and friends have no useful enumerable shape; render
  // them as text so layer (b) still gets a crack at their contents.
  if (value instanceof Date) return value.toISOString()
  if (value instanceof Error) return `${value.name}: ${value.message}`

  const out: Record<string, unknown> = {}
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    out[key] = isSecretFieldName(key)
      ? REDACTED
      : redactFieldsInner(entry, seen)
  }
  return out
}

/* -------------------------------------------------------------------------- */
/* Layer (b): regex backstop over serialized output                           */
/* -------------------------------------------------------------------------- */

/**
 * JSON keys whose 32-byte hex value is a public identifier, not a secret.
 *
 * A private key and a transaction hash are both `0x` + 64 hex; nothing about
 * the *shape* separates them. What separates them is the key they sit under, and
 * because layer (b) runs over JSON the key is still right there in the text. So
 * the backstop redacts every 32-byte hex run *except* one introduced by a name
 * on this list — fail-closed for anything unrecognised.
 */
export const PUBLIC_HASH_FIELD_NAMES: ReadonlySet<string> = new Set([
  'txhash',
  'transactionhash',
  'minttxhash',
  'chargetxhash',
  'blockhash',
  'hash',
  'digest',
  'approvalid',
  'onchainapprovalid',
  'id',
  'root',
  'salt',
  'nonce',
  'topic',
])

/** `0x` followed by exactly 64 hex digits: a private key, or a hash. */
const HEX32_RE = /0x[0-9a-fA-F]{64}\b/g

/** A JSON `"key": "0x<64 hex>"` pair, so the key can vet the value. */
const KEYED_HEX32_RE = /"([A-Za-z0-9_-]+)"(\s*:\s*)"(0x[0-9a-fA-F]{64})"/g

/**
 * A bare 64-hex run with no `0x`: an unprefixed private key, and the exact
 * shape of the daemon's CSRF token (`randomBytes(32).toString('hex')`).
 */
const BARE_HEX32_RE = /\b[0-9a-fA-F]{64}\b/g

/** `0x` + 65 bytes: an ECDSA signature, the one thing R10b must never emit. */
const SIGNATURE_HEX_RE = /0x[0-9a-fA-F]{130}\b/g

/**
 * A BIP-39-shaped run: 12, 15, 18, 21 or 24 lowercase words, spaces only.
 *
 * Deliberately shape-based rather than wordlist-based — the 2048-word list is
 * ~15 KB that would ship inside `npx giwacard` to catch a case the denylist
 * already covers by name. Prose in a tool result is punctuated, capitalised and
 * numeric; an unbroken run of a dozen bare lowercase words is not prose.
 */
const MNEMONIC_RE = /\b[a-z]{3,8}(?:[ ][a-z]{3,8}){11,23}\b/g

/** Extended-key and common secret-material prefixes. */
const EXTENDED_KEY_RE = /\b(?:xprv|xpub|yprv|zprv|tprv|uprv|vprv)[1-9A-HJ-NP-Za-km-z]{50,}\b/g

/**
 * Mask secret-shaped runs in already-serialized text.
 *
 * Order matters. The keyed pass runs first and pins every *allowed* hash to a
 * placeholder, so the blanket 32-byte-hex pass that follows cannot re-redact a
 * transaction hash the agent is entitled to. The placeholders are restored at
 * the end.
 */
export function redactSecrets(text: string): string {
  if (text === '') return text

  // 1. Signatures first: 130 hex digits contain 64-hex substrings, so letting
  //    the shorter rule run first would leave a signature partly intact.
  let out = text.replace(SIGNATURE_HEX_RE, REDACTED)

  // 2. Park public hashes behind `%%parkN%%` placeholders, restored in step 4.
  //    The sentinel is printable and JSON-safe on purpose: a control character
  //    here would survive into the serialized result and break `JSON.parse`.
  //    Nine characters cannot trip any rule in step 3.
  const parked: string[] = []
  out = out.replace(KEYED_HEX32_RE, (match, key: string, sep: string, hex: string) => {
    if (!PUBLIC_HASH_FIELD_NAMES.has(normalizeFieldName(key))) return match
    const slot = parked.push(hex) - 1
    return `"${key}"${sep}"%%park${slot}%%"`
  })

  // 3. Everything still key-shaped goes.
  out = out.replace(HEX32_RE, REDACTED)
  out = out.replace(BARE_HEX32_RE, REDACTED)
  out = out.replace(EXTENDED_KEY_RE, REDACTED)
  out = out.replace(MNEMONIC_RE, REDACTED)

  // 4. Restore the parked hashes.
  return out.replace(/%%park(\d+)%%/g, (_match, index: string) => {
    return parked[Number(index)] ?? REDACTED
  })
}

/* -------------------------------------------------------------------------- */
/* Both layers                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Run both layers over a structured value and return the cleaned value.
 *
 * The value is serialized between the layers so the backstop sees exactly the
 * bytes the agent would: layer (b) is only meaningful over the final text.
 *
 * @param value Any JSON-ish tool result.
 * @returns The same shape with every secret-named field and secret-shaped run
 * replaced by {@link REDACTED}.
 */
export function redact<T>(value: T): unknown {
  const structured = redactFields(value)
  let json: string
  try {
    json = JSON.stringify(structured)
  } catch {
    // Unserializable input cannot be vetted, so nothing about it is returned.
    return REDACTED
  }
  if (json === undefined) return structured
  const cleaned = redactSecrets(json)
  if (cleaned === json) return structured
  try {
    return JSON.parse(cleaned) as unknown
  } catch {
    return REDACTED
  }
}

/** Convenience: {@link redact} a value and serialize it for a text block. */
export function redactToJson(value: unknown, space?: number): string {
  return JSON.stringify(redact(value), null, space)
}

/**
 * Whether text still contains anything key-shaped.
 *
 * The assertion behind the "every tool result passes redaction" tests (AE4),
 * and cheap enough to be worth calling in anger.
 */
export function containsSecretShapedText(text: string): boolean {
  return redactSecrets(text) !== text
}
