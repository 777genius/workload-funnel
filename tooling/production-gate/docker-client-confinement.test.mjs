import { describe, expect, it, vi } from "vitest";

import { GateDockerRuntime } from "./docker-runtime.mjs";

const runId = "wf-production-gate-0123456789abcdef0123456789abcdef";
const name = `${runId}-client-1`;
const identity = "c".repeat(64);
const image = `quay.io/minio/mc:test@sha256:${"d".repeat(64)}`;
const sandboxRoot = `/tmp/${runId}`;
const expectedMounts = [
  {
    destination: "/gate/mc/config.json",
    source: `${sandboxRoot}/minio-admin-config.json`,
  },
  {
    destination: "/gate/bootstrap.sh",
    source: `${sandboxRoot}/minio-bootstrap.sh`,
  },
];

function inspectedClient() {
  return {
    Config: {
      Image: image,
      Labels: { "workload-funnel.production-gate.resource": name },
      User: "1000:1000",
    },
    HostConfig: {
      CapAdd: null,
      CapDrop: ["ALL"],
      Init: true,
      IpcMode: "private",
      Memory: 268_435_456,
      MemorySwap: 268_435_456,
      NanoCpus: 1_000_000_000,
      NetworkMode: `${runId}-network`,
      PidsLimit: 64,
      PortBindings: null,
      Privileged: false,
      ReadonlyRootfs: true,
      RestartPolicy: { Name: "no" },
      SecurityOpt: ["no-new-privileges=true"],
      Tmpfs: {
        "/gate/mc":
          "rw,nosuid,nodev,noexec,size=4194304,uid=1000,gid=1000,mode=0700",
        "/tmp":
          "rw,nosuid,nodev,noexec,size=16777216,uid=1000,gid=1000,mode=0700",
      },
      UTSMode: "",
    },
    Id: identity,
    Mounts: expectedMounts.map(({ destination, source }) => ({
      Destination: destination,
      Propagation: "rprivate",
      RW: false,
      Source: source,
      Type: "bind",
    })),
    NetworkSettings: { Ports: null },
  };
}

function runtimeFor(inspected, publishedPorts = "") {
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
            args[0] === "port" ? publishedPorts : JSON.stringify([inspected]),
        }),
      ),
    },
    sandboxRoot,
  });
}

function inspect(runtime) {
  return runtime.inspectClientConfinement(name, identity, {
    image,
    mounts: expectedMounts,
  });
}

describe("MinIO client writable-state confinement", () => {
  it("admits only the narrow mc state tmpfs and exact read-only config binds", async () => {
    const runtime = runtimeFor(inspectedClient());
    await expect(inspect(runtime)).resolves.toBe(true);
    expect(runtime.runner.run.mock.calls).toEqual([
      [
        "/usr/bin/docker",
        ["container", "inspect", name],
        { timeoutMs: 30_000 },
      ],
      ["/usr/bin/docker", ["port", name], { timeoutMs: 5_000 }],
    ]);
  });

  it.each([
    [
      "broader writable tmpfs",
      (value) => (value.HostConfig.Tmpfs["/var/tmp"] = "rw,size=4194304"),
    ],
    [
      "broadened mc tmpfs options",
      (value) =>
        (value.HostConfig.Tmpfs["/gate/mc"] =
          "rw,nosuid,nodev,size=8388608,uid=1000,gid=1000,mode=0700"),
    ],
    [
      "foreign host bind",
      (value) =>
        value.Mounts.push({
          Destination: "/gate/foreign",
          Propagation: "rprivate",
          RW: false,
          Source: "/etc",
          Type: "bind",
        }),
    ],
    ["writable config bind", (value) => (value.Mounts[0].RW = true)],
    [
      "substituted config bind",
      (value) => (value.Mounts[0].Source = `${sandboxRoot}/foreign-config`),
    ],
    [
      "writable root filesystem",
      (value) => (value.HostConfig.ReadonlyRootfs = false),
    ],
    [
      "requested port publication",
      (value) =>
        (value.HostConfig.PortBindings = {
          "9000/tcp": [{ HostIp: "127.0.0.1", HostPort: "49152" }],
        }),
    ],
    [
      "observed port publication",
      (value) =>
        (value.NetworkSettings.Ports = {
          "9000/tcp": [{ HostIp: "127.0.0.1", HostPort: "49152" }],
        }),
    ],
    ["privileged mode", (value) => (value.HostConfig.Privileged = true)],
    ["added capability", (value) => (value.HostConfig.CapAdd = ["NET_ADMIN"])],
    ["incomplete capability drop", (value) => (value.HostConfig.CapDrop = [])],
    [
      "broadened security options",
      (value) => value.HostConfig.SecurityOpt.push("seccomp=unconfined"),
    ],
  ])("rejects %s", async (_, mutate) => {
    const inspected = inspectedClient();
    mutate(inspected);
    await expect(inspect(runtimeFor(inspected))).rejects.toThrow(
      "docker_client_confinement_unproven",
    );
  });

  it("rejects publication reported only by docker port", async () => {
    await expect(
      inspect(runtimeFor(inspectedClient(), "127.0.0.1:49152\n")),
    ).rejects.toThrow("docker_client_confinement_unproven");
  });
});
