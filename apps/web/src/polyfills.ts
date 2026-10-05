// Must be the first import of main.tsx: web3.js, Anchor and the DBC SDK read Buffer at load time.
import { Buffer } from 'buffer'

const g = globalThis as unknown as { Buffer?: typeof Buffer; process?: { env: Record<string, string> } }
g.Buffer ??= Buffer
g.process ??= { env: {} }
