import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import { startNodeAgent as startLocalNodeAgent } from "@workload-funnel/node-agent/composition-local";
import { startNodeAgent as startProductionNodeAgent } from "@workload-funnel/node-agent/composition-production";
import {
  SYNTHETIC_EXECUTABLE,
  SYNTHETIC_SERVICE_USER,
  SYNTHETIC_WORKING_DIRECTORY,
} from "@workload-funnel/executor-systemd/transient-unit-start";
import { verifyAuthorityInstallAcknowledgement } from "@workload-funnel/node-launcher/authority-installation";
import { AuthorityRegistryError } from "@workload-funnel/node-launcher/authority-registry";
import {
  BreakGlassStopError,
  RootBreakGlassStop,
} from "@workload-funnel/node-launcher/break-glass-stop";
import { startNodeLauncher } from "@workload-funnel/node-launcher/composition";
import { recoverLauncherObservations } from "@workload-funnel/node-launcher/recovery-observation";
import {
  fingerprintMutationFence,
  type MutationFence,
} from "@workload-funnel/kernel";
import { parseLauncherRpcResponse } from "@workload-funnel/node-execution/process-lifecycle";

import {
  MemoryWalStorage,
  SyntheticSystemdManager,
  agentPeer,
  authority,
  fixture,
  install,
  mutationFence,
  newKeys,
  operatorPeer,
  request,
  signedTicket,
  stopFence,
  ticketClaims,
} from "./phase4b-launcher-fixture.js";

