import { describe, expect, it, vi } from "vitest";

import {
  POSTGRES_PARENT_TMPFS_DESTINATION,
  POSTGRES_PARENT_TMPFS_OPTIONS,
  postgresContainerArguments,
} from "./docker-plan.mjs";
import { GateDockerRuntime } from "./docker-runtime.mjs";

const runId = "wf-production-gate-0123456789abcdef0123456789abcdef";
const name = `${runId}-postgres`;
const networkName = `${runId}-network`;
const identity = "a".repeat(64);
const networkIdentity = "b".repeat(64);
const endpointIdentity = "c".repeat(64);
const imageId = `sha256:${"d".repeat(64)}`;
const image = `postgres:test@sha256:${"e".repeat(64)}`;
const postgresData = `/var/data/workload-funnel/sandboxes/${runId}/postgres-data`;
const passwordFile = `/tmp/${runId}/postgres-password`;
const expectedStorage = {
  destination: "/var/lib/postgresql/data",
  kind: "bind",
  source: postgresData,
};
const expectedSecrets = [
  {
    destination: "/run/secrets/postgres-password",
    source: passwordFile,
  },
];

function docker29Inspect() {
  return {
    Config: {
      Env: ["POSTGRES_PASSWORD_FILE=/run/secrets/postgres-password"],
      Image: image,
      Labels: { "workload-funnel.production-gate.resource": name },
      User: "70:70",
      Volumes: { "/var/lib/postgresql": {} },
    },
    HostConfig: {
      CapDrop: ["ALL"],
      Init: true,
      IpcMode: "private",
      Memory: 2_147_483_648,
      MemorySwap: 2_147_483_648,
      NanoCpus: 2_000_000_000,
      NetworkMode: networkName,
      PidsLimit: 256,
      PortBindings: null,
      Privileged: false,
      ReadonlyRootfs: true,
      RestartPolicy: { Name: "no" },
      SecurityOpt: ["no-new-privileges=true"],
      Tmpfs: {
        "/tmp": "rw,size=67108864",
        [POSTGRES_PARENT_TMPFS_DESTINATION]: POSTGRES_PARENT_TMPFS_OPTIONS,
      },
      UTSMode: "",
    },
    Id: identity,
    Image: imageId,
    Mounts: [
      {
        Destination: "/var/lib/postgresql/data",
        Propagation: "rprivate",
        RW: true,
        Source: postgresData,
        Type: "bind",
      },
      {
        Destination: "/run/secrets/postgres-password",
        Propagation: "rprivate",
        RW: false,
        Source: passwordFile,
        Type: "bind",
      },
    ],
    NetworkSettings: {
      Networks: {
        [networkName]: {
          EndpointID: endpointIdentity,
          IPAddress: "172.28.0.2",
          IPPrefixLen: 16,
          MacAddress: "02:42:ac:1c:00:02",
          NetworkID: networkIdentity,
        },
      },
      Ports: null,
    },
  };
}

function docker29NetworkInspect() {
  return {
    Containers: {
      [identity]: {
        EndpointID: endpointIdentity,
        IPv4Address: "172.28.0.2/16",
        IPv6Address: "",
        MacAddress: "02:42:ac:1c:00:02",
        Name: name,
      },
    },
    Driver: "bridge",
    IPAM: { Config: [{ Gateway: "172.28.0.1", Subnet: "172.28.0.0/16" }] },
    Id: networkIdentity,
    Ingress: false,
    Internal: true,
    Labels: { "workload-funnel.production-gate.run": runId },
    Name: networkName,
  };
}

function runtimeFor(
  inspected,
  network = docker29NetworkInspect(),
  publishedPorts = "",
) {
  let containerInspectCalls = 0;
  let networkInspectCalls = 0;
  return new GateDockerRuntime({
    executable: "/usr/bin/docker",
    ioDevice: "/dev/vda",
    runId,
    runner: {
      run: vi.fn((_executable, args) => {
        const inspectedValue = Array.isArray(inspected)
          ? inspected[Math.min(containerInspectCalls, inspected.length - 1)]
          : inspected;
        const networkValue = Array.isArray(network)
          ? network[Math.min(networkInspectCalls, network.length - 1)]
          : network;
        if (args[0] === "container") containerInspectCalls += 1;
        if (args[0] === "network") networkInspectCalls += 1;
        return Promise.resolve({
          code: 0,
          stderr: "",
          stdout:
            args[0] === "port"
              ? publishedPorts
              : JSON.stringify([
                  args[0] === "container" ? inspectedValue : networkValue,
                ]),
        });
      }),
    },
    sandboxRoot: `/tmp/${runId}`,
  });
}

