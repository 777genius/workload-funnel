import type {
  AllocationAuthority,
  AttemptStartAuthority,
  ClusterAuthority,
  ExecutionTicketClaims,
  NamespaceAuthority,
} from "@workload-funnel/node-execution/execution-ticket-validation";
import type { MutationFence } from "@workload-funnel/kernel";
import {
  DurableBreakGlassRegistry,
  type BreakGlassStopInput,
} from "./durable-break-glass-registry.js";
import {
  DurableControlPartitionRegistry,
  type ControlPartitionInput,
  type ControlPartitionResult,
} from "./durable-control-partition-registry.js";
import { compareAuthorityComponents } from "./compare-authority-components.js";
import { assertRecoveredStartBinding } from "./execution-tuple-binding.js";
import { type LauncherWal, LauncherWalError } from "./launcher-wal.js";
import {
  AuthorityRegistryError,
  type AuthorityInstallAcknowledgement,
  type LauncherAuthoritySnapshot,
  type LauncherGateAuthority,
  sameAllocation,
  sameAttempt,
  sameCluster,
  sameNamespace,
  validateSnapshot,
} from "../domain/authority-snapshot.js";
import type { StartWalRecord } from "../domain/launcher-wal-record.js";

export type {
  ControlPartitionInput,
  ControlPartitionResult,
} from "./durable-control-partition-registry.js";
export type { BreakGlassStopInput } from "./durable-break-glass-registry.js";

export interface AuthorizedStartResult<T> {
  readonly result?: T;
  readonly replayed: boolean;
  readonly state: "started" | "unknown";
}

function startRecordKey(record: StartWalRecord): string {
  return `${record.clusterIncarnation}\u0000${record.issuerKeyId}\u0000${record.nonce}`;
}

export class RootAuthorityRegistry {
  readonly #allocations = new Map<string, AllocationAuthority>();
  readonly #attempts = new Map<string, AttemptStartAuthority>();
  readonly #breakGlass: DurableBreakGlassRegistry;
  readonly #controlPartitions: DurableControlPartitionRegistry;
  readonly #effects = new Map<
    string,
    {
      readonly state: "systemd_call_issued" | "applied_or_unknown";
      readonly ticketDigest: string;
    }
  >();
  readonly #gates = new Map<string, LauncherGateAuthority>();
  readonly #installedOperations = new Map<
    string,
    AuthorityInstallAcknowledgement
  >();
  readonly #namespaces = new Map<string, NamespaceAuthority>();
  readonly #scopesClosed = new Set<string>();
  readonly #scopeSnapshots = new Map<string, LauncherAuthoritySnapshot>();
  readonly #scopeWalSequences = new Map<string, number>();
  readonly #starts = new Map<string, StartWalRecord>();
  #cluster: ClusterAuthority | undefined;
  #insideFinalMutation = false;
  #recoveryCordoned = false;

