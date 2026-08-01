import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  chmodSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  DEFAULT_SCRYPT_PARAMS,
  KEYSTORE_FILE_NAME,
  KeystoreCorruptError,
  KeystoreDecryptionError,
  KeystoreError,
  KeystoreNotFoundError,
  deleteKeystore,
  ensureKeystoreDir,
  keystoreDir,
  keystoreExists,
  keystoreFileMode,
  keystorePath,
  loadKeystore,
  passphrasesMatch,
  readKeystoreFile,
  saveKeystore,
  tryLoadKeystore,
  updateKeystore,
  verifyPassphrase,
  type KeystoreData,
  type KeystoreOptions,
} from './keystore.js'

/** Cheap scrypt so the suite stays fast. Production uses N = 2^17. */
const FAST_SCRYPT = { N: 2 ** 10, r: 8, p: 1 }

const OWNER_KEY =
  '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d' as const
const SESSION_KEY =
  '0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba' as const

let dir: string
let options: KeystoreOptions

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'giwacard-keystore-'))
  options = { dir, scryptParams: FAST_SCRYPT }
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('paths', () => {
  test('defaults to ~/.giwacard when nothing is configured', () => {
    const previous = process.env['GIWACARD_HOME']
    delete process.env['GIWACARD_HOME']
    try {
      expect(keystoreDir()).toMatch(/[/\\]\.giwacard$/)
      expect(keystorePath()).toMatch(/[/\\]\.giwacard[/\\]keystore\.json$/)
    } finally {
      if (previous !== undefined) process.env['GIWACARD_HOME'] = previous
    }
  })

  test('honours $GIWACARD_HOME', () => {
    const previous = process.env['GIWACARD_HOME']
    process.env['GIWACARD_HOME'] = '/tmp/somewhere-else'
    try {
      expect(keystoreDir()).toBe('/tmp/somewhere-else')
    } finally {
      if (previous === undefined) delete process.env['GIWACARD_HOME']
      else process.env['GIWACARD_HOME'] = previous
    }
  })

  test('an explicit dir option wins over the environment', () => {
    const previous = process.env['GIWACARD_HOME']
    process.env['GIWACARD_HOME'] = '/tmp/somewhere-else'
    try {
      expect(keystoreDir(options)).toBe(dir)
    } finally {
      if (previous === undefined) delete process.env['GIWACARD_HOME']
      else process.env['GIWACARD_HOME'] = previous
    }
  })
})

describe('round-trip', () => {
  test('save then load with the correct passphrase returns the same secrets', () => {
    const data: KeystoreData = {
      ownerPrivateKey: OWNER_KEY,
      sessionPrivateKey: SESSION_KEY,
      meta: { vault: '0x1234', createdBy: 'test' },
    }
    saveKeystore(data, 'correct horse battery staple', options)

    const loaded = loadKeystore('correct horse battery staple', options)
    expect(loaded).toEqual(data)
    expect(loaded.ownerPrivateKey).toBe(OWNER_KEY)
    expect(loaded.sessionPrivateKey).toBe(SESSION_KEY)
  })

  test('holds both the owner key and the session key in one file (KTD-15)', () => {
    saveKeystore(
      { ownerPrivateKey: OWNER_KEY, sessionPrivateKey: SESSION_KEY },
      'pw',
      options,
    )
    expect(readdirSync(dir)).toEqual([KEYSTORE_FILE_NAME])
  })

  test('an empty keystore round-trips', () => {
    saveKeystore({}, 'pw', options)
    expect(loadKeystore('pw', options)).toEqual({})
  })

  test('a unicode passphrase round-trips across normal forms', () => {
    // Same user-visible passphrase, different encodings: composed U+00E9 vs
    // decomposed 'e' + U+0301. NFKC normalisation makes them interchangeable.
    const composed = 'pass-\u00e9'
    const decomposed = 'pass-e\u0301'
    expect(composed).not.toBe(decomposed)

    saveKeystore({ ownerPrivateKey: OWNER_KEY }, composed, options)
    expect(loadKeystore(decomposed, options)).toEqual({
      ownerPrivateKey: OWNER_KEY,
    })
  })

  test('round-trips with the real (default) scrypt cost', () => {
    saveKeystore({ ownerPrivateKey: OWNER_KEY }, 'pw', { dir })
    const file = readKeystoreFile({ dir })
    expect(file.kdfparams.N).toBe(DEFAULT_SCRYPT_PARAMS.N)
    expect(loadKeystore('pw', { dir })).toEqual({ ownerPrivateKey: OWNER_KEY })
  })

  test('overwriting keeps createdAt and refreshes the payload', () => {
    saveKeystore({ ownerPrivateKey: OWNER_KEY }, 'pw', options)
    const first = readKeystoreFile(options)

    saveKeystore({ ownerPrivateKey: OWNER_KEY, sessionPrivateKey: SESSION_KEY }, 'pw', options)
    const second = readKeystoreFile(options)

    expect(second.createdAt).toBe(first.createdAt)
    expect(second.ciphertext).not.toBe(first.ciphertext)
    expect(loadKeystore('pw', options).sessionPrivateKey).toBe(SESSION_KEY)
  })

  test('each save uses a fresh salt and iv', () => {
    saveKeystore({ ownerPrivateKey: OWNER_KEY }, 'pw', options)
    const first = readKeystoreFile(options)
    saveKeystore({ ownerPrivateKey: OWNER_KEY }, 'pw', options)
    const second = readKeystoreFile(options)

    expect(second.kdfparams.salt).not.toBe(first.kdfparams.salt)
    expect(second.cipherparams.iv).not.toBe(first.cipherparams.iv)
    // Identical plaintext must not produce identical ciphertext.
    expect(second.ciphertext).not.toBe(first.ciphertext)
  })
})

