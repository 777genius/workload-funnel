import { createHash, generateKeyPairSync, sign, verify } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { openSqliteNodePersistence } from "@workload-funnel/store-sqlite/node-persistence";

import {
  createNodeMaintenanceService,
  registerNode,
  type NodeExecutionDrainObservation,
  type NodeExecutionDrainProof,
  type NodeExecutionInventoryReceipt,
  type NodeMaintenanceClaim,
  type NodeMaintenanceEnvironment,
} from "../index.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { force: true, recursive: true });
});

const pressurePolicy = Object.freeze({
  criticalThreshold: 0.9,
  healthyObservationsToRecover: 2,
  highObservationsToPause: 2,
  highThreshold: 0.7,
  softThreshold: 0.4,
});

function databasePath(): string {
  const root = mkdtempSync(join(tmpdir(), "wf-phase8-maintenance-"));
  roots.push(root);
  return join(root, "maintenance.sqlite");
}

function node() {
  return registerNode({
    bootEpoch: "node-1:boot:1",
    capabilities: ["synthetic_execution"],
    nodeId: "node-1",
    observation: {
      bootEpoch: "node-1:boot:1",
      capacity: { cpuMillis: 4000, memoryMiB: 4096 },
      observedAt: 10,
      pressure: {
        cpuPsiSome: 0,
        ioPsiSome: 0,
        memoryPsiSome: 0,
        sensorState: "healthy" as const,
      },
      sourceSequence: 1,
    },
    poolId: "pool-1",
    pressurePolicy,
  });
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object")
    return `{${Object.entries(value)
      .filter(([key]) => key !== "signatureBase64Url")
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`)
      .join(",")}}`;
  return JSON.stringify(value);
}

function digest(value: unknown): string {
  return createHash("sha256").update(canonical(value)).digest("hex");
}

const keys = generateKeyPairSync("ed25519");

function proof(sequence: number): NodeExecutionDrainProof {
  const unsigned = {
    allocationId: "allocation-1",
    durableSequence: sequence,
    evidenceDigest: digest(`absence-${String(sequence)}`),
    executionGeneration: "generation-1",
    executionId: "execution-1",
    issuedAt: 1,
    nodeBootEpoch: "node-1:boot:1",
    notAfter: 1000,
    proofId: `absence-proof-${String(sequence)}`,
    proofKind: "signed_absence" as const,
    signerKeyId: "maintenance-evidence-key",
  };
  return Object.freeze({
    ...unsigned,
    signatureBase64Url: sign(
      null,
      Buffer.from(canonical(unsigned)),
      keys.privateKey,
    ).toString("base64url"),
  });
}

function observation(
  state: NodeExecutionDrainObservation["state"],
  sequence: number,
): NodeExecutionDrainObservation {
  return Object.freeze({
    allocationId: "allocation-1",
    executionGeneration: "generation-1",
    executionId: "execution-1",
    nodeBootEpoch: "node-1:boot:1",
    observedSequence: sequence,
    ...(state === "proven_absent" ? { proof: proof(sequence) } : {}),
    state,
  });
}

function inventory(
  revision: number,
  executions: readonly NodeExecutionDrainObservation[],
): NodeExecutionInventoryReceipt {
  const unsigned = {
    complete: true as const,
    durable: true as const,
    evidenceDigest: digest({ executions, revision }),
    executions,
    inventoryRevision: revision,
    issuedAt: 1,
    nodeBootEpoch: "node-1:boot:1",
    nodeId: "node-1",
    notAfter: 1000,
    receiptId: `inventory-${String(revision)}`,
    signerKeyId: "maintenance-evidence-key",
  };
  return Object.freeze({
    ...unsigned,
    signatureBase64Url: sign(
      null,
      Buffer.from(canonical(unsigned)),
      keys.privateKey,
    ).toString("base64url"),
  });
}

function verifySigned(
  value: Readonly<{ signatureBase64Url: string }>,
): boolean {
  return verify(
    null,
    Buffer.from(canonical(value)),
    keys.publicKey,
    Buffer.from(value.signatureBase64Url, "base64url"),
  );
}

function claim(value: NodeMaintenanceClaim | undefined): NodeMaintenanceClaim {
  if (value === undefined) throw new Error("claim_missing");
  return value;
}

describe("Phase 8 crash-safe node drain and reboot", () => {
  it("retains prior identities across SQLite reopen and refuses transient empty inventory", () => {
    const path = databasePath();
    let currentInventory = inventory(1, [observation("active", 1)]);
    const stops: string[] = [];
    const reboots: string[] = [];
    const environment: NodeMaintenanceEnvironment = {
      inventory: () => currentInventory,
      requestReboot(input) {
        reboots.push(input.operationId);
        return digest(input);
      },
      requestStop(input) {
        stops.push(input.execution.executionId);
        return digest(input);
      },
      verifyDrainProof: (value) =>
        value.proof !== undefined && verifySigned(value.proof),
      verifyInventoryReceipt: (value) => verifySigned(value),
    };

    let opened = openSqliteNodePersistence(path);
    opened.nodes.create(node());
    let service = createNodeMaintenanceService(
      opened.nodes,
      opened.maintenance,
      environment,
    );
    service.begin({
      kind: "reboot",
      nodeId: "node-1",
      operationId: "maintenance-1",
      reason: "synthetic-reopen",
      requestedBy: "operator-1",
    });
    const firstClaim = claim(
      service.claim("maintenance-1", "controller-a", 0, 10, 100).claim,
    );
    expect(service.resume("maintenance-1", firstClaim, 11).step).toBe(
      "cordoned",
    );
    expect(service.resume("maintenance-1", firstClaim, 12)).toMatchObject({
      pendingExecutionIds: ["execution-1"],
      retainedExecutions: [
        expect.objectContaining({ executionId: "execution-1" }),
      ],
      step: "drain_requested",
    });
    expect(stops).toEqual(["execution-1"]);
    opened.close();

    opened = openSqliteNodePersistence(path);
    service = createNodeMaintenanceService(
      opened.nodes,
      opened.maintenance,
      environment,
    );
    currentInventory = inventory(2, []);
    expect(service.resume("maintenance-1", firstClaim, 13)).toMatchObject({
      pendingExecutionIds: ["execution-1"],
      step: "waiting_for_quiescence",
    });
    currentInventory = inventory(3, [observation("proven_absent", 3)]);
    expect(service.resume("maintenance-1", firstClaim, 14).step).toBe(
      "drained",
    );
    expect(service.resume("maintenance-1", firstClaim, 15).step).toBe(
      "reboot_requested",
    );
    expect(reboots).toEqual(["maintenance-1"]);
    expect(
      service.recordReboot({
        claim: firstClaim,
        now: 16,
        observation: {
          bootEpoch: "node-1:boot:2",
          capacity: { cpuMillis: 4000, memoryMiB: 4096 },
          observedAt: 16,
          pressure: {
            cpuPsiSome: 0,
            ioPsiSome: 0,
            memoryPsiSome: 0,
            sensorState: "healthy",
          },
          sourceSequence: 1,
        },
        operationId: "maintenance-1",
        pressurePolicy,
      }).step,
    ).toBe("reboot_observed");
    currentInventory = inventory(4, [observation("proven_absent", 4)]);
    expect(service.resume("maintenance-1", firstClaim, 17).step).toBe(
      "completed",
    );
    opened.close();
  });

  it("requires two distinct authoritative receipts before accepting a genuinely empty drain", () => {
    const opened = openSqliteNodePersistence(databasePath());
    opened.nodes.create(node());
    let currentInventory = inventory(10, []);
    const environment: NodeMaintenanceEnvironment = {
      inventory: () => currentInventory,
      requestReboot: () => "not-called",
      requestStop: () => "not-called",
      verifyDrainProof: () => false,
      verifyInventoryReceipt: (value) => verifySigned(value),
    };
    const service = createNodeMaintenanceService(
      opened.nodes,
      opened.maintenance,
      environment,
    );
    service.begin({
      kind: "drain",
      nodeId: "node-1",
      operationId: "empty-drain",
      reason: "synthetic-empty",
      requestedBy: "operator-1",
    });
    const currentClaim = claim(
      service.claim("empty-drain", "controller-a", 0, 1, 100).claim,
    );
    service.resume("empty-drain", currentClaim, 2);
    service.resume("empty-drain", currentClaim, 3);
    expect(service.resume("empty-drain", currentClaim, 4).step).toBe(
      "waiting_for_quiescence",
    );
    expect(service.resume("empty-drain", currentClaim, 5).step).toBe(
      "waiting_for_quiescence",
    );
    currentInventory = inventory(11, []);
    expect(service.resume("empty-drain", currentClaim, 6).step).toBe("drained");
    opened.close();
  });
});
