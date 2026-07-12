import type { TerminalizationIntent } from "@workload-funnel/workload-control/workload-lifecycle";

import type {
  StagingDisposition,
  TerminalReleaseReceipt,
} from "../domain/allocation.js";

export interface TerminalReleaseRequest {
  readonly attemptId: string;
  readonly executionGeneration: string;
  readonly intent: TerminalizationIntent;
  readonly allocationId?: string;
  readonly stagingDisposition: StagingDisposition;
  readonly barrierEvidenceDigest: string;
  readonly participantDigests: Readonly<Record<string, string>>;
}

export interface TerminalReleaseReceiptStore {
  release(request: TerminalReleaseRequest): TerminalReleaseReceipt;
  get(
    attemptId: string,
    executionGeneration: string,
    terminalizationIntentId: string,
  ): TerminalReleaseReceipt | undefined;
  verify(receiptId: string): TerminalReleaseReceipt | undefined;
}

export function terminalReleaseKey(request: TerminalReleaseRequest): string {
  return `${request.attemptId}/${request.executionGeneration}/${request.intent.terminalizationIntentId}`;
}

export function createTerminalReleaseReceiptStore(): TerminalReleaseReceiptStore {
  const byKey = new Map<string, TerminalReleaseReceipt>();
  const byProof = new Map<string, TerminalReleaseReceipt>();
  return Object.freeze({
    release(request: TerminalReleaseRequest) {
      if (
        request.intent.executionGeneration !== request.executionGeneration ||
        request.intent.allocationId !== request.allocationId
      )
        throw new Error("release_key_conflict");
      const key = terminalReleaseKey(request);
      const proofId = `terminal-release:${key}`;
      const participantDigests = Object.freeze(
        Object.fromEntries(
          Object.entries(request.participantDigests).sort(([left], [right]) =>
            left.localeCompare(right),
          ),
        ),
      );
      const receipt: TerminalReleaseReceipt =
        request.allocationId === undefined
          ? Object.freeze({
              attemptId: request.attemptId,
              barrierEvidenceDigest: request.barrierEvidenceDigest,
              disposition: request.intent.disposition,
              executionGeneration: request.executionGeneration,
              kind: "terminal_no_allocation",
              participantDigests,
              precedenceDecision: request.intent.precedenceDecision,
              proofId,
              stagingDisposition: request.stagingDisposition,
              terminalEvidenceDigest: request.intent.evidenceDigest,
              terminalEvidenceKind: request.intent.evidenceKind,
              terminalEvidenceVersion: request.intent.evidenceVersion,
              terminalizationIntentId: request.intent.terminalizationIntentId,
            })
          : Object.freeze({
              allocationId: request.allocationId,
              attemptId: request.attemptId,
              barrierEvidenceDigest: request.barrierEvidenceDigest,
              disposition: request.intent.disposition,
              executionGeneration: request.executionGeneration,
              kind: "terminal_release",
              participantDigests,
              precedenceDecision: request.intent.precedenceDecision,
              proofId,
              stagingDisposition: request.stagingDisposition,
              terminalEvidenceDigest: request.intent.evidenceDigest,
              terminalEvidenceKind: request.intent.evidenceKind,
              terminalEvidenceVersion: request.intent.evidenceVersion,
              terminalizationIntentId: request.intent.terminalizationIntentId,
            });
      const prior = byKey.get(key);
      if (prior !== undefined) {
        if (JSON.stringify(prior) !== JSON.stringify(receipt)) {
          throw new Error("release_key_conflict");
        }
        return prior;
      }
      byKey.set(key, receipt);
      byProof.set(proofId, receipt);
      return receipt;
    },
    get: (
      attemptId: string,
      executionGeneration: string,
      terminalizationIntentId: string,
    ) =>
      byKey.get(
        `${attemptId}/${executionGeneration}/${terminalizationIntentId}`,
      ),
    verify: (receiptId: string) => byProof.get(receiptId),
  });
}
