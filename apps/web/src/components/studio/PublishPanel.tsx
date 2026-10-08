import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useConnection, useWallet } from '@solana/wallet-adapter-react'
import { useWalletModal } from '@solana/wallet-adapter-react-ui'
import { useQueryClient } from '@tanstack/react-query'
import {
    buildPublishTransactions,
    compilePreset,
    deriveConfigState,
    explorerUrl,
    LintReport,
    Listing,
    listingMetaFromSpec,
    PresetSpec,
    QUOTE_ASSETS,
} from '@launchproof/core'
import { Button } from '../ui'
import { useNetwork } from '../../lib/network'
import { useToast } from '../../lib/toast'
import { explainError, sendSteps } from '../../lib/tx'

export function PublishPanel({ spec, lint }: { spec: PresetSpec; lint: LintReport | null }) {
    const { connection } = useConnection()
    const wallet = useWallet()
    const { setVisible } = useWalletModal()
    const { network, rpcUrl } = useNetwork()
    const toast = useToast()
    const navigate = useNavigate()
    const qc = useQueryClient()
    const [busy, setBusy] = useState<string | null>(null)
    const blocked = !lint || lint.findings.some((f) => f.severity === 'critical')

    const publish = async () => {
        if (!wallet.publicKey) return setVisible(true)
        try {
            setBusy('Building transactions...')
            const plan = await buildPublishTransactions(connection, network, wallet.publicKey, spec)
            const sigs = await sendSteps(
                connection,
                wallet,
                [
                    { label: 'Create DBC config', tx: plan.createConfigTx, signers: [plan.config] },
                    { label: 'List in registry', tx: plan.listingTx },
                ],
                (_, label, sig) => setBusy(sig ? `${label} confirmed` : `${label}...`)
            )
            toast({
                kind: 'success',
                title: 'Preset published',
                body: `Config ${plan.config.publicKey.toBase58().slice(0, 8)}... is live and listed. You earn its partner fees.`,
                href: explorerUrl(network, 'tx', sigs[0]),
            })
            // Re-reading the whole registry is slow on public RPCs, so insert the new listing
            // directly. Its config account is derived exactly (the same derivation the parity
            // tests check against the program), then refresh from chain in the background.
            const config = plan.config.publicKey
            const author = wallet.publicKey
            const listing: Listing = {
                config,
                author,
                signature: sigs[1],
                blockTime: Math.floor(Date.now() / 1000),
                meta: listingMetaFromSpec(config, spec),
                poolConfig: deriveConfigState(compilePreset(spec).params, {
                    quoteMint: QUOTE_ASSETS[network][spec.quote].mint,
                    feeClaimer: author,
                    leftoverReceiver: author,
                }),
            }
            qc.setQueryData<Listing[]>(['listings', network, rpcUrl], (old) => [listing, ...(old ?? []).filter((l) => !l.config.equals(config))])
            void qc.invalidateQueries({ queryKey: ['listings'] })
            navigate(`/p/${config.toBase58()}`)
        } catch (e) {
            toast({ kind: 'error', title: 'Publish failed', body: explainError(e) })
        } finally {
            setBusy(null)
        }
    }

    return (
        <div className="rounded-2xl border border-line bg-surface p-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="min-w-0">
                    <div className="text-[14px] font-semibold">Publish to {network === 'devnet' ? 'devnet' : 'mainnet'}</div>
                    <div className="text-xs text-muted">
                        Creates a DBC config owned by your wallet (you become its fee claimer), then lists it in the on-chain registry. About
                        0.009 SOL of rent.
                    </div>
                </div>
                <Button variant="primary" onClick={publish} loading={!!busy} disabled={wallet.connected && blocked}>
                    {busy ?? (wallet.connected ? (blocked ? 'Fix critical issues first' : 'Publish preset') : 'Connect wallet')}
                </Button>
            </div>
        </div>
    )
}
