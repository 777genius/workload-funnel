import { describe, expect, it, vi } from "vitest";

import {
  fingerprintMutationFence,
  type MutationFence,
} from "@workload-funnel/kernel";

import {
  LinuxProjectQuotaManager,
  probeLinuxProjectQuotaCapability,
  recoverLinuxProjectQuotaCapability,
} from "../linux-project-quota.js";
import type {
  NativeProjectQuotaIo,
  NativeProjectQuotaResult,
} from "../linux-project-quota-io.js";
import {
  fingerprintProjectQuotaControl,
  type TransientProjectQuotaControl,
} from "../project-quota-registry.js";

const digest = "a".repeat(64);
const receiptDigest = "b".repeat(64);
const previousReceiptDigest = "c".repeat(64);
const noPreviousReceiptDigest = "0".repeat(64);
const bootId = "01234567-89ab-cdef-0123-456789abcdef";

function fence(overrides: Partial<MutationFence> = {}): MutationFence {
  return {
    allocationId: "allocation-1",
    attemptId: "attempt-1",
    clusterIncarnation: "cluster-1",
    clusterIncarnationVersion: 1,
    desiredEffect: "process_start",
    effectScopeKey: "allocation:allocation-1:start",
    executionGeneration: "generation-1",
    expectedDesiredVersion: 1,
    issuedStartRevocationRevision: 0,
    namespaceId: "namespace-1",
    namespaceWriterEpoch: 1,
    operationGateRevision: 1,
    ownerFence: 1,
    requiredGate: "process_start",
    schemaVersion: 1,
    startFence: "start-fence-1",
    supersessionKey: "allocation:allocation-1",
    ...overrides,
  };
}

const control: TransientProjectQuotaControl = Object.freeze({
  allocationId: "allocation-1",
  inodeMaximum: 4_096n,
  maximumBytes: 67_108_864n,
  projectId: 1_234_567,
  root: "/var/lib/workload-funnel/allocations/allocation-1",
});

function result(
  stdout: string,
  status = 0,
  stderr = "",
): NativeProjectQuotaResult {
  return { signal: null, status, stderr, stdout };
}

function capabilityLine(
  overrides: {
    readonly bootId?: string;
    readonly device?: string;
    readonly mountId?: string;
  } = {},
): string {
  return [
    "workload-funnel.linux-project-quota-capability.v1",
    "production",
    overrides.mountId ?? "42",
    overrides.device ?? "8:1",
    "xfs",
    "prjquota",
    overrides.bootId ?? bootId,
    "true",
    "true",
  ]
    .join("\t")
    .concat("\n");
}

function receiptLine(
  operation: "applied" | "removed" | "verified_existing",
  authority: MutationFence,
  overrides: Readonly<Record<number, string>> = {},
): string {
  const removed = operation === "removed";
  const fields = [
    "result",
    operation,
    "workload-funnel.linux-project-quota-receipt.v2",
    removed ? "removed" : "active",
    control.allocationId,
    String(control.projectId),
    control.root,
    String(control.maximumBytes),
    String(control.inodeMaximum),
    fingerprintProjectQuotaControl(control),
    fingerprintMutationFence(authority),
    authority.executionGeneration,
    String(authority.clusterIncarnationVersion),
    String(authority.namespaceWriterEpoch),
    String(authority.operationGateRevision),
    String(authority.ownerFence),
    String(authority.expectedDesiredVersion),
    String(authority.issuedStartRevocationRevision),
    "8",
    "1",
    "9001",
    "42",
    "xfs",
    "prjquota",
    removed ? "0" : String(control.projectId),
    removed ? "0" : String(control.maximumBytes),
    removed ? "0" : String(control.inodeMaximum),
    "2",
    bootId,
    "exact-linux-project-quota-root-mount-identity-and-limits",
    removed ? previousReceiptDigest : noPreviousReceiptDigest,
    receiptDigest,
  ];
  for (const [index, value] of Object.entries(overrides))
    fields[Number(index)] = value;
  return `${fields.join("\t")}\n`;
}

function nativeIo(
  authority: MutationFence,
  behavior: (command: string) => NativeProjectQuotaResult = (command) =>
    result(
      command === "probe"
        ? capabilityLine()
        : receiptLine(
            command === "apply" ? "applied" : "verified_existing",
            authority,
          ),
    ),
): NativeProjectQuotaIo & {
  readonly commands: readonly string[];
  readonly run: ReturnType<typeof vi.fn>;
} {
  const commands: string[] = [];
  return {
    commands,
    inspect: () => ({
      device: 1,
      gid: 0,
      inode: 2,
      mode: 0o755,
      modifiedMs: 1,
      path: "/usr/libexec/workload-funnel/linux-project-quota",
      sha256: digest,
      size: 100,
      uid: 0,
    }),
    run: vi.fn((_path: string, arguments_: readonly string[]) => {
      const command = arguments_[0] ?? "";
      commands.push(command);
      return behavior(command);
    }),
  };
}

const config = Object.freeze({
  expectedHelperSha256: digest,
  nativeHelperPath: "/usr/libexec/workload-funnel/linux-project-quota",
});

