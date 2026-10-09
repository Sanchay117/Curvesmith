# State of DBC: methodology

The report describes **observed existing standard VirtualPool accounts**, not every token ever launched, all DBC variants, unique users, or trading volume. It reviews configs by usage without attributing addresses to launchpad brands.

## Collection

`pnpm cli -n mainnet-beta census --limit 5000 --tail-sample 3000 --cache .cache/census-v1`

1. Query the DBC program with `getProgramAccounts`, finalized commitment, the SDK's standard VirtualPool discriminator, and `isMigrated` equal to 0 and then 1. Request only the 32-byte config address at byte offset 72. The migration byte is at offset 305, including the account discriminator. The lifecycle test checks both offsets against actual program-created accounts before and after migration.
2. Deduplicate pool addresses across the two scans. If a pool migrates between scans, its later observation wins. Record both response slots. These queries do **not** create a single-slot snapshot. Closed accounts and transfer-hook pools are excluded; providers may have completeness limitations that sample validation cannot detect.
3. Count distinct referenced configs, rank by observed pools, and fetch the top N configs in batches of 100. Validate ownership and decode with the installed pinned DBC SDK. Failures remain visible, never silently counted as clean reviews.
4. Decode 200 sampled full pool accounts with the SDK and compare the config address and migration flag with the byte reader. Abort publication on a mismatch. This validates layout interpretation, not RPC completeness or historical counts.
5. Read quote mint accounts for token precision. Recognize SOL/USDC by mint address. All other assets retain their mint identity; no SOL or USD value is invented.
6. For the single-pool stratum, rank each config by SHA-256 of `launchproof-single-pool-v1:<address>` and select the first 3,000. This seeded hash ranking makes a reproducible uniform sample without relying on the RPC's account order. Fetch full config accounts in batches of 100, review them with the same policy, and record failures. Finding shares divide by successfully evaluated sampled configs. Two-sided 95% Wilson score intervals express sampling uncertainty only; failed reads, RPC omissions, and the account observation window can add bias. These are estimates for the single-pool stratum, not for all configs or all pools.
7. Scan PoolConfig accounts once with the account discriminator and `dataSlice` offset 40, length 64. The first 32 bytes are `feeClaimer`; the next 32 are `leftoverReceiver`. Join addresses to the observed config counts. The resulting operator count is the number of distinct fee-claimer **addresses among matched configs**, not a count of people or named launchpads. The raw 42 MB compressed operator scan remains in the local cache; `verify-census --cache` checks its hash and recomputes the grouped counts.

8. For every legacy mint-authority flag in the top configs and tail sample, fetch its recorded sample pool and base mint. Store pool/config linkage, mint owner and bytes, slots, fetch times, and whether mint authority is set, revoked, or unavailable. One sampled mint per config does not establish the state of its other pools. `verify-census` reproduces the observations from raw evidence. This adds later observations to the original census window.

Two scans plus validation and config reads can take several minutes and download hundreds of MB. Full raw RPC responses are gzipped, hashed, and cached locally. `--resume` reuses completed requests and may extend the observation window; `--offline` performs no network requests and requires a complete archive. Use a fresh cache directory for a new census. The CLI verifies saved requests against the requested parameters.

The 2026-10-09 mint observations found authorities set on 27 of 31 sampled top-config mints and revoked on 4. Among 20 flagged single-pool tail configs, 18 were set and 2 revoked. All 51 reads succeeded. These counts are sampled mints, not pool-weighted estimates; the legacy top flags cover 6,455 observed pools. The predicates and severities remain policy 2, with corrected explanatory text. Exact older receipt wording still verifies.

## Collection windows

The published pool scans span slots **454503193–454503628**. Their cache-file timestamps estimate **2026-10-08 09:24:43–09:26:40 UTC**; those early files did not record fetch times. Top config/quote and decode-validation times are also cache-file estimates. Copying the archive can change file timestamps, so preserve modification times when reproducing these estimates.

The tail reads have recorded fetch times **2026-10-08 13:43:52–13:43:58 UTC** (slots 454561639–454561666). The fee-claimer scan was fetched at **13:47:42 UTC**, slot 454562403. Base-mint observations were fetched **2026-10-09 06:46:07 UTC**, slots 454789632–454789635. These are separate observation windows. `observedAt` is only the latest supporting read.

The JSON `phases` summarizes each phase's slot range, time range, request count and whether times are estimated. The evidence archive retains per-request metadata; `verify-census --cache` checks raw archive hashes and metadata as well as the summaries. The decoder check means **all 200 samples matched; a mismatch aborts publication**, not an independently accumulated mismatch count.

