import { createHash } from "node:crypto";

import type { TransportIdentityBinding } from "@workload-funnel/control-service/authentication";
import {
  createAuthorizationService,
  type ApiPermission,
  type PrincipalAuthorizationPolicy,
} from "@workload-funnel/control-service/authorization";

const digest = /^[a-f0-9]{64}$/u;
const text = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/u;

export interface ProductionServerConfig {
  readonly authorizationPolicies: readonly PrincipalAuthorizationPolicy[];
  readonly capabilityReceipt: unknown;
  readonly capacity: Readonly<{
    capacityId: string;
    totalCpuMillis: number;
    totalMemoryMiB: number;
  }>;
  readonly compatibilityManifestDigest: string;
  readonly identityBindings: readonly TransportIdentityBinding[];
  readonly namespaceId: string;
  readonly network: Readonly<{
    drainTimeoutMs: number;
    headersTimeoutMs: number;
    host: string;
    keepAliveTimeoutMs: number;
    maxConnections: number;
    maxRequestBytes: number;
    port: number;
    requestTimeoutMs: number;
    tls: Readonly<{
      certificate: string;
      certificateAuthority: string;
      privateKey: string;
    }>;
  }>;
  readonly schemaVersion: 1;
  readonly trustedCapabilitySigners: ReadonlyMap<string, string>;
  readonly writer: Readonly<{ writerEpoch: number; writerId: string }>;
}

export class ProductionServerConfigurationError extends Error {
  public constructor(public readonly code: string) {
    super(code);
    this.name = "ProductionServerConfigurationError";
  }
}

function object(
  value: unknown,
  keys: readonly string[],
  code: string,
): Record<string, unknown> {
  const actualKeys =
    typeof value === "object" && value !== null && !Array.isArray(value)
      ? Object.keys(value).sort()
      : [];
  const expectedKeys = [...keys].sort();
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    actualKeys.length !== expectedKeys.length ||
    actualKeys.some((key, index) => key !== expectedKeys[index])
  )
    throw new ProductionServerConfigurationError(code);
  return value as Record<string, unknown>;
}

function integer(
  value: unknown,
  minimum: number,
  maximum: number,
  code: string,
): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < minimum ||
    value > maximum
  )
    throw new ProductionServerConfigurationError(code);
  return value;
}

function pem(value: unknown, label: string): string {
  if (
    typeof value !== "string" ||
    value.length < 64 ||
    value.length > 1_048_576 ||
    value.includes("\0") ||
    !value.includes(`-----BEGIN ${label}-----`) ||
    !value.includes(`-----END ${label}-----`)
  )
    throw new ProductionServerConfigurationError(
      "production_tls_config_invalid",
    );
  return value;
}

function parseIdentity(value: unknown): TransportIdentityBinding {
  const row = object(
    value,
    ["certificateFingerprint", "credentialId", "principalId"],
    "production_identity_config_invalid",
  );
  if (
    typeof row["certificateFingerprint"] !== "string" ||
    !/^(?:[A-F0-9]{2}:){31}[A-F0-9]{2}$/u.test(row["certificateFingerprint"]) ||
    typeof row["credentialId"] !== "string" ||
    !text.test(row["credentialId"]) ||
    typeof row["principalId"] !== "string" ||
    !text.test(row["principalId"])
  )
    throw new ProductionServerConfigurationError(
      "production_identity_config_invalid",
    );
  return Object.freeze({
    certificateFingerprint: row["certificateFingerprint"],
    credentialId: row["credentialId"],
    principalId: row["principalId"],
  });
}

