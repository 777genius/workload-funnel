import { createHash } from "node:crypto";

export interface TransientProjectQuotaControl {
  readonly allocationId: string;
  readonly inodeMaximum: bigint;
  readonly maximumBytes: bigint;
  readonly projectId: number;
  readonly root: string;
}

export const PROJECT_QUOTA_RECEIPT_SCHEMA =
  "phase4c.project-quota-receipt.v1" as const;

export interface VerifiedProjectQuotaReceipt extends TransientProjectQuotaControl {
  readonly controlDigest: string;
  readonly registryRevision: number;
  readonly schemaVersion: typeof PROJECT_QUOTA_RECEIPT_SCHEMA;
  readonly status: "applied" | "verified_existing";
  readonly verification: "exact_root_and_limits";
}

function validateControl(control: TransientProjectQuotaControl): void {
  if (
    !/^[a-z0-9-]+$/u.test(control.allocationId) ||
    control.root !==
      `/var/lib/workload-funnel/allocations/${control.allocationId}` ||
    !Number.isSafeInteger(control.projectId) ||
    control.projectId < 1 ||
    control.maximumBytes <= 0n ||
    control.inodeMaximum <= 0n
  ) {
    throw new Error("invalid_project_quota_control");
  }
}

export function fingerprintProjectQuotaControl(
  control: TransientProjectQuotaControl,
): string {
  return createHash("sha256")
    .update(
      [
        control.allocationId,
        control.projectId.toString(10),
        control.root,
        control.maximumBytes.toString(10),
        control.inodeMaximum.toString(10),
      ].join("\u0000"),
      "utf8",
    )
    .digest("hex");
}

export function isExactProjectQuotaReceipt(
  control: TransientProjectQuotaControl,
  receipt: VerifiedProjectQuotaReceipt,
): boolean {
  const candidate = receipt as unknown as Readonly<Record<string, unknown>>;
  return (
    candidate["schemaVersion"] === PROJECT_QUOTA_RECEIPT_SCHEMA &&
    candidate["verification"] === "exact_root_and_limits" &&
    (candidate["status"] === "applied" ||
      candidate["status"] === "verified_existing") &&
    Number.isSafeInteger(candidate["registryRevision"]) &&
    (candidate["registryRevision"] as number) >= 1 &&
    candidate["allocationId"] === control.allocationId &&
    candidate["projectId"] === control.projectId &&
    candidate["root"] === control.root &&
    candidate["maximumBytes"] === control.maximumBytes &&
    candidate["inodeMaximum"] === control.inodeMaximum &&
    candidate["controlDigest"] === fingerprintProjectQuotaControl(control)
  );
}

export class ProjectQuotaRegistry {
  readonly #byProject = new Map<
    number,
    Readonly<{
      control: TransientProjectQuotaControl;
      revision: number;
    }>
  >();
  readonly #projectByAllocation = new Map<string, number>();
  #revision = 0;

  public ensure(
    control: TransientProjectQuotaControl,
  ): VerifiedProjectQuotaReceipt {
    validateControl(control);
    const mappedProject = this.#projectByAllocation.get(control.allocationId);
    if (mappedProject !== undefined && mappedProject !== control.projectId) {
      throw new Error("project_quota_allocation_collision");
    }
    const current = this.#byProject.get(control.projectId);
    let status: VerifiedProjectQuotaReceipt["status"];
    let revision: number;
    if (current === undefined) {
      this.#revision += 1;
      revision = this.#revision;
      const frozen = Object.freeze({ ...control });
      this.#byProject.set(
        control.projectId,
        Object.freeze({ control: frozen, revision }),
      );
      this.#projectByAllocation.set(control.allocationId, control.projectId);
      status = "applied";
    } else {
      if (
        fingerprintProjectQuotaControl(current.control) !==
        fingerprintProjectQuotaControl(control)
      ) {
        throw new Error(
          current.control.allocationId === control.allocationId
            ? "project_quota_existing_limits_mismatch"
            : "project_quota_project_id_collision",
        );
      }
      revision = current.revision;
      status = "verified_existing";
    }
    return Object.freeze({
      ...control,
      controlDigest: fingerprintProjectQuotaControl(control),
      registryRevision: revision,
      schemaVersion: PROJECT_QUOTA_RECEIPT_SCHEMA,
      status,
      verification: "exact_root_and_limits",
    });
  }

  public verify(
    control: TransientProjectQuotaControl,
    receipt: VerifiedProjectQuotaReceipt,
  ): boolean {
    const current = this.#byProject.get(control.projectId);
    return (
      isExactProjectQuotaReceipt(control, receipt) &&
      current?.revision === receipt.registryRevision &&
      this.#projectByAllocation.get(control.allocationId) ===
        control.projectId &&
      fingerprintProjectQuotaControl(current.control) === receipt.controlDigest
    );
  }
}
