import type { BossDeploymentManifest, ResourceRef } from '@filoz/synapse-core/boss'
import type { Address, Hex } from 'viem'

export interface ServicesReadBaseOptions {
  manifest: string
  rpcUrl?: string
  json?: boolean
}

export interface ServicesCatalogOptions extends ServicesReadBaseOptions {
  fromBlock?: bigint
}

export interface ServicesListOptions extends ServicesReadBaseOptions {
  account: Address
  offset?: bigint
  limit?: bigint
}

export interface ServicesShowOptions extends ServicesReadBaseOptions {
  account: Address
  subscriptionId: Hex
}

export interface ServicesQuoteOptions extends ServicesShowOptions {
  resource: ResourceRef
  resourceData?: Hex
  pricingData: Hex
}

export interface ServicesReadContext {
  manifest: BossDeploymentManifest
  rpcUrl: string
}
