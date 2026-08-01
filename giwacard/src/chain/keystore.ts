import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  scryptSync,
  timingSafeEqual,
} from 'node:crypto'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/**
 * KTD-15: the owner wallet key and the session key both live in
 * `~/.giwacard/keystore.json`, encrypted under a key derived from a passphrase
 * the user supplies. The passphrase is never persisted and no key material is
 * ever stored next to the ciphertext — losing the passphrase means losing the
 * keystore, by design.
 */

export const KEYSTORE_DIR_NAME = '.giwacard' as const
export const KEYSTORE_FILE_NAME = 'keystore.json' as const

/** Directory mode: owner-only rwx. */
export const KEYSTORE_DIR_MODE = 0o700
/** File mode: owner-only rw. */
export const KEYSTORE_FILE_MODE = 0o600

export const KEYSTORE_VERSION = 1 as const
const CIPHER = 'aes-256-gcm' as const
const KDF = 'scrypt' as const
const KEY_LENGTH = 32
const SALT_LENGTH = 32
const IV_LENGTH = 12
const TAG_LENGTH = 16

/**
 * scrypt cost. N=2^17 with r=8 needs ~128 MiB, hence the explicit `maxmem`
 * (node's default is 32 MiB and would throw). Tunable so tests — and only
 * tests — can run cheap parameters.
 */
export interface ScryptParams {
  N: number
  r: number
  p: number
}

export const DEFAULT_SCRYPT_PARAMS: ScryptParams = {
  N: 2 ** 17,
  r: 8,
  p: 1,
}

function scryptMaxmem(params: ScryptParams): number {
  // node requires maxmem > 128 * N * r; give it generous headroom.
  return Math.max(64 * 1024 * 1024, 256 * params.N * params.r)
}

/* -------------------------------------------------------------------------- */
/* Types                                                                      */
/* -------------------------------------------------------------------------- */

export type Hex = `0x${string}`

/** The plaintext payload. Everything here is secret. */
export interface KeystoreData {
  /** Owner EOA private key — controls the vault. */
  ownerPrivateKey?: Hex
  /** Session key private key — spends inside policy (KTD-6). */
  sessionPrivateKey?: Hex
  /** Non-secret bookkeeping that still benefits from being sealed. */
  meta?: Record<string, unknown>
}

/** On-disk envelope. Contains no key material — only KDF/cipher parameters. */
export interface KeystoreFile {
  version: number
  kdf: typeof KDF
  kdfparams: ScryptParams & { dklen: number; salt: string }
  cipher: typeof CIPHER
  cipherparams: { iv: string }
  ciphertext: string
  tag: string
  createdAt: string
  updatedAt: string
}

export interface KeystoreOptions {
  /**
   * Keystore directory. Defaults to `$GIWACARD_HOME`, else `~/.giwacard`.
   */
  dir?: string
  /** scrypt cost. Only override in tests. */
  scryptParams?: ScryptParams
}

/* -------------------------------------------------------------------------- */
/* Errors                                                                     */
/* -------------------------------------------------------------------------- */

export type KeystoreErrorCode =
  | 'KEYSTORE_NOT_FOUND'
  | 'KEYSTORE_DECRYPTION_FAILED'
  | 'KEYSTORE_CORRUPT'
  | 'KEYSTORE_UNSUPPORTED_VERSION'
  | 'KEYSTORE_INVALID_PASSPHRASE'
  | 'KEYSTORE_ALREADY_EXISTS'

export class KeystoreError extends Error {
  override readonly name: string = 'KeystoreError'
  readonly code: KeystoreErrorCode
  readonly path: string | undefined

  constructor(
    code: KeystoreErrorCode,
    message: string,
    options?: { path?: string; cause?: unknown },
  ) {
    super(message, options?.cause !== undefined ? { cause: options.cause } : {})
    this.code = code
    this.path = options?.path
  }
}

export class KeystoreNotFoundError extends KeystoreError {
  override readonly name = 'KeystoreNotFoundError'
  constructor(path: string) {
    super(
      'KEYSTORE_NOT_FOUND',
      `No giwacard keystore at ${path}. Run \`giwacard init\` to create one.`,
      { path },
    )
  }
}

