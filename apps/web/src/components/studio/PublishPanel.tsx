import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useConnection, useWallet } from '@solana/wallet-adapter-react'
import { useWalletModal } from '@solana/wallet-adapter-react-ui'
import { useQueryClient } from '@tanstack/react-query'
import { buildPublishTransactions, explorerUrl, LintReport, PresetSpec } from '@curvesmith/core'
import { Button } from '../ui'
import { useNetwork } from '../../lib/network'
import { useToast } from '../../lib/toast'
import { explainError, sendSteps } from '../../lib/tx'

export function PublishPanel({ spec, lint }: { spec: PresetSpec; lint: LintReport | null }) {
    const { connection } = useConnection()
    const wallet = useWallet()
    const { setVisible } = useWalletModal()
    const { network } = useNetwork()
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
            await qc.invalidateQueries({ queryKey: ['listings'] })
            navigate(`/p/${plan.config.publicKey.toBase58()}`)
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
