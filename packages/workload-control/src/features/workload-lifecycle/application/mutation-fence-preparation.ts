import {
  type DesiredEffect,
  type MutationFence,
  validateMutationFence,
} from "@workload-funnel/kernel";

import type { Attempt } from "../domain/workload-records.js";

export interface SyntheticMutationFencePreparationCommand {
  readonly allocation?: Readonly<{
    allocationId: string;
    ownerFence: number;
  }>;
  readonly attempt: Attempt;
  readonly desiredEffect: DesiredEffect;
  readonly effectScopeKey: string;
  readonly expectedDesiredVersion: number;
  readonly gateRevision: number;
  readonly namespaceId: string;
  readonly requiredGate: string;
  readonly supersessionKey: string;
}

export function prepareSyntheticMutationFence(
  command: SyntheticMutationFencePreparationCommand,
): MutationFence {
  const startApplicable = ["dispatch_submit", "process_start"].includes(
    command.desiredEffect,
  );
  const mutationFence: MutationFence = Object.freeze({
    ...(command.allocation === undefined
      ? {}
      : {
          allocationId: command.allocation.allocationId,
          ownerFence: command.allocation.ownerFence,
        }),
    attemptId: command.attempt.attemptId,
    clusterIncarnation: "synthetic-phase1-cluster",
    clusterIncarnationVersion: 1,
    desiredEffect: command.desiredEffect,
    effectScopeKey: command.effectScopeKey,
    executionGeneration: command.attempt.executionGeneration,
    expectedDesiredVersion: command.expectedDesiredVersion,
    ...(startApplicable
      ? {
          issuedStartRevocationRevision:
            command.attempt.startRevocationRevision,
          startFence: command.attempt.startFence,
        }
      : {}),
    namespaceId: command.namespaceId,
    namespaceWriterEpoch: 1,
    operationGateRevision: command.gateRevision,
    requiredGate: command.requiredGate,
    schemaVersion: 1,
    supersessionKey: command.supersessionKey,
  });
  validateMutationFence(mutationFence);
  return mutationFence;
}