describe('wrong passphrase', () => {
  beforeEach(() => {
    saveKeystore(
      { ownerPrivateKey: OWNER_KEY, sessionPrivateKey: SESSION_KEY },
      'the-right-one',
      options,
    )
  })

  test('throws a typed decryption error', () => {
    expect(() => loadKeystore('the-wrong-one', options)).toThrow(
      KeystoreDecryptionError,
    )
    try {
      loadKeystore('the-wrong-one', options)
      throw new Error('expected loadKeystore to throw')
    } catch (error) {
      expect(error).toBeInstanceOf(KeystoreError)
      expect((error as KeystoreError).code).toBe('KEYSTORE_DECRYPTION_FAILED')
    }
  })

  test('does not return garbage — it returns nothing at all', () => {
    let result: unknown = 'sentinel'
    try {
      result = loadKeystore('the-wrong-one', options)
    } catch {
      /* expected */
    }
    expect(result).toBe('sentinel')
  })

  test('a near-miss passphrase fails just as hard', () => {
    expect(() => loadKeystore('the-right-onE', options)).toThrow(
      KeystoreDecryptionError,
    )
    expect(() => loadKeystore('the-right-one ', options)).toThrow(
      KeystoreDecryptionError,
    )
  })

  test('tryLoadKeystore still throws on a wrong passphrase', () => {
    expect(() => tryLoadKeystore('nope', options)).toThrow(
      KeystoreDecryptionError,
    )
  })

  test('verifyPassphrase reports true/false without leaking the payload', () => {
    expect(verifyPassphrase('the-right-one', options)).toBe(true)
    expect(verifyPassphrase('nope', options)).toBe(false)
  })

  test('an empty passphrase is rejected before any crypto happens', () => {
    expect(() => loadKeystore('', options)).toThrow(KeystoreError)
    expect(() => saveKeystore({}, '', options)).toThrow(KeystoreError)
    try {
      loadKeystore('', options)
    } catch (error) {
      expect((error as KeystoreError).code).toBe('KEYSTORE_INVALID_PASSPHRASE')
    }
  })
})

