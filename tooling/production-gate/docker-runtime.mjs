import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import {
  MINIO_DATA_TMPFS_OPTIONS,
  MINIO_SUPERVISOR_COMMAND,
  MINIO_SUPERVISOR_ENTRYPOINT,
  POSTGRES_PARENT_TMPFS_DESTINATION,
  POSTGRES_PARENT_TMPFS_OPTIONS,
  POSTGRES_SOCKET_TMPFS_DESTINATION,
  POSTGRES_SOCKET_TMPFS_OPTIONS,
  assertSafeDockerArguments,
  isolatedNetworkArguments,
} from "./docker-plan.mjs";
import {
  evaluateInternalEndpoint,
  exactBindMounts,
  exactOwnedNetworkMembers,
  exactSingleIpv4Subnet,
  noRequestedPortBindings,
  unpublishedPortMap,
} from "./docker-confinement-evidence.mjs";
import {
  CLIENT_TMPFS_OPTIONS,
  exactClientConfinement,
} from "./docker-client-confinement.mjs";
import { OWNED_RESOURCE_PATTERN } from "./constants.mjs";
import { restartMinioServerProcessWithDocker } from "./minio-process-restart.mjs";

const ENDPOINT_CONVERGENCE_ATTEMPTS = 5;
const ENDPOINT_CONVERGENCE_DELAY_MS = 50;

function boundedScratchTmpfs(options) {
  if (typeof options !== "string") return false;
  const fields = options.split(",");
  return (
    fields.length === new Set(fields).size &&
    fields.includes("rw") &&
    fields.includes("size=67108864") &&
    !fields.includes("ro") &&
    !fields.some((field) => /^size=/u.test(field) && field !== "size=67108864")
  );
}

function exactContainerTmpfs(tmpfs, expectedWritableStorage) {
  if (tmpfs === null || typeof tmpfs !== "object" || Array.isArray(tmpfs))
    return false;
  const postgresParentRequired =
    expectedWritableStorage?.kind === "bind" &&
    expectedWritableStorage.destination === "/var/lib/postgresql/data";
  const expectedDestinations = new Set([
    "/tmp",
    ...(expectedWritableStorage?.kind === "tmpfs"
      ? [expectedWritableStorage.destination]
      : []),
    ...(postgresParentRequired ? [POSTGRES_PARENT_TMPFS_DESTINATION] : []),
    ...(postgresParentRequired ? [POSTGRES_SOCKET_TMPFS_DESTINATION] : []),
  ]);
  const destinations = Object.keys(tmpfs);
  return (
    destinations.length === expectedDestinations.size &&
    destinations.every((destination) =>
      expectedDestinations.has(destination),
    ) &&
    boundedScratchTmpfs(tmpfs["/tmp"]) &&
    (expectedWritableStorage?.kind !== "tmpfs" ||
      tmpfs[expectedWritableStorage.destination] ===
        MINIO_DATA_TMPFS_OPTIONS) &&
    (!postgresParentRequired ||
      tmpfs[POSTGRES_PARENT_TMPFS_DESTINATION] ===
        POSTGRES_PARENT_TMPFS_OPTIONS) &&
    (!postgresParentRequired ||
      tmpfs[POSTGRES_SOCKET_TMPFS_DESTINATION] ===
        POSTGRES_SOCKET_TMPFS_OPTIONS)
  );
}

function exactMinioCredentialFileEnvironment(environment) {
  if (!Array.isArray(environment)) return false;
  const expected = [
    "MINIO_ROOT_PASSWORD_FILE=/run/secrets/minio-root-password",
    "MINIO_ROOT_USER_FILE=/run/secrets/minio-root-user",
  ];
  return (
    expected.every(
      (entry) => environment.filter((value) => value === entry).length === 1,
    ) &&
    !environment.some((entry) => /^MINIO_ROOT_(?:PASSWORD|USER)=/u.test(entry))
  );
}

function missingDockerObject(result) {
  return (
    result.code !== 0 &&
    /(?:no such|not found)/iu.test(`${result.stdout}\n${result.stderr}`)
  );
}

