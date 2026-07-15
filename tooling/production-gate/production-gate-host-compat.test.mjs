import { describe, expect, it, vi } from "vitest";

import { cleanupBoundedSystemdUnit } from "./bounded-host-process.mjs";
import { POSTGRES_FIXTURE_IMAGE } from "./constants.mjs";
import {
  assertSafeDockerArguments,
  postgresContainerArguments,
} from "./docker-plan.mjs";
import { GateDockerRuntime } from "./docker-runtime.mjs";
import { createSystemdProbeIo } from "./systemd-runtime.mjs";
import {
  cleanupSystemdSlice,
  createSystemdSliceOwnership,
} from "./systemd-slice-ledger.mjs";

const runId = "wf-production-gate-0123456789abcdef0123456789abcdef";
const slice = `${runId}.slice`;
const implicitSliceDescription =
  "Slice /wf/production/gate/0123456789abcdef0123456789abcdef";
const postgresData = `/var/data/workload-funnel/sandboxes/${runId}/postgres-data`;
const sliceControlGroup = `/wf.slice/wf-production.slice/wf-production-gate.slice/${slice}`;

function result(stdout, code = 0, stderr = "") {
  return { code, stderr, stdout };
}

function sliceShow(overrides = {}) {
  return `${Object.entries({
    ActiveState: "inactive",
    ControlGroup: "",
    Description: implicitSliceDescription,
    DropInPaths: "",
    FragmentPath: "",
    Id: slice,
    LoadState: "loaded",
    Names: slice,
    SourcePath: "",
    Transient: "no",
    ...overrides,
  })
    .map(([key, value]) => `${key}=${value}`)
    .join("\n")}\n`;
}

