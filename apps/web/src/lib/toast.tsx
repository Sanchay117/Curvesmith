import { createContext, ReactNode, useCallback, useContext, useState } from 'react'

export interface Toast {
    id: number
    kind: 'info' | 'success' | 'error'
    title: string
    body?: string
    href?: string
}

const Ctx = createContext<(t: Omit<Toast, 'id'>) => void>(() => {})

let nextId = 1

export function ToastProvider({ children }: { children: ReactNode }) {
    const [toasts, setToasts] = useState<Toast[]>([])
    const push = useCallback((t: Omit<Toast, 'id'>) => {
        const id = nextId++
        setToasts((xs) => [...xs, { ...t, id }])
        setTimeout(() => setToasts((xs) => xs.filter((x) => x.id !== id)), t.kind === 'error' ? 12_000 : 7_000)
    }, [])
    return (
        <Ctx.Provider value={push}>
            {children}
            <div className="pointer-events-none fixed right-4 bottom-4 z-50 flex w-[360px] max-w-[calc(100vw-32px)] flex-col gap-2">
                {toasts.map((t) => (
                    <div
                        key={t.id}
                        role="status"
                        className="pointer-events-auto rounded-xl border border-line bg-surface p-3 shadow-lg"
                    >
                        <div className="flex items-start gap-2">
                            <span
                                aria-hidden
                                className="mt-1 size-2 shrink-0 rounded-full"
                                style={{
                                    background:
                                        t.kind === 'success' ? 'var(--good)' : t.kind === 'error' ? 'var(--critical)' : 'var(--s1)',
                                }}
                            />
                            <div className="min-w-0 flex-1">
                                <div className="text-sm font-semibold">{t.title}</div>
                                {t.body && <div className="mt-0.5 text-xs break-words text-ink-2">{t.body}</div>}
                                {t.href && (
                                    <a className="mt-1 inline-block text-xs text-accent hover:underline" href={t.href} target="_blank" rel="noreferrer">
                                        View on explorer
                                    </a>
                                )}
                            </div>
                        </div>
                    </div>
                ))}
            </div>
        </Ctx.Provider>
    )
}

export const useToast = () => useContext(Ctx)
