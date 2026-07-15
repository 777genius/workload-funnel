import { Buffer } from "node:buffer";
import { EventEmitter } from "node:events";
import { setImmediate } from "node:timers";

import { describe, expect, it, vi } from "vitest";

import { createBoundedHostProcessManager } from "./bounded-host-process.mjs";
import { BoundedCommandRunner } from "./command-runner.mjs";

const runId = "wf-production-gate-0123456789abcdef0123456789abcdef";
const workloadRoot = `/var/lib/workload-funnel/allocations/${runId}`;

function loadedUnitShow(systemdArguments, { foreign = {}, omit = [] } = {}) {
  const description = systemdArguments
    .find((argument) => argument.startsWith("--description="))
    .slice("--description=".length);
  const unit = systemdArguments
    .find((argument) => argument.startsWith("--unit="))
    .slice("--unit=".length);
  const execStopPost =
    systemdArguments
      .find((argument) => argument.startsWith("--property=ExecStopPost="))
      ?.slice("--property=ExecStopPost=".length) ?? "";
  const values = {
    ActiveState: execStopPost === "" ? "active" : "deactivating",
    AmbientCapabilities: "",
    CapabilityBoundingSet: "",
    ControlGroup: `/wf.slice/wf-production.slice/wf-production-gate.slice/${runId}.slice/${unit}`,
    CPUQuotaPerSecUSec: "1s",
    CPUWeight: "100",
    Description: description,
    DevicePolicy: "closed",
    Environment:
      "HOME=/nonexistent LANG=C.UTF-8 LC_ALL=C.UTF-8 PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin TZ=UTC",
    ExecStopPost:
      execStopPost === ""
        ? ""
        : `{ path=/usr/bin/node ; argv[]=${execStopPost} ; ignore_errors=no ; start_time=[n/a] ; stop_time=[n/a] ; pid=1 ; code=(null) ; status=0/0 }`,
    FinalKillSignal: "SIGKILL",
    Group: "workload-funnel-synthetic",
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
    ReadWritePaths: workloadRoot,
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
    User: "workload-funnel-synthetic",
    WorkingDirectory: workloadRoot,
    ...foreign,
  };
  return `${Object.entries(values)
    .filter(([key]) => !omit.includes(key))
    .map(([key, value]) => `${key}=${value}`)
    .join("\n")}\n`;
}

function processManagerHarness(completionResult, propertyOverrides = {}) {
  const events = [];
  const reviewed = [];
  let complete;
  let stopped = false;
  let systemdArguments;
  const completion = new Promise((resolve) => {
    complete = resolve;
  });
  const process = {
    completion,
    kill: vi.fn(() => {
      events.push("kill");
      complete({
        code: null,
        errorCode: "command_failed",
        stderr: "",
        stdout: "",
      });
    }),
  };
  const runner = {
    run: vi.fn((_executable, args) => {
      if (args[0]?.startsWith("--unit=")) {
        systemdArguments = args;
        events.push("run-start");
        return Promise.resolve({ code: 0, stderr: "", stdout: "" });
      }
      if (args[0] === "stop") {
        stopped = true;
        events.push("stop");
        return Promise.resolve({ code: 0, stderr: "", stdout: "" });
      }
      if (args[0] === "reset-failed") {
        events.push("reset");
        return Promise.resolve({ code: 0, stderr: "", stdout: "" });
      }
      if (args[0] === "show" && stopped)
        return Promise.resolve({
          code: 0,
          stderr: "",
          stdout: "ActiveState=inactive\nControlGroup=\nLoadState=loaded\n",
        });
      return Promise.resolve({
        code: 0,
        stderr: "",
        stdout: loadedUnitShow(systemdArguments, propertyOverrides),
      });
    }),
    start: vi.fn((_executable, args) => {
      events.push("start");
      systemdArguments = args;
      return Promise.resolve(process);
    }),
  };
  const manager = createBoundedHostProcessManager({
    allowedExecutables: new Set(["/usr/bin/hq", "/usr/bin/node"]),
    ioDevice: "/dev/vda",
    ledger: {
      finalize: vi.fn(() => {
        events.push("finalize");
        return Promise.resolve();
      }),
      prepare: vi.fn(() => {
        events.push("prepare");
        return Promise.resolve("unit-record");
      }),
    },
    nodeExecutable: "/usr/bin/node",
    removeObservationMarker: vi.fn(() => {
      events.push("remove");
      return Promise.resolve();
    }),
    reviewedExecutables: {
      assertUnchanged: (executable) => {
        reviewed.push(executable);
        return Promise.resolve();
      },
    },
    runId,
    runner,
    sliceOwnership: {
      admit: () => {
        events.push("admit");
        return Promise.resolve();
      },
      register: () => {
        events.push("register");
        return Promise.resolve();
      },
    },
    systemctlExecutable: "/usr/bin/systemctl",
    systemdRunExecutable: "/usr/bin/systemd-run",
    workloadGroup: "workload-funnel-synthetic",
    workloadRoot,
    workloadUser: "workload-funnel-synthetic",
    writeObservationMarker: vi.fn(() => {
      events.push("release");
      complete(completionResult);
      return Promise.resolve();
    }),
  });
  return { events, manager, process, reviewed, runner };
}

