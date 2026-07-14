import { isAbsolute, join, relative, resolve } from "node:path";

import {
  fingerprintMutationFence,
  type MutationFence,
  sha256Hex,
  validateMutationFence,
} from "@workload-funnel/kernel";
import type { TargetOperationReceipt } from "@workload-funnel/node-execution/process-lifecycle";

import type {
  HostedCanaryInvocationProfile,
  HostedCanaryProcessResult,
  HostedCanarySandbox,
  HostedCanaryStartRequest,
} from "./contracts/hosted-canary-runtime.js";

const identifierPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u;
const accountSelectorPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
type JsonRecord = Readonly<Record<string, unknown>>;

function record(value: unknown): JsonRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error("hosted_canary_tools_catalog_malformed");
  return value as JsonRecord;
}

function isWithin(root: string, candidate: string): boolean {
  const suffix = relative(resolve(root), resolve(candidate));
  return suffix === "" || (!suffix.startsWith("..") && !isAbsolute(suffix));
}

export function assertHostedCanaryFence(
  fence: MutationFence,
  fingerprint: string,
  effect: "process_start" | "process_stop",
): void {
  validateMutationFence(fence);
  if (
    fingerprintMutationFence(fence) !== fingerprint ||
    fence.desiredEffect !== effect ||
    fence.requiredGate !== effect ||
    fence.allocationId === undefined ||
    fence.ownerFence === undefined ||
    fence.nodeId === undefined ||
    fence.nodeBootEpoch === undefined ||
    fence.notBefore === undefined ||
    fence.notAfter === undefined ||
    (effect === "process_start" &&
      (fence.startFence === undefined ||
        fence.issuedStartRevocationRevision === undefined))
  ) {
    throw new Error("hosted_canary_mutation_fence_incomplete_or_mismatched");
  }
}

export function assertHostedCanaryFenceTime(
  fence: MutationFence,
  nowMs: number,
): void {
  if (!Number.isSafeInteger(nowMs) || nowMs < 0)
    throw new Error("hosted_canary_clock_invalid");
  if (fence.notBefore === undefined || nowMs < fence.notBefore)
    throw new Error("hosted_canary_mutation_fence_not_yet_valid");
  if (fence.notAfter === undefined || nowMs >= fence.notAfter)
    throw new Error("hosted_canary_mutation_fence_expired");
}

export function assertSuccessfulProbe(result: HostedCanaryProcessResult): void {
  if (result.timedOut || result.exitCode !== 0)
    throw new Error("hosted_canary_capability_probe_failed");
}

export function assertDeployedCliHelp(help: string): void {
  const requiredFragments = [
    "subscription-runtime-codex-goal run --job-root <dir>",
    "--workspace <dir>",
    "--prompt <file>",
    "--task-id <id>",
    "--accounts account-a,account-b",
    "--registry-root <dir>",
    "--model gpt-5.5 --effort high --service-tier default",
    "--execution-engine app-server-goal",
    "--no-tmux",
    "subscription-runtime-codex-goal tools",
  ];
  if (requiredFragments.some((fragment) => !help.includes(fragment)))
    throw new Error("hosted_canary_required_cli_contract_missing");
}

export function assertDeployedToolsCatalog(output: string): void {
  let decoded: unknown;
  try {
    decoded = JSON.parse(output) as unknown;
  } catch {
    throw new Error("hosted_canary_tools_catalog_malformed");
  }
  const tools = record(decoded)["tools"];
  if (!Array.isArray(tools))
    throw new Error("hosted_canary_tools_catalog_malformed");
  const start = tools
    .map(record)
    .find((tool) => tool["name"] === "codex_goal_start");
  if (start === undefined)
    throw new Error("hosted_canary_required_tool_contract_missing");
  const description = start["description"];
  const inputSchema = record(start["inputSchema"]);
  const properties = record(inputSchema["properties"]);
  const requiredStringFields = [
    "jobId",
    "jobRootDir",
    "authRootDir",
    "stateRootDir",
    "workspacePath",
    "promptPath",
    "taskId",
    "outputPath",
    "progressPath",
    "model",
    "reasoningEffort",
    "serviceTier",
    "executionEngine",
    "accessBoundary",
    "networkAccess",
    "outputFormat",
    "registryRootDir",
  ];
  if (
    requiredStringFields.some((field) => !(field in properties)) ||
    !("accounts" in properties) ||
    !("projectAccessScope" in properties) ||
    "job_id" in properties ||
    "auth_root_dir" in properties
  )
    throw new Error("hosted_canary_required_tool_contract_missing");
  const accounts = record(properties["accounts"]);
  const accountForms = accounts["anyOf"];
  const projectAccessScope = record(properties["projectAccessScope"]);
  if (
    typeof description !== "string" ||
    !description.includes("detached tmux") ||
    requiredStringFields.some(
      (field) => record(properties[field])["type"] !== "string",
    ) ||
    !Array.isArray(accountForms) ||
    accountForms.length !== 2 ||
    !accountForms.some((form) => record(form)["type"] === "string") ||
    !accountForms.some((form) => {
      const schema = record(form);
      return (
        schema["type"] === "array" &&
        record(schema["items"])["type"] === "string"
      );
    }) ||
    projectAccessScope["type"] !== "object"
  )
    throw new Error("hosted_canary_required_tool_contract_missing");
}