function inspect(runtime, forbiddenValues = []) {
  return runtime.inspectContainerConfinement(
    name,
    "70:70",
    forbiddenValues,
    identity,
    expectedStorage,
    5432,
    image,
    expectedSecrets,
  );
}

describe("Docker 29 internal-network endpoint compatibility", () => {
  it("covers the Postgres 18 declared parent with a bounded tmpfs before the nested data bind", () => {
    const args = postgresContainerArguments({
      database: "wf_gate",
      dataDirectory: postgresData,
      image,
      ioDevice: "/dev/vda",
      name,
      network: networkName,
      passwordFile,
      user: "wf_gate",
    });
    const parentTmpfs = `${POSTGRES_PARENT_TMPFS_DESTINATION}:${POSTGRES_PARENT_TMPFS_OPTIONS}`;
    const parentIndex = args.indexOf(parentTmpfs);
    const dataBind = `type=bind,src=${postgresData},dst=/var/lib/postgresql/data,bind-propagation=rprivate`;
    expect(parentIndex).toBeGreaterThan(args.indexOf("--tmpfs"));
    expect(args[parentIndex - 1]).toBe("--tmpfs");
    expect(parentIndex).toBeLessThan(args.indexOf(dataBind));
    expect(args.filter((argument) => argument === parentTmpfs)).toHaveLength(1);
  });

  it("proves the created bridge is internal before admitting any container", async () => {
    let inspectCalls = 0;
    const ledger = {
      finalize: vi.fn(() => Promise.resolve()),
      prepare: vi.fn(() => Promise.resolve("network-record")),
    };
    const emptyNetwork = { ...docker29NetworkInspect(), Containers: {} };
    const runner = {
      run: vi.fn((_executable, args) => {
        if (args[0] === "network" && args[1] === "inspect") {
          inspectCalls += 1;
          return Promise.resolve(
            inspectCalls === 1
              ? {
                  code: 1,
                  stderr: "No such network",
                  stdout: "",
                }
              : {
                  code: 0,
                  stderr: "",
                  stdout: JSON.stringify([emptyNetwork]),
                },
          );
        }
        return Promise.resolve({
          code: 0,
          stderr: "",
          stdout:
            args[0] === "network" && args[1] === "create"
              ? networkIdentity
              : networkName,
        });
      }),
    };
    const runtime = new GateDockerRuntime({
      executable: "/usr/bin/docker",
      ioDevice: "/dev/vda",
      ledger,
      runId,
      runner,
      sandboxRoot: `/tmp/${runId}`,
    });
    await expect(runtime.createNetwork()).resolves.toBe(networkName);
    expect(ledger.finalize).toHaveBeenCalledWith(
      "network-record",
      { identity: networkIdentity },
      expect.any(Function),
    );
    expect(runner.run.mock.calls.map(([, args]) => args.slice(0, 2))).toEqual([
      ["network", "inspect"],
      ["network", "create"],
      ["network", "inspect"],
    ]);
  });

  it("accepts no publication and returns only the exact validated internal endpoint", async () => {
    const inspected = docker29Inspect();
    const runtime = runtimeFor(inspected);
    await expect(inspect(runtime)).resolves.toMatchObject({
      exactIdentity: identity,
      imageId,
      internalNetwork: networkName,
      internalNetworkEndpoint: { ipv4Address: "172.28.0.2", port: 5432 },
      publishedPorts: 0,
      writableStorage: {
        ...expectedStorage,
        parentTmpfs: {
          destination: POSTGRES_PARENT_TMPFS_DESTINATION,
          options: POSTGRES_PARENT_TMPFS_OPTIONS,
        },
      },
    });
    expect(runtime.runner.run.mock.calls).toEqual([
      [
        "/usr/bin/docker",
        ["container", "inspect", name],
        { timeoutMs: 30_000 },
      ],
      [
        "/usr/bin/docker",
        ["network", "inspect", networkName],
        { timeoutMs: 30_000 },
      ],
      ["/usr/bin/docker", ["port", name], { timeoutMs: 5_000 }],
    ]);
  });

  it.each([
    [
      "missing parent tmpfs",
      (value) =>
        Reflect.deleteProperty(
          value.HostConfig.Tmpfs,
          POSTGRES_PARENT_TMPFS_DESTINATION,
        ),
    ],
    [
      "wrong parent ownership",
      (value) =>
        (value.HostConfig.Tmpfs[POSTGRES_PARENT_TMPFS_DESTINATION] =
          POSTGRES_PARENT_TMPFS_OPTIONS.replace("uid=70", "uid=0")),
    ],
    [
      "unbounded parent tmpfs",
      (value) =>
        (value.HostConfig.Tmpfs[POSTGRES_PARENT_TMPFS_DESTINATION] =
          "rw,nosuid,nodev,noexec,uid=70,gid=70,mode=0700"),
    ],
    [
      "foreign tmpfs",
      (value) => (value.HostConfig.Tmpfs["/foreign"] = "rw,size=4096"),
    ],
  ])("rejects %s for the declared Postgres 18 parent", async (_, mutate) => {
    const inspected = docker29Inspect();
    mutate(inspected);
    await expect(inspect(runtimeFor(inspected))).rejects.toThrow(
      "docker_container_confinement_unproven",
    );
  });

  it.each([
    ["anonymous parent volume", "/var/lib/postgresql"],
    ["foreign volume", "/foreign"],
  ])("rejects a Docker-created %s", async (_, destination) => {
    const inspected = docker29Inspect();
    inspected.Mounts.push({
      Destination: destination,
      Driver: "local",
      Mode: "",
      Name: "f".repeat(64),
      Propagation: "",
      RW: true,
      Source: `/var/lib/docker/volumes/${"f".repeat(64)}/_data`,
      Type: "volume",
    });
    await expect(inspect(runtimeFor(inspected))).rejects.toThrow(
      "docker_container_confinement_unproven",
    );
  });

  it("converges from Docker 29's empty endpoint and membership to exact evidence", async () => {
    const empty = docker29Inspect();
    empty.NetworkSettings.Networks[networkName] = {
      EndpointID: "",
      IPAddress: "",
      IPPrefixLen: 0,
      MacAddress: "",
      NetworkID: networkIdentity,
    };
    const runtime = runtimeFor([empty, docker29Inspect()]);
    await expect(inspect(runtime)).resolves.toMatchObject({
      exactIdentity: identity,
      internalNetworkEndpoint: { ipv4Address: "172.28.0.2", port: 5432 },
    });
    expect(
      runtime.runner.run.mock.calls.filter(
        ([, args]) => args[0] === "container" && args[1] === "inspect",
      ),
    ).toHaveLength(2);
  });

  it("converges from absent network membership to exact evidence", async () => {
    const runtime = runtimeFor(docker29Inspect(), [
      { ...docker29NetworkInspect(), Containers: {} },
      docker29NetworkInspect(),
    ]);
    await expect(inspect(runtime)).resolves.toMatchObject({
      exactIdentity: identity,
      internalNetworkEndpoint: { ipv4Address: "172.28.0.2", port: 5432 },
    });
    expect(
      runtime.runner.run.mock.calls.filter(
        ([, args]) => args[0] === "network" && args[1] === "inspect",
      ),
    ).toHaveLength(2);
  });

  it("fails closed after the bounded window when endpoint membership stays empty", async () => {
    const empty = docker29Inspect();
    empty.NetworkSettings.Networks = {};
    const runtime = runtimeFor(empty, {
      ...docker29NetworkInspect(),
      Containers: {},
    });
    await expect(inspect(runtime)).rejects.toThrow(
      "docker_container_confinement_unproven",
    );
    expect(
      runtime.runner.run.mock.calls.filter(
        ([, args]) => args[0] === "container" && args[1] === "inspect",
      ),
    ).toHaveLength(5);
  });

  it("fails immediately when identity contradicts an otherwise transient endpoint", async () => {
    const empty = docker29Inspect();
    empty.Id = "f".repeat(64);
    empty.NetworkSettings.Networks = {};
    const runtime = runtimeFor(empty, {
      ...docker29NetworkInspect(),
      Containers: {},
    });
    await expect(inspect(runtime)).rejects.toThrow(
      "docker_container_confinement_unproven",
    );
    expect(
      runtime.runner.run.mock.calls.filter(
        ([, args]) => args[0] === "container" && args[1] === "inspect",
      ),
    ).toHaveLength(1);
  });

  it.each([
    [
      "stale",
      {
        Containers: {
          ["f".repeat(64)]: {
            ...docker29NetworkInspect().Containers[identity],
            Name: name,
          },
        },
      },
    ],
    [
      "foreign",
      {
        Containers: {
          ["f".repeat(64)]: {
            ...docker29NetworkInspect().Containers[identity],
            Name: "foreign-container",
          },
        },
      },
    ],
  ])(
    "fails immediately on %s membership while the endpoint is absent",
    async (_, mutation) => {
      const empty = docker29Inspect();
      empty.NetworkSettings.Networks = {};
      const runtime = runtimeFor(empty, {
        ...docker29NetworkInspect(),
        ...mutation,
      });
      await expect(inspect(runtime)).rejects.toThrow(
        "docker_container_confinement_unproven",
      );
      expect(
        runtime.runner.run.mock.calls.filter(
          ([, args]) => args[0] === "container" && args[1] === "inspect",
        ),
      ).toHaveLength(1);
    },
  );

  it.each([
    ["writable mount", (value) => (value.Mounts[0].RW = false)],
    ["resource limit", (value) => (value.HostConfig.Memory = 1)],
    [
      "port binding",
      (value) =>
        (value.HostConfig.PortBindings = {
          "5432/tcp": [{ HostIp: "127.0.0.1", HostPort: "49152" }],
        }),
    ],
    ["image", (value) => (value.Config.Image = `${image}-foreign`)],
    ["label", (value) => (value.Config.Labels = {})],
  ])(
    "does not retry endpoint absence with contradictory %s evidence",
    async (_, mutate) => {
      const empty = docker29Inspect();
      empty.NetworkSettings.Networks = {};
      mutate(empty);
      const runtime = runtimeFor(empty, {
        ...docker29NetworkInspect(),
        Containers: {},
      });
      await expect(inspect(runtime)).rejects.toThrow(
        "docker_container_confinement_unproven",
      );
      expect(
        runtime.runner.run.mock.calls.filter(
          ([, args]) => args[0] === "container" && args[1] === "inspect",
        ),
      ).toHaveLength(1);
    },
  );

  it("does not retry endpoint absence with malformed or secret evidence", async () => {
    const malformed = docker29Inspect();
    malformed.NetworkSettings.Networks = null;
    const malformedRuntime = runtimeFor(malformed);
    await expect(inspect(malformedRuntime)).rejects.toThrow(
      "docker_container_confinement_unproven",
    );
    expect(
      malformedRuntime.runner.run.mock.calls.filter(
        ([, args]) => args[0] === "container" && args[1] === "inspect",
      ),
    ).toHaveLength(1);

    const missingSubnet = docker29Inspect();
    missingSubnet.NetworkSettings.Networks = {};
    const missingSubnetRuntime = runtimeFor(missingSubnet, {
      ...docker29NetworkInspect(),
      Containers: {},
      IPAM: { Config: [] },
    });
    await expect(inspect(missingSubnetRuntime)).rejects.toThrow(
      "docker_container_confinement_unproven",
    );
    expect(
      missingSubnetRuntime.runner.run.mock.calls.filter(
        ([, args]) => args[0] === "container" && args[1] === "inspect",
      ),
    ).toHaveLength(1);

    const secret = docker29Inspect();
    secret.NetworkSettings.Networks = {};
    secret.Config.Env.push("PASSWORD=gate-secret");
    const secretRuntime = runtimeFor(secret, {
      ...docker29NetworkInspect(),
      Containers: {},
    });
    await expect(inspect(secretRuntime, ["gate-secret"])).rejects.toThrow(
      "docker_container_metadata_contains_secret",
    );
    expect(
      secretRuntime.runner.run.mock.calls.filter(
        ([, args]) => args[0] === "container" && args[1] === "inspect",
      ),
    ).toHaveLength(1);
  });

  it("rejects a docker port mapping even when inspect falsely reports none", async () => {
    await expect(
      inspect(
        runtimeFor(
          docker29Inspect(),
          docker29NetworkInspect(),
          "127.0.0.1:49152\n",
        ),
      ),
    ).rejects.toThrow("docker_container_confinement_unproven");
  });

  it.each([
    [
      "retained requested binding",
      { "5432/tcp": [{ HostIp: "127.0.0.1", HostPort: "0" }] },
    ],
    [
      "assigned public binding",
      { "5432/tcp": [{ HostIp: "127.0.0.1", HostPort: "49152" }] },
    ],
    ["empty assigned binding", { "5432/tcp": [] }],
    ["malformed assigned map", "foreign"],
  ])("rejects Docker 29 published-port evidence: %s", async (kind, ports) => {
    const inspected = docker29Inspect();
    if (kind === "retained requested binding")
      inspected.HostConfig.PortBindings = ports;
    else inspected.NetworkSettings.Ports = ports;
    await expect(inspect(runtimeFor(inspected))).rejects.toThrow(
      "docker_container_confinement_unproven",
    );
  });

  it.each([
    ["absent", {}],
    [
      "multiple",
      {
        [networkName]: docker29Inspect().NetworkSettings.Networks[networkName],
        "foreign-network":
          docker29Inspect().NetworkSettings.Networks[networkName],
      },
    ],
    [
      "malformed address",
      {
        [networkName]: {
          ...docker29Inspect().NetworkSettings.Networks[networkName],
          IPAddress: "172.28.0.999",
        },
      },
    ],
    [
      "foreign address",
      {
        [networkName]: {
          ...docker29Inspect().NetworkSettings.Networks[networkName],
          IPAddress: "192.0.2.10",
        },
      },
    ],
  ])("rejects %s container-network membership", async (_, networks) => {
    const inspected = docker29Inspect();
    inspected.NetworkSettings.Networks = networks;
    await expect(inspect(runtimeFor(inspected))).rejects.toThrow(
      "docker_container_confinement_unproven",
    );
  });

  it.each([
    ["external bridge", { Internal: false }],
    ["foreign driver", { Driver: "overlay" }],
    ["foreign name", { Name: "foreign-network" }],
    ["foreign network identity", { Id: "f".repeat(64) }],
    ["missing subnet", { IPAM: { Config: [] } }],
    [
      "multiple IPv4 subnets",
      {
        IPAM: {
          Config: [{ Subnet: "172.28.0.0/16" }, { Subnet: "172.29.0.0/16" }],
        },
      },
    ],
    ["foreign membership", { Containers: {} }],
    [
      "foreign attached container",
      {
        Containers: {
          ...docker29NetworkInspect().Containers,
          ["f".repeat(64)]: {
            EndpointID: "e".repeat(64),
            IPv4Address: "172.28.0.3/16",
            IPv6Address: "",
            MacAddress: "02:42:ac:1c:00:03",
            Name: "foreign-container",
          },
        },
      },
    ],
    [
      "duplicate attached address",
      {
        Containers: {
          ...docker29NetworkInspect().Containers,
          ["f".repeat(64)]: {
            EndpointID: "e".repeat(64),
            IPv4Address: "172.28.0.2/16",
            IPv6Address: "",
            MacAddress: "02:42:ac:1c:00:03",
            Name: `${runId}-client-1`,
          },
        },
      },
    ],
  ])("rejects %s network evidence", async (_, mutation) => {
    const network = { ...docker29NetworkInspect(), ...mutation };
    await expect(
      inspect(runtimeFor(docker29Inspect(), network)),
    ).rejects.toThrow("docker_container_confinement_unproven");
  });

  it.each([
    ["image", (value) => (value.Config.Image = `${image}-foreign`)],
    ["resource label", (value) => (value.Config.Labels = {})],
    ["UTS namespace", (value) => (value.HostConfig.UTSMode = "host")],
    ["writable storage", (value) => (value.Mounts[0].RW = false)],
    ["mount propagation", (value) => (value.Mounts[0].Propagation = "rshared")],
    ["secret mount", (value) => value.Mounts.pop()],
    ["secret value", (value) => value.Config.Env.push("PASSWORD=gate-secret")],
  ])("rejects mutated %s confinement", async (kind, mutate) => {
    const inspected = docker29Inspect();
    mutate(inspected);
    await expect(
      inspect(
        runtimeFor(inspected),
        kind === "secret value" ? ["gate-secret"] : [],
      ),
    ).rejects.toThrow(
      kind === "secret value"
        ? "docker_container_metadata_contains_secret"
        : "docker_container_confinement_unproven",
    );
  });
});
