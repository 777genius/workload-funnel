import { createHash, generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { readFile } from "node:fs/promises";

import { afterEach, describe, expect, it } from "vitest";

import { createAsyncPostgresNamespaceOwnershipStore } from "@workload-funnel/store-postgres/namespace-ownership-persistence";
import { createPostgresLifecycleDatabase } from "@workload-funnel/store-postgres/workload-persistence";

import {
  createControlService,
  migrateControlServiceDatabase,
  requiredProductionCapabilities,
} from "../../../generated/composition.control-postgres.js";
import {
  productionCapabilitySigningPayload,
  productionDeploymentConfigDigest,
  validateProductionServerConfig,
  type ProductionCapabilityReceipt,
} from "../index.js";

const connectionString = process.env["WF_CONTROL_POSTGRES_TEST_URL"];
const certificatePath = process.env["WF_CONTROL_POSTGRES_TEST_TLS_CERT_PATH"];
const privateKeyPath = process.env["WF_CONTROL_POSTGRES_TEST_TLS_KEY_PATH"];
const networkPortText = process.env["WF_CONTROL_SERVER_TEST_PORT"];
const describeProduction =
  connectionString === undefined ||
  certificatePath === undefined ||
  privateKeyPath === undefined ||
  networkPortText === undefined
    ? describe.skip
    : describe;
const databases: ReturnType<typeof createPostgresLifecycleDatabase>[] = [];
const schemas = new Set<string>();

function connection() {
  if (connectionString === undefined)
    throw new Error("postgres_integration_url_missing");
  const url = new URL(connectionString);
  const database = decodeURIComponent(url.pathname.slice(1));
  const port = Number(url.port);
  if (
    (url.protocol !== "postgres:" && url.protocol !== "postgresql:") ||
    !/^wf_control_test_[a-z0-9_]{1,40}$/u.test(database) ||
    url.hostname.length === 0 ||
    !Number.isSafeInteger(port) ||
    port < 1 ||
    port > 65_535 ||
    url.username.length === 0 ||
    url.password.length === 0 ||
    url.search.length !== 0 ||
    url.hash.length !== 0
  )
    throw new Error("postgres_integration_url_unsafe");
  return Object.freeze({
    database,
    host: url.hostname,
    password: decodeURIComponent(url.password),
    port,
    user: decodeURIComponent(url.username),
  });
}

function networkPort(): number {
  const value = Number(networkPortText);
  if (!Number.isSafeInteger(value) || value < 1 || value > 65_535)
    throw new Error("control_service_integration_port_unsafe");
  return value;
}

function databaseConfig(schema: string, certificateAuthority: string) {
  const value = connection();
  return Object.freeze({
    applicationName: "workload-funnel-control-composition-it",
    connectionTimeoutMs: 1_000,
    database: value.database,
    host: value.host,
    idleTimeoutMs: 1_000,
    lockTimeoutMs: 1_000,
    maxConnections: 4,
    password: value.password,
    port: value.port,
    profile: "production" as const,
    queryTimeoutMs: 5_000,
    schema,
    schemaOwner: value.user,
    shutdownTimeoutMs: 2_000,
    statementTimeoutMs: 4_000,
    tls: Object.freeze({
      certificateAuthority,
      serverName: value.host,
    }),
    user: value.user,
  });
}

function databaseDescriptor(config: ReturnType<typeof databaseConfig>) {
  return Object.freeze({
    applicationName: config.applicationName,
    connectionTimeoutMs: config.connectionTimeoutMs,
    database: config.database,
    host: config.host,
    idleTimeoutMs: config.idleTimeoutMs,
    lockTimeoutMs: config.lockTimeoutMs,
    maxConnections: config.maxConnections,
    port: config.port,
    profile: config.profile,
    queryTimeoutMs: config.queryTimeoutMs,
    schema: config.schema,
    schemaOwner: config.schemaOwner,
    shutdownTimeoutMs: config.shutdownTimeoutMs,
    statementTimeoutMs: config.statementTimeoutMs,
    tlsCertificateAuthorityDigest: createHash("sha256")
      .update(config.tls.certificateAuthority)
      .digest("hex"),
    tlsServerName: config.tls.serverName,
    user: config.user,
  });
}

function openDatabase(config: ReturnType<typeof databaseConfig>) {
  const value = createPostgresLifecycleDatabase({ config });
  databases.push(value);
  return value;
}

afterEach(async () => {
  await Promise.allSettled(databases.splice(0).map((value) => value.close()));
  if (certificatePath === undefined) return;
  const certificate = await readFile(certificatePath, "utf8");
  for (const schema of schemas) {
    const cleanup = openDatabase(databaseConfig(schema, certificate));
    try {
      await cleanup.queryExecutor.transaction((client) =>
        client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`),
      );
    } finally {
      await cleanup.close();
      databases.splice(databases.indexOf(cleanup), 1);
    }
  }
  schemas.clear();
});

describeProduction("production control-service PostgreSQL composition", () => {
  it("starts only from a signed complete receipt and closes its real pool and listener", async () => {
    if (certificatePath === undefined || privateKeyPath === undefined)
      throw new Error("production_integration_tls_fixture_missing");
    const [certificate, privateKey] = await Promise.all([
      readFile(certificatePath, "utf8"),
      readFile(privateKeyPath, "utf8"),
    ]);
    const schema = `wf_control_composition_${randomUUID().replaceAll("-", "")}`;
    schemas.add(schema);
    const postgres = databaseConfig(schema, certificate);
    await migrateControlServiceDatabase(postgres);
    const bootstrap = openDatabase(postgres);
    const writer = Object.freeze({ writerEpoch: 7, writerId: "writer-1" });
    const fingerprint = Array.from({ length: 32 }, () => "AA").join(":");
    await bootstrap.close();

    const { privateKey: signerPrivateKey, publicKey: signerPublicKey } =
      generateKeyPairSync("ed25519");
    const rawServer = {
      authorizationPolicies: [
        {
          policyVersion: 1,
          principalId: "principal-1",
          tenantGrants: [
            {
              allowedWorkloadProfiles: ["trusted-synthetic-v1"],
              maximumCpuMillis: 1_000,
              maximumMemoryMiB: 2_048,
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
      capabilityReceipt: {},
      capacity: {
        capacityId: "capacity-1",
        totalCpuMillis: 4_000,
        totalMemoryMiB: 8_192,
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
        drainTimeoutMs: 1_000,
        headersTimeoutMs: 2_000,
        host: "127.0.0.1",
        keepAliveTimeoutMs: 1_000,
        maxConnections: 10,
        maxRequestBytes: 65_536,
        port: networkPort(),
        requestTimeoutMs: 2_000,
        tls: { certificate, certificateAuthority: certificate, privateKey },
      },
      schemaVersion: 1,
      trustedCapabilitySigners: [
        {
          keyId: "integration-signer-1",
          publicKey: signerPublicKey
            .export({ format: "pem", type: "spki" })
            .toString(),
        },
      ],
      writer,
    };
    const server = validateProductionServerConfig(rawServer);
    const configDigest = productionDeploymentConfigDigest(
      server,
      databaseDescriptor(postgres),
    );
    const now = Date.now();
    const unsigned: Omit<ProductionCapabilityReceipt, "signatureBase64Url"> = {
      compatibilityManifestDigest: server.compatibilityManifestDigest,
      configDigest,
      dependencies: Object.freeze(
        requiredProductionCapabilities.map((capability) =>
          Object.freeze({
            capability,
            configurationDigest: "d".repeat(64),
            contractVersion: "integration-contract-v1",
            evidenceDigest: "e".repeat(64),
            notAfter: now + 60_000,
            providerId: `integration-${capability}`,
            verifiedAt: now - 1_000,
          }),
        ),
      ),
      issuedAt: now - 1_000,
      notAfter: now + 60_000,
      notBefore: now - 1_000,
      profileId: "control-postgres",
      schemaVersion: 1,
      signerKeyId: "integration-signer-1",
    };
    const capabilityReceipt = Object.freeze({
      ...unsigned,
      signatureBase64Url: sign(
        null,
        Buffer.from(productionCapabilitySigningPayload(unsigned)),
        signerPrivateKey,
      ).toString("base64url"),
    });
    const options = Object.freeze({
      database: postgres,
      now: () => now,
      server: { ...rawServer, capabilityReceipt },
    });

    await expect(createControlService(options)).rejects.toThrow(
      "production_namespace_writer_fence_missing",
    );
    const writerProvisioning = openDatabase(postgres);
    await createAsyncPostgresNamespaceOwnershipStore(
      writerProvisioning.queryExecutor,
      schema,
    ).create({
      namespaceId: "namespace-1",
      payload: Object.freeze({ deployment: "production-composition-it" }),
      version: 1,
      ...writer,
    });
    await writerProvisioning.close();
    await expect(createControlService(options)).rejects.toThrow(
      "production_transport_identity_missing",
    );
    const identityProvisioning = openDatabase(postgres);
    await identityProvisioning.queryExecutor.transaction((client) =>
      client.query(
        `INSERT INTO ${schema}.control_service_identity
           (identity_id, identity_kind, credential_id,
            credential_fingerprint, state, version, payload)
         VALUES ($1, 'mtls-client', $2, $3, 'active', 1, '{}'::jsonb)`,
        ["principal-1", "credential-1", fingerprint],
      ),
    );
    await identityProvisioning.close();

    const service = await createControlService(options);
    try {
      expect(service.productionStartsEnabled).toBe(true);
      expect(service.migration.currentVersion).toBe(2);
      await expect(service.listen()).resolves.toEqual({
        host: "127.0.0.1",
        port: networkPort(),
      });
      await expect(service.readiness()).resolves.toBe("ready");
      const tamper = openDatabase(postgres);
      await tamper.queryExecutor.transaction((client) =>
        client.query(
          `UPDATE ${schema}.schema_migration SET checksum = $1 WHERE version = 2`,
          ["0".repeat(64)],
        ),
      );
      await expect(service.readiness()).resolves.toBe("not_ready");
      await tamper.close();
    } finally {
      await service.close();
    }
    await expect(service.close()).resolves.toBeUndefined();
    await expect(service.readiness()).resolves.toBe("not_ready");
  }, 20_000);
});
