import { describe, expect, it, vi } from "vitest";

import {
  MINIO_DATA_TMPFS_OPTIONS,
  MINIO_IMAGE_ENTRYPOINT,
  MINIO_SUPERVISOR_COMMAND,
  MINIO_SUPERVISOR_DESTINATION,
  objectContainerArguments,
} from "./docker-plan.mjs";
import { GateDockerRuntime } from "./docker-runtime.mjs";

const runId = "wf-production-gate-0123456789abcdef0123456789abcdef";
const name = `${runId}-object`;
const networkName = `${runId}-network`;
const identity = "a".repeat(64);
const networkIdentity = "b".repeat(64);
const endpointIdentity = "c".repeat(64);
const image = `quay.io/minio/minio:test@sha256:${"f".repeat(64)}`;
const imageId = `sha256:${"1".repeat(64)}`;
const rootUserFile = `/tmp/${runId}/minio-root-user`;
const rootPasswordFile = `/tmp/${runId}/minio-root-password`;
const supervisorFile = `/reviewed/${runId}/minio-supervisor.sh`;
const secrets = [
  { destination: "/run/secrets/minio-root-user", source: rootUserFile },
  {
    destination: "/run/secrets/minio-root-password",
    source: rootPasswordFile,
  },
];
const processSupervisor = {
  readOnlyMounts: [
    { destination: MINIO_SUPERVISOR_DESTINATION, source: supervisorFile },
  ],
};

function containerInspect() {
  return {
    Config: {
      Cmd: [...MINIO_SUPERVISOR_COMMAND],
      Entrypoint: [...MINIO_IMAGE_ENTRYPOINT],
      Env: [
        "MINIO_ROOT_USER_FILE=/run/secrets/minio-root-user",
        "MINIO_ROOT_PASSWORD_FILE=/run/secrets/minio-root-password",
      ],
      Image: image,
      Labels: { "workload-funnel.production-gate.resource": name },
      User: "1000:1000",
    },
    HostConfig: {
      CapAdd: null,
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
        "/data": MINIO_DATA_TMPFS_OPTIONS,
        "/tmp":
          "rw,nosuid,nodev,noexec,size=67108864,uid=1000,gid=1000,mode=0700",
      },
      UTSMode: "",
    },
    Id: identity,
    Image: imageId,
    Mounts: [
      ...secrets.map(({ destination, source }) => ({
        Destination: destination,
        Propagation: "rprivate",
        RW: false,
        Source: source,
        Type: "bind",
      })),
      {
        Destination: MINIO_SUPERVISOR_DESTINATION,
        Propagation: "rprivate",
        RW: false,
        Source: supervisorFile,
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

function networkInspect() {
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

function inspect(inspected, forbiddenValues = []) {
  const runtime = new GateDockerRuntime({
    allowedReadOnlyMounts: new Set([supervisorFile]),
    executable: "/usr/bin/docker",
    ioDevice: "/dev/vda",
    runId,
    runner: {
      run: vi.fn((_executable, args) =>
        Promise.resolve({
          code: 0,
          stderr: "",
          stdout:
            args[0] === "port"
              ? ""
              : JSON.stringify([
                  args[0] === "container" ? inspected : networkInspect(),
                ]),
        }),
      ),
    },
    sandboxRoot: `/tmp/${runId}`,
  });
  return runtime.inspectContainerConfinement(
    name,
    "1000:1000",
    forbiddenValues,
    identity,
    { destination: "/data", kind: "tmpfs" },
    9000,
    image,
    secrets,
    processSupervisor,
  );
}

describe("Docker 29 supervised MinIO confinement", () => {
  it("creates the exact reviewed supervisor boundary over bounded tmpfs data", () => {
    const args = objectContainerArguments({
      image,
      ioDevice: "/dev/vda",
      name,
      network: networkName,
      rootPasswordFile,
      rootUserFile,
      supervisorFile,
    });
    const imageIndex = args.indexOf(image);
    expect(args.slice(imageIndex + 1)).toEqual(MINIO_SUPERVISOR_COMMAND);
    expect(args).toContain(`/data:${MINIO_DATA_TMPFS_OPTIONS}`);
    expect(args).toContain(
      `type=bind,src=${supervisorFile},dst=${MINIO_SUPERVISOR_DESTINATION},readonly`,
    );
    expect(args).not.toContain("--publish");
    expect(args).not.toContain("-p");
  });

  it("accepts the exact Docker 29 inspect shape and records the supervisor", async () => {
    await expect(inspect(containerInspect())).resolves.toMatchObject({
      capabilitiesDropped: true,
      exactIdentity: identity,
      metadataSecretValuesAbsent: true,
      processSupervisor: {
        command: MINIO_SUPERVISOR_COMMAND,
        readOnlyMount: processSupervisor.readOnlyMounts[0],
      },
      publishedPorts: 0,
      readOnlyRoot: true,
      writableStorage: { destination: "/data", kind: "tmpfs" },
    });
  });

  it.each([
    ["missing supervisor mount", (value) => value.Mounts.pop()],
    ["writable supervisor mount", (value) => (value.Mounts.at(-1).RW = true)],
    [
      "foreign supervisor source",
      (value) => (value.Mounts.at(-1).Source = "/tmp/foreign-supervisor"),
    ],
    ["supervisor command bypass", (value) => (value.Config.Cmd = ["server"])],
    [
      "supervisor entrypoint bypass",
      (value) => (value.Config.Entrypoint = ["/usr/bin/minio"]),
    ],
    [
      "unbounded object tmpfs",
      (value) => (value.HostConfig.Tmpfs["/data"] = "rw,nosuid,nodev,noexec"),
    ],
    [
      "wrong object tmpfs bound",
      (value) =>
        (value.HostConfig.Tmpfs["/data"] = MINIO_DATA_TMPFS_OPTIONS.replace(
          "268435456",
          "536870912",
        )),
    ],
    [
      "foreign tmpfs",
      (value) => (value.HostConfig.Tmpfs["/foreign"] = "rw,size=4096"),
    ],
    ["retained capability", (value) => (value.HostConfig.CapDrop = [])],
    ["added capability", (value) => (value.HostConfig.CapAdd = ["NET_ADMIN"])],
    [
      "host port",
      (value) =>
        (value.HostConfig.PortBindings = {
          "9000/tcp": [{ HostIp: "127.0.0.1", HostPort: "49152" }],
        }),
    ],
  ])("rejects %s", async (_, mutate) => {
    const inspected = containerInspect();
    mutate(inspected);
    await expect(inspect(inspected)).rejects.toThrow(
      "docker_container_confinement_unproven",
    );
  });

  it("rejects a MinIO secret in Docker metadata", async () => {
    const inspected = containerInspect();
    inspected.Config.Env.push("MINIO_ROOT_PASSWORD=adversarial-secret");
    await expect(inspect(inspected, ["adversarial-secret"])).rejects.toThrow(
      "docker_container_metadata_contains_secret",
    );
  });
});
