import { cancelledError } from './errors.js'

/**
 * The prompt surface, behind an interface.
 *
 * `@clack/prompts` owns a real terminal: it takes over stdin, hides the cursor,
 * and paints escape sequences. None of that can run inside `bun test`, and a
 * wizard that can only be exercised by a human is a wizard whose resume logic is
 * never tested. So every question the CLI asks goes through {@link Prompter},
 * the real implementation lazily imports clack, and the test suite supplies a
 * scripted one.
 *
 * The lazy import is also a startup-cost decision: `giwacard status` on a
 * configured machine asks nothing, and should not pay to load a prompt library.
 */

/** A choice in a `select`. */
export interface PromptOption<T> {
  value: T
  label: string
  hint?: string
}

export interface TextPromptOptions {
  message: string
  placeholder?: string
  initialValue?: string
  /** Return a string to reject the answer and re-ask. */
  validate?: (value: string) => string | undefined
}

export interface PasswordPromptOptions {
  message: string
  validate?: (value: string) => string | undefined
}

export interface ConfirmPromptOptions {
  message: string
  initialValue?: boolean
}

export interface SelectPromptOptions<T> {
  message: string
  options: readonly PromptOption<T>[]
  initialValue?: T
}

/** A spinner. `stop` is always called, including on the failure path. */
export interface PromptSpinner {
  start(message?: string): void
  /** Update the label without restarting the animation. */
  message(message: string): void
  stop(message?: string, code?: number): void
}

/**
 * Everything the wizard and the commands may ask a human.
 *
 * Deliberately small. Each method either returns an answer or throws
 * {@link cancelledError} — there is no `symbol` sentinel to forget to check,
 * which is the one mistake clack's own API makes easy.
 */
export interface Prompter {
  intro(title: string): void
  outro(message: string): void
  note(message: string, title?: string): void
  info(message: string): void
  warn(message: string): void
  error(message: string): void
  success(message: string): void
  text(options: TextPromptOptions): Promise<string>
  password(options: PasswordPromptOptions): Promise<string>
  confirm(options: ConfirmPromptOptions): Promise<boolean>
  select<T>(options: SelectPromptOptions<T>): Promise<T>
  spinner(): PromptSpinner
  /** False when nothing may be asked — a pipe, or `--yes`. */
  readonly interactive: boolean
}

/* -------------------------------------------------------------------------- */
/* clack-backed implementation                                                */
/* -------------------------------------------------------------------------- */

type ClackModule = typeof import('@clack/prompts')

let clackPromise: Promise<ClackModule> | null = null

/** Load `@clack/prompts` once, on first use. */
async function clack(): Promise<ClackModule> {
  clackPromise ??= import('@clack/prompts')
  return clackPromise
}

/**
 * Turn clack's cancel sentinel into a thrown {@link cancelledError}.
 *
 * clack returns a `symbol` when the user hits Ctrl-C, and a caller that forgets
 * to check gets that symbol as if it were an answer — an address, a passphrase,
 * a policy number. Funnelling every answer through here makes that impossible.
 */
function unwrap<T>(value: T | symbol, isCancel: (v: unknown) => boolean): T {
  if (isCancel(value)) throw cancelledError()
  return value as T
}

/**
 * Adapt a validator to clack's signature.
 *
 * clack hands the validator `string | undefined` (the field can be empty) while
 * every caller here is written against `string`. Normalising the `undefined` to
 * `''` in one place keeps the empty-input case from being a per-prompt `?? ''`
 * that someone eventually forgets.
 */
function adaptValidate(
  validate: ((value: string) => string | undefined) | undefined,
): ((value: string | undefined) => string | Error | undefined) | undefined {
  if (validate === undefined) return undefined
  return (value) => validate(value ?? '')
}

/** The real, terminal-driving {@link Prompter}. */
export class ClackPrompter implements Prompter {
  readonly interactive = true

  intro(title: string): void {
    void clack().then((c) => c.intro(title))
  }

  outro(message: string): void {
    void clack().then((c) => c.outro(message))
  }

  note(message: string, title?: string): void {
    void clack().then((c) => c.note(message, title))
  }

  info(message: string): void {
    void clack().then((c) => c.log.info(message))
  }

  warn(message: string): void {
    void clack().then((c) => c.log.warn(message))
  }

  error(message: string): void {
    void clack().then((c) => c.log.error(message))
  }

  success(message: string): void {
    void clack().then((c) => c.log.success(message))
  }

