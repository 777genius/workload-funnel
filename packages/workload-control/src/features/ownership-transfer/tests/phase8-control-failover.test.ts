import { createHash, generateKeyPairSync, sign, verify } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  fingerprintMutationFence,
  type MutationFence,
} from "@workload-funnel/kernel";
import { openSqliteReconciliationClaimStore } from "@workload-funnel/store-sqlite/reconciliation-claims";
import { openSqliteControlFailoverStore } from "@workload-funnel/store-sqlite/ownership-transfer-coordinator-persistence";

import {
  completeMutationFenceHighWatermarks,
  createControlServiceFailoverCoordinator,
  type AuthoritativeFinalAuthorityInventoryReceipt,
  type CompleteFenceInstallAcknowledgement,
  type ControlServiceFailoverEnvironment,
  type FinalAuthorityDrainAcknowledgement,
  type FinalMutationAuthority,
  type FinalMutationAuthorityKind,
  type FinalMutationAuthorityTarget,
} from "../index.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { force: true, recursive: true });
});

function paths(): Readonly<{ claims: string; failover: string }> {
  const root = mkdtempSync(join(tmpdir(), "wf-phase8-failover-"));
  roots.push(root);
  return Object.freeze({
    claims: join(root, "claims.sqlite"),
    failover: join(root, "failover.sqlite"),
  });
}

function fence(scope: string, epoch = 2): MutationFence {
  return Object.freeze({
    allocationId: "allocation-1",
    attemptId: "attempt-1",
    clusterIncarnation: "cluster-phase8",
    clusterIncarnationVersion: 8,
    desiredEffect: scope.includes("artifact")
      ? ("artifact_delete" as const)
      : ("process_start" as const),
    effectScopeKey: scope,
    executionGeneration: "generation-1",
    expectedDesiredVersion: 4,
    namespaceId: "namespace-1",
    namespaceWriterEpoch: epoch,
    nodeBootEpoch: 2,
    nodeId: "node-1",
    operationGateRevision: 11,
    ownerFence: 7,
    requiredGate: scope.includes("artifact")
      ? "result_delete"
      : "process_start",
    schemaVersion: 1,
    ...(scope.includes("artifact")
      ? {}
      : {
          issuedStartRevocationRevision: 3,
          startFence: "start-fence-1",
        }),
    supersessionKey: `supersession:${scope}`,
  });
}

function target(
  authorityId: string,
  authorityKind: FinalMutationAuthorityKind,
): FinalMutationAuthorityTarget {
  const mutationFence = fence(`scope:${authorityId}`);
  return Object.freeze({
    authorityId,
    authorityKind,
    highWatermarks: completeMutationFenceHighWatermarks(
      mutationFence,
      "writer-b",
    ),
    mutationFence,
    mutationFenceFingerprint: fingerprintMutationFence(mutationFence),
    writerIdentity: "writer-b",
  });
}

