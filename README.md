# Launchproof

**Read the terms. Before the launch.**

Launchproof is a configuration review and launch toolkit for Meteora's Dynamic Bonding Curve. It turns on-chain permissions into readable terms: who can mint, who can withdraw liquidity, how supply is allocated, and which asset a launch actually raises.

[App](https://sanchay117.github.io/Launchproof/) · [State of DBC](https://sanchay117.github.io/Launchproof/#/report) · [Methodology](docs/CENSUS.md) · [Developer guide](docs/GUIDE.md)

## Start with evidence

The **State of DBC** report scans existing standard mainnet DBC pool accounts, ranks their configs by observed pool count, and reviews the most-used configs. The page shows its observation window, audit coverage, excluded accounts, and any evaluation failures. Download its JSON and source account archive to inspect the results.

A **configuration audit** reads a config directly without a wallet or registry listing. It reports fee splits, LP vesting, token type, receiver addresses, and migration terms, and supports custom quote mints without mislabeling them SOL. Download an audit receipt containing the account bytes, SHA-256 hash, slot, and review results; reproduce it offline with the CLI. Policy-1 receipts remain verifiable after the policy-2 expansion.

A migration flag is a state transition, not evidence of demand, unique users, volume, or misconduct. These checks describe configured permissions and economic terms, not issuer trustworthiness or investment safety. See the [scope and reproducibility limits](docs/CENSUS.md).

## Then build a better launch

- **Studio:** eight curve families, fee schedules, LP locks and vesting, creator allocations, and DAMM v2 migration settings.
- **Simulation:** seeded market scenarios using official SDK quote math and modeled pool state transitions. Differential tests compare covered cases against real DBC program execution in LiteSVM.
- **Presets:** publish a DBC config and list it in the CSR-1 on-chain registry. Authors receive the partner fees configured for pools launched from their presets.
- **Lifecycle:** launch with a bundled first buy, trade, migrate into DAMM v2, and claim fees. Existing demonstration deployments are on devnet; addresses are in [deployments/devnet.json](deployments/devnet.json).
- **Developer tools:** shared TypeScript core, CLI, read-only audits, MCP transaction builders, and a graduation keeper.

The Studio and trading interface support SOL/USDC quotes, time-based fees, and DAMM v2 migration. The raw configuration audit can review additional quote assets and fee modes without pretending the simulator supports them.

## Run locally

Use Node.js 22 and the pnpm version pinned in `package.json`.

```bash
pnpm install --frozen-lockfile
pnpm dev            # http://localhost:5173
pnpm typecheck      # all workspace packages
pnpm test           # offline unit, differential, and lifecycle tests
pnpm build          # apps/web/dist
```

Tests run sequentially on macOS in CI because the pinned LiteSVM Linux build has a documented native-memory failure. Deployment requires passing tests and a production build.

## Reproduce the report

```bash
# Read-only: no keypair or SOL required. Full scans can download hundreds of MB.
pnpm cli -n mainnet-beta census --limit 5000 --tail-sample 3000 --cache .cache/census-new
# Resume a partially completed collection, or recompute from a complete archive:
pnpm cli -n mainnet-beta census --limit 5000 --tail-sample 3000 --cache .cache/census-new --resume
pnpm cli -n mainnet-beta census --limit 5000 --tail-sample 3000 --cache .cache/census-new --offline

pnpm cli -n mainnet-beta audit <config-address>
pnpm cli verify-receipt <downloaded-receipt.json>
pnpm cli verify-census apps/web/public/census-mainnet-beta.json --cache .cache/census-new
pnpm cli inspect fair-meme
```

`census` defaults to devnet like the rest of the CLI; explicitly select `-n mainnet-beta` for the mainnet report. Supply `-u <rpc-url>` before the command if the public endpoint limits scans. The raw archive stays local in `.cache/`; the compact report and selected account evidence ship in `apps/web/public/`.

## Try the lifecycle on devnet

Open **Reference configs**, connect a Devnet Burner wallet, fund it through the network menu or [Solana's faucet](https://faucet.solana.com), then choose **Micro Speedrun**. Launch, buy until the curve completes, migrate into DAMM v2, and inspect Earnings. Devnet tokens have no monetary value.

```bash
pnpm cli presets
pnpm cli keygen
pnpm cli airdrop 1
pnpm cli publish speedrun
pnpm snapshot       # refresh the devnet marketplace snapshot
```

Other commands include `launch`, `buy`, `sell`, `status`, `graduate`, `claim`, and `keeper`. Transactions require a funded signer. Keep private keys in ignored files; the read-only census and audit never need them.

## Agents and integration

```json
{
  "mcpServers": {
    "launchproof": {
      "command": "pnpm",
      "args": ["--dir", "/absolute/path/to/Launchproof", "mcp"]
    }
  }
}
```

The MCP exposes `audit_config`, `inspect_config`, template evaluation and simulation, market/pool reads, and unsigned publish, launch, and swap transaction builders. It does not expose migrate or claim builders. Builders return transactions for an external wallet to sign. RPC overrides: `LAUNCHPROOF_RPC_DEVNET` and `LAUNCHPROOF_RPC_MAINNET`. Browser defaults use `VITE_RPC_DEVNET` and `VITE_RPC_MAINNET`; these values are public in the bundle.

## Repository map

| Path | Purpose |
| --- | --- |
| `packages/core/src/` | Config audits, receipts, curve math, simulation, registry, transaction builders |
| `packages/core/test/` | Regression tests and LiteSVM fixtures |
| `packages/cli/src/` | CLI and reproducible census collector |
| `packages/mcp/src/` | MCP tools |
| `apps/web/` | React/Vite static frontend and report artifacts |
| `docs/CENSUS.md` | Data methodology, policy, and limitations |

Launchproof was developed under the working name Curvesmith. Package names and branding changed; the CSR-1 seed `curvesmith:registry:v1` and `csr1:` memo prefix remain unchanged so existing listings continue to resolve. [Registry specification](docs/CSR-1.md).

## License

MIT. See [LICENSE](LICENSE). Program binary fixtures are upstream Meteora artifacts used for integration tests; their upstream licensing applies.