export class KeystoreDecryptionError extends KeystoreError {
  override readonly name = 'KeystoreDecryptionError'
  constructor(path: string, cause?: unknown) {
    super(
      'KEYSTORE_DECRYPTION_FAILED',
      `Could not decrypt the giwacard keystore at ${path}. ` +
        'The passphrase is wrong, or the file has been modified.',
      { path, cause },
    )
  }
}

export class KeystoreCorruptError extends KeystoreError {
  override readonly name = 'KeystoreCorruptError'
  constructor(path: string, detail: string, cause?: unknown) {
    super('KEYSTORE_CORRUPT', `Malformed giwacard keystore at ${path}: ${detail}`, {
      path,
      cause,
    })
  }
}

/* -------------------------------------------------------------------------- */
/* Paths                                                                      */
/* -------------------------------------------------------------------------- */

/** Resolve the keystore directory: option > `$GIWACARD_HOME` > `~/.giwacard`. */
export function keystoreDir(options: KeystoreOptions = {}): string {
  if (options.dir) return options.dir
  const fromEnv = process.env['GIWACARD_HOME']
  if (fromEnv && fromEnv.trim() !== '') return fromEnv
  return join(homedir(), KEYSTORE_DIR_NAME)
}

/** Absolute path of the keystore file. */
export function keystorePath(options: KeystoreOptions = {}): string {
  return join(keystoreDir(options), KEYSTORE_FILE_NAME)
}

/** Whether a keystore file already exists. */
export function keystoreExists(options: KeystoreOptions = {}): boolean {
  return existsSync(keystorePath(options))
}

/**
 * Create the keystore directory with mode 0700.
 *
 * `mkdir`'s mode argument is masked by the process umask, so the mode is
 * re-applied explicitly afterwards.
 */
export function ensureKeystoreDir(options: KeystoreOptions = {}): string {
  const dir = keystoreDir(options)
  mkdirSync(dir, { recursive: true, mode: KEYSTORE_DIR_MODE })
  chmodSync(dir, KEYSTORE_DIR_MODE)
  return dir
}

/* -------------------------------------------------------------------------- */
/* Crypto                                                                     */
/* -------------------------------------------------------------------------- */

function assertPassphrase(passphrase: string): void {
  if (typeof passphrase !== 'string' || passphrase.length === 0) {
    throw new KeystoreError(
      'KEYSTORE_INVALID_PASSPHRASE',
      'A non-empty passphrase is required to encrypt or open the keystore.',
    )
  }
}

function deriveKey(
  passphrase: string,
  salt: Buffer,
  params: ScryptParams,
): Buffer {
  return scryptSync(passphrase.normalize('NFKC'), salt, KEY_LENGTH, {
    N: params.N,
    r: params.r,
    p: params.p,
    maxmem: scryptMaxmem(params),
  })
}

/**
 * Additional authenticated data: binds the ciphertext to its own header, so a
 * tampered KDF cost or version fails the GCM tag instead of silently changing
 * how the key is derived.
 */
function aad(file: Omit<KeystoreFile, 'ciphertext' | 'tag' | 'updatedAt'>): Buffer {
  return Buffer.from(
    JSON.stringify({
      version: file.version,
      kdf: file.kdf,
      kdfparams: file.kdfparams,
      cipher: file.cipher,
      cipherparams: file.cipherparams,
    }),
    'utf8',
  )
}

function encrypt(
  data: KeystoreData,
  passphrase: string,
  params: ScryptParams,
  createdAt: string,
): KeystoreFile {
  const salt = randomBytes(SALT_LENGTH)
  const iv = randomBytes(IV_LENGTH)
  const key = deriveKey(passphrase, salt, params)

  const header = {
    version: KEYSTORE_VERSION,
    kdf: KDF,
    kdfparams: { ...params, dklen: KEY_LENGTH, salt: salt.toString('hex') },
    cipher: CIPHER,
    cipherparams: { iv: iv.toString('hex') },
    createdAt,
  } satisfies Omit<KeystoreFile, 'ciphertext' | 'tag' | 'updatedAt'>

  const cipher = createCipheriv(CIPHER, key, iv, { authTagLength: TAG_LENGTH })
  cipher.setAAD(aad(header))
  const ciphertext = Buffer.concat([
    cipher.update(Buffer.from(JSON.stringify(data), 'utf8')),
    cipher.final(),
  ])
  const tag = cipher.getAuthTag()

  key.fill(0)

  return {
    ...header,
    ciphertext: ciphertext.toString('hex'),
    tag: tag.toString('hex'),
    updatedAt: new Date().toISOString(),
  }
}

