import type { Synapse } from '@filoz/synapse-sdk'
import {
  executeSquidFunding,
  fetchSquidCatalog,
  NATIVE_TOKEN_ADDRESS,
  planSquidFunding,
  quoteSquidRoute,
  resolveSourceToken,
  type DestinationRequirement,
  type SourceToken,
  type SquidPublicClient,
  type SquidQuote,
  type SquidWalletClient,
} from 'squid-evm-funding'
import {
  createPublicClient,
  createWalletClient,
  getAddress,
  http,
  parseUnits,
  type Address,
  type Chain,
  type Hex,
} from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { publicActionsL2 } from 'viem/op-stack'
import { arbitrum, avalanche, base, bsc, filecoin, mainnet as ethereum, optimism, polygon } from 'viem/chains'
import { MIN_FIL_FOR_GAS } from '../core/payments/index.js'
import { mainnet as filecoinMainnet } from '../core/synapse/index.js'
import {
  createSquidFundingState,
  openSquidCheckpointStore,
  type SquidFundingState,
} from './squid-checkpoint.js'
import type { FundingSourceOptions } from './types.js'

const SQUID_ROUTER = getAddress('0xce16F69375520ab01377ce7B88f5BA8C48F8D666')
const FILECOIN_USDFC = filecoinMainnet.contracts.usdfc.address
const REQUEST_TIMEOUT_MS = 15_000

interface SourcePolicy {
  chain: Chain
  names: readonly string[]
  maxNativeFee: bigint
  opStack?: boolean
}

/** Selected product boundary; token support within it is resolved from Squid's live catalog. */
export const SQUID_SOURCE_POLICIES: readonly SourcePolicy[] = [
  { chain: filecoin, names: ['filecoin', 'fil'], maxNativeFee: 30_000_000_000_000_000n },
  { chain: arbitrum, names: ['arbitrum', 'arb'], maxNativeFee: 3_000_000_000_000_000n },
  { chain: ethereum, names: ['ethereum', 'eth'], maxNativeFee: 30_000_000_000_000_000n },
  { chain: base, names: ['base'], maxNativeFee: 3_000_000_000_000_000n, opStack: true },
  { chain: optimism, names: ['optimism', 'op'], maxNativeFee: 3_000_000_000_000_000n, opStack: true },
  { chain: polygon, names: ['polygon', 'matic'], maxNativeFee: 10_000_000_000_000_000n },
  { chain: avalanche, names: ['avalanche', 'avax'], maxNativeFee: 10_000_000_000_000_000n },
  { chain: bsc, names: ['bnb', 'bsc'], maxNativeFee: 5_000_000_000_000_000n },
]

export interface PaymentShortfalls {
  fil: bigint
  usdfc: bigint
}

export interface PaymentAcquisitionSummary {
  source: SourceToken
  quotes: readonly SquidQuote[]
  maxSourceAmount: bigint
}

export interface AcquirePaymentShortfallsInput {
  synapse: Synapse
  owner: Address
  destinationChainId: number
  shortfalls: PaymentShortfalls
  /** Wallet USDFC that must remain available for the later Filecoin Pay deposit. */
  requiredWalletUsdfc: bigint
  options: FundingSourceOptions & { privateKey?: string | undefined }
  confirm?: (summary: PaymentAcquisitionSummary) => Promise<void>
}

function sourcePolicy(name: string | undefined): SourcePolicy {
  const normalized = name?.trim().toLowerCase()
  const matches = SQUID_SOURCE_POLICIES.filter((policy) => policy.names.includes(normalized ?? ''))
  if (matches.length !== 1) throw new Error(`Unsupported source chain: ${name ?? '(missing)'}`)
  return matches[0] as SourcePolicy
}

function selected(source: SourceToken, selector: string): boolean {
  const normalized = selector.trim().toLowerCase()
  if (normalized === 'native') return source.native
  if (/^0x[0-9a-fA-F]{40}$/.test(normalized)) return source.token.toLowerCase() === normalized
  return source.symbol.toLowerCase() === normalized
}

function integrityKey(value: string | undefined): Hex {
  if (value == null || !/^0x[0-9a-fA-F]{64}$/.test(value)) {
    throw new Error('SQUID_CHECKPOINT_INTEGRITY_KEY must be a separate 32-byte hex key')
  }
  return value as Hex
}

