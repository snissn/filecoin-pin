import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto'
import { chmod, lstat, mkdir, open, readFile, rename, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { lock as acquireLock } from 'proper-lockfile'
import type { DestinationRequirement, SourceToken, SquidExecutionCheckpoint } from 'squid-evm-funding'
import type { Address, Hex } from 'viem'
import { getDataDirectory } from '../config.js'

interface StoredRequirement {
  id: string
  chainId: number
  token: Address
  amount: bigint
  recipient: Address
  sourceAmount: bigint
}

export interface SquidFundingState {
  version: 1
  operationId: string
  owner: Address
  source: SourceToken
  requirements: StoredRequirement[]
  checkpoint?: SquidExecutionCheckpoint
  stateIntegrity: Hex
}

const BIGINT = '$filecoinPinBigint'

function stringify(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) =>
    typeof item === 'bigint' ? { [BIGINT]: item.toString() } : item
  )
}

function parse(raw: string): unknown {
  return JSON.parse(raw, (_key, item: unknown) => {
    const encoded = item != null && typeof item === 'object' ? (item as Record<string, unknown>)[BIGINT] : undefined
    if (
      item != null &&
      typeof item === 'object' &&
      Object.keys(item).length === 1 &&
      BIGINT in item &&
      typeof encoded === 'string' &&
      /^\d+$/.test(encoded)
    ) {
      return BigInt(encoded)
    }
    return item
  })
}

function isAddress(value: unknown): value is Address {
  return typeof value === 'string' && /^0x[0-9a-fA-F]{40}$/.test(value)
}

function isHash(value: unknown): value is Hex {
  return typeof value === 'string' && /^0x[0-9a-fA-F]{64}$/.test(value)
}

function isCheckpoint(value: unknown): value is SquidExecutionCheckpoint {
  if (value == null || typeof value !== 'object') return false
  const checkpoint = value as Partial<SquidExecutionCheckpoint>
  if (
    typeof checkpoint.executionId !== 'string' ||
    checkpoint.executionId.trim() === '' ||
    !isHash(checkpoint.integrity) ||
    !Array.isArray(checkpoint.steps)
  ) {
    return false
  }
  const keys = new Set<string>()
  for (const value of checkpoint.steps) {
    const step = value as Partial<(typeof checkpoint.steps)[number]>
    if (
      value == null ||
      typeof value !== 'object' ||
      !['approval', 'approval-reset', 'route'].includes(step.kind ?? '') ||
      typeof step.requirementId !== 'string' ||
      step.requirementId.trim() === '' ||
      !Number.isSafeInteger(step.attempt) ||
      (step.attempt as number) < 0 ||
      typeof step.nativeFee !== 'bigint' ||
      step.nativeFee < 0n ||
      !isAddress(step.from) ||
      !isAddress(step.to) ||
      !isHash(step.dataHash) ||
      typeof step.value !== 'bigint' ||
      step.value < 0n ||
      !Number.isSafeInteger(step.nonce) ||
      (step.nonce as number) < 0 ||
      typeof step.gas !== 'bigint' ||
      step.gas <= 0n ||
      (step.maxFeePerGas != null && (typeof step.maxFeePerGas !== 'bigint' || step.maxFeePerGas <= 0n)) ||
      (step.maxPriorityFeePerGas != null &&
        (typeof step.maxPriorityFeePerGas !== 'bigint' || step.maxPriorityFeePerGas < 0n)) ||
      (step.gasPrice != null && (typeof step.gasPrice !== 'bigint' || step.gasPrice <= 0n)) ||
      (step.destinationMinimum != null &&
        (typeof step.destinationMinimum !== 'bigint' || step.destinationMinimum <= 0n)) ||
      (step.quoteId != null && (typeof step.quoteId !== 'string' || step.quoteId.trim() === '')) ||
      (step.requestId != null && (typeof step.requestId !== 'string' || step.requestId.trim() === '')) ||
      (step.fromChainId != null && !Number.isSafeInteger(step.fromChainId)) ||
      (step.toChainId != null && !Number.isSafeInteger(step.toChainId)) ||
      (step.transactionHash != null && !isHash(step.transactionHash)) ||
      (step.receiptStatus != null && !['success', 'reverted'].includes(step.receiptStatus)) ||
      (step.receiptStatus != null && step.transactionHash == null)
    ) {
      return false
    }
    const key = `${step.kind}:${step.requirementId}:${step.attempt}`
    if (keys.has(key)) return false
    keys.add(key)
  }
  return true
}

