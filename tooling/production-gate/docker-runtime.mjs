import { createHash } from "node:crypto";
import { resolve } from "node:path";

import {
  assertSafeDockerArguments,
  isolatedNetworkArguments,
} from "./docker-plan.mjs";
import { OWNED_RESOURCE_PATTERN } from "./constants.mjs";

function missingDockerObject(result) {
  return (
    result.code !== 0 &&
    /(?:no such|not found)/iu.test(`${result.stdout}\n${result.stderr}`)
  );
}

function ipv4Number(value) {
  if (typeof value !== "string") return undefined;
  const octets = value.split(".");
  if (
    octets.length !== 4 ||
    octets.some(
      (octet) => !/^(?:0|[1-9]\d{0,2})$/u.test(octet) || Number(octet) > 255,
    )
  )
    return undefined;
  return octets.reduce((address, octet) => address * 256 + Number(octet), 0);
}

function ipv4BelongsToSubnet(address, subnet, prefixLength) {
  const addressNumber = ipv4Number(address);
  const subnetNumber = ipv4Number(subnet);
  if (
    addressNumber === undefined ||
    subnetNumber === undefined ||
    !Number.isSafeInteger(prefixLength) ||
    prefixLength < 1 ||
    prefixLength > 32
  )
    return false;
  const blockSize = 2 ** (32 - prefixLength);
  return (
    Math.floor(addressNumber / blockSize) ===
    Math.floor(subnetNumber / blockSize)
  );
}

function unpublishedPortMap(value) {
  if (value === null) return true;
  if (typeof value !== "object" || Array.isArray(value)) return false;
  return Object.values(value).every((bindings) => bindings === null);
}

function noRequestedPortBindings(value) {
  return (
    value === null ||
    (typeof value === "object" &&
      !Array.isArray(value) &&
      Object.keys(value).length === 0)
  );
}

function exactSingleIpv4Subnet(network) {
  if (!Array.isArray(network?.IPAM?.Config) || network.IPAM.Config.length !== 1)
    return undefined;
  const config = network.IPAM.Config[0];
  if (
    config === null ||
    typeof config !== "object" ||
    typeof config.Subnet !== "string"
  )
    return undefined;
  const match = config.Subnet.match(
    /^((?:0|[1-9]\d{0,2})(?:\.(?:0|[1-9]\d{0,2})){3})\/(\d{1,2})$/u,
  );
  const prefixLength = Number(match?.[2]);
  if (
    match === null ||
    ipv4Number(match[1]) === undefined ||
    !Number.isSafeInteger(prefixLength) ||
    prefixLength < 1 ||
    prefixLength > 30 ||
    !ipv4BelongsToSubnet(config.Gateway, match[1], prefixLength)
  )
    return undefined;
  return Object.freeze({ address: match[1], prefixLength });
}

function usableIpv4Host(address, subnet) {
  const addressNumber = ipv4Number(address);
  const subnetNumber = ipv4Number(subnet?.address);
  if (addressNumber === undefined || subnetNumber === undefined) return false;
  const blockSize = 2 ** (32 - subnet.prefixLength);
  const networkAddress = Math.floor(subnetNumber / blockSize) * blockSize;
  return (
    addressNumber > networkAddress &&
    addressNumber < networkAddress + blockSize - 1
  );
}

function exactOwnedNetworkMembers(network, runId, subnet) {
  if (
    network?.Containers === null ||
    typeof network?.Containers !== "object" ||
    Array.isArray(network?.Containers)
  )
    return false;
  const addresses = [];
  for (const [identity, member] of Object.entries(network.Containers)) {
    if (
      !/^[a-f0-9]{12,64}$/u.test(identity) ||
      member === null ||
      typeof member !== "object" ||
      !OWNED_RESOURCE_PATTERN.test(member.Name ?? "") ||
      !member.Name.startsWith(`${runId}-`) ||
      !/^[a-f0-9]{12,64}$/u.test(member.EndpointID ?? "") ||
      typeof member.IPv4Address !== "string"
    )
      return false;
    const match = member.IPv4Address.match(
      /^((?:0|[1-9]\d{0,2})(?:\.(?:0|[1-9]\d{0,2})){3})\/(\d{1,2})$/u,
    );
    if (
      match === null ||
      Number(match[2]) !== subnet.prefixLength ||
      !usableIpv4Host(match[1], subnet) ||
      !ipv4BelongsToSubnet(match[1], subnet.address, subnet.prefixLength)
    )
      return false;
    addresses.push(match[1]);
  }
  return new Set(addresses).size === addresses.length;
}

