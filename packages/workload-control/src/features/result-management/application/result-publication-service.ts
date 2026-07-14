import {
  assertMutationFenceGateOpen,
  type OperationGateSet,
} from "@workload-funnel/workload-control/operation-gating";
import type { MutationFence } from "@workload-funnel/kernel";

import type { ResultStore } from "./contracts/result-store.js";
import {
  finalizeResultManifest,
  stageResultManifest,
  type ResultManifest,
  type ResultStagingEvidence,
  type ResultVerificationEvidence,
} from "../domain/result-manifest.js";

export interface ResultPublicationService {
  applyVerification(
    resultManifestId: string,
    verification: ResultVerificationEvidence,
  ): ResultManifest;
  stage(evidence: ResultStagingEvidence): ResultManifest;
}

export function createResultPublicationService(
  store: ResultStore,
  gates: () => OperationGateSet,
): ResultPublicationService {
  const service: ResultPublicationService = {
    applyVerification(resultManifestId, verification) {
      const current = store.get(resultManifestId);
      if (current === undefined) throw new Error("result_manifest_not_found");
      if (current.complete) {
        if (
          current.verificationReceiptId !== verification.operationId ||
          current.resultManifestId !== verification.resultManifestId ||
          current.immutableStagingIdentity !==
            verification.immutableStagingIdentity ||
          current.manifestDigest !== verification.manifestDigest ||
          current.artifactProviderId !== verification.providerId ||
          JSON.stringify(current.entries) !==
            JSON.stringify(verification.verifiedEntries)
        ) {
          throw new Error("result_verification_receipt_mismatch");
        }
        return current;
      }
      return store.save(
        finalizeResultManifest(current, verification),
        current.version,
      );
    },
    stage(evidence) {
      const mutationFence: MutationFence = evidence.mutationFence;
      const candidate = stageResultManifest(evidence);
      const prior = store.getByAttempt(evidence.attemptId);
      if (prior !== undefined) {
        if (JSON.stringify(prior) !== JSON.stringify(candidate)) {
          throw new Error("result_staging_operation_conflict");
        }
        return prior;
      }
      assertMutationFenceGateOpen(gates(), mutationFence, "result_finalize");
      return store.create(candidate);
    },
  };
  return Object.freeze(service);
}