function isState(value: unknown): value is SquidFundingState {
  if (value == null || typeof value !== 'object') return false
  const state = value as Partial<SquidFundingState>
  return (
    state.version === 1 &&
    typeof state.operationId === 'string' &&
    state.operationId.trim() !== '' &&
    isAddress(state.owner) &&
    state.source != null &&
    Number.isSafeInteger(state.source.chain?.chainId) &&
    typeof state.source.chain?.networkName === 'string' &&
    isAddress(state.source.token) &&
    typeof state.source.symbol === 'string' &&
    Number.isSafeInteger(state.source.decimals) &&
    typeof state.source.native === 'boolean' &&
    (state.checkpoint == null || isCheckpoint(state.checkpoint)) &&
    isHash(state.stateIntegrity) &&
    Array.isArray(state.requirements) &&
    state.requirements.length > 0 &&
    state.requirements.every(
      (requirement) =>
        typeof requirement.id === 'string' &&
        Number.isSafeInteger(requirement.chainId) &&
        isAddress(requirement.token) &&
        typeof requirement.amount === 'bigint' &&
        requirement.amount > 0n &&
        isAddress(requirement.recipient) &&
        typeof requirement.sourceAmount === 'bigint' &&
        requirement.sourceAmount > 0n
    )
  )
}

function integrityPayload(state: SquidFundingState): string {
  return stringify({
    version: state.version,
    operationId: state.operationId,
    owner: state.owner,
    source: state.source,
    requirements: state.requirements,
    ...(state.checkpoint != null ? { checkpoint: state.checkpoint } : {}),
  })
}

function expectedIntegrity(state: SquidFundingState, integrityKey: Hex): Hex {
  const key = Buffer.from(integrityKey.slice(2), 'hex')
  const digest = createHmac('sha256', key)
    .update('filecoin-pin:squid-funding-state:v1\0')
    .update(integrityPayload(state))
    .digest('hex')
  return `0x${digest}`
}

function hasValidIntegrity(state: SquidFundingState, integrityKey: Hex): boolean {
  const actual = Buffer.from(state.stateIntegrity.slice(2), 'hex')
  const expected = Buffer.from(expectedIntegrity(state, integrityKey).slice(2), 'hex')
  return actual.length === expected.length && timingSafeEqual(actual, expected)
}

/** Authenticate the complete source plan and execution checkpoint before persistence. */
export function sealSquidFundingState(state: SquidFundingState, integrityKey: Hex): SquidFundingState {
  const unsigned = { ...state, stateIntegrity: `0x${'00'.repeat(32)}` as Hex }
  return { ...unsigned, stateIntegrity: expectedIntegrity(unsigned, integrityKey) }
}

function assertMonotonic(previous: SquidFundingState | undefined, next: SquidFundingState): void {
  if (previous == null) return
  if (
    previous.operationId !== next.operationId ||
    previous.owner.toLowerCase() !== next.owner.toLowerCase() ||
    stringify(previous.source) !== stringify(next.source) ||
    stringify(previous.requirements) !== stringify(next.requirements)
  ) {
    throw new Error('Squid funding state cannot change within one operation')
  }
  if (previous.checkpoint != null && next.checkpoint == null) {
    throw new Error('Squid funding checkpoint cannot be removed')
  }
  if (
    previous.checkpoint != null &&
    next.checkpoint != null &&
    previous.checkpoint.executionId !== next.checkpoint.executionId
  ) {
    throw new Error('Squid funding checkpoint cannot change executions')
  }
  const previousSteps = previous.checkpoint?.steps ?? []
  const nextSteps = next.checkpoint?.steps ?? []
  const stepKey = (step: (typeof previousSteps)[number]) => `${step.kind}:${step.requirementId}:${step.attempt}`
  const nextByKey = new Map(nextSteps.map((step) => [stepKey(step), step]))
  if (nextByKey.size !== nextSteps.length) throw new Error('Squid funding checkpoint contains duplicate steps')
  for (const step of previousSteps) {
    const updated = nextByKey.get(stepKey(step))
    if (updated == null) {
      if (step.transactionHash == null && step.receiptStatus == null) continue
      throw new Error('Squid funding checkpoint cannot remove a submitted transaction step')
    }
    const stablePrevious = { ...step, transactionHash: undefined, receiptStatus: undefined }
    const stableUpdated = { ...updated, transactionHash: undefined, receiptStatus: undefined }
    if (stringify(stablePrevious) !== stringify(stableUpdated)) {
      throw new Error('Squid funding checkpoint cannot rewrite a transaction intent')
    }
    if (step.transactionHash != null && step.transactionHash !== updated.transactionHash) {
      throw new Error('Squid funding checkpoint cannot replace a transaction hash')
    }
    if (step.receiptStatus != null && step.receiptStatus !== updated.receiptStatus) {
      throw new Error('Squid funding checkpoint cannot replace a transaction receipt')
    }
  }
}

