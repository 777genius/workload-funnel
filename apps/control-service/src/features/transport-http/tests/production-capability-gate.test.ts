import { generateKeyPairSync, sign } from "node:crypto";
import { EventEmitter } from "node:events";
import type { Server, ServerOptions } from "node:https";

import { describe, expect, it, vi } from "vitest";

import {
  createProductionNetworkService,
  installProductionSignalHandlers,
  productionCapabilitySigningPayload,
  productionDeploymentConfigDigest,
  validateProductionServerConfig,
  verifyProductionCapabilityReceipt,
  type ProductionCapabilityReceipt,
} from "../index.js";

const certificate = `-----BEGIN CERTIFICATE-----\n${"A".repeat(96)}\n-----END CERTIFICATE-----`;
const privateKey = generateKeyPairSync("ed25519")
  .privateKey.export({ format: "pem", type: "pkcs8" })
  .toString();
const fingerprint = Array.from({ length: 32 }, () => "AA").join(":");

function rawConfig(publicKey: string, capabilityReceipt: unknown = {}) {
  return {
    authorizationPolicies: [
      {
        policyVersion: 1,
        principalId: "principal-1",
        tenantGrants: [
          {
            allowedWorkloadProfiles: ["trusted-production-v1"],
            maximumCpuMillis: 1000,
            maximumMemoryMiB: 2048,
            permissions: [
              "workload.submit",
              "workload.observe",
              "workload.cancel",
              "operation.observe",
            ],
            tenantId: "tenant-1",
          },
        ],
      },
    ],
    capabilityReceipt,
    capacity: {
      capacityId: "pool-1",
      totalCpuMillis: 4000,
      totalMemoryMiB: 8192,
    },
    compatibilityManifestDigest: "c".repeat(64),
    identityBindings: [
      {
        certificateFingerprint: fingerprint,
        credentialId: "credential-1",
        principalId: "principal-1",
      },
    ],
    namespaceId: "namespace-1",
    network: {
      drainTimeoutMs: 100,
      headersTimeoutMs: 1000,
      host: "127.0.0.1",
      keepAliveTimeoutMs: 1000,
      maxConnections: 10,
      maxRequestBytes: 65536,
      port: 9443,
      requestTimeoutMs: 1000,
      tls: {
        certificate,
        certificateAuthority: certificate,
        privateKey,
      },
    },
    schemaVersion: 1,
    trustedCapabilitySigners: [{ keyId: "production-signer-1", publicKey }],
    writer: { writerEpoch: 7, writerId: "control-writer-1" },
  };
}

describe("production capability receipt", () => {
  it("enables only an exact, fresh, config-bound signed dependency set", () => {
    const { privateKey: signer, publicKey } = generateKeyPairSync("ed25519");
    const publicKeyPem = publicKey
      .export({ format: "pem", type: "spki" })
      .toString();
    const config = validateProductionServerConfig(rawConfig(publicKeyPem));
    const configDigest = productionDeploymentConfigDigest(config, {
      database: "wf_control",
      schema: "wf_control",
    });
    const now = 10_000;
    const unsigned: Omit<ProductionCapabilityReceipt, "signatureBase64Url"> = {
      compatibilityManifestDigest: config.compatibilityManifestDigest,
      configDigest,
      dependencies: Object.freeze(
        ["capability-a", "capability-b"].map((capability) =>
          Object.freeze({
            capability,
            configurationDigest: "d".repeat(64),
            contractVersion: "contract-v1",
            evidenceDigest: "e".repeat(64),
            notAfter: now + 1000,
            providerId: `provider-${capability}`,
            verifiedAt: now - 10,
          }),
        ),
      ),
      issuedAt: now - 20,
      notAfter: now + 1000,
      notBefore: now - 20,
      profileId: "control-postgres",
      schemaVersion: 1,
      signerKeyId: "production-signer-1",
    };
    const receipt = Object.freeze({
      ...unsigned,
      signatureBase64Url: sign(
        null,
        Buffer.from(productionCapabilitySigningPayload(unsigned)),
        signer,
      ).toString("base64url"),
    });
    const verified = verifyProductionCapabilityReceipt({
      expectedCompatibilityManifestDigest: config.compatibilityManifestDigest,
      expectedConfigDigest: configDigest,
      now,
      receipt,
      requiredCapabilities: ["capability-a", "capability-b"],
      trustedSignerPublicKeys: config.trustedCapabilitySigners,
    });

    expect(verified.verified).toBe(true);
    expect(() =>
      verifyProductionCapabilityReceipt({
        expectedCompatibilityManifestDigest: config.compatibilityManifestDigest,
        expectedConfigDigest: "f".repeat(64),
        now,
        receipt,
        requiredCapabilities: ["capability-a", "capability-b"],
        trustedSignerPublicKeys: config.trustedCapabilitySigners,
      }),
    ).toThrow("production_capability_gate_rejected");
    expect(() =>
      verifyProductionCapabilityReceipt({
        expectedCompatibilityManifestDigest: config.compatibilityManifestDigest,
        expectedConfigDigest: configDigest,
        now: now + 1000,
        receipt,
        requiredCapabilities: ["capability-a", "capability-b"],
        trustedSignerPublicKeys: config.trustedCapabilitySigners,
      }),
    ).toThrow("production_capability_gate_rejected");
  });

  it("rejects an identity-free or non-mTLS production configuration", () => {
    const { publicKey } = generateKeyPairSync("ed25519");
    const publicKeyPem = publicKey
      .export({ format: "pem", type: "spki" })
      .toString();
    expect(() =>
      validateProductionServerConfig({
        ...rawConfig(publicKeyPem),
        identityBindings: [],
      }),
    ).toThrow("production_server_config_invalid");
    expect(() =>
      validateProductionServerConfig({
        ...rawConfig(publicKeyPem),
        identityBindings: [
          {
            bearerTokenSha256: "a".repeat(64),
            credentialId: "credential-1",
            principalId: "principal-1",
          },
        ],
      }),
    ).toThrow("production_identity_config_invalid");
    const invalidAuthorization = rawConfig(publicKeyPem);
    const [policy] = invalidAuthorization.authorizationPolicies;
    const [grant] = policy?.tenantGrants ?? [];
    if (grant === undefined)
      throw new Error("test_authorization_grant_missing");
    grant.permissions = ["unbounded.root"];
    expect(() => validateProductionServerConfig(invalidAuthorization)).toThrow(
      "production_authorization_config_invalid",
    );
  });
});

