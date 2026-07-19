import { Buffer } from "node:buffer";
import { spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { setImmediate } from "node:timers";
import { fileURLToPath, URL } from "node:url";

import { describe, expect, it, vi } from "vitest";

import { createBoundedHostProcessManager } from "./bounded-host-process.mjs";
import { BoundedCommandRunner } from "./command-runner.mjs";
import {
  HYPERQUEUE_GATEWAY_PROBE_TIMEOUT_MS,
  HYPERQUEUE_SERVICE_RUNTIME_MAX_SEC,
} from "./constants.mjs";
import { parseGatewayProbeResult } from "./hyperqueue-contract.mjs";
import {
  exactSystemdObservationWindowInput,
  SYSTEMD_OBSERVATION_WINDOW_TIMEOUT_MS,
} from "./systemd-observation-window-contract.mjs";

const runId = "wf-production-gate-0123456789abcdef0123456789abcdef";
const workloadRoot = `/var/lib/workload-funnel/allocations/${runId}`;

describe("HyperQueue gateway probe failure diagnostics", () => {
  it("emits one bounded diagnostic envelope without stderr", () => {
    const result = spawnSync(
      process.execPath,
      [
        fileURLToPath(
          new URL("./fixtures/hyperqueue-gateway-probe.mjs", import.meta.url),
        ),
      ],
      {
        encoding: "utf8",
        env: { LANG: "C.UTF-8", LC_ALL: "C.UTF-8", TZ: "UTC" },
        timeout: 5_000,
      },
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toBe("");
    expect(result.stdout).toBe(
      '{"failureReason":"hyperqueue_gateway_probe_arguments_invalid"}\n',
    );
  });

  it("preserves one exact reviewed failure reason", () => {
    let failure;
    try {
      parseGatewayProbeResult(
        {
          code: 1,
          stderr: "untrusted wrapper diagnostic",
          stdout:
            '{"failureReason":"hyperqueue_gateway_probe_restart_recovery_failed"}\n',
          systemdResult: "exit-code",
        },
        "submit-and-recover",
      );
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(Error);
    expect(failure.message).toBe(
      "hyperqueue_gateway_probe_restart_recovery_failed",
    );
  });

  it.each([
    ["foreign namespace", '{"failureReason":"foreign_secret_value"}\n'],
    [
      "additional field",
      '{"failureReason":"hyperqueue_gateway_probe_failed","extra":true}\n',
    ],
    ["multiline output", '{"failureReason":"gateway_failed"}\n{}\n'],
  ])("fails closed for a %s", (_, stdout) => {
    expect(() =>
      parseGatewayProbeResult(
        { code: 1, stderr: "", stdout },
        "submit-and-recover",
      ),
    ).toThrow("hyperqueue_gateway_probe_execution_failed");
  });

  it.each([
    ["command_failed", "hyperqueue_gateway_probe_wrapper_failed"],
    ["command_output_limit", "hyperqueue_gateway_probe_output_limit"],
    ["command_timeout", "hyperqueue_gateway_probe_wrapper_timeout"],
  ])(
    "classifies bounded runner %s without exposing output",
    (errorCode, reason) => {
      expect(() =>
        parseGatewayProbeResult(
          {
            code: null,
            errorCode,
            stderr: "untrusted wrapper diagnostic",
            stdout: "untrusted wrapper output",
          },
          "submit-and-recover",
        ),
      ).toThrow(reason);
    },
  );

  it("gives the hosted gateway probe bounded headroom for durable recovery", async () => {
    const harness = processManagerHarness({
      code: 0,
      stderr: "",
      stdout: "gateway-evidence\n",
    });

    await expect(
      harness.manager.execute(
        "/usr/bin/node",
        ["/reviewed/hyperqueue-gateway-probe.mjs"],
        "hq-gateway-submit",
        { limits: { timeoutMs: HYPERQUEUE_GATEWAY_PROBE_TIMEOUT_MS } },
      ),
    ).resolves.toMatchObject({ code: 0 });
    expect(harness.runner.start).toHaveBeenCalledWith(
      "/usr/bin/systemd-run",
      expect.arrayContaining(["--property=RuntimeMaxSec=45s"]),
      { timeoutMs: 92_000 },
    );
  });

  it("fails closed for an unknown bounded runner failure", () => {
    expect(() =>
      parseGatewayProbeResult({ code: null, errorCode: "unknown" }),
    ).toThrow("hyperqueue_gateway_probe_execution_failed");
  });

  it.each([
    ["oom-kill", "hyperqueue_gateway_probe_memory_limit"],
    ["signal", "hyperqueue_gateway_probe_child_signaled"],
    ["timeout", "hyperqueue_gateway_probe_wrapper_timeout"],
  ])("classifies reviewed systemd result %s", (systemdResult, reason) => {
    expect(() =>
      parseGatewayProbeResult({
        code: 1,
        stderr: "",
        stdout: "",
        systemdResult,
      }),
    ).toThrow(reason);
  });

  it.each([
    ["", "", "hyperqueue_gateway_probe_child_output_missing"],
    [
      "",
      "untrusted stderr",
      "hyperqueue_gateway_probe_child_output_missing_with_stderr",
    ],
    ["x".repeat(257), "", "hyperqueue_gateway_probe_child_output_oversized"],
    ["not-newline", "", "hyperqueue_gateway_probe_child_output_shape_invalid"],
    ["unknown\n", "", "hyperqueue_gateway_probe_child_output_unrecognized"],
  ])(
    "classifies exit-code output shape without exposing bytes",
    (stdout, stderr, reason) => {
      expect(() =>
        parseGatewayProbeResult({
          code: 1,
          stderr,
          stdout,
          systemdResult: "exit-code",
        }),
      ).toThrow(reason);
    },
  );
});

function loadedUnitShow(systemdArguments, { foreign = {}, omit = [] } = {}) {
  const description = systemdArguments
    .find((argument) => argument.startsWith("--description="))
    .slice("--description=".length);
  const unit = systemdArguments
    .find((argument) => argument.startsWith("--unit="))
    .slice("--unit=".length);
  const execStartPre =
    systemdArguments
      .find((argument) => argument.startsWith("--property=ExecStartPre="))
      ?.slice("--property=ExecStartPre=".length) ?? "";
  const property = (name) =>
    systemdArguments
      .find((argument) => argument.startsWith(`--property=${name}=`))
      .slice(`--property=${name}=`.length);
  const values = {
    ActiveState: execStartPre === "" ? "active" : "activating",
    AmbientCapabilities: "",
    CapabilityBoundingSet: "",
    ControlGroup: `/wf.slice/wf-production.slice/wf-production-gate.slice/${runId}.slice/${unit}`,
    CPUQuotaPerSecUSec: "1s",
    CPUWeight: "100",
    Description: description,
    DevicePolicy: "closed",
    Environment:
      "HOME=/nonexistent LANG=C.UTF-8 LC_ALL=C.UTF-8 PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin TZ=UTC",
    ExecStartPre:
      execStartPre === ""
        ? ""
        : `{ path=/usr/bin/node ; argv[]=${execStartPre} ; ignore_errors=no ; start_time=[n/a] ; stop_time=[n/a] ; pid=1 ; code=(null) ; status=0/0 }`,
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
    Result: "exit-code",
    RuntimeMaxUSec: property("RuntimeMaxSec"),
    SendSIGKILL: "yes",
    Slice: `${runId}.slice`,
    SystemCallArchitectures: "native",
    SystemCallFilter: "read write",
    TasksMax: "128",
    TimeoutStopUSec: property("TimeoutStopSec"),
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

function processManagerHarness(
  completionResult,
  propertyOverrides = {},
  stopResult = { code: 0, stderr: "", stdout: "" },
) {
  const events = [];
  const observedUnitProperties = [];
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
        if (stopResult.code === 0) stopped = true;
        events.push("stop");
        return Promise.resolve(stopResult);
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
      const overrides =
        typeof propertyOverrides === "function"
          ? propertyOverrides(observedUnitProperties.length)
          : propertyOverrides;
      const stdout = loadedUnitShow(systemdArguments, overrides);
      observedUnitProperties.push(stdout);
      return Promise.resolve({
        code: 0,
        stderr: "",
        stdout,
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
  return {
    events,
    manager,
    observedUnitProperties,
    process,
    reviewed,
    runner,
  };
}

describe("systemd 255 bounded synchronous execution compatibility", () => {
  it("binds the caller and observation fixture to one exact timeout", () => {
    const marker = `${workloadRoot}/.observed-hq-cli-1`;
    expect(SYSTEMD_OBSERVATION_WINDOW_TIMEOUT_MS).toBe(30_000);
    expect(
      exactSystemdObservationWindowInput(
        marker,
        SYSTEMD_OBSERVATION_WINDOW_TIMEOUT_MS,
      ),
    ).toBe(true);
    for (const timeoutMs of [10_000, 29_999, 30_001])
      expect(exactSystemdObservationWindowInput(marker, timeoutMs)).toBe(false);
  });

  it.each([
    ["active state", { ActiveState: "active" }, "active_state_active"],
    [
      "deactivating state",
      { ActiveState: "deactivating" },
      "active_state_deactivating",
    ],
    ["failed state", { ActiveState: "failed" }, "active_state_failed"],
    ["unknown state", { ActiveState: "foreign" }, "active_state_other"],
    ["empty control group", { ControlGroup: "" }, "control_group"],
    ["missing pre-start barrier", { ExecStartPre: "" }, "prestart_barrier"],
  ])(
    "does not release a synchronous payload with %s",
    async (_, foreign, reason) => {
      const harness = processManagerHarness(
        { code: 0, stderr: "", stdout: "untrusted" },
        { foreign },
      );

      await expect(
        harness.manager.execute("/usr/bin/hq", ["worker", "list"], "hq-cli-1"),
      ).rejects.toThrow(`bounded_host_process_${reason}_unproven`);
      expect(harness.events).not.toContain("release");
    },
  );

  it("forwards the exact pressure runtime through launch and observation", async () => {
    const harness = processManagerHarness(
      { code: 0, stderr: "", stdout: "" },
      { foreign: { RuntimeMaxUSec: "1min 15s" } },
    );

    const process = await harness.manager.start(
      "/usr/bin/node",
      ["-e", "setInterval(() => {}, 1000)"],
      "pressure-cpu",
      { runtimeMaxSec: 75 },
    );

    expect(harness.runner.run).toHaveBeenCalledWith(
      "/usr/bin/systemd-run",
      expect.arrayContaining(["--property=RuntimeMaxSec=75s"]),
      { timeoutMs: 10_000 },
    );
    expect(
      harness.runner.run.mock.calls.some(
        ([executable, arguments_]) =>
          executable === "/usr/bin/systemctl" &&
          arguments_[0] === "show" &&
          arguments_.some(
            (argument) =>
              argument.startsWith("--property=") &&
              argument.includes("RuntimeMaxUSec"),
          ),
      ),
    ).toBe(true);
    const verified = await harness.manager.verify(process);
    expect(harness.observedUnitProperties).toHaveLength(2);
    expect(harness.observedUnitProperties).toEqual([
      expect.stringContaining("RuntimeMaxUSec=1min 15s\n"),
      expect.stringContaining("RuntimeMaxUSec=1min 15s\n"),
    ]);
    expect(process.runtimeMaxSec).toBe(75);
    expect(verified).toEqual({
      active: true,
      controlGroup: process.controlGroup,
      invocationId: process.invocationId,
      runtimeMaxSec: 75,
      unit: process.unit,
    });
  });

  it("waits for a restarted long-lived unit to leave its collected inactive state", async () => {
    const harness = processManagerHarness(
      { code: 0, stderr: "", stdout: "" },
      (observation) =>
        observation === 0
          ? {
              foreign: {
                ActiveState: "inactive",
                ControlGroup: "",
              },
            }
          : {},
    );

    const process = await harness.manager.start(
      "/usr/bin/hq",
      ["--server-dir", `${workloadRoot}/hq-server`, "server", "start"],
      "hq-server",
      { runtimeMaxSec: HYPERQUEUE_SERVICE_RUNTIME_MAX_SEC },
    );

    expect(harness.observedUnitProperties).toHaveLength(2);
    expect(harness.observedUnitProperties[0]).toContain(
      "ActiveState=inactive\n",
    );
    expect(harness.observedUnitProperties[1]).toContain("ActiveState=active\n");
    expect(process).toMatchObject({
      controlGroup: expect.stringMatching(/^\//u),
      runtimeMaxSec: HYPERQUEUE_SERVICE_RUNTIME_MAX_SEC,
    });
  });

  it.each([
    ["1min", 60],
    ["1min 30s", 90],
    ["75s", 75],
    ["75000ms", 75],
    ["75000000us", 75],
    ["75000000", 75],
  ])("accepts the exact RuntimeMaxUSec form %s", async (observed, seconds) => {
    const harness = processManagerHarness(
      { code: 0, stderr: "", stdout: "" },
      { foreign: { RuntimeMaxUSec: observed } },
    );

    await expect(
      harness.manager.start(
        "/usr/bin/node",
        ["-e", "setInterval(() => {}, 1000)"],
        "pressure-cpu",
        { runtimeMaxSec: seconds },
      ),
    ).resolves.toMatchObject({ runtimeMaxSec: seconds });
  });

  it.each([
    "+75s",
    "-75s",
    "75.0s",
    "1.25min",
    "1min 15.5s",
    "1min 15s 5s",
    "1min 1min",
    "15s 1min",
    "1min 60s",
    "1min 0s",
    "01min 15s",
    "1min 05s",
    "1h 15min",
    "75M",
    "75sec",
    " 1min 15s",
    "1min 15s ",
    "1min  15s",
    "1min\t15s",
    "1min15s",
    "",
  ])("rejects malformed RuntimeMaxUSec text %j", async (observed) => {
    const harness = processManagerHarness(
      { code: 0, stderr: "", stdout: "" },
      { foreign: { RuntimeMaxUSec: observed } },
    );

    await expect(
      harness.manager.start(
        "/usr/bin/node",
        ["-e", "setInterval(() => {}, 1000)"],
        "pressure-cpu",
        { runtimeMaxSec: 75 },
      ),
    ).rejects.toThrow("bounded_host_process_property_malformed");
  });

  it.each([
    ["memory", { MemoryMax: "1min 15s" }, "property_malformed"],
    [
      "memory duration unit",
      { MemoryMax: "536870912us" },
      "property_malformed",
    ],
    [
      "IO rate",
      { IOReadBandwidthMax: "/dev/vda 1min 15s" },
      "property_malformed",
    ],
    [
      "IO rate duration unit",
      { IOReadBandwidthMax: "/dev/vda 16777216us" },
      "property_malformed",
    ],
    ["file-size limit", { LimitFSIZE: "1min 15s" }, "confinement_unproven"],
    ["open-file limit", { LimitNOFILE: "1min 15s" }, "confinement_unproven"],
  ])(
    "does not extend the %s grammar with duration compounds",
    async (_, foreign, error) => {
      const harness = processManagerHarness(
        { code: 0, stderr: "", stdout: "" },
        { foreign: { RuntimeMaxUSec: "1min 15s", ...foreign } },
      );

      await expect(
        harness.manager.start(
          "/usr/bin/node",
          ["-e", "setInterval(() => {}, 1000)"],
          "pressure-cpu",
          { runtimeMaxSec: 75 },
        ),
      ).rejects.toThrow(`bounded_host_process_${error}`);
    },
  );

  it("preserves exact RuntimeMaxUSec equality after parsing", async () => {
    const harness = processManagerHarness(
      { code: 0, stderr: "", stdout: "" },
      { foreign: { RuntimeMaxUSec: "1min 14s" } },
    );

    await expect(
      harness.manager.start(
        "/usr/bin/node",
        ["-e", "setInterval(() => {}, 1000)"],
        "pressure-cpu",
        { runtimeMaxSec: 75 },
      ),
    ).rejects.toThrow("bounded_host_process_confinement_unproven");
  });

  it("rejects a malformed RuntimeMaxUSec during last-moment verify", async () => {
    const harness = processManagerHarness(
      { code: 0, stderr: "", stdout: "" },
      (observation) => ({
        foreign: {
          RuntimeMaxUSec: observation === 0 ? "1min 15s" : "1min 60s",
        },
      }),
    );
    const process = await harness.manager.start(
      "/usr/bin/node",
      ["-e", "setInterval(() => {}, 1000)"],
      "pressure-cpu",
      { runtimeMaxSec: 75 },
    );

    await expect(harness.manager.verify(process)).rejects.toThrow(
      "bounded_host_process_property_malformed",
    );
  });

  it("keeps non-pressure starts on the exact default runtime", async () => {
    const defaultHarness = processManagerHarness({
      code: 0,
      stderr: "",
      stdout: "",
    });
    const process = await defaultHarness.manager.start(
      "/usr/bin/node",
      ["-e", "setInterval(() => {}, 1000)"],
      "hq-worker",
    );

    expect(defaultHarness.runner.run).toHaveBeenCalledWith(
      "/usr/bin/systemd-run",
      expect.arrayContaining([
        "--property=RuntimeMaxSec=30s",
        "--property=SystemCallFilter=@system-service",
        "--property=SystemCallFilter=~@mount @privileged @resources @reboot",
      ]),
      { timeoutMs: 10_000 },
    );
    expect(defaultHarness.runner.run.mock.calls[0][1]).not.toContain(
      "--property=SystemCallFilter=@system-service ~@mount ~@privileged ~@resources ~@reboot",
    );
    expect(defaultHarness.observedUnitProperties).toHaveLength(1);
    expect(defaultHarness.observedUnitProperties[0]).toContain(
      "RuntimeMaxUSec=30s\n",
    );
    expect(process.runtimeMaxSec).toBe(30);

    const extendedHarness = processManagerHarness({
      code: 0,
      stderr: "",
      stdout: "",
    });
    await expect(
      extendedHarness.manager.start(
        "/usr/bin/node",
        ["-e", "setInterval(() => {}, 1000)"],
        "hq-worker",
        { runtimeMaxSec: 75 },
      ),
    ).rejects.toThrow("bounded_host_process_invocation_invalid");
    expect(extendedHarness.runner.run).not.toHaveBeenCalled();
  });

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

  it("keeps exact ownership live and fails closed when a stop is uncertain", async () => {
    const harness = processManagerHarness(
      { code: 0, stderr: "", stdout: "" },
      {},
      { code: 1, stderr: "stop failed", stdout: "" },
    );
    const process = await harness.manager.start(
      "/usr/bin/node",
      ["-e", "setInterval(() => {}, 1000)"],
      "hq-worker",
    );
    await expect(harness.manager.verify(process)).resolves.toMatchObject({
      active: true,
      controlGroup: process.controlGroup,
      invocationId: process.invocationId,
      runtimeMaxSec: 30,
      unit: process.unit,
    });
    const callsBeforeStop = harness.runner.run.mock.calls.length;
    await expect(harness.manager.stop(process)).rejects.toThrow(
      "bounded_host_process_stop_uncertain",
    );
    expect(
      harness.runner.run.mock.calls
        .slice(callsBeforeStop)
        .map(([, arguments_]) => arguments_[0]),
    ).toEqual(["show", "stop"]);
    await expect(harness.manager.verify(process)).resolves.toMatchObject({
      active: true,
      invocationId: process.invocationId,
    });
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
      const observedExpected =
        expected.code !== 0 && expected.code !== null
          ? { ...expected, systemdResult: "exit-code" }
          : expected;
      await expect(
        harness.manager.execute("/usr/bin/hq", ["job", "list"], "hq-cli-1", {
          limits: { maxOutputBytes: 1024, timeoutMs: 2_000 },
        }),
      ).resolves.toEqual(observedExpected);
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
          "--wait",
          "--pipe",
          expect.stringMatching(
            /^--property=ExecStartPre=\/usr\/bin\/node .*systemd-observation-window\.mjs .*\.observed-hq-cli-1 30000$/u,
          ),
          "--property=RuntimeMaxSec=2s",
          "--property=TimeoutStopSec=12s",
        ]),
        { maxOutputBytes: 1024, timeoutMs: 49_000 },
      );
      expect(harness.runner.start.mock.calls[0][1]).not.toContain("--collect");
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