## Review policy: `launchproof/config-review@2`

| Check | Rule | Interpretation |
| --- | --- | --- |
| Initially unlocked LP | Partner + creator unlocked shares >50% | A majority can be withdrawn after migration; no withdrawal is inferred. The report also shows each side separately. For unmigrated pools these are future configured terms. |
| Residual supply | Estimated receiver allocation >5%; >50% is critical | Initial supply minus curve sale, migration allocation, vesting, and configured migration burn. Dynamic-supply buffers are burned, not assigned to a receiver. Actual balances and fees can differ. |
| Legacy mint-authority mode | Config authority mode 3 or 4 | Deprecated for standard configs in DBC 0.2.0. The config flag does not prove that an existing token mint still has an authority. |
| Migration fee | Configured fee >10% | Quote is allocated as a fee before liquidity is deposited. |
| Time decay | Supported time scheduler with nonzero periods, interval, and reduction | No time decay is informational. Rate limiters and other fee modes are classified separately. |
| Custom quote | Mint is not recognized SOL/USDC | Keep identity and precision explicit; raw units when precision is unresolved. |
| High opening fee | At least 30% | A warning; notes whether the configured scheduler decays the fee. |
| DAMM v1 migration | Migration option 0 | Legacy path, so DAMM v2 fee and LP behavior must not be inferred. |
| Token-2022 | Base token type 1 | Mint extensions require separate inspection. |
| Shared fee and residual receiver | Same address with residual supply above 5% | This address receives both configured entitlements; no collection is inferred. |

The audit also reports creator and partner shares of trading and migration fees, the migration fee option, effective DAMM v2 base pool fee for fixed or customizable options, both LP vesting schedules, base-token program, fee-claimer address, and residual receiver. Trading-fee shares divide the portion after any protocol fee. A zero migration fee means no migration fee is payable regardless of its configured split. These fields describe config terms; they do not prove distributions or token-mint extension safety. Older `launchproof/config-review@1` receipts remain verifiable offline under their original policy.

The report assigns **no blanket safety grade**. Studio lint scores are a separate design heuristic with scenario assumptions; they are not the report's policy. The report does not simulate every audited config. The top-N findings are observed-pool weighted; the single-pool sample estimates config shares only within that stratum.

Headline finding percentages are **pool weighted among successfully audited configs**. Each row remains a config, not a launchpad. Config-count percentages, total observed pool coverage, and migration rates have different denominators. Categories overlap. Among reviewed pools with more than 50% LP initially unlocked, the creator side has the larger unlocked share in 575,710 of 893,724 pools (64.4%); the partner side leads in 315,187 (35.3%), and 2,827 tie. These describe migration terms, not observed withdrawals. An unflagged config is not a certified safe token.

Among 594,623 reviewed observed pools whose configured residual-supply estimate exceeds 5%, 594,518 (99.9823%) use the config fee claimer as the leftover receiver. The denominator is pools attached to reviewed configs above that threshold, not configs or actual token withdrawals. `residualReceivers` records these counts and their ratio.

## Evidence and receipts

`census-mainnet-beta.json` records counts, scope, scan slots, SDK version, failures, policy outputs, tail estimates, operator aggregates, and source hashes. Its companion `-evidence.json.gz` contains raw reviewed config bytes, sampled tail configs, and sampled full pool accounts. Run `pnpm cli verify-census apps/web/public/census-mainnet-beta.json --cache .cache/census-v1` to recompute the published reviews, intervals, seeded sample selection, and operator aggregates. The much larger complete RPC archive remains in the selected cache directory. Reproduce aggregate counts with `--offline`; selected public config bytes alone cannot prove full-network totals.

The live auditor offers an independent JSON receipt: config address, network, slot, fetch time, raw config bytes, hash, optional raw quote mint account, and policy outputs. Run:

```bash
pnpm cli verify-receipt launchproof-<address>.json
```

This checks the account-byte hash and recomputes findings offline. It does **not** independently authenticate the address/slot metadata, mint-account identity, RPC honesty, or chain inclusion. A malicious party could fabricate a self-consistent receipt. Re-read the specified address on a trusted RPC to corroborate it.

## Claims this data cannot support

- Migration rates do not measure organic demand, unique users, profit, success, bots, or wash trading.
- A custom quote threshold cannot be valued in SOL without pricing evidence.
- Permission to mint or withdraw is not proof that anyone exercised it.
- Simulator parity tests cover selected fixtures and paths, not a formal verification of every deployed program version.
- A snapshot has a date and an observation window. It is not a live census or an immutable historical index.
