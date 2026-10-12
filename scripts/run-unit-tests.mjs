import { readdir } from 'node:fs/promises'
import { createRequire } from 'node:module'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

const require = createRequire(import.meta.url)
const root = path.resolve(import.meta.dirname, '..')

async function collectTests(directory) {
  const entries = await readdir(directory, { withFileTypes: true })
  const groups = await Promise.all(
    entries.map(async (entry) => {
      const file = path.join(directory, entry.name)
      if (entry.isDirectory()) return collectTests(file)
      return /\.test\.tsx?$/.test(entry.name) ? [file] : []
    })
  )
  return groups.flat()
}

const files = (await collectTests(path.join(root, 'src'))).sort()
if (!files.length) throw new Error('No unit test files found in src.')
const result = spawnSync(
  process.execPath,
  [require.resolve('tsx/cli'), '--test', ...files],
  {
    cwd: root,
    stdio: 'inherit'
  }
)
if (result.error) throw result.error
process.exit(result.status ?? 1)
