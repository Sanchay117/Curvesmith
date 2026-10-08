import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const directory = path.dirname(fileURLToPath(import.meta.url))
const output = path.join(directory, 'dist/index.mjs')
await build({
    entryPoints: [path.join(directory, 'src/index.ts')],
    outfile: output,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    packages: 'external',
    alias: { '@launchproof/core': path.join(directory, '../core/src/index.ts') },
})
const code = fs.readFileSync(output, 'utf8').replace(/^#!\/usr\/bin\/env tsx/, '#!/usr/bin/env node')
fs.writeFileSync(output, code)
fs.chmodSync(output, 0o755)
