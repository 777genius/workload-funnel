import { Buffer } from "node:buffer";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  parseManualGateArguments,
  validatePinnedImages,
} from "./attestation.mjs";
import { BoundedCommandRunner } from "./command-runner.mjs";
import {
  DECLARED_COMPONENTS,
  DISPOSABLE_HOST_ATTESTATION,
  GATE_SANDBOX_PARENT,
  OBJECT_FIXTURE_IMAGE,
  POSTGRES_FIXTURE_IMAGE,
} from "./constants.mjs";
import {
  assertSafeDockerArguments,
  isolatedNetworkArguments,
  postgresContainerArguments,
} from "./docker-plan.mjs";
import {
  componentResult,
  createRedactor,
  evidenceRecord,
  finalizeEvidence,
} from "./evidence.mjs";
import {
  officialHyperQueueCancelArguments,
  officialHyperQueueSubmitArguments,
  parseOfficialArray,
  parseOfficialCancel,
  parseOfficialJobInfo,
  parseOfficialSubmit,
  stopHyperQueueCompatibilityProcesses,
} from "./hyperqueue-contract.mjs";
import { runMixedWorkloadMeasurement } from "./mixed-load.mjs";
import { observeGateStorage, parseLoadAverage } from "./host-observation.mjs";
import {
  createAwsCliScopedObjectClient,
  objectPolicyDocuments,
  providerIdentity,
} from "./object-contract.mjs";
import {
  admitPreflight,
  classifyPressure,
  parsePsi,
  ProducerPressureGate,
} from "./pressure.mjs";
import {
  encodePressureFixtureReadiness,
  PRESSURE_FIXTURE_MODES,
} from "./pressure-fixture-protocol.mjs";
import {
  atomicAcceptanceSql,
  crashWindowAcceptanceSql,
  parsePostgresSnapshot,
  postgresAtomicityProven,
  postgresSchemaSql,
} from "./postgres-probe.mjs";
import { waitForPressureFixtureReadiness } from "./pressure-stage.mjs";
import { OwnedResourceLedger } from "./resource-ledger.mjs";
import { evaluateMixedWorkloadSlo, percentile99 } from "./slo.mjs";
import {
  exactSystemdPropertiesObserved,
  parseSystemctlShow,
  systemdRunArguments,
} from "./systemd-contract.mjs";
import { createSystemdSliceOwnership } from "./systemd-slice-ledger.mjs";

const runId = "wf-production-gate-0123456789abcdef0123456789abcdef";
const digest = "a".repeat(64);
const implicitSliceDescription =
  "Slice /wf/production/gate/0123456789abcdef0123456789abcdef";

function sliceShow(overrides = {}) {
  return `${Object.entries({
    ActiveState: "inactive",
    ControlGroup: "",
    Description: implicitSliceDescription,
    DropInPaths: "",
    FragmentPath: "",
    Id: `${runId}.slice`,
    LoadState: "loaded",
    Names: `${runId}.slice`,
    SourcePath: "",
    Transient: "no",
    ...overrides,
  })
    .map(([key, value]) => `${key}=${value}`)
    .join("\n")}\n`;
}

function argumentsFor(root) {
  return [
    "--attestation",
    DISPOSABLE_HOST_ATTESTATION,
    "--aws-executable",
    "/usr/bin/aws",
    "--docker-executable",
    "/usr/bin/docker",
    "--evidence-path",
    `${root}/evidence.json`,
    "--hq-archive",
    "/opt/hq.tar.gz",
    "--hq-binary",
    "/opt/hq",
    "--id-executable",
    "/usr/bin/id",
    "--io-device",
    "/dev/vda",
    "--node-executable",
    "/usr/bin/node",
    "--object-client-image",
    `quay.io/minio/mc:RELEASE.2026-01-01@sha256:${digest}`,
    "--object-image",
    OBJECT_FIXTURE_IMAGE,
    "--operation",
    "run",
    "--postgres-image",
    POSTGRES_FIXTURE_IMAGE,
    "--psql-executable",
    "/usr/bin/psql",
    "--review-manifest",
    "/root/review-manifest.json",
    "--review-manifest-sha256",
    digest,
    "--run-id",
    runId,
    "--sandbox-root",
    root,
    "--systemctl-executable",
    "/usr/bin/systemctl",
    "--systemd-analyze-executable",
    "/usr/bin/systemd-analyze",
    "--systemd-run-executable",
    "/usr/bin/systemd-run",
  ];
}

function admitted(root, environment = {}) {
  return parseManualGateArguments(argumentsFor(root), {
    WF_PRODUCTION_GATE_DISPOSABLE_HOST_ATTESTATION: DISPOSABLE_HOST_ATTESTATION,
    WF_PRODUCTION_GATE_REVIEW_MANIFEST_SHA256: digest,
    ...environment,
  });
}

