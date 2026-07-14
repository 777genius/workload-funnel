import type {
  AllocationService,
  OwnerSafeCapacityReservationLedgerStore,
} from "@workload-funnel/workload-control/allocation-leasing";
import type { CanonicalCoordinator } from "@workload-funnel/workload-control/canonical-transaction-coordination";
import type { DeterministicExecutor } from "@workload-funnel/workload-control/execution-reconciliation";
import type { ResultManagementService } from "@workload-funnel/workload-control/result-management";
import {
  recordTerminalizationIntent,
  transitionAttempt,
  transitionRun,
  type TerminalOutcome,
  type WorkloadLifecycleService,
  type WorkloadStatus,
} from "@workload-funnel/workload-control/workload-lifecycle";

import { prepareSyntheticEffectFence } from "./synthetic-fence-flow.js";
import type {
  SyntheticExternalLifecycle,
  SyntheticRuntimeContext,
} from "./synthetic-external-lifecycle-contracts.js";
import type { DurableState } from "./synthetic-state.js";

export function createSyntheticExternalLifecycle(input: {
  readonly allocationLedger: OwnerSafeCapacityReservationLedgerStore;
  readonly allocations: AllocationService;
  readonly coordinator: CanonicalCoordinator;
  readonly executor: DeterministicExecutor;
  readonly lifecycle: WorkloadLifecycleService;
  readonly principalId: string;
  readonly results: ResultManagementService;
  readonly state: DurableState;
  readonly appendAudit: (
    operationId: string,
    actor: string,
    action: string,
    resourceId: string,
  ) => unknown;
}): SyntheticExternalLifecycle {
  const status = (runId: string): WorkloadStatus => {
    const value = input.lifecycle.status(
      {
        namespaceId: "test://phase1/walking-slice",
        principalId: input.principalId,
        tenantId: "synthetic-tenant",
      },
      runId,
    );
    if (value === undefined) throw new Error("Run does not exist");
    return value;
  };
  const runtimeContext = (runId: string): SyntheticRuntimeContext => {
    const current = status(runId);
    const allocation = input.allocations.getByAttempt(
      current.attempt.attemptId,
    );
    if (
      allocation === undefined ||
      current.attempt.allocationId !== allocation.allocationId ||
      current.attempt.dispatchId === undefined
    )
      throw new Error("Runtime context is not ready");
    const execution = input.executor.get(current.attempt.dispatchId);
    const processFence = prepareSyntheticEffectFence(
      input.state,
      current.attempt,
      "process_start",
      "process_start",
      `process:${current.attempt.attemptId}`,
      1,
      allocation,
    );
    return Object.freeze({
      allocation,
      attempt: current.attempt,
      ...(execution === undefined ? {} : { execution }),
      processFence: Object.freeze({
        ...processFence,
        nodeBootEpoch: 1,
        nodeId: allocation.nodeId,
        notAfter: 10_000,
        notBefore: 1_000,
      }),
    });
  };
  const service: SyntheticExternalLifecycle = {
    applyResultVerification(runId, resultManifestId, verification) {
      const current = status(runId);
      if (current.attempt.state !== "publishing_results")
        throw new Error("result_verification_lifecycle_mismatch");
      return input.coordinator.execute(
        "finalize-result-v1",
        `verify-result:${verification.operationId}`,
        () => {
          const manifest = input.results.applyVerification(
            resultManifestId,
            verification,
          );
          if (
            manifest.attemptId !== current.attempt.attemptId ||
            manifest.executionId !== current.attempt.executionId ||
            !manifest.complete
          )
            throw new Error("result_verification_identity_mismatch");
          if (current.attempt.resultManifestId === undefined) {
            input.lifecycle.applyAttempt(
              Object.freeze({
                ...current.attempt,
                resultManifestId: manifest.resultManifestId,
                version: current.attempt.version + 1,
              }),
            );
          } else if (
            current.attempt.resultManifestId !== manifest.resultManifestId
          )
            throw new Error("result_manifest_attachment_conflict");
          return manifest;
        },
      );
    },
    progressTerminal(command) {
      let current = status(command.runId);
      const existingIntent = current.attempt.terminalizationIntent;
      let release =
        existingIntent === undefined
          ? undefined
          : input.allocationLedger.terminalReleaseReceipt(
              current.attempt.attemptId,
              current.attempt.executionGeneration,
              existingIntent.terminalizationIntentId,
            );
      if (
        ["succeeded", "failed", "canceled", "lost"].includes(
          current.attempt.state,
        )
      )
        return Object.freeze({
          phase: "completed",
          ...(release === undefined ? {} : { release }),
          status: current,
        });
      if (existingIntent === undefined) {
        input.coordinator.execute(
          "record-attempt-terminal-intent-v1",
          `intent:${command.creatingOperationId}`,
          () => {
            input.lifecycle.applyAttempt(
              recordTerminalizationIntent(current.attempt, {
                ...(current.attempt.allocationId === undefined
                  ? {}
                  : { allocationId: current.attempt.allocationId }),
                creatingOperationId: command.creatingOperationId,
                disposition: command.disposition,
                evidenceDigest: command.evidenceDigest,
                evidenceKind: command.evidenceKind,
                evidenceVersion: 1,
                executionGeneration: current.attempt.executionGeneration,
                precedenceDecision: "completion_won",
              }),
            );
          },
        );
        return Object.freeze({
          phase: "intent_recorded",
          status: status(command.runId),
        });
      }
      if (release === undefined) {
        release = input.coordinator.execute(
          "release-allocation-v1",
          `release:${existingIntent.terminalizationIntentId}`,
          () =>
            input.allocationLedger.releaseTerminal({
              ...(current.attempt.allocationId === undefined
                ? {}
                : { allocationId: current.attempt.allocationId }),
              attemptId: current.attempt.attemptId,
              barrierEvidenceDigest: command.evidenceDigest,
              executionGeneration: current.attempt.executionGeneration,
              intent: existingIntent,
              participantDigests: Object.freeze({
                allocation: command.evidenceDigest,
                audit: command.evidenceDigest,
                capacity: command.evidenceDigest,
                lifecycle: command.evidenceDigest,
                result: command.evidenceDigest,
                tenant: command.evidenceDigest,
              }),
              stagingDisposition: "transferred",
            }),
        );
        return Object.freeze({ phase: "released", release, status: current });
      }
      current = status(command.runId);
      const outcome: TerminalOutcome =
        command.disposition === "publication_failure" ||
        command.disposition === "lost"
          ? "failed"
          : command.disposition;
      const terminalRelease = release;
      input.coordinator.execute(
        "apply-attempt-terminal-v2",
        `terminal:${existingIntent.terminalizationIntentId}`,
        () => {
          input.lifecycle.applyAttempt(
            transitionAttempt(
              current.attempt,
              outcome,
              terminalRelease.proofId,
            ),
          );
          input.lifecycle.applyRun(transitionRun(current.run, outcome));
        },
      );
      input.state.queuedCount = Math.max(0, input.state.queuedCount - 1);
      input.appendAudit(
        `terminal:${current.attempt.attemptId}`,
        input.principalId,
        `attempt.${outcome}`,
        current.attempt.attemptId,
      );
      return Object.freeze({
        phase: "completed",
        release: terminalRelease,
        status: status(command.runId),
      });
    },
    reconcileRuntimeTerminal(evidence) {
      return input.coordinator.execute(
        "finalize-result-v1",
        `runtime-terminal:${evidence.classification}:${evidence.observationOperationId}:${evidence.observationRuntimeOperationId}`,
        () => {
          const context = runtimeContext(evidence.runId);
          const dispatchId = context.attempt.dispatchId;
          if (dispatchId === undefined)
            throw new Error("Runtime dispatch is missing");
          const outcome: TerminalOutcome | undefined =
            evidence.classification === "provider_failure"
              ? "failed"
              : evidence.classification === "succeeded" ||
                  evidence.classification === "canceled"
                ? evidence.classification
                : undefined;
          const decision = input.executor.reconcileTerminal(
            {
              ...evidence,
              classification:
                evidence.classification === "unknown" ||
                evidence.classification === "quarantined"
                  ? evidence.classification
                  : "valid",
              dispatchId,
              ...(outcome === undefined ? {} : { outcome }),
            },
            context.processFence,
          );
          const latest = status(evidence.runId);
          if (
            decision.disposition === "terminalized" &&
            latest.attempt.state === "running"
          )
            input.lifecycle.applyAttempt(
              transitionAttempt(latest.attempt, "publishing_results"),
            );
          return decision;
        },
      );
    },
    runtimeContext,
    stageResult(runId, evidence) {
      const current = status(runId);
      if (
        current.attempt.state !== "publishing_results" ||
        evidence.attemptId !== current.attempt.attemptId ||
        evidence.executionId !== current.attempt.executionId
      )
        throw new Error("result_staging_lifecycle_mismatch");
      return input.coordinator.execute(
        "finalize-result-v1",
        `stage-result:${evidence.stagingOperationId}`,
        () => input.results.stage(evidence),
      );
    },
  };
  return Object.freeze(service);
}
