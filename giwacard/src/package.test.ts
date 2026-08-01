import { describe, expect, test } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { MINIMUM_NODE_VERSION } from './daemon/errors.js'
import { VERSION } from './version.js'

/**
 * What the published tarball has to contain and refuse.
 *
 * These are not stylistic manifest checks. Each one corresponds to a way the
 * package installed cleanly and then did not work:
 *
 * - `engines.node` said `>=20`, which installs on a runtime with no embedded
 *   SQLite. In-policy minting works there, so nothing looks wrong until the
 *   first over-policy request, at which point the whole approval flow fails.
 * - `files` was `["dist"]`, so `skill/SKILL.md` and `llms-install.md` — the two
 *   documents the `npx giwacard` onboarding story is built on — were never
 *   shipped. An agent told to read them from the installed package found
 *   nothing.
 */

const ROOT = join(import.meta.dir, '..')

interface Manifest {
  name: string
  version: string
  engines: { node: string }
  files: string[]
  bin: Record<string, string>
}

function manifest(): Manifest {
  return JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as Manifest
}

/** The agent-facing documents, relative to the package root. */
const AGENT_DOCS = ['skill/SKILL.md', 'llms-install.md'] as const

describe('package.json', () => {
  test('requires the Node the approval daemon actually needs', () => {
    expect(manifest().engines.node).toBe(`>=${MINIMUM_NODE_VERSION}`)
  })

  test('ships the two documents the onboarding story depends on', () => {
    const { files } = manifest()
    for (const doc of AGENT_DOCS) {
      // Either the exact path or the directory containing it is enough for npm.
      const included = files.some(
        (entry) => entry === doc || doc.startsWith(`${entry}/`),
      )
      expect(included).toBe(true)
      expect(existsSync(join(ROOT, doc))).toBe(true)
    }
  })

  test('the version constant and the manifest agree', () => {
    expect(manifest().version).toBe(VERSION)
  })
})

describe('the shipped documents', () => {
  test('SKILL.md carries the frontmatter a skill loader reads', () => {
    const skill = readFileSync(join(ROOT, 'skill/SKILL.md'), 'utf8')
    expect(skill.startsWith('---\n')).toBe(true)
    expect(skill).toContain('name: giwacard')
    expect(skill).toContain('description:')
  })

  test('every tool the docs name is one the server advertises', async () => {
    // Cheap guard against the docs and the surface drifting apart again: the
    // seven tool names must each appear in both documents' tool tables.
    const { GIWACARD_TOOL_NAMES } = await import('./mcp/tools/index.js')
    const skill = readFileSync(join(ROOT, 'skill/SKILL.md'), 'utf8')
    const runbook = readFileSync(join(ROOT, 'llms-install.md'), 'utf8')
    for (const name of GIWACARD_TOOL_NAMES) {
      expect(skill).toContain(name)
      expect(runbook).toContain(name)
    }
  })
})
