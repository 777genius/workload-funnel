import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { fileURLToPath, URL } from "node:url";

import { describe, expect, it, vi } from "vitest";

import { objectContainerArguments } from "./docker-plan.mjs";
import { GateDockerRuntime } from "./docker-runtime.mjs";
import {
  MINIO_SIGNAL_ARGV0,
  MINIO_SIGNAL_SCRIPT,
  MINIO_SIGNAL_SHELL,
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

function signalCommand(supervisorPid) {
  return [
    "exec",
    identity,
    MINIO_SIGNAL_SHELL,
    "-c",
    MINIO_SIGNAL_SCRIPT,
    MINIO_SIGNAL_ARGV0,
    String(supervisorPid),
  ];
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

async function waitForLines(path, count) {
  const deadline = Date.now() + 2_000;
  for (;;) {
    try {
      const lines = (await readFile(path, "utf8")).trim().split("\n");
      if (lines.length >= count) return lines;
    } catch {
      // The synthetic child creates its captures after the supervisor state.
    }
    if (Date.now() >= deadline)
      throw new Error("synthetic_minio_capture_timeout");
    await delay(20);
  }
}

function renderSyntheticSupervisor(source, paths) {
  return source
    .replace(
      "state_file=/tmp/workload-funnel-minio-supervisor.state",
      `state_file=${paths.state}`,
    )
    .replace(
      "expected_root_user_file=/run/secrets/minio-root-user",
      `expected_root_user_file=${paths.user}`,
    )
    .replace(
      "expected_root_password_file=/run/secrets/minio-root-password",
      `expected_root_password_file=${paths.password}`,
    )
    .replace("/usr/bin/minio", paths.server);
}

describe("confined MinIO server-process restart", () => {
  it("passes the exact positive supervisor PID as a positional argument while preserving the boundary", async () => {
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
          if (args[0] === "exec" && args[2] === "/bin/cat")
            return {
              code: 0,
              stderr: "",
              stdout: `${supervisorStates.shift()}\n`,
            };
          if (args[0] === "exec" && args[2] === MINIO_SIGNAL_SHELL)
            return { code: 0, stderr: "", stdout: "" };
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
    expect(
      calls.filter((args) => args[0] === "exec" && args[2] === "/bin/sh"),
    ).toEqual([signalCommand(7)]);
    expect(MINIO_SIGNAL_SCRIPT).toBe('kill -USR1 "$1"');
    expect(MINIO_SIGNAL_SCRIPT).not.toContain("7");
    expect(calls.some((args) => args[0] === "kill")).toBe(false);
    expect(calls.flat()).not.toContain("restart");
    expect(calls.flat()).not.toContain("start");
    expect(supervisorStates).toHaveLength(0);
  });

  it("never accepts a container stop in the Docker command sequence", async () => {
    let stopped = false;
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
              stdout: stopped
                ? `exited|0|${identity}|/${name}|${name}\n`
                : `running|401|${identity}|/${name}|${name}\n`,
            };
          if (args[0] === "exec" && args[2] === "/bin/cat")
            return { code: 0, stderr: "", stdout: `${state(1, 11)}\n` };
          if (args[0] === "exec" && args[2] === MINIO_SIGNAL_SHELL) {
            stopped = true;
            return { code: 0, stderr: "", stdout: "" };
          }
          throw new Error("unexpected_test_command");
        }),
      },
      sandboxRoot: `/tmp/${runId}`,
    });

    await expect(
      runtime.restartMinioServerProcess(name, identity),
    ).rejects.toThrow("minio_restart_container_boundary_unproven");
    expect(calls).toContainEqual(signalCommand(7));
    expect(calls.some((args) => args[0] === "kill")).toBe(false);
    expect(
      calls.filter((args) => args[0] === "exec" && args[2] === "/bin/cat"),
    ).toHaveLength(1);
  });

  it.each([
    "7;exit 0",
    "$(exit 0)",
    "7\nexit 0",
    "-7",
    "0",
    "9007199254740992",
  ])(
    "rejects supervisor PID injection before invoking the signal shell: %s",
    async (supervisorPid) => {
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
            if (args[0] === "exec" && args[2] === "/bin/cat")
              return {
                code: 0,
                stderr: "",
                stdout: `workload-funnel.minio-supervisor.v1|${supervisorPid}|1|11\n`,
              };
            throw new Error("unexpected_test_command");
          }),
        },
        sandboxRoot: `/tmp/${runId}`,
      });

      await expect(
        runtime.restartMinioServerProcess(name, identity),
      ).rejects.toThrow("minio_restart_evidence_malformed");
      expect(calls.some((args) => args[2] === MINIO_SIGNAL_SHELL)).toBe(false);
    },
  );

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

  it("forbids both absolute kill paths in production signaling sources", async () => {
    const productionSources = await Promise.all([
      readFile(
        fileURLToPath(new URL("./minio-process-restart.mjs", import.meta.url)),
        "utf8",
      ),
      readFile(
        fileURLToPath(
          new URL("./fixtures/minio-supervisor.sh", import.meta.url),
        ),
        "utf8",
      ),
    ]);
    for (const forbidden of ["/bin/kill", "/usr/bin/kill"])
      for (const source of productionSources)
        expect(source).not.toContain(forbidden);
  });

  it("keeps the synthetic POSIX supervisor alive across an interrupted wait and racing USR1", async () => {
    const directory = await mkdtemp(join(tmpdir(), "wf-minio-supervisor-"));
    const sourcePath = fileURLToPath(
      new URL("./fixtures/minio-supervisor.sh", import.meta.url),
    );
    const statePath = join(directory, "state");
    const serverPath = join(directory, "synthetic-minio");
    const supervisorPath = join(directory, "supervisor.sh");
    const rootUserFile = join(directory, "minio-root-user");
    const rootPasswordFile = join(directory, "minio-root-password");
    const argvCapture = join(directory, "argv");
    const passwordDigestCapture = join(directory, "password-digest");
    const startupCapture = join(directory, "startups");
    const terminationCapture = join(directory, "terminations");
    const userDigestCapture = join(directory, "user-digest");
    const syntheticRootUser = "wfroot0123456789abcdef";
    const syntheticRootPassword = "synthetic_Root-Password_0123456789";
    let logs = "";
    let child;
    try {
      await writeFile(rootUserFile, `${syntheticRootUser}\n`, { mode: 0o400 });
      await writeFile(rootPasswordFile, `${syntheticRootPassword}\n`, {
        mode: 0o400,
      });
      await writeFile(
        serverPath,
        [
          "#!/bin/sh",
          "set -eu",
          ': > "$WF_GATE_ARGV_CAPTURE"',
          'for argument do /usr/bin/printf "%s\\n" "$argument" >> "$WF_GATE_ARGV_CAPTURE"; done',
          '/usr/bin/printf "%s" "$MINIO_ROOT_USER" | /usr/bin/sha256sum >> "$WF_GATE_USER_DIGEST_CAPTURE"',
          '/usr/bin/printf "%s" "$MINIO_ROOT_PASSWORD" | /usr/bin/sha256sum >> "$WF_GATE_PASSWORD_DIGEST_CAPTURE"',
          '/usr/bin/printf "started\\n" >> "$WF_GATE_STARTUP_CAPTURE"',
          'trap \'/usr/bin/printf "terminating\\n" >> "$WF_GATE_TERMINATION_CAPTURE"; /bin/sleep 0.2; exit 0\' TERM INT',
          "while :; do /bin/sleep 1; done",
          "",
        ].join("\n"),
        { mode: 0o700 },
      );
      const source = await readFile(sourcePath, "utf8");
      await writeFile(
        supervisorPath,
        renderSyntheticSupervisor(source, {
          password: rootPasswordFile,
          server: serverPath,
          state: statePath,
          user: rootUserFile,
        }),
        { mode: 0o700 },
      );
      child = spawn("/bin/sh", [supervisorPath, "server", "/data"], {
        detached: true,
        env: {
          LANG: "C.UTF-8",
          LC_ALL: "C.UTF-8",
          MINIO_ROOT_PASSWORD_FILE: rootPasswordFile,
          MINIO_ROOT_USER_FILE: rootUserFile,
          PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
          TZ: "UTC",
          WF_GATE_ARGV_CAPTURE: argvCapture,
          WF_GATE_PASSWORD_DIGEST_CAPTURE: passwordDigestCapture,
          WF_GATE_STARTUP_CAPTURE: startupCapture,
          WF_GATE_TERMINATION_CAPTURE: terminationCapture,
          WF_GATE_USER_DIGEST_CAPTURE: userDigestCapture,
        },
        stdio: ["ignore", "pipe", "pipe"],
      });
      child.stdout.on("data", (chunk) => (logs += chunk.toString("utf8")));
      child.stderr.on("data", (chunk) => (logs += chunk.toString("utf8")));
      const before = await waitForState(statePath, 1);
      await waitForLines(startupCapture, 1);
      expect(before.supervisorPid).toBe(child.pid);
      expect(child.kill("SIGUSR1")).toBe(true);
      await waitForLines(terminationCapture, 1);
      expect(child.kill("SIGUSR1")).toBe(true);
      const after = await waitForState(statePath, 2);
      await waitForLines(startupCapture, 2);
      expect(after).toMatchObject({
        generation: 2,
        supervisorPid: before.supervisorPid,
      });
      expect(after.serverPid).not.toBe(before.serverPid);
      expect(child.exitCode).toBeNull();
      await delay(300);
      expect(await waitForState(statePath, 2)).toEqual(after);

      const digest = (value) =>
        createHash("sha256").update(value, "utf8").digest("hex");
      expect(await waitForLines(userDigestCapture, 2)).toEqual([
        `${digest(syntheticRootUser)}  -`,
        `${digest(syntheticRootUser)}  -`,
      ]);
      expect(await waitForLines(passwordDigestCapture, 2)).toEqual([
        `${digest(syntheticRootPassword)}  -`,
        `${digest(syntheticRootPassword)}  -`,
      ]);
      expect(await readFile(argvCapture, "utf8")).toBe("server\n/data\n");

      const createMetadata = objectContainerArguments({
        image: `quay.io/minio/minio:test@sha256:${"f".repeat(64)}`,
        ioDevice: "/dev/vda",
        name,
        network: `${runId}-network`,
        rootPasswordFile,
        rootUserFile,
        supervisorFile: supervisorPath,
      });
      for (const credential of [syntheticRootUser, syntheticRootPassword]) {
        expect(logs).not.toContain(credential);
        expect(await readFile(argvCapture, "utf8")).not.toContain(credential);
        expect(JSON.stringify(createMetadata)).not.toContain(credential);
      }
    } finally {
      if (child?.exitCode === null) {
        const exited = new Promise((resolve) => child.once("exit", resolve));
        process.kill(-child.pid, "SIGKILL");
        await Promise.race([exited, delay(2_000)]);
      }
      await rm(directory, { force: true, recursive: true });
    }
  });

  it.each([
    ["empty root-user file", "\n", "valid_Root-Password_0123456789\n"],
    [
      "multi-line root-password file",
      "wfroot0123456789abcdef\n",
      "first_password\nsecond_password\n",
    ],
  ])(
    "refuses a malformed secret before starting MinIO: %s",
    async (_, user, password) => {
      const directory = await mkdtemp(join(tmpdir(), "wf-minio-secret-check-"));
      const sourcePath = fileURLToPath(
        new URL("./fixtures/minio-supervisor.sh", import.meta.url),
      );
      const paths = {
        password: join(directory, "password"),
        server: join(directory, "server"),
        state: join(directory, "state"),
        user: join(directory, "user"),
      };
      const marker = join(directory, "server-started");
      try {
        await writeFile(paths.user, user, { mode: 0o400 });
        await writeFile(paths.password, password, { mode: 0o400 });
        await writeFile(
          paths.server,
          `#!/bin/sh\n/usr/bin/printf started > ${marker}\n`,
          { mode: 0o700 },
        );
        const source = await readFile(sourcePath, "utf8");
        const supervisor = join(directory, "supervisor.sh");
        await writeFile(supervisor, renderSyntheticSupervisor(source, paths), {
          mode: 0o700,
        });
        await expect(
          executeFile("/bin/sh", [supervisor, "server", "/data"], {
            env: {
              MINIO_ROOT_PASSWORD_FILE: paths.password,
              MINIO_ROOT_USER_FILE: paths.user,
            },
          }),
        ).rejects.toMatchObject({ code: 70, stdout: "", stderr: "" });
        await expect(readFile(marker, "utf8")).rejects.toMatchObject({
          code: "ENOENT",
        });
      } finally {
        await rm(directory, { force: true, recursive: true });
      }
    },
  );
});
