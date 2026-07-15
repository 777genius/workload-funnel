import { describe, expect, it, vi } from "vitest";

import { cleanupBoundedSystemdUnit } from "./bounded-host-process.mjs";
import { POSTGRES_FIXTURE_IMAGE } from "./constants.mjs";
import { postgresContainerArguments } from "./docker-plan.mjs";
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
        "5432/tcp": [{ HostIp: "127.0.0.1", HostPort: "49152" }],
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
      ),
    ).resolves.toMatchObject({
      privateUtsNamespace: true,
      writableStorage: expectedStorage,
    });

    inspected = postgresInspect({ UTSMode: "host" });
    await expect(
      runtime.inspectContainerConfinement(
        `${runId}-postgres`,
        "70:70",
        [],
        inspected.Id,
        expectedStorage,
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
      ),
    ).rejects.toThrow("docker_container_confinement_unproven");
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
              ControlGroup: `/${slice}`,
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
                ControlGroup: `/${slice}`,
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
          { name: slice, observed: { controlGroup: `/${slice}` } },
        ),
      ).rejects.toThrow("systemd_slice_cleanup_identity_changed");
      expect(foreignRunner.run).toHaveBeenCalledOnce();
    }
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