  public constructor(public readonly wal: LauncherWal) {
    this.#breakGlass = new DurableBreakGlassRegistry(
      wal,
      () => this.#starts.values(),
      () => this.#scopeSnapshots,
    );
    this.#controlPartitions = new DurableControlPartitionRegistry(wal, () =>
      this.#starts.values(),
    );
    if (wal.cordonReason !== undefined) {
      this.#recoveryCordoned = true;
      return;
    }
    try {
      for (const recovered of wal.records) {
        if (recovered.record.kind === "authority_installed") {
          const acknowledgement = this.applyInstall(
            recovered.record.snapshot,
            recovered.sequence,
            false,
          );
          this.#installedOperations.set(
            recovered.record.operationId,
            acknowledgement,
          );
        } else if (recovered.record.kind === "start_state") {
          assertRecoveredStartBinding(this.wal, recovered.record);
          this.#starts.set(startRecordKey(recovered.record), recovered.record);
        } else if (recovered.record.kind === "break_glass_stop") {
          this.#breakGlass.recover(recovered.record);
        } else if (recovered.record.kind === "control_partition") {
          this.#controlPartitions.recover(recovered.record);
        } else if (recovered.record.kind === "effect_state") {
          this.#effects.set(recovered.record.operationId, {
            state: recovered.record.state,
            ticketDigest: recovered.record.ticketDigest,
          });
        } else {
          const installed = this.#scopeSnapshots.get(
            recovered.record.effectScopeKey,
          );
          if (
            installed?.mutationFenceFingerprint !==
            recovered.record.installedFingerprint
          ) {
            throw new Error("scope state does not match installed authority");
          }
          if (recovered.record.state === "closed") {
            this.#scopesClosed.add(recovered.record.effectScopeKey);
          } else {
            this.#scopesClosed.delete(recovered.record.effectScopeKey);
          }
        }
      }
    } catch {
      this.#recoveryCordoned = true;
    }
  }

  public get cordoned(): boolean {
    return this.#recoveryCordoned || this.wal.cordonReason !== undefined;
  }

  public get controlPartitioned(): boolean {
    return this.#controlPartitions.active;
  }

  public closeScope(effectScopeKey: string, operationId: string): void {
    if (this.#insideFinalMutation) {
      throw new AuthorityRegistryError(
        "mutation_in_progress",
        "scope cannot close inside the final mutation boundary",
      );
    }
    if (this.#scopesClosed.has(effectScopeKey)) return;
    const installed = this.#scopeSnapshots.get(effectScopeKey);
    if (installed === undefined) {
      throw new AuthorityRegistryError(
        "authority_missing",
        "scope cannot close before authority installation",
      );
    }
    try {
      this.wal.append({
        effectScopeKey,
        installedFingerprint: installed.mutationFenceFingerprint,
        kind: "scope_state",
        operationId,
        state: "closed",
      });
    } catch (error) {
      if (error instanceof LauncherWalError) {
        throw new AuthorityRegistryError(
          "launcher_cordoned",
          "scope closure could not be made durable",
        );
      }
      throw error;
    }
    this.#scopesClosed.add(effectScopeKey);
  }

  public reopenScope(
    effectScopeKey: string,
    installedFingerprint: string,
    operationId: string,
  ): void {
    const installed = this.#scopeSnapshots.get(effectScopeKey);
    if (installed?.mutationFenceFingerprint !== installedFingerprint) {
      throw new AuthorityRegistryError(
        "authority_mismatch",
        "scope may reopen only for the acknowledged installed fingerprint",
      );
    }
    try {
      this.wal.append({
        effectScopeKey,
        installedFingerprint,
        kind: "scope_state",
        operationId,
        state: "open",
      });
    } catch (error) {
      if (error instanceof LauncherWalError) {
        throw new AuthorityRegistryError(
          "launcher_cordoned",
          "scope reopen could not be made durable",
        );
      }
      throw error;
    }
    this.#scopesClosed.delete(effectScopeKey);
  }

  public install(
    operationId: string,
    snapshot: LauncherAuthoritySnapshot,
    expectedPriorFingerprint?: string,
  ): AuthorityInstallAcknowledgement {
    this.assertMutationHealthy();
    if (this.#insideFinalMutation) {
      throw new AuthorityRegistryError(
        "mutation_in_progress",
        "authority cannot change inside the final mutation boundary",
      );
    }
    const priorOperation = this.#installedOperations.get(operationId);
    if (priorOperation !== undefined) {
      if (
        priorOperation.effectScopeKey !==
          snapshot.mutationFence.effectScopeKey ||
        priorOperation.mutationFenceFingerprint !==
          snapshot.mutationFenceFingerprint
      ) {
        throw new AuthorityRegistryError(
          "authority_mismatch",
          "install operation replay changed scope or complete tuple",
        );
      }
      return priorOperation;
    }
    validateSnapshot(snapshot);
    const current = this.#scopeSnapshots.get(
      snapshot.mutationFence.effectScopeKey,
    );
    if (
      expectedPriorFingerprint !== undefined &&
      current?.mutationFenceFingerprint !== expectedPriorFingerprint
    ) {
      throw new AuthorityRegistryError(
        "authority_mismatch",
        "expected prior complete tuple fingerprint does not match",
      );
    }
    const currentNamespace = this.#namespaces.get(
      snapshot.namespace.namespaceId,
    );
    const currentAllocation = this.#allocations.get(
      snapshot.allocation.allocationId,
    );
    const takeover =
      (this.#cluster !== undefined &&
        this.#cluster.version !== snapshot.cluster.version) ||
      (currentNamespace !== undefined &&
        currentNamespace.writerEpoch !== snapshot.namespace.writerEpoch) ||
      (currentAllocation !== undefined &&
        currentAllocation.ownerFence !== snapshot.allocation.ownerFence);
    if (
      takeover &&
      !this.#scopesClosed.has(snapshot.mutationFence.effectScopeKey)
    ) {
      throw new AuthorityRegistryError(
        "mutation_in_progress",
        "takeover install requires a closed and drained effect scope",
      );
    }
    compareAuthorityComponents(
      this.#cluster,
      snapshot,
      currentNamespace,
      currentAllocation,
      this.#attempts.get(snapshot.attempt.attemptId),
      this.#gates.get(snapshot.mutationFence.effectScopeKey),
      current,
    );
    let sequence: number;
    try {
      sequence = this.wal.append({
        kind: "authority_installed",
        operationId,
        snapshot,
      }).sequence;
    } catch (error) {
      if (error instanceof LauncherWalError) {
        throw new AuthorityRegistryError(
          "launcher_cordoned",
          "launcher WAL is unavailable",
        );
      }
      throw error;
    }
    const acknowledgement = this.applyInstall(snapshot, sequence, true);
    this.#installedOperations.set(operationId, acknowledgement);
    return acknowledgement;
  }

  public runAuthorizedStart<T>(
    claims: ExecutionTicketClaims,
    unitName: string,
    ticketDigest: string,
    mutation: () => T,
  ): AuthorizedStartResult<T> {
    this.assertMutationHealthy();
    if (this.#insideFinalMutation) {
      throw new AuthorityRegistryError(
        "mutation_in_progress",
        "nested final mutation is forbidden",
      );
    }
    const scope = claims.mutationFence.effectScopeKey;
    if (this.#scopesClosed.has(scope)) {
      throw new AuthorityRegistryError(
        "authority_mismatch",
        "mutation scope is closed for authority takeover",
      );
    }
    this.assertCompleteAuthority(claims);
    const nonceKey = `${claims.cluster.incarnationId}\u0000${claims.issuerKeyId}\u0000${claims.nonce}`;
    const prior = this.#starts.get(nonceKey);
    if (prior !== undefined) {
      if (prior.ticketDigest !== ticketDigest || prior.unitName !== unitName) {
        throw new AuthorityRegistryError(
          "nonce_replay",
          "redeemed nonce replay changed its immutable start intent",
        );
      }
      if (prior.state === "systemd_call_issued") {
        return { replayed: true, state: "unknown" };
      }
      if (prior.state === "started_or_unknown") {
        return {
          replayed: true,
          state: prior.observedState ?? "unknown",
        };
      }
    }
    this.#insideFinalMutation = true;
    try {
      try {
        this.wal.reserve(prior === undefined ? 3 : 2);
      } catch (error) {
        if (error instanceof LauncherWalError) {
          throw new AuthorityRegistryError(
            "launcher_cordoned",
            "launcher WAL has no safe start receipt reserve",
          );
        }
        throw error;
      }
      if (prior === undefined) {
        this.appendStart({
          attemptId: claims.attempt.attemptId,
          authorityWalSequence: this.installedAuthoritySequence(claims),
          clusterIncarnation: claims.cluster.incarnationId,
          executionDeadlineMs: claims.expiresAtMs,
          executionGeneration: claims.attempt.executionGeneration,
          issuerKeyId: claims.issuerKeyId,
          kind: "start_state",
          mutationFence: claims.mutationFence,
          mutationFenceFingerprint: claims.mutationFenceFingerprint,
          nodeBootEpoch: claims.node.bootEpoch,
          nodeBootId: claims.node.bootId,
          nodeId: claims.node.nodeId,
          nonce: claims.nonce,
          operationId: claims.operationId,
          partitionPolicy: claims.partitionPolicy,
          state: "redeemed",
          ticketDigest,
          unitName,
        });
      }
      this.assertCompleteAuthority(claims);
      this.appendStart({
        attemptId: claims.attempt.attemptId,
        authorityWalSequence: this.installedAuthoritySequence(claims),
        clusterIncarnation: claims.cluster.incarnationId,
        executionDeadlineMs: claims.expiresAtMs,
        executionGeneration: claims.attempt.executionGeneration,
        issuerKeyId: claims.issuerKeyId,
        kind: "start_state",
        mutationFence: claims.mutationFence,
        mutationFenceFingerprint: claims.mutationFenceFingerprint,
        nodeBootEpoch: claims.node.bootEpoch,
        nodeBootId: claims.node.bootId,
        nodeId: claims.node.nodeId,
        nonce: claims.nonce,
        operationId: claims.operationId,
        partitionPolicy: claims.partitionPolicy,
        state: "systemd_call_issued",
        ticketDigest,
        unitName,
      });
      const result = mutation();
      this.appendStart({
        attemptId: claims.attempt.attemptId,
        authorityWalSequence: this.installedAuthoritySequence(claims),
        clusterIncarnation: claims.cluster.incarnationId,
        executionDeadlineMs: claims.expiresAtMs,
        executionGeneration: claims.attempt.executionGeneration,
        issuerKeyId: claims.issuerKeyId,
        kind: "start_state",
        mutationFence: claims.mutationFence,
        mutationFenceFingerprint: claims.mutationFenceFingerprint,
        nodeBootEpoch: claims.node.bootEpoch,
        nodeBootId: claims.node.bootId,
        nodeId: claims.node.nodeId,
        nonce: claims.nonce,
        observedState: "started",
        operationId: claims.operationId,
        partitionPolicy: claims.partitionPolicy,
        state: "started_or_unknown",
        ticketDigest,
        unitName,
      });
      return { replayed: false, result, state: "started" };
    } finally {
      this.#insideFinalMutation = false;
    }
  }

  public assertKnownProcessIdentity(claims: ExecutionTicketClaims): void {
    const attempt = this.#attempts.get(claims.attempt.attemptId);
    const allocation = this.#allocations.get(claims.allocation.allocationId);
    if (
      attempt === undefined ||
      allocation === undefined ||
      attempt.executionGeneration !== claims.attempt.executionGeneration ||
      attempt.startFence !== claims.attempt.startFence ||
      allocation.attemptId !== claims.attempt.attemptId ||
      allocation.executionGeneration !== claims.attempt.executionGeneration
    ) {
      throw new AuthorityRegistryError(
        "authority_mismatch",
        "process identity is not known to root authority",
      );
    }
  }

  public runAuthorizedStop(
    claims: ExecutionTicketClaims,
    unitName: string,
    ticketDigest: string,
    mutation: () => void,
  ): "stopped" | "unknown" {
    this.assertMutationHealthy();
    if (
      this.#insideFinalMutation ||
      this.#scopesClosed.has(claims.mutationFence.effectScopeKey)
    ) {
      throw new AuthorityRegistryError(
        "mutation_in_progress",
        "process stop scope is not available",
      );
    }
    this.assertCompleteAuthority(claims);
    const prior = this.#effects.get(claims.operationId);
    if (prior !== undefined) {
      if (prior.ticketDigest !== ticketDigest) {
        throw new AuthorityRegistryError(
          "authority_mismatch",
          "effect operation replay changed its complete tuple",
        );
      }
      return prior.state === "applied_or_unknown" ? "stopped" : "unknown";
    }
    this.#insideFinalMutation = true;
    try {
      this.wal.reserve(2);
      this.wal.append({
        effect: "process_stop",
        kind: "effect_state",
        mutationFence: claims.mutationFence,
        mutationFenceFingerprint: claims.mutationFenceFingerprint,
        operationId: claims.operationId,
        state: "systemd_call_issued",
        ticketDigest,
        unitName,
      });
      this.#effects.set(claims.operationId, {
        state: "systemd_call_issued",
        ticketDigest,
      });
      this.assertCompleteAuthority(claims);
      mutation();
      this.wal.append({
        effect: "process_stop",
        kind: "effect_state",
        mutationFence: claims.mutationFence,
        mutationFenceFingerprint: claims.mutationFenceFingerprint,
        operationId: claims.operationId,
        state: "applied_or_unknown",
        ticketDigest,
        unitName,
      });
      this.#effects.set(claims.operationId, {
        state: "applied_or_unknown",
        ticketDigest,
      });
      return "stopped";
    } catch (error) {
      if (error instanceof LauncherWalError) {
        throw new AuthorityRegistryError(
          "launcher_cordoned",
          "launcher WAL cannot durably record the stop boundary",
        );
      }
      throw error;
    } finally {
      this.#insideFinalMutation = false;
    }
  }

  public runBreakGlassStop(
    input: BreakGlassStopInput,
    mutation: () => void,
  ): "stopped" | "unknown" {
    this.assertMutationHealthy();
    if (this.#insideFinalMutation) {
      throw new AuthorityRegistryError(
        "mutation_in_progress",
        "break-glass stop cannot nest a final mutation",
      );
    }
    return this.#breakGlass.run(input, () => {
      this.runPartitionMutation(mutation);
    });
  }

  public runControlPartition(
    input: ControlPartitionInput,
    mutation: () => void,
  ): ControlPartitionResult {
    this.assertMutationHealthy();
    if (this.#insideFinalMutation) {
      throw new AuthorityRegistryError(
        "mutation_in_progress",
        "control-partition reconciliation cannot nest a final mutation",
      );
    }
    return this.#controlPartitions.run(input, () => {
      this.runPartitionMutation(mutation);
    });
  }

  public reconcileControlPartitionDeadlines(
    nowMs: number,
    mutation: (start: StartWalRecord) => void,
  ): number {
    this.assertMutationHealthy();
    if (this.#insideFinalMutation) {
      throw new AuthorityRegistryError(
        "mutation_in_progress",
        "partition deadline reconciliation cannot nest a final mutation",
      );
    }
    return this.#controlPartitions.reconcile(nowMs, (start) => {
      this.runPartitionMutation(() => {
        mutation(start);
      });
    });
  }

  private runPartitionMutation(mutation: () => void): void {
    this.#insideFinalMutation = true;
    try {
      mutation();
    } finally {
      this.#insideFinalMutation = false;
    }
  }

  private appendStart(record: StartWalRecord): void {
    try {
      this.wal.append(record);
      this.#starts.set(startRecordKey(record), record);
    } catch (error) {
      if (error instanceof LauncherWalError) {
        throw new AuthorityRegistryError(
          "launcher_cordoned",
          "launcher WAL cannot durably record the start boundary",
        );
      }
      throw error;
    }
  }

  private applyInstall(
    snapshot: LauncherAuthoritySnapshot,
    walSequence: number,
    compare: boolean,
  ): AuthorityInstallAcknowledgement {
    validateSnapshot(snapshot);
    const currentNamespace = this.#namespaces.get(
      snapshot.namespace.namespaceId,
    );
    const currentAllocation = this.#allocations.get(
      snapshot.allocation.allocationId,
    );
    const currentAttempt = this.#attempts.get(snapshot.attempt.attemptId);
    const currentGate = this.#gates.get(snapshot.mutationFence.effectScopeKey);
    const currentScope = this.#scopeSnapshots.get(
      snapshot.mutationFence.effectScopeKey,
    );
    if (compare) {
      compareAuthorityComponents(
        this.#cluster,
        snapshot,
        currentNamespace,
        currentAllocation,
        currentAttempt,
        currentGate,
        currentScope,
      );
    } else if (currentScope !== undefined) {
      compareAuthorityComponents(
        this.#cluster,
        snapshot,
        currentNamespace,
        currentAllocation,
        currentAttempt,
        currentGate,
        currentScope,
      );
    }
    const idempotent =
      currentScope?.mutationFenceFingerprint ===
      snapshot.mutationFenceFingerprint;
    this.#cluster = Object.freeze({ ...snapshot.cluster });
    this.#namespaces.set(
      snapshot.namespace.namespaceId,
      Object.freeze({ ...snapshot.namespace }),
    );
    this.#allocations.set(
      snapshot.allocation.allocationId,
      Object.freeze({ ...snapshot.allocation }),
    );
    this.#attempts.set(
      snapshot.attempt.attemptId,
      Object.freeze({ ...snapshot.attempt }),
    );
    this.#gates.set(
      snapshot.mutationFence.effectScopeKey,
      Object.freeze({ ...snapshot.gate }),
    );
    this.#scopeSnapshots.set(
      snapshot.mutationFence.effectScopeKey,
      Object.freeze({
        ...snapshot,
        mutationFence: Object.freeze({ ...snapshot.mutationFence }),
      }),
    );
    this.#scopeWalSequences.set(
      snapshot.mutationFence.effectScopeKey,
      walSequence,
    );
    return Object.freeze({
      allocationId: snapshot.allocation.allocationId,
      allocationOwnerFence: snapshot.allocation.ownerFence,
      allocationOwnerId: snapshot.allocation.ownerId,
      attemptId: snapshot.attempt.attemptId,
      clusterIncarnation: snapshot.cluster.incarnationId,
      clusterIncarnationVersion: snapshot.cluster.version,
      effectScopeKey: snapshot.mutationFence.effectScopeKey,
      expectedDesiredVersion: snapshot.mutationFence.expectedDesiredVersion,
      gateOpen: snapshot.gate.open,
      gateRevision: snapshot.gate.revision,
      mutationFenceFingerprint: snapshot.mutationFenceFingerprint,
      mutationFence: snapshot.mutationFence,
      namespaceId: snapshot.namespace.namespaceId,
      namespaceWriterEpoch: snapshot.namespace.writerEpoch,
      namespaceWriterId: snapshot.namespace.writerId,
      result: idempotent ? "idempotent" : "installed",
      startRevocationRevision: snapshot.attempt.startRevocationRevision,
      supersessionKey: snapshot.mutationFence.supersessionKey,
      walSequence,
    });
  }

  private installedAuthoritySequence(claims: ExecutionTicketClaims): number {
    const mutationFence: MutationFence = claims.mutationFence;
    const sequence = this.#scopeWalSequences.get(mutationFence.effectScopeKey);
    if (sequence === undefined) {
      throw new AuthorityRegistryError(
        "authority_missing",
        "start has no durable installed authority WAL record",
      );
    }
    return sequence;
  }

  private assertCompleteAuthority(claims: ExecutionTicketClaims): void {
    const snapshot = this.#scopeSnapshots.get(
      claims.mutationFence.effectScopeKey,
    );
    const namespace = this.#namespaces.get(claims.namespace.namespaceId);
    const allocation = this.#allocations.get(claims.allocation.allocationId);
    const attempt = this.#attempts.get(claims.attempt.attemptId);
    const gate = this.#gates.get(claims.mutationFence.effectScopeKey);
    if (
      snapshot === undefined ||
      this.#cluster === undefined ||
      namespace === undefined ||
      allocation === undefined ||
      attempt === undefined ||
      gate === undefined ||
      snapshot.mutationFenceFingerprint !== claims.mutationFenceFingerprint ||
      !sameCluster(this.#cluster, claims.cluster) ||
      !sameNamespace(namespace, claims.namespace) ||
      !sameAllocation(allocation, claims.allocation) ||
      !sameAttempt(attempt, claims.attempt) ||
      gate.revision !== claims.gate.revision ||
      gate.effect !== claims.gate.effect ||
      !gate.open ||
      !sameCluster(snapshot.cluster, claims.cluster) ||
      !sameNamespace(snapshot.namespace, claims.namespace) ||
      !sameAllocation(snapshot.allocation, claims.allocation) ||
      !sameAttempt(snapshot.attempt, claims.attempt) ||
      snapshot.gate.effect !== claims.gate.effect ||
      snapshot.gate.revision !== claims.gate.revision ||
      !snapshot.gate.open
    ) {
      throw new AuthorityRegistryError(
        "authority_mismatch",
        "ticket does not equal the complete root-owned effect authority",
      );
    }
  }

  private assertMutationHealthy(): void {
    if (this.cordoned) {
      throw new AuthorityRegistryError(
        "launcher_cordoned",
        "launcher registry or WAL recovery is unprovable",
      );
    }
  }
}
