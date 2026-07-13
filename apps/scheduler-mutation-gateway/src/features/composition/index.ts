import {
  FilesystemGatewayWalStorage,
  GatewayAuthorityRegistry,
  GatewayWal,
} from "@workload-funnel/scheduler-mutation-gateway/authority-registry";
import { createProvider as createAuthorityInstallation } from "@workload-funnel/scheduler-mutation-gateway/authority-installation";
import {
  createProvider as createMutationBoundary,
  type GatewayCliReleaseConfig,
  type GatewayCredentialConfig,
  type GatewayMutationFaults,
} from "@workload-funnel/scheduler-mutation-gateway/hyperqueue-mutation-boundary";
import { createProvider as createRecovery } from "@workload-funnel/scheduler-mutation-gateway/recovery";

export interface SchedulerGatewayCompositionConfig {
  readonly acknowledgementKey: Uint8Array;
  readonly authorityId: string;
  readonly credential: GatewayCredentialConfig;
  readonly faults?: GatewayMutationFaults;
  readonly mode: "production" | "synthetic_research";
  readonly nowMs: () => number;
  readonly release: GatewayCliReleaseConfig;
  readonly trustedInstallKeys: ReadonlyMap<string, Uint8Array>;
  readonly walCapacity: number;
  readonly walPath: string;
}

export function createSchedulerMutationGateway(
  config: SchedulerGatewayCompositionConfig,
) {
  if (config.mode !== "synthetic_research")
    throw new Error("hyperqueue_production_pin_unapproved");
  const wal = new GatewayWal(
    new FilesystemGatewayWalStorage({
      capacity: config.walCapacity,
      path: config.walPath,
    }),
  );
  const registry = new GatewayAuthorityRegistry({
    acknowledgementKey: config.acknowledgementKey,
    authorityId: config.authorityId,
    nowMs: config.nowMs,
    trustedInstallKeys: config.trustedInstallKeys,
    wal,
  });
  const authority = createAuthorityInstallation(registry);
  const mutation = createMutationBoundary(
    registry,
    config.credential,
    config.release,
    config.faults,
  );
  const recovery = createRecovery(registry, mutation);
  return Object.freeze({
    closeAndDrain: (request: Parameters<typeof authority.closeAndDrain>[0]) =>
      authority.closeAndDrain(request),
    install: (request: Parameters<typeof authority.install>[0]) =>
      authority.install(request),
    mutate: mutation.mutate.bind(mutation),
    recovery,
    reopen: (request: Parameters<typeof authority.reopen>[0]) =>
      authority.reopen(request),
  });
}

export async function startSchedulerMutationGateway(
  gateway: ReturnType<typeof createSchedulerMutationGateway>,
) {
  return gateway.recovery.recover();
}
