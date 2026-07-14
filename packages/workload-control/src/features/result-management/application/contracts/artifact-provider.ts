import type { MutationFence } from "@workload-funnel/kernel";

import type { ResultEntry } from "../../domain/result-manifest.js";

export type ArtifactCapability = "verify_finalized_bytes" | "retention_delete";

export interface ArtifactVerificationCommand {
  readonly operationId: string;
  readonly resultManifestId: string;
  readonly immutableStagingIdentity: string;
  readonly manifestDigest: string;
  readonly expectedEntries: readonly ResultEntry[];
  readonly mutationFence: MutationFence;
  readonly stagingMutationFence: MutationFence;
  readonly stagingMutationFenceFingerprint: string;
}

export interface ArtifactVerificationReceipt {
  readonly operationId: string;
  readonly providerId: string;
  readonly resultManifestId: string;
  readonly immutableStagingIdentity: string;
  readonly manifestDigest: string;
  readonly verifiedEntries: readonly ResultEntry[];
  readonly verifiedAtMs: number;
  readonly status: "verified";
}

export interface ArtifactDeleteCommand {
  readonly operationId: string;
  readonly resultManifestId: string;
  readonly immutableStagingIdentity: string;
  readonly entryDigests: readonly string[];
  readonly mutationFence: MutationFence;
  readonly stagingMutationFence: MutationFence;
  readonly stagingMutationFenceFingerprint: string;
}

export interface ArtifactDeleteReceipt {
  readonly operationId: string;
  readonly providerId: string;
  readonly resultManifestId: string;
  readonly status: "deleted" | "unknown";
  readonly mutationFence: MutationFence;
  readonly mutationFenceFingerprint: string;
  readonly providerReceiptId: string;
  readonly verifiedAtMs?: number;
}

export interface ArtifactDeleteReconciliationReceipt {
  readonly operationId: string;
  readonly providerId: string;
  readonly providerReceiptId: string;
  readonly resultManifestId: string;
  readonly mutationFence: MutationFence;
  readonly mutationFenceFingerprint: string;
  readonly reconciledAtMs: number;
  readonly status: "verified_absent" | "still_present";
}

export interface ArtifactProvider {
  readonly providerId: string;
  readonly capabilities: readonly ArtifactCapability[];
  verify?(
    command: ArtifactVerificationCommand,
  ): Promise<ArtifactVerificationReceipt>;
  delete?(command: ArtifactDeleteCommand): Promise<ArtifactDeleteReceipt>;
  reconcileDelete?(
    command: ArtifactDeleteCommand,
  ): Promise<ArtifactDeleteReconciliationReceipt>;
}

export interface ArtifactProviderSet {
  select(providerId: string, capability: ArtifactCapability): ArtifactProvider;
  readonly providers: readonly ArtifactProvider[];
}

export function createArtifactProviderSet(
  input: Readonly<{
    providers: readonly ArtifactProvider[];
  }>,
): ArtifactProviderSet {
  const providers = Object.freeze([...input.providers]);
  const byCapability = new Map<string, ArtifactProvider>();
  for (const provider of providers) {
    for (const capability of provider.capabilities) {
      const key = `${provider.providerId}\u0000${capability}`;
      if (!provider.providerId || byCapability.has(key))
        throw new Error("ambiguous_artifact_capability");
      if (
        capability === "verify_finalized_bytes" &&
        provider.verify === undefined
      )
        throw new Error("artifact_verifier_missing_operation");
      if (capability === "retention_delete" && provider.delete === undefined)
        throw new Error("artifact_delete_missing_operation");
      if (
        capability === "retention_delete" &&
        provider.reconcileDelete === undefined
      )
        throw new Error("artifact_delete_reconciliation_missing_operation");
      byCapability.set(key, provider);
    }
  }
  return Object.freeze({
    providers,
    select(providerId: string, capability: ArtifactCapability) {
      const provider = byCapability.get(`${providerId}\u0000${capability}`);
      if (provider === undefined)
        throw new Error("unschedulable_missing_capability");
      return provider;
    },
  });
}