export function createDockerRecoveryCleaners({ executable, runId, runner }) {
  const command = (args) => runner.run(executable, args, { timeoutMs: 5_000 });
  return Object.freeze({
    "docker-container": async (record) => {
      const inspected = await command([
        "container",
        "inspect",
        '--format={{.Id}}|{{index .Config.Labels "workload-funnel.production-gate.resource"}}',
        record.name,
      ]);
      if (missingDockerObject(inspected)) return;
      const [identity, label] = inspected.stdout.trim().split("|");
      if (
        inspected.code !== 0 ||
        label !== record.name ||
        (record.observed.identity !== undefined &&
          record.observed.identity !== identity)
      )
        throw new Error("docker_container_cleanup_ownership_uncertain");
      const removed = await command([
        "container",
        "rm",
        "--force",
        "--volumes",
        record.name,
      ]);
      if (removed.code !== 0)
        throw new Error("docker_container_cleanup_uncertain");
    },
    "docker-network": async (record) => {
      const inspected = await command([
        "network",
        "inspect",
        '--format={{.Id}}|{{index .Labels "workload-funnel.production-gate.run"}}',
        record.name,
      ]);
      if (missingDockerObject(inspected)) return;
      const [identity, label] = inspected.stdout.trim().split("|");
      if (
        inspected.code !== 0 ||
        label !== runId ||
        (record.observed.identity !== undefined &&
          record.observed.identity !== identity)
      )
        throw new Error("docker_network_cleanup_ownership_uncertain");
      const removed = await command(["network", "rm", record.name]);
      if (removed.code !== 0)
        throw new Error("docker_network_cleanup_uncertain");
    },
  });
}

export class GateDockerRuntime {
  constructor({
    allowedReadOnlyMounts = new Set(),
    executable,
    ioDevice,
    ledger,
    runId,
    runner,
    sandboxRoot,
    secretValues = [],
  }) {
    this.allowedReadOnlyMounts = allowedReadOnlyMounts;
    this.executable = executable;
    this.ioDevice = ioDevice;
    this.ledger = ledger;
    this.runId = runId;
    this.runner = runner;
    this.sandboxRoot = sandboxRoot;
    this.secretValues = secretValues;
    this.network = `${runId}-network`;
    this.clientSequence = 0;
  }

  async command(args, timeoutMs = 30_000) {
    const result = await this.runner.run(this.executable, args, { timeoutMs });
    if (result.code !== 0) throw new Error("docker_gate_command_failed");
    return result.stdout.trim();
  }

  async assertLocalEngine() {
    const endpoint = await this.command([
      "context",
      "inspect",
      "--format={{.Endpoints.docker.Host}}",
    ]);
    if (
      !new Set(["unix:///run/docker.sock", "unix:///var/run/docker.sock"]).has(
        endpoint,
      )
    )
      throw new Error("docker_engine_is_not_local_unix_socket");
    const identity = await this.command(["info", "--format={{.ID}}"]);
    if (!/^[A-Za-z0-9:._-]{8,128}$/u.test(identity))
      throw new Error("docker_engine_identity_invalid");
    return Object.freeze({ endpoint, identity });
  }

  async assertResourceAbsent(kind, name) {
    const result = await this.runner.run(
      this.executable,
      [kind, "inspect", name],
      { timeoutMs: 5_000 },
    );
    if (!missingDockerObject(result))
      throw new Error("docker_gate_resource_preexisting");
  }

  async createNetwork() {
    await this.assertResourceAbsent("network", this.network);
    const recordId = await this.ledger.prepare("docker-network", this.network, {
      label: `workload-funnel.production-gate.run=${this.runId}`,
    });
    const identity = await this.command(isolatedNetworkArguments(this.runId));
    if (!/^[a-f0-9]{12,64}$/u.test(identity)) {
      await this.command(["network", "rm", this.network]);
      throw new Error("docker_network_identity_invalid");
    }
    let inspected;
    try {
      inspected = JSON.parse(
        await this.command(["network", "inspect", this.network]),
      );
    } catch {
      await this.command(["network", "rm", this.network]);
      throw new Error("docker_network_confinement_unproven");
    }
    const network = inspected?.[0];
    const subnet = exactSingleIpv4Subnet(network);
    if (
      !Array.isArray(inspected) ||
      inspected.length !== 1 ||
      network?.Id !== identity ||
      network?.Name !== this.network ||
      network?.Driver !== "bridge" ||
      network?.Internal !== true ||
      network?.Ingress !== false ||
      network?.Labels?.["workload-funnel.production-gate.run"] !== this.runId ||
      subnet === undefined ||
      !exactOwnedNetworkMembers(network, this.runId, subnet) ||
      Object.keys(network.Containers).length !== 0
    ) {
      await this.command(["network", "rm", this.network]);
      throw new Error("docker_network_confinement_unproven");
    }
    this.networkIdentity = identity;
    const cleanup = async () => {
      const observed = await this.command([
        "network",
        "inspect",
        "--format={{.Id}}",
        this.network,
      ]);
      if (observed !== identity)
        throw new Error("docker_network_identity_changed");
      await this.command(["network", "rm", this.network]);
    };
    await this.ledger.finalize(recordId, { identity }, cleanup);
    return this.network;
  }

