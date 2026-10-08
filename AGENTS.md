# Repository Guidelines

## Project Structure & Module Organization

Launchproof is an audit, census, and launch toolkit for Meteora DBC. Workspace packages use the `@launchproof/*` namespace.

- `apps/web/src/`: React pages, components, client utilities, and styles; `apps/web/public/` holds static assets and registry snapshots.
- `packages/core/src/`: curve compilation, simulation, analysis, registry logic, and transaction builders. Keep shared domain logic here so all clients use the same implementation.
- `packages/cli/src/` and `packages/mcp/src/`: command-line and MCP entry points.
- `packages/core/test/`: unit, differential, and lifecycle tests; `fixtures/` contains program binaries and account snapshots.
- `docs/`: architecture and CSR-1 registry documentation; `deployments/devnet.json` records demo deployment addresses.

## Build, Test, and Development Commands

Use Node.js 22 to match CI and the pnpm version pinned in `package.json`.

- `pnpm install --frozen-lockfile`: install workspace dependencies reproducibly.
- `pnpm dev`: start the web app at `http://localhost:5173`.
- `pnpm build`: type-check the web app and build into `apps/web/dist`.
- `pnpm typecheck`: check every workspace package.
- `pnpm test`: run the core Vitest suite.
- `pnpm --filter @launchproof/core test:watch`: run tests in watch mode.
- `pnpm cli presets`: list preset templates; `pnpm mcp` starts the MCP server.
- `pnpm snapshot`: refresh `apps/web/public/registry-devnet.json` from RPC before deployment.

## Coding Style & Naming Conventions

Use strict TypeScript and ES modules. Match existing code: four-space indentation, single-quoted strings, no statement-ending semicolons, and trailing commas in multiline structures. Use PascalCase for React component files and types, camelCase for functions and variables, and uppercase snake case for constants. No repository-wide ESLint or Prettier configuration is present; follow adjacent code and run type checks.

## Testing Guidelines

Name tests `*.test.ts` under `packages/core/test/`. Add regression cases for changed behavior, including seeded differential tests for simulator math and lifecycle tests for migration changes. Tests use Vitest and LiteSVM with local fixtures; no network is required. Preserve sequential execution to limit memory use. CI runs tests on macOS because of a documented LiteSVM Linux crash. No coverage threshold is configured.

## Commit & Pull Request Guidelines

Existing commits use short, informal subjects without a standardized prefix. Prefer concise, imperative descriptions of the actual change. PRs should explain motivation, link relevant issues, report validation commands and results, and include screenshots for UI changes.

## Maintainer Notes

The mainnet census is a snapshot of observed standard DBC pool accounts, not all launches. Its method and exclusions are in `docs/CENSUS.md`; the compact report and evidence archive are in `apps/web/public/`. The auditor reviews configured terms, not issuer identity or investment safety. Keep the CSR-1 seed `curvesmith:registry:v1` unchanged so existing listings remain readable. For this submission, keep wallets and `.keys/` untouched, do not send transactions or edit `video/`, and run `pnpm typecheck && pnpm test && pnpm build` before each commit.

## Security & Configuration

Use devnet for development. Never commit `.keys/`, keypair files, or secrets. `VITE_RPC_DEVNET` and `VITE_RPC_MAINNET` configure browser RPC defaults at build time; their values are public in the built app.
