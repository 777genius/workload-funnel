import { generateKeyPairSync } from "node:crypto";

import { expect } from "vitest";

import type { SyntheticTransientUnit } from "@workload-funnel/executor-systemd/transient-unit-start";
import {
  AUTHORITY_INSTALL_SCHEMA,
  RootAuthorityInstaller,
  signAuthorityInstallRequest,
  type AuthorityInstallClaims,
  type AuthorityInstallReason,
} from "@workload-funnel/node-launcher/authority-installation";
import {
  LauncherWal,
  type LauncherAuthoritySnapshot,
  type LauncherWalStorage,
  RootAuthorityRegistry,
  RootExecutionTicketVerifier,
} from "@workload-funnel/node-launcher/authority-registry";
import {
  EXECUTION_TICKET_SCHEMA,
  signExecutionTicket,
  SYNTHETIC_EXECUTION_PROFILE,
  type ExecutionTicketClaims,
} from "@workload-funnel/node-execution/execution-ticket-validation";
import {
  fingerprintMutationFence,
  type MutationFence,
} from "@workload-funnel/kernel";
import {
  encodeLauncherRpcRequest,
  LAUNCHER_RPC_PROTOCOL,
  type UnixPeerIdentity,
} from "@workload-funnel/node-execution/process-lifecycle";

import { LauncherMutationBoundary } from "../index.js";

export const agentPeer: UnixPeerIdentity = {
  gid: 2201,
  pid: 4201,
  transport: "unix",
  uid: 2201,
};
export const installerPeer: UnixPeerIdentity = {
  gid: 2100,
  pid: 4199,
  transport: "unix",
  uid: 2100,
};
export const operatorPeer: UnixPeerIdentity = {
  gid: 2000,
  pid: 4198,
  transport: "unix",
  uid: 2000,
};

export class MemoryWalStorage implements LauncherWalStorage {
  public readonly lines: string[] = [];
  public failNextAppend = false;

  public constructor(public readonly capacity = 100) {}

  public appendAndSync(serializedRecord: string): void {
    if (this.failNextAppend) {
      this.failNextAppend = false;
      throw new Error("synthetic fsync failure");
    }
    this.lines.push(serializedRecord);
  }

  public readAll(): readonly string[] {
    return [...this.lines];
  }
}

export class SyntheticSystemdManager {
  public readonly controlGroupStop = "supported" as const;
  public readonly externalFenceEnforced: boolean;
  public readonly transientServiceObservation = "supported" as const;
  public readonly transientServiceStart = "supported" as const;
  public readonly starts: SyntheticTransientUnit[] = [];
  public readonly processTrees = new Map<string, boolean[]>();
  public stopCalls = 0;
  public crashAfterStart = false;

  public constructor(externalFenceEnforced = false) {
    this.externalFenceEnforced = externalFenceEnforced;
  }

  public startTransientService(
    unit: SyntheticTransientUnit,
  ): "created" | "exists" {
    if (this.processTrees.has(unit.unitName)) return "exists";
    this.starts.push(unit);
    this.processTrees.set(unit.unitName, [true, true, true]);
    if (this.crashAfterStart) throw new Error("synthetic launcher crash");
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
    this.stopCalls += 1;
    const tree = this.processTrees.get(unitName);
    if (tree === undefined) return "absent";
    tree.fill(false);
    return "stopped";
  }
}

export class SyntheticControlAuthority {
  public disconnectedAt: number | undefined;
  public now = 1_500;

  public readonly disconnectedAtMs = (): number | undefined =>
    this.disconnectedAt;
  public readonly nowMs = (): number => this.now;
}

function required<T>(value: T | undefined): T {
  if (value === undefined)
    throw new Error("synthetic fixture field is missing");
  return value;
}