function decrypt(
  file: KeystoreFile,
  passphrase: string,
  path: string,
): KeystoreData {
  const salt = Buffer.from(file.kdfparams.salt, 'hex')
  const iv = Buffer.from(file.cipherparams.iv, 'hex')
  const key = deriveKey(passphrase, salt, {
    N: file.kdfparams.N,
    r: file.kdfparams.r,
    p: file.kdfparams.p,
  })

  try {
    const decipher = createDecipheriv(file.cipher, key, iv, {
      authTagLength: TAG_LENGTH,
    })
    decipher.setAAD(
      aad({
        version: file.version,
        kdf: file.kdf,
        kdfparams: file.kdfparams,
        cipher: file.cipher,
        cipherparams: file.cipherparams,
        createdAt: file.createdAt,
      }),
    )
    decipher.setAuthTag(Buffer.from(file.tag, 'hex'))
    // `final()` throws if the GCM tag does not verify, so a wrong passphrase can
    // never yield partial or garbage plaintext.
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(file.ciphertext, 'hex')),
      decipher.final(),
    ])
    const parsed = JSON.parse(plaintext.toString('utf8')) as KeystoreData
    plaintext.fill(0)
    return parsed
  } catch (cause) {
    throw new KeystoreDecryptionError(path, cause)
  } finally {
    key.fill(0)
  }
}

/* -------------------------------------------------------------------------- */
/* Read / write                                                               */
/* -------------------------------------------------------------------------- */

function assertKeystoreFile(value: unknown, path: string): KeystoreFile {
  if (typeof value !== 'object' || value === null) {
    throw new KeystoreCorruptError(path, 'expected a JSON object')
  }
  const file = value as Partial<KeystoreFile>
  if (file.version !== KEYSTORE_VERSION) {
    throw new KeystoreError(
      'KEYSTORE_UNSUPPORTED_VERSION',
      `Unsupported giwacard keystore version ${String(file.version)} at ${path}; ` +
        `this build understands version ${KEYSTORE_VERSION}.`,
      { path },
    )
  }
  if (file.kdf !== KDF) {
    throw new KeystoreCorruptError(path, `unknown kdf ${String(file.kdf)}`)
  }
  if (file.cipher !== CIPHER) {
    throw new KeystoreCorruptError(path, `unknown cipher ${String(file.cipher)}`)
  }
  const params = file.kdfparams
  if (
    typeof params !== 'object' ||
    params === null ||
    typeof params.salt !== 'string' ||
    typeof params.N !== 'number' ||
    typeof params.r !== 'number' ||
    typeof params.p !== 'number'
  ) {
    throw new KeystoreCorruptError(path, 'missing or invalid kdfparams')
  }
  if (
    typeof file.cipherparams !== 'object' ||
    file.cipherparams === null ||
    typeof file.cipherparams.iv !== 'string'
  ) {
    throw new KeystoreCorruptError(path, 'missing or invalid cipherparams')
  }
  if (typeof file.ciphertext !== 'string' || typeof file.tag !== 'string') {
    throw new KeystoreCorruptError(path, 'missing ciphertext or auth tag')
  }
  return file as KeystoreFile
}

/** Read and validate the envelope without decrypting it. */
export function readKeystoreFile(options: KeystoreOptions = {}): KeystoreFile {
  const path = keystorePath(options)
  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new KeystoreNotFoundError(path)
    }
    throw cause
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (cause) {
    throw new KeystoreCorruptError(path, 'file is not valid JSON', cause)
  }
  return assertKeystoreFile(parsed, path)
}

