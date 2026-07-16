import {
  fingerprintMutationFence,
  type MutationFence,
  validateMutationFence,
} from "@workload-funnel/kernel";

import {
  fingerprintProjectQuotaControl,
  isExactProjectQuotaReceipt,
  type TransientProjectQuotaControl,
  type VerifiedProjectQuotaReceipt,
} from "./project-quota-registry.js";
import {
  defaultNativeProjectQuotaIo,
  type NativeProjectQuotaIdentity,
  type NativeProjectQuotaIo,
  sameNativeProjectQuotaIdentity,
} from "./linux-project-quota-io.js";

export const LINUX_PROJECT_QUOTA_CAPABILITY_SCHEMA =
  "workload-funnel.linux-project-quota-capability.v1" as const;
export const LINUX_PROJECT_QUOTA_RECEIPT_SCHEMA =
  "workload-funnel.linux-project-quota-receipt.v2" as const;
export const LINUX_PROJECT_QUOTA_ALLOCATION_ROOT =
  "/var/lib/workload-funnel/allocations" as const;
export const LINUX_PROJECT_QUOTA_RECEIPT_ROOT =
  "/var/lib/workload-funnel/project-quota" as const;

export interface LinuxProjectQuotaCapabilityEvidence {
  readonly allocationRoot: string;
  readonly bootId: string;
  readonly byteQuota: true;
  readonly device: string;
  readonly filesystem: "ext4" | "xfs";
  readonly helperIdentity: NativeProjectQuotaIdentity;
  readonly helperMode: "disposable-test" | "production";
  readonly inodeQuota: true;
  readonly mountId: string;
  readonly mountOption: "pquota" | "prjquota";
  readonly receiptRoot: string;
  readonly schemaVersion: typeof LINUX_PROJECT_QUOTA_CAPABILITY_SCHEMA;
}

export interface LinuxVerifiedProjectQuotaReceipt extends VerifiedProjectQuotaReceipt {
  readonly appliedProjectId: number;
  readonly bootId: string;
  readonly device: string;
  readonly effectiveInodeMaximum: bigint;
  readonly effectiveMaximumBytes: bigint;
  readonly executionGeneration: string;
  readonly filesystem: "ext4" | "xfs";
  readonly linuxSchemaVersion: typeof LINUX_PROJECT_QUOTA_RECEIPT_SCHEMA;
  readonly linuxVerification: "exact-linux-project-quota-root-mount-identity-and-limits";
  readonly mountId: string;
  readonly mountOption: "pquota" | "prjquota";
  readonly mutationFenceFingerprint: string;
  readonly previousReceiptDigest: string;
  readonly receiptDigest: string;
  readonly rootDevice: string;
  readonly rootInode: string;
}

export interface LinuxProjectQuotaRemovalReceipt extends Omit<
  LinuxVerifiedProjectQuotaReceipt,
  "status"
> {
  readonly status: "removed";
}

export interface LinuxProjectQuotaAdapterConfig {
  readonly allocationRoot?: string;
  readonly expectedHelperMode?: "disposable-test" | "production";
  readonly expectedHelperSha256: string;
  readonly nativeHelperPath: string;
  readonly receiptRoot?: string;
}

const digestPattern = /^[a-f0-9]{64}$/u;
const noPriorReceiptDigest = "0".repeat(64);
const bootPattern = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/u;
const unsignedPattern = /^(?:0|[1-9][0-9]*)$/u;

function exactFields(output: string, expected: number): string[] {
  if (!output.endsWith("\n") || output.slice(0, -1).includes("\n"))
    throw new Error("project_quota_helper_output_ambiguous");
  const fields = output.slice(0, -1).split("\t");
  if (fields.length !== expected || fields.some((field) => field.length === 0))
    throw new Error("project_quota_helper_output_ambiguous");
  return fields;
}

function field(fields: readonly string[], index: number): string {
  const value = fields[index];
  if (value === undefined)
    throw new Error("project_quota_helper_output_ambiguous");
  return value;
}

function nativeFailure(result: ReturnType<NativeProjectQuotaIo["run"]>): never {
  const reason = result.stderr.trim();
  if (/^[a-z0-9_]{1,128}$/u.test(reason)) throw new Error(reason);
  throw new Error("project_quota_native_helper_failed");
}

