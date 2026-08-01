import { describe, expect, test } from 'bun:test'

import {
  REDACTED,
  containsSecretShapedText,
  isSecretFieldName,
  normalizeFieldName,
  redact,
  redactFields,
  redactSecrets,
  redactToJson,
} from './redact.js'

/** A real-shaped secp256k1 private key. Never a live key. */
const PRIVATE_KEY =
  '0x4c0883a69102937d6231471b5dbb6204fe5129617082792ae468d01a3f362318'
/** A 65-byte ECDSA signature. */
const SIGNATURE = `0x${'ab'.repeat(65)}`
/** A transaction hash — same shape as a private key, but public. */
const TX_HASH =
  '0x88df016429689c079f3b2f6ad39fa052532c56795b733da78a91ebe6a713944b'
const ADDRESS = '0x5FbDB2315678afecb367f032d93F642f64180aa3'

describe('normalizeFieldName', () => {
  test('strips case and separators so spelling variants collapse', () => {
    expect(normalizeFieldName('owner_signature')).toBe('ownersignature')
    expect(normalizeFieldName('owner-Signature')).toBe('ownersignature')
    expect(normalizeFieldName('ownerSignature')).toBe('ownersignature')
  })
})

describe('isSecretFieldName', () => {
  test('flags the names that actually carry key material', () => {
    for (const name of [
      'privateKey',
      'session_private_key',
      'ownerPrivateKey',
      'mnemonic',
      'seedPhrase',
      'passphrase',
      'password',
      'ownerSignature',
      'signature',
      'daemonToken',
      'apiKey',
      'x_api_key',
      'refresh_token',
      'ciphertext',
      'keystore',
    ]) {
      expect(isSecretFieldName(name)).toBe(true)
    }
  })

  test('leaves the public fields a card result needs', () => {
    // `token` is the ERC-20 the card settles in; redacting it would break every
    // legitimate result while protecting nothing.
    for (const name of [
      'token',
      'cardId',
      'card_id',
      'merchant',
      'amount',
      'available',
      'escrowed',
      'status',
      'txHash',
      'expires_at',
      'vault',
    ]) {
      expect(isSecretFieldName(name)).toBe(false)
    }
  })
})

describe('redactFields (layer a)', () => {
  test('blanks secret-named fields and keeps the rest', () => {
    const result = redactFields({
      cardId: '7',
      token: ADDRESS,
      sessionPrivateKey: PRIVATE_KEY,
      ownerSignature: SIGNATURE,
    }) as Record<string, unknown>

    expect(result['cardId']).toBe('7')
    expect(result['token']).toBe(ADDRESS)
    expect(result['sessionPrivateKey']).toBe(REDACTED)
    expect(result['ownerSignature']).toBe(REDACTED)
  })

  test('recurses through nested objects and arrays', () => {
    const result = redactFields({
      records: [{ inner: { privateKey: PRIVATE_KEY, id: 'a' } }],
    }) as { records: { inner: Record<string, unknown> }[] }

    expect(result.records[0]?.inner['privateKey']).toBe(REDACTED)
    expect(result.records[0]?.inner['id']).toBe('a')
  })

  test('normalises bigint so a result can always be serialized', () => {
    expect(redactFields({ cap: 1000n })).toEqual({ cap: '1000' })
  })

  test('breaks cycles instead of throwing', () => {
    const cyclic: Record<string, unknown> = { name: 'loop' }
    cyclic['self'] = cyclic
    expect(redactFields(cyclic)).toEqual({ name: 'loop', self: '[circular]' })
  })

  test('renders an Error as text so layer (b) can still sweep it', () => {
    const result = redactFields({
      cause: new Error(`boom ${PRIVATE_KEY}`),
    }) as Record<string, string>
    expect(result['cause']).toContain('boom')
  })
})