/**
 * Encrypt and write the keystore.
 *
 * Written to a temp file in the same directory and renamed into place, so an
 * interrupted write can never truncate an existing keystore. Both the temp file
 * and the final file are chmod'd to 0600 explicitly (umask ignores the `mode`
 * option in some environments), and the directory to 0700.
 */
export function saveKeystore(
  data: KeystoreData,
  passphrase: string,
  options: KeystoreOptions = {},
): string {
  assertPassphrase(passphrase)
  const dir = ensureKeystoreDir(options)
  const path = join(dir, KEYSTORE_FILE_NAME)

  let createdAt = new Date().toISOString()
  if (existsSync(path)) {
    try {
      createdAt = readKeystoreFile(options).createdAt ?? createdAt
    } catch {
      // A corrupt existing file must not block writing a fresh one.
    }
  }

  const file = encrypt(
    data,
    passphrase,
    options.scryptParams ?? DEFAULT_SCRYPT_PARAMS,
    createdAt,
  )

  const tmp = `${path}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`
  try {
    writeFileSync(tmp, `${JSON.stringify(file, null, 2)}\n`, {
      mode: KEYSTORE_FILE_MODE,
    })
    chmodSync(tmp, KEYSTORE_FILE_MODE)
    renameSync(tmp, path)
    chmodSync(path, KEYSTORE_FILE_MODE)
  } catch (error) {
    if (existsSync(tmp)) rmSync(tmp, { force: true })
    throw error
  }
  return path
}

/**
 * Decrypt the keystore.
 *
 * @throws {KeystoreNotFoundError} when no keystore exists yet.
 * @throws {KeystoreDecryptionError} when the passphrase is wrong or the file
 * was tampered with. Never returns partially decrypted data.
 */
export function loadKeystore(
  passphrase: string,
  options: KeystoreOptions = {},
): KeystoreData {
  assertPassphrase(passphrase)
  const file = readKeystoreFile(options)
  return decrypt(file, passphrase, keystorePath(options))
}

/**
 * Like {@link loadKeystore}, but returns `null` instead of throwing when there
 * is no keystore yet. Wrong-passphrase and corruption still throw.
 */
export function tryLoadKeystore(
  passphrase: string,
  options: KeystoreOptions = {},
): KeystoreData | null {
  try {
    return loadKeystore(passphrase, options)
  } catch (error) {
    if (error instanceof KeystoreNotFoundError) return null
    throw error
  }
}

/**
 * Read-modify-write under one passphrase. Used to add the session key after the
 * owner key already exists, without ever holding both halves in two files.
 */
export function updateKeystore(
  passphrase: string,
  mutate: (current: KeystoreData) => KeystoreData,
  options: KeystoreOptions = {},
): KeystoreData {
  const current = tryLoadKeystore(passphrase, options) ?? {}
  const next = mutate(current)
  saveKeystore(next, passphrase, options)
  return next
}

/** Verify a passphrase without exposing the plaintext to the caller. */
export function verifyPassphrase(
  passphrase: string,
  options: KeystoreOptions = {},
): boolean {
  try {
    loadKeystore(passphrase, options)
    return true
  } catch (error) {
    if (error instanceof KeystoreDecryptionError) return false
    throw error
  }
}

/** Delete the keystore. Returns false when there was nothing to delete. */
export function deleteKeystore(options: KeystoreOptions = {}): boolean {
  const path = keystorePath(options)
  if (!existsSync(path)) return false
  unlinkSync(path)
  return true
}

/** Permission bits of the keystore file, e.g. `0o600`. */
export function keystoreFileMode(options: KeystoreOptions = {}): number {
  const path = keystorePath(options)
  if (!existsSync(path)) throw new KeystoreNotFoundError(path)
  return statSync(path).mode & 0o777
}

/**
 * Constant-time comparison of two passphrase-ish strings. Exported for the
 * wizard's "confirm your passphrase" step (U7).
 */
export function passphrasesMatch(a: string, b: string): boolean {
  const left = Buffer.from(a.normalize('NFKC'), 'utf8')
  const right = Buffer.from(b.normalize('NFKC'), 'utf8')
  if (left.length !== right.length) return false
  return timingSafeEqual(left, right)
}
