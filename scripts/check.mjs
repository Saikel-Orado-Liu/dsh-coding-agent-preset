import { readdirSync, statSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { join, relative } from 'node:path'

const root = fileURLToPath(new URL('..', import.meta.url))
const roots = ['packages', 'tests']
const files = []

function collect(dir) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    const stat = statSync(full)
    if (stat.isDirectory()) {
      if (entry === 'node_modules') continue
      collect(full)
    } else if (/\.(?:[cm]?js)$/.test(entry)) {
      files.push(full)
    }
  }
}

for (const r of roots) {
  const full = join(root, r)
  if (statSync(full, { throwIfNoEntry: false })) collect(full)
}

let failed = false
for (const file of files) {
  const rel = relative(root, file)
  const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' })
  if (result.status === 0) {
    console.log(`OK ${rel}`)
  } else {
    failed = true
    console.error(`FAIL ${rel}`)
    console.error(result.stderr || result.stdout)
  }
}

if (failed) {
  process.exit(1)
}

console.log(`All JS/MJS syntax OK (${files.length} files).`)
