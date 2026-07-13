export interface PublicEventCompatibilityCheckpoint {
  readonly consumerId: string;
  readonly streamPosition: number;
  readonly appliedEventIds: ReadonlySet<string>;
  readonly appliedEventFingerprints: ReadonlyMap<string, string>;
  readonly quarantined: readonly Readonly<{
    eventId?: string;
    streamPosition?: number;
    reason:
      | "unsupported_major_version"
      | "unsupported_required_extension"
      | "unsupported_event_type"
      | "unsupported_closed_enum"
      | "conflicting_event_replay"
      | "malformed_event";
  }>[];
  readonly version: number;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value))
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  if (typeof value === "object" && value !== null)
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`)
      .join(",")}}`;
  if (value === undefined || typeof value === "function") return "null";
  return JSON.stringify(value);
}

export interface PublicEventCompatibilityPolicy {
  readonly supportedMajorVersions: ReadonlySet<number>;
  readonly supportedEventTypes: ReadonlySet<string>;
  readonly supportedRequiredExtensions: ReadonlySet<string>;
  readonly closedEnumValues: Readonly<Record<string, ReadonlySet<string>>>;
}

export type PublicEventCompatibilityResult = Readonly<
  | {
      status: "applied";
      checkpoint: PublicEventCompatibilityCheckpoint;
      event: Readonly<Record<string, unknown>>;
    }
  | {
      status: "quarantined";
      checkpoint: PublicEventCompatibilityCheckpoint;
      reason: PublicEventCompatibilityCheckpoint["quarantined"][number]["reason"];
    }
>;

function quarantine(
  checkpoint: PublicEventCompatibilityCheckpoint,
  input: Readonly<Record<string, unknown>>,
  reason: PublicEventCompatibilityCheckpoint["quarantined"][number]["reason"],
): PublicEventCompatibilityResult {
  const eventId = input["eventId"];
  const streamPosition = input["streamPosition"];
  const record = Object.freeze({
    reason,
    ...(typeof eventId === "string" ? { eventId } : {}),
    ...(typeof streamPosition === "number" ? { streamPosition } : {}),
  });
  return Object.freeze({
    checkpoint: Object.freeze({
      ...checkpoint,
      quarantined: Object.freeze([...checkpoint.quarantined, record]),
      version: checkpoint.version + 1,
    }),
    reason,
    status: "quarantined",
  });
}

export function consumeMixedVersionPublicEvent(
  checkpoint: PublicEventCompatibilityCheckpoint,
  input: unknown,
  policy: PublicEventCompatibilityPolicy,
): PublicEventCompatibilityResult {
  if (typeof input !== "object" || input === null || Array.isArray(input))
    return quarantine(checkpoint, {}, "malformed_event");
  const event = input as Readonly<Record<string, unknown>>;
  const contractVersion = event["contractVersion"];
  const eventId = event["eventId"];
  const eventType = event["eventType"];
  const streamPosition = event["streamPosition"];
  const payload = event["payload"];
  if (
    typeof contractVersion !== "string" ||
    typeof eventId !== "string" ||
    typeof eventType !== "string" ||
    typeof streamPosition !== "number" ||
    !Number.isSafeInteger(streamPosition) ||
    streamPosition < 0 ||
    typeof payload !== "object" ||
    payload === null ||
    Array.isArray(payload)
  )
    return quarantine(checkpoint, event, "malformed_event");
  const contractMatch = /^workload-funnel\.event\/v(\d+)$/u.exec(
    contractVersion,
  );
  if (contractMatch === null)
    return quarantine(checkpoint, event, "unsupported_major_version");
  const major = Number(contractMatch[1]);
  if (!policy.supportedMajorVersions.has(major))
    return quarantine(checkpoint, event, "unsupported_major_version");
  const requiredExtensions = event["requiredExtensions"];
  if (
    requiredExtensions !== undefined &&
    (!Array.isArray(requiredExtensions) ||
      requiredExtensions.some(
        (extension) =>
          typeof extension !== "string" ||
          !policy.supportedRequiredExtensions.has(extension),
      ))
  )
    return quarantine(checkpoint, event, "unsupported_required_extension");
  if (!policy.supportedEventTypes.has(eventType))
    return quarantine(checkpoint, event, "unsupported_event_type");
  for (const [field, supported] of Object.entries(policy.closedEnumValues)) {
    const value = (payload as Readonly<Record<string, unknown>>)[field];
    if (typeof value === "string" && !supported.has(value))
      return quarantine(checkpoint, event, "unsupported_closed_enum");
  }
  const fingerprint = canonicalJson(event);
  if (checkpoint.appliedEventIds.has(eventId))
    return checkpoint.appliedEventFingerprints.get(eventId) === fingerprint
      ? Object.freeze({ checkpoint, event, status: "applied" })
      : quarantine(checkpoint, event, "conflicting_event_replay");
  if (streamPosition !== checkpoint.streamPosition + 1)
    return quarantine(checkpoint, event, "malformed_event");
  return Object.freeze({
    checkpoint: Object.freeze({
      ...checkpoint,
      appliedEventIds: new Set([...checkpoint.appliedEventIds, eventId]),
      appliedEventFingerprints: new Map([
        ...checkpoint.appliedEventFingerprints,
        [eventId, fingerprint],
      ]),
      streamPosition,
      version: checkpoint.version + 1,
    }),
    event: Object.freeze({ ...event }),
    status: "applied",
  });
}