describe("systemd 255 bounded synchronous execution compatibility", () => {
  it("measures repeated cancellation convergence around one confined process stop", async () => {
    const harness = processManagerHarness({
      code: 0,
      stderr: "",
      stdout: "",
    });
    const process = await harness.manager.start(
      "/usr/bin/node",
      ["-e", "setInterval(() => {}, 1000)"],
      "cancel-probe",
    );

    await expect(harness.manager.cancel(process)).resolves.toMatchObject({
      cancellationObserved: true,
      confinedCancellationPerformed: true,
      controlGroup: expect.stringMatching(/^\//u),
      invocationId: expect.stringMatching(/^[a-f0-9]{32}$/u),
      killMode: "control-group",
      unit: `${runId}-cancel-probe.service`,
    });
    await expect(harness.manager.cancel(process)).resolves.toMatchObject({
      cancellationObserved: true,
      confinedCancellationPerformed: false,
    });
    expect(
      harness.runner.run.mock.calls.filter(([, args]) => args[0] === "stop"),
    ).toHaveLength(1);
    expect(harness.events).toEqual([
      "prepare",
      "admit",
      "run-start",
      "finalize",
      "register",
      "stop",
    ]);
  });

  it.each([
    ["fast success", { code: 0, stderr: "", stdout: "hq-output\n" }],
    ["nonzero", { code: 7, stderr: "hq-error\n", stdout: "partial\n" }],
    [
      "timeout",
      {
        code: null,
        errorCode: "command_timeout",
        stderr: "",
        stdout: "partial\n",
      },
    ],
    [
      "output limit",
      {
        code: null,
        errorCode: "command_output_limit",
        stderr: "",
        stdout: "bounded",
      },
    ],
  ])(
    "preserves %s results only after durable observation",
    async (_, expected) => {
      const harness = processManagerHarness(expected);
      await expect(
        harness.manager.execute("/usr/bin/hq", ["job", "list"], "hq-cli-1", {
          limits: { maxOutputBytes: 1024, timeoutMs: 2_000 },
        }),
      ).resolves.toEqual(expected);
      expect(harness.events).toEqual([
        "prepare",
        "admit",
        "start",
        "finalize",
        "register",
        "release",
        "stop",
        "reset",
        "remove",
      ]);
      expect(harness.reviewed).toEqual(["/usr/bin/hq", "/usr/bin/node"]);
      expect(harness.runner.start).toHaveBeenCalledWith(
        "/usr/bin/systemd-run",
        expect.arrayContaining([
          "--collect",
          "--wait",
          "--pipe",
          expect.stringMatching(
            /^--property=ExecStopPost=\/usr\/bin\/node .*systemd-observation-window\.mjs .*\.observed-hq-cli-1 4000$/u,
          ),
        ]),
        { maxOutputBytes: 1024, timeoutMs: 2_000 },
      );
      expect(harness.runner.start.mock.calls[0][1]).not.toContain("/bin/sh");
    },
  );

  it.each([
    ["missing", { omit: ["CPUWeight"] }],
    ["foreign", { foreign: { CapabilityBoundingSet: "cap_net_admin" } }],
  ])("fails closed and cleans a unit with %s properties", async (_, change) => {
    const harness = processManagerHarness(
      { code: 0, stderr: "", stdout: "untrusted" },
      change,
    );
    await expect(
      harness.manager.execute("/usr/bin/hq", ["job", "list"], "hq-cli-1"),
    ).rejects.toThrow("bounded_host_process_confinement_unproven");
    expect(harness.events).toEqual([
      "prepare",
      "admit",
      "start",
      "kill",
      "stop",
      "reset",
    ]);
    expect(harness.process.kill).toHaveBeenCalledOnce();
  });

  it("preserves output and classifies timeout or output overflow", async () => {
    const createChild = () => {
      const child = new EventEmitter();
      child.pid = 101;
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.kill = vi.fn(() => {
        setImmediate(() => child.emit("close", null, "SIGKILL"));
        return true;
      });
      return child;
    };

    const nonzeroChild = createChild();
    const nonzeroRunner = new BoundedCommandRunner({
      reviewedExecutables: { assertUnchanged: () => Promise.resolve() },
      spawn: () => nonzeroChild,
    });
    const nonzero = await nonzeroRunner.start("/usr/bin/systemd-run", [], {
      maxOutputBytes: 64,
      timeoutMs: 100,
    });
    nonzeroChild.stdout.emit("data", Buffer.from("hq-output\n"));
    nonzeroChild.stderr.emit("data", Buffer.from("hq-error\n"));
    nonzeroChild.emit("close", 7, null);
    await expect(nonzero.completion).resolves.toEqual({
      code: 7,
      stderr: "hq-error\n",
      stdout: "hq-output\n",
    });

    const outputChild = createChild();
    const outputRunner = new BoundedCommandRunner({
      reviewedExecutables: { assertUnchanged: () => Promise.resolve() },
      spawn: () => outputChild,
    });
    const output = await outputRunner.start("/usr/bin/systemd-run", [], {
      maxOutputBytes: 4,
      timeoutMs: 100,
    });
    outputChild.stdout.emit("data", Buffer.from("12345"));
    await expect(output.completion).resolves.toEqual({
      code: null,
      errorCode: "command_output_limit",
      stderr: "",
      stdout: "",
    });

    const timeoutChild = createChild();
    const timeoutRunner = new BoundedCommandRunner({
      reviewedExecutables: { assertUnchanged: () => Promise.resolve() },
      spawn: () => timeoutChild,
    });
    const timeout = await timeoutRunner.start("/usr/bin/systemd-run", [], {
      maxOutputBytes: 4,
      timeoutMs: 1,
    });
    await expect(timeout.completion).resolves.toEqual({
      code: null,
      errorCode: "command_timeout",
      stderr: "",
      stdout: "",
    });
  });
});