  async startContainer(name, arguments_) {
    await this.assertResourceAbsent("container", name);
    const recordId = await this.ledger.prepare("docker-container", name, {
      label: `workload-funnel.production-gate.resource=${name}`,
    });
    const identity = await this.command(
      assertSafeDockerArguments(arguments_),
      45_000,
    );
    if (!/^[a-f0-9]{12,64}$/u.test(identity)) {
      await this.command(["container", "rm", "--force", "--volumes", name]);
      throw new Error("docker_container_identity_invalid");
    }
    const cleanup = async () => {
      const observed = await this.command([
        "container",
        "inspect",
        "--format={{.Id}}",
        name,
      ]);
      if (observed !== identity)
        throw new Error("docker_container_identity_changed");
      await this.command(["container", "rm", "--force", "--volumes", name]);
    };
    await this.ledger.finalize(recordId, { identity }, cleanup);
    const started = await this.command(["container", "start", name], 15_000);
    if (started !== name)
      throw new Error("docker_container_start_identity_invalid");
    return identity;
  }

  async inspectContainerConfinement(
    name,
    expectedUser,
    forbiddenValues = [],
    expectedIdentity,
    expectedWritableStorage,
    expectedContainerPort,
    expectedImage,
    expectedSecretMounts,
    expectedProcess,
  ) {
    for (
      let attempt = 1;
      attempt <= ENDPOINT_CONVERGENCE_ATTEMPTS;
      attempt += 1
    ) {
      const evidence = await this.inspectContainerConfinementObservation(
        name,
        expectedUser,
        forbiddenValues,
        expectedIdentity,
        expectedWritableStorage,
        expectedContainerPort,
        expectedImage,
        expectedSecretMounts,
        expectedProcess,
      );
      if (evidence !== undefined) return evidence;
      if (attempt === ENDPOINT_CONVERGENCE_ATTEMPTS)
        throw new Error("docker_container_confinement_unproven");
      await delay(ENDPOINT_CONVERGENCE_DELAY_MS);
    }
    throw new Error("docker_container_confinement_unproven");
  }

