import { beforeEach, describe, expect, it, vi } from 'vitest'
import { runAutoSetup } from '../../payments/auto.js'

const mocks = vi.hoisted(() => ({
  acquire: vi.fn(),
  getStatus: vi.fn(),
  deposit: vi.fn(),
  checkFIL: vi.fn(),
  checkUSDFC: vi.fn(),
  checkAllowances: vi.fn(),
  setAllowances: vi.fn(),
}))

const owner = '0x1111111111111111111111111111111111111111'
const synapse = {
  chain: { id: 314, name: 'Filecoin - Mainnet' },
  client: { account: { address: owner } },
  payments: {
    accountSummary: vi.fn(async () => ({ availableFunds: 0n })),
  },
  storage: {
    getStorageInfo: vi.fn(async () => ({
      pricing: {
        noCDN: { perTiBPerEpoch: 1n },
        priceList: {},
      },
    })),
  },
}

function isFundingSourceRequested(options: Record<string, unknown>): boolean {
  return ['fromChain', 'fromToken', 'maxSourceAmount', 'sourceRpcUrl', 'slippage'].some((key) => {
    const value = options[key]
    return typeof value === 'string' ? value.trim() !== '' : value != null
  })
}

vi.mock('../../payments/squid-funding.js', () => ({
  acquirePaymentShortfalls: mocks.acquire,
  isFundingSourceRequested,
}))
vi.mock('../../core/synapse/index.js', () => ({
  initializeSynapse: vi.fn(async () => synapse),
  getClientAddress: vi.fn(() => owner),
}))
vi.mock('../../core/payments/index.js', () => ({
  MIN_FIL_FOR_GAS: 100n,
  checkFILBalance: mocks.checkFIL,
  checkUSDFCBalance: mocks.checkUSDFC,
  getPaymentStatus: mocks.getStatus,
  checkAllowances: mocks.checkAllowances,
  checkAndSetAllowances: mocks.setAllowances,
  computeAutoSetupTargetBalance: vi.fn(() => ({ targetBalance: 100n })),
  validatePaymentRequirements: vi.fn(() => ({ isValid: true })),
  validateGasRequirement: vi.fn(() => ({ isValid: true })),
  depositUSDFC: mocks.deposit,
  calculateDepositCapacity: vi.fn(() => ({ gibPerMonth: 1 })),
}))
vi.mock('../../utils/cli-auth.js', () => ({
  parseCLIAuth: vi.fn(() => ({})),
  getCLILogger: vi.fn(() => ({})),
}))
vi.mock('../../utils/cli-helpers.js', () => ({
  intro: vi.fn(),
  outro: vi.fn(),
  cancel: vi.fn(),
  createSpinner: vi.fn(() => ({ start: vi.fn(), stop: vi.fn() })),
}))
vi.mock('../../utils/cli-logger.js', () => ({
  log: { line: vi.fn(), indent: vi.fn(), flush: vi.fn(), message: vi.fn() },
}))
vi.mock('../../payments/setup.js', () => ({
  displayAccountInfo: vi.fn(),
  displayDepositWarning: vi.fn(),
}))
vi.mock('../../core/utils/format.js', () => ({ formatUSDFC: vi.fn((value: bigint) => value.toString()) }))

describe('payments setup --auto source acquisition', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.checkFIL.mockResolvedValue({ balance: 40n, isCalibnet: false, hasSufficientGas: false })
    mocks.checkUSDFC.mockResolvedValue(10n)
    mocks.checkAllowances.mockResolvedValue({ needsUpdate: true })
    mocks.getStatus
      .mockResolvedValueOnce({
        filecoinPayBalance: 0n,
        filBalance: 40n,
        walletUsdfcBalance: 10n,
        currentAllowances: { lockupUsage: 0n },
      })
      .mockResolvedValueOnce({
        filecoinPayBalance: 0n,
        filBalance: 100n,
        walletUsdfcBalance: 100n,
        currentAllowances: { lockupUsage: 0n },
      })
    mocks.acquire.mockResolvedValue(true)
    mocks.deposit.mockResolvedValue({ depositTx: '0xdeposit' })
    mocks.setAllowances.mockResolvedValue({ updated: true, transactionHash: '0xallowance' })
  })

  it('uses the existing setup target, then resumes deposit and ready output', async () => {
    const options = {
      auto: true,
      rateAllowance: '1TiB/month',
      privateKey: `0x${'11'.repeat(32)}`,
      fromChain: 'arbitrum',
      fromToken: 'USDC',
      maxSourceAmount: '1',
      sourceRpcUrl: 'https://source.example',
    }

    await runAutoSetup(options)

    expect(mocks.acquire).toHaveBeenCalledWith(
      expect.objectContaining({
        destinationChainId: 314,
        shortfalls: { fil: 60n, usdfc: 90n },
        requiredWalletUsdfc: 100n,
        options,
      })
    )
    expect(mocks.deposit).toHaveBeenCalledWith(synapse, 100n)
    expect(mocks.setAllowances).toHaveBeenCalledWith(synapse)
  })

  it('skips acquisition and balance refresh when the wallet already covers the setup target', async () => {
    mocks.checkFIL.mockResolvedValue({ balance: 100n, isCalibnet: false, hasSufficientGas: true })
    mocks.checkUSDFC.mockResolvedValue(100n)
    mocks.getStatus.mockReset().mockResolvedValue({
      filecoinPayBalance: 0n,
      filBalance: 100n,
      walletUsdfcBalance: 100n,
      currentAllowances: { lockupUsage: 0n },
    })

    await runAutoSetup({
      auto: true,
      rateAllowance: '1TiB/month',
      fromChain: 'arbitrum',
      fromToken: 'USDC',
      maxSourceAmount: '1',
    })

    expect(mocks.acquire).not.toHaveBeenCalled()
    expect(mocks.getStatus).toHaveBeenCalledOnce()
    expect(mocks.deposit).toHaveBeenCalledWith(synapse, 100n)
  })
})
