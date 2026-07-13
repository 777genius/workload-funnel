export {
  GatewayAuthorityRegistry,
  type GatewayAuthorityRegistryConfig,
  type PrepareGatewayMutation,
} from "./application/gateway-authority-registry.js";
export { GatewayWal, GatewayWalError } from "./application/gateway-wal.js";
export type { GatewayWalStorage } from "./application/contracts/gateway-wal-storage.js";
export type {
  GatewayWalRecord,
  RecoveredGatewayWalRecord,
} from "./domain/gateway-wal-record.js";
export {
  FilesystemGatewayWalStorage,
  PRODUCTION_SCHEDULER_GATEWAY_WAL,
  type FilesystemGatewayWalConfig,
} from "./filesystem.js";

export type GatewayProvider = GatewayAuthorityRegistryType;

export function createProvider(registry: GatewayProvider): GatewayProvider {
  return registry;
}
import type { GatewayAuthorityRegistry as GatewayAuthorityRegistryType } from "./application/gateway-authority-registry.js";
