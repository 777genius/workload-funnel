import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { isAbsolute, posix, resolve } from "node:path";

import {
  HOST_MINIMUMS,
  HOST_ROOT_PREFIX,
  CONTROL_ROOT_PREFIX,
  REQUIRED_BOOTSTRAP_TOOLS,
  REQUIRED_CGROUP_CONTROLLERS,
  SANDBOX_PARENT,
} from "./constants.mjs";

export class HostedGateRefusal extends Error {
  constructor(code) {
    super(code);
    this.code = code;
    this.name = "HostedGateRefusal";
  }
}

function refuse(condition, code) {
  if (condition) throw new HostedGateRefusal(code);
}

export function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

export function verifySha256(
  bytes,
  expected,
  code = "download_digest_mismatch",
) {
  refuse(!/^[a-f0-9]{64}$/u.test(expected), "expected_digest_invalid");
  const observed = sha256(bytes);
  refuse(observed !== expected, code);
  return observed;
}

export function hostedContext(environment) {
  const workspace = environment.GITHUB_WORKSPACE;
  const runnerTemp = environment.RUNNER_TEMP;
  const commit = environment.GITHUB_SHA;
  const runNumber = environment.GITHUB_RUN_ID;
  const runAttempt = environment.GITHUB_RUN_ATTEMPT;
  refuse(
    typeof workspace !== "string" ||
      !isAbsolute(workspace) ||
      resolve(workspace) !== workspace ||
      workspace.includes("\0"),
    "hosted_workspace_path_invalid",
  );
  refuse(
    typeof runnerTemp !== "string" ||
      !isAbsolute(runnerTemp) ||
      resolve(runnerTemp) !== runnerTemp ||
      runnerTemp.includes("\0"),
    "hosted_runner_temp_invalid",
  );
  refuse(!/^[a-f0-9]{40}$/u.test(commit ?? ""), "hosted_commit_invalid");
  refuse(!/^[1-9][0-9]{0,19}$/u.test(runNumber ?? ""), "hosted_run_id_invalid");
  refuse(
    !/^[1-9][0-9]{0,5}$/u.test(runAttempt ?? ""),
    "hosted_attempt_invalid",
  );
  const suffix = sha256(
    Buffer.from(`${commit}\0${runNumber}\0${runAttempt}`, "utf8"),
  ).slice(0, 32);
  const runId = `wf-production-gate-${suffix}`;
  return Object.freeze({
    artifactRoot: `${runnerTemp}/wf-production-gate-${runNumber}-${runAttempt}-evidence`,
    commit,
    controlRoot: `${CONTROL_ROOT_PREFIX}${suffix}`,
    hostRoot: `${HOST_ROOT_PREFIX}${suffix}`,
    runAttempt,
    runId,
    runNumber,
    runnerTemp,
    sandboxRoot: `${SANDBOX_PARENT}/${runId}`,
    workspace,
  });
}

export function validateCanonicalPath(path, parent, code) {
  refuse(
    typeof path !== "string" ||
      !isAbsolute(path) ||
      resolve(path) !== path ||
      path.includes("\0") ||
      !path.startsWith(`${parent}/`) ||
      posix.relative(parent, path).startsWith(".."),
    code,
  );
  return path;
}

export function validateTrustedIdentity(identity, options = {}) {
  const { executable = false, expectedPath, expectedSha256 } = options;
  refuse(
    identity === null ||
      typeof identity !== "object" ||
      Array.isArray(identity),
    "tool_identity_invalid",
  );
  refuse(identity.path !== expectedPath, "tool_path_drift");
  refuse(identity.canonicalPath !== identity.path, "tool_path_not_canonical");
  refuse(
    identity.kind !== "file" || identity.symlink === true,
    "tool_symlink_refused",
  );
  refuse(identity.uid !== 0 || identity.gid !== 0, "tool_owner_drift");
  refuse(
    !Number.isSafeInteger(identity.mode) || (identity.mode & 0o022) !== 0,
    "tool_mode_drift",
  );
  refuse(executable && (identity.mode & 0o111) === 0, "tool_not_executable");
  refuse(
    !Array.isArray(identity.ancestors) ||
      identity.ancestors.length === 0 ||
      identity.ancestors.some(
        (item) =>
          item.kind !== "directory" ||
          item.symlink === true ||
          item.uid !== 0 ||
          item.gid !== 0 ||
          (item.mode & 0o022) !== 0,
      ),
    "tool_parent_drift",
  );
  if (expectedSha256 !== undefined)
    refuse(identity.sha256 !== expectedSha256, "tool_digest_drift");
  return identity;
}

