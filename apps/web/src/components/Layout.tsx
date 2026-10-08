import { ReactNode, useCallback, useEffect, useRef, useState } from 'react'
import { NavLink, Link, useLocation } from 'react-router-dom'
import { WalletMultiButton } from '@solana/wallet-adapter-react-ui'
import { useConnection, useWallet } from '@solana/wallet-adapter-react'
import { useNetwork } from '../lib/network'
import { DevnetBurnerName } from '../lib/burner'
import { useSolBalance } from '../lib/queries'
import { useToast } from '../lib/toast'
import { Button, cx, Segmented, TextInput } from './ui'

function useTheme() {
    const [theme, setTheme] = useState<'light' | 'dark'>(() => {
        try {
            const saved = localStorage.getItem('cs.theme')
            if (saved === 'light' || saved === 'dark') return saved
        } catch {
            /* ignore */
        }
        return window.matchMedia?.('(prefers-color-scheme: light)').matches ? 'light' : 'dark'
    })
    useEffect(() => {
        document.documentElement.dataset.theme = theme
        try {
            localStorage.setItem('cs.theme', theme)
        } catch {
            /* ignore */
        }
    }, [theme])
    return [theme, setTheme] as const
}

function Logo() {
    return (
        <Link to="/" className="flex items-center gap-2.5">
            {/* the mark: a checkmark whose rising stroke is a bonding curve, i.e. a proven curve */}
            <svg width="28" height="28" viewBox="0 0 32 32" aria-hidden>
                <defs>
                    <linearGradient id="lp-mark" x1="0" y1="0" x2="1" y2="1">
                        <stop offset="0" stopColor="#7b6bff" />
                        <stop offset="1" stopColor="#4c37d9" />
                    </linearGradient>
                </defs>
                <rect width="32" height="32" rx="8" fill="url(#lp-mark)" />
                <path d="M8 16.6 L13.4 21.8 C 16.6 16.4, 19.6 11.4, 24.6 8.6" fill="none" stroke="#fff" strokeWidth="3.2" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            <span className="hidden text-[17px] font-semibold tracking-tight sm:inline">Launchproof</span>
        </Link>
    )
}

/** Shown when the devnet burner is connected: its address, balance and a faucet shortcut. */
function BurnerPanel() {
    const wallet = useWallet()
    const { connection } = useConnection()
    const bal = useSolBalance(wallet.publicKey)
    const toast = useToast()
    const [busy, setBusy] = useState(false)
    if (wallet.wallet?.adapter.name !== DevnetBurnerName || !wallet.publicKey) return null
    const addr = wallet.publicKey.toBase58()
    return (
        <div className="mt-4 rounded-xl bg-surface-2 p-3 text-xs">
            <div className="mb-1 font-semibold text-ink">Devnet burner wallet</div>
            <div className="font-mono break-all text-ink-2">{addr}</div>
            <div className="mt-1 text-muted">Balance {bal.data !== undefined ? (bal.data / 1e9).toFixed(3) : '...'} SOL</div>
            <div className="mt-2 flex gap-2">
                <Button
                    size="sm"
                    loading={busy}
                    onClick={async () => {
                        setBusy(true)
                        try {
                            const sig = await connection.requestAirdrop(wallet.publicKey!, 1e9)
                            await connection.confirmTransaction(sig, 'confirmed')
                            toast({ kind: 'success', title: 'Airdropped 1 devnet SOL' })
                        } catch {
                            toast({ kind: 'error', title: 'Faucet is rate limited', body: 'Copy the address and use faucet.solana.com instead.' })
                        } finally {
                            setBusy(false)
                        }
                    }}
                >
                    Airdrop 1 SOL
                </Button>
                <a href="https://faucet.solana.com" target="_blank" rel="noreferrer">
                    <Button size="sm" variant="ghost">
                        Web faucet
                    </Button>
                </a>
            </div>
        </div>
    )
}

function Settings({ onClose }: { onClose: () => void }) {
    const { network, setNetwork, rpcUrl, setRpcUrl } = useNetwork()
    const [draft, setDraft] = useState(rpcUrl)
    return (
        <div className="absolute top-full right-0 z-40 mt-2 w-80 rounded-2xl border border-line bg-surface p-4 shadow-xl">
            <div className="mb-3 text-sm font-semibold">Network</div>
            <Segmented
                value={network}
                onChange={(n) => {
                    setNetwork(n)
                    onClose()
                }}
                options={[
                    { value: 'devnet', label: 'Devnet' },
                    { value: 'mainnet-beta', label: 'Mainnet' },
                ]}
            />
            <div className="mt-4 mb-1.5 text-[13px] font-medium text-ink-2">RPC endpoint</div>
            <TextInput value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="https://..." />
            <p className="mt-1.5 text-xs text-muted">
                Public RPCs throttle the registry scan. A free Helius or Triton endpoint makes mainnet browsing fast. Stored only in this browser.
            </p>
            <div className="mt-3 flex justify-end gap-2">
                <Button size="sm" variant="ghost" onClick={() => setRpcUrl('')}>
                    Reset
                </Button>
                <Button
                    size="sm"
                    variant="primary"
                    onClick={() => {
                        setRpcUrl(draft)
                        onClose()
                    }}
                >
                    Save
                </Button>
            </div>
            <BurnerPanel />
        </div>
    )
}

