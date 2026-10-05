import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// The Solana / Anchor / DBC SDK stack expects Node's `Buffer` and `global` in the browser.
// src/polyfills.ts installs Buffer before anything else loads; `global` is aliased here.
export default defineConfig({
    // relative base so the static build works from any path (GitHub Pages, IPFS, a subfolder)
    base: './',
    plugins: [react(), tailwindcss()],
    define: { global: 'globalThis', 'process.env.NODE_DEBUG': 'false' },
    resolve: { alias: { buffer: 'buffer/' } },
    optimizeDeps: { esbuildOptions: { define: { global: 'globalThis' } } },
    build: {
        target: 'es2022',
        chunkSizeWarningLimit: 4000,
    },
    server: { port: 5173 },
})
