import { Connection, Keypair, Transaction } from '@solana/web3.js'
import { WalletContextState } from '@solana/wallet-adapter-react'

export interface TxStep {
    label: string
    tx: Transaction
    /** Extra keypairs that must co-sign (fresh config, mint or position-NFT keys). */
    signers?: Keypair[]
}

/**
 * Signs every step with one wallet prompt when the wallet supports `signAllTransactions`,
 * then sends them in order, waiting for confirmation between steps so later steps can rely
 * on accounts created by earlier ones.
 */
export async function sendSteps(
    connection: Connection,
    wallet: WalletContextState,
    steps: TxStep[],
    onStep?: (i: number, label: string, signature?: string) => void
): Promise<string[]> {
    if (!wallet.publicKey) throw new Error('Connect a wallet first')
    for (const s of steps) if (s.signers?.length) s.tx.partialSign(...s.signers)

    let signed: Transaction[]
    if (wallet.signAllTransactions) {
        signed = await wallet.signAllTransactions(steps.map((s) => s.tx))
    } else if (wallet.signTransaction) {
        signed = []
        for (const s of steps) signed.push(await wallet.signTransaction(s.tx))
    } else {
        throw new Error('This wallet cannot sign transactions')
    }

    const sigs: string[] = []
    for (let i = 0; i < signed.length; i++) {
        onStep?.(i, steps[i].label)
        const sig = await connection.sendRawTransaction(signed[i].serialize(), { skipPreflight: false, maxRetries: 5 })
        const res = await connection.confirmTransaction(
            {
                signature: sig,
                blockhash: signed[i].recentBlockhash!,
                lastValidBlockHeight: signed[i].lastValidBlockHeight ?? (await connection.getBlockHeight()) + 150,
            },
            'confirmed'
        )
        if (res.value.err) throw new Error(`${steps[i].label} failed: ${JSON.stringify(res.value.err)}`)
        sigs.push(sig)
        onStep?.(i, steps[i].label, sig)
    }
    return sigs
}

/** Pulls the useful line out of a simulation failure instead of the whole log dump. */
export function explainError(e: unknown): string {
    const msg = e instanceof Error ? e.message : String(e)
    const logs: string[] = (e as { logs?: string[] })?.logs ?? []
    const anchor = logs.find((l) => l.includes('Error Message:'))
    if (anchor) return anchor.split('Error Message:')[1].trim()
    if (/User rejected|rejected the request/i.test(msg)) return 'Request rejected in wallet'
    if (/insufficient lamports|insufficient funds/i.test(msg)) return 'Not enough SOL for this transaction'
    return msg.length > 220 ? `${msg.slice(0, 220)}...` : msg
}