function signingAccount(value: string | undefined, owner: Address) {
  if (value == null || value.trim() === '') throw new Error('Source acquisition requires owner private-key auth')
  const normalized = (value.startsWith('0x') ? value : `0x${value}`) as Hex
  const account = privateKeyToAccount(normalized)
  if (account.address.toLowerCase() !== owner.toLowerCase()) {
    throw new Error('The source private key must control the Filecoin payment owner')
  }
  return account
}

function requested(options: FundingSourceOptions): boolean {
  const values = [options.fromChain, options.fromToken, options.maxSourceAmount]
  const count = values.filter((value) => value != null && value.trim() !== '').length
  if (count === 0) return false
  if (count !== values.length) {
    throw new Error('Source acquisition requires --from-chain, --from-token, and --max-source-amount together')
  }
  return true
}

function requirements(input: AcquirePaymentShortfallsInput): DestinationRequirement[] {
  return [
    ...(input.shortfalls.fil > 0n
      ? [
          {
            id: 'filecoin-fil',
            chainId: filecoinMainnet.id,
            token: NATIVE_TOKEN_ADDRESS,
            amount: input.shortfalls.fil,
            recipient: input.owner,
          },
        ]
      : []),
    ...(input.shortfalls.usdfc > 0n
      ? [
          {
            id: 'filecoin-usdfc',
            chainId: filecoinMainnet.id,
            token: FILECOIN_USDFC,
            amount: input.shortfalls.usdfc,
            recipient: input.owner,
          },
        ]
      : []),
  ]
}

function resumable(state: SquidFundingState, current: readonly DestinationRequirement[]): boolean {
  const currentById = new Map(current.map((item) => [item.id, item]))
  const knownIds = new Set(state.requirements.map((item) => item.id))
  if (current.some((item) => !knownIds.has(item.id))) return false
  for (const requirement of state.requirements) {
    const amount = currentById.get(requirement.id)?.amount ?? 0n
    if (amount === requirement.amount) continue
    if (amount > requirement.amount) return false
    const routeWasRecorded = state.checkpoint?.steps.some(
      (step) => step.kind === 'route' && step.requirementId === requirement.id && step.transactionHash != null
    )
    if (routeWasRecorded !== true) return false
  }
  return true
}

function fetchWithTimeout(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  return fetch(input, { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) })
}