describe("Phase 4B durable root launcher", () => {
  it("preserves the exact Phase 4A trusted boundary and production disablement", () => {
    const current = fixture();
    const ticket = signedTicket(current);
    const base = JSON.parse(request(ticket, "trusted-boundary")) as Record<
      string,
      unknown
    >;
    const missingFenceComponent = structuredClone(base) as {
      ticket: { claims: { mutationFence: { ownerFence?: number } } };
    };
    delete missingFenceComponent.ticket.claims.mutationFence.ownerFence;
    for (const attack of [
      { ...base, executable: "/bin/sh" },
      { ...base, user: "root" },
      { ...base, properties: { KillMode: "process" } },
      { ...base, method: "StartTransientUnit" },
      missingFenceComponent,
    ]) {
      expect(
        parseLauncherRpcResponse(
          current.boundary.handle(JSON.stringify(attack), agentPeer),
        ),
      ).toMatchObject({ error: { code: "malformed_request" }, ok: false });
    }
    expect(
      parseLauncherRpcResponse(
        current.boundary.handle(request(ticket, "wrong-peer"), {
          ...agentPeer,
          uid: 0,
        }),
      ),
    ).toMatchObject({ error: { code: "peer_not_authorized" }, ok: false });
    expect(current.manager.starts).toHaveLength(0);
    expect(startNodeLauncher().status).toBe("unsupported");
    expect(startProductionNodeAgent().status).toBe("unsupported");
    expect(startLocalNodeAgent().status).toBe("unsupported");
  });

  it("requires signed full-tuple install and durably redeems each nonce once", () => {
    const current = fixture();
    const ticket = signedTicket(current);
    const first = parseLauncherRpcResponse(
      current.boundary.handle(request(ticket, "start-1"), agentPeer),
    );
    expect(first).toMatchObject({ ok: true, result: { state: "started" } });
    const unitName = first.ok ? first.result.unitName : "";
    expect(current.manager.starts).toHaveLength(1);
    expect(current.manager.starts[0]).toMatchObject({
      execStart: [
        {
          arguments: [SYNTHETIC_EXECUTABLE, "--phase4c-tree"],
          path: SYNTHETIC_EXECUTABLE,
        },
      ],
      properties: {
        Group: SYNTHETIC_SERVICE_USER,
        KillMode: "control-group",
        User: SYNTHETIC_SERVICE_USER,
        WorkingDirectory: SYNTHETIC_WORKING_DIRECTORY,
      },
      unitName,
    });
    expect(
      parseLauncherRpcResponse(
        current.boundary.handle(request(ticket, "start-retry"), agentPeer),
      ),
    ).toMatchObject({ ok: true, result: { state: "started", unitName } });
    expect(current.manager.starts).toHaveLength(1);

    const collision = signedTicket(
      current,
      ticketClaims(mutationFence(), {
        operationId: "another-operation",
        ticketId: "another-ticket",
      }),
    );
    expect(
      parseLauncherRpcResponse(
        current.boundary.handle(
          request(collision, "nonce-collision"),
          agentPeer,
        ),
      ),
    ).toMatchObject({ error: { code: "replay_rejected" }, ok: false });
    expect(current.manager.starts).toHaveLength(1);
  });

  it("recovers crash ambiguity without duplicate start and cords corrupt/full WAL", () => {
    const storage = new MemoryWalStorage();
    const manager = new SyntheticSystemdManager();
    manager.crashAfterStart = true;
    const keys = newKeys();
    const beforeCrash = fixture(storage, manager, keys);
    const ticket = signedTicket(beforeCrash);
    expect(
      parseLauncherRpcResponse(
        beforeCrash.boundary.handle(
          request(ticket, "crashing-start"),
          agentPeer,
        ),
      ),
    ).toMatchObject({
      error: { code: "unsupported_host_capability" },
      ok: false,
    });
    expect(manager.starts).toHaveLength(1);

    manager.crashAfterStart = false;
    const afterRestart = fixture(storage, manager, keys);
    expect(
      parseLauncherRpcResponse(
        afterRestart.boundary.handle(
          request(ticket, "restart-retry"),
          agentPeer,
        ),
      ),
    ).toMatchObject({ ok: true, result: { state: "unknown" } });
    expect(manager.starts).toHaveLength(1);
    expect(
      recoverLauncherObservations(afterRestart.registry, (unitName) => ({
        state: manager.observeTransientService(unitName),
        unitName,
      })),
    ).toMatchObject({ mutationReady: false, reason: "unknown_start_outcome" });

    const corruptStorage = new MemoryWalStorage();
    fixture(corruptStorage, new SyntheticSystemdManager(), keys);
    const corruptLine = corruptStorage.lines.at(0);
    if (corruptLine === undefined) throw new Error("synthetic WAL is empty");
    corruptStorage.lines[0] = `${corruptLine}tampered`;
    const corrupted = fixture(
      corruptStorage,
      new SyntheticSystemdManager(),
      keys,
    );
    expect(corrupted.registry.cordoned).toBe(true);
    expect(
      parseLauncherRpcResponse(
        corrupted.boundary.handle(
          request(signedTicket(corrupted), "corrupt-wal"),
          agentPeer,
        ),
      ),
    ).toMatchObject({ error: { code: "launcher_cordoned" }, ok: false });

    const incompleteStorage = new MemoryWalStorage();
    fixture(incompleteStorage, new SyntheticSystemdManager(), keys);
    const incompleteLine = incompleteStorage.lines.at(0);
    if (incompleteLine === undefined) throw new Error("synthetic WAL is empty");
    const incomplete = JSON.parse(incompleteLine) as {
      checksum: string;
      previousChecksum: string;
      record: {
        snapshot: { mutationFenceFingerprint?: string };
      };
      sequence: number;
    };
    delete incomplete.record.snapshot.mutationFenceFingerprint;
    incomplete.checksum = createHash("sha256")
      .update(
        JSON.stringify({
          previousChecksum: incomplete.previousChecksum,
          record: incomplete.record,
          sequence: incomplete.sequence,
        }),
        "utf8",
      )
      .digest("hex");
    incompleteStorage.lines[0] = JSON.stringify(incomplete);
    expect(
      fixture(incompleteStorage, new SyntheticSystemdManager(), keys).registry
        .cordoned,
    ).toBe(true);

    const fullManager = new SyntheticSystemdManager();
    const full = fixture(new MemoryWalStorage(3), fullManager);
    expect(
      parseLauncherRpcResponse(
        full.boundary.handle(
          request(signedTicket(full), "ledger-full"),
          agentPeer,
        ),
      ),
    ).toMatchObject({ error: { code: "launcher_cordoned" }, ok: false });
    expect(fullManager.starts).toHaveLength(0);
  });

  it("serializes normal stop through its own complete desired-version tuple", () => {
    const current = fixture();
    const started = parseLauncherRpcResponse(
      current.boundary.handle(
        request(signedTicket(current), "normal-stop-target"),
        agentPeer,
      ),
    );
    expect(started).toMatchObject({ ok: true, result: { state: "started" } });
    const stopClaims = ticketClaims(stopFence(), {
      nonce: "unused-stop-nonce",
      operationId: "stop-operation-1",
      ticketId: "stop-ticket-1",
    });
    install(
      current,
      authority(stopClaims),
      "stop-fence-install-1",
      "desired_effect_supersession",
    );
    const stopTicket = signedTicket(current, stopClaims);
    expect(
      parseLauncherRpcResponse(
        current.boundary.handle(
          request(stopTicket, "normal-stop-1", "stop"),
          agentPeer,
        ),
      ),
    ).toMatchObject({ ok: true, result: { state: "stopped" } });
    expect(
      parseLauncherRpcResponse(
        current.boundary.handle(
          request(stopTicket, "normal-stop-retry", "stop"),
          agentPeer,
        ),
      ),
    ).toMatchObject({ ok: true, result: { state: "stopped" } });
    expect(current.manager.stopCalls).toBe(1);
    expect(
      parseLauncherRpcResponse(
        current.boundary.handle(
          request(signedTicket(current), "start-ticket-cannot-stop", "stop"),
          agentPeer,
        ),
      ),
    ).toMatchObject({ error: { code: "authority_mismatch" }, ok: false });
  });

  it("enforces desired-version high-watermarks and takeover issue-after-ack", () => {
    const current = fixture();
    const initial = mutationFence();
    const nextFence = mutationFence({
      expectedDesiredVersion: 2,
      ownerFence: 2,
      supersessionKey: "desired-start-2",
    });
    const nextClaims = ticketClaims(nextFence, {
      nonce: "nonce-2",
      operationId: "start-operation-2",
      ownerId: "owner-2",
      ticketId: "ticket-2",
    });
    const nextSnapshot = authority(nextClaims);
    expect(() =>
      install(
        current,
        nextSnapshot,
        "takeover-install-2",
        "allocation_takeover",
        fingerprintMutationFence(initial),
      ),
    ).toThrow(AuthorityRegistryError);

    current.registry.closeScope(initial.effectScopeKey, "takeover-close-2");
    const closedAfterRestart = fixture(
      current.storage,
      current.manager,
      current.keys,
    );
    expect(
      parseLauncherRpcResponse(
        closedAfterRestart.boundary.handle(
          request(signedTicket(closedAfterRestart), "closed-after-restart"),
          agentPeer,
        ),
      ),
    ).toMatchObject({ error: { code: "authority_mismatch" }, ok: false });
    const signedAck = install(
      current,
      nextSnapshot,
      "takeover-install-2",
      "allocation_takeover",
      fingerprintMutationFence(initial),
    );
    expect(
      verifyAuthorityInstallAcknowledgement(
        signedAck,
        current.keys.launcher.publicKey,
      ),
    ).toBe(true);
    expect(signedAck.acknowledgement).toMatchObject({
      allocationOwnerFence: 2,
      expectedDesiredVersion: 2,
      mutationFenceFingerprint: fingerprintMutationFence(nextFence),
      supersessionKey: "desired-start-2",
    });

    expect(
      parseLauncherRpcResponse(
        current.boundary.handle(
          request(signedTicket(current, nextClaims), "closed-scope"),
          agentPeer,
        ),
      ),
    ).toMatchObject({ error: { code: "authority_mismatch" }, ok: false });
    current.registry.reopenScope(
      nextFence.effectScopeKey,
      signedAck.acknowledgement.mutationFenceFingerprint,
      "takeover-reopen-2",
    );
    const recovered = fixture(current.storage, current.manager, current.keys);
    expect(
      parseLauncherRpcResponse(
        recovered.boundary.handle(
          request(signedTicket(recovered), "stale-owner"),
          agentPeer,
        ),
      ),
    ).toMatchObject({ error: { code: "authority_mismatch" }, ok: false });
    expect(
      parseLauncherRpcResponse(
        recovered.boundary.handle(
          request(signedTicket(recovered, nextClaims), "new-owner"),
          agentPeer,
        ),
      ),
    ).toMatchObject({ ok: true, result: { state: "started" } });

    const equalVersionMismatch = authority(
      ticketClaims(
        mutationFence({
          expectedDesiredVersion: 2,
          ownerFence: 2,
          supersessionKey: "forged-equal-version",
        }),
        { ownerId: "owner-2" },
      ),
    );
    expect(() =>
      install(
        current,
        equalVersionMismatch,
        "mismatched-equal-version",
        "desired_effect_supersession",
      ),
    ).toThrow(AuthorityRegistryError);
  });

  it("rejects stale incarnation/writer and equal-version identity reuse", () => {
    const current = fixture();
    const initial = mutationFence();
    const rotated = mutationFence({
      clusterIncarnation: "cluster-2",
      clusterIncarnationVersion: 2,
      expectedDesiredVersion: 2,
      namespaceWriterEpoch: 2,
      supersessionKey: "rotated-start",
    });
    const rotatedClaims = ticketClaims(rotated, {
      nonce: "nonce-rotation",
      operationId: "start-rotation",
      ticketId: "ticket-rotation",
      writerId: "writer-2",
    });
    current.registry.closeScope(initial.effectScopeKey, "rotation-close");
    const acknowledgement = install(
      current,
      authority(rotatedClaims),
      "cluster-writer-rotation",
      "cluster_rotation",
      fingerprintMutationFence(initial),
    );
    current.registry.reopenScope(
      initial.effectScopeKey,
      acknowledgement.acknowledgement.mutationFenceFingerprint,
      "rotation-reopen",
    );
    expect(
      parseLauncherRpcResponse(
        current.boundary.handle(
          request(signedTicket(current), "stale-writer-incarnation"),
          agentPeer,
        ),
      ),
    ).toMatchObject({ error: { code: "authority_mismatch" }, ok: false });
    const forgedIdentity = ticketClaims(
      mutationFence({
        clusterIncarnation: "cluster-forged",
        clusterIncarnationVersion: 2,
        expectedDesiredVersion: 3,
        namespaceWriterEpoch: 3,
        supersessionKey: "forged-incarnation",
      }),
      { writerId: "writer-3" },
    );
    current.registry.closeScope(initial.effectScopeKey, "forged-close");
    expect(() =>
      install(
        current,
        authority(forgedIdentity),
        "forged-incarnation-install",
        "cluster_rotation",
      ),
    ).toThrow(AuthorityRegistryError);
  });

  it("makes zero calls for every stale or mismatched complete-tuple component", () => {
    const current = fixture();
    const initial = mutationFence();
    const dominating = mutationFence({
      clusterIncarnation: "cluster-2",
      clusterIncarnationVersion: 2,
      expectedDesiredVersion: 2,
      issuedStartRevocationRevision: 1,
      namespaceWriterEpoch: 2,
      operationGateRevision: 2,
      ownerFence: 2,
      supersessionKey: "desired-start-2",
    });
    const dominatingClaims = ticketClaims(dominating, {
      nonce: "nonce-dominating",
      operationId: "start-dominating",
      ownerId: "owner-2",
      ticketId: "ticket-dominating",
      writerId: "writer-2",
    });
    current.registry.closeScope(initial.effectScopeKey, "complete-close");
    const acknowledgement = install(
      current,
      authority(dominatingClaims),
      "complete-high-watermark-install",
      "cluster_rotation",
      fingerprintMutationFence(initial),
    );
    current.registry.reopenScope(
      initial.effectScopeKey,
      acknowledgement.acknowledgement.mutationFenceFingerprint,
      "complete-reopen",
    );
    const staleFences: MutationFence[] = [
      {
        ...dominating,
        clusterIncarnation: "cluster-1",
        clusterIncarnationVersion: 1,
      },
      { ...dominating, namespaceWriterEpoch: 1 },
      { ...dominating, ownerFence: 1 },
      { ...dominating, operationGateRevision: 1 },
      { ...dominating, issuedStartRevocationRevision: 0 },
      {
        ...dominating,
        expectedDesiredVersion: 1,
        supersessionKey: "desired-start-1",
      },
      { ...dominating, nodeBootEpoch: 0 },
    ];
    for (const [index, staleFence] of staleFences.entries()) {
      const claims = ticketClaims(staleFence, {
        nonce: `stale-nonce-${String(index)}`,
        operationId: `stale-operation-${String(index)}`,
        ownerId: staleFence.ownerFence === 1 ? "owner-1" : "owner-2",
        ticketId: `stale-ticket-${String(index)}`,
        writerId:
          staleFence.namespaceWriterEpoch === 1 ? "writer-1" : "writer-2",
      });
      expect(
        parseLauncherRpcResponse(
          current.boundary.handle(
            request(signedTicket(current, claims), `stale-${String(index)}`),
            agentPeer,
          ),
        ),
      ).toMatchObject({ error: { code: "authority_mismatch" }, ok: false });
    }
    expect(current.manager.starts).toHaveLength(0);
  });

  it("allows only a generation-bound dedicated operator emergency stop", () => {
    const current = fixture();
    const started = parseLauncherRpcResponse(
      current.boundary.handle(
        request(signedTicket(current), "emergency-target-start"),
        agentPeer,
      ),
    );
    if (!started.ok) throw new Error("synthetic start unexpectedly failed");
    const emergency = new RootBreakGlassStop({
      boundary: current.boundary,
      operatorGid: operatorPeer.gid,
      operatorUid: operatorPeer.uid,
    });
    const stopInput = {
      attemptId: "attempt-1",
      executionGeneration: "generation-1",
      mutationFence: mutationFence(),
      mutationFenceFingerprint: fingerprintMutationFence(mutationFence()),
      nodeBootEpoch: 1,
      nodeBootId: "boot-1",
      nodeId: "node-1",
      operationId: "break-glass-1",
      reason: "local operator observed runaway synthetic fixture",
      unitName: started.result.unitName,
    };
    expect(() => emergency.stop(agentPeer, stopInput)).toThrow(
      BreakGlassStopError,
    );
    expect(() =>
      emergency.stop(operatorPeer, {
        ...stopInput,
        executionGeneration: "generation-forged",
        operationId: "break-glass-forged",
      }),
    ).toThrow(AuthorityRegistryError);
    expect(emergency.stop(operatorPeer, stopInput)).toBe("stopped");
    expect(emergency.stop(operatorPeer, stopInput)).toBe("stopped");
    expect(current.manager.stopCalls).toBe(1);
    expect(
      current.registry.wal.records.filter(
        ({ record }) => record.kind === "break_glass_stop",
      ),
    ).toHaveLength(2);
  });

  it("rejects a mixed unit-A/generation-B break-glass tuple without stopping", () => {
    const current = fixture();
    const startedA = parseLauncherRpcResponse(
      current.boundary.handle(
        request(signedTicket(current), "mixed-target-a"),
        agentPeer,
      ),
    );
    if (!startedA.ok) throw new Error("synthetic A start failed");
    const fenceB = mutationFence({
      allocationId: "allocation-2",
      attemptId: "attempt-2",
      effectScopeKey: "namespace-1.process-start.attempt-2.generation-2",
      executionGeneration: "generation-2",
      startFence: "start-fence-2",
      supersessionKey: "desired-start-2",
    });
    const claimsB = ticketClaims(fenceB, {
      nonce: "nonce-b",
      operationId: "start-b",
      ticketId: "ticket-b",
    });
    install(current, authority(claimsB), "install-b", "gate_change");
    const startedB = parseLauncherRpcResponse(
      current.boundary.handle(
        request(signedTicket(current, claimsB), "mixed-target-b"),
        agentPeer,
      ),
    );
    if (!startedB.ok) throw new Error("synthetic B start failed");
    const emergency = new RootBreakGlassStop({
      boundary: current.boundary,
      operatorGid: operatorPeer.gid,
      operatorUid: operatorPeer.uid,
    });
    const tupleB = {
      attemptId: "attempt-2",
      executionGeneration: "generation-2",
      mutationFence: fenceB,
      mutationFenceFingerprint: fingerprintMutationFence(fenceB),
      nodeBootEpoch: 1,
      nodeBootId: "boot-1",
      nodeId: "node-1",
      operationId: "mixed-break-glass",
      reason: "adversarial mixed unit and generation must not stop",
      unitName: startedA.result.unitName,
    };
    expect(() => emergency.stop(operatorPeer, tupleB)).toThrow(
      AuthorityRegistryError,
    );
    expect(current.manager.stopCalls).toBe(0);
    expect(() =>
      emergency.stop(operatorPeer, {
        ...tupleB,
        nodeBootId: "boot-forged",
        operationId: "mixed-boot",
        unitName: startedB.result.unitName,
      }),
    ).toThrow(AuthorityRegistryError);
    expect(current.manager.stopCalls).toBe(0);
  });

  it("durably enforces signed partition policy in the synthetic lifecycle", () => {
    const current = fixture();
    const ticket = signedTicket(current);
    expect(
      parseLauncherRpcResponse(
        current.boundary.handle(request(ticket, "partition-start"), agentPeer),
      ),
    ).toMatchObject({ ok: true, result: { state: "started" } });
    current.controlAuthority.disconnectedAt = 1_600;
    current.controlAuthority.now = 1_900;
    expect(
      parseLauncherRpcResponse(
        current.boundary.handle(
          request(ticket, "partition-observe", "observe"),
          agentPeer,
        ),
      ),
    ).toMatchObject({ ok: true, result: { state: "active" } });
    expect(current.manager.stopCalls).toBe(0);

    const restarted = fixture(
      current.storage,
      current.manager,
      current.keys,
      current.controlAuthority,
    );
    expect(restarted.registry.controlPartitioned).toBe(true);
    restarted.controlAuthority.now = 2_100;
    expect(
      parseLauncherRpcResponse(
        restarted.boundary.handle(
          request(ticket, "partition-deadline", "observe"),
          agentPeer,
        ),
      ),
    ).toMatchObject({ ok: true, result: { state: "inactive" } });
    expect(current.manager.stopCalls).toBe(1);
    const reopened = fixture(
      current.storage,
      current.manager,
      current.keys,
      current.controlAuthority,
    );
    reopened.controlAuthority.now = 2_200;
    expect(
      parseLauncherRpcResponse(
        reopened.boundary.handle(
          request(ticket, "partition-reopen", "observe"),
          agentPeer,
        ),
      ),
    ).toMatchObject({ ok: true, result: { state: "inactive" } });
    expect(current.manager.stopCalls).toBe(1);
    expect(
      parseLauncherRpcResponse(
        reopened.boundary.handle(request(ticket, "isolated-replay"), agentPeer),
      ),
    ).toMatchObject({ error: { code: "authority_mismatch" }, ok: false });
    expect(
      reopened.registry.wal.records
        .filter(({ record }) => record.kind === "control_partition")
        .map(({ record }) =>
          record.kind === "control_partition" ? record.state : "",
        ),
    ).toEqual(["scheduled", "stop_issued", "stopped_or_unknown"]);
  });

  it("rejects executor_fenced unless the real executor capability is present", () => {
    const unsupported = fixture();
    const fencedClaims = ticketClaims(mutationFence(), {
      partitionPolicy: "executor_fenced",
    });
    expect(
      parseLauncherRpcResponse(
        unsupported.boundary.handle(
          request(
            signedTicket(unsupported, fencedClaims),
            "fenced-unsupported",
          ),
          agentPeer,
        ),
      ),
    ).toMatchObject({
      error: { code: "unsupported_host_capability" },
      ok: false,
    });
    expect(unsupported.manager.starts).toHaveLength(0);

    const supported = fixture(undefined, new SyntheticSystemdManager(true));
    expect(
      parseLauncherRpcResponse(
        supported.boundary.handle(
          request(signedTicket(supported, fencedClaims), "fenced-supported"),
          agentPeer,
        ),
      ),
    ).toMatchObject({ ok: true, result: { state: "started" } });
  });
});
