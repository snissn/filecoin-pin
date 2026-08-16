import { describe, expect, it } from 'vitest'
import { servicesCommand } from '../../commands/services.js'
import { formatServiceQuote, formatServiceSubscription } from '../../services/index.js'

const address = (digit: string) => `0x${digit.repeat(40)}` as const
const hash = (digit: string) => `0x${digit.repeat(64)}` as const

describe('services command', () => {
  it('exposes only the signer-free C0 read surface', () => {
    expect(servicesCommand.commands.map((command) => command.name())).toEqual(['catalog', 'quote', 'list', 'show'])
    for (const command of servicesCommand.commands) {
      expect(command.options.some((option) => option.long === '--private-key')).toBe(false)
      expect(command.options.some((option) => option.long === '--session-key')).toBe(false)
    }
  })

  it('renders exact resource identity and does not overstate assurance', () => {
    const rendered = formatServiceQuote({
      serviceId: hash('1'),
      serviceName: 'Filone Managed Storage',
      assuranceKind: 0,
      resource: {
        kind: 0,
        chainId: 314159n,
        anchor: address('2'),
        resourceId: 42n,
        context: hash('0'),
      },
      ratePerEpoch: 123n,
      validThroughEpoch: 999n,
      billable: true,
    })

    expect(rendered).toContain('Filone Managed Storage')
    expect(rendered).toContain('chain 314159')
    expect(rendered).toContain(address('2'))
    expect(rendered).toContain('data set 42')
    expect(rendered).toContain('CANCELLABLE_ONLY')
    expect(rendered).toContain('not independently verified')
    expect(rendered).toContain('123 base units/epoch')
  })

  it('renders recipients, caps, budget, lifecycle state, and Pay rail identity', () => {
    const rendered = formatServiceSubscription({
      subscriptionId: hash('3'),
      beneficiary: address('4'),
      reporter: address('5'),
      railId: 77n,
      acceptedRatePerEpoch: 123n,
      currentFixedBudget: 456n,
      maxRatePerEpoch: 789n,
      lifetimeCapGross: 1000n,
      remainingLifetimeGross: 544n,
      quoteValidThroughEpoch: 999n,
      assuranceKind: 2,
      dependencyKind: 1,
      state: 3,
    })

    expect(rendered).toContain('rail 77')
    expect(rendered).toContain(address('4'))
    expect(rendered).toContain(address('5'))
    expect(rendered).toContain('TRUSTED_METERING')
    expect(rendered).toContain('provider-reported usage')
    expect(rendered).toContain('PAUSED')
    expect(rendered).toContain('remaining lifetime cap: 544')
  })
})
