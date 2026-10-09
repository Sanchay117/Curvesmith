import { PublicKey } from '@solana/web3.js'
import Decimal from 'decimal.js'
import { PoolConfig } from '@meteora-ag/dynamic-bonding-curve-sdk'
import { Network } from './constants'
import { specFromConfig } from './registry'
import { residualSupply } from './audit'
import { compilePreset } from './curve'

/** Import editable terms; explicitly disclose fields the design language cannot reproduce. */
export function studioSpecFromConfig(config: PoolConfig, network: Network, address: string) {
    new PublicKey(address)
    if (![6, 9].includes(config.tokenDecimal)) throw new Error('Studio supports base token decimals 6 or 9. This config cannot be imported.')
    if (![0, 1].includes(config.tokenType) || ![0, 1].includes(config.collectFeeMode) || config.tokenUpdateAuthority > 4) throw new Error('Studio cannot represent this token or fee mode.')
    if (config.migrationFeeOption > 6) throw new Error('Studio cannot represent this migration fee option.')
    const spec = specFromConfig(config, network, { n: `${address.slice(0, 6)}...${address.slice(-4)} (improved)` })
    const notices = [
        'Original curve segments are replaced by a constant-product curve using the imported endpoint prices. Recheck the new raise and supply split.',
        'Fee-claimer and leftover-receiver addresses are not copied. Publishing uses the publishing wallet.',
        'Fee decay and vesting are reconstructed from schedule fields; rounding can differ from the original raw parameters.',
    ]
    spec.token.leftover = new Decimal(residualSupply(config).leftover.toString()).div(new Decimal(10).pow(config.tokenDecimal)).toNumber()
    if (config.fixedTokenSupplyFlag !== 1) notices.push('Dynamic supply is converted to a fixed initial-supply estimate; the original mint buffer and burn behavior are not imported.')
    if (config.poolFees.dynamicFee.initialized) notices.push('Dynamic fees use the Studio SDK defaults; custom volatility parameters are not imported.')
    if (config.migratedPoolBaseFeeMode !== 0) notices.push('The post-migration fee scheduler is not imported; the displayed DAMM v2 starting fee is used instead.')
    if (config.tokenUpdateAuthority === 3 || config.tokenUpdateAuthority === 4) {
        spec.token.authority = 'immutable'
        notices.push('The deprecated retained-mint-authority mode is reset to immutable for the new standard config.')
    }
    try { compilePreset(spec) }
    catch (error) { throw new Error(`Studio could not reconstruct an editable design: ${(error as Error).message}`) }
    return { spec, notices }
}
