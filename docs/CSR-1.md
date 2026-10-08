# CSR-1: Curve Spec Registry

A permissionless, indexer-free registry of DBC launch presets that lives entirely in Solana transaction history.

## Address

```
REGISTRY_ADDRESS = sha256("curvesmith:registry:v1") = 3cjzSdeXvwoke4238hghUi6dzo7cNhousyR19mNjzsBR
```

The address is a hash, so no one holds a private key for it. It is only ever referenced, never signed for. Nothing is stored in it.

## Listing transaction

A listing is one transaction signed by the **author**, containing, in order:

1. `ComputeBudget::SetComputeUnitLimit` sized to the memo (`40,000 + 420 * memoBytes`; SPL Memo costs about 380 CU per byte because it logs the memo).
2. An SPL Memo v2 instruction (`MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr`) with the author attached as a signer and data:

   ```
   csr1:{"v":1,"c":"<config>","n":"<name>","t":"<tagline>","d":"<description>","g":"<category>","k":["<tag>",...],"s":<curve shape>}
   ```

   | field | meaning | limit |
   |---|---|---|
   | `v` | version, always `1` | |
   | `c` | DBC config address being listed | base58 pubkey |
   | `n` | name | 48 chars |
   | `t` | tagline | 96 chars |
   | `d` | description | 420 chars |
   | `g` | category: `meme`, `community`, `rwa`, `equity`, `ai`, `creator`, `experimental` | |
   | `k` | tags | 6 tags, 20 chars each |
   | `s` | the designed curve shape (`{"kind":"tranches",...}` etc.) | |
   | `x` | optional `1` to delist | |

3. `System::Transfer` of 0 lamports from the author to `REGISTRY_ADDRESS`, so the transaction is indexed under the registry address. This is the same trick Solana Pay uses for payment references.

Every library listing fits in a single 1232-byte transaction (checked in `packages/core/test/core.test.ts`).

## Reading

1. `getSignaturesForAddress(REGISTRY_ADDRESS)` (paginated with `before`), newest first, skipping failed transactions.
2. Fetch each transaction (`jsonParsed`), take the memo with the `csr1:` prefix and the first signer as the author.
3. Keep the newest listing per `(config, author)`; drop it if it is a delisting (`x: 1`).
4. Fetch every listed config account. Keep a listing only if:
   - the account is owned by the DBC program and decodes as a `PoolConfig`, and
   - **the listing's signer equals the config's `fee_claimer`**.

## Trust model

- **Who can list**: only the wallet that actually earns a config's partner fees. A third party cannot list (or delist) someone else's config.
- **What is trusted from the memo**: only presentation (name, text, category, the designed shape). Every economic fact shown to users (curve, fees, graduation terms, LP ownership, supply) is read from the config account itself, so a listing cannot misdescribe what a launch does.
- **Spam**: anyone can reference the registry address. Readers ignore anything that is not a valid `csr1:` memo from a config's fee claimer, and clients can additionally rank by on-chain activity (launches, graduations).

## Why not a custom program or an indexer?

| Option | Pros | Cons |
|---|---|---|
| Custom Anchor registry program | Accounts can be queried with `getProgramAccounts`; can enforce rules on write | A new program to write, audit, deploy and pay rent for; users must trust it; another thing that can break |
| Off-chain database + API | Fast queries, search | A server to run and trust; the marketplace stops when it stops |
| **CSR-1 (memo + reference)** | No new program, no server, verifiable by anyone with an RPC; economics always from chain | O(n) RPC reads per refresh; public RPCs throttle `getSignaturesForAddress` |

CSR-1 is the right trade at hackathon and early-production scale. Because the format is public, a cache or indexer can be added later without changing how listings are written.

The seed retains the original working name for compatibility with existing listings. Launchproof does not change the CSR-1 address or memo prefix.
