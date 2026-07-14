import { generateKeyPairSync } from "node:crypto";

import { createSyntheticSandboxProfile } from "@workload-funnel/executor-systemd/cgroup-resource-mapping";
import {
  AUTHORITY_INSTALL_SCHEMA,
  RootAuthorityInstaller,
  signAuthorityInstallRequest,
  type AuthorityInstallClaims,
} from "@workload-funnel/node-launcher/authority-installation";
import {
  FilesystemLauncherWalStorage,
  LauncherWal,
  RootAuthorityRegistry,
  RootExecutionTicketVerifier,
  type LauncherAuthoritySnapshot,
} from "@workload-funnel/node-launcher/authority-registry";
import { LauncherMutationBoundary } from "@workload-funnel/node-launcher/systemd-mutation-boundary";
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
  type LauncherRpcResponse,
  type LauncherRpcSuccess,
  type UnixPeerIdentity,
} from "@workload-funnel/node-execution/process-lifecycle";
import { fingerprintSandboxProfile } from "@workload-funnel/node-execution/resource-enforcement";
import {
  fingerprintMutationFence,
  type MutationFence,
} from "@workload-funnel/kernel";

import { SyntheticProcessManager } from "./synthetic-process-manager.js";

const agentPeer: UnixPeerIdentity = Object.freeze({
  gid: 2_201,
  pid: 4_201,
  transport: "unix",
  uid: 2_201,
});
const installerPeer: UnixPeerIdentity = Object.freeze({
  gid: 2_100,
  pid: 4_199,
  transport: "unix",
  uid: 2_100,
});

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("launcher_fence_identity_missing");
  return value;
}

function ticketClaims(fence: MutationFence): ExecutionTicketClaims {
  const allocationId = required(fence.allocationId);
  return Object.freeze({
    allocation: Object.freeze({
      allocationId,
      attemptId: fence.attemptId,
      executionGeneration: fence.executionGeneration,
      ownerFence: required(fence.ownerFence),
      ownerId: "synthetic-owner",
    }),
    attempt: Object.freeze({
      attemptId: fence.attemptId,
      executionGeneration: fence.executionGeneration,
      startFence: required(fence.startFence),
      startRevocationRevision: required(fence.issuedStartRevocationRevision),
    }),
    cluster: Object.freeze({
      incarnationId: fence.clusterIncarnation,
      version: fence.clusterIncarnationVersion,
    }),
    expiresAtMs: required(fence.notAfter),
    gate: Object.freeze({
      effect: "process_start" as const,
      open: true,
      revision: fence.operationGateRevision,
    }),
    issuedAtMs: required(fence.notBefore),
    issuerKeyId: "e2e-ticket-key",
    mutationFence: fence,
    mutationFenceFingerprint: fingerprintMutationFence(fence),
    namespace: Object.freeze({
      namespaceId: fence.namespaceId,
      writerEpoch: fence.namespaceWriterEpoch,
      writerId: "e2e-control-writer",
    }),
    node: Object.freeze({
      bootEpoch: required(fence.nodeBootEpoch),
      bootId: "synthetic-boot",
      nodeId: required(fence.nodeId),
    }),
    nonce: `nonce-${fence.attemptId}`,
    operationId: `launcher-start-${fence.attemptId}`,
    partitionPolicy: "terminate_after_grace" as const,
    profileId: SYNTHETIC_EXECUTION_PROFILE,
    sandboxProfileDigest: fingerprintSandboxProfile(
      createSyntheticSandboxProfile(allocationId),
    ),
    schemaVersion: EXECUTION_TICKET_SCHEMA,
    ticketId: `launcher-ticket-${fence.attemptId}`,
  });
}

function authority(claims: ExecutionTicketClaims): LauncherAuthoritySnapshot {
  return Object.freeze({
    allocation: claims.allocation,
    attempt: claims.attempt,
    cluster: claims.cluster,
    gate: claims.gate,
    mutationFence: claims.mutationFence,
    mutationFenceFingerprint: claims.mutationFenceFingerprint,
    namespace: claims.namespace,
  });
}

