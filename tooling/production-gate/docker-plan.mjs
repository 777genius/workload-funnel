import { OWNED_NAME_PATTERN, OWNED_RESOURCE_PATTERN } from "./constants.mjs";

const forbidden = [
  "--privileged",
  "--network=host",
  "--network host",
  "/var/run/docker.sock",
  "/run/docker.sock",
  "--env-file",
];

export const POSTGRES_PARENT_TMPFS_DESTINATION = "/var/lib/postgresql";
export const POSTGRES_PARENT_TMPFS_OPTIONS =
  "rw,nosuid,nodev,noexec,size=67108864,uid=70,gid=70,mode=0700";
const POSTGRES_PARENT_TMPFS_ARGUMENT = `${POSTGRES_PARENT_TMPFS_DESTINATION}:${POSTGRES_PARENT_TMPFS_OPTIONS}`;
export const POSTGRES_SOCKET_TMPFS_DESTINATION = "/var/run/postgresql";
export const POSTGRES_SOCKET_TMPFS_OPTIONS =
  "rw,nosuid,nodev,noexec,size=1048576,uid=70,gid=70,mode=0700";
const POSTGRES_SOCKET_TMPFS_ARGUMENT = `${POSTGRES_SOCKET_TMPFS_DESTINATION}:${POSTGRES_SOCKET_TMPFS_OPTIONS}`;
export const MINIO_DATA_TMPFS_OPTIONS =
  "rw,nosuid,nodev,noexec,size=268435456,uid=1000,gid=1000,mode=0700";
export const MINIO_SUPERVISOR_DESTINATION = "/gate/minio-supervisor.sh";
export const MINIO_IMAGE_ENTRYPOINT = Object.freeze([
  "/usr/bin/docker-entrypoint.sh",
]);
export const MINIO_SUPERVISOR_COMMAND = Object.freeze([
  "/bin/sh",
  MINIO_SUPERVISOR_DESTINATION,
  "server",
  "/data",
  "--address",
  ":9000",
  "--console-address",
  ":9001",
]);

export function assertSafeDockerArguments(args) {
  const rendered = args.join(" ");
  if (forbidden.some((token) => rendered.includes(token)))
    throw new Error("unsafe_docker_gate_arguments");
  for (let index = 0; index < args.length; index += 1) {
    if (
      args[index] === "--name" &&
      !OWNED_RESOURCE_PATTERN.test(args[index + 1] ?? "")
    )
      throw new Error("unsafe_docker_resource_name");
    if (args[index] === "--publish" || args[index] === "-p")
      throw new Error("docker_port_publication_forbidden");
  }
  return Object.freeze([...args]);
}

export function isolatedNetworkArguments(runId) {
  if (!OWNED_NAME_PATTERN.test(runId))
    throw new Error("unsafe_docker_gate_run_id");
  return Object.freeze([
    "network",
    "create",
    "--driver",
    "bridge",
    "--internal",
    "--label",
    `workload-funnel.production-gate.run=${runId}`,
    `${runId}-network`,
  ]);
}

function boundedContainerArguments({
  dataStorage,
  environment,
  image,
  ioDevice,
  name,
  network,
  parentTmpfs,
  readOnlyMounts = [],
  scratchTmpfs,
  secretMounts,
  socketTmpfs,
  user,
}) {
  if (
    dataStorage === null ||
    typeof dataStorage !== "object" ||
    Array.isArray(dataStorage) ||
    !new Set(["bind", "tmpfs"]).has(dataStorage.kind) ||
    typeof dataStorage.destination !== "string" ||
    !/^\/(?:data|var\/lib\/postgresql\/data)$/u.test(dataStorage.destination) ||
    (dataStorage.kind === "bind" &&
      (typeof dataStorage.source !== "string" ||
        !/^\/var\/data\/workload-funnel\/sandboxes\/wf-production-gate-[a-f0-9]{32}\/postgres-data$/u.test(
          dataStorage.source,
        ))) ||
    (dataStorage.kind === "tmpfs" &&
      (typeof dataStorage.options !== "string" ||
        !/^\/data:rw,nosuid,nodev,noexec,size=268435456,uid=1000,gid=1000,mode=0700$/u.test(
          dataStorage.options,
        ))) ||
    (parentTmpfs !== undefined &&
      parentTmpfs !== POSTGRES_PARENT_TMPFS_ARGUMENT) ||
    (socketTmpfs !== undefined &&
      socketTmpfs !== POSTGRES_SOCKET_TMPFS_ARGUMENT) ||
    !Array.isArray(secretMounts) ||
    secretMounts.some(
      ({ destination, source }) =>
        typeof source !== "string" ||
        !source.startsWith("/") ||
        source.includes("\u0000") ||
        typeof destination !== "string" ||
        !/^\/run\/secrets\/[a-z0-9-]{1,64}$/u.test(destination),
    ) ||
    !Array.isArray(readOnlyMounts) ||
    readOnlyMounts.length > 1 ||
    readOnlyMounts.some(
      ({ destination, source }) =>
        destination !== MINIO_SUPERVISOR_DESTINATION ||
        typeof source !== "string" ||
        !source.startsWith("/") ||
        source.includes("\u0000"),
    ) ||
    environment === null ||
    typeof environment !== "object" ||
    Array.isArray(environment) ||
    Object.entries(environment).some(
      ([key, value]) =>
        !/^[A-Z][A-Z0-9_]*$/u.test(key) ||
        typeof value !== "string" ||
        value.includes("\u0000") ||
        /(?:PASSWORD|SECRET|TOKEN|CREDENTIAL)$/u.test(key),
    )
  )
    throw new Error("docker_secret_delivery_invalid");
  if (
    !OWNED_RESOURCE_PATTERN.test(name) ||
    !OWNED_RESOURCE_PATTERN.test(network) ||
    !/^\/dev\/[A-Za-z0-9._-]+$/u.test(ioDevice) ||
    typeof image !== "string" ||
    !/^[A-Za-z0-9./_-]+:[A-Za-z0-9._-]+@sha256:[a-f0-9]{64}$/u.test(image) ||
    !/^[A-Za-z0-9_-]+(?::[A-Za-z0-9_-]+)?$/u.test(user)
  )
    throw new Error("unsafe_bounded_container_identity");
  return assertSafeDockerArguments([
    "create",
    "--pull=never",
    "--platform=linux/amd64",
    "--name",
    name,
    "--network",
    network,
    "--cpus",
    "2",
    "--memory",
    "2147483648",
    "--memory-swap",
    "2147483648",
    "--pids-limit",
    "256",
    "--ulimit",
    "fsize=536870912:536870912",
    "--ulimit",
    "nofile=1024:1024",
    "--blkio-weight",
    "100",
    "--device-read-bps",
    `${ioDevice}:16mb`,
    "--device-write-bps",
    `${ioDevice}:8mb`,
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges=true",
    "--read-only",
    "--init",
    "--ipc=private",
    "--user",
    user,
    "--restart",
    "no",
    "--stop-timeout",
    "5",
    "--tmpfs",
    scratchTmpfs,
    ...(parentTmpfs === undefined ? [] : ["--tmpfs", parentTmpfs]),
    ...(socketTmpfs === undefined ? [] : ["--tmpfs", socketTmpfs]),
    ...(dataStorage.kind === "tmpfs"
      ? ["--tmpfs", dataStorage.options]
      : [
          "--mount",
          `type=bind,src=${dataStorage.source},dst=${dataStorage.destination},bind-propagation=rprivate`,
        ]),
    ...Object.entries(environment).flatMap(([key, value]) => [
      "--env",
      `${key}=${value}`,
    ]),
    ...secretMounts.flatMap(({ destination, source }) => [
      "--mount",
      `type=bind,src=${source},dst=${destination},readonly`,
    ]),
    ...readOnlyMounts.flatMap(({ destination, source }) => [
      "--mount",
      `type=bind,src=${source},dst=${destination},readonly`,
    ]),
    "--label",
    `workload-funnel.production-gate.resource=${name}`,
    image,
  ]);
}