function assertHelper(
  config: LinuxProjectQuotaAdapterConfig,
  io: NativeProjectQuotaIo,
): NativeProjectQuotaIdentity {
  if (!digestPattern.test(config.expectedHelperSha256))
    throw new Error("project_quota_helper_digest_invalid");
  const identity = io.inspect(config.nativeHelperPath);
  if (identity.sha256 !== config.expectedHelperSha256)
    throw new Error("project_quota_helper_digest_mismatch");
  return identity;
}

function runNative(
  config: LinuxProjectQuotaAdapterConfig,
  io: NativeProjectQuotaIo,
  arguments_: readonly string[],
): string {
  const before = assertHelper(config, io);
  const result = io.run(config.nativeHelperPath, arguments_);
  const after = assertHelper(config, io);
  if (!sameNativeProjectQuotaIdentity(before, after))
    throw new Error("project_quota_helper_identity_changed");
  if (result.status !== 0 || result.signal !== null || result.stderr !== "")
    nativeFailure(result);
  return result.stdout;
}

function roots(config: LinuxProjectQuotaAdapterConfig): {
  readonly allocation: string;
  readonly receipt: string;
} {
  const allocation =
    config.allocationRoot ?? LINUX_PROJECT_QUOTA_ALLOCATION_ROOT;
  const receipt = config.receiptRoot ?? LINUX_PROJECT_QUOTA_RECEIPT_ROOT;
  const mode = config.expectedHelperMode ?? "production";
  if (
    mode === "production" &&
    (allocation !== LINUX_PROJECT_QUOTA_ALLOCATION_ROOT ||
      receipt !== LINUX_PROJECT_QUOTA_RECEIPT_ROOT)
  ) {
    throw new Error("project_quota_production_root_mismatch");
  }
  return { allocation, receipt };
}

function sameCapability(
  left: LinuxProjectQuotaCapabilityEvidence,
  right: LinuxProjectQuotaCapabilityEvidence,
): boolean {
  const candidate = right as unknown as Readonly<Record<string, unknown>>;
  return (
    left.allocationRoot === right.allocationRoot &&
    left.bootId === right.bootId &&
    candidate["byteQuota"] === true &&
    left.device === right.device &&
    left.filesystem === right.filesystem &&
    left.helperMode === right.helperMode &&
    candidate["inodeQuota"] === true &&
    left.mountId === right.mountId &&
    left.mountOption === right.mountOption &&
    left.receiptRoot === right.receiptRoot &&
    candidate["schemaVersion"] === LINUX_PROJECT_QUOTA_CAPABILITY_SCHEMA &&
    sameNativeProjectQuotaIdentity(left.helperIdentity, right.helperIdentity)
  );
}

function sameStableCapability(
  left: LinuxProjectQuotaCapabilityEvidence,
  right: LinuxProjectQuotaCapabilityEvidence,
): boolean {
  const candidate = right as unknown as Readonly<Record<string, unknown>>;
  return (
    left.allocationRoot === right.allocationRoot &&
    candidate["byteQuota"] === true &&
    left.device === right.device &&
    left.filesystem === right.filesystem &&
    left.helperMode === right.helperMode &&
    candidate["inodeQuota"] === true &&
    left.mountOption === right.mountOption &&
    left.receiptRoot === right.receiptRoot &&
    candidate["schemaVersion"] === LINUX_PROJECT_QUOTA_CAPABILITY_SCHEMA &&
    sameNativeProjectQuotaIdentity(left.helperIdentity, right.helperIdentity)
  );
}