export class TrustedSyntheticLauncher {
  public readonly manager = new SyntheticProcessManager();
  readonly #keys = Object.freeze({
    installer: generateKeyPairSync("ed25519"),
    launcher: generateKeyPairSync("ed25519"),
    ticket: generateKeyPairSync("ed25519"),
  });
  readonly #walDirectory: string;
  #boundary!: LauncherMutationBoundary;
  #installer!: RootAuthorityInstaller;

  public constructor(walDirectory: string) {
    this.#walDirectory = walDirectory;
    this.restart();
  }

  public get externalStartCount(): number {
    return this.manager.starts.length;
  }

  public install(fence: MutationFence): void {
    const claims = ticketClaims(fence);
    const snapshot = authority(claims);
    const installClaims: AuthorityInstallClaims = Object.freeze({
      bootEpoch: required(fence.nodeBootEpoch),
      bootId: "synthetic-boot",
      effectScopeKey: fence.effectScopeKey,
      expectedPriorFingerprint: null,
      expiresAtMs: required(fence.notAfter),
      installOperationId: `launcher-install-${fence.attemptId}`,
      issuedAtMs: required(fence.notBefore),
      issuerKeyId: "e2e-installer-key",
      nodeId: required(fence.nodeId),
      reason: "gate_change",
      schemaVersion: AUTHORITY_INSTALL_SCHEMA,
      snapshot,
    });
    this.#installer.install(
      installerPeer,
      signAuthorityInstallRequest(
        installClaims,
        this.#keys.installer.privateKey,
      ),
    );
  }

  public restart(): void {
    const registry = new RootAuthorityRegistry(
      new LauncherWal(
        new FilesystemLauncherWalStorage({
          capacity: 100,
          directory: this.#walDirectory,
        }),
      ),
    );
    this.#installer = new RootAuthorityInstaller({
      bootEpoch: 1,
      bootId: "synthetic-boot",
      launcherKeyId: "e2e-launcher-key",
      launcherPrivateKey: this.#keys.launcher.privateKey,
      nodeId: "synthetic-node-1",
      nowMs: () => 1_500,
      registry,
      trustedInstallerGid: installerPeer.gid,
      trustedInstallerKeys: new Map([
        ["e2e-installer-key", this.#keys.installer.publicKey],
      ]),
      trustedInstallerUid: installerPeer.uid,
    });
    this.#boundary = new LauncherMutationBoundary({
      agentGid: agentPeer.gid,
      agentUid: agentPeer.uid,
      controlAuthority: {
        disconnectedAtMs: () => undefined,
        nowMs: () => 1_500,
      },
      manager: this.manager,
      partitionGraceMs: 500,
      registry,
      ticketVerifier: new RootExecutionTicketVerifier({
        bootId: "synthetic-boot",
        nodeId: "synthetic-node-1",
        nowMs: () => 1_500,
        trustedTicketKeys: new Map([
          ["e2e-ticket-key", this.#keys.ticket.publicKey],
        ]),
      }),
    });
  }

  public start(fence: MutationFence): LauncherRpcSuccess {
    const response = this.attemptStart(fence);
    if (!response.ok)
      throw new Error(`launcher_rejected:${response.error.code}`);
    return response;
  }

  public attemptStart(fence: MutationFence): LauncherRpcResponse {
    const ticket = signExecutionTicket(
      ticketClaims(fence),
      this.#keys.ticket.privateKey,
    );
    return parseLauncherRpcResponse(
      this.#boundary.handle(
        encodeLauncherRpcRequest({
          method: "start",
          protocolVersion: LAUNCHER_RPC_PROTOCOL,
          requestId: `launcher-request-${fence.attemptId}`,
          ticket,
        }),
        agentPeer,
      ),
    );
  }

  public attemptTamperedStart(
    fence: MutationFence,
    missingField: keyof MutationFence,
  ): LauncherRpcResponse {
    const ticket = structuredClone(
      signExecutionTicket(ticketClaims(fence), this.#keys.ticket.privateKey),
    ) as unknown as {
      claims: { mutationFence: Partial<MutationFence> };
    };
    Reflect.deleteProperty(ticket.claims.mutationFence, missingField);
    return parseLauncherRpcResponse(
      this.#boundary.handle(
        encodeLauncherRpcRequest({
          method: "start",
          protocolVersion: LAUNCHER_RPC_PROTOCOL,
          requestId: `launcher-missing-${missingField}`,
          ticket: ticket as never,
        }),
        agentPeer,
      ),
    );
  }
}