export function mutationFence(
  overrides: Partial<MutationFence> = {},
): MutationFence {
  return {
    allocationId: "allocation-1",
    attemptId: "attempt-1",
    clusterIncarnation: "cluster-1",
    clusterIncarnationVersion: 1,
    desiredEffect: "process_start",
    effectScopeKey: "namespace-1.process-start.attempt-1.generation-1",
    executionGeneration: "generation-1",
    expectedDesiredVersion: 1,
    issuedStartRevocationRevision: 0,
    namespaceId: "namespace-1",
    namespaceWriterEpoch: 1,
    nodeBootEpoch: 1,
    nodeId: "node-1",
    notAfter: 2_000,
    notBefore: 1_000,
    operationGateRevision: 1,
    ownerFence: 1,
    requiredGate: "process_start",
    schemaVersion: 1,
    startFence: "start-fence-1",
    supersessionKey: "desired-start-1",
    ...overrides,
  };
}

export function ticketClaims(
  fence: MutationFence = mutationFence(),
  overrides: Partial<
    Pick<
      ExecutionTicketClaims,
      "nonce" | "operationId" | "ticketId" | "partitionPolicy"
    >
  > & { readonly ownerId?: string; readonly writerId?: string } = {},
): ExecutionTicketClaims {
  return {
    allocation: {
      allocationId: required(fence.allocationId),
      attemptId: fence.attemptId,
      executionGeneration: fence.executionGeneration,
      ownerFence: required(fence.ownerFence),
      ownerId: overrides.ownerId ?? "owner-1",
    },
    attempt: {
      attemptId: fence.attemptId,
      executionGeneration: fence.executionGeneration,
      startFence: fence.startFence ?? "start-fence-1",
      startRevocationRevision: fence.issuedStartRevocationRevision ?? 0,
    },
    cluster: {
      incarnationId: fence.clusterIncarnation,
      version: fence.clusterIncarnationVersion,
    },
    expiresAtMs: required(fence.notAfter),
    gate: {
      effect: fence.desiredEffect as "process_start" | "process_stop",
      open: true,
      revision: fence.operationGateRevision,
    },
    issuedAtMs: required(fence.notBefore),
    issuerKeyId: "ticket-issuer-1",
    mutationFence: fence,
    mutationFenceFingerprint: fingerprintMutationFence(fence),
    namespace: {
      namespaceId: fence.namespaceId,
      writerEpoch: fence.namespaceWriterEpoch,
      writerId: overrides.writerId ?? "writer-1",
    },
    node: {
      bootEpoch: required(fence.nodeBootEpoch),
      bootId: "boot-1",
      nodeId: required(fence.nodeId),
    },
    nonce: overrides.nonce ?? "nonce-1",
    operationId: overrides.operationId ?? "start-operation-1",
    partitionPolicy: overrides.partitionPolicy ?? "terminate_after_grace",
    profileId: SYNTHETIC_EXECUTION_PROFILE,
    schemaVersion: EXECUTION_TICKET_SCHEMA,
    ticketId: overrides.ticketId ?? "ticket-1",
  };
}

export function stopFence(
  overrides: Partial<MutationFence> = {},
): MutationFence {
  const {
    issuedStartRevocationRevision: _issuedStartRevocationRevision,
    startFence: _startFence,
    ...stop
  } = mutationFence({
    desiredEffect: "process_stop",
    effectScopeKey: "namespace-1.process-stop.attempt-1.generation-1",
    requiredGate: "process_stop",
    supersessionKey: "desired-stop-1",
    ...overrides,
  });
  void _issuedStartRevocationRevision;
  void _startFence;
  return stop;
}

export function authority(
  claims: ExecutionTicketClaims,
  gateOpen = true,
): LauncherAuthoritySnapshot {
  return {
    allocation: claims.allocation,
    attempt: claims.attempt,
    cluster: claims.cluster,
    gate: { ...claims.gate, open: gateOpen },
    mutationFence: claims.mutationFence,
    mutationFenceFingerprint: claims.mutationFenceFingerprint,
    namespace: claims.namespace,
  };
}

export interface FixtureKeys {
  readonly installer: ReturnType<typeof generateKeyPairSync>;
  readonly launcher: ReturnType<typeof generateKeyPairSync>;
  readonly ticket: ReturnType<typeof generateKeyPairSync>;
}

