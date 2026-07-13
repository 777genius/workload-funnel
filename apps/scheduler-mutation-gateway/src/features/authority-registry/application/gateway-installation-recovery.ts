import {
  fingerprintMutationFence,
  validateMutationFence,
  type MutationFence,
} from "@workload-funnel/kernel";
import {
  compareInstalledSchedulerFence,
  mutationFenceComparisonFields,
  schedulerMutationScopeKey,
  validateSchedulerAuthorityHighWatermarkRecords,
  type SchedulerScopeCloseAcknowledgement,
  type SignedSchedulerFenceInstallAcknowledgement,
} from "@workload-funnel/scheduler-hyperqueue/mutation-gateway-authority";

import {
  applyCrossScopeInstall,
  combineAuthorityComparisons,
  planCrossScopeInstall,
} from "./cross-scope-authority.js";
import {
  validateInstallAcknowledgement,
  validateRecoveredCloseAcknowledgement,
} from "./gateway-installation-schema.js";
import {
  fingerprint,
  scopeState,
  type DurableOperationResult,
  type GatewayRegistryRuntime,
} from "./gateway-registry-runtime.js";
import type { GatewayWalRecord } from "../domain/gateway-wal-record.js";

export interface InstallationRecoveryState {
  readonly closeReceipts: Map<
    string,
    DurableOperationResult<SchedulerScopeCloseAcknowledgement>
  >;
  readonly installReceipts: Map<
    string,
    DurableOperationResult<SignedSchedulerFenceInstallAcknowledgement>
  >;
  readonly reopenOperations: Map<string, string>;
}

export function applyRecoveredInstallationRecord(
  record: GatewayWalRecord,
  sequence: number,
  runtime: GatewayRegistryRuntime,
  recovered: InstallationRecoveryState,
): boolean {
  if (record.kind === "install")
    recoverInstall(record, sequence, runtime, recovered);
  else if (record.kind === "close")
    recoverClose(record, sequence, runtime, recovered);
  else if (record.kind === "reopen")
    recoverReopen(record, sequence, runtime, recovered);
  else return false;
  return true;
}

function recoverInstall(
  record: Extract<GatewayWalRecord, { readonly kind: "install" }>,
  sequence: number,
  runtime: GatewayRegistryRuntime,
  recovered: InstallationRecoveryState,
): void {
  const claims = record.acknowledgement.claims;
  const recoveredFence: MutationFence = record.fence;
  validateMutationFence(recoveredFence);
  validateInstallAcknowledgement(
    record.acknowledgement,
    runtime.authorityId,
    runtime.acknowledgementKey,
  );
  const scopeKey = schedulerMutationScopeKey(claims.scope);
  const state = scopeState(runtime, scopeKey);
  const highWatermarkPlan = planCrossScopeInstall(
    runtime,
    recoveredFence,
    claims.scope,
  );
  const recoveredComparison = combineAuthorityComparisons(
    compareInstalledSchedulerFence(recoveredFence, state.fence, claims.scope),
    highWatermarkPlan.comparison,
  );
  const accepted = claims.result !== "rejected";
  validateSchedulerAuthorityHighWatermarkRecords(
    record.authorityHighWatermarks,
    accepted ? highWatermarkPlan.records : [],
  );
  if (
    claims.registrySequence !== sequence ||
    fingerprintMutationFence(recoveredFence) !==
      record.mutationFenceFingerprint ||
    fingerprint(claims.comparisonFields) !==
      fingerprint(mutationFenceComparisonFields(recoveredFence)) ||
    (accepted &&
      (claims.installedFingerprint !== record.mutationFenceFingerprint ||
        claims.comparisonResult !== recoveredComparison ||
        (claims.result === "installed") !==
          (recoveredComparison === "dominates") ||
        (claims.result === "already_installed") !==
          (recoveredComparison === "equal") ||
        (recoveredComparison !== "dominates" &&
          recoveredComparison !== "equal")))
  )
    throw new Error("gateway_install_recovery_mismatch");
  recovered.installReceipts.set(claims.installOperationId, {
    requestFingerprint: record.requestFingerprint,
    result: record.acknowledgement,
  });
  if (!accepted) return;
  applyCrossScopeInstall(runtime, highWatermarkPlan, scopeKey);
  state.acknowledgement = record.acknowledgement;
  if (claims.drainDisposition === "drained") delete state.cordonReason;
  state.fence = recoveredFence;
  state.fingerprint = claims.installedFingerprint;
  state.invalidatedByCrossScope = false;
  state.registrySequence = sequence;
  state.scope = claims.scope;
}

function recoverClose(
  record: Extract<GatewayWalRecord, { readonly kind: "close" }>,
  sequence: number,
  runtime: GatewayRegistryRuntime,
  recovered: InstallationRecoveryState,
): void {
  validateRecoveredCloseAcknowledgement(record.acknowledgement, sequence);
  const state = scopeState(
    runtime,
    schedulerMutationScopeKey(record.acknowledgement.scope),
  );
  state.closed = true;
  state.registrySequence = sequence;
  if (record.acknowledgement.disposition === "unresolved")
    state.cordonReason = "unresolved_cli_intent";
  recovered.closeReceipts.set(record.acknowledgement.closeOperationId, {
    requestFingerprint: record.requestFingerprint,
    result: record.acknowledgement,
  });
}

function recoverReopen(
  record: Extract<GatewayWalRecord, { readonly kind: "reopen" }>,
  sequence: number,
  runtime: GatewayRegistryRuntime,
  recovered: InstallationRecoveryState,
): void {
  validateInstallAcknowledgement(
    record.installAcknowledgement,
    runtime.authorityId,
    runtime.acknowledgementKey,
  );
  if (
    record.installAcknowledgement.claims.result !== "installed" &&
    record.installAcknowledgement.claims.result !== "already_installed"
  )
    throw new Error("gateway_reopen_recovery_mismatch");
  const state = scopeState(
    runtime,
    schedulerMutationScopeKey(record.installAcknowledgement.claims.scope),
  );
  if (
    state.fingerprint !==
      record.installAcknowledgement.claims.installedFingerprint ||
    state.registrySequence !==
      record.installAcknowledgement.claims.registrySequence
  )
    throw new Error("gateway_reopen_recovery_mismatch");
  state.closed = false;
  state.registrySequence = sequence;
  recovered.reopenOperations.set(
    record.reopenOperationId,
    record.requestFingerprint,
  );
}
