# Repository Guidelines

## Project Structure & Module Organization

Launchproof is a launch-economics studio for Meteora DBC. Workspace packages currently use the `@launchproof/*` namespace.

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

## Handoff Log

Work since the rename from Curvesmith (a same-name, same-concept entry exists at github.com/zxreigns/curvesmith, so the project was repositioned around auditing):

- **Rename (commit 1002e43 and after):** product, packages (`@launchproof/*`), CLI binary, MCP server name, env vars (`LAUNCHPROOF_RPC_*`) and preset schema (`launchproof/preset@1`). The registry seed stays `curvesmith:registry:v1` so existing CSR-1 listings remain valid.
- **Audit-first app (Codex):** the State of DBC report is the home page (`Report.tsx`, data in `apps/web/public/census-mainnet-beta.json` plus a gzipped evidence archive), a direct config auditor (`Audit.tsx`), downloadable audit receipts (`core/src/receipt.ts`), CLI `census`, `audit`, `verify-receipt` and `verify-census`, and an MCP audit tool. See `docs/CENSUS.md` for method and coverage.
- **Auditor fixes (Codex):** quote mints other than SOL/USDC are no longer treated as SOL; dynamic-supply buffers burned at migration are no longer reported as withdrawable leftover supply; the migration flag offset is pinned by the lifecycle test.
- **Web fixes:** mainnet uses a CORS-friendly RPC (api.mainnet-beta.solana.com rejects browser origins), pasting a config address audits it, a just-published preset no longer flashes as "Unlisted" while the snapshot is stale, deploy now depends on passing tests.
- **Brand:** violet accent on cool neutrals and a check-curve mark (`Layout.tsx`, `public/favicon.svg`, `public/og.svg` rendered to `og.png`), distinct from the other Curvesmith's orange.
- **CLI:** `keygen` honours `-k`, relative `-k` paths resolve from the caller's directory, and `publish` takes `--raise <amount>` and `--name <name>`. The whole mainnet sequence (publish with `--raise 0.25`, launch, buy to graduation, graduate, claim twice) was rehearsed on devnet: about 0.30 SOL including the 0.25 raise.
- **Validation:** `pnpm typecheck`, `pnpm test` (51 tests) and `pnpm build` pass.

Open items: mainnet presets and one full mainnet lifecycle (author's wallet), `deployments/mainnet.json` plus a mainnet registry snapshot, regenerating the demo video for the new name and audit-first story (pipeline in the gitignored `video/` folder), and the X thread and Superteam submission (deadline 2026-10-13 06:59 UTC).

## Security & Configuration

Use devnet for development. Never commit `.keys/`, keypair files, or secrets. `VITE_RPC_DEVNET` and `VITE_RPC_MAINNET` configure browser RPC defaults at build time; their values are public in the built app.