function exactBindMounts(mounts, expectedWritableStorage, expectedSecrets) {
  if (!Array.isArray(mounts) || !Array.isArray(expectedSecrets)) return false;
  const expected = [
    ...(expectedWritableStorage?.kind === "bind"
      ? [
          {
            destination: expectedWritableStorage.destination,
            readWrite: true,
            source: expectedWritableStorage.source,
          },
        ]
      : []),
    ...expectedSecrets.map(({ destination, source }) => ({
      destination,
      readWrite: false,
      source,
    })),
  ];
  return (
    mounts.length === expected.length &&
    expected.every(({ destination, readWrite, source }) =>
      mounts.some(
        (mount) =>
          mount !== null &&
          typeof mount === "object" &&
          mount.Type === "bind" &&
          mount.Source === source &&
          mount.Destination === destination &&
          mount.RW === readWrite &&
          mount.Propagation === "rprivate",
      ),
    )
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
    const networkNames = Object.keys(attachedNetworks ?? {});
    const endpoint = attachedNetworks?.[this.network];
    const prefixLength = endpoint?.IPPrefixLen;
    const ipv4Address = endpoint?.IPAddress;
    const subnet = exactSingleIpv4Subnet(network);
    const membership = network?.Containers?.[inspected?.Id];
    const writableStorageProven =
      expectedWritableStorage?.kind === "bind"
        ? typeof host?.Tmpfs?.[expectedWritableStorage.destination] !== "string"
        : expectedWritableStorage?.kind === "tmpfs" &&
          typeof host?.Tmpfs?.[expectedWritableStorage.destination] ===
            "string";
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
      !host?.CapDrop?.includes("ALL") ||
      !host?.SecurityOpt?.some((value) =>
        value.startsWith("no-new-privileges"),
      ) ||
      typeof host?.Tmpfs?.["/tmp"] !== "string" ||
      !writableStorageProven ||
      !exactBindMounts(
        inspected?.Mounts,
        expectedWritableStorage,
        expectedSecretMounts,
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
      networkNames.length !== 1 ||
      networkNames[0] !== this.network ||
      endpoint === null ||
      typeof endpoint !== "object" ||
      !/^[a-f0-9]{12,64}$/u.test(endpoint.NetworkID ?? "") ||
      endpoint.NetworkID !== network.Id ||
      !/^[a-f0-9]{12,64}$/u.test(endpoint.EndpointID ?? "") ||
      ipv4Number(ipv4Address) === undefined ||
      !Number.isSafeInteger(prefixLength) ||
      prefixLength < 1 ||
      prefixLength > 32 ||
      subnet === undefined ||
      subnet.prefixLength !== prefixLength ||
      !usableIpv4Host(ipv4Address, subnet) ||
      !ipv4BelongsToSubnet(
        ipv4Address,
        subnet?.address,
        subnet?.prefixLength,
      ) ||
      membership === null ||
      typeof membership !== "object" ||
      !exactOwnedNetworkMembers(network, this.runId, subnet) ||
      membership.Name !== name ||
      membership.EndpointID !== endpoint.EndpointID ||
      membership.MacAddress !== endpoint.MacAddress ||
      membership.IPv4Address !== `${ipv4Address}/${String(prefixLength)}` ||
      membership.IPv6Address !== ""
    )
      throw new Error("docker_container_confinement_unproven");
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
      writableStorage: Object.freeze({ ...expectedWritableStorage }),
      resourceLimits: Object.freeze({
        memoryBytes: host.Memory,
        pids: host.PidsLimit,
        virtualCpus: host.NanoCpus / 1_000_000_000,
      }),
    });
  }

  restart(name) {
    return this.command(["restart", "--time", "5", name], 15_000);
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
      "/tmp:rw,nosuid,nodev,noexec,size=16777216,uid=1000,gid=1000,mode=0700",
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
    await this.inspectClientConfinement(name, identity);
    return this.command(["container", "start", "--attach", name], 15_000);
  }

  async inspectClientConfinement(name, identity) {
    const output = await this.command(["container", "inspect", name]);
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
    const host = inspected?.HostConfig;
    const container = inspected?.Config;
    if (
      !Array.isArray(decoded) ||
      decoded.length !== 1 ||
      inspected?.Id !== identity ||
      container?.User !== "1000:1000" ||
      host?.Privileged !== false ||
      host?.ReadonlyRootfs !== true ||
      host?.Init !== true ||
      host?.IpcMode !== "private" ||
      host?.UTSMode !== "" ||
      host?.NetworkMode !== this.network ||
      host?.Memory !== 268_435_456 ||
      host?.MemorySwap !== 268_435_456 ||
      host?.NanoCpus !== 1_000_000_000 ||
      host?.PidsLimit !== 64 ||
      host?.RestartPolicy?.Name !== "no" ||
      !host?.CapDrop?.includes("ALL") ||
      !host?.SecurityOpt?.some((value) =>
        value.startsWith("no-new-privileges"),
      ) ||
      typeof host?.Tmpfs?.["/tmp"] !== "string" ||
      Object.values(host?.PortBindings ?? {}).some(
        (bindings) => Array.isArray(bindings) && bindings.length > 0,
      )
    )
      throw new Error("docker_client_confinement_unproven");
    return true;
  }
}
