import { generateKeyPairSync } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  LauncherSocketClient,
  LauncherPeerError,
} from "@workload-funnel/node-agent/launcher-socket-client";
import { startNodeAgent as startLocalNodeAgent } from "@workload-funnel/node-agent/composition-local";
import { startNodeAgent as startProductionNodeAgent } from "@workload-funnel/node-agent/composition-production";
import {
  SYNTHETIC_EXECUTABLE,
  SYNTHETIC_SERVICE_USER,
  SYNTHETIC_WORKING_DIRECTORY,
  type SyntheticTransientUnit,
} from "@workload-funnel/executor-systemd/transient-unit-start";
import { RootAuthorityInstaller } from "@workload-funnel/node-launcher/authority-installation";
import {
  AuthorityRegistryError,
  type LauncherAuthoritySnapshot,
  RootAuthorityRegistry,
  RootExecutionTicketVerifier,
} from "@workload-funnel/node-launcher/authority-registry";
import { startNodeLauncher } from "@workload-funnel/node-launcher/composition";
import {
  EXECUTION_TICKET_SCHEMA,
  signExecutionTicket,
  SYNTHETIC_EXECUTION_PROFILE,
  type ExecutionTicketClaims,
} from "@workload-funnel/node-execution/execution-ticket-validation";
import {
  encodeLauncherRpcRequest,
  LAUNCHER_RPC_PROTOCOL,
  parseLauncherRpcResponse,
  type UnixLauncherRpcTransport,
  type UnixPeerIdentity,
} from "@workload-funnel/node-execution/process-lifecycle";

import { LauncherMutationBoundary } from "../index.js";

const agentPeer: UnixPeerIdentity = {
  gid: 2201,
  pid: 4201,
  transport: "unix",
  uid: 2201,
};
const launcherPeer: UnixPeerIdentity = {
  gid: 0,
  pid: 4200,
  transport: "unix",
  uid: 0,
};
const installerPeer: UnixPeerIdentity = {
  gid: 2100,
  pid: 4199,
  transport: "unix",
  uid: 2100,
};

function ticketClaims(): ExecutionTicketClaims {
  return {
    allocation: {
      allocationId: "allocation-1",
      attemptId: "attempt-1",
      executionGeneration: "generation-1",
      ownerFence: 1,
      ownerId: "owner-1",
    },
    attempt: {
      attemptId: "attempt-1",
      executionGeneration: "generation-1",
      startFence: "start-fence-1",
      startRevocationRevision: 0,
    },
    cluster: { incarnationId: "cluster-1", version: 1 },
    expiresAtMs: 2_000,
    gate: { effect: "process_start", open: true, revision: 1 },
    issuedAtMs: 1_000,
    issuerKeyId: "issuer-1",
    namespace: {
      namespaceId: "namespace-1",
      writerEpoch: 1,
      writerId: "writer-1",
    },
    node: { bootId: "boot-1", nodeId: "node-1" },
    profileId: SYNTHETIC_EXECUTION_PROFILE,
    schemaVersion: EXECUTION_TICKET_SCHEMA,
    ticketId: "ticket-1",
  };
}

function authority(
  claims: ExecutionTicketClaims = ticketClaims(),
): LauncherAuthoritySnapshot {
  return {
    allocation: claims.allocation,
    attempt: claims.attempt,
    cluster: claims.cluster,
    gate: claims.gate,
    namespace: claims.namespace,
  };
}

class SyntheticSystemdManager {
  public readonly controlGroupStop = "supported" as const;
  public readonly transientServiceObservation = "supported" as const;
  public readonly transientServiceStart: "supported" | "unsupported";
  public readonly starts: SyntheticTransientUnit[] = [];
  public readonly processTrees = new Map<string, boolean[]>();

  public constructor(
    transientServiceStart: "supported" | "unsupported" = "supported",
  ) {
    this.transientServiceStart = transientServiceStart;
  }

  public startTransientService(
    unit: SyntheticTransientUnit,
  ): "created" | "exists" {
    if (this.processTrees.has(unit.unitName)) return "exists";
    this.starts.push(unit);
    this.processTrees.set(unit.unitName, [true, true, true, true]);
    return "created";
  }

  public observeTransientService(
    unitName: string,
  ): "active" | "failed" | "inactive" | "unknown" {
    const tree = this.processTrees.get(unitName);
    if (tree === undefined) return "unknown";
    return tree.some(Boolean) ? "active" : "inactive";
  }

  public stopTransientService(
    unitName: string,
    mode: "replace",
  ): "absent" | "stopped" {
    expect(mode).toBe("replace");
    const tree = this.processTrees.get(unitName);
    if (tree === undefined) return "absent";
    const unit = this.starts.find(
      (candidate) => candidate.unitName === unitName,
    );
    if (unit?.properties.killMode !== "control-group") {
      throw new Error("synthetic manager refuses incomplete-tree cancellation");
    }
    tree.fill(false);
    return "stopped";
  }
}