function validateRatio(value, code) {
  refuse(!Number.isFinite(value) || value < 0 || value > 1, code);
}

export function validateHostAdmission(observation) {
  refuse(
    observation?.rootSudo?.effectiveUid !== 0 ||
      !Number.isSafeInteger(observation?.rootSudo?.sudoUid) ||
      observation.rootSudo.sudoUid < 1,
    "root_sudo_not_proven",
  );
  refuse(observation.pid1 !== "systemd", "systemd_not_pid1");
  refuse(observation.cgroup?.filesystem !== "cgroup2", "cgroup_v2_not_proven");
  const controllers = new Set(observation.cgroup?.controllers);
  refuse(
    REQUIRED_CGROUP_CONTROLLERS.some((name) => !controllers.has(name)),
    "cgroup_v2_controllers_incomplete",
  );
  refuse(
    !Number.isSafeInteger(observation.systemd?.version) ||
      observation.systemd.version < 250,
    "systemd_version_unsupported",
  );
  refuse(
    typeof observation.docker?.serverVersion !== "string" ||
      observation.docker.serverVersion.length === 0,
    "docker_server_not_proven",
  );
  for (const [field, code] of [
    ["containers", "foreign_container_state"],
    ["images", "foreign_image_state"],
    ["nonDefaultNetworks", "foreign_docker_network_state"],
    ["volumes", "foreign_docker_volume_state"],
  ])
    refuse(
      !Array.isArray(observation.docker[field]) ||
        observation.docker[field].length !== 0,
      code,
    );
  refuse(
    !Array.isArray(observation.systemd.foreignUnits) ||
      observation.systemd.foreignUnits.length !== 0,
    "foreign_workload_service_state",
  );
  refuse(
    !Array.isArray(observation.foreign?.paths) ||
      observation.foreign.paths.length !== 0 ||
      !Array.isArray(observation.foreign?.processes) ||
      observation.foreign.processes.length !== 0 ||
      observation.foreign.syntheticUserExists === true ||
      observation.foreign.syntheticGroupExists === true,
    "foreign_workload_state",
  );
  const resources = observation.resources ?? {};
  validateRatio(resources.diskAvailableRatio, "disk_headroom_invalid");
  validateRatio(resources.inodeAvailableRatio, "inode_headroom_invalid");
  validateRatio(resources.memoryAvailableRatio, "memory_headroom_invalid");
  refuse(
    resources.cpuCount < HOST_MINIMUMS.cpuCount ||
      resources.memoryTotalBytes < HOST_MINIMUMS.memoryTotalBytes ||
      resources.memoryAvailableBytes < HOST_MINIMUMS.memoryAvailableBytes ||
      resources.memoryAvailableRatio < HOST_MINIMUMS.memoryAvailableRatio ||
      resources.diskAvailableBytes < HOST_MINIMUMS.diskAvailableBytes ||
      resources.diskAvailableRatio < HOST_MINIMUMS.diskAvailableRatio ||
      resources.inodeAvailableRatio < HOST_MINIMUMS.inodeAvailableRatio ||
      resources.pidHeadroom < HOST_MINIMUMS.pidHeadroom ||
      resources.loadPerCpu >= 0.75 ||
      resources.cpuPsiSome >= 0.1 ||
      resources.ioPsiSome >= 0.08 ||
      resources.memoryPsiSome >= 0.08,
    "host_headroom_insufficient",
  );
  const tools = observation.tools ?? {};
  refuse(
    REQUIRED_BOOTSTRAP_TOOLS.some((name) => tools[name] === undefined),
    "bootstrap_tool_inventory_incomplete",
  );
  for (const name of REQUIRED_BOOTSTRAP_TOOLS)
    validateTrustedIdentity(tools[name], {
      executable: true,
      expectedPath: tools[name].path,
    });
  return Object.freeze({ admitted: true, observation });
}

export function validateCleanupResults(results) {
  refuse(
    !Array.isArray(results) || results.length === 0,
    "cleanup_results_missing",
  );
  const failed = results.filter((item) => item.ok !== true);
  return Object.freeze({ certain: failed.length === 0, failed, results });
}
