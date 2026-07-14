import type { MutationFence } from "@workload-funnel/kernel";
import type {
  PreparedTargetTicket,
  TargetOperationReceipt,
} from "@workload-funnel/node-execution/process-lifecycle";

export const HOSTED_CANARY_RUNTIME_CONTRACT =
  "subscription-runtime.codex-goal.hosted-canary.v1" as const;
export const HOSTED_CANARY_DISPOSABLE_PURPOSE =
  "WORKLOAD_FUNNEL_SUBSCRIPTION_RUNTIME_DISPOSABLE_CANARY_ONLY" as const;

export interface HostedCanaryExecutableIdentity {
  readonly device: number;
  readonly inode: number;
  readonly modifiedMs: number;
  readonly sha256: string;
  readonly size: number;
}

export interface HostedCanaryProcessRequest {
  readonly argv: readonly string[];
  readonly cwd: string;
  readonly environment: Readonly<Record<string, string>>;
  readonly executable: string;
  readonly expectedExecutableIdentity: HostedCanaryExecutableIdentity;
  readonly maxOutputBytes: number;
  readonly timeoutMs: number;
}

export interface HostedCanaryProcessResult {
  readonly exitCode: number | null;
  readonly stderr: string;
  readonly stdout: string;
  readonly timedOut: boolean;
}

export interface HostedCanaryForegroundResult {
  readonly exitCode: number | null;
  readonly timedOut: boolean;
}

export interface HostedCanaryForegroundHandle {
  readonly completion: Promise<HostedCanaryForegroundResult>;
  terminate(): void;
}

export interface HostedCanaryProcessRunner {
  inspectExecutable(path: string): Promise<HostedCanaryExecutableIdentity>;
  run(request: HostedCanaryProcessRequest): Promise<HostedCanaryProcessResult>;
  startForeground(
    request: HostedCanaryProcessRequest,
  ): Promise<HostedCanaryForegroundHandle>;
}

export interface HostedCanaryAuthorityStore {
  assertCurrent(fence: MutationFence, fingerprint: string): void;
  install(
    fence: MutationFence,
    fingerprint: string,
  ): "idempotent" | "installed";
}

/**
 * Resolved only inside the trusted node adapter. These are selectors and paths,
 * never credential bytes; the adapter must not inspect authRoot.
 */
export interface HostedCanaryInvocationProfile {
  readonly accessBoundary: "isolated_workspace_write";
  readonly accountSelectors: readonly string[];
  readonly authRoot: string;
  readonly executionEngine: "app-server-goal";
  readonly model: string;
  readonly networkAccess: "restricted";
  readonly profileId: string;
  readonly profileRevision: string;
  readonly reasoningEffort: string;
  readonly serviceTier: string;
}

export interface HostedCanaryInvocationProfileResolver {
  resolve(profileId: string): Promise<HostedCanaryInvocationProfile>;
}

export interface HostedCanaryRuntimeRelease {
  readonly contractVersion: typeof HOSTED_CANARY_RUNTIME_CONTRACT;
  readonly executable: string;
  readonly expectedBinarySha256: string;
  readonly expectedCliHelpSha256: string;
  readonly expectedToolsCatalogSha256: string;
  readonly limits: {
    readonly foregroundTimeoutMs: number;
    readonly maxOutputBytes: number;
    readonly probeTimeoutMs: number;
  };
  readonly productionStartsEnabled: false;
}

export interface HostedCanarySandbox {
  readonly canaryPurpose: typeof HOSTED_CANARY_DISPOSABLE_PURPOSE;
  readonly environment: Readonly<Record<string, string>>;
  readonly jobRoot: string;
  readonly projectRoot: string;
  readonly projectFingerprint: string;
  readonly registryRoot: string;
  readonly stateRoot: string;
  readonly temporaryRoot: string;
}

export interface HostedCanaryCapabilityEvidence {
  readonly binarySha256: string;
  readonly cliHelpSha256: string;
  readonly contractVersion: typeof HOSTED_CANARY_RUNTIME_CONTRACT;
  readonly foregroundNoTmux: true;
  readonly startToolInvocation: "forbidden_tmux_path";
  readonly toolJsonUsesCamelCase: true;
  readonly toolsCatalogSha256: string;
}

export interface HostedCanaryStartRequest {
  readonly invocationProfileId: string;
  readonly promptPath: string;
  readonly taskId: string;
  readonly ticket: PreparedTargetTicket;
}

export interface HostedCanaryStartResult {
  readonly foregroundStart: TargetOperationReceipt;
  readonly state: "accepted" | "unknown";
}

export interface HostedCanaryStopRequest {
  readonly mutationFence: MutationFence;
  readonly mutationFenceFingerprint: string;
  readonly operationId: string;
  readonly runtimeTargetId: string;
}

export interface HostedCanaryStopResult {
  readonly foregroundCompletion?: HostedCanaryForegroundResult;
  readonly receipt: TargetOperationReceipt;
}