const targets = Object.freeze([
  target("artifact-1", "artifact-store"),
  target("launcher-1", "node-launcher"),
  target("sealer-1", "result-sealer"),
  target("runtime-1", "runtime-broker"),
  target("scheduler-1", "scheduler-gateway"),
  target("launcher-2", "node-launcher"),
]);

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object")
    return `{${Object.entries(value)
      .filter(([key]) => key !== "signatureBase64Url")
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`)
      .join(",")}}`;
  return JSON.stringify(value);
}

const keys = generateKeyPairSync("ed25519");

function inventory(
  inventoryTargets: readonly FinalMutationAuthorityTarget[],
): AuthoritativeFinalAuthorityInventoryReceipt {
  const unsigned = {
    complete: true as const,
    durable: true as const,
    inventoryDigest: createHash("sha256")
      .update(canonical(inventoryTargets))
      .digest("hex"),
    inventoryId: "authority-inventory-7",
    inventoryRevision: 7,
    issuedAt: 1,
    namespaceId: "namespace-1",
    notAfter: 1000,
    operationId: "failover-1",
    signerKeyId: "authority-inventory-key",
    targetEpoch: 2,
    targets: inventoryTargets,
  };
  return Object.freeze({
    ...unsigned,
    signatureBase64Url: sign(
      null,
      Buffer.from(canonical(unsigned)),
      keys.privateKey,
    ).toString("base64url"),
  });
}

class SyntheticAuthority implements FinalMutationAuthority {
  public closeCalls = 0;
  public mutationCalls = 0;
  readonly #closed = new Set<string>();
  readonly #installed = new Map<string, string>();
  #sequence = 0;

  public constructor(public readonly authorityId: string) {}

  public close(input: {
    operationId: string;
    target: FinalMutationAuthorityTarget;
  }) {
    this.closeCalls += 1;
    this.#closed.add(input.target.mutationFence.effectScopeKey);
    return Object.freeze({
      authorityId: this.authorityId,
      closed: true as const,
      durable: true as const,
      effectScopeKey: input.target.mutationFence.effectScopeKey,
      operationId: input.operationId,
    });
  }

  public drain(input: {
    operationId: string;
    target: FinalMutationAuthorityTarget;
    close: ReturnType<SyntheticAuthority["close"]>;
  }): FinalAuthorityDrainAcknowledgement {
    if (!this.#closed.has(input.target.mutationFence.effectScopeKey))
      throw new Error("scope_not_closed");
    return Object.freeze({
      authorityId: this.authorityId,
      closeOperationId: input.close.operationId,
      drained: true,
      durable: true,
      effectScopeKey: input.target.mutationFence.effectScopeKey,
      operationId: input.operationId,
    });
  }

  public install(input: {
    operationId: string;
    target: FinalMutationAuthorityTarget;
    drain: FinalAuthorityDrainAcknowledgement;
  }): CompleteFenceInstallAcknowledgement {
    if (!input.drain.drained) throw new Error("not_drained");
    this.#installed.set(
      input.target.mutationFence.effectScopeKey,
      input.target.mutationFenceFingerprint,
    );
    return Object.freeze({
      authorityId: this.authorityId,
      authorityKind: input.target.authorityKind,
      durableSequence: ++this.#sequence,
      effectScopeKey: input.target.mutationFence.effectScopeKey,
      highWatermarks: input.target.highWatermarks,
      installed: true,
      mutationFence: input.target.mutationFence,
      mutationFenceFingerprint: input.target.mutationFenceFingerprint,
      operationId: input.operationId,
    });
  }

  public reopen(input: {
    operationId: string;
    acknowledgement: CompleteFenceInstallAcknowledgement;
  }): string {
    if (
      this.#installed.get(input.acknowledgement.effectScopeKey) !==
      input.acknowledgement.mutationFenceFingerprint
    )
      throw new Error("reopen_without_install");
    this.#closed.delete(input.acknowledgement.effectScopeKey);
    return `reopened:${this.authorityId}:${input.operationId}`;
  }

  public mutate(candidate: MutationFence): void {
    if (
      this.#closed.has(candidate.effectScopeKey) ||
      this.#installed.get(candidate.effectScopeKey) !==
        fingerprintMutationFence(candidate)
    )
      throw new Error("final_authority_rejected");
    this.mutationCalls += 1;
  }
}

function environment(
  inventoryTargets: readonly FinalMutationAuthorityTarget[],
  authorities: ReadonlyMap<string, SyntheticAuthority>,
): ControlServiceFailoverEnvironment {
  let writerEpoch = 1;
  return {
    advanceCanonicalWriter(input) {
      if (writerEpoch === input.expectedCurrentEpoch)
        writerEpoch = input.targetEpoch;
      return {
        receiptDigest: `writer-epoch:${String(writerEpoch)}`,
        writerEpoch,
        writerId: input.toWriterId,
      };
    },
    authority(authorityId) {
      const authority = authorities.get(authorityId);
      if (authority === undefined) throw new Error("authority_not_found");
      return authority;
    },
    disableOldCredentials: () => "old-credentials-disabled",
    inventory: () => inventory(inventoryTargets),
    verifyAuthoritativeInventory(receipt) {
      return (
        receipt.inventoryRevision === 7 &&
        JSON.stringify(
          receipt.targets.map((item) => item.authorityId).sort(),
        ) === JSON.stringify(targets.map((item) => item.authorityId).sort()) &&
        verify(
          null,
          Buffer.from(canonical(receipt)),
          keys.publicKey,
          Buffer.from(receipt.signatureBase64Url, "base64url"),
        )
      );
    },
  };
}

describe("Phase 8 authoritative control-service failover", () => {
  it("reopens crash-safe stores and installs every scope/instance before stale mutation is possible", () => {
    const path = paths();
    const authorities = new Map(
      targets.map((item) => [
        item.authorityId,
        new SyntheticAuthority(item.authorityId),
      ]),
    );
    const env = environment(targets, authorities);
    let failover = openSqliteControlFailoverStore(path.failover);
    let claims = openSqliteReconciliationClaimStore(path.claims);
    let coordinator = createControlServiceFailoverCoordinator(
      failover.store,
      claims.store,
      env,
    );
    coordinator.begin({
      expectedCurrentEpoch: 1,
      fromWriterId: "writer-a",
      namespaceId: "namespace-1",
      now: 10,
      operationId: "failover-1",
      toWriterId: "writer-b",
    });
    const claim = coordinator.claim("failover-1", "controller-a", 0, 10, 100);
    expect(coordinator.resume("failover-1", claim, 11).phase).toBe(
      "scopes_closed",
    );
    failover.close();
    claims.close();

    failover = openSqliteControlFailoverStore(path.failover);
    claims = openSqliteReconciliationClaimStore(path.claims);
    coordinator = createControlServiceFailoverCoordinator(
      failover.store,
      claims.store,
      env,
    );
    while (coordinator.resume("failover-1", claim, 12).phase !== "completed") {
      // Each iteration persists exactly one resumable phase.
    }
    expect(coordinator.discoverIncomplete(10)).toEqual([]);
    for (const item of targets) {
      const authority = authorities.get(item.authorityId);
      if (authority === undefined) throw new Error("authority_not_found");
      expect(() => {
        authority.mutate({
          ...item.mutationFence,
          namespaceWriterEpoch: 1,
        });
      }).toThrow("final_authority_rejected");
      expect(authority.mutationCalls).toBe(0);
      authority.mutate(item.mutationFence);
      expect(authority.mutationCalls).toBe(1);
    }
    failover.close();
    claims.close();
  });

  it("fails closed before the first close when the signed inventory omits one applicable authority instance", () => {
    const path = paths();
    const authorities = new Map(
      targets.map((item) => [
        item.authorityId,
        new SyntheticAuthority(item.authorityId),
      ]),
    );
    const omitted = targets.filter((item) => item.authorityId !== "launcher-2");
    const failover = openSqliteControlFailoverStore(path.failover);
    const claims = openSqliteReconciliationClaimStore(path.claims);
    const coordinator = createControlServiceFailoverCoordinator(
      failover.store,
      claims.store,
      environment(omitted, authorities),
    );
    expect(() =>
      coordinator.begin({
        expectedCurrentEpoch: 1,
        fromWriterId: "writer-a",
        namespaceId: "namespace-1",
        now: 10,
        operationId: "failover-1",
        toWriterId: "writer-b",
      }),
    ).toThrow("failover_authority_inventory_not_authoritative");
    expect(
      [...authorities.values()].reduce(
        (total, authority) => total + authority.closeCalls,
        0,
      ),
    ).toBe(0);
    failover.close();
    claims.close();
  });
});
