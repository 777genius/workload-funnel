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

  async loopbackPort(name, containerPort, expectedHostPort) {
    const output = await this.command([
      "port",
      name,
      `${String(containerPort)}/tcp`,
    ]);
    const match = output.match(/^127\.0\.0\.1:(\d{2,5})$/u);
    const port = Number(match?.[1]);
    if (
      match === null ||
      !Number.isSafeInteger(port) ||
      port < 1 ||
      port > 65_535
    )
      throw new Error("docker_published_port_not_loopback");
    if (
      !Number.isSafeInteger(expectedHostPort) ||
      expectedHostPort < 1 ||
      expectedHostPort > 65_535 ||
      port !== expectedHostPort
    )
      throw new Error("docker_published_port_identity_changed");
    return port;
  }

  async inspectContainerConfinement(
    name,
    expectedUser,
    forbiddenValues = [],
    expectedIdentity,
    expectedWritableStorage,
    expectedContainerPort,
  ) {
    const output = await this.command(["container", "inspect", name]);
    if (
      forbiddenValues.some(
        (value) => typeof value !== "string" || value.length < 1,
      ) ||
      forbiddenValues.some((value) => output.includes(value))
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
    const requestedPorts = host?.PortBindings;
    const assignedPorts = inspected?.NetworkSettings?.Ports;
    const expectedPortKey = `${String(expectedContainerPort)}/tcp`;
    const requestedPortKeys = Object.keys(requestedPorts ?? {});
    const requestedBindings = requestedPorts?.[expectedPortKey];
    const requestedBinding = requestedBindings?.[0];
    const assignedPortKeys = Object.keys(assignedPorts ?? {});
    const assignedBindings = assignedPorts?.[expectedPortKey];
    const assignedBinding = assignedBindings?.[0];
    const publishedHostPort = Number(assignedBinding?.HostPort);
    const writableStorageProven =
      expectedWritableStorage?.kind === "bind"
        ? Array.isArray(inspected?.Mounts) &&
          inspected.Mounts.some(
            (mount) =>
              mount.Type === "bind" &&
              mount.Source === expectedWritableStorage.source &&
              mount.Destination === expectedWritableStorage.destination &&
              mount.RW === true &&
              mount.Propagation === "rprivate",
          ) &&
          typeof host?.Tmpfs?.[expectedWritableStorage.destination] !== "string"
        : expectedWritableStorage?.kind === "tmpfs" &&
          typeof host?.Tmpfs?.[expectedWritableStorage.destination] ===
            "string";
    if (
      !Array.isArray(decoded) ||
      decoded.length !== 1 ||
      typeof inspected?.Id !== "string" ||
      !/^sha256:[a-f0-9]{64}$/u.test(inspected?.Image ?? "") ||
      (expectedIdentity !== undefined && inspected.Id !== expectedIdentity) ||
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
      !Number.isSafeInteger(expectedContainerPort) ||
      expectedContainerPort < 1 ||
      expectedContainerPort > 65_535 ||
      requestedPortKeys.length !== 1 ||
      requestedPortKeys[0] !== expectedPortKey ||
      !Array.isArray(requestedBindings) ||
      requestedBindings.length !== 1 ||
      requestedBinding === null ||
      typeof requestedBinding !== "object" ||
      Array.isArray(requestedBinding) ||
      Object.keys(requestedBinding).sort().join(",") !== "HostIp,HostPort" ||
      requestedBinding.HostIp !== "127.0.0.1" ||
      requestedBinding.HostPort !== "0" ||
      assignedPortKeys.length !== 1 ||
      assignedPortKeys[0] !== expectedPortKey ||
      !Array.isArray(assignedBindings) ||
      assignedBindings.length !== 1 ||
      assignedBinding === null ||
      typeof assignedBinding !== "object" ||
      Array.isArray(assignedBinding) ||
      Object.keys(assignedBinding).sort().join(",") !== "HostIp,HostPort" ||
      assignedBinding.HostIp !== "127.0.0.1" ||
      !/^[1-9]\d{0,4}$/u.test(assignedBinding.HostPort ?? "") ||
      !Number.isSafeInteger(publishedHostPort) ||
      publishedHostPort > 65_535
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
      metadataSecretValuesAbsent: true,
      nonRootUser: expectedUser,
      privateUtsNamespace: true,
      publishedHostPort,
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
