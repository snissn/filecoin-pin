import { createHash, randomUUID } from 'node:crypto'
import { chmod, lstat, mkdir, open, readFile, rename, rm } from 'node:fs/promises'
import { join } from 'node:path'
import type {
  DestinationRequirement,
  SourceToken,
  SquidExecutionCheckpoint,
} from 'squid-evm-funding'
import type { Address } from 'viem'
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
}

const BIGINT = '$filecoinPinBigint'

function stringify(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) =>
    typeof item === 'bigint' ? { [BIGINT]: item.toString() } : item
  )
}

function parse(raw: string): unknown {
  return JSON.parse(raw, (_key, item: unknown) => {
    const encoded =
      item != null && typeof item === 'object' ? (item as Record<string, unknown>)[BIGINT] : undefined
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

/** Hold one owner-wide lock so two CLI processes cannot sign the same source operation concurrently. */
export async function openSquidCheckpointStore(owner: Address): Promise<SquidCheckpointStore> {
  const directory = join(process.env.SQUID_CHECKPOINT_DIR ?? getDataDirectory(), 'squid-funding')
  await mkdir(directory, { recursive: true, mode: 0o700 })
  if (process.platform !== 'win32') await chmod(directory, 0o700)
  const identity = createHash('sha256').update(owner.toLowerCase()).digest('hex')
  const path = join(directory, `${identity}.json`)
  const lockPath = join(directory, `${identity}.lock`)
  let lock
  try {
    lock = await open(lockPath, 'wx', 0o600)
    await lock.writeFile(`${process.pid}\n`)
    await lock.sync()
    await syncDirectory(directory)
  } catch (error) {
    if (lock != null) {
      await lock.close().catch(() => undefined)
      await rm(lockPath, { force: true }).catch(() => undefined)
    }
    throw new Error('Another Squid funding operation is active, or its lock requires manual reconciliation', {
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
      return value
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      throw error
    }
  }
  const save = async (state: SquidFundingState): Promise<void> => {
    if (!isState(state)) throw new Error('Invalid Squid funding state')
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
    try {
      await lock.close()
    } finally {
      await rm(lockPath, { force: true })
      await syncDirectory(directory)
    }
  }
  return { load, save, clear, release }
}

export function createSquidFundingState(input: {
  owner: Address
  source: SourceToken
  requirements: readonly DestinationRequirement[]
  sourceAmounts: readonly bigint[]
}): SquidFundingState {
  if (input.requirements.length !== input.sourceAmounts.length) {
    throw new Error('Squid funding requirements and source amounts do not match')
  }
  return {
    version: 1,
    operationId: randomUUID(),
    owner: input.owner,
    source: input.source,
    requirements: input.requirements.map((requirement, index) => {
      const sourceAmount = input.sourceAmounts[index]
      if (sourceAmount == null || sourceAmount <= 0n) throw new Error('Squid funding source amount is missing')
      return { ...requirement, sourceAmount }
    }),
  }
}
