# launchproof CLI

Read-only config audits and a reproducible census for Meteora DBC, plus optional launch tools. Requires Node.js 22 or newer.

```bash
npx launchproof -n mainnet-beta audit <config-address>
npx launchproof verify-receipt <receipt.json>
npx launchproof verify-census <report.json> --cache <archive-directory>
```

The default cluster is devnet. `audit` and `census` only read RPC data; `publish`, `launch`, `buy`, `sell`, `graduate`, and `claim` require an explicitly funded signer. Run `npx launchproof --help` for options. Config review is not a safety certificate. See the repository's `docs/CENSUS.md` for the census method.

Build locally with `pnpm --filter launchproof build`. When ready, the maintainer can publish with `pnpm --filter launchproof publish --access public`; this repository does not publish automatically.
