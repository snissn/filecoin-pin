import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { once } from 'node:events'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SquidExecutionStep } from 'squid-evm-funding'
import type { Address } from 'viem'
import { afterEach, describe, expect, it } from 'vitest'
import {
  createSquidFundingState,
  openSquidCheckpointStore,
  type SquidCheckpointStore,
  sealSquidFundingState,
} from '../../payments/squid-checkpoint.js'

const OWNER = '0x1111111111111111111111111111111111111111' as Address
const ROUTER = '0xce16F69375520ab01377ce7B88f5BA8C48F8D666' as Address
const SOURCE_TOKEN = '0x2222222222222222222222222222222222222222' as Address
const DESTINATION_TOKEN = '0x3333333333333333333333333333333333333333' as Address
const INTEGRITY_KEY = `0x${'aa'.repeat(32)}` as const

function step(requirementId: string, nonce: number): SquidExecutionStep {
  return {
    kind: 'route',
    requirementId,
    attempt: 0,
    nativeFee: 1n,
    from: OWNER,
    to: ROUTER,
    dataHash: `0x${'44'.repeat(32)}`,
    value: 0n,
    nonce,
    gas: 1n,
  }
}

describe('Squid checkpoint store', () => {
  let directory: string | undefined
  const stores: SquidCheckpointStore[] = []

  afterEach(async () => {
    for (const store of stores.reverse()) await store.release().catch(() => undefined)
    stores.length = 0
    delete process.env.SQUID_CHECKPOINT_DIR
    if (directory != null) await rm(directory, { recursive: true, force: true })
    directory = undefined
  })

  it('locks per owner and preserves only monotonic submitted transaction state', async () => {
    directory = await mkdtemp(join(tmpdir(), 'filecoin-pin-squid-'))
    process.env.SQUID_CHECKPOINT_DIR = directory
    const store = await openSquidCheckpointStore(OWNER, INTEGRITY_KEY)
    stores.push(store)

    await expect(openSquidCheckpointStore(OWNER, INTEGRITY_KEY)).rejects.toThrow(
      'Another Squid funding operation is active'
    )

    const initial = createSquidFundingState({
      owner: OWNER,
      source: {
        chain: { chainId: 42161, networkName: 'Arbitrum' },
        token: SOURCE_TOKEN,
        symbol: 'USDC',
        decimals: 6,
        native: false,
      },
      requirements: [
        { id: 'fil', chainId: 314, token: DESTINATION_TOKEN, amount: 7n, recipient: OWNER },
        { id: 'usdfc', chainId: 314, token: DESTINATION_TOKEN, amount: 11n, recipient: OWNER },
      ],
      sourceAmounts: [13n, 17n],
      integrityKey: INTEGRITY_KEY,
    })
    await store.save(initial)
    await expect(store.load()).resolves.toEqual(initial)

    const filIntent = step('fil', 0)
    const usdfcIntent = step('usdfc', 1)
    const intentState = sealSquidFundingState(
      {
        ...initial,
        checkpoint: {
          executionId: 'execution',
          steps: [filIntent, usdfcIntent],
          integrity: `0x${'55'.repeat(32)}` as const,
        },
      },
      INTEGRITY_KEY
    )
    await store.save(intentState)

    const submittedUsdfc = { ...usdfcIntent, transactionHash: `0x${'66'.repeat(32)}` as const }
    const reordered = sealSquidFundingState(
      {
        ...intentState,
        checkpoint: {
          executionId: 'execution',
          steps: [submittedUsdfc, filIntent],
          integrity: `0x${'77'.repeat(32)}` as const,
        },
      },
      INTEGRITY_KEY
    )
    await store.save(reordered)

    const safeRollback = sealSquidFundingState(
      {
        ...reordered,
        checkpoint: {
          executionId: 'execution',
          steps: [submittedUsdfc],
          integrity: `0x${'88'.repeat(32)}` as const,
        },
      },
      INTEGRITY_KEY
    )
    await store.save(safeRollback)

    await expect(
      store.save(
        sealSquidFundingState(
          {
            ...safeRollback,
            checkpoint: { executionId: 'execution', steps: [], integrity: `0x${'99'.repeat(32)}` },
          },
          INTEGRITY_KEY
        )
      )
    ).rejects.toThrow('cannot remove a submitted transaction step')

    await expect(store.load()).resolves.toEqual(safeRollback)
    await store.clear()
    await expect(store.load()).resolves.toBeUndefined()
  })

  it('rejects a persisted source plan changed without the integrity key', async () => {
    directory = await mkdtemp(join(tmpdir(), 'filecoin-pin-squid-'))
    process.env.SQUID_CHECKPOINT_DIR = directory
    const store = await openSquidCheckpointStore(OWNER, INTEGRITY_KEY)
    stores.push(store)
    const state = createSquidFundingState({
      owner: OWNER,
      source: {
        chain: { chainId: 42161, networkName: 'Arbitrum' },
        token: SOURCE_TOKEN,
        symbol: 'USDC',
        decimals: 6,
        native: false,
      },
      requirements: [{ id: 'fil', chainId: 314, token: DESTINATION_TOKEN, amount: 7n, recipient: OWNER }],
      sourceAmounts: [13n],
      integrityKey: INTEGRITY_KEY,
    })
    await store.save(state)
    const identity = createHash('sha256').update(OWNER.toLowerCase()).digest('hex')
    const path = join(directory, 'squid-funding', `${identity}.json`)
    const raw = await readFile(path, 'utf8')
    const tampered = raw.replace('{"$filecoinPinBigint":"13"}', '{"$filecoinPinBigint":"130"}')
    expect(tampered).not.toBe(raw)
    await writeFile(path, tampered)

    await expect(store.load()).rejects.toThrow('failed its integrity check')
  })

  it('releases the owner lock when a process terminates without cleanup', async () => {
    directory = await mkdtemp(join(tmpdir(), 'filecoin-pin-squid-'))
    process.env.SQUID_CHECKPOINT_DIR = directory
    const initial = await openSquidCheckpointStore(OWNER, INTEGRITY_KEY)
    await initial.release()
    const identity = createHash('sha256').update(OWNER.toLowerCase()).digest('hex')
    const lockPath = join(directory, 'squid-funding', `${identity}.owner`)
    const script = [
      "const { lock } = require('proper-lockfile')",
      "lock(process.argv[1], { realpath: false, stale: 5000, update: 1000 }).then(() => process.stdout.write('locked\\n'))",
      'setInterval(() => undefined, 1_000)',
    ].join(';')
    const child = spawn(process.execPath, ['-e', script, lockPath], { stdio: ['ignore', 'pipe', 'pipe'] })
    await once(child.stdout, 'data')

    await expect(openSquidCheckpointStore(OWNER, INTEGRITY_KEY, { staleMs: 5_000 })).rejects.toThrow(
      'Another Squid funding operation is active'
    )
    child.kill('SIGKILL')
    await once(child, 'exit')
    await new Promise((resolve) => setTimeout(resolve, 6_000))

    const recovered = await openSquidCheckpointStore(OWNER, INTEGRITY_KEY, { staleMs: 5_000 })
    stores.push(recovered)
  }, 15_000)
})