describe('file permissions', () => {
  test('the keystore file is created with mode 0600', () => {
    saveKeystore({ ownerPrivateKey: OWNER_KEY }, 'pw', options)
    expect(keystoreFileMode(options)).toBe(0o600)
    expect(statSync(keystorePath(options)).mode & 0o777).toBe(0o600)
  })

  test('the keystore directory is created with mode 0700', () => {
    const nested = join(dir, 'nested', '.giwacard')
    saveKeystore({ ownerPrivateKey: OWNER_KEY }, 'pw', {
      dir: nested,
      scryptParams: FAST_SCRYPT,
    })
    expect(statSync(nested).mode & 0o777).toBe(0o700)
  })

  test('0600 survives an overwrite even if the file was loosened', () => {
    saveKeystore({ ownerPrivateKey: OWNER_KEY }, 'pw', options)
    // Simulate a user (or a bad backup tool) widening the permissions.
    chmodSync(keystorePath(options), 0o644)
    expect(keystoreFileMode(options)).toBe(0o644)

    saveKeystore({ ownerPrivateKey: OWNER_KEY }, 'pw', options)
    expect(keystoreFileMode(options)).toBe(0o600)
  })

  test('ensureKeystoreDir is idempotent', () => {
    expect(ensureKeystoreDir(options)).toBe(dir)
    expect(ensureKeystoreDir(options)).toBe(dir)
    expect(statSync(dir).mode & 0o777).toBe(0o700)
  })

  test('leaves no temp files behind', () => {
    saveKeystore({ ownerPrivateKey: OWNER_KEY }, 'pw', options)
    saveKeystore({ ownerPrivateKey: OWNER_KEY }, 'pw', options)
    expect(readdirSync(dir).filter((f) => f.endsWith('.tmp'))).toEqual([])
  })
})

describe('no keystore yet', () => {
  test('keystoreExists is false', () => {
    expect(keystoreExists(options)).toBe(false)
  })

  test('loadKeystore throws a typed not-found error with an actionable hint', () => {
    expect(() => loadKeystore('pw', options)).toThrow(KeystoreNotFoundError)
    try {
      loadKeystore('pw', options)
      throw new Error('expected loadKeystore to throw')
    } catch (error) {
      const err = error as KeystoreNotFoundError
      expect(err.code).toBe('KEYSTORE_NOT_FOUND')
      expect(err.path).toBe(keystorePath(options))
      expect(err.message).toContain('giwacard init')
    }
  })

  test('tryLoadKeystore returns null instead of throwing', () => {
    expect(tryLoadKeystore('pw', options)).toBeNull()
  })

  test('keystoreFileMode throws not-found rather than reporting a bogus mode', () => {
    expect(() => keystoreFileMode(options)).toThrow(KeystoreNotFoundError)
  })

  test('deleteKeystore returns false when there is nothing to delete', () => {
    expect(deleteKeystore(options)).toBe(false)
  })

  test('updateKeystore bootstraps an empty keystore', () => {
    const next = updateKeystore(
      'pw',
      (current) => ({ ...current, ownerPrivateKey: OWNER_KEY }),
      options,
    )
    expect(next).toEqual({ ownerPrivateKey: OWNER_KEY })
    expect(loadKeystore('pw', options)).toEqual({ ownerPrivateKey: OWNER_KEY })
  })
})

describe('tamper detection', () => {
  beforeEach(() => {
    saveKeystore({ ownerPrivateKey: OWNER_KEY }, 'pw', options)
  })

  const rewrite = (mutate: (file: Record<string, any>) => void) => {
    const path = keystorePath(options)
    const file = JSON.parse(readFileSync(path, 'utf8')) as Record<string, any>
    mutate(file)
    writeFileSync(path, JSON.stringify(file), { mode: 0o600 })
  }

  test('flipped ciphertext fails the auth tag', () => {
    rewrite((file) => {
      const hex: string = file['ciphertext']
      file['ciphertext'] = (hex[0] === 'a' ? 'b' : 'a') + hex.slice(1)
    })
    expect(() => loadKeystore('pw', options)).toThrow(KeystoreDecryptionError)
  })

  test('rewritten kdf parameters fail (header is authenticated)', () => {
    rewrite((file) => {
      file['kdfparams'].N = 2 ** 11
    })
    expect(() => loadKeystore('pw', options)).toThrow(KeystoreDecryptionError)
  })

  test('a swapped auth tag fails', () => {
    rewrite((file) => {
      file['tag'] = '00000000000000000000000000000000'
    })
    expect(() => loadKeystore('pw', options)).toThrow(KeystoreDecryptionError)
  })

  test('non-JSON content is reported as corrupt, not as a wrong passphrase', () => {
    writeFileSync(keystorePath(options), 'not json at all', { mode: 0o600 })
    expect(() => loadKeystore('pw', options)).toThrow(KeystoreCorruptError)
  })

  test('a future version is reported distinctly', () => {
    rewrite((file) => {
      file['version'] = 99
    })
    try {
      loadKeystore('pw', options)
      throw new Error('expected loadKeystore to throw')
    } catch (error) {
      expect((error as KeystoreError).code).toBe(
        'KEYSTORE_UNSUPPORTED_VERSION',
      )
    }
  })

  test('missing cipherparams is reported as corrupt', () => {
    rewrite((file) => {
      delete file['cipherparams']
    })
    expect(() => loadKeystore('pw', options)).toThrow(KeystoreCorruptError)
  })
})