export function postgresContainerArguments(config) {
  if (
    !/^[a-z][a-z0-9_]{0,62}$/u.test(config.database) ||
    !/^[a-z][a-z0-9_]{0,62}$/u.test(config.user)
  )
    throw new Error("unsafe_postgres_container_identity");
  return Object.freeze([
    ...boundedContainerArguments({
      dataStorage: {
        destination: "/var/lib/postgresql/data",
        kind: "bind",
        source: config.dataDirectory,
      },
      image: config.image,
      environment: {
        PGDATA: "/var/lib/postgresql/data/gate-data",
        POSTGRES_DB: config.database,
        POSTGRES_PASSWORD_FILE: "/run/secrets/postgres-password",
        POSTGRES_USER: config.user,
      },
      ioDevice: config.ioDevice,
      name: config.name,
      network: config.network,
      parentTmpfs: POSTGRES_PARENT_TMPFS_ARGUMENT,
      scratchTmpfs:
        "/tmp:rw,nosuid,nodev,noexec,size=67108864,uid=70,gid=70,mode=0700",
      secretMounts: [
        {
          destination: "/run/secrets/postgres-password",
          source: config.passwordFile,
        },
      ],
      socketTmpfs: POSTGRES_SOCKET_TMPFS_ARGUMENT,
      user: "70:70",
    }),
    "postgres",
    "-c",
    "max_connections=32",
    "-c",
    "max_wal_size=64MB",
    "-c",
    "min_wal_size=32MB",
    "-c",
    "temp_file_limit=16MB",
    "-c",
    "statement_timeout=15000",
    "-c",
    "idle_in_transaction_session_timeout=15000",
    "-c",
    `unix_socket_directories=${POSTGRES_SOCKET_TMPFS_DESTINATION}`,
  ]);
}

export function objectContainerArguments(config) {
  if (
    typeof config.supervisorFile !== "string" ||
    !config.supervisorFile.startsWith("/") ||
    config.supervisorFile.includes("\u0000")
  )
    throw new Error("unsafe_minio_supervisor_identity");
  return Object.freeze([
    ...boundedContainerArguments({
      dataStorage: {
        destination: "/data",
        kind: "tmpfs",
        options: `/data:${MINIO_DATA_TMPFS_OPTIONS}`,
      },
      image: config.image,
      environment: {
        MINIO_ROOT_PASSWORD_FILE: "/run/secrets/minio-root-password",
        MINIO_ROOT_USER_FILE: "/run/secrets/minio-root-user",
      },
      ioDevice: config.ioDevice,
      name: config.name,
      network: config.network,
      readOnlyMounts: [
        {
          destination: MINIO_SUPERVISOR_DESTINATION,
          source: config.supervisorFile,
        },
      ],
      scratchTmpfs:
        "/tmp:rw,nosuid,nodev,noexec,size=67108864,uid=1000,gid=1000,mode=0700",
      secretMounts: [
        {
          destination: "/run/secrets/minio-root-user",
          source: config.rootUserFile,
        },
        {
          destination: "/run/secrets/minio-root-password",
          source: config.rootPasswordFile,
        },
      ],
      user: "1000:1000",
    }),
    ...MINIO_SUPERVISOR_COMMAND,
  ]);
}
