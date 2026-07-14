import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  createPhase1SyntheticService,
  createSyntheticDatabase,
} from "@workload-funnel/control-service/phase1-synthetic-runtime";
import {
  discoverSystemdCapabilities,
  syntheticDisposableLinuxProbe,
} from "@workload-funnel/executor-systemd/capability-discovery";
import {
  createSyntheticHostSurvivalProfile,
  createSyntheticSandboxProfile,
  mapHostSurvivalControls,
  mapSystemdExecutionControls,
} from "@workload-funnel/executor-systemd/cgroup-resource-mapping";
import { openSqliteArtifactMutationAuthorityStore } from "@workload-funnel/artifact-store-object/stage-upload";
import type { MutationFence } from "@workload-funnel/kernel";
import { openSqliteNodePersistence } from "@workload-funnel/store-sqlite/node-persistence";
import { deriveHostSurvivalAdmission } from "@workload-funnel/workload-control/capacity-management";
import {
  fingerprintHostPressurePolicy,
  recordHostSurvivalObservation,
  registerNode,
  type HostPressureDimension,
  type HostPressureHysteresisPolicy,
  type HostPressureObservation,
} from "@workload-funnel/workload-control/node-lifecycle";
import { decideHostControlAdmission } from "@workload-funnel/workload-control/tenant-admission";
import { createDurableArtifactMutationAuthority } from "@workload-funnel/workload-control/result-management";

const dimensions: readonly HostPressureDimension[] = [
  "cpu_psi_some",
  "memory_psi_some",
  "io_psi_some",
  "pids",
];

const thresholds = Object.freeze(
  Object.fromEntries(
    [
      "cpu_psi_full",
      "cpu_psi_some",
      "disk",
      "inodes",
      "io_psi_full",
      "io_psi_some",
      "journal",
      "memory_available",
      "memory_psi_full",
      "memory_psi_some",
      "node_spool",
      "pids",
    ].map((dimension) => [
      dimension,
      Object.freeze({ critical: 0.9, high: 0.7, soft: 0.4 }),
    ]),
  ) as Record<
    HostPressureDimension,
    { critical: number; high: number; soft: number }
  >,
);

const pressurePolicy: HostPressureHysteresisPolicy = Object.freeze({
  healthyObservationsToRecover: 3,
  highObservationsToPause: 2,
  maximumObservationAgeMs: 1_000,
  policyId: "single-host-pressure-v1",
  revision: 1,
  softDerateFactor: 0.5,
  thresholds,
});

function pressure(
  tick: number,
  dimension: HostPressureDimension | undefined,
): HostPressureObservation {
  const base: HostPressureObservation = {
    cpu: { fullAvg10: 0.01, someAvg10: 0.01 },
    diskUsedRatio: 0.1,
    inodeUsedRatio: 0.1,
    io: { fullAvg10: 0.01, someAvg10: 0.01 },
    journalUsedRatio: 0.1,
    memory: { fullAvg10: 0.01, someAvg10: 0.01 },
    memoryAvailableRatio: 0.9,
    nodeSpoolUsedRatio: 0.1,
    observedAt: tick,
    pidUsedRatio: 0.1,
    sensorState: "fresh",
    sourceSequence: tick + 1,
  };
  switch (dimension) {
    case "cpu_psi_some":
      return { ...base, cpu: { ...base.cpu, someAvg10: 0.95 } };
    case "memory_psi_some":
      return { ...base, memory: { ...base.memory, someAvg10: 0.95 } };
    case "io_psi_some":
      return { ...base, io: { ...base.io, someAvg10: 0.95 } };
    case "pids":
      return { ...base, pidUsedRatio: 0.95 };
    case undefined:
      return base;
    default:
      throw new Error("unexpected_pressure_dimension");
  }
}

function artifactFence(index: number): MutationFence {
  const allocationId = `allocation-${String(index)}`;
  return Object.freeze({
    allocationId,
    attemptId: `attempt-${String(index)}`,
    clusterIncarnation: "cluster-phase8-load",
    clusterIncarnationVersion: 1,
    desiredEffect: "artifact_stage",
    effectScopeKey: `artifact-stage:execution-${String(index)}`,
    executionGeneration: `generation-${String(index)}`,
    expectedDesiredVersion: 1,
    namespaceId: "synthetic-load",
    namespaceWriterEpoch: 1,
    notAfter: 2_000,
    notBefore: 0,
    operationGateRevision: 1,
    ownerFence: 1,
    requiredGate: "result_finalize",
    schemaVersion: 1,
    supersessionKey: `artifact-stage:execution-${String(index)}`,
  });
}

