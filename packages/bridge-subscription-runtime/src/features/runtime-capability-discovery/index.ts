import {
  RUNTIME_TARGET_CONTRACT_VERSION,
  type TargetCapabilityDiscovery,
  type TargetCapabilityProvider,
  type TargetCapabilitySet,
  type TargetMutationBoundary,
  type TargetMutationKind,
} from "@workload-funnel/node-execution/process-lifecycle";

import type { RuntimeCapabilityClient } from "./application/contracts/runtime-capability-client.js";

export type { RuntimeCapabilityClient } from "./application/contracts/runtime-capability-client.js";

export const SUBSCRIPTION_RUNTIME_BROKER_CONTRACT =
  "subscription-runtime.broker.v1" as const;

const mutationKinds: ReadonlySet<string> = new Set([
  "create",
  "start",
  "resume",
  "input",
  "update",
  "checkpoint",
  "stop",
  "cancel",
  "delete",
]);
const mutationBoundaries: ReadonlySet<string> = new Set([
  "runtime",
  "provider",
  "session",
]);

type RuntimeCapabilityRecord = Readonly<Record<string, unknown>>;

function asRecord(value: unknown): RuntimeCapabilityRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("runtime_capability_response_malformed");
  }
  return value as RuntimeCapabilityRecord;
}

function booleanField(record: RuntimeCapabilityRecord, field: string): boolean {
  const value = record[field];
  if (typeof value !== "boolean") {
    throw new Error(`runtime_capability_${field}_malformed`);
  }
  return value;
}

function parseCapabilities(
  value: unknown,
  targetId: string,
): TargetCapabilitySet {
  const record = asRecord(value);
  const kinds: unknown = record["mutationKinds"];
  const boundaries: unknown = record["mutationBoundaries"];
  if (
    record["contractVersion"] !== SUBSCRIPTION_RUNTIME_BROKER_CONTRACT ||
    record["targetId"] !== targetId ||
    typeof record["runtimeBuildSha"] !== "string" ||
    !/^[a-f0-9]{40,64}$/u.test(record["runtimeBuildSha"]) ||
    !Array.isArray(kinds) ||
    kinds.some(
      (kind) => typeof kind !== "string" || !mutationKinds.has(kind),
    ) ||
    !Array.isArray(boundaries) ||
    boundaries.length === 0 ||
    boundaries.some(
      (boundary) =>
        typeof boundary !== "string" || !mutationBoundaries.has(boundary),
    )
  ) {
    throw new Error("runtime_capability_response_malformed");
  }
  const parsedKinds = (kinds as unknown[]).map(
    (kind) => kind as TargetMutationKind,
  );
  const parsedBoundaries = (boundaries as unknown[]).map(
    (boundary) => boundary as TargetMutationBoundary,
  );
  return Object.freeze({
    contractVersion: RUNTIME_TARGET_CONTRACT_VERSION,
    cursorSnapshots: booleanField(record, "cursorSnapshots"),
    durableOperationReceipts: booleanField(record, "durableOperationReceipts"),
    foregroundOwnedExecution: booleanField(record, "foregroundOwnedExecution"),
    mutationKinds: Object.freeze(parsedKinds),
    mutationBoundaries: Object.freeze(parsedBoundaries),
    runtimeBuildSha: record["runtimeBuildSha"],
    runtimeMutationFencing: booleanField(record, "runtimeMutationFencing"),
    targetId,
  });
}

function decision(
  capabilities: TargetCapabilitySet,
  requiredMutationKind?: TargetMutationKind,
  requiredMutationBoundary?: TargetMutationBoundary,
): TargetCapabilityDiscovery {
  if (!capabilities.runtimeMutationFencing) {
    return {
      capabilities,
      reason: "required_fencing_unsupported",
      status: "incapable",
    };
  }
  if (!capabilities.durableOperationReceipts) {
    return {
      capabilities,
      reason: "durable_receipts_unsupported",
      status: "incapable",
    };
  }
  if (!capabilities.cursorSnapshots) {
    return {
      capabilities,
      reason: "cursor_snapshot_unsupported",
      status: "incapable",
    };
  }
  if (!capabilities.foregroundOwnedExecution) {
    return {
      capabilities,
      reason: "foreground_ownership_unsupported",
      status: "incapable",
    };
  }
  if (
    requiredMutationKind !== undefined &&
    !capabilities.mutationKinds.includes(requiredMutationKind)
  ) {
    return {
      capabilities,
      reason: "mutation_kind_unsupported",
      status: "incapable",
    };
  }
  if (
    requiredMutationBoundary !== undefined &&
    !capabilities.mutationBoundaries.includes(requiredMutationBoundary)
  ) {
    return {
      capabilities,
      reason: "mutation_boundary_unsupported",
      status: "incapable",
    };
  }
  return { capabilities, status: "capable" };
}

export function createProvider(
  client: RuntimeCapabilityClient,
): TargetCapabilityProvider {
  return Object.freeze({
    async discover(
      targetId: string,
      requiredMutationKind?: TargetMutationKind,
      requiredMutationBoundary?: TargetMutationBoundary,
    ): Promise<TargetCapabilityDiscovery> {
      try {
        return decision(
          parseCapabilities(
            await client.discoverCapabilities(targetId),
            targetId,
          ),
          requiredMutationKind,
          requiredMutationBoundary,
        );
      } catch {
        const capabilities: TargetCapabilitySet = Object.freeze({
          contractVersion: RUNTIME_TARGET_CONTRACT_VERSION,
          cursorSnapshots: false,
          durableOperationReceipts: false,
          foregroundOwnedExecution: false,
          mutationKinds: Object.freeze([]),
          mutationBoundaries: Object.freeze([]),
          runtimeBuildSha: "unknown",
          runtimeMutationFencing: false,
          targetId,
        });
        return {
          capabilities,
          reason: "contract_version_unsupported",
          status: "incapable",
        };
      }
    },
  });
}
