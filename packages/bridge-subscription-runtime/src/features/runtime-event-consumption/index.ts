import type {
  TargetEventPage,
  TargetEventSource,
  TargetOperationObservation,
  TargetSnapshotPage,
  TargetTerminalInput,
} from "@workload-funnel/node-execution/process-lifecycle";

import type { RuntimeEventClient } from "./application/contracts/runtime-event-client.js";

export type { RuntimeEventClient } from "./application/contracts/runtime-event-client.js";

type UnknownRecord = Readonly<Record<string, unknown>>;

function record(value: unknown, location: string): UnknownRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${location}_malformed`);
  }
  return value as UnknownRecord;
}

function exactKeys(
  value: UnknownRecord,
  required: readonly string[],
  optional: readonly string[],
  location: string,
): void {
  const allowed = new Set([...required, ...optional]);
  if (
    required.some((key) => !(key in value)) ||
    Object.keys(value).some((key) => !allowed.has(key))
  ) {
    throw new Error(`${location}_fields_malformed`);
  }
}

function stringField(
  value: UnknownRecord,
  field: string,
  location: string,
): string {
  const candidate = value[field];
  if (
    typeof candidate !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/u.test(candidate)
  ) {
    throw new Error(`${location}_${field}_malformed`);
  }
  return candidate;
}

function terminal(value: unknown): TargetTerminalInput {
  const input = record(value, "runtime_terminal");
  const outcome = input["outcome"];
  if (outcome === "succeeded") {
    exactKeys(
      input,
      ["completedAtMs", "exitCode", "outcome", "resultDigest"],
      [],
      "runtime_terminal",
    );
  } else if (outcome === "failed") {
    exactKeys(
      input,
      ["completedAtMs", "failureCode", "outcome"],
      ["exitCode"],
      "runtime_terminal",
    );
  } else if (outcome === "canceled") {
    exactKeys(
      input,
      ["cancellationCode", "completedAtMs", "outcome"],
      [],
      "runtime_terminal",
    );
  } else {
    throw new Error("runtime_terminal_outcome_quarantined");
  }
  if (
    !Number.isSafeInteger(input["completedAtMs"]) ||
    (input["completedAtMs"] as number) < 0
  ) {
    throw new Error("runtime_terminal_malformed");
  }
  const exitCode = input["exitCode"];
  const failureCode = input["failureCode"];
  const resultDigest = input["resultDigest"];
  const cancellationCode = input["cancellationCode"];
  if (
    (exitCode !== undefined &&
      (!Number.isSafeInteger(exitCode) || (exitCode as number) < 0)) ||
    (failureCode !== undefined &&
      (typeof failureCode !== "string" || failureCode.length === 0)) ||
    (cancellationCode !== undefined &&
      (typeof cancellationCode !== "string" ||
        cancellationCode.length === 0)) ||
    (resultDigest !== undefined &&
      (typeof resultDigest !== "string" ||
        !/^[a-f0-9]{64}$/u.test(resultDigest)))
  ) {
    throw new Error("runtime_terminal_malformed");
  }
  const completedAtMs = input["completedAtMs"] as number;
  if (outcome === "succeeded") {
    if (exitCode !== 0 || typeof resultDigest !== "string") {
      throw new Error("runtime_terminal_success_contradiction_quarantined");
    }
    return { completedAtMs, exitCode: 0, outcome, resultDigest };
  }
  if (outcome === "failed") {
    if (exitCode === 0 || typeof failureCode !== "string") {
      throw new Error("runtime_terminal_failure_contradiction_quarantined");
    }
    return {
      completedAtMs,
      ...(exitCode === undefined ? {} : { exitCode: exitCode as number }),
      failureCode,
      outcome,
    };
  }
  if (typeof cancellationCode !== "string") {
    throw new Error("runtime_terminal_cancellation_contradiction_quarantined");
  }
  return { cancellationCode, completedAtMs, outcome };
}

function observation(
  value: unknown,
  expectedTargetId: string,
  expectedControllerId: string,
): TargetOperationObservation {
  const input = record(value, "runtime_event");
  exactKeys(
    input,
    [
      "schemaVersion",
      "causationId",
      "controllerId",
      "cursor",
      "operationId",
      "projectId",
      "runtimeBuildSha",
      "runtimeOperationId",
      "sourceRevision",
      "state",
      "targetId",
    ],
    ["terminal"],
    "runtime_event",
  );
  const state = input["state"];
  if (
    input["schemaVersion"] !== "subscription-runtime.event.v1" ||
    input["targetId"] !== expectedTargetId ||
    input["controllerId"] !== expectedControllerId ||
    typeof state !== "string" ||
    ![
      "accepted",
      "starting",
      "running",
      "exited",
      "stopped",
      "unknown",
    ].includes(state) ||
    !Number.isSafeInteger(input["sourceRevision"]) ||
    (input["sourceRevision"] as number) < 1
  ) {
    throw new Error("runtime_event_identity_malformed");
  }
  const runtimeBuildSha = stringField(
    input,
    "runtimeBuildSha",
    "runtime_event",
  );
  if (!/^[a-f0-9]{40,64}$/u.test(runtimeBuildSha)) {
    throw new Error("runtime_event_build_sha_malformed");
  }
  const terminalInput = input["terminal"];
  const base = {
    causationId: stringField(input, "causationId", "runtime_event"),
    controllerId: stringField(input, "controllerId", "runtime_event"),
    cursor: stringField(input, "cursor", "runtime_event"),
    operationId: stringField(input, "operationId", "runtime_event"),
    projectId: stringField(input, "projectId", "runtime_event"),
    runtimeBuildSha,
    runtimeOperationId: stringField(
      input,
      "runtimeOperationId",
      "runtime_event",
    ),
    sourceRevision: input["sourceRevision"] as number,
    state: state as TargetOperationObservation["state"],
    targetId: stringField(input, "targetId", "runtime_event"),
  } as const;
  if (terminalInput === undefined) {
    return Object.freeze(
      state === "exited" || state === "stopped"
        ? {
            ...base,
            quarantineReason: "runtime_terminal_evidence_missing",
            state: "quarantined" as const,
          }
        : base,
    );
  }
  try {
    const terminalInputValue = terminal(terminalInput);
    const compatible =
      (state === "exited" &&
        (terminalInputValue.outcome === "succeeded" ||
          terminalInputValue.outcome === "failed")) ||
      (state === "stopped" &&
        (terminalInputValue.outcome === "canceled" ||
          terminalInputValue.outcome === "failed"));
    return Object.freeze(
      compatible
        ? { ...base, terminal: terminalInputValue }
        : {
            ...base,
            quarantineReason: "runtime_terminal_state_contradiction",
            state: "quarantined" as const,
          },
    );
  } catch (error) {
    return Object.freeze({
      ...base,
      quarantineReason:
        error instanceof Error ? error.message : "runtime_terminal_quarantined",
      state: "quarantined" as const,
    });
  }
}

function page(
  value: unknown,
  expectedSchema: string,
  listField: "events" | "entries",
  tokenField: "nextCursor" | "nextPageToken",
  targetId: string,
  controllerId: string,
  maximumEntries: number,
): TargetEventPage | TargetSnapshotPage {
  const input = record(value, "runtime_page");
  exactKeys(input, ["schemaVersion", listField], [tokenField], "runtime_page");
  const entries = input[listField];
  const token = input[tokenField];
  if (
    input["schemaVersion"] !== expectedSchema ||
    !Array.isArray(entries) ||
    entries.length > maximumEntries ||
    (token !== undefined &&
      (typeof token !== "string" ||
        !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/u.test(token)))
  ) {
    throw new Error("runtime_page_malformed");
  }
  const parsed = Object.freeze(
    entries.map((entry) => observation(entry, targetId, controllerId)),
  );
  return listField === "events"
    ? { events: parsed, ...(token === undefined ? {} : { nextCursor: token }) }
    : {
        entries: parsed,
        ...(token === undefined ? {} : { nextPageToken: token }),
      };
}

export interface RuntimeEventProviderInput {
  readonly client: RuntimeEventClient;
  readonly controllerId: string;
  readonly targetId: string;
}

export function createProvider(
  input: RuntimeEventProviderInput,
): TargetEventSource {
  return Object.freeze({
    async readEvents(
      cursor: string | undefined,
      limit: number,
    ): Promise<TargetEventPage> {
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) {
        throw new Error("runtime_event_limit_invalid");
      }
      return page(
        await input.client.readEvents(cursor, limit),
        "subscription-runtime.event-page.v1",
        "events",
        "nextCursor",
        input.targetId,
        input.controllerId,
        limit,
      ) as TargetEventPage;
    },
    async readSnapshot(
      pageToken: string | undefined,
      limit: number,
    ): Promise<TargetSnapshotPage> {
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) {
        throw new Error("runtime_snapshot_limit_invalid");
      }
      return page(
        await input.client.readProjectSnapshot(pageToken, limit),
        "subscription-runtime.snapshot-page.v1",
        "entries",
        "nextPageToken",
        input.targetId,
        input.controllerId,
        limit,
      ) as TargetSnapshotPage;
    },
  });
}
