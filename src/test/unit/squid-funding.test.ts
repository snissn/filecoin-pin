import { type Address, parseEther } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const TEST_KEY = `0x${'11'.repeat(32)}` as const
const OWNER = privateKeyToAccount(TEST_KEY).address
const SOURCE = {
  chain: { chainId: 42161, networkName: 'Arbitrum' },
  token: '0x2222222222222222222222222222222222222222' as Address,
  symbol: 'USDC',
  decimals: 6,
  native: false,
}

const mocks = vi.hoisted(() => ({
  fetchCatalog: vi.fn(),
  resolveSource: vi.fn(),
  plan: vi.fn(),
  quote: vi.fn(),
  execute: vi.fn(),
  openStore: vi.fn(),
}))

vi.mock('squid-evm-funding', () => ({
  NATIVE_TOKEN_ADDRESS: '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
  fetchSquidCatalog: mocks.fetchCatalog,
  resolveSourceToken: mocks.resolveSource,
  planSquidFunding: mocks.plan,
  quoteSquidRoute: mocks.quote,
  executeSquidFunding: mocks.execute,
}))

vi.mock('../../payments/squid-checkpoint.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../payments/squid-checkpoint.js')>()),
  openSquidCheckpointStore: mocks.openStore,
}))

import { acquirePaymentShortfalls } from '../../payments/squid-funding.js'

const synapse = {
  client: {},
} as never

function quote(id: string, requirement: { id: string; amount: bigint; token: Address }) {
  return {
    id,
    requirement: {
      ...requirement,
      chainId: 314,
      recipient: OWNER,
    },
    source: SOURCE,
    sourceAmount: 100_000n,
    destinationAmount: requirement.amount,
    target: '0xce16F69375520ab01377ce7B88f5BA8C48F8D666',
    approvalSpender: '0xce16F69375520ab01377ce7B88f5BA8C48F8D666',
    data: '0x12',
    value: 0n,
    gasLimit: 1n,
    maxFeePerGas: 1n,
    expiresAt: 4_000_000_000,
    estimatedRouteDurationSeconds: 1,
  }
}

function input(destinationChainId = 314) {
  return {
    synapse,
    owner: OWNER,
    destinationChainId,
    shortfalls: { fil: 7n, usdfc: 11n },
    requiredWalletUsdfc: 20n,
    options: {
      privateKey: TEST_KEY,
      fromChain: 'arbitrum',
      fromToken: 'USDC',
      maxSourceAmount: '1',
      sourceRpcUrl: 'https://source.example',
    },
  }
}