function parsePolicy(value: unknown): PrincipalAuthorizationPolicy {
  const row = object(
    value,
    ["policyVersion", "principalId", "tenantGrants"],
    "production_authorization_config_invalid",
  );
  if (
    typeof row["principalId"] !== "string" ||
    !text.test(row["principalId"]) ||
    typeof row["policyVersion"] !== "number" ||
    !Number.isSafeInteger(row["policyVersion"]) ||
    row["policyVersion"] < 1 ||
    !Array.isArray(row["tenantGrants"]) ||
    row["tenantGrants"].length < 1 ||
    row["tenantGrants"].length > 256
  )
    throw new ProductionServerConfigurationError(
      "production_authorization_config_invalid",
    );
  return Object.freeze({
    policyVersion: row["policyVersion"],
    principalId: row["principalId"],
    tenantGrants: Object.freeze(
      row["tenantGrants"].map((grant) => {
        const item = object(
          grant,
          [
            "allowedWorkloadProfiles",
            "maximumCpuMillis",
            "maximumMemoryMiB",
            "permissions",
            "tenantId",
          ],
          "production_authorization_config_invalid",
        );
        if (
          typeof item["tenantId"] !== "string" ||
          !text.test(item["tenantId"]) ||
          !Array.isArray(item["permissions"]) ||
          item["permissions"].length < 1 ||
          !Array.isArray(item["allowedWorkloadProfiles"]) ||
          typeof item["maximumCpuMillis"] !== "number" ||
          !Number.isSafeInteger(item["maximumCpuMillis"]) ||
          item["maximumCpuMillis"] < 1 ||
          typeof item["maximumMemoryMiB"] !== "number" ||
          !Number.isSafeInteger(item["maximumMemoryMiB"]) ||
          item["maximumMemoryMiB"] < 1
        )
          throw new ProductionServerConfigurationError(
            "production_authorization_config_invalid",
          );
        return Object.freeze({
          allowedWorkloadProfiles: new Set(
            item["allowedWorkloadProfiles"] as string[],
          ),
          maximumCpuMillis: item["maximumCpuMillis"],
          maximumMemoryMiB: item["maximumMemoryMiB"],
          permissions: new Set(item["permissions"] as ApiPermission[]),
          tenantId: item["tenantId"],
        });
      }),
    ),
  });
}

export function validateProductionServerConfig(
  value: unknown,
): ProductionServerConfig {
  const row = object(
    value,
    [
      "authorizationPolicies",
      "capabilityReceipt",
      "capacity",
      "compatibilityManifestDigest",
      "identityBindings",
      "namespaceId",
      "network",
      "schemaVersion",
      "trustedCapabilitySigners",
      "writer",
    ],
    "production_server_config_invalid",
  );
  if (
    row["schemaVersion"] !== 1 ||
    typeof row["namespaceId"] !== "string" ||
    !text.test(row["namespaceId"]) ||
    typeof row["compatibilityManifestDigest"] !== "string" ||
    !digest.test(row["compatibilityManifestDigest"]) ||
    !Array.isArray(row["identityBindings"]) ||
    row["identityBindings"].length < 1 ||
    row["identityBindings"].length > 1024 ||
    !Array.isArray(row["authorizationPolicies"]) ||
    row["authorizationPolicies"].length < 1 ||
    row["authorizationPolicies"].length > 1024 ||
    !Array.isArray(row["trustedCapabilitySigners"]) ||
    row["trustedCapabilitySigners"].length < 1 ||
    row["trustedCapabilitySigners"].length > 16
  )
    throw new ProductionServerConfigurationError(
      "production_server_config_invalid",
    );
  const network = object(
    row["network"],
    [
      "drainTimeoutMs",
      "headersTimeoutMs",
      "host",
      "keepAliveTimeoutMs",
      "maxConnections",
      "maxRequestBytes",
      "port",
      "requestTimeoutMs",
      "tls",
    ],
    "production_network_config_invalid",
  );
  const tls = object(
    network["tls"],
    ["certificate", "certificateAuthority", "privateKey"],
    "production_tls_config_invalid",
  );
  const capacity = object(
    row["capacity"],
    ["capacityId", "totalCpuMillis", "totalMemoryMiB"],
    "production_capacity_config_invalid",
  );
  const writer = object(
    row["writer"],
    ["writerEpoch", "writerId"],
    "production_writer_config_invalid",
  );
  if (
    typeof network["host"] !== "string" ||
    network["host"].length < 1 ||
    network["host"].length > 253 ||
    /[\p{Cc}\s/]/u.test(network["host"])
  )
    throw new ProductionServerConfigurationError(
      "production_network_config_invalid",
    );
  const identityBindings = Object.freeze(
    row["identityBindings"].map(parseIdentity),
  );
  const authorizationPolicies = Object.freeze(
    row["authorizationPolicies"].map(parsePolicy),
  );
  try {
    createAuthorizationService(authorizationPolicies);
  } catch {
    throw new ProductionServerConfigurationError(
      "production_authorization_config_invalid",
    );
  }
  if (
    new Set(identityBindings.map((item) => item.credentialId)).size !==
      identityBindings.length ||
    new Set(identityBindings.map((item) => item.certificateFingerprint))
      .size !== identityBindings.length ||
    identityBindings.some(
      (binding) =>
        !authorizationPolicies.some(
          (policy) => policy.principalId === binding.principalId,
        ),
    )
  )
    throw new ProductionServerConfigurationError(
      "production_identity_config_invalid",
    );
  const signers = new Map<string, string>();
  for (const value of row["trustedCapabilitySigners"]) {
    const signer = object(
      value,
      ["keyId", "publicKey"],
      "production_capability_signer_invalid",
    );
    if (
      typeof signer["keyId"] !== "string" ||
      !text.test(signer["keyId"]) ||
      signers.has(signer["keyId"]) ||
      typeof signer["publicKey"] !== "string"
    )
      throw new ProductionServerConfigurationError(
        "production_capability_signer_invalid",
      );
    signers.set(signer["keyId"], pem(signer["publicKey"], "PUBLIC KEY"));
  }
  return Object.freeze({
    authorizationPolicies,
    capabilityReceipt: row["capabilityReceipt"],
    capacity: Object.freeze({
      capacityId:
        typeof capacity["capacityId"] === "string" &&
        text.test(capacity["capacityId"])
          ? capacity["capacityId"]
          : (() => {
              throw new ProductionServerConfigurationError(
                "production_capacity_config_invalid",
              );
            })(),
      totalCpuMillis: integer(
        capacity["totalCpuMillis"],
        1,
        1_000_000_000,
        "production_capacity_config_invalid",
      ),
      totalMemoryMiB: integer(
        capacity["totalMemoryMiB"],
        1,
        1_000_000_000,
        "production_capacity_config_invalid",
      ),
    }),
    compatibilityManifestDigest: row["compatibilityManifestDigest"],
    identityBindings,
    namespaceId: row["namespaceId"],
    network: Object.freeze({
      drainTimeoutMs: integer(
        network["drainTimeoutMs"],
        100,
        60_000,
        "production_network_config_invalid",
      ),
      headersTimeoutMs: integer(
        network["headersTimeoutMs"],
        100,
        60_000,
        "production_network_config_invalid",
      ),
      host: network["host"],
      keepAliveTimeoutMs: integer(
        network["keepAliveTimeoutMs"],
        100,
        60_000,
        "production_network_config_invalid",
      ),
      maxConnections: integer(
        network["maxConnections"],
        1,
        10_000,
        "production_network_config_invalid",
      ),
      maxRequestBytes: integer(
        network["maxRequestBytes"],
        1024,
        1_048_576,
        "production_network_config_invalid",
      ),
      port: integer(
        network["port"],
        1,
        65_535,
        "production_network_config_invalid",
      ),
      requestTimeoutMs: integer(
        network["requestTimeoutMs"],
        100,
        300_000,
        "production_network_config_invalid",
      ),
      tls: Object.freeze({
        certificate: pem(tls["certificate"], "CERTIFICATE"),
        certificateAuthority: pem(tls["certificateAuthority"], "CERTIFICATE"),
        privateKey:
          typeof tls["privateKey"] === "string" &&
          tls["privateKey"].includes("BEGIN PRIVATE KEY")
            ? pem(tls["privateKey"], "PRIVATE KEY")
            : pem(tls["privateKey"], "EC PRIVATE KEY"),
      }),
    }),
    schemaVersion: 1,
    trustedCapabilitySigners: signers,
    writer: Object.freeze({
      writerEpoch: integer(
        writer["writerEpoch"],
        1,
        Number.MAX_SAFE_INTEGER,
        "production_writer_config_invalid",
      ),
      writerId:
        typeof writer["writerId"] === "string" && text.test(writer["writerId"])
          ? writer["writerId"]
          : (() => {
              throw new ProductionServerConfigurationError(
                "production_writer_config_invalid",
              );
            })(),
    }),
  });
}

