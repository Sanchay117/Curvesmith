import { createContext, ReactNode, useContext, useMemo, useState } from 'react'
import { DEFAULT_RPC, Network } from '@curvesmith/core'

interface NetworkState {
    network: Network
    rpcUrl: string
    setNetwork: (n: Network) => void
    setRpcUrl: (url: string) => void
}

const Ctx = createContext<NetworkState | null>(null)

const read = (k: string) => {
    try {
        return localStorage.getItem(k)
    } catch {
        return null
    }
}
const write = (k: string, v: string | null) => {
    try {
        if (v === null) localStorage.removeItem(k)
        else localStorage.setItem(k, v)
    } catch {
        /* storage unavailable (private mode): settings just won't persist */
    }
}

/**
 * Network + RPC selection. Devnet is the default so anyone can try the full lifecycle for
 * free. A custom RPC (e.g. a Helius key) can be set per network; public RPCs rate-limit
 * the registry scan on mainnet.
 */
export function NetworkProvider({ children }: { children: ReactNode }) {
    const [network, setNetworkState] = useState<Network>(() => (read('cs.network') as Network) || 'devnet')
    const [custom, setCustom] = useState<string | null>(() => read(`cs.rpc.${network}`))

    const value = useMemo<NetworkState>(
        () => ({
            network,
            rpcUrl: custom || import.meta.env[`VITE_RPC_${network === 'devnet' ? 'DEVNET' : 'MAINNET'}`] || DEFAULT_RPC[network],
            setNetwork: (n) => {
                write('cs.network', n)
                setNetworkState(n)
                setCustom(read(`cs.rpc.${n}`))
            },
            setRpcUrl: (url) => {
                const v = url.trim() || null
                write(`cs.rpc.${network}`, v)
                setCustom(v)
            },
        }),
        [network, custom]
    )
    return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}

export function useNetwork(): NetworkState {
    const v = useContext(Ctx)
    if (!v) throw new Error('useNetwork outside NetworkProvider')
    return v
}