export function probeLinuxProjectQuotaCapability(
  config: LinuxProjectQuotaAdapterConfig,
  io: NativeProjectQuotaIo = defaultNativeProjectQuotaIo,
): LinuxProjectQuotaCapabilityEvidence {
  const configuredRoots = roots(config);
  const fields = exactFields(
    runNative(config, io, [
      "probe",
      configuredRoots.allocation,
      configuredRoots.receipt,
    ]),
    9,
  );
  const mode = config.expectedHelperMode ?? "production";
  if (
    field(fields, 0) !== LINUX_PROJECT_QUOTA_CAPABILITY_SCHEMA ||
    field(fields, 1) !== mode ||
    !unsignedPattern.test(field(fields, 2)) ||
    !/^[0-9]+:[0-9]+$/u.test(field(fields, 3)) ||
    (field(fields, 4) !== "xfs" && field(fields, 4) !== "ext4") ||
    (field(fields, 5) !== "prjquota" && field(fields, 5) !== "pquota") ||
    !bootPattern.test(field(fields, 6)) ||
    field(fields, 7) !== "true" ||
    field(fields, 8) !== "true"
  ) {
    throw new Error("project_quota_capability_evidence_invalid");
  }
  return Object.freeze({
    allocationRoot: configuredRoots.allocation,
    bootId: field(fields, 6),
    byteQuota: true,
    device: field(fields, 3),
    filesystem: field(fields, 4) as "ext4" | "xfs",
    helperIdentity: assertHelper(config, io),
    helperMode: mode,
    inodeQuota: true,
    mountId: field(fields, 2),
    mountOption: field(fields, 5) as "pquota" | "prjquota",
    receiptRoot: configuredRoots.receipt,
    schemaVersion: LINUX_PROJECT_QUOTA_CAPABILITY_SCHEMA,
  });
}

export function recoverLinuxProjectQuotaCapability(
  config: LinuxProjectQuotaAdapterConfig,
  previous: LinuxProjectQuotaCapabilityEvidence,
  io: NativeProjectQuotaIo = defaultNativeProjectQuotaIo,
): LinuxProjectQuotaCapabilityEvidence {
  const current = probeLinuxProjectQuotaCapability(config, io);
  if (!sameStableCapability(current, previous)) {
    throw new Error("project_quota_cleanup_capability_mismatch");
  }
  return current;
}

function fenceArguments(fence: MutationFence, allocationId: string): string[] {
  validateMutationFence(fence);
  if (
    fence.desiredEffect !== "process_start" ||
    fence.allocationId !== allocationId ||
    fence.ownerFence === undefined ||
    fence.issuedStartRevocationRevision === undefined
  ) {
    throw new Error("project_quota_mutation_fence_mismatch");
  }
  return [
    fingerprintMutationFence(fence),
    fence.executionGeneration,
    String(fence.clusterIncarnationVersion),
    String(fence.namespaceWriterEpoch),
    String(fence.operationGateRevision),
    String(fence.ownerFence),
    String(fence.expectedDesiredVersion),
    String(fence.issuedStartRevocationRevision),
  ];
}

function requestArguments(
  configuredRoots: ReturnType<typeof roots>,
  control: TransientProjectQuotaControl,
  fence: MutationFence,
): string[] {
  if (
    control.root !== `${configuredRoots.allocation}/${control.allocationId}` ||
    control.maximumBytes <= 0n ||
    control.inodeMaximum <= 0n ||
    !Number.isSafeInteger(control.projectId) ||
    control.projectId < 1 ||
    control.projectId > 2_147_483_647
  ) {
    throw new Error("invalid_project_quota_control");
  }
  return [
    configuredRoots.allocation,
    configuredRoots.receipt,
    control.allocationId,
    String(control.projectId),
    String(control.maximumBytes),
    String(control.inodeMaximum),
    fingerprintProjectQuotaControl(control),
    ...fenceArguments(fence, control.allocationId),
  ];
}

