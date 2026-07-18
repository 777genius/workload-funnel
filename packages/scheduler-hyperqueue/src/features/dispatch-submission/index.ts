import {
  fingerprintMutationFence,
  type MutationFence,
  validateMutationFence,
} from "@workload-funnel/kernel";
import {
  SCHEDULER_SHIM_PROTOCOL,
  type SchedulerShimInvocation,
} from "@workload-funnel/node-execution/scheduler-shim-entrypoint";
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

export interface HyperQueueSubmissionInput {
  readonly acknowledgedInstall: SignedSchedulerFenceInstallAcknowledgement;
  readonly dispatchId: string;
  readonly mappingFingerprint: string;
  readonly mutationFence: MutationFence;
  readonly operationId: string;
  readonly requestedCpuCount: number;
  readonly requiredCustomResources: Readonly<Record<string, number>>;
  readonly scope: SchedulerMutationScope;
  readonly shimInvocation: SchedulerShimInvocation;
}

function encodedShim(invocation: SchedulerShimInvocation): string {
  const protocolVersion: unknown = invocation.protocolVersion;
  if (protocolVersion !== SCHEDULER_SHIM_PROTOCOL)
    throw new Error("hyperqueue_shim_protocol_mismatch");
  const encoded = Buffer.from(JSON.stringify(invocation), "utf8").toString(
    "base64url",
  );
  if (encoded.length > 256 * 1024)
    throw new Error("hyperqueue_shim_invocation_too_large");
  return encoded;
}

export function createHyperQueueSubmitMutation(
  input: HyperQueueSubmissionInput,
): MutateHyperQueueRequest {
  const fence: MutationFence = input.mutationFence;
  validateMutationFence(fence);
  if (
    fence.desiredEffect !== "dispatch_submit" ||
    input.scope.effectKind !== "dispatch_submit" ||
    input.dispatchId !== input.scope.dispatchId ||
    input.shimInvocation.dispatchId !== input.dispatchId ||
    input.shimInvocation.mappingFingerprint !== input.mappingFingerprint
  )
    throw new Error("hyperqueue_submission_authority_mismatch");
  return Object.freeze({
    acknowledgedInstall: input.acknowledgedInstall,
    mutationFence: fence,
    mutationFenceFingerprint: fingerprintMutationFence(fence),
    operationId: input.operationId,
    payload: Object.freeze({
      dispatchId: input.dispatchId,
      kind: "submit",
      mappingFingerprint: input.mappingFingerprint,
      requestedCpuCount: input.requestedCpuCount,
      requiredCustomResources: Object.freeze({
        ...input.requiredCustomResources,
      }),
      restartPolicy: "never",
      shimInvocationBase64: encodedShim(input.shimInvocation),
    }),
    protocolVersion: "phase7.scheduler-mutation-gateway.v1",
    scope: input.scope,
  });
}

export interface HyperQueueDispatchSubmissionProvider {
  submitAfterInstall(
    input: HyperQueueSubmissionInput,
  ): Promise<ExternalDispatchMutationReceipt>;
}

export function createProvider(
  gateway: SchedulerMutationGatewayClient,
): HyperQueueDispatchSubmissionProvider {
  return Object.freeze({
    async submitAfterInstall(input: HyperQueueSubmissionInput) {
      const evidence = await gateway.mutate(
        createHyperQueueSubmitMutation(input),
      );
      return toExternalDispatchMutationReceipt(evidence);
    },
  });
}