describe('redactSecrets (layer b)', () => {
  test('masks a 32-byte hex key that no field name flagged', () => {
    // The case layer (a) structurally cannot catch: a key inside free text.
    const text = JSON.stringify({ message: `use ${PRIVATE_KEY} to sign` })
    expect(redactSecrets(text)).not.toContain(PRIVATE_KEY)
    expect(redactSecrets(text)).toContain(REDACTED)
  })

  test('masks a bare 64-hex run, which is also the daemon token shape', () => {
    const token = 'a'.repeat(64)
    expect(redactSecrets(`token=${token}`)).not.toContain(token)
  })

  test('masks a full ECDSA signature without leaving fragments', () => {
    const masked = redactSecrets(`sig ${SIGNATURE}`)
    expect(masked).not.toContain(SIGNATURE)
    expect(masked).not.toContain('abab')
  })

  test('masks a BIP-39-shaped word run', () => {
    const mnemonic =
      'legal winner thank year wave sausage worth useful legal winner thank yellow'
    expect(redactSecrets(`phrase: ${mnemonic}`)).not.toContain(mnemonic)
  })

  test('keeps a transaction hash, which is public and needed', () => {
    const text = JSON.stringify({ mint_tx_hash: TX_HASH, cardId: '3' })
    const cleaned = redactSecrets(text)
    expect(cleaned).toContain(TX_HASH)
    expect(JSON.parse(cleaned)).toEqual({ mint_tx_hash: TX_HASH, cardId: '3' })
  })

  test('redacts a 32-byte hex under an unrecognised key — fail closed', () => {
    // `notes` is not on the public-hash allowlist, so the value goes even
    // though it is shaped exactly like the tx hash above.
    const text = JSON.stringify({ notes: TX_HASH })
    expect(redactSecrets(text)).not.toContain(TX_HASH)
  })

  test('leaves plain addresses alone', () => {
    const text = JSON.stringify({ merchant: ADDRESS })
    expect(redactSecrets(text)).toBe(text)
  })

  test('is idempotent', () => {
    const once = redactSecrets(JSON.stringify({ m: PRIVATE_KEY }))
    expect(redactSecrets(once)).toBe(once)
  })
})

describe('redact (both layers)', () => {
  test('catches a key the denylist missed and one it did not', () => {
    const result = redact({
      ownerSignature: SIGNATURE,
      message: `recover with ${PRIVATE_KEY}`,
      mint_tx_hash: TX_HASH,
      merchant: ADDRESS,
    }) as Record<string, string>

    expect(result['ownerSignature']).toBe(REDACTED)
    expect(result['message']).not.toContain(PRIVATE_KEY)
    // Public values survive both layers.
    expect(result['mint_tx_hash']).toBe(TX_HASH)
    expect(result['merchant']).toBe(ADDRESS)
  })

  test('a daemon approval record never yields its owner signature', () => {
    // The exact shape `GET /v1/requests/:id` returns. Handing this to an agent
    // verbatim would hand it a reusable spend authorisation.
    const wire = {
      id: 'req-1',
      status: 'approved',
      ownerSignature: SIGNATURE,
      cardId: '9',
      mintTxHash: TX_HASH,
    }
    const serialized = redactToJson(wire)
    expect(serialized).not.toContain(SIGNATURE)
    // The card id and tx hash still come through — the agent needs both.
    expect(JSON.parse(serialized)).toMatchObject({
      cardId: '9',
      mintTxHash: TX_HASH,
      ownerSignature: REDACTED,
    })
  })

  test('survives an unserializable value rather than leaking it', () => {
    const bad = { toJSON: () => { throw new Error('nope') } }
    expect(redact(bad)).toBe(REDACTED)
  })
})

describe('containsSecretShapedText', () => {
  test('is the assertion the tool-result tests rely on (AE4)', () => {
    expect(containsSecretShapedText(`x ${PRIVATE_KEY}`)).toBe(true)
    expect(containsSecretShapedText(`merchant ${ADDRESS}`)).toBe(false)
  })
})