describe('Squid payment funding adapter', () => {
  let state: import('../../payments/squid-checkpoint.js').SquidFundingState | undefined
  const clear = vi.fn(async () => {
    state = undefined
  })
  const release = vi.fn(async () => undefined)

  beforeEach(() => {
    vi.clearAllMocks()
    state = undefined
    process.env.SQUID_INTEGRATOR_ID = 'test-integrator'
    process.env.SQUID_CHECKPOINT_INTEGRITY_KEY = `0x${'22'.repeat(32)}`
    mocks.fetchCatalog.mockResolvedValue({})
    mocks.resolveSource.mockReturnValue(SOURCE)
    mocks.openStore.mockResolvedValue({
      load: async () => state,
      save: async (next: typeof state) => {
        state = next
      },
      clear,
      release,
    })
  })

  afterEach(() => {
    delete process.env.SQUID_INTEGRATOR_ID
    delete process.env.SQUID_CHECKPOINT_INTEGRITY_KEY
  })

  it('returns on zero shortfall without the library, provider, store, or source RPC', async () => {
    const acquired = await acquirePaymentShortfalls({ ...input(), shortfalls: { fil: 0n, usdfc: 0n }, options: {} })

    expect(acquired).toBe(false)
    expect(mocks.openStore).not.toHaveBeenCalled()
    expect(mocks.fetchCatalog).not.toHaveBeenCalled()
    expect(mocks.plan).not.toHaveBeenCalled()
    expect(mocks.execute).not.toHaveBeenCalled()
  })

  it.each([
    314159, 31415926,
  ])('fails closed on unsupported destination %i before provider activity', async (chainId) => {
    await expect(acquirePaymentShortfalls(input(chainId))).rejects.toThrow(
      'Source acquisition is available only for Filecoin mainnet'
    )

    expect(mocks.openStore).not.toHaveBeenCalled()
    expect(mocks.fetchCatalog).not.toHaveBeenCalled()
    expect(mocks.plan).not.toHaveBeenCalled()
  })

  it('passes the exact FIL and USDFC requirements to the library', async () => {
    const planned = [
      quote('fil', { id: 'filecoin-fil', amount: 7n, token: '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee' }),
      quote('usdfc', { id: 'filecoin-usdfc', amount: 11n, token: '0x80B98d3aa09ffff255c3ba4A241111Ff1262F045' }),
    ]
    mocks.plan.mockResolvedValue(planned)
    mocks.execute.mockImplementation(async (_execution, dependencies) => {
      const checkpoint = { executionId: 'execution', steps: [], integrity: `0x${'33'.repeat(32)}` }
      await dependencies.save(checkpoint)
      return checkpoint
    })

    await expect(acquirePaymentShortfalls(input())).resolves.toBe(true)

    expect(mocks.plan).toHaveBeenCalledWith(
      expect.objectContaining({
        requirements: [
          expect.objectContaining({ id: 'filecoin-fil', amount: 7n }),
          expect.objectContaining({ id: 'filecoin-usdfc', amount: 11n }),
        ],
      }),
      expect.objectContaining({ integratorId: 'test-integrator' })
    )
    expect(mocks.execute).toHaveBeenCalledOnce()
    expect(clear).toHaveBeenCalledOnce()
  })

  it('resumes an interrupted library checkpoint without replanning source spend', async () => {
    const planned = [
      quote('fil', { id: 'filecoin-fil', amount: 7n, token: '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee' }),
      quote('usdfc', { id: 'filecoin-usdfc', amount: 11n, token: '0x80B98d3aa09ffff255c3ba4A241111Ff1262F045' }),
    ]
    mocks.plan.mockResolvedValue(planned)
    mocks.quote.mockImplementation(async ({ requirement, sourceAmount }) => ({
      ...planned.find((item) => item.requirement.id === requirement.id),
      requirement,
      sourceAmount,
      source: SOURCE,
    }))
    const checkpoint = {
      executionId: 'execution',
      steps: [
        {
          kind: 'route',
          requirementId: 'filecoin-fil',
          attempt: 0,
          nativeFee: 1n,
          from: OWNER,
          to: '0xce16F69375520ab01377ce7B88f5BA8C48F8D666',
          dataHash: `0x${'44'.repeat(32)}`,
          value: 0n,
          nonce: 1,
          gas: 1n,
          transactionHash: `0x${'55'.repeat(32)}`,
        },
      ],
      integrity: `0x${'33'.repeat(32)}`,
    }
    mocks.execute
      .mockImplementationOnce(async (_execution, dependencies) => {
        await dependencies.save(checkpoint)
        throw new Error('interrupted')
      })
      .mockImplementationOnce(async (_execution, dependencies) => {
        expect(await dependencies.load()).toEqual(checkpoint)
        return checkpoint
      })

    await expect(acquirePaymentShortfalls(input())).rejects.toThrow('interrupted')
    await expect(acquirePaymentShortfalls(input())).resolves.toBe(true)

    expect(mocks.plan).toHaveBeenCalledOnce()
    expect(mocks.fetchCatalog).toHaveBeenCalledOnce()
    expect(mocks.quote).toHaveBeenCalledTimes(2)
    expect(mocks.execute).toHaveBeenCalledTimes(2)
  })

  it('configures OP Stack total-fee accounting and a non-decreasing buffer', async () => {
    const baseSource = { ...SOURCE, chain: { chainId: 8453, networkName: 'Base' } }
    mocks.resolveSource.mockReturnValue(baseSource)
    const planned = [
      {
        ...quote('fil', { id: 'filecoin-fil', amount: 7n, token: '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee' }),
        source: baseSource,
      },
      {
        ...quote('usdfc', { id: 'filecoin-usdfc', amount: 11n, token: '0x80B98d3aa09ffff255c3ba4A241111Ff1262F045' }),
        source: baseSource,
      },
    ]
    mocks.plan.mockResolvedValue(planned)
    mocks.execute.mockImplementation(async () => ({
      executionId: 'execution',
      steps: [],
      integrity: `0x${'33'.repeat(32)}`,
    }))

    await acquirePaymentShortfalls({ ...input(), options: { ...input().options, fromChain: 'base' } })

    expect(mocks.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        feeMode: 'op-stack',
        maxNativeFee: 3_000_000_000_000_000n,
        opStackFeeBuffer: expect.any(Function),
      }),
      expect.anything()
    )
    const execution = mocks.execute.mock.calls[0]?.[0]
    const buffer = execution?.opStackFeeBuffer
    expect(buffer).toBeTypeOf('function')
    expect(buffer?.(0n)).toBe(0n)
    expect(buffer?.(1n)).toBe(2n)
    expect(buffer?.(7n)).toBe(9n)
    expect(buffer?.(parseEther('1'))).toBe(parseEther('1.25'))
  })
})
