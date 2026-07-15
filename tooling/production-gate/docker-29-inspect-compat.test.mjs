import { describe, expect, it, vi } from "vitest";

import { GateDockerRuntime } from "./docker-runtime.mjs";

const runId = "wf-production-gate-0123456789abcdef0123456789abcdef";
const postgresData = `/var/data/workload-funnel/sandboxes/${runId}/postgres-data`;
const expectedStorage = {
  destination: "/var/lib/postgresql/data",
  kind: "bind",
  source: postgresData,
};

function docker29Inspect() {
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

function runtimeFor(inspected, dockerPort = "127.0.0.1:49152\n") {
  return new GateDockerRuntime({
    executable: "/usr/bin/docker",
    ioDevice: "/dev/vda",
    runId,
    runner: {
      run: vi.fn((_executable, args) =>
        Promise.resolve({
          code: 0,
          stderr: "",
          stdout:
            args[0] === "container" ? JSON.stringify([inspected]) : dockerPort,
        }),
      ),
    },
    sandboxRoot: `/tmp/${runId}`,
  });
}

async function inspect(runtime, identity = "a".repeat(64)) {
  return runtime.inspectContainerConfinement(
    `${runId}-postgres`,
    "70:70",
    [],
    identity,
    expectedStorage,
    5432,
  );
}

describe("Docker 29 inspect port compatibility", () => {
  it("distinguishes the requested ephemeral port from the assigned port", async () => {
    const inspected = docker29Inspect();
    const runtime = runtimeFor(inspected);
    const confinement = await inspect(runtime);
    expect(confinement).toMatchObject({
      exactIdentity: inspected.Id,
      publishedHostPort: 49152,
      writableStorage: expectedStorage,
    });
    await expect(
      runtime.loopbackPort(
        `${runId}-postgres`,
        5432,
        confinement.publishedHostPort,
      ),
    ).resolves.toBe(49152);
  });

  it("requires docker port to agree with the assigned inspect port", async () => {
    const runtime = runtimeFor(docker29Inspect(), "127.0.0.1:49153\n");
    const confinement = await inspect(runtime);
    await expect(
      runtime.loopbackPort(
        `${runId}-postgres`,
        5432,
        confinement.publishedHostPort,
      ),
    ).rejects.toThrow("docker_published_port_identity_changed");
  });

  it.each([
    ["missing map", {}],
    ["missing binding", { "5432/tcp": null }],
    ["empty binding", { "5432/tcp": [] }],
    [
      "preassigned request",
      { "5432/tcp": [{ HostIp: "127.0.0.1", HostPort: "49152" }] },
    ],
    [
      "wildcard request",
      { "5432/tcp": [{ HostIp: "0.0.0.0", HostPort: "0" }] },
    ],
    [
      "multiple requests",
      {
        "5432/tcp": [
          { HostIp: "127.0.0.1", HostPort: "0" },
          { HostIp: "127.0.0.1", HostPort: "0" },
        ],
      },
    ],
    [
      "extended request binding",
      {
        "5432/tcp": [
          { Extra: "untrusted", HostIp: "127.0.0.1", HostPort: "0" },
        ],
      },
    ],
    [
      "foreign request",
      {
        "5432/tcp": [{ HostIp: "127.0.0.1", HostPort: "0" }],
        "9000/tcp": [{ HostIp: "127.0.0.1", HostPort: "0" }],
      },
    ],
  ])("rejects the adversarial requested-port shape: %s", async (_, ports) => {
    const inspected = docker29Inspect();
    inspected.HostConfig.PortBindings = ports;
    await expect(inspect(runtimeFor(inspected))).rejects.toThrow(
      "docker_container_confinement_unproven",
    );
  });

  it.each([
    ["missing map", {}],
    ["missing binding", { "5432/tcp": null }],
    ["empty binding", { "5432/tcp": [] }],
    [
      "ephemeral result",
      { "5432/tcp": [{ HostIp: "127.0.0.1", HostPort: "0" }] },
    ],
    [
      "wildcard result",
      { "5432/tcp": [{ HostIp: "0.0.0.0", HostPort: "49152" }] },
    ],
    [
      "invalid result",
      { "5432/tcp": [{ HostIp: "127.0.0.1", HostPort: "65536" }] },
    ],
    [
      "multiple results",
      {
        "5432/tcp": [
          { HostIp: "127.0.0.1", HostPort: "49152" },
          { HostIp: "127.0.0.1", HostPort: "49153" },
        ],
      },
    ],
    [
      "extended result binding",
      {
        "5432/tcp": [
          {
            Extra: "untrusted",
            HostIp: "127.0.0.1",
            HostPort: "49152",
          },
        ],
      },
    ],
    [
      "foreign result",
      {
        "5432/tcp": [{ HostIp: "127.0.0.1", HostPort: "49152" }],
        "9000/tcp": [{ HostIp: "127.0.0.1", HostPort: "49153" }],
      },
    ],
  ])("rejects the adversarial assigned-port shape: %s", async (_, ports) => {
    const inspected = docker29Inspect();
    inspected.NetworkSettings.Ports = ports;
    await expect(inspect(runtimeFor(inspected))).rejects.toThrow(
      "docker_container_confinement_unproven",
    );
  });
});
