import { describe, expect, it } from "vitest";

import { bearerTokenDigest } from "@workload-funnel/control-service/authentication";
import type { ApiPermission } from "@workload-funnel/control-service/authorization";

import { createControlService } from "../../../generated/composition.control-sqlite.js";

const permissions = new Set<ApiPermission>([
  "workload.submit",
  "workload.observe",
]);

describe("Phase 5 generated control-service composition", () => {
  it("constructs an authenticated public product flow without enabling privileged starts", () => {
    const token = "generated-composition-synthetic-token";
    const clock = () => 1_783_900_802_000;
    const control = createControlService();
    const api = control.createPublicApi({
      authorizationPolicies: [
        Object.freeze({
          policyVersion: 1,
          principalId: "synthetic-principal",
          tenantGrants: [
            Object.freeze({
              allowedWorkloadProfiles: new Set(["trusted-synthetic-v1"]),
              maximumCpuMillis: 1000,
              maximumMemoryMiB: 1024,
              permissions,
              tenantId: "synthetic-tenant",
            }),
          ],
        }),
      ],
      clock,
      cursorKeyset: {
        keys: [
          Object.freeze({
            keyId: "composition-cursor-key",
            notAfter: clock() + 60_000,
            notBefore: clock() - 1000,
            secret: new Uint8Array(32).fill(29),
            sign: true,
          }),
        ],
        keysetVersion: 1,
      },
      cursorTtlMs: 10_000,
      health: () =>
        Object.freeze({
          admissionPath: "available",
          cancellationPath: "available",
          canonicalStore: "available",
          internalLoop: "progressing",
          nodeSchedulability: Object.freeze({
            "synthetic-node-1": "schedulable",
          }),
          observationPath: "available",
          outboxPublisher: "progressing",
        }),
      identityBindings: [
        Object.freeze({
          bearerTokenSha256: bearerTokenDigest(token),
          credentialId: "composition-test-credential",
          principalId: "synthetic-principal",
        }),
      ],
      redactionPolicy: {
        maximumArrayLength: 32,
        maximumDepth: 8,
        maximumStringLength: 256,
        policyVersion: 1,
        secretKeys: new Set(["secret"]),
        sensitiveKeys: new Set(["prompt"]),
      },
      telemetrySink: Object.freeze({
        log: () => undefined,
        metric: () => undefined,
        span: () => undefined,
      }),
    });

    const response = api.handle({
      body: {
        contractVersion: "workload-funnel.api/v1",
        mutation: {
          causationId: "composition-cause",
          contractVersion: "workload-funnel.mutation/v1",
          correlationId: "composition-correlation",
          idempotencyKey: "composition-submit",
          requestedTenantScope: "synthetic-tenant",
          requestId: "composition-request",
        },
        spec: {
          command: ["synthetic", "composition"],
          processProfile: "trusted-synthetic-v1",
          resources: { cpuMillis: 100, memoryMiB: 64 },
          resultFiles: [],
          schemaVersion: 1,
          syntheticOutcome: "succeeded",
        },
      },
      credential: Object.freeze({ kind: "bearer", token }),
      method: "POST",
      path: "/v1/workloads",
    });

    expect(response.status).toBe(202);
    expect(response.body).toMatchObject({
      contractVersion: "workload-funnel.api/v1",
      operation: { duplicate: false },
    });
    expect(control.profileId).toBe("control-sqlite");
  });
});