class FakeHttpsServer extends EventEmitter {
  public headersTimeout = 0;
  public keepAliveTimeout = 0;
  public maxConnections = 0;
  public requestTimeout = 0;
  public readonly closeAllConnections = vi.fn();
  public readonly closeIdleConnections = vi.fn();
  public closeCallback: (() => void) | undefined;

  public listen(): this {
    queueMicrotask(() => this.emit("listening"));
    return this;
  }

  public close(callback?: () => void): this {
    this.closeCallback = callback;
    return this;
  }
}

describe("production network shutdown", () => {
  it("becomes unready, closes idle connections, and closes idempotently", async () => {
    const { publicKey } = generateKeyPairSync("ed25519");
    const config = validateProductionServerConfig(
      rawConfig(publicKey.export({ format: "pem", type: "spki" }).toString()),
    );
    const fake = new FakeHttpsServer();
    let serverOptions: ServerOptions | undefined;
    const service = createProductionNetworkService({
      config,
      dependencyHealth: () => Promise.resolve(true),
      operations: {
        cancel: () => Promise.resolve({}),
        operation: () => Promise.resolve(undefined),
        status: () => Promise.resolve(undefined),
        submit: () => Promise.resolve({}),
      },
      serverFactory: (options) => {
        serverOptions = options;
        return fake as unknown as Server;
      },
    });

    expect(serverOptions).toMatchObject({
      minVersion: "TLSv1.2",
      rejectUnauthorized: true,
      requestCert: true,
    });

    await expect(service.listen()).resolves.toEqual({
      host: "127.0.0.1",
      port: 9443,
    });
    await expect(service.readiness()).resolves.toBe("ready");
    fake.emit("error", new Error("synthetic_listener_failure"));
    expect(service.liveness()).toBe("failed");
    await expect(service.readiness()).resolves.toBe("not_ready");
    const first = service.close();
    await Promise.resolve();
    expect(fake.closeIdleConnections).toHaveBeenCalledOnce();
    await expect(service.readiness()).resolves.toBe("not_ready");
    fake.closeCallback?.();
    await first;
    await expect(service.close()).resolves.toBeUndefined();
    expect(service.liveness()).toBe("failed");
  });

  it("uses one close path for repeated process signals", async () => {
    const target = new EventEmitter();
    const close = vi.fn(() => Promise.resolve());
    const remove = installProductionSignalHandlers(
      { close },
      target as unknown as Pick<NodeJS.Process, "once" | "off">,
    );
    target.emit("SIGTERM");
    target.emit("SIGINT");
    await Promise.resolve();
    expect(close).toHaveBeenCalledOnce();
    remove();
  });
});
