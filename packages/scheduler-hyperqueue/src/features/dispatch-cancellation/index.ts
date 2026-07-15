import {
  fingerprintMutationFence,
  type MutationFence,
  validateMutationFence,
} from "@workload-funnel/kernel";
import type { SchedulerShimInvocation } from "@workload-funnel/node-execution/scheduler-shim-entrypoint";
import type {
  MutateHyperQueueRequest,
  SchedulerMutationGatewayClient,
  SchedulerMutationScope,
  SignedSchedulerFenceInstallAcknowledgement,
} from "@workload-funnel/scheduler-hyperqueue/mutation-gateway-authority";
import {
  toExternalDispatchMutationReceipt,
  type ExternalDispatchMutationReceipt,
} from "@workload-funnel/workload-control/dispatch-reconciliation";

export interface HyperQueueCancellationInput {
  readonly acknowledgedInstall: SignedSchedulerFenceInstallAcknowledgement;
  readonly dispatchId: string;
  readonly jobId: string;
  readonly mappingFingerprint: string;
  readonly mutationFence: MutationFence;
  readonly operationId: string;
  readonly scope: SchedulerMutationScope;
  readonly shimInvocation?: Pick<SchedulerShimInvocation, "dispatchId">;
  readonly submitRevocationAcknowledgement: SignedSchedulerFenceInstallAcknowledgement;
  readonly taskId: string;
}

export function createHyperQueueCancelMutation(
  input: HyperQueueCancellationInput,
): MutateHyperQueueRequest {
  const fence: MutationFence = input.mutationFence;
  validateMutationFence(fence);
  if (
    fence.desiredEffect !== "dispatch_cancel" ||
    input.scope.effectKind !== "dispatch_cancel" ||
    input.dispatchId !== input.scope.dispatchId ||
    (input.shimInvocation !== undefined &&
      input.shimInvocation.dispatchId !== input.dispatchId)
  )
    throw new Error("hyperqueue_cancellation_authority_mismatch");
  return Object.freeze({
    acknowledgedInstall: input.acknowledgedInstall,
    mutationFence: fence,
    mutationFenceFingerprint: fingerprintMutationFence(fence),
    operationId: input.operationId,
    payload: Object.freeze({
      dispatchId: input.dispatchId,
      jobId: input.jobId,
      kind: "cancel",
      mappingFingerprint: input.mappingFingerprint,
      taskId: input.taskId,
    }),
    protocolVersion: "phase7.scheduler-mutation-gateway.v1",
    scope: input.scope,
    submitRevocationAcknowledgement: input.submitRevocationAcknowledgement,
  });
}

export interface HyperQueueDispatchCancellationProvider {
  cancelAfterInstall(
    input: HyperQueueCancellationInput,
  ): Promise<ExternalDispatchMutationReceipt>;
}

export interface HyperQueueCancellationObserver {
  readonly observationOrderDurability: string;
  observe(
    input: Readonly<{
      jobId: string;
      mappingFingerprint: string;
      taskId: string;
    }>,
  ): Promise<
    Readonly<{
      schedulerState:
        | "waiting"
        | "running"
        | "finished"
        | "failed"
        | "canceled"
        | "lost"
        | "unknown";
    }>
  >;
}

export function createProvider(
  gateway: SchedulerMutationGatewayClient,
  observer: HyperQueueCancellationObserver,
): HyperQueueDispatchCancellationProvider {
  if (observer.observationOrderDurability !== "restart_durable")
    throw new Error("hyperqueue_cancel_observation_order_not_durable");
  return Object.freeze({
    async cancelAfterInstall(input: HyperQueueCancellationInput) {
      const evidence = await gateway.mutate(
        createHyperQueueCancelMutation(input),
      );
      const acknowledgement = toExternalDispatchMutationReceipt(evidence);
      if (
        acknowledgement.disposition !== "accepted" &&
        acknowledgement.disposition !== "already_applied"
      )
        return acknowledgement;
      try {
        const observation = await observer.observe({
          jobId: input.jobId,
          mappingFingerprint: input.mappingFingerprint,
          taskId: input.taskId,
        });
        if (observation.schedulerState !== "canceled")
          throw new Error("hyperqueue_cancel_not_terminal");
        return acknowledgement;
      } catch {
        return toExternalDispatchMutationReceipt({
          ...acknowledgement.evidence,
          comparisonResult: "cancel_acknowledged_observation_ambiguous",
          outcome: "unknown",
          reason: "hyperqueue_cancel_terminal_observation_required",
        });
      }
    },
  });
}