  async inspectContainerConfinementObservation(
    name,
    expectedUser,
    forbiddenValues,
    expectedIdentity,
    expectedWritableStorage,
    expectedContainerPort,
    expectedImage,
    expectedSecretMounts,
    expectedProcess,
  ) {
    const [output, networkOutput, publishedPorts] = await Promise.all([
      this.command(["container", "inspect", name]),
      this.command(["network", "inspect", this.network]),
      this.runner.run(this.executable, ["port", name], {
        timeoutMs: 5_000,
      }),
    ]);
    if (
      forbiddenValues.some(
        (value) => typeof value !== "string" || value.length < 1,
      ) ||
      forbiddenValues.some((value) => output.includes(value))
    )
      throw new Error("docker_container_metadata_contains_secret");
    let decoded;
    let decodedNetwork;
    try {
      decoded = JSON.parse(output);
      decodedNetwork = JSON.parse(networkOutput);
    } catch {
      throw new Error("docker_container_inspect_malformed");
    }
    const inspected = decoded?.[0];
    const host = inspected?.HostConfig;
    const container = inspected?.Config;
    const network = decodedNetwork?.[0];
    const attachedNetworks = inspected?.NetworkSettings?.Networks;
    const subnet = exactSingleIpv4Subnet(network);
    const endpointEvidence = evaluateInternalEndpoint({
      attachedNetworks,
      containerIdentity: inspected?.Id,
      name,
      network,
      networkName: this.network,
      runId: this.runId,
      subnet,
    });
    const writableStorageProven = exactContainerTmpfs(
      host?.Tmpfs,
      expectedWritableStorage,
    );
    const processProven =
      expectedProcess === undefined ||
      (Array.isArray(expectedProcess.readOnlyMounts) &&
        expectedProcess.readOnlyMounts.length === 1 &&
        expectedProcess.readOnlyMounts[0].destination ===
          MINIO_SUPERVISOR_COMMAND[0] &&
        this.allowedReadOnlyMounts.has(
          expectedProcess.readOnlyMounts[0].source,
        ) &&
        Array.isArray(container?.Entrypoint) &&
        container.Entrypoint.length === MINIO_SUPERVISOR_ENTRYPOINT.length &&
        container.Entrypoint.every(
          (argument, index) => argument === MINIO_SUPERVISOR_ENTRYPOINT[index],
        ) &&
        Array.isArray(container?.Cmd) &&
        container.Cmd.length === MINIO_SUPERVISOR_COMMAND.length &&
        container.Cmd.every(
          (argument, index) => argument === MINIO_SUPERVISOR_COMMAND[index],
        ) &&
        exactMinioCredentialFileEnvironment(container?.Env));
    const expectedReadOnlyMounts = [
      ...(Array.isArray(expectedSecretMounts) ? expectedSecretMounts : []),
      ...(Array.isArray(expectedProcess?.readOnlyMounts)
        ? expectedProcess.readOnlyMounts
        : []),
    ];
    if (
      !Array.isArray(decoded) ||
      decoded.length !== 1 ||
      typeof inspected?.Id !== "string" ||
      !/^sha256:[a-f0-9]{64}$/u.test(inspected?.Image ?? "") ||
      (expectedIdentity !== undefined && inspected.Id !== expectedIdentity) ||
      container?.Image !== expectedImage ||
      container?.Labels?.["workload-funnel.production-gate.resource"] !==
        name ||
      container?.User !== expectedUser ||
      host?.Privileged !== false ||
      host?.ReadonlyRootfs !== true ||
      host?.Init !== true ||
      host?.IpcMode !== "private" ||
      host?.UTSMode !== "" ||
      host?.NetworkMode !== this.network ||
      host?.Memory !== 2_147_483_648 ||
      host?.MemorySwap !== 2_147_483_648 ||
      host?.NanoCpus !== 2_000_000_000 ||
      host?.PidsLimit !== 256 ||
      host?.RestartPolicy?.Name !== "no" ||
      !(
        host?.CapAdd === null ||
        (Array.isArray(host?.CapAdd) && host.CapAdd.length === 0)
      ) ||
      !Array.isArray(host?.CapDrop) ||
      host.CapDrop.length !== 1 ||
      host.CapDrop[0] !== "ALL" ||
      !host?.SecurityOpt?.some((value) =>
        value.startsWith("no-new-privileges"),
      ) ||
      !writableStorageProven ||
      !processProven ||
      !exactBindMounts(
        inspected?.Mounts,
        expectedWritableStorage,
        expectedReadOnlyMounts,
      ) ||
      !Number.isSafeInteger(expectedContainerPort) ||
      expectedContainerPort < 1 ||
      expectedContainerPort > 65_535 ||
      !noRequestedPortBindings(host?.PortBindings) ||
      !unpublishedPortMap(inspected?.NetworkSettings?.Ports) ||
      publishedPorts.code !== 0 ||
      publishedPorts.stdout !== "" ||
      publishedPorts.stderr !== "" ||
      !Array.isArray(decodedNetwork) ||
      decodedNetwork.length !== 1 ||
      network?.Name !== this.network ||
      (this.networkIdentity !== undefined &&
        network?.Id !== this.networkIdentity) ||
      network?.Driver !== "bridge" ||
      network?.Internal !== true ||
      network?.Ingress !== false ||
      network?.Labels?.["workload-funnel.production-gate.run"] !== this.runId ||
      subnet === undefined ||
      endpointEvidence.state === "invalid"
    )
      throw new Error("docker_container_confinement_unproven");
    if (endpointEvidence.state === "transient-absence") return undefined;
    const { ipv4Address } = endpointEvidence;
    return Object.freeze({
      capabilitiesDropped: true,
      configurationSha256: createHash("sha256")
        .update(JSON.stringify({ container, host }), "utf8")
        .digest("hex"),
      exactIdentity: inspected.Id,
      imageId: inspected.Image,
      internalNetwork: this.network,
      internalNetworkEndpoint: Object.freeze({
        ipv4Address,
        port: expectedContainerPort,
      }),
      metadataSecretValuesAbsent: true,
      nonRootUser: expectedUser,
      privateUtsNamespace: true,
      publishedPorts: 0,
      readOnlyRoot: true,
      writableStorage: Object.freeze({
        ...expectedWritableStorage,
        ...(expectedWritableStorage?.kind === "bind" &&
        expectedWritableStorage.destination === "/var/lib/postgresql/data"
          ? {
              parentTmpfs: Object.freeze({
                destination: POSTGRES_PARENT_TMPFS_DESTINATION,
                options: POSTGRES_PARENT_TMPFS_OPTIONS,
              }),
              socketTmpfs: Object.freeze({
                destination: POSTGRES_SOCKET_TMPFS_DESTINATION,
                options: POSTGRES_SOCKET_TMPFS_OPTIONS,
              }),
            }
          : {}),
      }),
      resourceLimits: Object.freeze({
        memoryBytes: host.Memory,
        pids: host.PidsLimit,
        virtualCpus: host.NanoCpus / 1_000_000_000,
      }),
      ...(expectedProcess === undefined
        ? {}
        : {
            processSupervisor: Object.freeze({
              command: Object.freeze([...MINIO_SUPERVISOR_COMMAND]),
              entrypoint: Object.freeze([...MINIO_SUPERVISOR_ENTRYPOINT]),
              readOnlyMount: Object.freeze({
                ...expectedProcess.readOnlyMounts[0],
              }),
            }),
          }),
    });
  }