describe("manual production gate admission", () => {
  it("requires the exact attestation through both independent inputs", () => {
    const root = `${GATE_SANDBOX_PARENT}/${runId}`;
    expect(() => parseManualGateArguments(argumentsFor(root), {})).toThrow(
      "disposable_host_attestation_missing",
    );
    expect(() =>
      parseManualGateArguments(
        argumentsFor(root).with(1, `${DISPOSABLE_HOST_ATTESTATION};docker`),
        {
          WF_PRODUCTION_GATE_DISPOSABLE_HOST_ATTESTATION:
            DISPOSABLE_HOST_ATTESTATION,
        },
      ),
    ).toThrow("disposable_host_attestation_missing");
  });

  it("rejects unsafe names, roots, evidence paths, devices, and tag drift", () => {
    const root = `${GATE_SANDBOX_PARENT}/${runId}`;
    expect(() => admitted(`/tmp/${runId};rm`)).toThrow(
      "unsafe_production_gate_sandbox_root",
    );
    expect(() => admitted(root.replace(runId, `${runId}-other`))).toThrow(
      "unsafe_production_gate_sandbox_root",
    );
    const badEvidence = argumentsFor(root);
    badEvidence[badEvidence.indexOf("--evidence-path") + 1] =
      "/tmp/evidence.json";
    expect(() =>
      parseManualGateArguments(badEvidence, {
        WF_PRODUCTION_GATE_DISPOSABLE_HOST_ATTESTATION:
          DISPOSABLE_HOST_ATTESTATION,
        WF_PRODUCTION_GATE_REVIEW_MANIFEST_SHA256: digest,
      }),
    ).toThrow("evidence_path_must_be_in_owned_sandbox");
    const config = admitted(root);
    expect(() =>
      validatePinnedImages({ ...config, postgresImage: "postgres:18.4" }),
    ).toThrow("postgres_image_not_18_4_digest_pinned");
    expect(() =>
      validatePinnedImages({
        ...config,
        objectImage: `minio/minio:latest@sha256:${digest}`,
      }),
    ).toThrow("object_fixture_image_not_digest_pinned");
  });

  it("admits only the fixed production sandbox parent and replacement operation", () => {
    const root = `${GATE_SANDBOX_PARENT}/${runId}`;
    const environment = {
      WF_PRODUCTION_GATE_DISPOSABLE_HOST_ATTESTATION:
        DISPOSABLE_HOST_ATTESTATION,
      WF_PRODUCTION_GATE_REVIEW_MANIFEST_SHA256: digest,
    };
    expect(admitted(root)).toMatchObject({
      operation: "run",
      sandboxRoot: root,
    });
    expect(
      parseManualGateArguments(["--", ...argumentsFor(root)], environment),
    ).toMatchObject({ operation: "run", sandboxRoot: root });
    expect(() =>
      parseManualGateArguments(
        ["--", "--", ...argumentsFor(root)],
        environment,
      ),
    ).toThrow("invalid_manual_gate_arguments");
    expect(() =>
      parseManualGateArguments(
        argumentsFor(root).toSpliced(2, 0, "--"),
        environment,
      ),
    ).toThrow("invalid_manual_gate_arguments");
    expect(() => admitted(`/tmp/${runId}`)).toThrow(
      "unsafe_production_gate_sandbox_root",
    );
    const recovery = argumentsFor(root);
    recovery[recovery.indexOf("--operation") + 1] = "recover-cleanup";
    expect(parseManualGateArguments(recovery, environment).operation).toBe(
      "recover-cleanup",
    );
  });
});

