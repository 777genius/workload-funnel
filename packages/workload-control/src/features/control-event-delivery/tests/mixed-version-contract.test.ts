import { describe, expect, it } from "vitest";

import {
  consumeMixedVersionPublicEvent,
  type PublicEventCompatibilityCheckpoint,
  type PublicEventCompatibilityPolicy,
} from "../index.js";

const policy: PublicEventCompatibilityPolicy = Object.freeze({
  closedEnumValues: Object.freeze({
    state: new Set(["accepted", "running", "succeeded"]),
  }),
  supportedEventTypes: new Set(["RunObserved", "RunCorrection"]),
  supportedMajorVersions: new Set([1]),
  supportedRequiredExtensions: new Set<string>(),
});

function checkpoint(): PublicEventCompatibilityCheckpoint {
  return Object.freeze({
    appliedEventIds: new Set<string>(),
    appliedEventFingerprints: new Map<string, string>(),
    consumerId: "mixed-client",
    quarantined: Object.freeze([]),
    streamPosition: 0,
    version: 1,
  });
}

function event(overrides: Readonly<Record<string, unknown>> = {}) {
  return {
    contractVersion: "workload-funnel.event/v1",
    eventId: "event-1",
    eventType: "RunObserved",
    optionalFutureField: { preservedByPassThrough: true },
    payload: { state: "accepted" },
    streamPosition: 1,
    ...overrides,
  };
}

describe("Phase 5 mixed-version event contract", () => {
  it("accepts additive optional fields in v1 and preserves immutable event data", () => {
    const result = consumeMixedVersionPublicEvent(
      checkpoint(),
      event(),
      policy,
    );
    expect(result.status).toBe("applied");
    expect(result.checkpoint.streamPosition).toBe(1);
    if (result.status !== "applied") throw new Error("event_not_applied");
    expect(result.event["optionalFutureField"]).toEqual({
      preservedByPassThrough: true,
    });
  });

  it.each([
    [
      "unsupported_major_version",
      event({ contractVersion: "workload-funnel.event/v2" }),
    ],
    [
      "unsupported_major_version",
      event({ contractVersion: "foreign-protocol/v1" }),
    ],
    [
      "unsupported_required_extension",
      event({ requiredExtensions: ["requires-v2-projection"] }),
    ],
    ["unsupported_event_type", event({ eventType: "NewClosedEvent" })],
    ["unsupported_closed_enum", event({ payload: { state: "paused" } })],
  ])("quarantines %s without advancing the checkpoint", (reason, input) => {
    const result = consumeMixedVersionPublicEvent(checkpoint(), input, policy);
    expect(result).toMatchObject({ reason, status: "quarantined" });
    expect(result.checkpoint.streamPosition).toBe(0);
    expect(result.checkpoint.quarantined).toHaveLength(1);
  });

  it("models corrections as a new immutable event", () => {
    const first = consumeMixedVersionPublicEvent(checkpoint(), event(), policy);
    const correction = consumeMixedVersionPublicEvent(
      first.checkpoint,
      event({
        eventId: "event-2",
        eventType: "RunCorrection",
        payload: { correctsEventId: "event-1", state: "running" },
        streamPosition: 2,
      }),
      policy,
    );
    expect(correction.status).toBe("applied");
    expect(correction.checkpoint.streamPosition).toBe(2);
    expect(correction.checkpoint.appliedEventIds).toEqual(
      new Set(["event-1", "event-2"]),
    );
  });

  it("deduplicates exact delivery but quarantines a mutated event-ID replay", () => {
    const first = consumeMixedVersionPublicEvent(checkpoint(), event(), policy);
    expect(
      consumeMixedVersionPublicEvent(first.checkpoint, event(), policy).status,
    ).toBe("applied");
    const conflict = consumeMixedVersionPublicEvent(
      first.checkpoint,
      event({ payload: { state: "running" } }),
      policy,
    );
    expect(conflict).toMatchObject({
      reason: "conflicting_event_replay",
      status: "quarantined",
    });
    expect(conflict.checkpoint.streamPosition).toBe(1);
  });
});
