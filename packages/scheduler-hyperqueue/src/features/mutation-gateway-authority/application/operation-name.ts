import { createHash } from "node:crypto";

export const HYPERQUEUE_ADAPTER_KEY = "scheduler-hyperqueue" as const;
export const HYPERQUEUE_ADAPTER_CONTRACT_VERSION = 1 as const;
export const HYPERQUEUE_OPERATION_NAME_CONTRACT =
  "workload-funnel.hq-operation-name.v1" as const;

const identifierPattern = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/u;
const requestFingerprintPattern = /^[a-f0-9]{64}$/u;
const mutationFenceFingerprintPattern = /^fence-v1-[a-f0-9]{64}$/u;
const canonicalJobNamePattern = /^wf-hq-v1-[A-Za-z0-9_-]{86}$/u;

export interface HyperQueueSubmitOperationIdentity {
  readonly mappingFingerprint: string;
  readonly mutationFenceFingerprint: string;
  readonly operationId: string;
  readonly requestFingerprint: string;
  readonly schedulerInstanceId: string;
}

function assertIdentity(identity: HyperQueueSubmitOperationIdentity): void {
  for (const value of [
    identity.mappingFingerprint,
    identity.operationId,
    identity.schedulerInstanceId,
  ]) {
    if (!identifierPattern.test(value) || value !== value.normalize("NFC"))
      throw new Error("hyperqueue_operation_identity_invalid");
  }
  if (
    !requestFingerprintPattern.test(identity.requestFingerprint) ||
    !mutationFenceFingerprintPattern.test(identity.mutationFenceFingerprint)
  )
    throw new Error("hyperqueue_operation_identity_invalid");
}

export function canonicalHyperQueueOperationJobName(
  identity: HyperQueueSubmitOperationIdentity,
): string {
  assertIdentity(identity);
  const canonicalIdentity = JSON.stringify([
    HYPERQUEUE_OPERATION_NAME_CONTRACT,
    HYPERQUEUE_ADAPTER_KEY,
    HYPERQUEUE_ADAPTER_CONTRACT_VERSION,
    identity.schedulerInstanceId,
    identity.operationId,
    identity.requestFingerprint,
    identity.mappingFingerprint,
    identity.mutationFenceFingerprint,
  ]);
  const digest = createHash("sha512")
    .update(canonicalIdentity, "utf8")
    .digest("base64url");
  const name = `wf-hq-v1-${digest}`;
  if (!canonicalJobNamePattern.test(name))
    throw new Error("hyperqueue_operation_job_name_invalid");
  return name;
}

export function validateCanonicalHyperQueueOperationJobName(
  identity: HyperQueueSubmitOperationIdentity,
  jobName: string,
): void {
  if (
    !canonicalJobNamePattern.test(jobName) ||
    jobName !== canonicalHyperQueueOperationJobName(identity)
  )
    throw new Error("hyperqueue_operation_job_name_invalid");
}
