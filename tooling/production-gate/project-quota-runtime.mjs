function restoreControl(value) {
  if (
    value === null ||
    typeof value !== "object" ||
    typeof value.allocationId !== "string" ||
    typeof value.inodeMaximum !== "string" ||
    typeof value.maximumBytes !== "string" ||
    !Number.isSafeInteger(value.projectId) ||
    typeof value.root !== "string"
  )
    throw new Error("project_quota_cleanup_control_invalid");
  return Object.freeze({
    ...value,
    inodeMaximum: BigInt(value.inodeMaximum),
    maximumBytes: BigInt(value.maximumBytes),
  });
}

function restoreReceipt(value) {
  if (
    value === null ||
    typeof value !== "object" ||
    typeof value.receiptDigest !== "string"
  )
    throw new Error("project_quota_cleanup_receipt_invalid");
  return Object.freeze({
    ...value,
    effectiveInodeMaximum: BigInt(value.effectiveInodeMaximum),
    effectiveMaximumBytes: BigInt(value.effectiveMaximumBytes),
    inodeMaximum: BigInt(value.inodeMaximum),
    maximumBytes: BigInt(value.maximumBytes),
  });
}

export function serializeProjectQuotaControl(control) {
  return Object.freeze({
    ...control,
    inodeMaximum: control.inodeMaximum.toString(),
    maximumBytes: control.maximumBytes.toString(),
  });
}

export function serializeProjectQuotaReceipt(receipt) {
  return Object.freeze({
    ...receipt,
    effectiveInodeMaximum: receipt.effectiveInodeMaximum.toString(),
    effectiveMaximumBytes: receipt.effectiveMaximumBytes.toString(),
    inodeMaximum: receipt.inodeMaximum.toString(),
    maximumBytes: receipt.maximumBytes.toString(),
  });
}

export async function cleanupProjectQuotaRecord(record) {
  const expected = record.expected;
  if (
    expected === null ||
    typeof expected !== "object" ||
    expected.adapterConfig === null ||
    typeof expected.adapterConfig !== "object" ||
    expected.capability === null ||
    typeof expected.capability !== "object" ||
    expected.fence === null ||
    typeof expected.fence !== "object"
  )
    throw new Error("project_quota_cleanup_record_invalid");
  const quota =
    await import("@workload-funnel/executor-systemd/transient-unit-start");
  const control = restoreControl(expected.control);
  const capability = quota.recoverLinuxProjectQuotaCapability(
    expected.adapterConfig,
    expected.capability,
  );
  const manager = new quota.LinuxProjectQuotaManager(
    expected.adapterConfig,
    capability,
  );
  const recorded = record.observed?.receipt;
  if (recorded === undefined) {
    manager.cleanupProjectQuota(control, expected.fence);
  } else {
    manager.removeProjectQuota(
      control,
      restoreReceipt(recorded),
      expected.fence,
    );
  }
}