function stable(value: unknown): string {
  if (value === undefined)
    throw new ProductionServerConfigurationError(
      "production_config_digest_invalid",
    );
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (value instanceof Set) return stable([...value].sort());
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stable(record[key])}`)
    .join(",")}}`;
}

export function productionDeploymentConfigDigest(
  config: ProductionServerConfig,
  databaseDescriptor: Readonly<Record<string, unknown>>,
): string {
  const descriptor = {
    authorizationPolicies: config.authorizationPolicies,
    capacity: config.capacity,
    compatibilityManifestDigest: config.compatibilityManifestDigest,
    database: databaseDescriptor,
    identityBindings: config.identityBindings,
    namespaceId: config.namespaceId,
    network: {
      ...config.network,
      tls: {
        certificateAuthorityDigest: createHash("sha256")
          .update(config.network.tls.certificateAuthority)
          .digest("hex"),
        certificateDigest: createHash("sha256")
          .update(config.network.tls.certificate)
          .digest("hex"),
      },
    },
    profileId: "control-postgres",
    schemaVersion: 1,
    trustedCapabilitySigners: [...config.trustedCapabilitySigners]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([keyId, publicKey]) => ({
        keyId,
        publicKeyDigest: createHash("sha256").update(publicKey).digest("hex"),
      })),
    writer: config.writer,
  };
  return createHash("sha256").update(stable(descriptor)).digest("hex");
}