function parseReceipt(
  output: string,
  control: TransientProjectQuotaControl,
  fence: MutationFence,
  capability: LinuxProjectQuotaCapabilityEvidence,
  expectedOperation: "applied" | "removed" | "verified_existing",
): LinuxVerifiedProjectQuotaReceipt {
  const fields = exactFields(output, 32);
  const numeric = [
    5, 7, 8, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 24, 25, 26, 27,
  ];
  if (
    field(fields, 0) !== "result" ||
    field(fields, 1) !== expectedOperation ||
    field(fields, 2) !== LINUX_PROJECT_QUOTA_RECEIPT_SCHEMA ||
    field(fields, 3) !==
      (expectedOperation === "removed" ? "removed" : "active") ||
    !numeric.every((index) => unsignedPattern.test(field(fields, index))) ||
    field(fields, 4) !== control.allocationId ||
    field(fields, 5) !== String(control.projectId) ||
    field(fields, 6) !== control.root ||
    field(fields, 7) !== String(control.maximumBytes) ||
    field(fields, 8) !== String(control.inodeMaximum) ||
    !digestPattern.test(field(fields, 9)) ||
    field(fields, 9) !== fingerprintProjectQuotaControl(control) ||
    field(fields, 10) !== fingerprintMutationFence(fence) ||
    field(fields, 11) !== fence.executionGeneration ||
    field(fields, 12) !== String(fence.clusterIncarnationVersion) ||
    field(fields, 13) !== String(fence.namespaceWriterEpoch) ||
    field(fields, 14) !== String(fence.operationGateRevision) ||
    field(fields, 15) !== String(fence.ownerFence) ||
    field(fields, 16) !== String(fence.expectedDesiredVersion) ||
    field(fields, 17) !== String(fence.issuedStartRevocationRevision) ||
    `${field(fields, 18)}:${field(fields, 19)}` !== capability.device ||
    field(fields, 21) !== capability.mountId ||
    field(fields, 22) !== capability.filesystem ||
    field(fields, 23) !== capability.mountOption ||
    field(fields, 29) !==
      "exact-linux-project-quota-root-mount-identity-and-limits" ||
    field(fields, 28) !== capability.bootId ||
    !digestPattern.test(field(fields, 30)) ||
    !digestPattern.test(field(fields, 31)) ||
    field(fields, 31) === noPriorReceiptDigest ||
    (expectedOperation === "removed" &&
      field(fields, 30) === noPriorReceiptDigest)
  ) {
    throw new Error("project_quota_receipt_output_invalid");
  }
  const receipt = Object.freeze({
    allocationId: field(fields, 4),
    appliedProjectId: Number(field(fields, 24)),
    bootId: field(fields, 28),
    controlDigest: field(fields, 9),
    device: capability.device,
    effectiveInodeMaximum: BigInt(field(fields, 26)),
    effectiveMaximumBytes: BigInt(field(fields, 25)),
    executionGeneration: field(fields, 11),
    filesystem: field(fields, 22) as "ext4" | "xfs",
    inodeMaximum: BigInt(field(fields, 8)),
    linuxSchemaVersion: LINUX_PROJECT_QUOTA_RECEIPT_SCHEMA,
    linuxVerification:
      "exact-linux-project-quota-root-mount-identity-and-limits" as const,
    maximumBytes: BigInt(field(fields, 7)),
    mountId: field(fields, 21),
    mountOption: field(fields, 23) as "pquota" | "prjquota",
    mutationFenceFingerprint: field(fields, 10),
    projectId: Number(field(fields, 5)),
    previousReceiptDigest: field(fields, 30),
    receiptDigest: field(fields, 31),
    registryRevision: Number(field(fields, 27)),
    root: field(fields, 6),
    rootDevice: `${field(fields, 18)}:${field(fields, 19)}`,
    rootInode: field(fields, 20),
    schemaVersion: "phase4c.project-quota-receipt.v1" as const,
    status:
      expectedOperation === "applied"
        ? ("applied" as const)
        : ("verified_existing" as const),
    verification: "exact_root_and_limits" as const,
  });
  if (
    !isExactProjectQuotaReceipt(control, receipt) ||
    receipt.mutationFenceFingerprint !== fingerprintMutationFence(fence) ||
    receipt.bootId !== capability.bootId ||
    (expectedOperation !== "removed" &&
      (receipt.appliedProjectId !== control.projectId ||
        receipt.effectiveMaximumBytes !== control.maximumBytes ||
        receipt.effectiveInodeMaximum !== control.inodeMaximum)) ||
    (expectedOperation === "removed" &&
      (receipt.appliedProjectId !== 0 ||
        receipt.effectiveMaximumBytes !== 0n ||
        receipt.effectiveInodeMaximum !== 0n))
  ) {
    throw new Error("project_quota_receipt_tuple_mismatch");
  }
  return receipt;
}

function parseApplicationReceipt(
  output: string,
  control: TransientProjectQuotaControl,
  fence: MutationFence,
  capability: LinuxProjectQuotaCapabilityEvidence,
): LinuxVerifiedProjectQuotaReceipt {
  const operation = field(exactFields(output, 32), 1);
  if (operation !== "applied" && operation !== "verified_existing")
    throw new Error("project_quota_receipt_output_invalid");
  return parseReceipt(output, control, fence, capability, operation);
}

export class LinuxProjectQuotaManager {
  public readonly projectQuotaControl = "supported" as const;
  readonly #capability: LinuxProjectQuotaCapabilityEvidence;
  readonly #config: LinuxProjectQuotaAdapterConfig;
  readonly #io: NativeProjectQuotaIo;
  readonly #roots: ReturnType<typeof roots>;

