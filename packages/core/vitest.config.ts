import { defineConfig } from 'vitest/config'

// The differential and lifecycle suites each spin up several LiteSVM instances that load the
// DBC, DAMM v2 and Metaplex binaries. Running files in parallel workers exhausts memory on
// small CI runners (std::bad_alloc), so run them sequentially in one forked process.
export default defineConfig({
    test: {
        pool: 'forks',
        fileParallelism: false,
        testTimeout: 60_000,
    },
})