describe('on-disk envelope', () => {
  test('never stores a key alongside the ciphertext (KTD-15)', () => {
    saveKeystore(
      { ownerPrivateKey: OWNER_KEY, sessionPrivateKey: SESSION_KEY },
      'pw',
      options,
    )
    const raw = readFileSync(keystorePath(options), 'utf8')

    expect(raw).not.toContain(OWNER_KEY)
    expect(raw).not.toContain(OWNER_KEY.slice(2))
    expect(raw).not.toContain(SESSION_KEY)
    expect(raw).not.toContain(SESSION_KEY.slice(2))
    expect(raw).not.toContain('pw')
    expect(raw).not.toContain('ownerPrivateKey')

    const file = JSON.parse(raw) as Record<string, unknown>
    expect(Object.keys(file).sort()).toEqual([
      'cipher',
      'cipherparams',
      'ciphertext',
      'createdAt',
      'kdf',
      'kdfparams',
      'tag',
      'updatedAt',
      'version',
    ])
  })

  test('declares its kdf and cipher', () => {
    saveKeystore({ ownerPrivateKey: OWNER_KEY }, 'pw', options)
    const file = readKeystoreFile(options)
    expect(file.kdf).toBe('scrypt')
    expect(file.cipher).toBe('aes-256-gcm')
    expect(file.kdfparams.dklen).toBe(32)
    expect(file.kdfparams.salt).toHaveLength(64)
    expect(file.cipherparams.iv).toHaveLength(24)
    expect(file.tag).toHaveLength(32)
  })

  test('production defaults are expensive on purpose', () => {
    expect(DEFAULT_SCRYPT_PARAMS.N).toBe(131_072)
    expect(DEFAULT_SCRYPT_PARAMS.r).toBe(8)
    expect(DEFAULT_SCRYPT_PARAMS.p).toBe(1)
  })
})

describe('updateKeystore', () => {
  test('adds the session key without disturbing the owner key', () => {
    saveKeystore({ ownerPrivateKey: OWNER_KEY }, 'pw', options)
    updateKeystore(
      'pw',
      (current) => ({ ...current, sessionPrivateKey: SESSION_KEY }),
      options,
    )
    expect(loadKeystore('pw', options)).toEqual({
      ownerPrivateKey: OWNER_KEY,
      sessionPrivateKey: SESSION_KEY,
    })
  })

  test('propagates a wrong passphrase instead of silently resetting', () => {
    saveKeystore({ ownerPrivateKey: OWNER_KEY }, 'pw', options)
    expect(() =>
      updateKeystore('wrong', (current) => current, options),
    ).toThrow(KeystoreDecryptionError)
    // The original keystore must survive the failed update.
    expect(loadKeystore('pw', options)).toEqual({ ownerPrivateKey: OWNER_KEY })
  })
})

describe('deleteKeystore', () => {
  test('removes an existing keystore', () => {
    saveKeystore({ ownerPrivateKey: OWNER_KEY }, 'pw', options)
    expect(deleteKeystore(options)).toBe(true)
    expect(keystoreExists(options)).toBe(false)
    expect(tryLoadKeystore('pw', options)).toBeNull()
  })
})

describe('passphrasesMatch', () => {
  test('matches equal passphrases, including across normal forms', () => {
    expect(passphrasesMatch('hunter2', 'hunter2')).toBe(true)
    expect(passphrasesMatch('caf\u00e9', 'cafe\u0301')).toBe(true)
  })

  test('rejects different passphrases and different lengths', () => {
    expect(passphrasesMatch('hunter2', 'hunter3')).toBe(false)
    expect(passphrasesMatch('hunter2', 'hunter22')).toBe(false)
    expect(passphrasesMatch('', 'x')).toBe(false)
  })
})
