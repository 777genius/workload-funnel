import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  createPostgresServiceIdentityAuthorityStore,
  type PostgresServiceIdentityAuthorityDriver,
} from "../adapters/postgres-service-identity-authority-store.js";
import type {
  NodeMessageReplayCursor,
  ServiceIdentityOperationReceipt,
  ServiceIdentityRecord,
} from "../index.js";

interface Row {
  readonly key: string;
  readonly version: number;
  readonly payload: string;
}

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { force: true, recursive: true });
});

class DurableIdentityPostgresPortFixture implements PostgresServiceIdentityAuthorityDriver {
  public readonly capabilities = Object.freeze({
    backend: "postgres",
    crashSafe: true,
    multiWriter: true,
    serializableTransactions: true,
  });
  readonly #database: DatabaseSync;

  public constructor(path: string) {
    this.#database = new DatabaseSync(path);
    this.#database.exec("PRAGMA journal_mode=WAL");
    this.#database.exec("PRAGMA synchronous=FULL");
    this.#database.exec(`
      CREATE TABLE IF NOT EXISTS identity_port_row (
        bucket TEXT NOT NULL,
        key TEXT NOT NULL,
        version INTEGER NOT NULL,
        payload TEXT NOT NULL,
        PRIMARY KEY (bucket, key)
      ) STRICT;
    `);
  }

  public close(): void {
    this.#database.close();
  }

  public migrate(statements: readonly string[]): void {
    if (statements.length < 1) throw new Error("identity_migration_missing");
  }

  public transaction<T>(callback: () => T): T {
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      const result = callback();
      this.#database.exec("COMMIT");
      return result;
    } catch (error) {
      this.#database.exec("ROLLBACK");
      throw error;
    }
  }

  public getIdentity(identityId: string): ServiceIdentityRecord | undefined {
    return this.read("identity", identityId) as
      | ServiceIdentityRecord
      | undefined;
  }

  public insertIdentity(
    identity: ServiceIdentityRecord,
  ):
    | "inserted"
    | "identity_conflict"
    | "node_conflict"
    | "credential_conflict" {
    if (this.getIdentity(identity.identityId) !== undefined)
      return "identity_conflict";
    const existing = this.list("identity") as readonly ServiceIdentityRecord[];
    if (
      existing.some(
        (candidate) =>
          identity.nodeId !== undefined && candidate.nodeId === identity.nodeId,
      )
    )
      return "node_conflict";
    if (
      existing.some((candidate) =>
        credentialKeys(candidate).some((value) =>
          credentialKeys(identity).includes(value),
        ),
      )
    )
      return "credential_conflict";
    this.insert("identity", identity.identityId, identity.version, identity);
    return "inserted";
  }

  public compareAndSetIdentity(
    expectedVersion: number,
    identity: ServiceIdentityRecord,
  ): "updated" | "version_conflict" | "credential_conflict" {
    const conflict = (this.list("identity") as readonly ServiceIdentityRecord[])
      .filter((candidate) => candidate.identityId !== identity.identityId)
      .some((candidate) =>
        credentialKeys(candidate).some((value) =>
          credentialKeys(identity).includes(value),
        ),
      );
    if (conflict) return "credential_conflict";
    return this.compareAndSet(
      "identity",
      identity.identityId,
      expectedVersion,
      identity.version,
      identity,
    )
      ? "updated"
      : "version_conflict";
  }

  public getOperation(
    operationId: string,
  ): ServiceIdentityOperationReceipt | undefined {
    return this.read("operation", operationId) as
      | ServiceIdentityOperationReceipt
      | undefined;
  }

  public insertOperation(receipt: ServiceIdentityOperationReceipt): boolean {
    return this.insert(
      "operation",
      receipt.operationId,
      receipt.identityVersion,
      receipt,
    );
  }

  public getCursor(credentialId: string): NodeMessageReplayCursor | undefined {
    return this.read("cursor", credentialId) as
      | NodeMessageReplayCursor
      | undefined;
  }

  public compareAndSetCursor(
    expectedVersion: number,
    cursor: NodeMessageReplayCursor,
  ): boolean {
    return expectedVersion === 0
      ? this.insert("cursor", cursor.credentialId, cursor.version, cursor)
      : this.compareAndSet(
          "cursor",
          cursor.credentialId,
          expectedVersion,
          cursor.version,
          cursor,
        );
  }

  private read(bucket: string, key: string): unknown {
    const row = this.#database
      .prepare(
        "SELECT key, version, payload FROM identity_port_row WHERE bucket = ? AND key = ?",
      )
      .get(bucket, key) as Row | undefined;
    return row === undefined ? undefined : (JSON.parse(row.payload) as unknown);
  }

  private list(bucket: string): readonly unknown[] {
    return (
      this.#database
        .prepare(
          "SELECT payload FROM identity_port_row WHERE bucket = ? ORDER BY key",
        )
        .all(bucket) as unknown as readonly Pick<Row, "payload">[]
    ).map((row) => JSON.parse(row.payload) as unknown);
  }

  private insert(
    bucket: string,
    key: string,
    version: number,
    value: unknown,
  ): boolean {
    return (
      this.#database
        .prepare(
          "INSERT INTO identity_port_row (bucket, key, version, payload) VALUES (?, ?, ?, ?) ON CONFLICT(bucket, key) DO NOTHING",
        )
        .run(bucket, key, version, JSON.stringify(value)).changes === 1
    );
  }

  private compareAndSet(
    bucket: string,
    key: string,
    expectedVersion: number,
    version: number,
    value: unknown,
  ): boolean {
    return (
      this.#database
        .prepare(
          "UPDATE identity_port_row SET version = ?, payload = ? WHERE bucket = ? AND key = ? AND version = ?",
        )
        .run(version, JSON.stringify(value), bucket, key, expectedVersion)
        .changes === 1
    );
  }
}

function credentialKeys(identity: ServiceIdentityRecord): readonly string[] {
  return identity.credentials.flatMap((credential) => [
    credential.credentialId,
    credential.certificateFingerprint,
    credential.certificateSerial,
  ]);
}

function identity(
  identityId: string,
  nodeId: string,
  credentialId: string,
): ServiceIdentityRecord {
  return Object.freeze({
    audience: "workload-funnel-node",
    bootEpochGeneration: 1,
    credentials: Object.freeze([
      Object.freeze({
        certificateFingerprint: `fingerprint-${credentialId}`,
        certificateSerial: `serial-${credentialId}`,
        credentialId,
        generation: 1,
        issuedAt: 1,
        notAfter: 1000,
      }),
    ]),
    currentBootEpoch: `${nodeId}:boot:1`,
    currentCredentialId: credentialId,
    enrollmentCredentialFingerprint: `fingerprint-${credentialId}`,
    enrollmentProofDigest: "a".repeat(64),
    identityId,
    kind: "node-agent",
    nodeId,
    permissions: Object.freeze(["node.capacity.publish"] as const),
    revocationRevision: 0,
    state: "active",
    version: 1,
  });
}

function operation(
  operationId: string,
  identityId: string,
): ServiceIdentityOperationReceipt {
  return Object.freeze({
    actorPrincipalId: "enrollment-controller",
    authorizationEvidenceDigest: "b".repeat(64),
    identityId,
    identityVersion: 1,
    operationFingerprint: "c".repeat(64),
    operationId,
    outcome: "enrollment_requested",
  });
}

describe("Phase 8 durable Postgres identity port restart", () => {
  it("reopens bindings and rejects a duplicate node or credential", () => {
    const root = mkdtempSync(join(tmpdir(), "wf-phase8-postgres-identity-"));
    roots.push(root);
    const path = join(root, "identity-port.sqlite");
    let driver = new DurableIdentityPostgresPortFixture(path);
    let store = createPostgresServiceIdentityAuthorityStore(driver);
    const first = identity("identity-1", "node-1", "credential-1");
    store.create(first, operation("enroll-1", first.identityId));
    driver.close();

    driver = new DurableIdentityPostgresPortFixture(path);
    store = createPostgresServiceIdentityAuthorityStore(driver);
    expect(store.get(first.identityId)).toEqual(first);
    expect(() =>
      store.create(
        identity("identity-2", "node-1", "credential-2"),
        operation("enroll-2", "identity-2"),
      ),
    ).toThrow("node_identity_already_bound");
    expect(() =>
      store.create(
        identity("identity-3", "node-3", "credential-1"),
        operation("enroll-3", "identity-3"),
      ),
    ).toThrow("credential_identity_reused");
    driver.close();
  });
});
