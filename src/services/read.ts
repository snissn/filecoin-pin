import { readFile } from 'node:fs/promises'
import {
  bossAccountSnapshotCall,
  bossQuoteSnapshotCall,
  bossServiceRegistryAbi,
  bossSubscriptionPageCall,
  bossSubscriptionSnapshotCall,
  parseBossDeploymentManifest,
} from '@filoz/synapse-core/boss'
import {
  createPublicClient,
  defineChain,
  getAbiItem,
  http,
} from 'viem'
import { getLogs, readContract } from 'viem/actions'
import type {
  ServicesCatalogOptions,
  ServicesListOptions,
  ServicesQuoteOptions,
  ServicesReadBaseOptions,
  ServicesShowOptions,
} from './types.js'

const MAX_PAGE_SIZE = 32n

export async function loadBossManifest(path: string) {
  return parseBossDeploymentManifest(JSON.parse(await readFile(path, 'utf8')))
}

async function createBossReadClient(options: ServicesReadBaseOptions) {
  const manifest = await loadBossManifest(options.manifest)
  const rpcUrl = options.rpcUrl ?? process.env.FILECOIN_RPC_URL ?? process.env.RPC_URL
  if (!rpcUrl) throw new Error('A Filecoin RPC URL is required via --rpc-url, FILECOIN_RPC_URL, or RPC_URL')
  const chain = defineChain({
    id: manifest.chainId,
    name: manifest.network,
    nativeCurrency: { name: 'Filecoin', symbol: 'FIL', decimals: 18 },
    rpcUrls: { default: { http: [rpcUrl] } },
  })
  return {
    manifest,
    client: createPublicClient({ chain, transport: http(rpcUrl) }),
  }
}

export async function readServicesCatalog(options: ServicesCatalogOptions) {
  const { manifest, client } = await createBossReadClient(options)
  const event = getAbiItem({ abi: bossServiceRegistryAbi, name: 'ServicePublished' })
  const logs = await getLogs(client, {
    address: manifest.contracts.BossServiceRegistry.address,
    event,
    fromBlock: options.fromBlock ?? BigInt(manifest.contracts.BossServiceRegistry.deploymentBlock),
    toBlock: 'latest',
  })
  return logs.map((log) => ({
    provider: log.args.provider,
    serviceId: log.args.serviceId,
    serviceType: log.args.serviceType,
    serviceVersion: log.args.serviceVersion,
    providerRevision: log.args.providerRevision,
    metadataURI: log.args.metadataURI,
    blockNumber: log.blockNumber,
    transactionHash: log.transactionHash,
    assuranceNotice:
      'Catalog publication is discovery metadata, not an SLA or data-access grant. Inspect and accept the exact signed offer bytes.',
  }))
}

export async function readServicesList(options: ServicesListOptions) {
  const { manifest, client } = await createBossReadClient(options)
  const stateView = manifest.contracts.BossStateView.address
  const offset = options.offset ?? 0n
  const limit = options.limit ?? MAX_PAGE_SIZE
  if (offset < 0n) throw new Error('offset cannot be negative')
  if (limit < 1n || limit > MAX_PAGE_SIZE) throw new Error('limit must be between 1 and 32')
  const account = await readContract(client, bossAccountSnapshotCall({ stateView, account: options.account }))
  const subscriptions = await readContract(
    client,
    bossSubscriptionPageCall({ stateView, account: options.account, offset, limit })
  )
  return { account, subscriptions, offset, limit }
}

export async function readServicesShow(options: ServicesShowOptions) {
  const { manifest, client } = await createBossReadClient(options)
  const stateView = manifest.contracts.BossStateView.address
  const subscription = await readContract(
    client,
    bossSubscriptionSnapshotCall({ stateView, account: options.account, subscriptionId: options.subscriptionId })
  )
  return {
    subscription,
    assuranceNotice:
      'Boss payment authorization does not grant custody or data access. Assurance and termination behavior are the accepted on-chain terms.',
  }
}

export async function readServicesQuote(options: ServicesQuoteOptions) {
  const { manifest, client } = await createBossReadClient(options)
  const stateView = manifest.contracts.BossStateView.address
  const quote = await readContract(
    client,
    bossQuoteSnapshotCall({
      stateView,
      account: options.account,
      subscriptionId: options.subscriptionId,
      resource: options.resource,
      resourceData: options.resourceData ?? '0x',
      pricingData: options.pricingData,
    })
  )
  return {
    quote,
    resource: options.resource,
    assuranceNotice:
      'Quote output is deterministic contract state, not an SLA. No wallet action, deposit, approval, or top-up was performed.',
  }
}

export function printServicesResult(value: unknown, json = false): void {
  if (json) {
    console.log(JSON.stringify(value, bigintJsonReplacer, 2))
    return
  }
  console.log(formatHuman(value))
}

function bigintJsonReplacer(_key: string, value: unknown): unknown {
  return typeof value === 'bigint' ? value.toString() : value
}

function formatHuman(value: unknown): string {
  return JSON.stringify(value, bigintJsonReplacer, 2)
}
