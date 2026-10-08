# Launchproof: the complete guide

For census methodology, limitations, and receipt verification, start with [CENSUS.md](CENSUS.md). This document explains the project end to end for someone who knows computer science but is new to Solana and DeFi: the concepts, the idea, the architecture, how each piece works, and why each decision was made (including the alternatives that were rejected).

Contents

1. [Solana in ten minutes (only what this project uses)](#1-solana-in-ten-minutes)
2. [Meteora DBC: how a bonding-curve launch works](#2-meteora-dbc)
3. [The idea, and why this one](#3-the-idea-and-why-this-one)
4. [Architecture at a glance](#4-architecture-at-a-glance)
5. [Deep dives](#5-deep-dives)
6. [Trade-offs, all in one place](#6-trade-offs)
7. [Where everything is](#7-where-everything-is)
8. [Running, testing, demoing, submitting](#8-running-testing-demoing-submitting)

---

## 1. Solana in ten minutes

**Accounts.** Everything on Solana is an *account*: a blob of bytes at a 32-byte address (a public key), holding some SOL (in *lamports*, 1 SOL = 10^9 lamports) and owned by a *program*. Only the owning program can change an account's data. Wallets, tokens, pools and configs are all accounts.

**Programs.** Smart contracts. They are stateless code; all state lives in accounts passed into each call. Meteora's DBC is one program (`dbcij3LW...`); its DAMM v2 AMM is another (`cpamdpZC...`).

**Transactions and instructions.** A transaction is a list of *instructions* (program + accounts + data) that execute atomically, signed by the required keys. Size limit: **1232 bytes**. Compute limit: 200k compute units (CU) per instruction by default, up to 1.4M per transaction if you ask with a `ComputeBudget` instruction. (Launchproof hit both limits; see 5.8.)

**Signers.** Any account marked as a signer must sign. New accounts created at a fresh address (a DBC config, a token mint) need that address's keypair to sign once, which is why the app generates a keypair, *partially signs* with it, and then asks the wallet to sign too.

**PDAs.** Program Derived Addresses are addresses computed from seeds and a program id, with no private key. Programs "sign" for them. DBC's pool authority and pool addresses are PDAs.

**Rent.** Accounts must hold enough lamports to be "rent exempt" (about 0.0069 SOL per KB). Creating a DBC config costs about 0.009 SOL of rent; it is a deposit, not a fee.

**SPL tokens.** A token is a *mint* account (supply, decimals). Balances live in *token accounts*; the canonical one per wallet and mint is the Associated Token Account (ATA). Wrapped SOL (wSOL) lets SOL act like an SPL token.

**RPC.** You talk to the chain through an RPC node (HTTP JSON-RPC). Public RPCs are free but rate limited (you will see `429 Too Many Requests` in the devnet seed logs). Reads like `getAccountInfo`, `getProgramAccounts` and `getSignaturesForAddress` are how the app finds everything.

**Devnet vs mainnet.** Same programs, fake money on devnet. Meteora deploys DBC and DAMM v2 to both at the same addresses, which is why the whole lifecycle works on devnet.

## 2. Meteora DBC

A **bonding curve** sells a new token along a price function: each purchase moves the price up, each sale moves it down, and there is no order book or initial liquidity provider. DBC implements this as a *virtual pool*.

**Two roles.** A *partner* (normally a launchpad) creates a **config**: the rules. A *creator* launches a **pool** (a token) from a config. Many pools share one config. The partner is the config's `fee_claimer` and earns a share of every pool's fees. Launchproof's key insight is that **a preset author is exactly a DBC partner**, so "publishing a preset" means becoming a micro-launchpad that earns from everything launched with your design.

**The curve.** Prices are stored as square roots in Q64.64 fixed point (`sqrtPrice * 2^64` as a u128). The curve is up to 16 segments; segment *i* covers `[sqrtP_i, sqrtP_{i+1}]` with liquidity `L_i`, and inside a segment it behaves like a constant-product AMM:

```
base tokens sold in a segment  = L * (1/sqrtP_low - 1/sqrtP_high)
quote paid for them            = L * (sqrtP_high - sqrtP_low)
```

**Fees.** Every trade pays a base fee from a *fee scheduler* (linear or exponential decay from a high "sniper tax" to a settled fee over a set time), optionally plus a *dynamic fee* that grows with recent volatility. 20% goes to the protocol; the rest splits between partner and creator by `creatorTradingFeePercentage`.

**Graduation.** When the pool's quote reserve reaches `migrationQuoteThreshold` (the "raise"), the curve is complete. Anyone can then call `migration_damm_v2`, which creates a DAMM v2 pool at the curve's final price, deposits the raise (minus an optional graduation fee) and a reserved amount of tokens, and splits the LP position between partner and creator as unlocked, permanently locked, or vesting.

## 3. The idea, and why this one

The bounty judges on: depth of Meteora integration, technical quality, originality and sustainable DBC use, scalability and new asset classes, and traction. Meteora also listed ideas they want: a **config preset marketplace**, **novel curve and fee configurations**, **equity / RWA launch mechanics**, **end-to-end DBC + DAMM v2 flows**, and **developer tooling**.

Most submissions to a bounty like this will be launchpads: a pump.fun-style site on top of one hard-coded config. That shows integration but not much else.

Launchproof goes one level up: **it is infrastructure for every launchpad and creator**. It hits nearly every item on Meteora's list with one coherent product:

- the marketplace is the explicit #1 ask, and the partner-fee model makes it economically self-sustaining (authors are paid by the protocol itself, no new token or fee needed);
- the curve compiler makes "novel curves" a design surface instead of hand math, and the library ships flat NAV sales and IPO-style tranches for RWAs and equities;
- the full lifecycle (publish, launch, trade, graduate, claim) is in the app, CLI and MCP;
- the exact simulator, config auditor, keeper and MCP server are developer and agent tooling.

**Alternatives considered and rejected.**

| Idea | Why not |
|---|---|
| Another launchpad (fork of Meteora's fun-launch scaffold) | Crowded, low originality, judged mostly on traction we cannot produce in a week |
| Trading-terminal data stream / indexer | Useful but needs paid infrastructure to be credible, and is invisible in a demo |
| Custom Anchor program that CPIs into DBC | More "depth" on paper, but a new program to write, test and audit in a week, with real risk of shipping something broken. DBC already provides everything needed (partner = author), so a program would add risk, not capability |
| AI-only config generator | A thin wrapper; becomes credible only once there is a trustworthy simulator underneath, which is what Launchproof builds first (the MCP server then gives agents that capability) |

## 4. Architecture at a glance

```
              +----------------------------------------------+
              |            @launchproof/core  (TypeScript)    |
              |  preset -> curve compiler -> ConfigParameters |
              |  onchain derivation -> SimPool -> scenarios   |
              |  analysis -> lint -> health score             |
              |  CSR-1 registry  |  tx builders  |  stats     |
              +---------+-------------+-------------+---------+
                        |             |             |
                   apps/web      packages/cli   packages/mcp
                (React, static)   (terminal)    (AI agents)
                        |             |             |
                        +------ Solana RPC ---------+
                                      |
                 DBC program   DAMM v2 program   SPL Memo   (Meteora + Solana)
```

**Decision: one framework-free core library.** Every piece of logic (math, simulation, lint, registry, transaction building) lives in `packages/core` and has no React or Node-specific code. The web app, CLI and MCP server are thin shells around it. Benefits: one implementation of the hard parts, testable without a browser, and the CLI and MCP server came almost for free. Cost: a little indirection when building UI.

**Decision: TypeScript everywhere, on top of Meteora's official SDK.** The SDK already mirrors the program's math. Reusing it rather than reimplementing means the simulator inherits Meteora's own correctness, and our job shrinks to the parts the SDK does not provide (state transitions, design, analysis).

**Decision: no backend.** The web app is a static site. The chain is the database: presets come from the CSR-1 registry, stats from `getProgramAccounts`, pool state from account reads. Benefits: free to host (GitHub Pages, IPFS), nothing to keep running, nothing to trust. Cost: every page load does several RPC reads, and public RPCs rate-limit (users can paste their own RPC in the network menu).

**Decision: monorepo with pnpm workspaces.** Internal packages are consumed as TypeScript source (no build step between them), which keeps iteration fast. To publish `@launchproof/core` to npm later, add a `tsup` build.

## 5. Deep dives

### 5.1 The curve compiler (`packages/core/src/curve.ts`)

Designers think in "price as a function of how much of the sale is done", `P(x)` for `x` from 0 to 1. DBC thinks in segments. The compiler bridges them:

1. Choose breakpoints. Smooth shapes use 17 points `x_j = j/16` and prices `p_j = P(x_j)`. Flat uses two points `[p0, p0 * (1 + band)]`. Tranches use a flat segment per tranche plus a tiny "jump" segment between tranches (so up to 8 tranches in 16 segments).
2. Choose weights so each segment sells exactly its slice of the sale. From the segment formula above, base sold in segment *j* is proportional to `L_j * (1/sqrt(p_j) - 1/sqrt(p_{j+1}))`, so
   ```
   w_j = (x_{j+1} - x_j) / (1/sqrt(p_j) - 1/sqrt(p_{j+1}))
   ```
3. Hand prices and weights to the SDK's `buildCurveWithCustomSqrtPrices`, which scales the liquidities so that tokens sold on the curve plus tokens reserved for the DAMM v2 pool plus vesting plus leftover equal the total supply, and derives the raise.

Two properties fall out:
- **No price gap at graduation.** DBC graduates at the last breakpoint and seeds DAMM v2 at that exact price.
- **The raise depends only on the market caps and shape, not on supply.** Scaling both market caps by `k` scales the raise by exactly `k`, so "Solve for a raise" in the Studio is one multiplication.

Edge case found during testing: at very small prices (the 2 SOL Speedrun preset) Q64.64 rounding exceeds the SDK's tolerance, which it absorbs into a "leftover" allocation. `compilePreset` grows the leftover 10x at a time (up to 0.1% of supply) until the SDK accepts it.

### 5.2 Deriving the on-chain config (`onchain.ts`)

The simulator needs the exact `PoolConfig` account the program would write, including fields the program computes itself (migration sqrt price, swap base amount, graduation base amount). `deriveConfigState` mirrors `process_create_config` and `PoolConfig::init` from the Rust program. The differential test compares every field against the account the real program writes. It caught one bug: the program rounds the post-fee migration amount **up**, not down.

### 5.3 The simulator (`sim/pool.ts`)

`SimPool` holds a pool state shaped exactly like the decoded on-chain account. For each swap it:

1. runs the program's pre-swap volatility update (dynamic fees),
2. asks the SDK for the swap result (fee, output, next price) given the current time,
3. applies the state transition ported from `VirtualPool::apply_swap_result`: price, reserves, partner / creator / protocol fee buckets (in base or quote depending on fee mode), metrics,
4. runs the post-swap volatility accumulator update, and
5. marks the curve complete once the threshold is reached.

**Decision: port only the state transition, not the math.** The quote math is subtle (rounding direction everywhere, fee-inclusive vs exclusive amounts, partial fills) and the SDK already mirrors it. Porting ~60 lines of state updates is a much smaller surface to get right than reimplementing the whole swap.

### 5.4 Proving it with LiteSVM (`packages/core/test`)

LiteSVM is a Solana virtual machine you can run inside a Node test, no validator required. The harness (`test/svm.ts`) loads Meteora's real program binaries (`.so` files from their SDK repo) and exposes them through a `Connection` subclass, so the unmodified Meteora SDK builds transactions against it as if it were devnet.

- `differential.test.ts`: config parity for five very different presets, then 60 seeded random swaps on both the simulator and the real program, comparing the full state after every swap. Plus a dynamic-supply parity test for other launchpads' configs.
- `lifecycle.test.ts`: the whole journey, including a real DAMM v2 migration. DAMM v2 needs config accounts that only Meteora's admin can create, so the test clones them from devnet (`test/fixtures/accounts`). Migration also needs the DBC pool authority to hold SOL for "flash rent" (it lends rent to the new DAMM accounts and is repaid in the same instruction); the test funds it, as Meteora does on devnet and mainnet.

**Why this matters.** "Our simulator says snipers lose 47%" is only worth something if the simulator is right. Differential testing against the actual binary is the strongest evidence possible short of mainnet, it runs in three seconds, and it found real bugs (5.2, 5.6).

### 5.5 Scenarios (`sim/scenario.ts`, `sim/scenarios.ts`)

Agents: a creator first buy (bundled with launch, so it can pay the minimum fee), snipers that buy in the first seconds and dump later, a Poisson-arrival crowd with log-normal trade sizes and some profit taking, a whale, and a panic where everyone sells half.

**Decision: trade sizes are fractions of the raise.** That makes one scenario meaningful for an 86 SOL meme curve and a 7M USDC equity raise alike, so presets are comparable under identical market behaviour. **Decision: seeded randomness** (`mulberry32`): the same preset, scenario and seed always produce the same trades, so results are reproducible and shareable.

### 5.6 Analysis and lint (`analysis.ts`, `lint.ts`)

Analysis reads the compiled config back: raise, market caps, supply split (sold on curve / paired in LP / creator allocation / leftover), average buyer multiple at graduation, opening price impact, graduated-pool impact for a 1 SOL or 1,000 USDC trade, fee schedule.

Lint has two layers: the SDK's own `validateConfigParameters` (what the chain would reject) and economic findings backed by numbers and simulation. Severities map to a score (critical -40, warning -12, info -4) and a grade. The **leftover-supply** rule was added after auditing a live mainnet config that leaves 90% of its supply to the launchpad's wallet; that audit also exposed a supply-estimation bug for dynamic-supply configs, now fixed and covered by a test.

### 5.7 The CSR-1 registry (`registry.ts`, `docs/CSR-1.md`)

How do you build a marketplace without a server or a new program? Each listing is a memo transaction that also sends 0 lamports to a keyless address, so `getSignaturesForAddress(registry)` enumerates all listings (the Solana Pay "reference" trick). The trust rule: a listing counts only if its signer is the config's fee claimer, and economics are always read from the config account, never the memo. Full rationale and alternatives are in `docs/CSR-1.md`.

### 5.8 Transactions (`chain.ts`, `apps/web/src/lib/tx.ts`)

Every builder returns unsigned transactions plus any fresh keypairs that must co-sign, so the same code works for a browser wallet, the CLI's file keypair, and the MCP server (which never sees keys and returns base64 transactions instead).

Lessons from real runs:
- **Compute budget**: SPL Memo spends about 380 CU per byte (it logs the memo). A 700-byte listing exceeded the default 200k and failed on devnet, so listings now request `40k + 420 * bytes` CU.
- **Duplicate compute-budget instructions** are rejected by the runtime; the SDK sometimes adds its own, so `withPriority` only adds what is missing.
- **One wallet prompt for multi-step flows**: publishing signs both transactions with `signAllTransactions`, then sends them in order, waiting for confirmation in between.
- **Partial fill for buys**: the last buy before graduation would overshoot the threshold; `swap2` with `PartialFill` stops exactly at the graduation price and refunds the rest.

### 5.9 The web app (`apps/web`)

- **Vite + React + TypeScript + Tailwind v4.** Fast dev loop, small config.
- **Hash routing** (`/#/studio`) so the static build works on any host without server rewrites.
- **TanStack Query** caches every RPC read by key, dedupes identical requests across components, and refetches pool state every few seconds.
- **Wallet Standard** via `@solana/wallet-adapter-react`: installed wallets are auto-detected, no wallet list to maintain.
- **Polyfills**: Solana libraries expect Node's `Buffer`; `src/polyfills.ts` installs it before anything else loads. (A Vite polyfill plugin was tried first and caused a circular import between pre-bundled dependencies, so it was replaced.)
- **Responsiveness**: evaluation (compile + two simulations + lint) takes tens of milliseconds, so the Studio uses `useDeferredValue` to keep sliders smooth and shows the last valid design (dimmed) when an edit does not compile. Marketplace cards evaluate after first paint and share a cache with detail pages.
- **Charts** are hand-written SVG (crosshair, tooltip, legend, log scale) following a validated palette, so they theme cleanly in dark and light mode without a charting dependency.
- **Devnet Burner wallet** (`src/lib/burner.ts`): a small wallet-adapter implementation with its key in localStorage, offered only on devnet, so anyone can try every flow without installing or configuring a wallet extension.
- **Registry snapshot** (`launchproof snapshot`, `src/lib/queries.ts`): the build ships a static copy of the registry and preset stats. Pages paint from it instantly, then live chain data replaces it (stale-while-revalidate); if the live read fails after retries, the snapshot stays on screen instead of an error. Config accounts are stored as raw bytes and decoded with the DBC program's own coder, so the snapshot cannot drift from the real account layout.

### 5.10 What testing against the real chain taught us

Unit tests and the LiteSVM suite proved the math. Clicking through the app against public devnet found a different class of bug: how a real app behaves when the network is slow, out of order or rate limited. Each one is worth knowing as a general lesson.

| Symptom | Root cause | Fix and lesson |
|---|---|---|
| A live marketplace card showed another preset's numbers | JSON-RPC batch responses can arrive in any order, and responses were paired with requests by array index | Read the signature from each transaction itself and sort by slot. Never trust batch order. |
| A just-published preset was missing from the marketplace | Under rate limiting, a transaction fetch came back `null` and the reader skipped it silently | Retry missing transactions with backoff. A rate limit must degrade speed, never correctness. |
| The buy quote showed a 10% sniper fee a minute after launch, when the real fee was 1.2% | The chain-clock query went stale while its refetches were throttled, so quotes were priced at launch time | Sync the chain clock once a minute and tick it locally every second. Time-dependent pricing needs a clock that cannot freeze. |
| Long listings failed on devnet with "exceeded CUs meter" | SPL Memo logs the memo, about 380 compute units per byte, over the default 200k budget | Measure on chain, then request a compute budget sized to the memo. |
| "Sell" tab appeared not to work | An open dropdown that never closed was covering it | Popovers close on outside click, Escape and navigation. |
| Charts overflowed phone screens | A grid with no column template let the chart's initial 600px width size the column | Explicit `grid-cols-1` on mobile, a scalable SVG, and a resize observer that re-attaches when its element changes. |
| Publishing hung on "List in registry confirmed" | The UI waited for a full registry re-read before navigating | Insert the new listing into the cache directly (its config is derived exactly), navigate, refresh in the background. |

The earlier bugs found by the LiteSVM suite (graduation amount rounding up, not down; other launchpads' dynamic token supply) were math bugs; these were systems bugs. A serious project needs both kinds of testing.

## 6. Trade-offs

| Decision | Chosen | Gave up |
|---|---|---|
| Logic placement | One core library shared by app, CLI, MCP | A bit of indirection in UI code |
| Simulator math | Reuse the SDK's quote math, port only state updates | Dependence on SDK correctness (mitigated by differential tests against the binary) |
| Correctness evidence | LiteSVM differential tests on real `.so` binaries | Fixtures must be refreshed when Meteora upgrades the programs |
| Registry | Memo + reference address, economics from chain | O(n) reads per refresh; throttled on public RPCs |
| Backend | None (static site) | Each visitor does its own RPC reads |
| Custom on-chain program | None | Cannot enforce marketplace rules on write (the read-side trust rule covers what matters) |
| Market model | Simple agents, relative sizes, seeded | Not a forecast of real behaviour; exact only about the pool's response |
| Token metadata | Creator supplies a URI | No image hosting (would need a server or a paid storage key) |
| Scope | SPL and Token-2022 base tokens, SOL and USDC quotes | Transfer-hook pools and badge-gated quote mints not in the Studio yet |

## 7. Where everything is

| Path | What it is |
|---|---|
| `packages/core/src/preset.ts` | `PresetSpec` type and defaults |
| `packages/core/src/curve.ts` | Curve planner and compiler, curve sampling |
| `packages/core/src/onchain.ts` | Off-chain derivation of the on-chain config |
| `packages/core/src/sim/pool.ts` | `SimPool`, the exact pool model |
| `packages/core/src/sim/scenario.ts`, `scenarios.ts` | Agent-based scenarios and the built-in set |
| `packages/core/src/sim/migration.ts` | Graduation prediction |
| `packages/core/src/analysis.ts`, `lint.ts`, `evaluate.ts` | Economics, findings, score; the one-call pipeline |
| `packages/core/src/registry.ts` | CSR-1 encode, decode, read, and spec reconstruction from chain |
| `packages/core/src/chain.ts` | Transaction builders and live stats |
| `packages/core/src/library.ts` | The eight curated presets |
| `packages/core/test/` | LiteSVM harness, differential, lifecycle and unit tests, program fixtures |
| `packages/cli/src/index.ts` | The CLI |
| `packages/cli/src/seed-devnet.ts` | Devnet seeding script (wrote `deployments/devnet.json`) |
| `packages/mcp/src/index.ts` | The MCP server |
| `apps/web/src/pages/` | Marketplace, Studio, preset and template pages, Launch, Token, Earnings, How it works |
| `apps/web/src/components/` | Charts, preset views, Studio controls, UI kit |
| `apps/web/src/lib/` | Network and RPC settings, queries, transaction sending, formatting |
| `.reference/` (gitignored) | Meteora's DBC program, SDK and Invent repos, kept locally for reading |

## 8. Running, testing, demoing, submitting

```bash
pnpm install
pnpm test                 # unit, differential, and lifecycle tests in LiteSVM
pnpm dev                  # the app
pnpm cli inspect fair-meme
pnpm --filter @launchproof/web build   # static site in apps/web/dist
```

**Suggested 3-minute demo.**
1. State of DBC: observation window, audit coverage, pool-weighted findings, and source account archive. Then open Presets for the devnet marketplace.
2. Studio: start from Fair Meme, switch the shape to Tranches and then Freehand, watch the curve, supply split and grade update; open Simulate and compare Sniper rush ROI with the fee decay on versus a flat 1% fee.
3. Open State of DBC, inspect a config, download its audit receipt, and reproduce it with `pnpm cli verify-receipt <file>`. Explain snapshot coverage and the difference between migration and demand.
4. With the Devnet Burner: open Micro Speedrun, launch a token with a first buy, buy it to graduation (the quote shows the partial fill), click Graduate to DAMM v2, then claim author and creator fees on the Earnings page. Watch the sniper fee decay live in the buy quote during the first 30 seconds.
5. Show `pnpm test` passing and the MCP server answering `simulate_preset`.

**Before submitting** (things only you can do):
- Record the pitch video (2 to 3 minutes) and the demo video (3 minutes or less).
- Push the repo (it is at `github.com/Sanchay117/Launchproof`); keep it public, or grant `dannxbt` read access.
- Run `pnpm snapshot`, commit the refreshed `apps/web/public/registry-devnet.json`, push, and enable GitHub Pages (Settings, Pages, Source: GitHub Actions). The workflow in `.github/workflows/pages.yml` tests, builds and deploys on every push to `main`.
- Optionally publish one or two presets on mainnet with a small amount of SOL (about 0.01 SOL of rent each) for the traction criterion: `pnpm cli -n mainnet-beta -k <your keypair> publish fair-meme`.