export function validateStartRequest(
  request: HostedCanaryStartRequest,
  sandbox: HostedCanarySandbox,
): void {
  if (
    !identifierPattern.test(request.invocationProfileId) ||
    !identifierPattern.test(request.taskId) ||
    !isAbsolute(request.promptPath) ||
    !isWithin(sandbox.projectRoot, request.promptPath) ||
    request.promptPath !== join(sandbox.projectRoot, "hosted-canary-prompt.md")
  )
    throw new Error("hosted_canary_start_request_invalid");
}

export function validateInvocationProfile(
  profile: HostedCanaryInvocationProfile,
  expectedProfileId: string,
  projectRoot: string,
): void {
  const wire = profile as unknown as Readonly<Record<string, unknown>>;
  const accountSelectors = wire["accountSelectors"];
  const authRoot = wire["authRoot"];
  const model = wire["model"];
  const profileId = wire["profileId"];
  const profileRevision = wire["profileRevision"];
  const reasoningEffort = wire["reasoningEffort"];
  const serviceTier = wire["serviceTier"];
  if (
    typeof profileId !== "string" ||
    profileId !== expectedProfileId ||
    !identifierPattern.test(profileId) ||
    typeof profileRevision !== "string" ||
    !identifierPattern.test(profileRevision) ||
    typeof authRoot !== "string" ||
    !isAbsolute(authRoot) ||
    isWithin(projectRoot, authRoot) ||
    !Array.isArray(accountSelectors) ||
    accountSelectors.length < 1 ||
    accountSelectors.length > 8 ||
    accountSelectors.some(
      (account) =>
        typeof account !== "string" || !accountSelectorPattern.test(account),
    ) ||
    new Set(accountSelectors).size !== accountSelectors.length ||
    typeof model !== "string" ||
    model.length < 1 ||
    model.length > 128 ||
    typeof reasoningEffort !== "string" ||
    !/^[a-z0-9_-]{1,32}$/u.test(reasoningEffort) ||
    typeof serviceTier !== "string" ||
    !/^[a-z0-9_-]{1,32}$/u.test(serviceTier) ||
    wire["executionEngine"] !== "app-server-goal" ||
    wire["accessBoundary"] !== "isolated_workspace_write" ||
    wire["networkAccess"] !== "restricted"
  )
    throw new Error("hosted_canary_trusted_profile_invalid");
}

export function buildForegroundArgv(
  request: HostedCanaryStartRequest,
  profile: HostedCanaryInvocationProfile,
  sandbox: HostedCanarySandbox,
): readonly string[] {
  const outputPath = join(sandbox.stateRoot, "runtime-result.json");
  const progressPath = join(sandbox.stateRoot, "runtime-progress.json");
  const projectAccessScope = {
    isolatedWorkspaceRoot: sandbox.projectRoot,
    projectId: request.ticket.projectId,
    readRoots: [sandbox.projectRoot],
    registryRoot: sandbox.registryRoot,
    workspaceRoots: [sandbox.projectRoot],
  };
  return Object.freeze([
    "run",
    "--no-tmux",
    "--job-root",
    sandbox.jobRoot,
    "--auth-root",
    profile.authRoot,
    "--workspace",
    sandbox.projectRoot,
    "--prompt",
    request.promptPath,
    "--task-id",
    request.taskId,
    "--accounts",
    profile.accountSelectors.join(","),
    "--format",
    "json",
    "--state-root",
    sandbox.stateRoot,
    "--job-id",
    request.taskId,
    "--registry-root",
    sandbox.registryRoot,
    "--output",
    outputPath,
    "--progress",
    progressPath,
    "--model",
    profile.model,
    "--effort",
    profile.reasoningEffort,
    "--service-tier",
    profile.serviceTier,
    "--execution-engine",
    profile.executionEngine,
    "--access-boundary",
    profile.accessBoundary,
    "--project-access-scope-json",
    JSON.stringify(projectAccessScope),
    "--network-access",
    profile.networkAccess,
  ]);
}

export function operationFingerprint(parts: readonly string[]): string {
  return `hosted-canary-intent-v1-${sha256Hex(JSON.stringify(parts))}`;
}

export function unknownReceipt(
  operationId: string,
  mutationFenceFingerprint: string,
): TargetOperationReceipt {
  return Object.freeze({
    mutationFenceFingerprint,
    operationId,
    state: "unknown",
  });
}