describe("real Linux project-quota application adapter", () => {
  it("returns only an exact durable receipt after native read-back verification", () => {
    const authority = fence();
    const io = nativeIo(authority);
    const capability = probeLinuxProjectQuotaCapability(config, io);
    const manager = new LinuxProjectQuotaManager(config, capability, io);
    const receipt = manager.applyProjectQuota(control, authority);

    expect(receipt).toMatchObject({
      appliedProjectId: control.projectId,
      effectiveInodeMaximum: control.inodeMaximum,
      effectiveMaximumBytes: control.maximumBytes,
      mutationFenceFingerprint: fingerprintMutationFence(authority),
      receiptDigest,
      rootDevice: "8:1",
      rootInode: "9001",
      status: "applied",
    });
    expect(io.commands).toEqual(["probe", "probe", "apply", "verify"]);
    const forged = { ...receipt, rootInode: "forged" };
    expect(manager.verifyProjectQuotaReceipt(control, forged, authority)).toBe(
      false,
    );
  });

  it("accepts an exact reopened receipt and rejects stale generation or fence", () => {
    const authority = fence();
    const io = nativeIo(authority, (command) =>
      result(
        command === "probe"
          ? capabilityLine()
          : receiptLine("verified_existing", authority),
      ),
    );
    const capability = probeLinuxProjectQuotaCapability(config, io);
    const manager = new LinuxProjectQuotaManager(config, capability, io);
    const receipt = manager.applyProjectQuota(control, authority);
    expect(receipt.status).toBe("verified_existing");
    expect(
      manager.verifyProjectQuotaReceipt(
        control,
        receipt,
        fence({ executionGeneration: "generation-stale", ownerFence: 0 }),
      ),
    ).toBe(false);
  });

  it("recovers cleanup capability across a stable remount and rejects device drift", () => {
    const authority = fence();
    let probeOutput = capabilityLine();
    const io = nativeIo(authority, (command) =>
      result(
        command === "probe"
          ? probeOutput
          : receiptLine("verified_existing", authority),
      ),
    );
    const previous = probeLinuxProjectQuotaCapability(config, io);
    const rebootedBootId = "fedcba98-7654-3210-fedc-ba9876543210";
    probeOutput = capabilityLine({
      bootId: rebootedBootId,
      mountId: "43",
    });
    expect(
      recoverLinuxProjectQuotaCapability(config, previous, io),
    ).toMatchObject({
      bootId: rebootedBootId,
      device: previous.device,
      mountId: "43",
    });

    probeOutput = capabilityLine({
      bootId: rebootedBootId,
      device: "8:2",
      mountId: "44",
    });
    expect(() =>
      recoverLinuxProjectQuotaCapability(config, previous, io),
    ).toThrow("project_quota_cleanup_capability_mismatch");
  });

  it.each([
    ["ambiguous success", () => result("ok\nextra\n")],
    [
      "project-ID collision",
      () => result("", 2, "project_quota_project_id_collision\n"),
    ],
    [
      "effective-limit drift",
      () => result(receiptLine("verified_existing", fence(), { 25: "1" })),
    ],
  ])("fails closed for %s", (_name, behavior) => {
    const authority = fence();
    const io = nativeIo(authority, (command) =>
      command === "probe" ? result(capabilityLine()) : behavior(),
    );
    const capability = probeLinuxProjectQuotaCapability(config, io);
    const manager = new LinuxProjectQuotaManager(config, capability, io);
    expect(() => manager.applyProjectQuota(control, authority)).toThrow();
  });

  it("requires exact verified removal and returns its durable removal receipt", () => {
    const authority = fence();
    const io = nativeIo(authority, (command) =>
      result(
        command === "probe"
          ? capabilityLine()
          : receiptLine(
              command === "remove" ? "removed" : "verified_existing",
              authority,
            ),
      ),
    );
    const capability = probeLinuxProjectQuotaCapability(config, io);
    const manager = new LinuxProjectQuotaManager(config, capability, io);
    const receipt = manager.applyProjectQuota(control, authority);
    expect(() =>
      manager.removeProjectQuota(
        control,
        { ...receipt, receiptDigest: noPreviousReceiptDigest },
        authority,
      ),
    ).toThrow("project_quota_removal_receipt_invalid");
    expect(io.commands).toEqual(["probe", "probe", "apply", "verify"]);

    expect(
      manager.removeProjectQuota(control, receipt, authority),
    ).toMatchObject({
      appliedProjectId: 0,
      effectiveInodeMaximum: 0n,
      effectiveMaximumBytes: 0n,
      receiptDigest,
      status: "removed",
    });
  });

  it("uses the fenced native cleanup path when no observed receipt exists", () => {
    const authority = fence();
    const io = nativeIo(authority, (command) =>
      result(command === "probe" ? capabilityLine() : "result\tabsent\n"),
    );
    const capability = probeLinuxProjectQuotaCapability(config, io);
    const manager = new LinuxProjectQuotaManager(config, capability, io);

    expect(manager.cleanupProjectQuota(control, authority)).toBe("absent");
    expect(io.commands).toEqual(["probe", "probe", "cleanup"]);
  });

  it("accepts only an exact durable receipt from native cleanup recovery", () => {
    const authority = fence();
    const io = nativeIo(authority, (command) =>
      result(
        command === "probe"
          ? capabilityLine()
          : receiptLine("removed", authority),
      ),
    );
    const capability = probeLinuxProjectQuotaCapability(config, io);
    const manager = new LinuxProjectQuotaManager(config, capability, io);

    expect(manager.cleanupProjectQuota(control, authority)).toMatchObject({
      appliedProjectId: 0,
      effectiveInodeMaximum: 0n,
      effectiveMaximumBytes: 0n,
      previousReceiptDigest,
      receiptDigest,
      status: "removed",
    });
    expect(io.commands).toEqual(["probe", "probe", "cleanup"]);
  });
});
