# Curvesmith

**Launch economics, designed and proven.** A studio, simulator and on-chain marketplace for Meteora's Dynamic Bonding Curve (DBC).

Design a launch curve visually, test it against snipers and crowds with the DBC program's own math (verified against the real program binary), publish it as a real DBC config that pays you partner fees, and let anyone launch, trade and graduate tokens from it into DAMM v2. Everything is also available to AI agents through an MCP server and to developers through a TypeScript library and CLI.

> Built for the Meteora "Best use of DBC" bounty (Crypto World's Fair, Solana). Runs on devnet out of the box; mainnet is one toggle away.

---

## The problem

DBC is the most configurable launch primitive on Solana: up to 16 curve segments, time-decaying and volatility-aware fees, graduation fees, LP locks and vesting, creator allocations, Token-2022 and custom DAMM v2 pool fees. But a DBC config is about forty raw numbers (Q64.64 square-root prices, u128 liquidities, fee numerators). Today every launchpad hand-tunes those numbers, deploys them blind, and creators and traders have no way to see what a config actually does until money is on the line.

We pointed the toolkit at live mainnet launchpad configs and it immediately surfaced terms no user would see from a launch page, for example a config that sells 7% of supply on the curve, pairs 3% in the pool, and leaves **90% of the supply to its own fee wallet after graduation**, with 89% of the graduated LP withdrawable on day one:

```
$ pnpm cli -n mainnet-beta inspect 2bFH5q216w51UopEZP359NGGSUUeCwmycoBzP8Jc83at
Imported config  [F 12/100]
  supply            7.1% sold on curve, 2.9% to LP, 0% creator
  review
   [critical] 90% of supply goes to the leftover receiver
   [warning]  No anti-sniper fee
   [warning]  89% of graduated liquidity is withdrawable on day one
```

## What Curvesmith does

| | |
|---|---|
| **Design** | Pick a price path (constant product, linear, exponential, power, S-curve, flat, stepped tranches, or drag a freehand curve) plus market caps, fees, graduation terms and LP ownership. A compiler turns it into an exact 16-segment DBC config. |
| **Simulate** | Agent-based market replays (sniper rush, organic crowd, whale, panic, slow grind) on a pool model that matches the on-chain program bit for bit. See sniper ROI, graduation time, fee split and the DAMM v2 pool you graduate into. |
| **Review** | Protocol validation (what `create_config` would reject) plus economic lints the chain happily accepts: no sniper tax, withdrawable LP, thin graduated pools, retained mint authority, hidden leftover supply. A 0-100 launch health score. |
| **Publish** | One click creates a DBC config owned by your wallet (you are the partner and fee claimer) and lists it in an on-chain registry. Every token launched from your preset pays you its partner trading fees. |
| **Marketplace** | Browse presets with live on-chain stats (launches, graduation rate, fees generated), fork any of them, or paste **any DBC config address** from any launchpad to audit it. |
| **Launch and trade** | Launch a token from any preset with a bundled first buy, trade with exact quotes, crank graduation into DAMM v2 (permissionless), and claim author and creator fees. |
| **Agents and developers** | `@curvesmith/core` library, a CLI, and an MCP server with 12 tools so AI agents can design, simulate, review and build transactions for DBC launches. Meteora's own MCP is docs-only; this one acts. |

## How it maps to what Meteora asked for

| Meteora's wish list | Curvesmith |
|---|---|
| DBC configuration preset marketplace | Core product: an on-chain preset registry (CSR-1) where authors earn the partner fees of every launch from their preset |
| Novel curve or fee configurations (flat, exponential, long curves) | Eight curve families compiled to DBC segments, including flat NAV sales, IPO-style tranches, S-curves and freehand; eight curated templates |
| Launch mechanics optimized for equity / stock launches, RWAs | `NAV Subscription` (fixed-price USDC sale, issuer metadata authority) and `Equity Tranches` (four priced tranches, team vesting, LP vesting) |
| End-to-end launch flows integrating DBC and DAMM v2 | Publish, launch, trade, graduate into DAMM v2 and claim, all in the app, CLI and MCP |
| Developer tooling for trading terminals | Exact quote engine (`quoteSwap`) shared by the UI, CLI and MCP; config auditor; keeper that graduates completed pools |
| AI applications | MCP server; `Agent Treasury` template routes curve and graduation fees to an agent's wallet |

## Proof: it matches the real program

The simulator is only useful if it is exactly right, so the test suite runs Meteora's actual DBC, DAMM v2 and Metaplex program binaries inside [LiteSVM](https://github.com/LiteSVM/litesvm), an in-process Solana VM:

- **Config parity**: for every curve family, the config account the DBC program writes is compared field by field with Curvesmith's off-chain derivation.
- **Swap replay**: 60 seeded random buys and sells (fee decay, dynamic fees, sells, partial fills at graduation) run on both the simulator and the real program; price, reserves, every fee bucket and the volatility tracker must match to the lamport after every swap.
- **Full lifecycle**: publish, launch with a min-fee creator first buy, trade to graduation, permissionless migration into a real DAMM v2 pool (opening price must equal the final curve price; deposited quote within 0.01% of prediction), and a partner fee claim.
- **Dynamic supply**: the minted supply of other launchpads' dynamic-supply configs matches Curvesmith's model exactly, so audits of foreign configs are accurate.

```
pnpm test        # 40 tests, about 3 seconds, no network needed
```

## Devnet deployment

All eight library presets are published and listed on devnet, with demo tokens launched and one taken all the way through graduation into DAMM v2. Addresses are in [`deployments/devnet.json`](deployments/devnet.json).

| | |
|---|---|
| DBC program | `dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN` |
| DAMM v2 program | `cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG` |
| Curvesmith registry (CSR-1) | `3cjzSdeXvwoke4238hghUi6dzo7cNhousyR19mNjzsBR` |

## Quick start

Requirements: Node 20+, pnpm.

```bash
pnpm install
pnpm dev          # the web app at http://localhost:5173
pnpm test         # differential and lifecycle tests on the real programs
```

Use a wallet set to devnet (Phantom: Settings, Developer settings, Testnet mode). Get devnet SOL from https://faucet.solana.com.

### CLI

```bash
pnpm cli presets                                   # library templates with grades
pnpm cli inspect fair-meme                         # analyze, simulate and lint a template
pnpm cli -n mainnet-beta inspect <config-address>  # audit any DBC config on chain
pnpm cli keygen && pnpm cli airdrop 1              # devnet wallet in .keys/ (gitignored)
pnpm cli publish speedrun                          # create config + registry listing
pnpm cli list                                      # read the registry
pnpm cli launch <config> --name "My Token" --symbol MINE --buy 0.1
pnpm cli buy <pool> 0.5 | pnpm cli sell <pool> all
pnpm cli status <pool> | pnpm cli graduate <pool> | pnpm cli claim <pool>
pnpm cli keeper                                    # graduate every completed pool of listed presets
```

### MCP server (for Claude and other agents)

```json
{
  "mcpServers": {
    "curvesmith": { "command": "pnpm", "args": ["--dir", "/path/to/Meteora-DBC", "mcp"] }
  }
}
```

Tools: `list_templates`, `get_template`, `evaluate_preset`, `simulate_preset`, `compare_presets`, `inspect_config`, `list_marketplace`, `pool_status`, `quote_swap`, `build_publish_transactions`, `build_launch_transaction`, `build_swap_transaction`. The server never sees a private key: write tools return base64 transactions for the agent's wallet to sign.

## Architecture

```
packages/core     @curvesmith/core: everything that matters, framework free
  preset.ts         PresetSpec: the human-level description of a launch
  curve.ts          shape -> 16-segment DBC curve compiler (+ curve sampling)
  onchain.ts        ConfigParameters -> the PoolConfig account the program writes
  sim/pool.ts       SimPool: stateful DBC pool, SDK quote math + ported state transition
  sim/scenario.ts   seeded agent-based market scenarios
  sim/migration.ts  graduation prediction (DAMM v2 amounts, fees, surplus, LP split)
  analysis.ts       headline economics       lint.ts   findings + health score
  registry.ts       CSR-1 on-chain registry   chain.ts  tx builders + live stats
  test/             LiteSVM harness, differential, lifecycle and unit tests
packages/cli      curvesmith CLI (and the devnet seed script)
packages/mcp      MCP server
apps/web          React app: Marketplace, Studio, preset pages, Launch, Token, Earnings
```

The app is a static site with no backend: the chain is the database. See [docs/GUIDE.md](docs/GUIDE.md) for a full walkthrough of the design, the math, and every trade-off, and [docs/CSR-1.md](docs/CSR-1.md) for the registry spec.

## Limitations

- Simulations model market behaviour with simple agents. They are exact about what the pool does for a given sequence of trades, not predictions of what people will do.
- The registry is read with `getSignaturesForAddress` plus one transaction fetch per listing. That is fine for thousands of listings; a cached indexer would sit in front beyond that. Public mainnet RPCs throttle these reads; set your own endpoint in the network menu.
- Token metadata URIs are supplied by the creator; the app does not host images.
- Transfer-hook (Token-2022) pools and token-badge quote mints are supported by DBC but not exposed in the Studio yet.

## License

MIT
