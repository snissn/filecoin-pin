import { parseUnits } from 'viem'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
  mockCheckAllowances,
  mockCheckFILBalance,
  mockCheckUSDFCBalance,
  mockDeposit,
  mockEnsureWallet,
  mockGetPaymentStatus,
  mockInitialize,
  mockValidateGasRequirement,
  mockValidatePaymentRequirements,
} = vi.hoisted(() => ({
  mockCheckAllowances: vi.fn(),
  mockCheckFILBalance: vi.fn(),
  mockCheckUSDFCBalance: vi.fn(),
  mockDeposit: vi.fn(),
  mockEnsureWallet: vi.fn(),
  mockGetPaymentStatus: vi.fn(),
  mockInitialize: vi.fn(),
  mockValidateGasRequirement: vi.fn(),
  mockValidatePaymentRequirements: vi.fn(),
}))

vi.mock('../../core/payments/acquisition/orchestrate.js', () => ({
  ensureWalletReadyForFilecoinTransactions: mockEnsureWallet,
}))

vi.mock('../../core/payments/index.js', () => ({
  MIN_FIL_FOR_GAS: 100n,
  calculateDepositCapacity: vi.fn(() => ({ gibPerMonth: 0 })),
  checkAllowances: mockCheckAllowances,
  checkAndSetAllowances: vi.fn(),
  checkFILBalance: mockCheckFILBalance,
  checkUSDFCBalance: mockCheckUSDFCBalance,
  computeAutoSetupTargetBalance: vi.fn(),
  depositUSDFC: mockDeposit,
  getPaymentStatus: mockGetPaymentStatus,
  validateGasRequirement: mockValidateGasRequirement,
  validatePaymentRequirements: mockValidatePaymentRequirements,
}))

vi.mock('../../core/synapse/index.js', () => ({
  getClientAddress: vi.fn(() => '0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf'),
  initializeSynapse: mockInitialize,
}))

vi.mock('../../utils/cli-auth.js', () => ({
  getCLILogger: vi.fn(() => ({})),
  parseCLIAuth: vi.fn(() => ({ privateKey: '0x0000000000000000000000000000000000000000000000000000000000000001' })),
}))

vi.mock('../../utils/cli-helpers.js', () => ({
  cancel: vi.fn(),
  createSpinner: vi.fn(() => ({ start: vi.fn(), stop: vi.fn() })),
  intro: vi.fn(),
  outro: vi.fn(),
}))

vi.mock('../../utils/cli-logger.js', () => ({
  log: { flush: vi.fn(), indent: vi.fn(), line: vi.fn(), message: vi.fn() },
}))

vi.mock('../../payments/setup.js', () => ({
  displayAccountInfo: vi.fn(),
  displayDepositWarning: vi.fn(),
}))

import { runAutoSetup } from '../../payments/auto.js'

const TWO_USDFC = parseUnits('2', 18)

describe('runAutoSetup acquisition integration', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockInitialize.mockResolvedValue({
      chain: { id: 314, name: 'mainnet' },
      payments: { accountSummary: vi.fn().mockResolvedValue({ availableFunds: 0n }) },
      storage: { getStorageInfo: vi.fn().mockResolvedValue({ pricing: { noCDN: { perTiBPerEpoch: 1n } } }) },
    })
    mockCheckFILBalance.mockResolvedValue({ balance: 0n, isCalibnet: false, hasSufficientGas: false })
    mockCheckUSDFCBalance.mockResolvedValue(0n)
    mockCheckAllowances.mockResolvedValue({ needsUpdate: true })
    mockGetPaymentStatus
      .mockResolvedValueOnce({ filecoinPayBalance: 0n, filBalance: 0n, walletUsdfcBalance: 0n, currentAllowances: {} })
      .mockResolvedValueOnce({
        filecoinPayBalance: 0n,
        filBalance: 100n,
        walletUsdfcBalance: TWO_USDFC,
        currentAllowances: {},
      })
    mockValidatePaymentRequirements.mockReturnValue({ isValid: true })
    mockValidateGasRequirement.mockReturnValue({ isValid: true })
    mockEnsureWallet.mockResolvedValue([])
    mockDeposit.mockResolvedValue({ depositTx: '0xdeposit' })
  })

  it('keeps the explicit target and acquires wallet shortfalls before the existing deposit', async () => {
    const order: string[] = []
    mockEnsureWallet.mockImplementation(async () => {
      order.push('acquire')
      return []
    })
    mockDeposit.mockImplementation(async () => {
      order.push('deposit')
      return { depositTx: '0xdeposit' }
    })

    await expect(
      runAutoSetup({
        auto: true,
        deposit: '2',
        rateAllowance: '1TiB/month',
        fromChain: 'arb',
        fromToken: 'USDC',
        maxSourceAmount: '3',
      } as any)
    ).resolves.toBeUndefined()

    expect(mockEnsureWallet).toHaveBeenCalledWith(
      expect.objectContaining({
        destinationChainId: 314,
        requiredUsdfc: TWO_USDFC,
        walletFilBalance: 0n,
        walletUsdfcBalance: 0n,
      })
    )
    expect(mockDeposit).toHaveBeenCalledWith(expect.anything(), TWO_USDFC)
    expect(order).toEqual(['acquire', 'deposit'])
  })
})
