# State of DBC: methodology

The report describes **observed existing standard VirtualPool accounts**, not every token ever launched, all DBC variants, unique users, or trading volume. It reviews configs by usage without attributing addresses to launchpad brands.

## Collection

`pnpm cli -n mainnet-beta census --limit 5000 --cache .cache/census-new`

1. Query the DBC program with `getProgramAccounts`, finalized commitment, the SDK's standard VirtualPool discriminator, and `isMigrated` equal to 0 and then 1. Request only the 32-byte config address at byte offset 72. The migration byte is at offset 305, including the account discriminator. The lifecycle test checks both offsets against actual program-created accounts before and after migration.
2. Deduplicate pool addresses across the two scans. If a pool migrates between scans, its later observation wins. Record both response slots. These queries do **not** create a single-slot snapshot. Closed accounts and transfer-hook pools are excluded; providers may have completeness limitations that sample validation cannot detect.
3. Count distinct referenced configs, rank by observed pools, and fetch the top N configs in batches of 100. Validate ownership and decode with pinned DBC SDK 1.5.13. Failures remain visible, never silently counted as clean reviews.
4. Decode 200 sampled full pool accounts with the SDK and compare the config address and migration flag with the byte reader. Abort publication on a mismatch. This validates layout interpretation, not RPC completeness or historical counts.
5. Read quote mint accounts for token precision. Recognize SOL/USDC by mint address. All other assets retain their mint identity; no SOL or USD value is invented.

Two scans plus validation and config reads can take several minutes and download hundreds of MB. Full raw RPC responses are gzipped, hashed, and cached locally. `--resume` reuses completed requests and may extend the observation window; `--offline` performs no network requests and requires a complete archive. Use a fresh cache directory for a new census. The CLI verifies saved requests against the requested parameters.

## Review policy: `launchproof/config-review@1`

| Check | Rule | Interpretation |
| --- | --- | --- |
| Initially unlocked LP | Partner + creator unlocked shares >50% | A majority can be withdrawn after migration; no withdrawal is inferred. |
| Residual supply | Estimated receiver allocation >5%; >50% is critical | Initial supply minus curve sale, migration allocation, vesting, and configured migration burn. Dynamic-supply buffers are burned, not assigned to a receiver. Actual balances and fees can differ. |
| Mint authority | Config authority mode 3 or 4 | Additional issuance is permitted; it can be legitimate for externally backed assets. |
| Migration fee | Configured fee >10% | Quote is allocated as a fee before liquidity is deposited. |
| Time decay | Supported time scheduler with nonzero periods, interval, and reduction | No time decay is informational. Rate limiters and other fee modes are classified separately. |
| Custom quote | Mint is not recognized SOL/USDC | Keep identity and precision explicit; raw units when precision is unresolved. |

The report assigns **no blanket safety grade**. Studio lint scores are a separate design heuristic with scenario assumptions; they are not the report's policy. The report does not simulate every audited config.

Headline finding percentages are **pool weighted among successfully audited configs**. Each row remains a config, not a launchpad. Config-count percentages, total observed pool coverage, and migration rates have different denominators. Categories overlap. An unflagged config is not a certified safe token.

## Evidence and receipts

`census-mainnet-beta.json` records counts, scope, scan slots, SDK version, failures, policy outputs, and source hashes. Its companion `-evidence.json.gz` contains raw config bytes and sampled full pool accounts. The much larger complete RPC archive remains in the selected cache directory. Reproduce the aggregate census from that archive with `--offline`; selected public config bytes alone cannot prove full-network totals.

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
