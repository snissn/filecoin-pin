import { beforeEach, describe, expect, it, vi } from 'vitest'
import { runFund } from '../../payments/fund.js'

const { mockConfirm, mockIsCancel, mockCancel, mockPlan, mockDeposit, mockWithdraw, mockAcquire } = vi.hoisted(() => ({
  mockConfirm: vi.fn(),
  mockIsCancel: vi.fn(() => false),
  mockCancel: vi.fn(),
  mockPlan: vi.fn(),
  mockDeposit: vi.fn(),
  mockWithdraw: vi.fn(),
  mockAcquire: vi.fn(async () => false),
}))

vi.mock('@clack/prompts', () => ({
  confirm: mockConfirm,
  isCancel: mockIsCancel,
}))
vi.mock('../../core/synapse/index.js', () => ({
  initializeSynapse: vi.fn(async () => ({
    chain: { id: 314 },
    payments: { accountSummary: vi.fn(async () => ({ funds: 0n })) },
  })),
  getClientAddress: vi.fn(() => '0x1111111111111111111111111111111111111111'),
}))
vi.mock('../../payments/squid-funding.js', () => ({ acquirePaymentShortfalls: mockAcquire }))
vi.mock('../../utils/cli-auth.js', () => ({
  parseCLIAuth: vi.fn(() => ({})),
  getCLILogger: vi.fn(() => ({})),
}))
vi.mock('../../utils/cli-helpers.js', () => ({
  intro: vi.fn(),
  outro: vi.fn(),
  cancel: mockCancel,
  isInteractive: vi.fn(() => true),
  createSpinner: vi.fn(() => ({ start: vi.fn(), stop: vi.fn(), message: vi.fn() })),
}))
vi.mock('../../utils/cli-logger.js', () => ({
  isTTY: vi.fn(() => true),
  log: { line: vi.fn(), indent: vi.fn(), flush: vi.fn(), section: vi.fn() },
}))
vi.mock('../../core/payments/index.js', () => ({
  DEFAULT_LOCKUP_DAYS: 30,
  MIN_FIL_FOR_GAS: 100n,
  planFilecoinPayFunding: mockPlan,
  checkUSDFCBalance: vi.fn(async () => 1_000_000_000_000_000_000_000n),
  depositUSDFC: mockDeposit,
  withdrawUSDFC: mockWithdraw,
  clampDepositToLimit: vi.fn((v: bigint) => v),
  executeFilecoinPayFunding: vi.fn(),
  toStorageRunwaySummary: vi.fn(() => ({})),
}))
vi.mock('../../core/utils/format.js', () => ({
  formatUSDFC: vi.fn((v: bigint) => String(v)),
}))
vi.mock('../../core/utils/index.js', () => ({
  formatRunwaySummary: vi.fn(() => []),
}))

function planResult(delta: bigint) {
  return {
    plan: {
      targetType: 'deposit',
      mode: 'exact',
      delta,
      targetDeposit: delta > 0n ? delta : -delta,
      walletShortfall: null as bigint | null,
      projected: { runway: { state: 'active', runwayDays: 60 } },
      current: { runway: { rateUsed: 1n } },
    },
    status: { filBalance: 100n, walletUsdfcBalance: 1_000_000_000_000_000_000_000n },
  }
}

describe('runFund confirmation exit codes', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockIsCancel.mockReturnValue(false)
    mockDeposit.mockResolvedValue({ depositTx: '0xdeposit' })
    process.exitCode = 0
  })

  it('exits with code 2 when the deposit confirmation is declined', async () => {
    mockPlan.mockResolvedValueOnce(planResult(5_000_000_000_000_000_000n))
    mockConfirm.mockResolvedValueOnce(false)

    await runFund({ amount: '5' })

    expect(mockDeposit).not.toHaveBeenCalled()
    expect(mockCancel).toHaveBeenCalledWith('Deposit cancelled by user')
    expect(process.exitCode).toBe(2)
  })

  it('aborts the deposit when the confirmation prompt is cancelled', async () => {
    const cancelSymbol = Symbol('clack:cancel')
    mockPlan.mockResolvedValueOnce(planResult(5_000_000_000_000_000_000n))
    mockConfirm.mockResolvedValueOnce(cancelSymbol)
    mockIsCancel.mockReturnValueOnce(true)

    await runFund({ amount: '5' })

    expect(mockDeposit).not.toHaveBeenCalled()
    expect(process.exitCode).toBe(2)
  })

  it('exits with code 2 when the withdraw confirmation is declined', async () => {
    mockPlan.mockResolvedValueOnce(planResult(-5_000_000_000_000_000_000n))
    mockConfirm.mockResolvedValueOnce(false)

    await runFund({ amount: '5' })

    expect(mockWithdraw).not.toHaveBeenCalled()
    expect(mockCancel).toHaveBeenCalledWith('Withdraw cancelled by user')
    expect(process.exitCode).toBe(2)
  })

  it('keeps a declined confirmation from downgrading a prior failure code', async () => {
    process.exitCode = 1
    mockPlan.mockResolvedValueOnce(planResult(5_000_000_000_000_000_000n))
    mockConfirm.mockResolvedValueOnce(false)

    await runFund({ amount: '5' })

    expect(process.exitCode).toBe(1)
  })

  it('does not invoke the acquisition adapter for a zero adjustment', async () => {
    mockPlan.mockResolvedValueOnce(planResult(0n))

    await runFund({ amount: '5' })

    expect(mockAcquire).not.toHaveBeenCalled()
  })

  it('passes the exact FIL and USDFC shortfalls before resuming the deposit', async () => {
    const result = planResult(500n)
    result.plan.walletShortfall = 300n
    result.status.filBalance = 40n
    mockPlan.mockResolvedValueOnce(result)
    mockAcquire.mockResolvedValueOnce(true)
    mockConfirm.mockResolvedValueOnce(true)

    await runFund({
      amount: '5',
      fromChain: 'arbitrum',
      fromToken: 'USDC',
      maxSourceAmount: '1',
      sourceRpcUrl: 'https://source.example',
    })

    expect(mockAcquire).toHaveBeenCalledWith(
      expect.objectContaining({
        destinationChainId: 314,
        shortfalls: { fil: 60n, usdfc: 300n },
        requiredWalletUsdfc: 500n,
      })
    )
    expect(mockDeposit).toHaveBeenCalledWith(expect.anything(), 500n)
  })
})
