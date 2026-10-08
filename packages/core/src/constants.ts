import { PublicKey } from '@solana/web3.js'
import { NATIVE_MINT } from '@solana/spl-token'
import { sha256 } from './hash'

export type Network = 'devnet' | 'mainnet-beta'

export const DBC_PROGRAM_ID = new PublicKey('dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN')
export const DAMM_V2_PROGRAM_ID = new PublicKey('cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG')
export const MEMO_PROGRAM_ID = new PublicKey('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr')

/**
 * Curve Spec Registry address (CSR-1).
 *
 * Nobody holds a key for this address: it is sha256("curvesmith:registry:v1"). The seed keeps
 * the project's working name on purpose: changing it would move the registry and orphan every
 * existing listing.
 * Every preset listing transaction references it, so `getSignaturesForAddress(REGISTRY_ADDRESS)`
 * enumerates the whole marketplace without any indexer or custom program.
 */
export const REGISTRY_SEED = 'curvesmith:registry:v1'
export const REGISTRY_ADDRESS = new PublicKey(sha256(new TextEncoder().encode(REGISTRY_SEED)))

/** Prefix of every registry memo. Bumping the version keeps old clients from misreading new listings. */
export const REGISTRY_MEMO_PREFIX = 'csr1:'

export interface QuoteAsset {
    symbol: string
    mint: PublicKey
    decimals: number
}

export const QUOTE_ASSETS: Record<Network, Record<string, QuoteAsset>> = {
    devnet: {
        SOL: { symbol: 'SOL', mint: NATIVE_MINT, decimals: 9 },
        // Circle's devnet USDC (faucet.circle.com)
        USDC: {
            symbol: 'USDC',
            mint: new PublicKey('4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU'),
            decimals: 6,
        },
    },
    'mainnet-beta': {
        SOL: { symbol: 'SOL', mint: NATIVE_MINT, decimals: 9 },
        USDC: {
            symbol: 'USDC',
            mint: new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'),
            decimals: 6,
        },
    },
}

export function quoteAssetByMint(network: Network, mint: PublicKey): QuoteAsset | undefined {
    return Object.values(QUOTE_ASSETS[network]).find((q) => q.mint.equals(mint))
}

export const DEFAULT_RPC: Record<Network, string> = {
    devnet: 'https://api.devnet.solana.com',
    'mainnet-beta': 'https://api.mainnet-beta.solana.com',
}

export function explorerUrl(network: Network, kind: 'tx' | 'address', value: string): string {
    const cluster = network === 'devnet' ? '?cluster=devnet' : ''
    return `https://solscan.io/${kind === 'tx' ? 'tx' : 'account'}/${value}${cluster}`
}