/** Closes a popover on outside click, Escape, or navigation. */
function useDismiss(open: boolean, close: () => void) {
    const ref = useRef<HTMLDivElement>(null)
    const location = useLocation()
    useEffect(() => {
        if (!open) return
        const onDown = (e: MouseEvent) => {
            if (ref.current && !ref.current.contains(e.target as Node)) close()
        }
        const onKey = (e: KeyboardEvent) => e.key === 'Escape' && close()
        document.addEventListener('mousedown', onDown)
        document.addEventListener('keydown', onKey)
        return () => {
            document.removeEventListener('mousedown', onDown)
            document.removeEventListener('keydown', onKey)
        }
    }, [open, close])
    useEffect(() => close(), [location.pathname]) // eslint-disable-line react-hooks/exhaustive-deps
    return ref
}

export function Layout({ children }: { children: ReactNode }) {
    const [theme, setTheme] = useTheme()
    const { network } = useNetwork()
    const location = useLocation()
    const readOnly = location.pathname === '/' || (location.pathname.startsWith('/audit/') && !location.search.includes('network=devnet'))
    const [open, setOpen] = useState(false)
    const [menu, setMenu] = useState(false)
    const closeSettings = useCallback(() => setOpen(false), [])
    const settingsRef = useDismiss(open, closeSettings)
    const nav = [
        { to: '/', label: 'State of DBC' },
        { to: '/market', label: 'Presets' },
        { to: '/studio', label: 'Studio' },
        { to: '/earnings', label: 'Earnings' },
        { to: '/about', label: 'How it works' },
    ]
    return (
        <div className="min-h-screen">
            <header className="sticky top-0 z-30 border-b border-line bg-page/85 backdrop-blur">
                <div className="mx-auto flex h-16 max-w-[1280px] items-center gap-3 px-4 sm:gap-6 sm:px-6">
                    <Logo />
                    <nav className="hidden items-center gap-1 md:flex">
                        {nav.map((n) => (
                            <NavLink
                                key={n.to}
                                to={n.to}
                                end={n.to === '/'}
                                className={({ isActive }) =>
                                    cx('rounded-lg px-3 py-1.5 text-sm font-medium transition-colors', isActive ? 'bg-surface-2 text-ink' : 'text-ink-2 hover:text-ink')
                                }
                            >
                                {n.label}
                            </NavLink>
                        ))}
                    </nav>
                    <div className="ml-auto flex min-w-0 items-center gap-1.5 sm:gap-2">
                        <div className="relative" ref={settingsRef}>
                            <button
                                aria-expanded={open}
                                onClick={() => setOpen((o) => !o)}
                                className="flex h-9 items-center gap-2 rounded-[10px] border border-line-strong bg-surface-2 px-3 text-[13px] font-medium"
                            >
                                <span className="size-2 rounded-full" style={{ background: readOnly ? 'var(--muted)' : network === 'devnet' ? 'var(--s4)' : 'var(--good)' }} />
                                <span className="hidden sm:inline">{readOnly ? 'Mainnet · read-only' : network === 'devnet' ? 'Devnet' : 'Mainnet'}</span>
                            </button>
                            {open && <Settings onClose={() => setOpen(false)} />}
                        </div>
                        <button
                            aria-label="Toggle theme"
                            onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
                            className="grid size-9 place-items-center rounded-[10px] border border-line-strong bg-surface-2 text-ink-2 hover:text-ink"
                        >
                            {theme === 'dark' ? (
                                <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden><circle cx="8" cy="8" r="3.2" fill="currentColor" /><g stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"><path d="M8 1.2v1.6M8 13.2v1.6M1.2 8h1.6M13.2 8h1.6M3.2 3.2l1.1 1.1M11.7 11.7l1.1 1.1M3.2 12.8l1.1-1.1M11.7 4.3l1.1-1.1" /></g></svg>
                            ) : (
                                <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden><path d="M13.5 9.6A5.8 5.8 0 016.4 2.5a5.8 5.8 0 107.1 7.1z" fill="currentColor" /></svg>
                            )}
                        </button>
                        <WalletMultiButton />
                        <button
                            className="grid size-9 place-items-center rounded-[10px] border border-line-strong bg-surface-2 md:hidden"
                            aria-label="Menu"
                            onClick={() => setMenu((m) => !m)}
                        >
                            <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden><path d="M2 4h12M2 8h12M2 12h12" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" /></svg>
                        </button>
                    </div>
                </div>
                {menu && (
                    <nav className="flex flex-col border-t border-line px-4 py-2 md:hidden">
                        {nav.map((n) => (
                            <NavLink key={n.to} to={n.to} end={n.to === '/'} onClick={() => setMenu(false)} className="py-2 text-sm font-medium text-ink-2">
                                {n.label}
                            </NavLink>
                        ))}
                    </nav>
                )}
            </header>
            {network === 'mainnet-beta' && !readOnly && (
                <div className="border-b border-line bg-accent-wash px-4 py-2 text-center text-xs text-ink-2">
                    You are on mainnet. Publishing, launching and trading use real funds.
                </div>
            )}
            {/* keyed by route so every page enters with the same short fade-up */}
            <main key={location.pathname} className="lp-page mx-auto max-w-[1280px] px-4 py-8 sm:px-6">
                {children}
            </main>
            <footer className="mx-auto max-w-[1280px] px-4 pb-10 text-xs text-muted sm:px-6">
                Built on Meteora's Dynamic Bonding Curve and DAMM v2. Quotes use the official SDK's math. The simulator is differential-tested against the
                program binary on covered cases; these models do not predict price.
            </footer>
        </div>
    )
}
