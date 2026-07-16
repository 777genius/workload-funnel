import { sha256Hex } from "@workload-funnel/kernel";

import {
  InvalidWorkloadError,
  type WorkloadSpec,
} from "../domain/workload-records.js";

export function validateWorkloadSpec(value: unknown): WorkloadSpec {
  if (typeof value !== "object" || value === null) {
    throw new InvalidWorkloadError("A structured WorkloadSpec is required");
  }
  const candidate = value as Record<string, unknown>;
  if (
    candidate["schemaVersion"] !== 1 ||
    candidate["processProfile"] !== "trusted-synthetic-v1"
  ) {
    throw new InvalidWorkloadError(
      "Only the trusted synthetic v1 profile is enabled",
    );
  }
  const command = candidate["command"];
  if (
    !Array.isArray(command) ||
    command.length === 0 ||
    command.length > 128 ||
    command.some(
      (part) =>
        typeof part !== "string" ||
        part.length === 0 ||
        part.length > 4096 ||
        part.includes("\0"),
    )
  ) {
    throw new InvalidWorkloadError(
      "A structured synthetic command is required",
    );
  }
  const commandParts = command as string[];
  if (commandParts.reduce((total, part) => total + part.length, 0) > 65_536)
    throw new InvalidWorkloadError(
      "A structured synthetic command is required",
    );
  const resources = candidate["resources"];
  if (typeof resources !== "object" || resources === null) {
    throw new InvalidWorkloadError("Resource requests must be positive");
  }
  const resourceRecord = resources as Record<string, unknown>;
  const cpuMillis = resourceRecord["cpuMillis"];
  const memoryMiB = resourceRecord["memoryMiB"];
  if (
    typeof cpuMillis !== "number" ||
    typeof memoryMiB !== "number" ||
    !Number.isSafeInteger(cpuMillis) ||
    !Number.isSafeInteger(memoryMiB) ||
    cpuMillis <= 0 ||
    memoryMiB <= 0 ||
    cpuMillis > 1_000_000_000 ||
    memoryMiB > 1_000_000_000
  )
    throw new InvalidWorkloadError("Resource requests must be positive");
  const syntheticOutcome = candidate["syntheticOutcome"];
  if (
    typeof syntheticOutcome !== "string" ||
    !["succeeded", "failed", "canceled"].includes(syntheticOutcome)
  )
    throw new InvalidWorkloadError("Synthetic outcome is not supported");
  const resultFiles = candidate["resultFiles"];
  if (!Array.isArray(resultFiles) || resultFiles.length > 256)
    throw new InvalidWorkloadError("Synthetic results exceed the file limit");
  let resultBytes = 0;
  for (const result of resultFiles) {
    if (
      typeof result !== "object" ||
      result === null ||
      Array.isArray(result)
    ) {
      throw new InvalidWorkloadError(
        "Result paths must remain inside the synthetic root",
      );
    }
    const resultRecord = result as Record<string, unknown>;
    const path = resultRecord["path"];
    const content = resultRecord["content"];
    if (
      typeof path !== "string" ||
      typeof content !== "string" ||
      path.length === 0 ||
      path.length > 512 ||
      path.startsWith("/") ||
      path.split("/").includes("..") ||
      path.includes("\0") ||
      content.length > 1_048_576
    )
      throw new InvalidWorkloadError(
        "Result paths must remain inside the synthetic root",
      );
    resultBytes += content.length;
    if (resultBytes > 8_388_608)
      throw new InvalidWorkloadError("Synthetic result bytes exceed the limit");
  }
  return Object.freeze({
    command: Object.freeze([...commandParts]),
    processProfile: "trusted-synthetic-v1",
    resources: Object.freeze({ cpuMillis, memoryMiB }),
    resultFiles: Object.freeze(
      resultFiles.map((result) => {
        const record = result as Record<string, unknown>;
        return Object.freeze({
          content: record["content"] as string,
          path: record["path"] as string,
        });
      }),
    ),
    schemaVersion: 1,
    syntheticOutcome: syntheticOutcome as WorkloadSpec["syntheticOutcome"],
  });
}

export function workloadSpecDigest(spec: WorkloadSpec): string {
  return `spec-sha256-${sha256Hex(JSON.stringify(spec))}`;
}
