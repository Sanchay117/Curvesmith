# Repository Guidelines

## Project Structure & Module Organization

Launchproof audits Meteora DBC configs with a census, Studio, CLI, and MCP server. Core and MCP use `@launchproof/*`; the npm CLI is `launchproof-dbc` (binary `launchproof`).

- `apps/web/src/` contains React pages and components; `apps/web/public/` holds static assets and the published census.
- `packages/core/src/` owns audit policy, curve math, simulation, registry logic, and transaction builders.
- `packages/cli/src/` and `packages/mcp/src/` expose the core. Build the npm CLI with `pnpm --filter launchproof-dbc build`.
- `packages/core/test/` holds Vitest, LiteSVM, and differential tests; `fixtures/` holds program binaries and account snapshots.

## Build, Test, and Development Commands

Use Node.js 22.

- `pnpm install --frozen-lockfile`: install the workspace.
- `pnpm dev`: serve at `localhost:5173`.
- `pnpm typecheck && pnpm test && pnpm build`: check packages, run core tests, and build `apps/web/dist`. Run before every commit.
- `pnpm --filter @launchproof/core test:watch`: watch core tests.
- `pnpm cli presets` lists templates; `pnpm mcp` starts the MCP server.
- `pnpm snapshot` refreshes the devnet registry snapshot.

## Coding Style & Naming Conventions

Use strict TypeScript and ES modules: four-space indentation, single quotes, no semicolons, and trailing commas in multiline structures. Name React components and types in PascalCase, variables and functions in camelCase, and constants in uppercase snake case. Match nearby code; no formatter is configured.

## Testing Guidelines

Put `*.test.ts` files in `packages/core/test/`. Cover audit rules with golden mainnet fixtures; replay SOL/USDC swaps and assert exact claims. Vitest and LiteSVM tests use local fixtures without network access. Keep tests sequential. CI runs on macOS due to a LiteSVM Linux crash; no coverage threshold is set.

## Commit & Pull Request Guidelines

History uses short subjects without a fixed prefix. Write an imperative subject. PRs should explain the change, link relevant issues, report checks, and include UI screenshots.

## Maintainer Notes & Security

The mainnet census counts observed standard DBC pools, not all launches. It audits the busiest configs, samples 3,000 single-pool configs, and groups pools by fee-claimer address. See `docs/CENSUS.md`; verify the sample and grouping offline with `pnpm cli verify-census apps/web/public/census-mainnet-beta.json --cache .cache/census-v1`. Mint observations inspect one base mint per flagged legacy config, with offline evidence checks. Phase windows separate pool scans from later reads. Policy 2 covers fee splits, LP vesting, token type, and migration terms; policy-1 receipts still verify. Studio Review applies the same audit to compiled designs; its 0-100 grade is only a design heuristic. Earnings claims DBC trading fees; simulated outcomes are labeled separately.

Preserve the CSR-1 seed `curvesmith:registry:v1`. Develop on devnet. Never commit `.keys/` or secrets. Do not access wallets, send transactions, edit `video/`, or push. `VITE_RPC_DEVNET` and `VITE_RPC_MAINNET` are public browser build settings.
