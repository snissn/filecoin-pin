import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SquidExecutionStep } from 'squid-evm-funding'
import type { Address } from 'viem'
import { afterEach, describe, expect, it } from 'vitest'
import {
  createSquidFundingState,
  openSquidCheckpointStore,
  type SquidCheckpointStore,
} from '../../payments/squid-checkpoint.js'

const OWNER = '0x1111111111111111111111111111111111111111' as Address
const ROUTER = '0xce16F69375520ab01377ce7B88f5BA8C48F8D666' as Address
const SOURCE_TOKEN = '0x2222222222222222222222222222222222222222' as Address
const DESTINATION_TOKEN = '0x3333333333333333333333333333333333333333' as Address

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
    const store = await openSquidCheckpointStore(OWNER)
    stores.push(store)

    await expect(openSquidCheckpointStore(OWNER)).rejects.toThrow('Another Squid funding operation is active')

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
    })
    await store.save(initial)
    await expect(store.load()).resolves.toEqual(initial)

    const filIntent = step('fil', 0)
    const usdfcIntent = step('usdfc', 1)
    const intentState = {
      ...initial,
      checkpoint: {
        executionId: 'execution',
        steps: [filIntent, usdfcIntent],
        integrity: `0x${'55'.repeat(32)}` as const,
      },
    }
    await store.save(intentState)

    const submittedUsdfc = { ...usdfcIntent, transactionHash: `0x${'66'.repeat(32)}` as const }
    const reordered = {
      ...intentState,
      checkpoint: {
        ...intentState.checkpoint,
        steps: [submittedUsdfc, filIntent],
        integrity: `0x${'77'.repeat(32)}` as const,
      },
    }
    await store.save(reordered)

    const safeRollback = {
      ...reordered,
      checkpoint: {
        ...reordered.checkpoint,
        steps: [submittedUsdfc],
        integrity: `0x${'88'.repeat(32)}` as const,
      },
    }
    await store.save(safeRollback)

    await expect(
      store.save({
        ...safeRollback,
        checkpoint: { ...safeRollback.checkpoint, steps: [], integrity: `0x${'99'.repeat(32)}` },
      })
    ).rejects.toThrow('cannot remove a submitted transaction step')

    await expect(store.load()).resolves.toEqual(safeRollback)
    await store.clear()
    await expect(store.load()).resolves.toBeUndefined()
  })
})
