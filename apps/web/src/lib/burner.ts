import {
    BaseSignerWalletAdapter,
    isVersionedTransaction,
    WalletName,
    WalletNotConnectedError,
    WalletReadyState,
} from '@solana/wallet-adapter-base'
import { Keypair, Transaction, TransactionVersion, VersionedTransaction } from '@solana/web3.js'

export const DevnetBurnerName = 'Devnet Burner' as WalletName<'Devnet Burner'>
const KEY = 'cs.devnet-burner'

/**
 * A throwaway in-browser wallet, offered on devnet only, so anyone can try the full
 * publish / launch / trade / graduate flow without configuring a wallet extension.
 * The secret key lives in localStorage: fine for devnet play money, never for real funds.
 */
export class DevnetBurnerWalletAdapter extends BaseSignerWalletAdapter {
    name = DevnetBurnerName
    url = 'https://faucet.solana.com'
    icon =
        'data:image/svg+xml;base64,' +
        btoa(
            '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="8" fill="#2d2d2a"/><path d="M16 5c3 4 7 7 7 13a7 7 0 01-14 0c0-3 2-5 3-7 1 3 2 4 4 4-1-3-1-6 0-10z" fill="#ff7a45"/></svg>'
        )
    supportedTransactionVersions: ReadonlySet<TransactionVersion> = new Set(['legacy', 0])
    private keypair: Keypair | null = null

    get connecting() {
        return false
    }
    get publicKey() {
        return this.keypair?.publicKey ?? null
    }
    get readyState() {
        return WalletReadyState.Loadable
    }

    async connect(): Promise<void> {
        let kp: Keypair | null = null
        try {
            const saved = localStorage.getItem(KEY)
            if (saved) kp = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(saved)))
        } catch {
            kp = null
        }
        if (!kp) {
            kp = Keypair.generate()
            try {
                localStorage.setItem(KEY, JSON.stringify(Array.from(kp.secretKey)))
            } catch {
                /* storage blocked: the burner just won't survive a reload */
            }
        }
        this.keypair = kp
        this.emit('connect', kp.publicKey)
    }

    async disconnect(): Promise<void> {
        this.keypair = null
        this.emit('disconnect')
    }

    async signTransaction<T extends Transaction | VersionedTransaction>(tx: T): Promise<T> {
        if (!this.keypair) throw new WalletNotConnectedError()
        if (isVersionedTransaction(tx)) tx.sign([this.keypair])
        else tx.partialSign(this.keypair)
        return tx
    }
}