describe("bounded resource plans", () => {
  it("keeps Docker internal-only, unpublished, capped, and injection-closed", () => {
    expect(isolatedNetworkArguments(runId)).toContain("--internal");
    const args = postgresContainerArguments({
      database: `${runId.replaceAll("-", "_")}`,
      dataDirectory: `${GATE_SANDBOX_PARENT}/${runId}/postgres-data`,
      image: POSTGRES_FIXTURE_IMAGE,
      ioDevice: "/dev/vda",
      name: `${runId}-postgres`,
      network: `${runId}-network`,
      passwordFile: `/tmp/${runId}/postgres-password`,
      user: "wf_gate",
    });
    expect(args).toEqual(
      expect.arrayContaining([
        "--pull=never",
        "--memory-swap",
        "--pids-limit",
        "--device-read-bps",
        "--device-write-bps",
        "--cap-drop",
        "ALL",
        "--read-only",
        "--platform=linux/amd64",
      ]),
    );
    expect(args).not.toContain("--publish");
    expect(() => assertSafeDockerArguments(["run", "--privileged"])).toThrow(
      "unsafe_docker_gate_arguments",
    );
    expect(() =>
      assertSafeDockerArguments(["run", "--name", `${runId};touch-pwned`]),
    ).toThrow("unsafe_docker_resource_name");
  });

  it("tracks reverse cleanup and reports partial cleanup without widening scope", async () => {
    const directory = await mkdtemp(join(tmpdir(), "wf-gate-ledger-"));
    const events = [];
    try {
      const ledger = await OwnedResourceLedger.open({
        path: join(directory, "ledger.json"),
        runId,
      });
      const network = await ledger.prepare("network", `${runId}-network`);
      await ledger.finalize(network, { id: "network" }, () =>
        events.push("network"),
      );
      const container = await ledger.prepare("container", `${runId}-postgres`);
      await ledger.finalize(container, { id: "container" }, () => {
        events.push("container");
        throw new Error("partial_cleanup");
      });
      await expect(ledger.prepare("container", "foreign")).rejects.toThrow(
        "resource_not_owned_by_gate_run",
      );
      await expect(ledger.cleanup()).resolves.toMatchObject({ certain: false });
      expect(events).toEqual(["container", "network"]);
      expect(ledger.snapshot()).toEqual([
        expect.objectContaining({
          name: `${runId}-postgres`,
          state: "uncertain",
        }),
      ]);
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });
});

describe("live pressure admission", () => {
  const observation = {
    cpuPsiSome: 0.01,
    diskFreeBytes: 16 * 1024 ** 3,
    diskFreeRatio: 0.5,
    ioPsiSome: 0.01,
    loadPerCpu: 0.1,
    memoryAvailableRatio: 0.8,
    memoryPsiSome: 0.01,
    nowMs: 1_000,
    observedAtMs: 1_000,
  };

  it("accepts the real CPU PSI shape without a full line and rejects malformed PSI", () => {
    expect(
      parsePsi("some avg10=1.00 avg60=0.10 avg300=0.01 total=12", {
        requireFull: false,
      }),
    ).toMatchObject({
      some: { avg10: 0.01, total: 12 },
    });
    expect(() => parsePsi("some avg10=nan total=1")).toThrow(
      "malformed_psi_observation",
    );
    expect(parseLoadAverage("4.0 1.0 1.0 1/1 1", 8)).toBe(0.5);
  });

  it("bounds concurrent gate-storage inspection without serializing every inode", async () => {
    let active = 0;
    let maximumActive = 0;
    const result = await observeGateStorage({
      inspect: async () => {
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        await Promise.resolve();
        active -= 1;
        return {
          isDirectory: () => false,
          isFile: () => true,
          isSymbolicLink: () => false,
          size: 1,
        };
      },
      list: () =>
        Promise.resolve(
          Array.from({ length: 128 }, (_, index) => ({
            name: String(index),
          })),
        ),
      maximumBytes: 256,
      maximumInodes: 256,
      root: "/synthetic/pressure",
    });
    expect(result).toEqual({
      gateDiskUsedRatio: 0.5,
      gateInodeUsedRatio: 0.5,
      gateStorageBytes: 128,
      gateStorageInodes: 128,
    });
    expect(maximumActive).toBe(64);
  });

  it("fails stale preflight closed and preserves protected control availability", () => {
    expect(admitPreflight({ ...observation, nowMs: 10_000 })).toMatchObject({
      producerAdmission: "paused",
      protectedControl: { cancel: true, health: true, status: true },
    });
    expect(classifyPressure({ ...observation, nowMs: 10_000 }).severity).toBe(
      "critical",
    );
  });

  it("pauses before critical pressure and reopens only after hysteresis", () => {
    const gate = new ProducerPressureGate();
    const high = { ...observation, cpuPsiSome: 0.25 };
    expect(gate.observe(high).producerAdmission).toBe("open");
    expect(gate.observe(high).producerAdmission).toBe("paused");
    expect(gate.observe(observation).producerAdmission).toBe("paused");
    expect(gate.observe(observation).producerAdmission).toBe("paused");
    expect(gate.observe(observation).producerAdmission).toBe("open");
    expect(
      gate.observe({ ...observation, cpuPsiSome: 0.7 }).producerAdmission,
    ).toBe("aborted");
  });

  it("keeps protected controls live while producer admission pauses and reopens", async () => {
    let now = 1_000;
    let calls = 0;
    const produce = vi.fn(() => Promise.resolve(true));
    const protectedControl = vi.fn(() => Promise.resolve(true));
    const onPause = vi.fn(() => Promise.resolve());
    const result = await runMixedWorkloadMeasurement({
      clock: () => now,
      durationMs: 10_000,
      maximumIterations: 100,
      observe: () => {
        calls += 1;
        return Promise.resolve({
          ...observation,
          cpuPsiSome: calls <= 2 ? 0.25 : 0.01,
          nowMs: now,
          observedAtMs: now,
        });
      },
      onPause,
      preciseClock: () => now,
      produce,
      protectedControls: {
        cancel: protectedControl,
        health: protectedControl,
        status: protectedControl,
      },
      wait: () => {
        now += 100;
        return Promise.resolve();
      },
    });
    expect(result).toMatchObject({
      acceptedAfterReopen: expect.any(Number),
      observedPause: true,
      observedReopen: true,
      protectedControlFailures: 0,
      sampleCounts: {
        cancel: expect.any(Number),
        health: expect.any(Number),
        status: expect.any(Number),
      },
    });
    expect(onPause).toHaveBeenCalledOnce();
    expect(result.acceptedAfterReopen).toBeGreaterThan(0);
    expect(produce.mock.calls.length).toBeGreaterThanOrEqual(100);
    expect(produce.mock.calls.length).toBeLessThanOrEqual(256);
    expect(result.sampleCounts.cancel).toBeGreaterThanOrEqual(100);
    expect(result.sampleCounts.health).toBeGreaterThanOrEqual(100);
    expect(result.sampleCounts.status).toBeGreaterThanOrEqual(100);
    expect(protectedControl).toHaveBeenCalledTimes(
      result.sampleCounts.cancel +
        result.sampleCounts.health +
        result.sampleCounts.status,
    );
  });

  it("observes pressure independently of a slow cancellation sample", async () => {
    let now = 1_000;
    let observations = 0;
    let releaseCancellation;
    const cancel = vi.fn(() => {
      if (releaseCancellation !== undefined) return Promise.resolve(true);
      return new Promise((resolve) => {
        releaseCancellation = resolve;
      });
    });
    const result = await runMixedWorkloadMeasurement({
      clock: () => now,
      durationMs: 10_000,
      maximumIterations: 110,
      maximumSamples: 100,
      observe: () => {
        observations += 1;
        return Promise.resolve({
          ...observation,
          cpuPsiSome: observations <= 2 ? 0.25 : 0.01,
          nowMs: now,
          observedAtMs: now,
        });
      },
      onPause: () => Promise.resolve(),
      preciseClock: () => now,
      produce: () => Promise.resolve(true),
      protectedControls: {
        cancel,
        health: () => Promise.resolve(true),
        status: () => Promise.resolve(true),
      },
      wait: () => {
        now += 100;
        if (observations === 5) releaseCancellation?.(true);
        return Promise.resolve();
      },
    });

    expect(result).toMatchObject({
      acceptedAfterReopen: expect.any(Number),
      durationMs: expect.any(Number),
      observedPause: true,
      observedReopen: true,
      sampleCounts: { cancel: 100, health: 100, status: 100 },
    });
    expect(result.durationMs).toBeGreaterThanOrEqual(10_000);
    expect(result.durationMs).toBeLessThanOrEqual(11_000);
    expect(result.acceptedAfterReopen).toBeGreaterThan(0);
    expect(cancel).toHaveBeenCalledTimes(100);
    expect(result.slo.passed).toBe(true);
  });

  it("starts the full measurement after staggered fixtures are primed with bounded runtime remaining", async () => {
    const initialNow = 1_000;
    const rampDurationMs = 9_631;
    let now = initialNow;
    let observations = 0;
    let pressureQuiesced = false;
    let readiness;
    const modes = PRESSURE_FIXTURE_MODES;
    const readyOffsets = new Map([
      ["cpu", 1_200],
      ["memory", 3_400],
      ["io", 5_600],
      ["disk", 7_800],
      ["inodes", rampDurationMs],
    ]);
    const fixtures = modes.map((mode, index) => ({
      mode,
      process: { mode },
      runtimeDeadlineMs: initialNow - (4 - index) * 1_000 + 75_000,
    }));
    const result = await runMixedWorkloadMeasurement({
      clock: () => now,
      durationMs: 30_000,
      maximumIterations: 600,
      maximumSamples: 256,
      observe: () => {
        observations += 1;
        return Promise.resolve({
          ...observation,
          cpuPsiSome: observations <= 20 ? 0.25 : 0.01,
          nowMs: now,
          observedAtMs: now,
        });
      },
      onPause: () => {
        pressureQuiesced = true;
        return Promise.resolve();
      },
      policy: {
        ...new ProducerPressureGate().policy,
        highObservationsToPause: 20,
      },
      preciseClock: () => now,
      prepare: async () => {
        const readyAt = now + rampDurationMs;
        readiness = await waitForPressureFixtureReadiness({
          clock: () => now,
          fixtures,
          readReady: (path) => {
            const mode = path.slice(path.lastIndexOf("-") + 1);
            if (now - initialNow >= readyOffsets.get(mode))
              return Promise.resolve(encodePressureFixtureReadiness(mode));
            return Promise.reject(
              Object.assign(new Error("not ready"), {
                code: "ENOENT",
              }),
            );
          },
          root: "/synthetic/pressure",
          verifyRunning: (process) =>
            Promise.resolve({ active: true, mode: process.mode }),
          wait: (milliseconds) => {
            now += Math.min(milliseconds, readyAt - now);
            return Promise.resolve();
          },
        });
      },
      produce: () => Promise.resolve(true),
      protectedControls: {
        cancel: () => Promise.resolve(true),
        health: () => Promise.resolve(true),
        status: () => Promise.resolve(true),
      },
      wait: (milliseconds) => {
        now += milliseconds;
        return Promise.resolve();
      },
    });
    expect(readiness).toMatchObject({
      allModesReady: true,
      durationMs: rampDurationMs,
      minimumRuntimeRemainingMs: 61_369,
      modes,
      verifiedFixtures: modes.map((mode) => ({
        mode,
        primed: expect.any(Object),
        process: { active: true, mode },
      })),
    });
    expect(result).toMatchObject({
      acceptedAfterReopen: expect.any(Number),
      durationMs: 30_000,
      observedPause: true,
      observedReopen: true,
      sampleCounts: { cancel: 256, health: 256, status: 256 },
      slo: { passed: true },
    });
    expect(result.acceptedAfterReopen).toBeGreaterThan(0);
    expect(pressureQuiesced).toBe(true);
    expect(now - initialNow).toBe(rampDurationMs + 30_000);
  });

  it("keeps the producer closed when the first live observation is critical", async () => {
    let now = 1_000;
    const produce = vi.fn(() => Promise.resolve(true));
    const onAbort = vi.fn(() => Promise.resolve());
    const result = await runMixedWorkloadMeasurement({
      clock: () => now,
      durationMs: 10_000,
      maximumIterations: 100,
      maximumSamples: 100,
      observe: () =>
        Promise.resolve({
          ...observation,
          cpuPsiSome: 0.7,
          nowMs: now,
          observedAtMs: now,
        }),
      onAbort,
      preciseClock: () => now,
      produce,
      protectedControls: {
        cancel: () => Promise.resolve(true),
        health: () => Promise.resolve(true),
        status: () => Promise.resolve(true),
      },
      wait: () => {
        now += 100;
        return Promise.resolve();
      },
    });

    expect(result.abortedBeforeHostExhaustion).toBe(true);
    expect(result.slo.passed).toBe(false);
    expect(onAbort).toHaveBeenCalledOnce();
    expect(produce).not.toHaveBeenCalled();
  });
});

describe("Postgres transaction contract", () => {
  it("uses SERIALIZABLE atomic acceptance and exact history relations", () => {
    const schema = "wf_production_gate_0123456789abcdef0123456789abcdef";
    const sql = atomicAcceptanceSql({
      callerScope: "caller",
      idempotencyKey: "key",
      operationId: "operation",
      schema,
      workloadId: "workload",
    });
    expect(sql).toContain("BEGIN ISOLATION LEVEL SERIALIZABLE");
    expect(sql).toContain("idempotency_receipt");
    expect(sql).toContain("FROM created_workload");
    expect(sql).toContain("FROM created_outbox");
    expect(postgresSchemaSql(schema)).toContain(
      "PRIMARY KEY (caller_scope, idempotency_key)",
    );
    expect(
      crashWindowAcceptanceSql(
        {
          callerScope: "caller",
          idempotencyKey: "key",
          operationId: "operation",
          schema,
          workloadId: "workload",
        },
        "before_commit",
      ),
    ).toContain("pg_sleep(30);\nCOMMIT");
    const postCommit = crashWindowAcceptanceSql(
      {
        callerScope: "caller-post",
        idempotencyKey: "key-post",
        operationId: "operation-post",
        schema,
        workloadId: "workload-post",
      },
      "after_commit",
    );
    expect(postCommit.indexOf("COMMIT;")).toBeLessThan(
      postCommit.indexOf("SELECT pg_sleep(30)"),
    );
    const snapshot = parsePostgresSnapshot(
      '{"receipts":1,"workloads":1,"outbox":1,"acceptedHistory":1,"terminalHistory":1,"workloadIds":["workload"]}',
    );
    expect(postgresAtomicityProven(snapshot)).toBe(true);
  });

  it("rejects SQL injection and malformed external JSON", () => {
    expect(() => postgresSchemaSql("safe;drop_schema")).toThrow(
      "unsafe_postgres_gate_identifier",
    );
    expect(() => parsePostgresSnapshot("{}")).toThrow(
      "postgres_gate_snapshot_invalid",
    );
    expect(() => parsePostgresSnapshot("not-json")).toThrow(
      "postgres_gate_snapshot_malformed",
    );
  });
});

describe("S3-compatible contract", () => {
  it("uses conditional PUT without claiming credential immutability", async () => {
    const checksum = `sha256:${"b".repeat(64)}`;
    const checksumBase64 = Buffer.from(checksum.slice(7), "hex").toString(
      "base64",
    );
    const run = vi.fn(async (_executable, args) => ({
      code: 0,
      stderr: "",
      stdout: JSON.stringify({ ChecksumSHA256: checksumBase64 }),
      args,
    }));
    const client = createAwsCliScopedObjectClient({
      awsExecutable: "/usr/bin/aws",
      bucket: `${runId}-artifacts`,
      credentialEnvironment: {},
      endpoint: "http://127.0.0.1:19000",
      runId,
      runner: { run },
      scope: {
        canDelete: false,
        canList: false,
        canOverwrite: true,
        canRead: false,
        permissions: ["put"],
        prefix: `${runId}/uploads/`,
      },
    });
    await expect(
      client.putIfAbsent({
        bodyPath: "/tmp/body",
        checksum,
        key: `${runId}/uploads/a`,
        sizeBytes: 1,
      }),
    ).resolves.toMatchObject({ created: true });
    expect(client.capabilities).toMatchObject({
      conditionalCreate: true,
      credentialEnforcedImmutability: false,
    });
    expect(run.mock.calls[0][1]).toEqual(
      expect.arrayContaining([
        "--if-none-match",
        "*",
        "--checksum-algorithm",
        "SHA256",
      ]),
    );
    const identity = providerIdentity({
      endpoint: "http://127.0.0.1:19000",
      fixtureImage: `minio/minio:x@sha256:${digest}`,
      region: "us-east-1",
    });
    expect(identity).toMatchObject({
      compatibilityOnly: true,
      productionProviderApproved: false,
    });
  });

  it("keeps upload, delete, and verification policies disjoint", () => {
    const policies = objectPolicyDocuments({
      bucket: `${runId}-artifacts`,
      key: `${runId}/uploads/artifact.bin`,
      prefix: `${runId}/uploads/`,
    });
    expect(policies.upload.Statement[0].Action).toEqual(["s3:PutObject"]);
    expect(policies.upload.Statement[0]).toMatchObject({
      Resource: [
        `arn:aws:s3:::${runId}-artifacts/${runId}/uploads/artifact.bin`,
      ],
    });
    expect(policies.upload.Statement[0]).not.toHaveProperty("Condition");
    expect(policies.delete.Statement[0].Action).toEqual(["s3:DeleteObject"]);
    expect(policies.verify.Statement[0].Action).toEqual(["s3:GetObject"]);
  });
});

describe("official HyperQueue 0.26.2 translation", () => {
  it("stops the exact worker before its server and never advances past an uncertain worker stop", async () => {
    const server = Object.freeze({ invocationId: "server", role: "hq-server" });
    const worker = Object.freeze({ invocationId: "worker", role: "hq-worker" });
    const order = [];
    const stopProcess = vi.fn((process) => {
      order.push(process);
      return Promise.resolve();
    });
    await expect(
      stopHyperQueueCompatibilityProcesses({ server, stopProcess, worker }),
    ).resolves.toBeUndefined();
    expect(order).toEqual([worker, server]);

    const uncertainStop = vi.fn((process) => {
      if (process === worker)
        return Promise.reject(new Error("bounded_host_process_stop_uncertain"));
      return Promise.resolve();
    });
    await expect(
      stopHyperQueueCompatibilityProcesses({
        server,
        stopProcess: uncertainStop,
        worker,
      }),
    ).rejects.toThrow("bounded_host_process_stop_uncertain");
    expect(uncertainStop).toHaveBeenCalledTimes(1);
    expect(uncertainStop).toHaveBeenCalledWith(worker);
  });

  it("uses global server-dir and the real submit/cancel schemas", () => {
    const submit = officialHyperQueueSubmitArguments({
      cpus: 1,
      jobName: `${runId}-job`,
      serverDirectory: "/tmp/hq",
      shimArguments: [],
      shimExecutable: "/usr/bin/node",
    });
    expect(submit.slice(0, 3)).toEqual(["--server-dir", "/tmp/hq", "submit"]);
    expect(parseOfficialSubmit('{"id":7}')).toEqual({
      jobId: "7",
      taskId: "0",
    });
    const cancel = officialHyperQueueCancelArguments("/tmp/hq", "7");
    expect(cancel).not.toEqual(
      expect.arrayContaining(["--task", "--mapping-fingerprint"]),
    );
    expect(parseOfficialCancel("{}")).toEqual({ acknowledged: true });
    expect(
      parseOfficialJobInfo('[{"info":{"id":7},"tasks":[]}]', "7"),
    ).toMatchObject({ jobId: "7" });
  });

  it("fails closed on malformed or legacy synthetic JSON", () => {
    expect(() => parseOfficialSubmit('{"jobId":"job-1"}')).toThrow(
      "hyperqueue_submit_schema_invalid",
    );
    expect(() => parseOfficialCancel('{"state":"canceled"}')).toThrow(
      "hyperqueue_cancel_schema_invalid",
    );
    expect(() => parseOfficialArray("{}", "worker_list")).toThrow(
      "hyperqueue_worker_list_schema_invalid",
    );
    expect(() => parseOfficialJobInfo('[{"id":7,"tasks":[]}]', "7")).toThrow(
      "hyperqueue_job_info_schema_invalid",
    );
    for (const malformed of [
      "[]",
      '[{"info":{"id":7},"tasks":[]},{"info":{"id":7},"tasks":[]}]',
      '[{"info":{"id":"07"},"tasks":[]}]',
      '[{"info":{"id":7},"tasks":[{"id":"00"}]}]',
      '[{"info":{"id":7},"tasks":[{"id":0},{"id":"0"}]}]',
    ])
      expect(() => parseOfficialJobInfo(malformed, "7")).toThrow(
        "hyperqueue_job_info_schema_invalid",
      );
    expect(() =>
      parseOfficialJobInfo('[{"info":{"id":8},"tasks":[]}]', "7"),
    ).toThrow("hyperqueue_job_info_identity_mismatch");
    expect(() => officialHyperQueueCancelArguments("/tmp/hq", "01")).toThrow(
      "hyperqueue_job_id_invalid",
    );
  });
});

describe("systemd and SLO contracts", () => {
  const properties = {
    AmbientCapabilities: [],
    CapabilityBoundingSet: [],
    CPUQuotaPerSecUSec: 500_000n,
    CPUWeight: 100,
    DevicePolicy: "closed",
    Group: "workload-funnel-synthetic",
    IOReadBandwidthMax: [["/dev/vda", 1_048_576n]],
    IOWeight: 100,
    IOWriteBandwidthMax: [["/dev/vda", 524_288n]],
    KillMode: "control-group",
    LimitNOFILE: 1024,
    MemoryHigh: 67_108_864n,
    MemoryMax: 100_663_296n,
    MemorySwapMax: 0n,
    NoNewPrivileges: true,
    PrivateDevices: true,
    PrivateNetwork: true,
    PrivateTmp: true,
    ProtectControlGroups: true,
    ProtectKernelModules: true,
    ProtectKernelTunables: true,
    ProtectSystem: "strict",
    ReadWritePaths: [`/var/lib/workload-funnel/allocations/${runId}`],
    RuntimeMaxUSec: 5_000_000n,
    SystemCallFilter: ["@system-service", "~@mount"],
    TasksMax: 16,
    User: "workload-funnel-synthetic",
  };

  it("renders mapped transient-unit properties without a shell and verifies identity", () => {
    const args = systemdRunArguments({
      description: `WorkloadFunnel production gate ${runId} tree`,
      executable: "/usr/bin/node",
      executableArguments: ["/tmp/fixture"],
      ioDevice: "/dev/vda",
      properties,
      slice: `${runId}.slice`,
      unit: `${runId}-tree.service`,
    });
    expect(args).toEqual(
      expect.arrayContaining([
        "--property=KillMode=control-group",
        "--property=RuntimeMaxSec=5000000us",
        "--property=MemorySwapMax=0",
        "--",
        "/usr/bin/node",
      ]),
    );
    expect(args.join(" ")).not.toContain("sh -c");
    expect(() =>
      systemdRunArguments({
        description: `WorkloadFunnel production gate ${runId} bad`,
        executable: "/usr/bin/node",
        ioDevice: "/dev/vda",
        properties,
        slice: `${runId}.slice`,
        unit: `${runId};touch-x.service`,
      }),
    ).toThrow("unsafe_systemd_gate_invocation");
    const shown = parseSystemctlShow(
      `ActiveState=active\nAmbientCapabilities=\nCapabilityBoundingSet=\nControlGroup=/wf.slice/test\nDescription=WorkloadFunnel production gate ${runId} tree\nEnvironment=HOME=/nonexistent LANG=C.UTF-8 LC_ALL=C.UTF-8 PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin TZ=UTC\nInvocationID=${"c".repeat(32)}\nKillMode=control-group\nLockPersonality=yes\nNoNewPrivileges=yes\nProtectSystem=strict\nSlice=${runId}.slice\nDevicePolicy=closed\nPrivateDevices=yes\nPrivateNetwork=yes\nPrivateTmp=yes\nProcSubset=pid\nProtectClock=yes\nProtectControlGroups=yes\nProtectHome=yes\nProtectHostname=yes\nProtectKernelLogs=yes\nProtectKernelModules=yes\nProtectKernelTunables=yes\nProtectProc=invisible\nRestrictAddressFamilies=AF_UNIX\nRestrictNamespaces=yes\nRestrictRealtime=yes\nRestrictSUIDSGID=yes\nSystemCallArchitectures=native\nUMask=0077`,
    );
    expect(
      exactSystemdPropertiesObserved(shown, {
        description: `WorkloadFunnel production gate ${runId} tree`,
        slice: `${runId}.slice`,
      }),
    ).toBe(true);
  });

  it("computes bounded p99 and rejects failed protected control", () => {
    expect(percentile99([1, 2, 3, 4])).toBe(4);
    const samples = Array.from({ length: 100 }, () => 10);
    expect(
      evaluateMixedWorkloadSlo({
        accepted: 50,
        cancelLatenciesMs: samples,
        durationMs: 10_000,
        healthLatenciesMs: samples,
        iterations: 100,
        protectedControlFailures: 0,
        statusLatenciesMs: samples,
      }).passed,
    ).toBe(true);
    expect(
      evaluateMixedWorkloadSlo({
        accepted: 50,
        cancelLatenciesMs: samples,
        durationMs: 10_000,
        healthLatenciesMs: samples,
        iterations: 100,
        protectedControlFailures: 1,
        statusLatenciesMs: samples,
      }).passed,
    ).toBe(false);
  });

  it("refuses a preexisting slice and cleans only an admitted owned slice", async () => {
    const directory = await mkdtemp(join(tmpdir(), "wf-gate-slice-"));
    try {
      const foreignLedger = await OwnedResourceLedger.open({
        path: join(directory, "foreign.json"),
        runId,
      });
      const foreign = createSystemdSliceOwnership({
        ledger: foreignLedger,
        runId,
        runner: {
          run: vi.fn(() =>
            Promise.resolve({
              code: 0,
              stderr: "",
              stdout: sliceShow({ Description: "foreign slice" }),
            }),
          ),
        },
        systemctlExecutable: "/usr/bin/systemctl",
      });
      await expect(foreign.admit()).rejects.toThrow(
        "systemd_gate_slice_already_exists_or_unprovable",
      );

      const ledger = await OwnedResourceLedger.open({
        path: join(directory, "owned.json"),
        runId,
      });
      const absent = {
        code: 1,
        stderr: `Unit ${runId}.slice could not be found.`,
        stdout: "",
      };
      let calls = 0;
      const owned = createSystemdSliceOwnership({
        ledger,
        runId,
        runner: {
          run: vi.fn(() => {
            calls += 1;
            if (calls === 1) return Promise.resolve(absent);
            if (calls === 5)
              return Promise.resolve({
                code: 0,
                stderr: "",
                stdout: sliceShow(),
              });
            if (calls === 2 || calls === 3)
              return Promise.resolve({
                code: 0,
                stderr: "",
                stdout: sliceShow({
                  ActiveState: "active",
                  ControlGroup: `/wf.slice/wf-production.slice/wf-production-gate.slice/${runId}.slice`,
                }),
              });
            return Promise.resolve({ code: 0, stderr: "", stdout: "" });
          }),
        },
        systemctlExecutable: "/usr/bin/systemctl",
      });
      await owned.admit();
      await owned.register();
      expect(ledger.snapshot()).toEqual([
        expect.objectContaining({
          kind: "systemd-slice",
          name: `${runId}.slice`,
          state: "active",
        }),
      ]);
      await expect(ledger.cleanup()).resolves.toMatchObject({ certain: true });
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });
});

describe("redacted fail-closed evidence", () => {
  it("redacts values and secret-shaped keys", () => {
    const redact = createRedactor(["literal-secret"]);
    expect(
      redact({ message: "prefix literal-secret suffix", password: "anything" }),
    ).toEqual({ message: "prefix [REDACTED] suffix", password: "[REDACTED]" });
  });

  it("forbids synthetic PASS evidence and closes production on any blocker", () => {
    expect(() =>
      componentResult({
        evidence: [evidenceRecord("synthetic", true, {}, "synthetic")],
        id: "attestation",
        status: "PASS",
      }),
    ).toThrow("real_evidence_required_for_component_pass");
    const components = DECLARED_COMPONENTS.map((id) =>
      id === "postgres_production_adapter"
        ? componentResult({
            evidence: [],
            id,
            reasonCode: "adapter_missing",
            status: "BLOCKED",
          })
        : componentResult({
            evidence: [evidenceRecord(`${id}_evidence`, true, {})],
            id,
            status: "PASS",
          }),
    );
    const evidence = finalizeEvidence({
      components,
      finishedAt: "2026-07-15T00:01:00.000Z",
      host: {},
      runId,
      startedAt: "2026-07-15T00:00:00.000Z",
    });
    expect(evidence).toMatchObject({
      overallVerdict: "BLOCKED",
      privilegedStartsEnabled: false,
      productionStartsEnabled: false,
      syntheticEvidenceAcceptedForRealFields: false,
    });
  });

  it("classifies command timeout without exposing arguments", async () => {
    const runner = new BoundedCommandRunner({
      executeFile: async () => {
        throw Object.assign(new Error("timed out secret-value"), {
          killed: true,
        });
      },
    });
    await expect(
      runner.run("/usr/bin/false", ["secret-value"], { timeoutMs: 10 }),
    ).resolves.toEqual({
      code: null,
      errorCode: "command_timeout",
      stderr: "",
      stdout: "",
    });
  });
});
