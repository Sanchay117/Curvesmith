/**
 * LiteSVM harness: runs the real Meteora program binaries (DBC, DAMM v2, Metaplex)
 * in-process, and exposes them through a web3.js `Connection` subclass so the
 * official DBC SDK can build transactions against it exactly as it would on devnet.
 */
import {
    AccountInfo,
    Commitment,
    Connection,
    Keypair,
    LAMPORTS_PER_SOL,
    PublicKey,
    Transaction,
} from '@solana/web3.js'
import { Clock, FailedTransactionMetadata, LiteSVM } from 'litesvm'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const fixture = (name: string) => path.join(here, 'fixtures', name)

export const DBC_PROGRAM_ID = new PublicKey('dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN')
export const DAMM_V2_PROGRAM_ID = new PublicKey('cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG')
export const METAPLEX_PROGRAM_ID = new PublicKey('metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s')

export class SvmConnection extends Connection {
    constructor(readonly svm: LiteSVM) {
        // The endpoint is never contacted: every method the SDK uses is overridden below.
        super('http://127.0.0.1:65535')
    }

    private toInfo(pk: PublicKey): AccountInfo<Buffer> | null {
        const a = this.svm.getAccount(pk)
        if (!a) return null
        return {
            data: Buffer.from(a.data),
            executable: a.executable,
            lamports: Number(a.lamports),
            owner: a.owner,
            rentEpoch: a.rentEpoch,
        }
    }

    override async getAccountInfo(pk: PublicKey, _c?: unknown): Promise<AccountInfo<Buffer> | null> {
        return this.toInfo(pk)
    }

    override async getAccountInfoAndContext(pk: PublicKey, _c?: unknown) {
        return { context: { slot: Number(this.svm.getClock().slot) }, value: this.toInfo(pk) }
    }

    override async getMultipleAccountsInfo(pks: PublicKey[], _c?: unknown) {
        return pks.map((pk) => this.toInfo(pk))
    }

    override async getBalance(pk: PublicKey, _c?: unknown): Promise<number> {
        return Number(this.svm.getBalance(pk) ?? 0n)
    }

    override async getSlot(_c?: unknown): Promise<number> {
        return Number(this.svm.getClock().slot)
    }

    override async getBlockTime(_slot: number): Promise<number> {
        return Number(this.svm.getClock().unixTimestamp)
    }

    override async getLatestBlockhash(_c?: Commitment | unknown) {
        return { blockhash: this.svm.latestBlockhash(), lastValidBlockHeight: 1_000_000 }
    }

    override async getMinimumBalanceForRentExemption(len: number, _c?: Commitment): Promise<number> {
        return Number(this.svm.minimumBalanceForRentExemption(BigInt(len)))
    }
}

export class Svm {
    readonly svm: LiteSVM
    readonly connection: SvmConnection

    constructor() {
        this.svm = new LiteSVM().withNativeMints()
        this.svm.addProgramFromFile(DBC_PROGRAM_ID, fixture('dynamic_bonding_curve.so'))
        this.svm.addProgramFromFile(DAMM_V2_PROGRAM_ID, fixture('cp_amm.so'))
        this.svm.addProgramFromFile(METAPLEX_PROGRAM_ID, fixture('metaplex.so'))
        this.connection = new SvmConnection(this.svm)
        // Start the chain at a realistic timestamp so time-based fee schedules behave as on mainnet.
        this.setTime(1_760_000_000n)
    }

    /**
     * Clones accounts snapshotted from devnet (test/fixtures/accounts/*.json), e.g. the
     * DAMM v2 configs Meteora's admin created for DBC graduation.
     */
    loadAccountFixtures() {
        const dir = path.join(here, 'fixtures', 'accounts')
        for (const file of fs.readdirSync(dir)) {
            const a = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'))
            this.svm.setAccount(new PublicKey(a.pubkey), {
                lamports: a.lamports,
                data: Buffer.from(a.data, 'base64'),
                owner: new PublicKey(a.owner),
                executable: a.executable,
                rentEpoch: 0,
            })
        }
        return this
    }

    funded(sol = 1_000): Keypair {
        const kp = Keypair.generate()
        this.svm.airdrop(kp.publicKey, BigInt(sol * LAMPORTS_PER_SOL))
        return kp
    }

    now(): bigint {
        return this.svm.getClock().unixTimestamp
    }

    setTime(unixTimestamp: bigint) {
        const c = this.svm.getClock()
        this.svm.setClock(
            new Clock(c.slot + 1n, c.epochStartTimestamp, c.epoch, c.leaderScheduleEpoch, unixTimestamp)
        )
    }

    advance(seconds: number) {
        const c = this.svm.getClock()
        // keep slot roughly in step with time (400ms slots)
        const slots = BigInt(Math.max(1, Math.round(seconds / 0.4)))
        this.svm.setClock(
            new Clock(
                c.slot + slots,
                c.epochStartTimestamp,
                c.epoch,
                c.leaderScheduleEpoch,
                c.unixTimestamp + BigInt(seconds)
            )
        )
        this.svm.expireBlockhash()
    }

    send(tx: Transaction, signers: Keypair[]) {
        tx.recentBlockhash = this.svm.latestBlockhash()
        if (!tx.feePayer) tx.feePayer = signers[0].publicKey
        tx.sign(...signers)
        const res = this.svm.sendTransaction(tx)
        if (res instanceof FailedTransactionMetadata) {
            throw new Error(`tx failed: ${res.toString()}\n${res.meta().logs().join('\n')}`)
        }
        // a fresh blockhash per tx avoids AlreadyProcessed on identical retries
        this.svm.expireBlockhash()
        return res
    }
}