function safeMessage(error: unknown, values: readonly (string | undefined)[]): string {
  let message = error instanceof Error ? error.message : String(error)
  for (const value of values) {
    if (value != null && value !== '') message = message.replaceAll(value, '[redacted]')
  }
  return message.replace(/\b(?:https?|wss?):\/\/[^\s'"`<>]+/giu, '[redacted RPC URL]')
}

function makeSourceClients(policy: SourcePolicy, rpcUrl: string, privateKey: string | undefined, owner: Address) {
  const account = signingAccount(privateKey, owner)
  const transport = http(rpcUrl, { timeout: REQUEST_TIMEOUT_MS })
  const basicPublicClient = createPublicClient({ chain: policy.chain, transport })
  const publicClient = policy.opStack === true ? basicPublicClient.extend(publicActionsL2()) : basicPublicClient
  const walletClient = createWalletClient({ account, chain: policy.chain, transport })
  return {
    publicClient: publicClient as unknown as SquidPublicClient,
    walletClient: walletClient as unknown as SquidWalletClient,
  }
}

/** Acquire only the positive FIL/USDFC shortfalls supplied by the existing payment planner. */
export async function acquirePaymentShortfalls(input: AcquirePaymentShortfallsInput): Promise<boolean> {
  if (input.shortfalls.fil <= 0n && input.shortfalls.usdfc <= 0n) return false
  if (!requested(input.options)) {
    throw new Error('The Filecoin wallet is underfunded; fund it directly or provide all source acquisition options')
  }
  if (input.destinationChainId !== filecoinMainnet.id) {
    throw new Error('Source acquisition is available only for Filecoin mainnet')
  }

  const policy = sourcePolicy(input.options.fromChain)
  const tokenSelector = input.options.fromToken as string
  const sourceRpcUrl = input.options.sourceRpcUrl
  if (sourceRpcUrl == null || sourceRpcUrl.trim() === '') {
    throw new Error('Source acquisition requires --source-rpc-url or SOURCE_RPC_URL')
  }
  const squid = {
    integratorId: process.env.SQUID_INTEGRATOR_ID ?? '',
    fetch: fetchWithTimeout,
  }
  if (squid.integratorId.trim() === '') throw new Error('SQUID_INTEGRATOR_ID is required')
  const key = integrityKey(process.env.SQUID_CHECKPOINT_INTEGRITY_KEY)
  const account = signingAccount(input.options.privateKey, input.owner)
  const currentRequirements = requirements(input)
  const store = await openSquidCheckpointStore(input.owner)
  try {
    let state = await store.load()
    let source: SourceToken
    let quotes: SquidQuote[]

    if (state != null) {
      if (state.owner.toLowerCase() !== input.owner.toLowerCase()) {
        throw new Error('Squid funding state belongs to a different owner')
      }
      if (state.source.chain.chainId !== policy.chain.id || !selected(state.source, tokenSelector)) {
        throw new Error('Squid funding state belongs to a different source selection')
      }
      if (!resumable(state, currentRequirements)) {
        if ((state.checkpoint?.steps.length ?? 0) > 0) {
          throw new Error('Wallet shortfalls changed during a submitted Squid operation; reconcile it manually')
        }
        await store.clear()
        state = undefined
      }
    }

    if (state == null) {
      const catalog = await fetchSquidCatalog(squid)
      source = resolveSourceToken(catalog, policy.chain.id, tokenSelector)
      const maximum = parseUnits(input.options.maxSourceAmount as string, source.decimals)
      if (maximum <= 0n) throw new Error('--max-source-amount must be greater than zero')
      quotes = await planSquidFunding(
        {
          owner: input.owner,
          source,
          requirements: currentRequirements,
          maxSourceAmount: maximum,
          slippage: input.options.slippage ?? 1,
        },
        squid
      )
      state = createSquidFundingState({
        owner: input.owner,
        source,
        requirements: currentRequirements,
        sourceAmounts: quotes.map((quote) => quote.sourceAmount),
      })
      await store.save(state)
    } else {
      source = state.source
      quotes = await Promise.all(
        state.requirements.map((requirement) =>
          quoteSquidRoute(
            {
              owner: input.owner,
              source,
              requirement,
              sourceAmount: requirement.sourceAmount,
              slippage: input.options.slippage ?? 1,
            },
            squid
          )
        )
      )
    }

    const maxSourceAmount = parseUnits(input.options.maxSourceAmount as string, source.decimals)
    const plannedSourceAmount = quotes.reduce((total, quote) => total + quote.sourceAmount, 0n)
    if (plannedSourceAmount > maxSourceAmount) throw new Error('Saved Squid operation exceeds the current source cap')
    await input.confirm?.({ source, quotes, maxSourceAmount })

    const clients = makeSourceClients(policy, sourceRpcUrl, input.options.privateKey, input.owner)
    const sourceBalanceFloor =
      policy.chain.id === filecoinMainnet.id && source.token.toLowerCase() === FILECOIN_USDFC.toLowerCase()
        ? input.requiredWalletUsdfc
        : policy.chain.id === filecoinMainnet.id && source.native
          ? MIN_FIL_FOR_GAS
          : 0n
    const nativeBalanceFloor = policy.chain.id === filecoinMainnet.id ? MIN_FIL_FOR_GAS : 0n

    await executeSquidFunding(
      {
        operationId: state.operationId,
        checkpointIntegrityKey: key,
        account: account.address,
        source,
        quotes,
        maxSourceAmount,
        maxNativeFee: policy.maxNativeFee,
        sourceBalanceFloor,
        nativeBalanceFloor,
        trustedTarget: SQUID_ROUTER,
        trustedSpender: SQUID_ROUTER,
        feeMode: policy.opStack === true ? 'op-stack' : 'standard',
        ...(policy.opStack === true ? { opStackFeeBuffer: (fee: bigint) => (fee * 5n + 3n) / 4n } : {}),
        maxPollAttempts: 120,
        pollIntervalMs: 5_000,
      },
      {
        publicClient: clients.publicClient,
        walletClient: clients.walletClient,
        destinationClient: (chainId) => {
          if (chainId !== filecoinMainnet.id) throw new Error(`Unsupported destination chain ${chainId}`)
          return input.synapse.client as unknown as SquidPublicClient
        },
        refreshQuote: (quote) =>
          quoteSquidRoute(
            {
              owner: input.owner,
              source: quote.source,
              requirement: quote.requirement,
              sourceAmount: quote.sourceAmount,
              slippage: input.options.slippage ?? 1,
            },
            squid
          ),
        squidStatusOptions: squid,
        load: async () => state?.checkpoint,
        save: async (checkpoint) => {
          state = { ...(state as SquidFundingState), checkpoint }
          await store.save(state)
        },
      }
    )
    await store.clear()
    return true
  } catch (error) {
    throw new Error(safeMessage(error, [sourceRpcUrl, input.options.privateKey]))
  } finally {
    await store.release()
  }
}