describe("Phase 8 bounded final synthetic E2E", () => {
  it("keeps canonical observe/cancel and final authority progressing under CPU/memory/IO/PID pressure", () => {
    const root = mkdtempSync(join(tmpdir(), "wf-phase8-bounded-e2e-"));
    try {
      const nodePath = join(root, "node.sqlite");
      const authorityPath = join(root, "artifact-authority.sqlite");
      let nodes = openSqliteNodePersistence(nodePath);
      const profile = createSyntheticHostSurvivalProfile();
      expect(profile.pressurePolicyBinding.digest).toBe(
        fingerprintHostPressurePolicy(pressurePolicy),
      );
      nodes.nodes.create(
        registerNode({
          bootEpoch: "node-load:boot:1",
          capabilities: ["synthetic_execution"],
          nodeId: "node-load",
          observation: {
            bootEpoch: "node-load:boot:1",
            capacity: { cpuMillis: 8000, memoryMiB: 16_384 },
            observedAt: 0,
            pressure: {
              cpuPsiSome: 0,
              ioPsiSome: 0,
              memoryPsiSome: 0,
              sensorState: "healthy",
            },
            sourceSequence: 1,
          },
          poolId: "synthetic-load-pool",
          pressurePolicy: {
            criticalThreshold: 0.9,
            healthyObservationsToRecover: 3,
            highObservationsToPause: 2,
            highThreshold: 0.7,
            softThreshold: 0.4,
          },
        }),
      );

      const capabilityReport = discoverSystemdCapabilities(
        syntheticDisposableLinuxProbe(),
      );
      expect(mapHostSurvivalControls(profile, capabilityReport).status).toBe(
        "supported",
      );
      const executorPlans = Array.from({ length: 12 }, (_, index) =>
        mapSystemdExecutionControls(
          createSyntheticSandboxProfile(`allocation-${String(index)}`),
          capabilityReport,
          "synthetic_disposable_linux_fixture",
        ),
      );
      expect(executorPlans.every((plan) => plan.status === "supported")).toBe(
        true,
      );

      let authorityStore =
        openSqliteArtifactMutationAuthorityStore(authorityPath);
      let authority = createDurableArtifactMutationAuthority(
        authorityStore.store,
      );
      const fences = Array.from({ length: 12 }, (_, index) =>
        artifactFence(index),
      );
      for (const [index, fence] of fences.entries())
        authority.install({
          mutationFence: fence,
          now: 1,
          operationId: `install-load-${String(index)}`,
          writerIdentity: "load-writer-1",
        });

      const database = createSyntheticDatabase("sqlite");
      let service = createPhase1SyntheticService(database);
      const runs = Array.from({ length: 12 }, (_, index) =>
        service.submit({
          idempotencyKey: `load-${String(index)}`,
          spec: Object.freeze({
            command: Object.freeze(["synthetic", "succeeded"]),
            processProfile: "trusted-synthetic-v1",
            resources: Object.freeze({
              cpuMillis: index % 2 === 0 ? 500 : 1000,
              memoryMiB: index % 3 === 0 ? 512 : 256,
            }),
            resultFiles: Object.freeze([]),
            schemaVersion: 1 as const,
            syntheticOutcome: "succeeded" as const,
          }),
        }),
      );

      let controlOperations = 0;
      let producerPauses = 0;
      let maximumControlGap = 0;
      let lastControlTick = 0;
      let persistenceReopens = 0;
      let cancellationIssued = false;
      const exercisedPressureDimensions = new Set<HostPressureDimension>();
      for (let tick = 1; tick <= 600; tick += 1) {
        const pressureWindow = Math.floor((tick - 1) / 5);
        const pressureDimension =
          tick % 5 === 1 || tick % 5 === 2
            ? dimensions[pressureWindow % dimensions.length]
            : undefined;
        if (pressureDimension !== undefined)
          exercisedPressureDimensions.add(pressureDimension);
        const currentNode = nodes.nodes.get("node-load");
        if (currentNode === undefined) throw new Error("node_missing");
        const observed = recordHostSurvivalObservation(
          currentNode,
          currentNode.version,
          pressure(tick, pressureDimension),
          profile,
          pressurePolicy,
          tick,
        );
        nodes.nodes.compareAndSet(
          currentNode.nodeId,
          currentNode.version,
          observed,
        );
        const admission = deriveHostSurvivalAdmission(observed);
        expect(admission.controlOperations.observation).toBe(true);
        expect(
          decideHostControlAdmission("typed_broker", {
            attribution: "per_allocation",
            daemonPoolReserved: true,
            deploymentAllowsDirectHostSocket: false,
            elevatedAuthorization: false,
            requestedByCallerOverride: false,
            tenantIsolation: "multi_tenant",
            verifiedIsolationProfiles: new Map(),
            workloadTrust: "trusted",
          }).status,
        ).toBe("allowed");

        const observedRun = runs[tick % runs.length];
        if (observedRun !== undefined) service.status(observedRun.runId);
        if (!cancellationIssued && tick === 17) {
          const canceled = runs.at(-1);
          if (canceled === undefined) throw new Error("run_missing");
          service.cancel(canceled.runId, "cancel-under-pressure");
          cancellationIssued = true;
        }
        controlOperations += 1;
        maximumControlGap = Math.max(maximumControlGap, tick - lastControlTick);
        lastControlTick = tick;

        if (admission.producerAdmission === "paused") producerPauses += 1;
        else service.step();

        if (tick === 73) {
          nodes.close();
          authorityStore.close();
          nodes = openSqliteNodePersistence(nodePath);
          authorityStore =
            openSqliteArtifactMutationAuthorityStore(authorityPath);
          authority = createDurableArtifactMutationAuthority(
            authorityStore.store,
          );
          service = createPhase1SyntheticService(database);
          persistenceReopens += 1;
        }
        if (
          runs.every(
            (run) =>
              service.status(run.runId)?.run.terminalOutcome !== undefined,
          )
        )
          break;
      }

      const terminal = runs.filter(
        (run) => service.status(run.runId)?.run.terminalOutcome !== undefined,
      );
      let finalExternalEffects = 0;
      for (const fence of fences) {
        authority.authorize(fence, 700);
        finalExternalEffects += 1;
      }
      expect(terminal).toHaveLength(12);
      expect(database.state.workloadById).toHaveLength(12);
      expect(database.state.runById).toHaveLength(12);
      expect(controlOperations).toBeGreaterThan(30);
      expect(producerPauses).toBeGreaterThan(0);
      expect(maximumControlGap).toBe(1);
      expect(persistenceReopens).toBe(1);
      expect(finalExternalEffects).toBe(12);
      expect([...exercisedPressureDimensions].sort()).toEqual(
        [...dimensions].sort(),
      );
      expect(nodes.nodes.get("node-load")?.hostPressureState).toBeDefined();
      nodes.close();
      authorityStore.close();
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });
});
