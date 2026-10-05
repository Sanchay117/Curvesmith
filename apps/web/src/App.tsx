import { lazy, Suspense } from 'react'
import { Route, Routes } from 'react-router-dom'
import { Layout } from './components/Layout'
import { Spinner } from './components/ui'
import { Marketplace } from './pages/Marketplace'

// The Studio pulls in the most UI; split it and the rarer pages out of the first load.
const Studio = lazy(() => import('./pages/Studio').then((m) => ({ default: m.Studio })))
const PresetPage = lazy(() => import('./pages/PresetPage').then((m) => ({ default: m.PresetPage })))
const TemplatePage = lazy(() => import('./pages/PresetPage').then((m) => ({ default: m.TemplatePage })))
const Launch = lazy(() => import('./pages/Launch').then((m) => ({ default: m.Launch })))
const TokenPage = lazy(() => import('./pages/TokenPage').then((m) => ({ default: m.TokenPage })))
const Earnings = lazy(() => import('./pages/Earnings').then((m) => ({ default: m.Earnings })))
const About = lazy(() => import('./pages/About').then((m) => ({ default: m.About })))

export function App() {
    return (
        <Layout>
            <Suspense
                fallback={
                    <div className="grid h-64 place-items-center text-muted">
                        <Spinner />
                    </div>
                }
            >
                <Routes>
                    <Route path="/" element={<Marketplace />} />
                    <Route path="/studio" element={<Studio />} />
                    <Route path="/t/:id" element={<TemplatePage />} />
                    <Route path="/p/:config" element={<PresetPage />} />
                    <Route path="/launch/:config" element={<Launch />} />
                    <Route path="/token/:pool" element={<TokenPage />} />
                    <Route path="/earnings" element={<Earnings />} />
                    <Route path="/about" element={<About />} />
                    <Route path="*" element={<div className="py-24 text-center text-muted">Page not found.</div>} />
                </Routes>
            </Suspense>
        </Layout>
    )
}