  public constructor(
    config: LinuxProjectQuotaAdapterConfig,
    capability: LinuxProjectQuotaCapabilityEvidence,
    io: NativeProjectQuotaIo = defaultNativeProjectQuotaIo,
  ) {
    this.#config = config;
    this.#io = io;
    this.#roots = roots(config);
    const current = probeLinuxProjectQuotaCapability(config, io);
    if (!sameCapability(current, capability)) {
      throw new Error("project_quota_capability_evidence_stale");
    }
    this.#capability = capability;
  }

  public applyProjectQuota(
    control: TransientProjectQuotaControl,
    fence: MutationFence,
  ): LinuxVerifiedProjectQuotaReceipt {
    const request = requestArguments(this.#roots, control, fence);
    const applied = parseApplicationReceipt(
      runNative(this.#config, this.#io, ["apply", ...request]),
      control,
      fence,
      this.#capability,
    );
    return this.verifyExact(control, applied, fence);
  }

  public verifyProjectQuotaReceipt(
    control: TransientProjectQuotaControl,
    receipt: VerifiedProjectQuotaReceipt,
    fence: MutationFence,
  ): boolean {
    try {
      this.verifyExact(control, receipt, fence);
      return true;
    } catch {
      return false;
    }
  }

  public removeProjectQuota(
    control: TransientProjectQuotaControl,
    receipt: LinuxVerifiedProjectQuotaReceipt,
    fence: MutationFence,
  ): LinuxProjectQuotaRemovalReceipt {
    const supplied = receipt as unknown as Readonly<Record<string, unknown>>;
    if (
      !isExactProjectQuotaReceipt(control, receipt) ||
      typeof supplied["receiptDigest"] !== "string" ||
      !digestPattern.test(supplied["receiptDigest"]) ||
      supplied["receiptDigest"] === noPriorReceiptDigest ||
      supplied["mutationFenceFingerprint"] !== fingerprintMutationFence(fence)
    ) {
      throw new Error("project_quota_removal_receipt_invalid");
    }
    const request = requestArguments(this.#roots, control, fence);
    const removed = parseReceipt(
      runNative(this.#config, this.#io, [
        "remove",
        ...request,
        receipt.receiptDigest,
      ]),
      control,
      fence,
      this.#capability,
      "removed",
    );
    return Object.freeze({ ...removed, status: "removed" });
  }

  public cleanupProjectQuota(
    control: TransientProjectQuotaControl,
    fence: MutationFence,
  ): LinuxProjectQuotaRemovalReceipt | "absent" {
    const request = requestArguments(this.#roots, control, fence);
    const output = runNative(this.#config, this.#io, ["cleanup", ...request]);
    if (output === "result\tabsent\n") return "absent";
    const removed = parseReceipt(
      output,
      control,
      fence,
      this.#capability,
      "removed",
    );
    return Object.freeze({ ...removed, status: "removed" });
  }

  private verifyExact(
    control: TransientProjectQuotaControl,
    receipt: VerifiedProjectQuotaReceipt,
    fence: MutationFence,
  ): LinuxVerifiedProjectQuotaReceipt {
    const candidate = receipt as unknown as {
      readonly receiptDigest?: unknown;
    };
    if (
      typeof candidate.receiptDigest !== "string" ||
      !digestPattern.test(candidate.receiptDigest)
    )
      throw new Error("project_quota_receipt_digest_invalid");
    const linux = receipt as LinuxVerifiedProjectQuotaReceipt;
    const request = requestArguments(this.#roots, control, fence);
    const reopened = parseReceipt(
      runNative(this.#config, this.#io, [
        "verify",
        ...request,
        linux.receiptDigest,
      ]),
      control,
      fence,
      this.#capability,
      "verified_existing",
    );
    const supplied = linux as unknown as Readonly<Record<string, unknown>>;
    if (
      reopened.receiptDigest !== linux.receiptDigest ||
      reopened.registryRevision !== linux.registryRevision ||
      (supplied["status"] !== "applied" &&
        supplied["status"] !== "verified_existing") ||
      Object.entries(reopened).some(
        ([key, value]) => key !== "status" && supplied[key] !== value,
      )
    )
      throw new Error("project_quota_receipt_reopen_mismatch");
    return linux;
  }
}