  async restartMinioServerProcess(name, identity) {
    return restartMinioServerProcessWithDocker({
      identity,
      name,
      runtime: this,
    });
  }

  async crashAndRestart(name, identity, afterCrash = () => Promise.resolve()) {
    if (
      !OWNED_RESOURCE_PATTERN.test(name) ||
      !/^[a-f0-9]{12,64}$/u.test(identity) ||
      typeof afterCrash !== "function"
    )
      throw new Error("docker_crash_probe_identity_invalid");
    const before = await this.command([
      "container",
      "inspect",
      "--format={{.State.Status}}|{{.State.Pid}}|{{.Id}}",
      name,
    ]);
    const [beforeStatus, beforePidText, beforeIdentity] = before.split("|");
    const beforePid = Number(beforePidText);
    if (
      beforeStatus !== "running" ||
      !Number.isSafeInteger(beforePid) ||
      beforePid < 2 ||
      beforeIdentity !== identity
    )
      throw new Error("docker_crash_probe_precondition_unproven");
    const killed = await this.command(["kill", "--signal=KILL", name], 5_000);
    if (killed !== name) throw new Error("docker_crash_signal_unproven");
    const crashed = await this.command([
      "container",
      "inspect",
      "--format={{.State.Status}}|{{.State.ExitCode}}|{{.State.OOMKilled}}|{{.State.Pid}}|{{.Id}}",
      name,
    ]);
    const [status, exitCode, oomKilled, pid, crashedIdentity] =
      crashed.split("|");
    if (
      status !== "exited" ||
      exitCode !== "137" ||
      oomKilled !== "false" ||
      pid !== "0" ||
      crashedIdentity !== identity
    )
      throw new Error("docker_sigkill_crash_unproven");
    await afterCrash();
    const started = await this.command(["container", "start", name], 15_000);
    if (started !== name)
      throw new Error("docker_crash_restart_identity_invalid");
    const resumed = await this.command([
      "container",
      "inspect",
      "--format={{.State.Status}}|{{.State.Pid}}|{{.Id}}",
      name,
    ]);
    const [resumedStatus, resumedPidText, resumedIdentity] = resumed.split("|");
    const resumedPid = Number(resumedPidText);
    if (
      resumedStatus !== "running" ||
      !Number.isSafeInteger(resumedPid) ||
      resumedPid < 2 ||
      resumedIdentity !== identity
    )
      throw new Error("docker_crash_restart_unproven");
    return Object.freeze({
      containerIdentityStable: true,
      exitCode: 137,
      oomKilled: false,
      processBoundaryStopped: true,
      signal: "SIGKILL",
    });
  }

  async partition(name) {
    await this.command(["network", "disconnect", this.network, name]);
  }

  async heal(name) {
    await this.command(["network", "connect", this.network, name]);
  }