  async text(options: TextPromptOptions): Promise<string> {
    const c = await clack()
    const answer = await c.text({
      message: options.message,
      ...(options.placeholder !== undefined
        ? { placeholder: options.placeholder }
        : {}),
      ...(options.initialValue !== undefined
        ? { initialValue: options.initialValue }
        : {}),
      ...(options.validate !== undefined
        ? { validate: adaptValidate(options.validate) }
        : {}),
    })
    return unwrap(answer, c.isCancel)
  }

  async password(options: PasswordPromptOptions): Promise<string> {
    const c = await clack()
    const answer = await c.password({
      message: options.message,
      ...(options.validate !== undefined
        ? { validate: adaptValidate(options.validate) }
        : {}),
    })
    return unwrap(answer, c.isCancel)
  }

  async confirm(options: ConfirmPromptOptions): Promise<boolean> {
    const c = await clack()
    const answer = await c.confirm({
      message: options.message,
      ...(options.initialValue !== undefined
        ? { initialValue: options.initialValue }
        : {}),
    })
    return unwrap(answer, c.isCancel)
  }

  async select<T>(options: SelectPromptOptions<T>): Promise<T> {
    const c = await clack()
    const answer = await c.select<T>({
      message: options.message,
      // clack's `Option<Value>` is a conditional type that TypeScript cannot
      // resolve against an unbound `T`. The shape is structurally identical
      // either way, so the cast is erasure, not a claim.
      options: options.options.map((option) => ({
        value: option.value,
        label: option.label,
        ...(option.hint !== undefined ? { hint: option.hint } : {}),
      })) as never,
      ...(options.initialValue !== undefined
        ? { initialValue: options.initialValue }
        : {}),
    })
    return unwrap(answer, c.isCancel)
  }

  spinner(): PromptSpinner {
    // clack's spinner is created eagerly by its own API, so the handle is
    // buffered until the module resolves. Calls made before then are replayed in
    // order, which keeps `start(); message(); stop()` correct either way.
    let handle: ReturnType<ClackModule['spinner']> | null = null
    const queue: ((s: ReturnType<ClackModule['spinner']>) => void)[] = []
    const ready = clack().then((c) => {
      handle = c.spinner()
      for (const action of queue.splice(0)) action(handle)
      return handle
    })
    const run = (action: (s: ReturnType<ClackModule['spinner']>) => void) => {
      if (handle) action(handle)
      else {
        queue.push(action)
        void ready
      }
    }
    return {
      start: (message) => run((s) => s.start(message)),
      message: (message) => run((s) => s.message(message)),
      // A non-zero code means the step failed, which clack renders with its own
      // error symbol rather than the success tick `stop` would use.
      stop: (message, code) =>
        run((s) => (code ? s.error(message) : s.stop(message))),
    }
  }
}

/* -------------------------------------------------------------------------- */
/* Non-interactive implementation                                             */
/* -------------------------------------------------------------------------- */

/**
 * A {@link Prompter} that refuses to ask anything.
 *
 * Used when stdin is not a TTY. Every question throws instead of hanging
 * forever waiting on a pipe that will never answer — a CI run that quietly
 * blocks is worse than one that fails with a sentence naming the flag it needed.
 */
export class NonInteractivePrompter implements Prompter {
  readonly interactive = false
  readonly #log: (message: string) => void

  constructor(log: (message: string) => void = () => {}) {
    this.#log = log
  }

  intro(title: string): void {
    this.#log(title)
  }
  outro(message: string): void {
    this.#log(message)
  }
  note(message: string, title?: string): void {
    this.#log(title === undefined ? message : `${title}: ${message}`)
  }
  info(message: string): void {
    this.#log(message)
  }
  warn(message: string): void {
    this.#log(message)
  }
  error(message: string): void {
    this.#log(message)
  }
  success(message: string): void {
    this.#log(message)
  }

  #refuse(message: string): never {
    throw cancelledError(
      `giwacard needs an answer to "${message}" but stdin is not a terminal.`,
    )
  }

  text(options: TextPromptOptions): Promise<string> {
    return this.#refuse(options.message)
  }
  password(options: PasswordPromptOptions): Promise<string> {
    return this.#refuse(options.message)
  }
  confirm(options: ConfirmPromptOptions): Promise<boolean> {
    return this.#refuse(options.message)
  }
  select<T>(options: SelectPromptOptions<T>): Promise<T> {
    return this.#refuse(options.message)
  }

  spinner(): PromptSpinner {
    return {
      start: (message) => {
        if (message !== undefined) this.#log(message)
      },
      message: (message) => this.#log(message),
      stop: (message) => {
        if (message !== undefined) this.#log(message)
      },
    }
  }
}
