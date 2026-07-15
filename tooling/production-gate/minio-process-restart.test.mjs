import { execFile, spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { fileURLToPath, URL } from "node:url";

import { describe, expect, it, vi } from "vitest";

import { GateDockerRuntime } from "./docker-runtime.mjs";
import {
  assertMinioRestartEvidence,
  parseMinioSupervisorState,
  proveMinioProcessRestart,
  restartConfinedMinio,
} from "./minio-process-restart.mjs";

const runId = "wf-production-gate-0123456789abcdef0123456789abcdef";
const name = `${runId}-object`;
const identity = "a".repeat(64);
const executeFile = promisify(execFile);

function state(generation, serverPid, supervisorPid = 7) {
  return `workload-funnel.minio-supervisor.v1|${String(supervisorPid)}|${String(generation)}|${String(serverPid)}`;
}

function processObservation(overrides = {}) {
  return {
    configurationSha256: "b".repeat(64),
    containerBoundaryPid: 401,
    containerBoundaryStable: true,
    containerConfinementStable: true,
    containerIdentity: identity,
    containerIdentityStable: true,
    currentServerGeneration: 2,
    currentServerPid: 12,
    previousServerGeneration: 1,
    previousServerPid: 11,
    readinessAfterRestart: true,
    schemaVersion: "workload-funnel.minio-server-process-restart.v1",
    serverProcessGenerationChanged: true,
    serverProcessPidChanged: true,
    supervisorBoundaryStable: true,
    supervisorPid: 7,
    ...overrides,
  };
}

function restartObservation() {
  const evidence = processObservation();
  return {
    containerBoundaryPid: evidence.containerBoundaryPid,
    containerBoundaryStable: evidence.containerBoundaryStable,
    containerIdentity: evidence.containerIdentity,
    containerIdentityStable: evidence.containerIdentityStable,
    currentServerGeneration: evidence.currentServerGeneration,
    currentServerPid: evidence.currentServerPid,
    previousServerGeneration: evidence.previousServerGeneration,
    previousServerPid: evidence.previousServerPid,
    schemaVersion:
      "workload-funnel.minio-server-process-restart-observation.v1",
    serverProcessGenerationChanged: evidence.serverProcessGenerationChanged,
    serverProcessPidChanged: evidence.serverProcessPidChanged,
    supervisorBoundaryStable: evidence.supervisorBoundaryStable,
    supervisorPid: evidence.supervisorPid,
  };
}

async function waitForState(path, generation) {
  const deadline = Date.now() + 2_000;
  for (;;) {
    try {
      const observed = parseMinioSupervisorState(
        (await readFile(path, "utf8")).trim(),
      );
      if (observed.generation === generation) return observed;
    } catch {
      // The supervisor creates and atomically replaces the state during startup.
    }
    if (Date.now() >= deadline) throw new Error("synthetic_supervisor_timeout");
    await delay(20);
  }
}

describe("confined MinIO server-process restart", () => {
  it("keeps the container and supervisor stable while changing server generation and PID", async () => {
    const supervisorStates = [state(1, 11), state(1, 11), state(2, 12)];
    const calls = [];
    const runtime = new GateDockerRuntime({
      executable: "/usr/bin/docker",
      ioDevice: "/dev/vda",
      runId,
      runner: {
        run: vi.fn(async (_executable, args) => {
          calls.push(args);
          if (args[0] === "container")
            return {
              code: 0,
              stderr: "",
              stdout: `running|401|${identity}|/${name}|${name}\n`,
            };
          if (args[0] === "exec")
            return {
              code: 0,
              stderr: "",
              stdout: `${supervisorStates.shift()}\n`,
            };
          if (args[0] === "kill")
            return { code: 0, stderr: "", stdout: `${identity}\n` };
          throw new Error("unexpected_test_command");
        }),
      },
      sandboxRoot: `/tmp/${runId}`,
    });

    await expect(
      runtime.restartMinioServerProcess(name, identity),
    ).resolves.toEqual({
      containerBoundaryPid: 401,
      containerBoundaryStable: true,
      containerIdentity: identity,
      containerIdentityStable: true,
      currentServerGeneration: 2,
      currentServerPid: 12,
      previousServerGeneration: 1,
      previousServerPid: 11,
      schemaVersion:
        "workload-funnel.minio-server-process-restart-observation.v1",
      serverProcessGenerationChanged: true,
      serverProcessPidChanged: true,
      supervisorBoundaryStable: true,
      supervisorPid: 7,
    });
    expect(calls).toContainEqual(["kill", "--signal=USR1", identity]);
    expect(calls.flat()).not.toContain("restart");
    expect(calls.flat()).not.toContain("start");
    expect(supervisorStates).toHaveLength(0);
  });

  it.each([
    ["", "empty"],
    ["workload-funnel.minio-supervisor.v1|7|1", "missing field"],
    ["workload-funnel.minio-supervisor.v1|7|1|0", "zero PID"],
    ["workload-funnel.minio-supervisor.v1|7|01|11", "noncanonical"],
    ["foreign|7|1|11", "foreign schema"],
  ])("fails closed on malformed supervisor evidence: %s", (output) => {
    expect(() => parseMinioSupervisorState(output)).toThrow(
      "minio_restart_evidence_malformed",
    );
  });

  it.each([
    [{ generation: 1, serverPid: 12, supervisorPid: 7 }, "same generation"],
    [{ generation: 3, serverPid: 12, supervisorPid: 7 }, "skipped generation"],
    [{ generation: 2, serverPid: 11, supervisorPid: 7 }, "same server PID"],
    [{ generation: 2, serverPid: 12, supervisorPid: 8 }, "changed supervisor"],
  ])("fails closed on stale restart evidence: %s", (after) => {
    expect(() =>
      proveMinioProcessRestart({
        after,
        before: { generation: 1, serverPid: 11, supervisorPid: 7 },
        containerBoundaryPidAfter: 401,
        containerBoundaryPidBefore: 401,
        containerIdentity: identity,
      }),
    ).toThrow("minio_restart_evidence_stale");
  });

  it("requires readiness and revalidates unchanged confinement after restart", async () => {
    const events = [];
    const confinement = {
      configurationSha256: "b".repeat(64),
      exactIdentity: identity,
      internalNetwork: `${runId}-network`,
      internalNetworkEndpoint: { ipv4Address: "172.28.0.2", port: 9000 },
    };
    await expect(
      restartConfinedMinio({
        beforeConfinement: confinement,
        docker: {
          restartMinioServerProcess: async () => {
            events.push("server-restarted");
            return restartObservation();
          },
        },
        identity,
        inspectConfinement: async () => {
          events.push("confinement-revalidated");
          return confinement;
        },
        name,
        ready: async () => true,
        waitFor: async (ready) => {
          expect(await ready()).toBe(true);
          events.push("ready");
        },
      }),
    ).resolves.toEqual(processObservation());
    expect(events).toEqual([
      "server-restarted",
      "ready",
      "confinement-revalidated",
    ]);
  });

  it.each([
    ["same generation", { currentServerGeneration: 1 }],
    ["same PID", { currentServerPid: 11 }],
    ["missing readiness", { readinessAfterRestart: false }],
    ["changed boundary", { containerBoundaryStable: false }],
    ["malformed identity", { containerIdentity: "foreign" }],
  ])("rejects malformed final restart evidence: %s", (_, mutation) => {
    expect(() =>
      assertMinioRestartEvidence(processObservation(mutation)),
    ).toThrow("minio_restart_evidence_malformed");
  });

  it("keeps the reviewed supervisor syntactically valid POSIX shell", async () => {
    const supervisor = fileURLToPath(
      new URL("./fixtures/minio-supervisor.sh", import.meta.url),
    );
    await expect(
      executeFile("/bin/sh", ["-n", supervisor]),
    ).resolves.toMatchObject({ stderr: "", stdout: "" });
  });

  it("runs the reviewed supervisor through a real synthetic process restart", async () => {
    const directory = await mkdtemp(join(tmpdir(), "wf-minio-supervisor-"));
    const sourcePath = fileURLToPath(
      new URL("./fixtures/minio-supervisor.sh", import.meta.url),
    );
    const statePath = join(directory, "state");
    const serverPath = join(directory, "synthetic-minio");
    const supervisorPath = join(directory, "supervisor.sh");
    let child;
    try {
      await writeFile(
        serverPath,
        [
          "#!/bin/sh",
          "trap 'exit 0' TERM INT",
          "while :; do /bin/sleep 1; done",
          "",
        ].join("\n"),
        { mode: 0o700 },
      );
      const source = await readFile(sourcePath, "utf8");
      await writeFile(
        supervisorPath,
        source
          .replace(
            "state_file=/tmp/workload-funnel-minio-supervisor.state",
            `state_file=${statePath}`,
          )
          .replace("/usr/bin/minio", serverPath),
        { mode: 0o700 },
      );
      child = spawn("/bin/sh", [supervisorPath, "server", "/data"], {
        detached: true,
        stdio: "ignore",
      });
      const before = await waitForState(statePath, 1);
      expect(before.supervisorPid).toBe(child.pid);
      expect(child.kill("SIGUSR1")).toBe(true);
      const after = await waitForState(statePath, 2);
      expect(after).toMatchObject({
        generation: 2,
        supervisorPid: before.supervisorPid,
      });
      expect(after.serverPid).not.toBe(before.serverPid);
      expect(child.exitCode).toBeNull();
    } finally {
      if (child?.exitCode === null) {
        const exited = new Promise((resolve) => child.once("exit", resolve));
        process.kill(-child.pid, "SIGKILL");
        await Promise.race([exited, delay(2_000)]);
      }
      await rm(directory, { force: true, recursive: true });
    }
  });
});
