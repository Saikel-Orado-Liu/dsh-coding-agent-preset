#!/usr/bin/env node
// Auto-install helper for DSH Coding Agent Preset.
//
// When this package is installed as a dependency of a DSH web profile (or any
// profile), pnpm runs this script from `postinstall`. It:
//   1. Copies `presets/coding` into `<dshHome>/.agent-presets/coding`.
//   2. Copies the two internal packages into `<dshHome>/profiles/node_modules`,
//      which is the resolution base for preset rows.
//
// This makes `dsh plugin --profile web add @gamegeek-saikel/dsh-coding-preset`
// install both the profile dependency and the actual preset files automatically.

import { cp, mkdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const packageRoot = fileURLToPath(new URL('..', import.meta.url))
const dshHome = process.env.DSH_HOME || join(homedir(), '.dsh')

const targets = [
  {
    from: join(packageRoot, 'presets', 'coding'),
    to: join(dshHome, '.agent-presets', 'coding'),
    label: 'preset',
  },
  {
    from: join(packageRoot, 'packages', 'dsh-terminal-pwsh'),
    to: join(dshHome, 'profiles', 'node_modules', 'dsh-terminal-pwsh'),
    label: 'package dsh-terminal-pwsh',
  },
  {
    from: join(packageRoot, 'packages', 'dsh-tool-pwsh-persistent'),
    to: join(dshHome, 'profiles', 'node_modules', 'dsh-tool-pwsh-persistent'),
    label: 'package dsh-tool-pwsh-persistent',
  },
]

for (const target of targets) {
  if (!existsSync(target.from)) {
    console.error(`[dsh-coding-preset] missing source: ${target.from}`)
    process.exitCode = 1
    continue
  }
  await mkdir(dirname(target.to), { recursive: true })
  await cp(target.from, target.to, { recursive: true, force: true })
  console.log(`[dsh-coding-preset] installed ${target.label} -> ${target.to}`)
}

if (process.exitCode) {
  console.error('[dsh-coding-preset] auto-install failed')
} else {
  console.log('[dsh-coding-preset] auto-install complete')
}