function fixture(manager = new SyntheticSystemdManager()) {
  const keys = generateKeyPairSync("ed25519");
  const registry = new RootAuthorityRegistry();
  const installer = new RootAuthorityInstaller(registry, 2100, 2100);
  installer.install(installerPeer, authority());
  const ticketVerifier = new RootExecutionTicketVerifier({
    bootId: "boot-1",
    nodeId: "node-1",
    nowMs: () => 1_500,
    trustedTicketKeys: new Map([["issuer-1", keys.publicKey]]),
  });
  const boundary = new LauncherMutationBoundary({
    agentGid: agentPeer.gid,
    agentUid: agentPeer.uid,
    manager,
    registry,
    ticketVerifier,
  });
  const ticket = signExecutionTicket(ticketClaims(), keys.privateKey);
  return { boundary, installer, keys, manager, registry, ticket };
}

function rawRequest(
  ticket: ReturnType<typeof signExecutionTicket>,
  method: "observe" | "start" | "stop" = "start",
): string {
  return encodeLauncherRpcRequest({
    method,
    protocolVersion: LAUNCHER_RPC_PROTOCOL,
    requestId: `request-${method}`,
    ticket,
  });
}

describe("Phase 4A minimal trusted launch boundary", () => {
  it("installs and acknowledges every monotonic root-owned authority", () => {
    const { installer, registry } = fixture();
    const initial = authority();
    expect(registry.install(initial).result).toBe("idempotent");

    const clusterAdvanced = {
      ...initial,
      cluster: { incarnationId: "cluster-2", version: 2 },
    };
    expect(installer.install(installerPeer, clusterAdvanced)).toMatchObject({
      clusterIncarnationVersion: 2,
      result: "installed",
    });
    const writerAdvanced = {
      ...clusterAdvanced,
      namespace: { ...initial.namespace, writerEpoch: 2, writerId: "writer-2" },
    };
    expect(installer.install(installerPeer, writerAdvanced)).toMatchObject({
      namespaceWriterEpoch: 2,
    });
    const ownerAdvanced = {
      ...writerAdvanced,
      allocation: { ...initial.allocation, ownerFence: 2, ownerId: "owner-2" },
    };
    expect(installer.install(installerPeer, ownerAdvanced)).toMatchObject({
      allocationOwnerFence: 2,
    });
    const revoked = {
      ...ownerAdvanced,
      attempt: { ...initial.attempt, startRevocationRevision: 1 },
      gate: { effect: "process_start" as const, open: false, revision: 2 },
    };
    expect(installer.install(installerPeer, revoked)).toMatchObject({
      gateOpen: false,
      gateRevision: 2,
      startRevocationRevision: 1,
    });

    const staleSnapshots: LauncherAuthoritySnapshot[] = [
      { ...revoked, cluster: initial.cluster },
      { ...revoked, namespace: initial.namespace },
      { ...revoked, allocation: initial.allocation },
      { ...revoked, attempt: initial.attempt },
      { ...revoked, gate: initial.gate },
    ];
    for (const stale of staleSnapshots) {
      expect(() => registry.install(stale)).toThrow(AuthorityRegistryError);
    }
    expect(() =>
      registry.install({
        ...revoked,
        namespace: { ...revoked.namespace, writerId: "writer-forged" },
      }),
    ).toThrow(AuthorityRegistryError);
    expect(() => installer.install(agentPeer, revoked)).toThrow(
      AuthorityRegistryError,
    );
  });

  it("rejects compromised agent attempts to select host mutation inputs", () => {
    const { boundary, manager, ticket } = fixture();
    const base = JSON.parse(rawRequest(ticket)) as Record<string, unknown>;
    const attacks: Record<string, unknown>[] = [
      { ...base, executable: "/bin/sh" },
      { ...base, user: "root" },
      { ...base, workingDirectory: "/home/user/project" },
      { ...base, properties: { Delegate: true, KillMode: "process" } },
      { ...base, method: "StartTransientUnit" },
      { ...base, method: "dbus_call", busName: "org.freedesktop.systemd1" },
      {
        ...base,
        ticket: {
          ...ticket,
          claims: { ...ticket.claims, executable: "/bin/sh" },
        },
      },
      {
        ...base,
        ticket: {
          ...ticket,
          claims: { ...ticket.claims, user: "root" },
        },
      },
    ];

    for (const attack of attacks) {
      const response = parseLauncherRpcResponse(
        boundary.handle(JSON.stringify(attack), agentPeer),
      );
      expect(response).toMatchObject({
        error: { code: "malformed_request" },
        ok: false,
      });
    }
    expect(manager.starts).toHaveLength(0);

    const wrongPeer = parseLauncherRpcResponse(
      boundary.handle(rawRequest(ticket), { ...agentPeer, uid: 0 }),
    );
    expect(wrongPeer).toMatchObject({
      error: { code: "peer_not_authorized" },
      ok: false,
    });
    expect(manager.starts).toHaveLength(0);
  });

  it("acknowledges operation-gate revocation before rejecting an old start", () => {
    const { boundary, installer, manager, ticket } = fixture();
    const acknowledgement = installer.install(installerPeer, {
      ...authority(),
      gate: { effect: "process_start", open: false, revision: 2 },
    });
    expect(acknowledgement).toMatchObject({
      gateOpen: false,
      gateRevision: 2,
    });

    expect(
      parseLauncherRpcResponse(boundary.handle(rawRequest(ticket), agentPeer)),
    ).toMatchObject({
      error: { code: "authority_mismatch" },
      ok: false,
    });
    expect(manager.starts).toHaveLength(0);
  });

  it("starts only the frozen synthetic unit and stops its complete process tree", () => {
    const { boundary, installer, manager, ticket } = fixture();
    const started = parseLauncherRpcResponse(
      boundary.handle(rawRequest(ticket), agentPeer),
    );
    expect(started.ok).toBe(true);
    expect(manager.starts).toHaveLength(1);
    const unitName = manager.starts[0]?.unitName;
    expect(unitName).toMatch(
      /^workload-funnel-phase4a-[a-f0-9]{32}\.service$/u,
    );
    expect(manager.starts[0]).toEqual({
      description: "WorkloadFunnel Phase 4A synthetic process tree",
      execStart: [
        {
          arguments: [SYNTHETIC_EXECUTABLE, "--phase4a-tree"],
          ignoreFailure: false,
          path: SYNTHETIC_EXECUTABLE,
        },
      ],
      properties: {
        finalKillSignal: "SIGKILL",
        group: SYNTHETIC_SERVICE_USER,
        killMode: "control-group",
        killSignal: "SIGTERM",
        noNewPrivileges: true,
        privateTmp: true,
        protectHome: true,
        protectSystem: "strict",
        sendSigkill: true,
        tasksMax: 64,
        timeoutStopMicroseconds: 5_000_000,
        user: SYNTHETIC_SERVICE_USER,
        workingDirectory: SYNTHETIC_WORKING_DIRECTORY,
      },
      startMode: "fail",
      unitName,
    });
    expect(
      parseLauncherRpcResponse(
        boundary.handle(rawRequest(ticket, "observe"), agentPeer),
      ),
    ).toMatchObject({ ok: true, result: { state: "active", unitName } });

    const revokedStart = {
      ...authority(),
      attempt: { ...authority().attempt, startRevocationRevision: 1 },
    };
    expect(installer.install(installerPeer, revokedStart)).toMatchObject({
      startRevocationRevision: 1,
    });
    const denied = parseLauncherRpcResponse(
      boundary.handle(rawRequest(ticket), agentPeer),
    );
    expect(denied).toMatchObject({
      error: { code: "authority_mismatch" },
      ok: false,
    });
    expect(manager.starts).toHaveLength(1);

    const stopped = parseLauncherRpcResponse(
      boundary.handle(rawRequest(ticket, "stop"), agentPeer),
    );
    expect(stopped).toMatchObject({ ok: true, result: { state: "stopped" } });
    const tree = manager.processTrees.values().next().value;
    expect(tree).toBeDefined();
    expect(tree?.every((alive) => !alive)).toBe(true);
  });

  it("checks the root launcher peer on the unprivileged client", () => {
    const { boundary, ticket } = fixture();
    const transport = (peer: UnixPeerIdentity): UnixLauncherRpcTransport => ({
      exchange: (payload) => ({
        payload: boundary.handle(payload, agentPeer),
        peer,
      }),
    });
    const client = new LauncherSocketClient({
      launcherGid: 0,
      launcherUid: 0,
      transport: transport(launcherPeer),
    });
    expect(client.start("client-start-1", ticket)).toMatchObject({ ok: true });

    const impostor = new LauncherSocketClient({
      launcherGid: 0,
      launcherUid: 0,
      transport: transport({ ...launcherPeer, uid: 2201 }),
    });
    expect(() => impostor.observe("client-observe-1", ticket)).toThrow(
      LauncherPeerError,
    );
  });

  it("records typed unsupported evidence without attempting a host start", () => {
    const manager = new SyntheticSystemdManager("unsupported");
    const { boundary, ticket } = fixture(manager);

    expect(
      parseLauncherRpcResponse(boundary.handle(rawRequest(ticket), agentPeer)),
    ).toMatchObject({
      error: {
        code: "unsupported_host_capability",
        message: "systemd_transient_service_start_unsupported",
      },
      ok: false,
    });
    expect(manager.starts).toHaveLength(0);
  });

  it("keeps all host and production entrypoints fail-closed", () => {
    expect(startNodeLauncher()).toEqual({
      capability: "privileged_node_launcher",
      reason: "phase_4a_privileged_host_start_disabled",
      status: "unsupported",
    });
    expect(startProductionNodeAgent()).toEqual({
      capability: "production_node_agent",
      reason: "phase_4a_production_start_disabled",
      status: "unsupported",
    });
    expect(startLocalNodeAgent()).toEqual({
      capability: "host_node_agent",
      reason: "phase_4a_host_start_requires_synthetic_fixture",
      status: "unsupported",
    });
  });
});