function postgresInspect(overrides = {}) {
  return {
    Config: {
      Env: ["POSTGRES_PASSWORD_FILE=/run/secrets/postgres-password"],
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
      ...overrides,
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
}

function clientInspect(identity, overrides = {}) {
  return {
    Config: { Cmd: ["ready"], User: "1000:1000" },
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
      ...overrides,
    },
    Id: identity,
  };
}

describe("Docker 29 production-gate compatibility", () => {
  it("uses valid writable bind syntax and proves the exact rprivate mount", async () => {
    const args = postgresContainerArguments({
      database: "wf_gate",
      dataDirectory: postgresData,
      image: POSTGRES_FIXTURE_IMAGE,
      ioDevice: "/dev/vda",
      name: `${runId}-postgres`,
      network: `${runId}-network`,
      passwordFile: `/tmp/${runId}/postgres-password`,
      user: "wf_gate",
    });
    const dataMount = args[args.indexOf("--mount") + 1];
    expect(dataMount).toBe(
      `type=bind,src=${postgresData},dst=/var/lib/postgresql/data,bind-propagation=rprivate`,
    );
    expect(dataMount.split(",").every((field) => field.includes("="))).toBe(
      true,
    );
    expect(args.some((argument) => argument.startsWith("--uts"))).toBe(false);
    expect(args).toContain("--ipc=private");
    expect(args).toContain("127.0.0.1:0:5432");
    expect(() =>
      assertSafeDockerArguments(["create", "--publish", "127.0.0.1::5432"]),
    ).toThrow("docker_port_not_loopback_ephemeral");
    expect(() =>
      assertSafeDockerArguments([
        "create",
        "--publish",
        "127.0.0.1:49152:5432",
      ]),
    ).toThrow("docker_port_not_loopback_ephemeral");
    expect(() =>
      assertSafeDockerArguments(["create", "--publish", "0.0.0.0:0:5432"]),
    ).toThrow("docker_port_not_loopback_ephemeral");
    expect(
      assertSafeDockerArguments(["create", "--publish", "127.0.0.1:0:5432"]),
    ).toEqual(["create", "--publish", "127.0.0.1:0:5432"]);

    let inspected = postgresInspect();
    const runtime = new GateDockerRuntime({
      executable: "/usr/bin/docker",
      ioDevice: "/dev/vda",
      runId,
      runner: {
        run: () => Promise.resolve(result(JSON.stringify([inspected]))),
      },
      sandboxRoot: `/tmp/${runId}`,
    });
    const expectedStorage = {
      destination: "/var/lib/postgresql/data",
      kind: "bind",
      source: postgresData,
    };
    await expect(
      runtime.inspectContainerConfinement(
        `${runId}-postgres`,
        "70:70",
        [],
        inspected.Id,
        expectedStorage,
        5432,
      ),
    ).resolves.toMatchObject({
      privateUtsNamespace: true,
      publishedHostPort: 49152,
      writableStorage: expectedStorage,
    });

    for (const binding of [
      { HostIp: "127.0.0.1", HostPort: "" },
      { HostIp: "127.0.0.1", HostPort: "49152" },
      { HostIp: "0.0.0.0", HostPort: "49152" },
      { HostIp: "127.0.0.1", HostPort: "65536" },
    ]) {
      inspected = postgresInspect({
        PortBindings: { "5432/tcp": [binding] },
      });
      await expect(
        runtime.inspectContainerConfinement(
          `${runId}-postgres`,
          "70:70",
          [],
          inspected.Id,
          expectedStorage,
          5432,
        ),
      ).rejects.toThrow("docker_container_confinement_unproven");
    }

    inspected = postgresInspect({
      PortBindings: {
        "5432/tcp": [{ HostIp: "127.0.0.1", HostPort: "0" }],
        "9000/tcp": [{ HostIp: "127.0.0.1", HostPort: "49153" }],
      },
    });
    await expect(
      runtime.inspectContainerConfinement(
        `${runId}-postgres`,
        "70:70",
        [],
        inspected.Id,
        expectedStorage,
        5432,
      ),
    ).rejects.toThrow("docker_container_confinement_unproven");

    inspected = postgresInspect({ UTSMode: "host" });
    await expect(
      runtime.inspectContainerConfinement(
        `${runId}-postgres`,
        "70:70",
        [],
        inspected.Id,
        expectedStorage,
        5432,
      ),
    ).rejects.toThrow("docker_container_confinement_unproven");

    inspected = postgresInspect();
    inspected.Mounts[0].RW = false;
    await expect(
      runtime.inspectContainerConfinement(
        `${runId}-postgres`,
        "70:70",
        [],
        inspected.Id,
        expectedStorage,
        5432,
      ),
    ).rejects.toThrow("docker_container_confinement_unproven");

    inspected = postgresInspect();
    inspected.Mounts[0].Propagation = "rshared";
    await expect(
      runtime.inspectContainerConfinement(
        `${runId}-postgres`,
        "70:70",
        [],
        inspected.Id,
        expectedStorage,
        5432,
      ),
    ).rejects.toThrow("docker_container_confinement_unproven");
  });

  it("requires docker port to prove one assigned loopback port", async () => {
    let output = "127.0.0.1:49152\n";
    const runtime = new GateDockerRuntime({
      executable: "/usr/bin/docker",
      ioDevice: "/dev/vda",
      runId,
      runner: { run: () => Promise.resolve(result(output)) },
      sandboxRoot: `/tmp/${runId}`,
    });
    await expect(
      runtime.loopbackPort(`${runId}-postgres`, 5432, 49152),
    ).resolves.toBe(49152);
    await expect(
      runtime.loopbackPort(`${runId}-postgres`, 5432, 49153),
    ).rejects.toThrow("docker_published_port_identity_changed");
    for (const foreign of [
      "0.0.0.0:49152\n",
      "127.0.0.1:0\n",
      "127.0.0.1:\n",
      "127.0.0.1:49152\n127.0.0.1:49153\n",
    ]) {
      output = foreign;
      await expect(
        runtime.loopbackPort(`${runId}-postgres`, 5432, 49152),
      ).rejects.toThrow("docker_published_port_not_loopback");
    }
  });

  it("omits UTS flags for clients and accepts only Docker's empty private mode", async () => {
    const identity = "c".repeat(64);
    const createCalls = [];
    let inspectCalls = 0;
    let inspected = clientInspect(identity);
    const runtime = new GateDockerRuntime({
      executable: "/usr/bin/docker",
      ioDevice: "/dev/vda",
      ledger: {
        finalize: () => Promise.resolve(),
        prepare: () => Promise.resolve("record"),
      },
      runId,
      runner: {
        run: (_executable, args) => {
          if (args[0] === "container" && args[1] === "inspect") {
            inspectCalls += 1;
            return Promise.resolve(
              inspectCalls === 1
                ? result("", 1, "No such container")
                : result(JSON.stringify([inspected])),
            );
          }
          if (args[0] === "create") {
            createCalls.push(args);
            return Promise.resolve(result(identity));
          }
          return Promise.resolve(result(`${runId}-client-1`));
        },
      },
      sandboxRoot: `/tmp/${runId}`,
    });
    await expect(
      runtime.runClient({
        arguments_: ["ready"],
        image: POSTGRES_FIXTURE_IMAGE,
      }),
    ).resolves.toBe(`${runId}-client-1`);
    expect(createCalls).toHaveLength(1);
    expect(
      createCalls[0].some((argument) => argument.startsWith("--uts")),
    ).toBe(false);

    inspected = clientInspect(identity, { UTSMode: "host" });
    await expect(
      runtime.inspectClientConfinement(`${runId}-client-1`, identity),
    ).rejects.toThrow("docker_client_confinement_unproven");
  });
});

describe("systemd 255 production-gate compatibility", () => {
  it("admits only the exact inactive implicit-slice baseline", async () => {
    const prepare = vi.fn(() => Promise.resolve("slice-record"));
    const baseline = createSystemdSliceOwnership({
      ledger: { prepare },
      runId,
      runner: { run: () => Promise.resolve(result(sliceShow())) },
      systemctlExecutable: "/usr/bin/systemctl",
    });
    await expect(baseline.admit()).resolves.toBeUndefined();
    expect(prepare).toHaveBeenCalledOnce();
    expect(prepare).toHaveBeenCalledWith("systemd-slice", slice, {
      controlGroupSuffix: `/${slice}`,
    });
    expect(sliceShow()).toContain(`Description=${implicitSliceDescription}\n`);

    const foreignStates = [
      { ActiveState: "active" },
      { ControlGroup: `/foreign.slice/${slice}` },
      { Description: slice },
      { Description: "foreign slice" },
      { Description: "Slice /wf/production/gate/foreign" },
      { DropInPaths: "/etc/systemd/system/gate.slice.d/foreign.conf" },
      { FragmentPath: "/etc/systemd/system/gate.slice" },
      { Id: "foreign.slice" },
      { LoadState: "masked" },
      { Names: `${slice} foreign.slice` },
      { SourcePath: "/foreign/generated/source" },
      { Transient: "yes" },
    ];
    for (const foreignState of foreignStates) {
      const foreignPrepare = vi.fn();
      const foreign = createSystemdSliceOwnership({
        ledger: { prepare: foreignPrepare },
        runId,
        runner: {
          run: () => Promise.resolve(result(sliceShow(foreignState))),
        },
        systemctlExecutable: "/usr/bin/systemctl",
      });
      await expect(foreign.admit()).rejects.toThrow(
        "systemd_gate_slice_already_exists_or_unprovable",
      );
      expect(foreignPrepare).not.toHaveBeenCalled();
    }
  });

  it("persists the exact observed implicit-slice hierarchy", async () => {
    const finalize = vi.fn(() => Promise.resolve());
    let calls = 0;
    const ownership = createSystemdSliceOwnership({
      ledger: {
        finalize,
        prepare: () => Promise.resolve("slice-record"),
      },
      runId,
      runner: {
        run: () => {
          calls += 1;
          return Promise.resolve(
            result(
              calls === 1
                ? sliceShow()
                : sliceShow({
                    ActiveState: "active",
                    ControlGroup: sliceControlGroup,
                  }),
            ),
          );
        },
      },
      systemctlExecutable: "/usr/bin/systemctl",
    });
    await ownership.admit();
    await ownership.register();
    expect(finalize).toHaveBeenCalledWith(
      "slice-record",
      { controlGroup: sliceControlGroup },
      expect.any(Function),
    );
  });

  it("treats only an exact implicit baseline as already clean", async () => {
    const cleanRunner = {
      run: vi.fn(() => Promise.resolve(result(sliceShow()))),
    };
    await expect(
      cleanupSystemdSlice(
        {
          runner: cleanRunner,
          systemctlExecutable: "/usr/bin/systemctl",
        },
        { name: slice, observed: {} },
      ),
    ).resolves.toBeUndefined();
    expect(cleanRunner.run).toHaveBeenCalledOnce();

    const activeUnownedRunner = {
      run: vi.fn(() =>
        Promise.resolve(
          result(
            sliceShow({
              ActiveState: "active",
              ControlGroup: sliceControlGroup,
            }),
          ),
        ),
      ),
    };
    await expect(
      cleanupSystemdSlice(
        {
          runner: activeUnownedRunner,
          systemctlExecutable: "/usr/bin/systemctl",
        },
        { name: slice, observed: {} },
      ),
    ).rejects.toThrow("systemd_slice_cleanup_identity_changed");
    expect(activeUnownedRunner.run).toHaveBeenCalledOnce();

    for (const foreignState of [
      { Description: slice },
      { Description: "Slice /wf/production/gate/foreign" },
      { DropInPaths: "/run/systemd/system/gate.slice.d/foreign.conf" },
    ]) {
      const foreignRunner = {
        run: vi.fn(() =>
          Promise.resolve(
            result(
              sliceShow({
                ActiveState: "active",
                ControlGroup: sliceControlGroup,
                ...foreignState,
              }),
            ),
          ),
        ),
      };
      await expect(
        cleanupSystemdSlice(
          {
            runner: foreignRunner,
            systemctlExecutable: "/usr/bin/systemctl",
          },
          {
            expected: { controlGroupSuffix: `/${slice}` },
            name: slice,
            observed: { controlGroup: sliceControlGroup },
          },
        ),
      ).rejects.toThrow("systemd_slice_cleanup_identity_changed");
      expect(foreignRunner.run).toHaveBeenCalledOnce();
    }
  });

  it.each([
    [
      "finalized",
      {
        expected: { controlGroupSuffix: `/${slice}` },
        name: slice,
        observed: { controlGroup: sliceControlGroup },
        state: "active",
      },
    ],
    [
      "prepared-only",
      {
        expected: { controlGroupSuffix: `/${slice}` },
        name: slice,
        observed: {},
        state: "prepared",
      },
    ],
  ])("cleans an exact %s hierarchical implicit slice", async (_, record) => {
    let calls = 0;
    const runner = {
      run: vi.fn((_executable, args) => {
        calls += 1;
        if (calls === 1)
          return Promise.resolve(
            result(
              sliceShow({
                ActiveState: "active",
                ControlGroup: sliceControlGroup,
              }),
            ),
          );
        if (args[0] === "show") return Promise.resolve(result(sliceShow()));
        return Promise.resolve(result(""));
      }),
    };
    await expect(
      cleanupSystemdSlice(
        { runner, systemctlExecutable: "/usr/bin/systemctl" },
        record,
      ),
    ).resolves.toBeUndefined();
    expect(runner.run.mock.calls.map(([, args]) => args[0])).toEqual([
      "show",
      "stop",
      "reset-failed",
      "show",
    ]);
  });

  it("rejects foreign or contradictory prepared-only recovery identities", async () => {
    const record = {
      expected: { controlGroupSuffix: `/${slice}` },
      name: slice,
      observed: {},
      state: "prepared",
    };
    const foreignShows = [
      sliceShow({
        ActiveState: "active",
        ControlGroup: `/foreign.slice/${slice}`,
      }),
      sliceShow({
        ActiveState: "active",
        ControlGroup: sliceControlGroup,
        Description: "foreign",
      }),
      sliceShow({
        ActiveState: "active",
        ControlGroup: sliceControlGroup,
        DropInPaths: "/run/systemd/system/foreign.conf",
      }),
      sliceShow({
        ActiveState: "active",
        ControlGroup: sliceControlGroup,
        Transient: "yes",
      }),
      `${sliceShow({
        ActiveState: "active",
        ControlGroup: sliceControlGroup,
      })}ControlGroup=${sliceControlGroup}\n`,
    ];
    for (const stdout of foreignShows) {
      const runner = {
        run: vi.fn(() => Promise.resolve(result(stdout))),
      };
      await expect(
        cleanupSystemdSlice(
          { runner, systemctlExecutable: "/usr/bin/systemctl" },
          record,
        ),
      ).rejects.toThrow("systemd_slice_cleanup_identity_changed");
      expect(runner.run).toHaveBeenCalledOnce();
    }

    const contradictoryRecord = {
      ...record,
      expected: { controlGroupSuffix: "/foreign.slice" },
    };
    await expect(
      cleanupSystemdSlice(
        {
          runner: {
            run: () =>
              Promise.resolve(
                result(
                  sliceShow({
                    ActiveState: "active",
                    ControlGroup: sliceControlGroup,
                  }),
                ),
              ),
          },
          systemctlExecutable: "/usr/bin/systemctl",
        },
        contradictoryRecord,
      ),
    ).rejects.toThrow("systemd_slice_cleanup_identity_changed");
  });

  it("requires an exact inactive implicit baseline after stop and reset", async () => {
    let calls = 0;
    const runner = {
      run: vi.fn((_executable, args) => {
        calls += 1;
        if (calls === 1)
          return Promise.resolve(
            result(
              sliceShow({
                ActiveState: "active",
                ControlGroup: sliceControlGroup,
              }),
            ),
          );
        if (args[0] === "show")
          return Promise.resolve(result("LoadState=not-found\n"));
        return Promise.resolve(result(""));
      }),
    };
    await expect(
      cleanupSystemdSlice(
        { runner, systemctlExecutable: "/usr/bin/systemctl" },
        {
          expected: { controlGroupSuffix: `/${slice}` },
          name: slice,
          observed: {},
          state: "prepared",
        },
      ),
    ).rejects.toThrow("systemd_slice_cleanup_uncertain");
  });

  it("recognizes not-found among properties without weakening loaded identity", async () => {
    const absentOutput = "Description=\nInvocationID=\nLoadState=not-found\n";
    const absentRunner = {
      run: vi.fn(() => Promise.resolve(result(absentOutput))),
    };
    await expect(
      cleanupBoundedSystemdUnit(
        {
          runner: absentRunner,
          systemctlExecutable: "/usr/bin/systemctl",
        },
        {
          expected: { description: "expected" },
          name: `${runId}-prepared.service`,
          observed: {},
        },
      ),
    ).resolves.toBeUndefined();
    expect(absentRunner.run).toHaveBeenCalledOnce();

    const foreignLoadedRunner = {
      run: vi.fn(() =>
        Promise.resolve(
          result(
            `Description=foreign LoadState=not-found\nInvocationID=${"d".repeat(32)}\nLoadState=loaded\n`,
          ),
        ),
      ),
    };
    await expect(
      cleanupBoundedSystemdUnit(
        {
          runner: foreignLoadedRunner,
          systemctlExecutable: "/usr/bin/systemctl",
        },
        {
          expected: { description: "expected" },
          name: `${runId}-loaded.service`,
          observed: { invocationId: "d".repeat(32) },
        },
      ),
    ).rejects.toThrow("bounded_host_process_cleanup_identity_changed");
    expect(foreignLoadedRunner.run).toHaveBeenCalledOnce();

    const contradictoryLoadStateRunner = {
      run: vi.fn(() =>
        Promise.resolve(
          result(
            `Description=foreign\nInvocationID=${"d".repeat(32)}\nLoadState=not-found\nLoadState=loaded\n`,
          ),
        ),
      ),
    };
    await expect(
      cleanupBoundedSystemdUnit(
        {
          runner: contradictoryLoadStateRunner,
          systemctlExecutable: "/usr/bin/systemctl",
        },
        {
          expected: { description: "expected" },
          name: `${runId}-contradictory.service`,
          observed: { invocationId: "d".repeat(32) },
        },
      ),
    ).rejects.toThrow("bounded_host_process_show_malformed");
    expect(contradictoryLoadStateRunner.run).toHaveBeenCalledOnce();

    let preparedCleanup;
    const probeRunner = {
      run: vi.fn(() => Promise.resolve(result(absentOutput))),
    };
    const probeIo = createSystemdProbeIo({
      ledger: {
        finalize: (_recordId, _observed, cleanup) => {
          preparedCleanup = cleanup;
          return Promise.resolve();
        },
        prepare: () => Promise.resolve("prepared-record"),
      },
      runner: probeRunner,
      sliceOwnership: { register: () => Promise.resolve() },
      systemctlExecutable: "/usr/bin/systemctl",
    });
    await probeIo.prepareUnit(`${runId}-prepared.service`, "expected");
    await probeIo.finalizeUnit(`${runId}-prepared.service`, {
      InvocationID: "e".repeat(32),
    });
    await expect(preparedCleanup()).resolves.toBeUndefined();
    expect(probeRunner.run).toHaveBeenCalledOnce();
  });
});
