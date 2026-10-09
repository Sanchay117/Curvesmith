import './polyfills'
import { StrictMode, useMemo } from 'react'
import { createRoot } from 'react-dom/client'
import { HashRouter } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { ConnectionProvider, WalletProvider } from '@solana/wallet-adapter-react'
import { WalletModalProvider } from '@solana/wallet-adapter-react-ui'
import '@solana/wallet-adapter-react-ui/styles.css'
import './styles.css'
import { NetworkProvider, useNetwork } from './lib/network'
import { ToastProvider } from './lib/toast'
import { DevnetBurnerWalletAdapter } from './lib/burner'
import { App } from './App'

// Public RPCs answer bursts with 429s; retry with exponential backoff instead of failing.
const queryClient = new QueryClient({
    defaultOptions: {
        queries: {
            refetchOnWindowFocus: false,
            retry: 4,
            retryDelay: (attempt) => Math.min(15_000, 800 * 2 ** attempt + Math.random() * 400),
        },
    },
})

function Solana({ children }: { children: React.ReactNode }) {
    const { rpcUrl, network } = useNetwork()
    // Wallet Standard auto-detects installed wallets (Phantom, Solflare, Backpack...); the only
    // explicit adapter is a devnet burner so the app can be tried without any extension.
    const wallets = useMemo(() => (network === 'devnet' ? [new DevnetBurnerWalletAdapter()] : []), [network])
    // web3.js would retry 429s on its own; withRetry and React Query already back off, and stacking both multiplies a burst
    return (
        <ConnectionProvider endpoint={rpcUrl} config={{ commitment: 'confirmed', disableRetryOnRateLimit: true }}>
            <WalletProvider wallets={wallets} autoConnect>
                <WalletModalProvider>{children}</WalletModalProvider>
            </WalletProvider>
        </ConnectionProvider>
    )
}

createRoot(document.getElementById('root')!).render(
    <StrictMode>
        <HashRouter>
            <QueryClientProvider client={queryClient}>
                <NetworkProvider>
                    <Solana>
                        <ToastProvider>
                            <App />
                        </ToastProvider>
                    </Solana>
                </NetworkProvider>
            </QueryClientProvider>
        </HashRouter>
    </StrictMode>
)
