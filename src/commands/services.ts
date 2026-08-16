import { readFile } from 'node:fs/promises'
import { Command } from 'commander'
import { type Address, type Hex, isAddress, isHex } from 'viem'
import {
  printServicesResult,
  readServicesCatalog,
  readServicesList,
  readServicesQuote,
  readServicesShow,
} from '../services/index.js'

const addReadOptions = (command: Command): Command =>
  command
    .requiredOption('--manifest <path>', 'Receipt-verified Filecoin Boss deployment manifest')
    .option('--rpc-url <url>', 'Filecoin JSON-RPC URL (or FILECOIN_RPC_URL/RPC_URL)')
    .option('--json', 'Emit machine-readable JSON')

const asAddress = (value: string): Address => {
  if (!isAddress(value)) throw new Error(`Invalid address: ${value}`)
  return value
}

const asHex = (value: string, label: string): Hex => {
  if (!isHex(value)) throw new Error(`Invalid ${label}: ${value}`)
  return value
}

const asBigInt = (value: string, label: string): bigint => {
  try {
    const parsed = BigInt(value)
    if (parsed < 0n) throw new Error()
    return parsed
  } catch {
    throw new Error(`Invalid ${label}: ${value}`)
  }
}

export const servicesCommand = new Command('services').description(
  'Inspect Filecoin Boss service offers and subscriptions without a signer'
)

const catalogCommand = addReadOptions(
  new Command('catalog')
    .description('List provider-published Boss service metadata')
    .option('--from-block <block>', 'Override the registry deployment block')
).action(async (options) => {
  const result = await readServicesCatalog({
    manifest: options.manifest,
    rpcUrl: options.rpcUrl,
    json: options.json,
    fromBlock: options.fromBlock === undefined ? undefined : asBigInt(options.fromBlock, 'from block'),
  })
  printServicesResult(result, options.json)
})

const listCommand = addReadOptions(
  new Command('list')
    .description('List bounded Boss subscriptions for one account')
    .requiredOption('--account <address>', 'Boss account address')
    .option('--offset <offset>', 'Subscription offset', '0')
    .option('--limit <limit>', 'Page size from 1 through 32', '32')
).action(async (options) => {
  const result = await readServicesList({
    manifest: options.manifest,
    rpcUrl: options.rpcUrl,
    json: options.json,
    account: asAddress(options.account),
    offset: asBigInt(options.offset, 'offset'),
    limit: asBigInt(options.limit, 'limit'),
  })
  printServicesResult(result, options.json)
})

const showCommand = addReadOptions(
  new Command('show')
    .description('Show one Boss subscription and its verified Pay-rail association')
    .requiredOption('--account <address>', 'Boss account address')
    .argument('<subscription-id>', 'Boss subscription ID')
).action(async (subscriptionId, options) => {
  const result = await readServicesShow({
    manifest: options.manifest,
    rpcUrl: options.rpcUrl,
    json: options.json,
    account: asAddress(options.account),
    subscriptionId: asHex(subscriptionId, 'subscription ID'),
  })
  printServicesResult(result, options.json)
})

const quoteCommand = addReadOptions(
  new Command('quote')
    .description('Recompute a Boss quote from accepted resource and pricing preimages')
    .requiredOption('--account <address>', 'Boss account address')
    .requiredOption('--subscription-id <id>', 'Boss subscription ID')
    .requiredOption('--resource <path>', 'JSON file containing the canonical ResourceRef')
    .requiredOption('--pricing-data <hex>', 'Accepted pricing-data preimage')
    .option('--resource-data <hex>', 'Accepted resource-data preimage', '0x')
).action(async (options) => {
  const resource = JSON.parse(await readFile(options.resource, 'utf8'), (_key, value) => {
    if (typeof value === 'string' && /^\d+$/.test(value)) return BigInt(value)
    return value
  })
  const result = await readServicesQuote({
    manifest: options.manifest,
    rpcUrl: options.rpcUrl,
    json: options.json,
    account: asAddress(options.account),
    subscriptionId: asHex(options.subscriptionId, 'subscription ID'),
    resource,
    resourceData: asHex(options.resourceData, 'resource data'),
    pricingData: asHex(options.pricingData, 'pricing data'),
  })
  printServicesResult(result, options.json)
})

servicesCommand.addCommand(catalogCommand, quoteCommand, listCommand, showCommand)
