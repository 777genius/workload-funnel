import { createPublicKey, verify } from "node:crypto";

const digest = /^[a-f0-9]{64}$/u;
const bounded = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/u;

export interface ProductionCapabilityDependency {
  readonly capability: string;
  readonly configurationDigest: string;
  readonly contractVersion: string;
  readonly evidenceDigest: string;
  readonly notAfter: number;
  readonly providerId: string;
  readonly verifiedAt: number;
}

export interface ProductionCapabilityReceipt {
  readonly compatibilityManifestDigest: string;
  readonly configDigest: string;
  readonly dependencies: readonly ProductionCapabilityDependency[];
  readonly issuedAt: number;
  readonly notAfter: number;
  readonly notBefore: number;
  readonly profileId: "control-postgres";
  readonly schemaVersion: 1;
  readonly signatureBase64Url: string;
  readonly signerKeyId: string;
}

export interface VerifiedProductionCapabilityReceipt extends ProductionCapabilityReceipt {
  readonly verified: true;
}

export class ProductionCapabilityGateError extends Error {
  public constructor(public readonly code: string) {
    super(code);
    this.name = "ProductionCapabilityGateError";
  }
}

function canonical(value: unknown): string {
  if (value === undefined)
    throw new ProductionCapabilityGateError(
      "production_capability_receipt_invalid",
    );
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`)
    .join(",")}}`;
}

function exactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return (
    actual.length === expected.length &&
    actual.every((key, index) => key === expected[index])
  );
}

function timestamp(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function parseDependency(value: unknown): ProductionCapabilityDependency {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new ProductionCapabilityGateError(
      "production_capability_receipt_invalid",
    );
  const row = value as Record<string, unknown>;
  if (
    !exactKeys(row, [
      "capability",
      "configurationDigest",
      "contractVersion",
      "evidenceDigest",
      "notAfter",
      "providerId",
      "verifiedAt",
    ]) ||
    typeof row["capability"] !== "string" ||
    !bounded.test(row["capability"]) ||
    typeof row["configurationDigest"] !== "string" ||
    !digest.test(row["configurationDigest"]) ||
    typeof row["contractVersion"] !== "string" ||
    !bounded.test(row["contractVersion"]) ||
    typeof row["evidenceDigest"] !== "string" ||
    !digest.test(row["evidenceDigest"]) ||
    !timestamp(row["notAfter"]) ||
    typeof row["providerId"] !== "string" ||
    !bounded.test(row["providerId"]) ||
    !timestamp(row["verifiedAt"])
  )
    throw new ProductionCapabilityGateError(
      "production_capability_receipt_invalid",
    );
  return Object.freeze({
    capability: row["capability"],
    configurationDigest: row["configurationDigest"],
    contractVersion: row["contractVersion"],
    evidenceDigest: row["evidenceDigest"],
    notAfter: row["notAfter"],
    providerId: row["providerId"],
    verifiedAt: row["verifiedAt"],
  });
}

export function parseProductionCapabilityReceipt(
  value: unknown,
): ProductionCapabilityReceipt {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new ProductionCapabilityGateError(
      "production_capability_receipt_invalid",
    );
  const row = value as Record<string, unknown>;
  if (
    !exactKeys(row, [
      "compatibilityManifestDigest",
      "configDigest",
      "dependencies",
      "issuedAt",
      "notAfter",
      "notBefore",
      "profileId",
      "schemaVersion",
      "signatureBase64Url",
      "signerKeyId",
    ]) ||
    row["schemaVersion"] !== 1 ||
    row["profileId"] !== "control-postgres" ||
    typeof row["compatibilityManifestDigest"] !== "string" ||
    !digest.test(row["compatibilityManifestDigest"]) ||
    typeof row["configDigest"] !== "string" ||
    !digest.test(row["configDigest"]) ||
    !Array.isArray(row["dependencies"]) ||
    !timestamp(row["issuedAt"]) ||
    !timestamp(row["notAfter"]) ||
    !timestamp(row["notBefore"]) ||
    typeof row["signatureBase64Url"] !== "string" ||
    !/^[A-Za-z0-9_-]{80,512}$/u.test(row["signatureBase64Url"]) ||
    typeof row["signerKeyId"] !== "string" ||
    !bounded.test(row["signerKeyId"])
  )
    throw new ProductionCapabilityGateError(
      "production_capability_receipt_invalid",
    );
  const dependencies = Object.freeze(row["dependencies"].map(parseDependency));
  return Object.freeze({
    compatibilityManifestDigest: row["compatibilityManifestDigest"],
    configDigest: row["configDigest"],
    dependencies,
    issuedAt: row["issuedAt"],
    notAfter: row["notAfter"],
    notBefore: row["notBefore"],
    profileId: "control-postgres",
    schemaVersion: 1,
    signatureBase64Url: row["signatureBase64Url"],
    signerKeyId: row["signerKeyId"],
  });
}

export function productionCapabilitySigningPayload(
  receipt: Omit<ProductionCapabilityReceipt, "signatureBase64Url">,
): string {
  return canonical(receipt);
}

export function verifyProductionCapabilityReceipt(
  input: Readonly<{
    expectedCompatibilityManifestDigest: string;
    expectedConfigDigest: string;
    now: number;
    receipt: unknown;
    requiredCapabilities: readonly string[];
    trustedSignerPublicKeys: ReadonlyMap<string, string>;
  }>,
): VerifiedProductionCapabilityReceipt {
  const receipt = parseProductionCapabilityReceipt(input.receipt);
  const capabilities = receipt.dependencies.map(
    (dependency) => dependency.capability,
  );
  if (
    !timestamp(input.now) ||
    receipt.configDigest !== input.expectedConfigDigest ||
    receipt.compatibilityManifestDigest !==
      input.expectedCompatibilityManifestDigest ||
    input.now < receipt.notBefore ||
    input.now >= receipt.notAfter ||
    receipt.issuedAt > input.now ||
    receipt.notBefore < receipt.issuedAt ||
    receipt.notAfter - receipt.notBefore > 24 * 60 * 60 * 1000 ||
    capabilities.join() !== [...input.requiredCapabilities].sort().join() ||
    capabilities.join() !== [...new Set(capabilities)].sort().join() ||
    receipt.dependencies.some(
      (dependency) =>
        dependency.verifiedAt > input.now ||
        dependency.notAfter > receipt.notAfter ||
        dependency.notAfter <= input.now,
    )
  )
    throw new ProductionCapabilityGateError(
      "production_capability_gate_rejected",
    );
  const publicKey = input.trustedSignerPublicKeys.get(receipt.signerKeyId);
  if (publicKey === undefined)
    throw new ProductionCapabilityGateError(
      "production_capability_signer_untrusted",
    );
  const { signatureBase64Url, ...payload } = receipt;
  let valid = false;
  try {
    valid = verify(
      null,
      Buffer.from(productionCapabilitySigningPayload(payload), "utf8"),
      createPublicKey(publicKey),
      Buffer.from(signatureBase64Url, "base64url"),
    );
  } catch {
    valid = false;
  }
  if (!valid)
    throw new ProductionCapabilityGateError(
      "production_capability_signature_invalid",
    );
  return Object.freeze({ ...receipt, verified: true as const });
}
