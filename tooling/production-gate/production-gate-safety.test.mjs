import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath, URL } from "node:url";

import { describe, expect, it, vi } from "vitest";

import {
  boundedHostSystemdArguments,
  exactBoundedHostPropertiesObserved,
} from "./bounded-host-process.mjs";
import { BoundedCommandRunner } from "./command-runner.mjs";
import {
  MINIMAL_COMMAND_ENVIRONMENT,
  OBJECT_FIXTURE_IMAGE,
  POSTGRES_FIXTURE_IMAGE,
} from "./constants.mjs";
import {
  assertSafeDockerArguments,
  objectContainerArguments,
  postgresContainerArguments,
} from "./docker-plan.mjs";
import { GateDockerRuntime } from "./docker-runtime.mjs";
import {
  inspectCanonicalExecutable,
  ReviewedExecutableSet,
} from "./executable-identity.mjs";
import { classifyPressure } from "./pressure.mjs";
import { probeRealSystemdCapabilities } from "./systemd-capability-probe.mjs";

const runId = "wf-production-gate-0123456789abcdef0123456789abcdef";
const executeFile = promisify(execFile);

describe("production gate host safety", () => {
  it("replaces the host environment and checks reviewed identity before exec", async () => {
    process.env.WF_ADVERSARIAL_HOST_SECRET = "must-not-escape";
    const events = [];
    let invokedEnvironment;
    const runner = new BoundedCommandRunner({
      executeFile: async (_executable, _args, options) => {
        events.push("execute");
        invokedEnvironment = options.env;
        return { stderr: "", stdout: "ok" };
      },
      reviewedExecutables: {
        assertUnchanged: async () => events.push("identity"),
      },
    });
    await runner.run("/usr/bin/true", [], {
      environment: { PGAPPNAME: "gate" },
      timeoutMs: 100,
    });
    expect(events).toEqual(["identity", "execute"]);
    expect(invokedEnvironment).toEqual({
      ...MINIMAL_COMMAND_ENVIRONMENT,
      PGAPPNAME: "gate",
    });
    expect(invokedEnvironment).not.toHaveProperty("WF_ADVERSARIAL_HOST_SECRET");
    await expect(
      runner.run("/usr/bin/true", [], { environment: { PATH: "/tmp" } }),
    ).rejects.toThrow("unsafe_gate_command_environment");

    const refused = new BoundedCommandRunner({
      executeFile: vi.fn(),
      reviewedExecutables: {
        assertUnchanged: () =>
          Promise.reject(new Error("gate_executable_identity_changed")),
      },
    });
    await expect(refused.run("/usr/bin/true", [])).rejects.toThrow(
      "gate_executable_identity_changed",
    );
    expect(refused.executeFile).not.toHaveBeenCalled();
    delete process.env.WF_ADVERSARIAL_HOST_SECRET;
  });

  it("renders a fixed non-root, capability-empty, network-private unit", () => {
    const plan = boundedHostSystemdArguments(
      {
        allowedExecutables: new Set(["/usr/bin/node"]),
        ioDevice: "/dev/vda",
        runId,
        workloadGroup: "workload-funnel-synthetic",
        workloadRoot: `/var/lib/workload-funnel/allocations/${runId}`,
        workloadUser: "workload-funnel-synthetic",
      },
      {
        executable: "/usr/bin/node",
        executableArguments: ["--version"],
        role: "probe",
      },
    );
    expect(plan.arguments).toEqual(
      expect.arrayContaining([
        "--property=User=workload-funnel-synthetic",
        "--property=Group=workload-funnel-synthetic",
        "--property=AmbientCapabilities=",
        "--property=CapabilityBoundingSet=",
        "--property=DevicePolicy=closed",
        "--property=PrivateNetwork=yes",
        "--property=ProtectSystem=strict",
        "--property=NoNewPrivileges=yes",
        "--property=KillMode=control-group",
        "--setenv=HOME=/nonexistent",
      ]),
    );
    expect(() =>
      boundedHostSystemdArguments(
        {
          allowedExecutables: new Set(["/usr/bin/node"]),
          ioDevice: "/dev/vda",
          runId,
          workloadGroup: "root",
          workloadRoot: "/",
          workloadUser: "root",
        },
        {
          executable: "/usr/bin/node",
          executableArguments: [],
          role: "probe",
        },
      ),
    ).toThrow("bounded_host_process_invocation_invalid");
  });

  it("refuses executable digest, inode, mode, and canonical-path drift", async () => {
    if (process.getuid?.() !== 0) return;
    const root = await realpath(process.cwd());
    const directory = `${root}/.gate-executable-test-${process.pid}-${Date.now()}`;
    const executable = `${directory}/reviewed`;
    await mkdir(directory, { mode: 0o700 });
    try {
      await writeFile(executable, "#!/bin/sh\nexit 0\n", {
        flag: "wx",
        mode: 0o500,
      });
      const identity = await inspectCanonicalExecutable(executable);
      const reviewed = new ReviewedExecutableSet([identity]);
      await expect(
        reviewed.assertUnchanged(executable),
      ).resolves.toBeUndefined();
      await rename(executable, `${executable}.replaced`);
      await writeFile(executable, "#!/bin/sh\nexit 1\n", {
        flag: "wx",
        mode: 0o500,
      });
      await expect(reviewed.assertUnchanged(executable)).rejects.toThrow(
        "gate_executable_identity_changed",
      );
      await chmod(executable, 0o722);
      await expect(inspectCanonicalExecutable(executable)).rejects.toThrow(
        "gate_executable_owner_or_mode_untrusted",
      );
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  it("fails closed when a launched unit omits one reviewed confinement property", () => {
    const plan = {
      description: `WorkloadFunnel production gate ${runId} probe`,
    };
    const config = {
      ioDevice: "/dev/vda",
      runId,
      workloadGroup: "workload-funnel-synthetic",
      workloadRoot: `/var/lib/workload-funnel/allocations/${runId}`,
      workloadUser: "workload-funnel-synthetic",
    };
    const values = {
      ActiveState: "active",
      AmbientCapabilities: "",
      CapabilityBoundingSet: "",
      ControlGroup: `/gate.slice/${runId}-probe.service`,
      CPUQuotaPerSecUSec: "1s",
      CPUWeight: "100",
      Description: plan.description,
      DevicePolicy: "closed",
      Environment:
        "HOME=/nonexistent LANG=C.UTF-8 LC_ALL=C.UTF-8 PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin TZ=UTC",
      FinalKillSignal: "SIGKILL",
      Group: config.workloadGroup,
      IOReadBandwidthMax: "/dev/vda 16M",
      IOWeight: "100",
      IOWriteBandwidthMax: "/dev/vda 8M",
      InvocationID: "a".repeat(32),
      JoinsNamespaceOf: "",
      KillMode: "control-group",
      KillSignal: "SIGTERM",
      LimitFSIZE: "67108864",
      LimitNOFILE: "1024",
      LoadState: "loaded",
      LockPersonality: "yes",
      MemoryHigh: "384M",
      MemoryMax: "512M",
      MemorySwapMax: "0",
      NoNewPrivileges: "yes",
      PrivateDevices: "yes",
      PrivateNetwork: "yes",
      PrivateTmp: "yes",
      ProcSubset: "pid",
      ProtectClock: "yes",
      ProtectControlGroups: "yes",
      ProtectHome: "yes",
      ProtectHostname: "yes",
      ProtectKernelLogs: "yes",
      ProtectKernelModules: "yes",
      ProtectKernelTunables: "yes",
      ProtectProc: "invisible",
      ProtectSystem: "strict",
      ReadWritePaths: config.workloadRoot,
      RestrictAddressFamilies: "AF_INET6 AF_UNIX AF_INET",
      RestrictNamespaces: "yes",
      RestrictRealtime: "yes",
      RestrictSUIDSGID: "yes",
      RuntimeMaxUSec: "30s",
      SendSIGKILL: "yes",
      Slice: `${runId}.slice`,
      SystemCallArchitectures: "native",
      SystemCallFilter: "@system-service ~@mount",
      TasksMax: "128",
      TimeoutStopUSec: "5s",
      UMask: "0077",
      User: config.workloadUser,
      WorkingDirectory: config.workloadRoot,
    };
    expect(
      exactBoundedHostPropertiesObserved(values, config, plan, undefined),
    ).toBe(true);
    expect(() =>
      exactBoundedHostPropertiesObserved(
        { ...values, CapabilityBoundingSet: "cap_net_admin" },
        config,
        plan,
        undefined,
      ),
    ).toThrow("bounded_host_process_confinement_unproven");
  });

  it("keeps secrets out of hardened Docker create metadata", async () => {
    const fakeCredential = ["adversarial", runId, "credential"].join("-");
    const postgresData = `/var/data/workload-funnel/sandboxes/${runId}/postgres-data`;
    const postgres = postgresContainerArguments({
      database: "wf_gate",
      dataDirectory: postgresData,
      image: POSTGRES_FIXTURE_IMAGE,
      ioDevice: "/dev/vda",
      name: `${runId}-postgres`,
      network: `${runId}-network`,
      passwordFile: `/tmp/${runId}/postgres-${fakeCredential.length}`,
      user: "wf_gate",
    });
    const object = objectContainerArguments({
      image: OBJECT_FIXTURE_IMAGE,
      ioDevice: "/dev/vda",
      name: `${runId}-object`,
      network: `${runId}-network`,
      rootPasswordFile: `/tmp/${runId}/root-password-file`,
      rootUserFile: `/tmp/${runId}/root-user-file`,
    });
    for (const args of [postgres, object]) {
      expect(args.join("\n")).not.toContain(fakeCredential);
      expect(args).not.toContain("--env-file");
      expect(args).toEqual(
        expect.arrayContaining([
          "--cap-drop",
          "ALL",
          "--read-only",
          "--init",
          "--ipc=private",
          "--security-opt",
          "no-new-privileges=true",
        ]),
      );
    }
    expect(postgres.join("\n")).toContain(
      `type=bind,src=${postgresData},dst=/var/lib/postgresql/data,bind-propagation=rprivate`,
    );
    expect(postgres).not.toContain("--uts=private");
    expect(postgres.join("\n")).not.toContain(",rw,");
    expect(postgres.join("\n")).toContain("POSTGRES_PASSWORD_FILE=");
    expect(object.join("\n")).toContain("MINIO_ROOT_PASSWORD_FILE=");
    expect(() =>
      assertSafeDockerArguments(["create", "--env-file", "/tmp/secret"]),
    ).toThrow("unsafe_docker_gate_arguments");

    const inspected = {
      Config: {
        Env: ["POSTGRES_PASSWORD_FILE=/run/secrets/password"],
        User: "70:70",
      },
      HostConfig: {
        CapDrop: ["ALL"],
        Init: true,
        IpcMode: "private",
        Memory: 2_147_483_648,
        MemorySwap: 2_147_483_648,
        NanoCpus: 2_000_000_000,
        NetworkMode: `${runId}-network`,
        PidsLimit: 256,
        PortBindings: {
          "5432/tcp": [{ HostIp: "127.0.0.1", HostPort: "0" }],
        },
        Privileged: false,
        ReadonlyRootfs: true,
        RestartPolicy: { Name: "no" },
        SecurityOpt: ["no-new-privileges=true"],
        Tmpfs: { "/tmp": "rw,size=67108864" },
        UTSMode: "",
      },
      Id: "a".repeat(64),
      Image: `sha256:${"b".repeat(64)}`,
      Mounts: [
        {
          Destination: "/var/lib/postgresql/data",
          Propagation: "rprivate",
          RW: true,
          Source: postgresData,
          Type: "bind",
        },
      ],
      NetworkSettings: {
        Ports: {
          "5432/tcp": [{ HostIp: "127.0.0.1", HostPort: "49152" }],
        },
      },
    };
    const inspectOutput = { value: JSON.stringify([inspected]) };
    const runtime = new GateDockerRuntime({
      executable: "/usr/bin/docker",
      ioDevice: "/dev/vda",
      runId,
      runner: {
        run: () =>
          Promise.resolve({ code: 0, stderr: "", stdout: inspectOutput.value }),
      },
      sandboxRoot: `/tmp/${runId}`,
    });
    await expect(
      runtime.inspectContainerConfinement(
        `${runId}-postgres`,
        "70:70",
        [fakeCredential],
        undefined,
        {
          destination: "/var/lib/postgresql/data",
          kind: "bind",
          source: postgresData,
        },
        5432,
      ),
    ).resolves.toMatchObject({ metadataSecretValuesAbsent: true });
    inspected.Config.Env.push(`UNSAFE=${fakeCredential}`);
    inspectOutput.value = JSON.stringify([inspected]);
    await expect(
      runtime.inspectContainerConfinement(
        `${runId}-postgres`,
        "70:70",
        [fakeCredential],
        undefined,
        {
          destination: "/var/lib/postgresql/data",
          kind: "bind",
          source: postgresData,
        },
        5432,
      ),
    ).rejects.toThrow("docker_container_metadata_contains_secret");

    const client = {
      Config: { Cmd: ["/gate/bootstrap.sh", "ready"], User: "1000:1000" },
      HostConfig: {
        CapDrop: ["ALL"],
        Init: true,
        IpcMode: "private",
        Memory: 268_435_456,
        MemorySwap: 268_435_456,
        NanoCpus: 1_000_000_000,
        NetworkMode: `${runId}-network`,
        PidsLimit: 64,
        PortBindings: {},
        Privileged: false,
        ReadonlyRootfs: true,
        RestartPolicy: { Name: "no" },
        SecurityOpt: ["no-new-privileges=true"],
        Tmpfs: { "/tmp": "rw,size=16777216" },
        UTSMode: "",
      },
      Id: "c".repeat(64),
    };
    inspectOutput.value = JSON.stringify([client]);
    runtime.secretValues = [fakeCredential];
    await expect(
      runtime.inspectClientConfinement(`${runId}-client-1`, client.Id),
    ).resolves.toBe(true);
    client.Config.Cmd.push(fakeCredential);
    inspectOutput.value = JSON.stringify([client]);
    await expect(
      runtime.inspectClientConfinement(`${runId}-client-1`, client.Id),
    ).rejects.toThrow("docker_container_metadata_contains_secret");
  });

  it("pipes MinIO credentials to the real bootstrap call without argv or environment disclosure", async () => {
    const directory = await mkdtemp(join(tmpdir(), "wf-minio-bootstrap-"));
    const fixturePath = fileURLToPath(
      new URL("./fixtures/minio-bootstrap.sh", import.meta.url),
    );
    const executable = join(directory, "mc-fake");
    const bootstrap = join(directory, "bootstrap.sh");
    const credentialFile = join(directory, "identity");
    const argvCapture = join(directory, "argv");
    const stdinCapture = join(directory, "stdin");
    const credentialMarker = ["fixture", runId, "value"].join(":");
    try {
      const source = await readFile(fixturePath, "utf8");
      const invocation = "/usr/bin/mc admin user add gate";
      expect(source.split(invocation)).toHaveLength(2);
      await writeFile(
        executable,
        [
          "#!/bin/sh",
          "set -eu",
          ': > "$WF_GATE_ARGV_CAPTURE"',
          'for argument do /usr/bin/printf "%s\\n" "$argument" >> "$WF_GATE_ARGV_CAPTURE"; done',
          'if [ "$*" = "admin user add gate" ]; then /bin/cat > "$WF_GATE_STDIN_CAPTURE"; fi',
          "",
        ].join("\n"),
        { mode: 0o700 },
      );
      await writeFile(bootstrap, source.replaceAll("/usr/bin/mc", executable), {
        mode: 0o700,
      });
      await writeFile(
        credentialFile,
        `wfupload${runId.slice(-12)}\n${credentialMarker}\n`,
        { mode: 0o400 },
      );
      const result = await executeFile(
        "/bin/sh",
        [bootstrap, "add-user", credentialFile],
        {
          env: {
            ...MINIMAL_COMMAND_ENVIRONMENT,
            WF_GATE_ARGV_CAPTURE: argvCapture,
            WF_GATE_STDIN_CAPTURE: stdinCapture,
          },
        },
      );
      expect(await readFile(argvCapture, "utf8")).toBe(
        "admin\nuser\nadd\ngate\n",
      );
      expect(await readFile(stdinCapture, "utf8")).toBe(
        `wfupload${runId.slice(-12)}\n${credentialMarker}\n`,
      );
      expect(JSON.stringify(result)).not.toContain(credentialMarker);
      expect(
        JSON.stringify({
          ...MINIMAL_COMMAND_ENVIRONMENT,
          WF_GATE_ARGV_CAPTURE: argvCapture,
          WF_GATE_STDIN_CAPTURE: stdinCapture,
        }),
      ).not.toContain(credentialMarker);

      const deterministicUser = `wfupload${runId.slice(-12)}`;
      await executeFile(
        "/bin/sh",
        [bootstrap, "attach-policy", `${runId}-upload`, deterministicUser],
        {
          env: {
            ...MINIMAL_COMMAND_ENVIRONMENT,
            WF_GATE_ARGV_CAPTURE: argvCapture,
            WF_GATE_STDIN_CAPTURE: stdinCapture,
          },
        },
      );
      expect(await readFile(argvCapture, "utf8")).toBe(
        `admin\npolicy\nattach\ngate\n${runId}-upload\n--user\n${deterministicUser}\n`,
      );
      expect(await readFile(argvCapture, "utf8")).not.toContain(
        credentialMarker,
      );
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  it("proves a SIGKILL container-process crash before restarting the same Postgres container", async () => {
    const identity = "d".repeat(64);
    const outputs = [
      `running|101|${identity}`,
      `${runId}-postgres`,
      `exited|137|false|0|${identity}`,
      `${runId}-postgres`,
      `running|202|${identity}`,
    ];
    const calls = [];
    const events = [];
    const runtime = new GateDockerRuntime({
      executable: "/usr/bin/docker",
      ioDevice: "/dev/vda",
      runId,
      runner: {
        run: async (_executable, args) => {
          calls.push(args);
          return { code: 0, stderr: "", stdout: `${outputs.shift()}\n` };
        },
      },
      sandboxRoot: `/tmp/${runId}`,
    });
    await expect(
      runtime.crashAndRestart(`${runId}-postgres`, identity, async () => {
        events.push("client-observed-server-crash");
      }),
    ).resolves.toMatchObject({
      containerIdentityStable: true,
      exitCode: 137,
      processBoundaryStopped: true,
      signal: "SIGKILL",
    });
    expect(events).toEqual(["client-observed-server-crash"]);
    expect(calls).toEqual(
      expect.arrayContaining([
        ["kill", "--signal=KILL", `${runId}-postgres`],
        ["container", "start", `${runId}-postgres`],
      ]),
    );
    expect(calls.flat()).not.toContain("restart");
    expect(outputs).toHaveLength(0);
  });

  it("uses only a non-mutating real-systemd capability preflight", async () => {
    const directory = join(
      tmpdir(),
      `wf-systemd-capability-${process.pid}-${Date.now()}`,
    );
    await mkdir(directory, { mode: 0o700 });
    const calls = [];
    try {
      const result = await probeRealSystemdCapabilities(
        {
          ioDevice: "/dev/vda",
          nodeExecutable: "/usr/bin/node",
          runner: {
            run: async (executable, args) => {
              calls.push([executable, args]);
              if (executable !== "/usr/bin/systemctl")
                return { code: 0, stderr: "", stdout: "" };
              return args[0] === "--version"
                ? { code: 0, stderr: "", stdout: "systemd 255 (255.1)\n" }
                : { code: 0, stderr: "", stdout: "255.1\n" };
            },
          },
          sandboxRoot: directory,
          systemctlExecutable: "/usr/bin/systemctl",
          systemdAnalyzeExecutable: "/usr/bin/systemd-analyze",
          workloadGroup: "workload-funnel-synthetic",
          workloadRoot: `/var/lib/workload-funnel/allocations/${runId}`,
          workloadUser: "workload-funnel-synthetic",
        },
        {
          hostPlatform: () => "linux",
          read: () => Promise.resolve("cpu io memory pids\n"),
          write: writeFile,
        },
      );
      expect(result.report.evidenceSource).toBe("disposable_linux_host");
      expect(result.report.capabilities.ephemeral_disk_quota).toBe(false);
      expect(calls).toHaveLength(3);
      expect(calls[1][1]).toEqual([
        "show",
        "--property=Version",
        "--value",
        "--no-pager",
      ]);
      expect(calls[2][1].slice(0, 2)).toEqual(["--man=no", "verify"]);
      expect(calls.flatMap(([, args]) => args)).not.toEqual(
        expect.arrayContaining(["start", "run"]),
      );
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  it("classifies bounded gate disk and inode pressure independently", () => {
    const base = {
      cpuPsiSome: 0,
      gateDiskUsedRatio: 0,
      gateInodeUsedRatio: 0,
      ioPsiSome: 0,
      loadPerCpu: 0,
      memoryAvailableRatio: 0.8,
      memoryPsiSome: 0,
      nowMs: 1,
      observedAtMs: 1,
    };
    expect(
      classifyPressure({ ...base, gateDiskUsedRatio: 0.8 }).reasons,
    ).toContain("gate_disk");
    expect(
      classifyPressure({ ...base, gateInodeUsedRatio: 0.8 }).reasons,
    ).toContain("gate_inodes");
  });
});
