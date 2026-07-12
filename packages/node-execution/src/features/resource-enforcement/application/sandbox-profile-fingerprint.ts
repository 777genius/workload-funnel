import { createHash } from "node:crypto";

import {
  type SandboxProfile,
  validateSandboxProfile,
} from "../domain/sandbox-profile.js";

function stableValue(value: unknown): unknown {
  if (typeof value === "bigint") return `${value.toString()}n`;
  if (Array.isArray(value)) return value.map(stableValue);
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nested]) => [key, stableValue(nested)]),
    );
  }
  return value;
}

export function fingerprintSandboxProfile(profile: SandboxProfile): string {
  validateSandboxProfile(profile);
  return createHash("sha256")
    .update(JSON.stringify(stableValue(profile)), "utf8")
    .digest("hex");
}