  async runClient({
    arguments_,
    entrypoint,
    environment = {},
    image,
    mounts = [],
  }) {
    if (
      !Array.isArray(mounts) ||
      mounts.some(
        ({ destination, source }) =>
          typeof source !== "string" ||
          ((resolve(source) !== source ||
            !source.startsWith(`${this.sandboxRoot}/`)) &&
            !this.allowedReadOnlyMounts.has(source)) ||
          typeof destination !== "string" ||
          !/^\/(?:gate|run\/secrets)\/[A-Za-z0-9._/-]{1,256}$/u.test(
            destination,
          ) ||
          destination
            .split("/")
            .some((segment) => segment === "." || segment === ".."),
      ) ||
      environment === null ||
      typeof environment !== "object" ||
      Array.isArray(environment) ||
      Object.keys(environment).length !== 0 ||
      (entrypoint !== undefined &&
        (typeof entrypoint !== "string" ||
          !entrypoint.startsWith("/") ||
          entrypoint.includes("\0"))) ||
      typeof image !== "string" ||
      !/^[A-Za-z0-9./_-]+:[A-Za-z0-9._-]+@sha256:[a-f0-9]{64}$/u.test(image)
    )
      throw new Error("docker_client_file_outside_sandbox");
    this.clientSequence += 1;
    if (this.clientSequence > 64)
      throw new Error("docker_client_command_limit_exceeded");
    const name = `${this.runId}-client-${String(this.clientSequence)}`;
    await this.assertResourceAbsent("container", name);
    const args = [
      "create",
      "--pull=never",
      "--platform=linux/amd64",
      "--name",
      name,
      "--network",
      this.network,
      "--cpus",
      "1",
      "--memory",
      "268435456",
      "--memory-swap",
      "268435456",
      "--pids-limit",
      "64",
      "--blkio-weight",
      "100",
      "--device-read-bps",
      `${this.ioDevice}:16mb`,
      "--device-write-bps",
      `${this.ioDevice}:8mb`,
      "--cap-drop",
      "ALL",
      "--security-opt",
      "no-new-privileges=true",
      "--read-only",
      "--init",
      "--ipc=private",
      "--user",
      "1000:1000",
      "--restart",
      "no",
      "--stop-timeout",
      "5",
      "--tmpfs",
      `/tmp:${CLIENT_TMPFS_OPTIONS["/tmp"]}`,
      "--tmpfs",
      `/gate/mc:${CLIENT_TMPFS_OPTIONS["/gate/mc"]}`,
      "--label",
      `workload-funnel.production-gate.resource=${name}`,
      ...Object.entries(environment).flatMap(([key, value]) => [
        "--env",
        `${key}=${value}`,
      ]),
      ...mounts.flatMap(({ destination, source }) => [
        "--mount",
        `type=bind,src=${source},dst=${destination},readonly`,
      ]),
      ...(entrypoint === undefined ? [] : ["--entrypoint", entrypoint]),
      image,
      ...arguments_,
    ];
    const recordId = await this.ledger.prepare("docker-container", name, {
      label: `workload-funnel.production-gate.resource=${name}`,
    });
    const identity = await this.command(
      assertSafeDockerArguments(args),
      15_000,
    );
    if (!/^[a-f0-9]{12,64}$/u.test(identity)) {
      await this.command(["container", "rm", "--force", "--volumes", name]);
      throw new Error("docker_client_identity_invalid");
    }
    const cleanup = async () => {
      const observed = await this.command([
        "container",
        "inspect",
        "--format={{.Id}}",
        name,
      ]);
      if (observed !== identity)
        throw new Error("docker_client_identity_changed");
      await this.command(["container", "rm", "--force", "--volumes", name]);
    };
    await this.ledger.finalize(recordId, { identity }, cleanup);
    await this.inspectClientConfinement(name, identity, { image, mounts });
    return this.command(["container", "start", "--attach", name], 15_000);
  }

  async inspectClientConfinement(
    name,
    identity,
    { image: expectedImage, mounts: expectedMounts = [] } = {},
  ) {
    const [output, publishedPorts] = await Promise.all([
      this.command(["container", "inspect", name]),
      this.runner.run(this.executable, ["port", name], { timeoutMs: 5_000 }),
    ]);
    if (
      !Array.isArray(this.secretValues) ||
      this.secretValues.some(
        (value) => typeof value !== "string" || value.length < 1,
      ) ||
      this.secretValues.some((value) => output.includes(value))
    )
      throw new Error("docker_container_metadata_contains_secret");
    let decoded;
    try {
      decoded = JSON.parse(output);
    } catch {
      throw new Error("docker_container_inspect_malformed");
    }
    const inspected = decoded?.[0];
    if (
      !Array.isArray(decoded) ||
      decoded.length !== 1 ||
      !Array.isArray(expectedMounts) ||
      !exactClientConfinement({
        expectedImage,
        expectedMounts,
        identity,
        inspected,
        name,
        networkName: this.network,
        publishedPorts,
      })
    )
      throw new Error("docker_client_confinement_unproven");
    return true;
  }
}