export function newKeys(): FixtureKeys {
  return {
    installer: generateKeyPairSync("ed25519"),
    launcher: generateKeyPairSync("ed25519"),
    ticket: generateKeyPairSync("ed25519"),
  };
}

function installClaims(
  snapshot: LauncherAuthoritySnapshot,
  operationId: string,
  reason: AuthorityInstallReason,
  expectedPriorFingerprint: string | null = null,
): AuthorityInstallClaims {
  return {
    bootId: "boot-1",
    bootEpoch: 1,
    effectScopeKey: snapshot.mutationFence.effectScopeKey,
    expiresAtMs: 2_000,
    expectedPriorFingerprint,
    installOperationId: operationId,
    issuedAtMs: 1_000,
    issuerKeyId: "installer-1",
    nodeId: "node-1",
    reason,
    schemaVersion: AUTHORITY_INSTALL_SCHEMA,
    snapshot,
  };
}

export function fixture(
  storage: LauncherWalStorage = new MemoryWalStorage(),
  manager = new SyntheticSystemdManager(),
  keys = newKeys(),
  controlAuthority = new SyntheticControlAuthority(),
) {
  const wal = new LauncherWal(storage);
  const registry = new RootAuthorityRegistry(wal);
  const installer = new RootAuthorityInstaller({
    bootId: "boot-1",
    bootEpoch: 1,
    launcherKeyId: "launcher-1",
    launcherPrivateKey: keys.launcher.privateKey,
    nodeId: "node-1",
    nowMs: () => 1_500,
    registry,
    trustedInstallerGid: installerPeer.gid,
    trustedInstallerKeys: new Map([["installer-1", keys.installer.publicKey]]),
    trustedInstallerUid: installerPeer.uid,
  });
  const initialClaims = ticketClaims();
  if (!registry.cordoned) {
    installer.install(
      installerPeer,
      signAuthorityInstallRequest(
        installClaims(authority(initialClaims), "install-1", "gate_change"),
        keys.installer.privateKey,
      ),
    );
  }
  return createBoundaryFixture(
    storage,
    manager,
    keys,
    registry,
    installer,
    controlAuthority,
  );
}

function createBoundaryFixture(
  storage: LauncherWalStorage,
  manager: SyntheticSystemdManager,
  keys: FixtureKeys,
  registry: RootAuthorityRegistry,
  installer: RootAuthorityInstaller,
  controlAuthority: SyntheticControlAuthority,
) {
  const verifier = new RootExecutionTicketVerifier({
    bootId: "boot-1",
    nodeId: "node-1",
    nowMs: () => 1_500,
    trustedTicketKeys: new Map([["ticket-issuer-1", keys.ticket.publicKey]]),
  });
  const boundary = new LauncherMutationBoundary({
    agentGid: agentPeer.gid,
    agentUid: agentPeer.uid,
    controlAuthority,
    manager,
    partitionGraceMs: 500,
    registry,
    ticketVerifier: verifier,
  });
  return {
    boundary,
    controlAuthority,
    installer,
    keys,
    manager,
    registry,
    storage,
  };
}

export function install(
  current: ReturnType<typeof fixture>,
  snapshot: LauncherAuthoritySnapshot,
  operationId: string,
  reason: AuthorityInstallReason,
  expectedPriorFingerprint: string | null = null,
) {
  return current.installer.install(
    installerPeer,
    signAuthorityInstallRequest(
      installClaims(snapshot, operationId, reason, expectedPriorFingerprint),
      current.keys.installer.privateKey,
    ),
  );
}

export function signedTicket(
  current: ReturnType<typeof fixture>,
  claims = ticketClaims(),
) {
  return signExecutionTicket(claims, current.keys.ticket.privateKey);
}

export function request(
  ticket: ReturnType<typeof signExecutionTicket>,
  requestId: string,
  method: "observe" | "start" | "stop" = "start",
): string {
  return encodeLauncherRpcRequest({
    method,
    protocolVersion: LAUNCHER_RPC_PROTOCOL,
    requestId,
    ticket,
  });
}
