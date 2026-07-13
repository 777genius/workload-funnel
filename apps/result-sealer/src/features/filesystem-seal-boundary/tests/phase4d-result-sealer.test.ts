import { createHash, generateKeyPairSync } from "node:crypto";
import { mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import type { MutationFence } from "@workload-funnel/kernel";
import { startResultSealer } from "@workload-funnel/result-sealer/composition";
import {
  createSealOutputClaims,
  signSealOutputRequest,
  type SealOutputClaims,
} from "@workload-funnel/node-execution/result-sealing-coordination";
import {
  FilesystemSealBoundary,
  ResultSealerRpcBoundary,
  UnsafeSealTreeError,
  deterministicOutputName,
  type DescriptorSealFilesystem,
  type DescriptorTreeEntry,
  type DescriptorTreeSnapshot,
} from "../index.js";
import {
  SealAuthorityRegistry,
  SealRegistryError,
  SealerWal,
  FilesystemSealerWalStorage,
  type SealerWalStorage,
} from "../../seal-authority-registry/index.js";

class MemoryWalStorage implements SealerWalStorage {
  public readonly lines: string[] = [];
  public recoveryState: "new" | "existing" = "new";
  public commit: string | undefined;
  public constructor(public readonly capacity = 100) {}
  public appendAndSync(line: string, commit: string): void {
    this.lines.push(line);
    this.commit = commit;
    this.recoveryState = "existing";
  }
  public readAll(): readonly string[] {
    return this.lines;
  }
  public readCommit(): string | undefined {
    return this.commit;
  }
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function file(
  overrides: Partial<DescriptorTreeEntry> = {},
): DescriptorTreeEntry {
  return Object.freeze({
    allocatedBytes: 5,
    changeToken: "change-1",
    device: "dev-1",
    digest: digest("hello"),
    inode: "inode-file-1",
    mode: 0o400,
    nlink: 1,
    pathSegments: Object.freeze(["result.txt"]),
    sizeBytes: 5,
    type: "file",
    uid: 1234,
    xattrs: Object.freeze([]),
    ...overrides,
  });
}

class FakeDescriptorFilesystem implements DescriptorSealFilesystem {
  public readonly outputParent = Object.freeze({
    device: "dev-1",
    inode: "output-parent",
  });
  public readonly stagingParent = Object.freeze({
    device: "dev-1",
    inode: "staging-parent",
  });
  public atomicCalls = 0;
  public scanCalls = 0;
  public failAtomic = false;
  public mutateAfterFirstScan = false;
  public constructor(public snapshot: DescriptorTreeSnapshot) {}
  public scanSource(sourceName: string): DescriptorTreeSnapshot {
    void sourceName;
    this.scanCalls += 1;
    if (this.mutateAfterFirstScan && this.scanCalls > 1) {
      return Object.freeze({
        entries: Object.freeze(
          this.snapshot.entries.map((entry) =>
            Object.freeze({ ...entry, changeToken: "changed" }),
          ),
        ),
      });
    }
    return this.snapshot;
  }
  public atomicSeal(
    input: Readonly<{
      sourceName: string;
      destinationName: string;
      expectedSource: DescriptorTreeSnapshot;
    }>,
  ): DescriptorTreeSnapshot {
    void input;
    this.atomicCalls += 1;
    if (this.failAtomic) throw new Error("ambiguous synthetic rename");
    return this.snapshot;
  }
}

const keys = generateKeyPairSync("ed25519");

function fence(overrides: Partial<MutationFence> = {}): MutationFence {
  return Object.freeze({
    allocationId: "allocation-1",
    attemptId: "attempt-1",
    clusterIncarnation: "cluster-1",
    clusterIncarnationVersion: 1,
    desiredEffect: "seal_output",
    effectScopeKey: "seal-output:execution-1",
    executionGeneration: "generation-1",
    expectedDesiredVersion: 1,
    namespaceId: "namespace-1",
    namespaceWriterEpoch: 1,
    nodeBootEpoch: 7,
    nodeId: "node-1",
    operationGateRevision: 3,
    ownerFence: 9,
    requiredGate: "result_finalize",
    schemaVersion: 1,
    supersessionKey: "seal-output:execution-1",
    ...overrides,
  });
}

function claims(
  overrides: Partial<
    Omit<SealOutputClaims, "protocolVersion" | "tupleFingerprint">
  > = {},
) {
  return createSealOutputClaims({
    allocationId: "allocation-1",
    attemptId: "attempt-1",
    audience: "workload-funnel-result-sealer",
    executionGeneration: "generation-1",
    executionId: "execution-1",
    expiresAtMs: 200,
    issuedAtMs: 50,
    issuer: "control-service",
    issuerKeyId: "sealer-key-1",
    mutationFence: fence(),
    nodeBootEpoch: 7,
    nodeId: "node-1",
    operationId: "seal-operation-1",
    outputContractDigest: digest("output-contract"),
    quiescenceReceiptDigest: digest("quiesced"),
    sealProfileDigest: digest("profile"),
    unitInvocationDigest: digest("invocation"),
    ...overrides,
  });
}

function fixture(
  snapshot: DescriptorTreeSnapshot = Object.freeze({
    entries: Object.freeze([file()]),
  }),
) {
  const storage = new MemoryWalStorage();
  const filesystem = new FakeDescriptorFilesystem(snapshot);
  const registry = new SealAuthorityRegistry(
    new SealerWal(storage),
    new Map([["sealer-key-1", keys.publicKey]]),
    () => 100,
  );
  const boundary = new FilesystemSealBoundary({
    expectedOutputParent: filesystem.outputParent,
    expectedStagingParent: filesystem.stagingParent,
    expectedWorkloadUid: 1234,
    filesystem,
    limits: {
      maxDepth: 8,
      maxEntries: 32,
      maxFileBytes: 1024,
      maxTotalBytes: 4096,
    },
    registry,
  });
  const authorization = signSealOutputRequest(claims(), keys.privateKey);
  registry.install("install-1", authorization);
  return { authorization, boundary, filesystem, registry, storage };
}

describe("Phase 4D trusted result-sealer", () => {
  it("keeps privileged production start disabled", () => {
    expect(startResultSealer()).toEqual({
      capability: "privileged_result_seal",
      reason: "native_openat2_sealer_start_disabled",
      status: "unsupported",
    });
  });

  it("uses deterministic roots and durably replays one sealed receipt after restart", () => {
    const first = fixture();
    expect(deterministicOutputName(first.authorization.claims)).toBe(
      "bm9kZS0x--YWxsb2NhdGlvbi0x--Z2VuZXJhdGlvbi0x",
    );
    const receipt = first.boundary.seal(first.authorization);
    expect(receipt).toMatchObject({ outcome: "sealed", totalBytes: 5 });
    expect(first.filesystem.atomicCalls).toBe(1);
    expect(first.storage.lines).toHaveLength(6);

    const recoveredRegistry = new SealAuthorityRegistry(
      new SealerWal(first.storage),
      new Map([["sealer-key-1", keys.publicKey]]),
      () => 100,
    );
    const recovered = new FilesystemSealBoundary({
      expectedOutputParent: first.filesystem.outputParent,
      expectedStagingParent: first.filesystem.stagingParent,
      expectedWorkloadUid: 1234,
      filesystem: first.filesystem,
      limits: {
        maxDepth: 8,
        maxEntries: 32,
        maxFileBytes: 1024,
        maxTotalBytes: 4096,
      },
      registry: recoveredRegistry,
    });
    expect(recovered.seal(first.authorization)).toEqual(receipt);
    expect(first.filesystem.atomicCalls).toBe(1);
  });

  it("finalizes an explicit empty result", () => {
    const current = fixture(Object.freeze({ entries: Object.freeze([]) }));
    expect(current.boundary.seal(current.authorization)).toMatchObject({
      entries: [],
      outcome: "sealed",
      totalBytes: 0,
    });
  });

  it("exposes only typed signed seal RPC to the peer-checked node identity", () => {
    const current = fixture();
    const rpc = new ResultSealerRpcBoundary({
      agentGid: 222,
      agentUid: 111,
      boundary: current.boundary,
    });
    const request = JSON.stringify({
      authorization: current.authorization,
      method: "seal_output",
      protocolVersion: 1,
      requestId: "rpc-1",
    });
    expect(
      JSON.parse(
        rpc.handle(request, { gid: 222, pid: 10, transport: "unix", uid: 111 }),
      ),
    ).toMatchObject({
      ok: true,
      receipt: { outcome: "sealed" },
      requestId: "rpc-1",
    });
    const denied = fixture();
    const deniedRpc = new ResultSealerRpcBoundary({
      agentGid: 222,
      agentUid: 111,
      boundary: denied.boundary,
    });
    expect(
      JSON.parse(
        deniedRpc.handle(request, {
          gid: 222,
          pid: 10,
          transport: "unix",
          uid: 999,
        }),
      ),
    ).toMatchObject({
      error: { code: "seal_output_refused" },
      ok: false,
    });
    expect(denied.filesystem.atomicCalls).toBe(0);
  });

  it.each([
    ["symlink", { type: "symlink" }],
    ["fifo", { type: "fifo" }],
    ["socket", { type: "socket" }],
    ["device", { type: "device" }],
    ["hardlink", { nlink: 2 }],
    ["setuid", { mode: 0o4400 }],
    ["capability xattr", { xattrs: ["security.capability"] }],
    ["sparse file", { allocatedBytes: 1 }],
    ["parent traversal", { pathSegments: ["..", "escape"] }],
    ["absolute segment", { pathSegments: ["/etc/passwd"] }],
    ["decoded separator", { pathSegments: ["a/b"] }],
    ["unicode alias", { pathSegments: ["e\u0301"] }],
  ] as const)(
    "refuses %s without an atomic publication",
    (_name, overrides) => {
      const current = fixture(
        Object.freeze({
          entries: Object.freeze([
            file(overrides as Partial<DescriptorTreeEntry>),
          ]),
        }),
      );
      expect(() => current.boundary.seal(current.authorization)).toThrow(
        UnsafeSealTreeError,
      );
      expect(current.filesystem.atomicCalls).toBe(0);
      expect(current.registry.state("seal-operation-1")).toBeUndefined();
    },
  );

  it("refuses a content/metadata mutation race before WAL preparation", () => {
    const current = fixture();
    current.filesystem.mutateAfterFirstScan = true;
    expect(() => current.boundary.seal(current.authorization)).toThrow(
      "result_mutation_race",
    );
    expect(current.filesystem.atomicCalls).toBe(0);
    expect(current.registry.state("seal-operation-1")).toBeUndefined();
  });

  it("returns durable unknown and never retries an ambiguous atomic call", () => {
    const current = fixture();
    current.filesystem.failAtomic = true;
    const receipt = current.boundary.seal(current.authorization);
    expect(receipt).toMatchObject({
      outcome: "unknown",
      reason: "atomic_seal_outcome_ambiguous",
    });
    expect(current.boundary.seal(current.authorization)).toEqual(receipt);
    expect(current.filesystem.atomicCalls).toBe(1);
  });

  it("rejects compromised-agent tampering, cross-allocation access, and operation collisions", () => {
    const current = fixture();
    const tampered = {
      ...current.authorization,
      claims: { ...current.authorization.claims, allocationId: "allocation-2" },
    };
    expect(() => current.boundary.seal(tampered)).toThrow();
    expect(current.filesystem.atomicCalls).toBe(0);

    const conflictClaims = claims({ outputContractDigest: digest("changed") });
    const conflict = signSealOutputRequest(conflictClaims, keys.privateKey);
    expect(() => current.registry.install("install-1", conflict)).toThrow(
      SealRegistryError,
    );
  });

  it.each([
    ["owner", { ownerFence: 10 }],
    ["gate", { operationGateRevision: 4 }],
    ["desired version", { expectedDesiredVersion: 2 }],
  ] as const)(
    "rejects a formerly installed authority after its %s high-watermark advances",
    (_name, fenceOverride) => {
      const current = fixture();
      const superseding = signSealOutputRequest(
        claims({
          mutationFence: fence(fenceOverride),
          operationId: "seal-operation-2",
        }),
        keys.privateKey,
      );
      current.registry.install("install-2", superseding);
      expect(() => current.boundary.seal(current.authorization)).toThrow(
        "stale_authority",
      );
      expect(current.filesystem.atomicCalls).toBe(0);
    },
  );

  it("cordons on a truncated or reordered WAL", () => {
    const current = fixture();
    current.storage.lines[0] = `${current.storage.lines[0] ?? ""}corrupt`;
    const wal = new SealerWal(current.storage);
    expect(wal.cordonReason).toBe("sealer_wal_corrupt");
    const registry = new SealAuthorityRegistry(
      wal,
      new Map([["sealer-key-1", keys.publicKey]]),
      () => 100,
    );
    expect(registry.cordoned).toBe(true);
    expect(() => registry.authorize(current.authorization)).toThrow(
      "sealer_cordoned",
    );
  });

  it.each(["missing", "empty", "valid-prefix-truncated", "commit-missing"])(
    "cordons when initialized WAL history is %s on reopen",
    (failure) => {
      const current = fixture();
      current.storage.recoveryState = "existing";
      if (failure === "missing" || failure === "empty")
        current.storage.lines.length = 0;
      if (failure === "valid-prefix-truncated") current.storage.lines.pop();
      if (failure === "commit-missing") current.storage.commit = undefined;
      const wal = new SealerWal(current.storage);
      expect(wal.cordonReason).toBe("sealer_wal_corrupt");
      expect(
        new SealAuthorityRegistry(
          wal,
          new Map([["sealer-key-1", keys.publicKey]]),
          () => 100,
        ).cordoned,
      ).toBe(true);
    },
  );

  it("persists real WAL fencing history and cords missing or empty ledgers after initialization", () => {
    for (const failure of ["missing", "empty"] as const) {
      const directory = mkdtempSync(join(tmpdir(), "wf-sealer-wal-"));
      try {
        const storage = new FilesystemSealerWalStorage({
          capacity: 20,
          directory,
        });
        const authorization = signSealOutputRequest(claims(), keys.privateKey);
        new SealAuthorityRegistry(
          new SealerWal(storage),
          new Map([["sealer-key-1", keys.publicKey]]),
          () => 100,
        ).install("install-real-wal", authorization);
        const recovered = new SealAuthorityRegistry(
          new SealerWal(
            new FilesystemSealerWalStorage({ capacity: 20, directory }),
          ),
          new Map([["sealer-key-1", keys.publicKey]]),
          () => 100,
        );
        expect(recovered.authorize(authorization).claims.operationId).toBe(
          "seal-operation-1",
        );
        const walPath = join(directory, "result-sealer.wal");
        if (failure === "missing") {
          unlinkSync(walPath);
          unlinkSync(join(directory, "result-sealer.commit"));
        } else writeFileSync(walPath, "", { mode: 0o600 });
        const failed = new SealerWal(
          new FilesystemSealerWalStorage({ capacity: 20, directory }),
        );
        expect(failed.cordonReason).toBe("sealer_wal_corrupt");
      } finally {
        rmSync(directory, { force: true, recursive: true });
      }
    }
  });
});