async function syncDirectory(directory: string): Promise<void> {
  // Windows does not support opening directories for fsync. File sync plus
  // atomic rename is the strongest portable equivalent there.
  if (process.platform === 'win32') return
  const handle = await open(directory, 'r')
  try {
    await handle.sync()
  } finally {
    await handle.close()
  }
}

export interface SquidCheckpointStore {
  load: () => Promise<SquidFundingState | undefined>
  save: (state: SquidFundingState) => Promise<void>
  clear: () => Promise<void>
  release: () => Promise<void>
}

/** Hold one owner-wide renewable lock so two CLI processes cannot sign the same source operation concurrently. */
export async function openSquidCheckpointStore(
  owner: Address,
  integrityKey: Hex,
  lockOptions: { staleMs?: number } = {}
): Promise<SquidCheckpointStore> {
  const directory = join(process.env.SQUID_CHECKPOINT_DIR ?? getDataDirectory(), 'squid-funding')
  await mkdir(directory, { recursive: true, mode: 0o700 })
  if (process.platform !== 'win32') await chmod(directory, 0o700)
  const identity = createHash('sha256').update(owner.toLowerCase()).digest('hex')
  const path = join(directory, `${identity}.json`)
  const lockPath = join(directory, `${identity}.owner`)
  const stale = lockOptions.staleMs ?? 300_000
  let releaseLock: (() => Promise<void>) | undefined
  try {
    releaseLock = await acquireLock(lockPath, {
      realpath: false,
      retries: 0,
      stale,
      update: Math.max(1_000, Math.floor(stale / 3)),
    })
  } catch (error) {
    throw new Error('Another Squid funding operation is active', {
      cause: error instanceof Error ? error : undefined,
    })
  }

  let released = false
  const load = async (): Promise<SquidFundingState | undefined> => {
    try {
      const details = await lstat(path)
      if (!details.isFile()) throw new Error('Squid funding state is not a regular file')
      const value = parse(await readFile(path, 'utf8'))
      if (!isState(value)) throw new Error('Invalid Squid funding state')
      if (!hasValidIntegrity(value, integrityKey)) throw new Error('Squid funding state failed its integrity check')
      return value
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      throw error
    }
  }
  const save = async (state: SquidFundingState): Promise<void> => {
    if (!isState(state)) throw new Error('Invalid Squid funding state')
    if (!hasValidIntegrity(state, integrityKey)) throw new Error('Squid funding state failed its integrity check')
    assertMonotonic(await load(), state)
    const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`
    try {
      const handle = await open(temporary, 'wx', 0o600)
      try {
        await handle.writeFile(`${stringify(state)}\n`)
        await handle.sync()
      } finally {
        await handle.close()
      }
      await rename(temporary, path)
      await syncDirectory(directory)
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => undefined)
      throw error
    }
  }
  const clear = async () => {
    await rm(path, { force: true })
    await syncDirectory(directory)
  }
  const release = async () => {
    if (released) return
    released = true
    await releaseLock()
  }
  return { load, save, clear, release }
}

export function createSquidFundingState(input: {
  owner: Address
  source: SourceToken
  requirements: readonly DestinationRequirement[]
  sourceAmounts: readonly bigint[]
  integrityKey: Hex
}): SquidFundingState {
  if (input.requirements.length !== input.sourceAmounts.length) {
    throw new Error('Squid funding requirements and source amounts do not match')
  }
  return sealSquidFundingState(
    {
      version: 1,
      operationId: randomUUID(),
      owner: input.owner,
      source: input.source,
      requirements: input.requirements.map((requirement, index) => {
        const sourceAmount = input.sourceAmounts[index]
        if (sourceAmount == null || sourceAmount <= 0n) throw new Error('Squid funding source amount is missing')
        return { ...requirement, sourceAmount }
      }),
      stateIntegrity: `0x${'00'.repeat(32)}`,
    },
    input.integrityKey
  )
}
