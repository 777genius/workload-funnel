import { describe, expect, it } from "vitest";

import {
  closeCancellationBarrier,
  createCancellationSaga,
  recordAuthorityEvidence,
  recordCancellationExecutionEvidence,
  recordCancellationRelease,
  recordStartRevocation,
  type CancellationAuthorityEvidence,
  type CancellationSaga,
} from "../index.js";

function recover(saga: CancellationSaga): CancellationSaga {
  return Object.freeze(JSON.parse(JSON.stringify(saga)) as CancellationSaga);
}

describe("Phase 2 durable cancellation crash and race matrix", () => {
  it("survives a restart before and after every durable barrier mutation", () => {
    let saga = recover(
      createCancellationSaga("cancel-1", "run-1", "attempt-1"),
    );
    saga = recover(recordStartRevocation(saga, 3));
    saga = recover(
      recordAuthorityEvidence(saga, {
        authorityId: "launcher-1",
        evidenceDigest: "launcher-wal-10",
        kind: "acknowledged",
        revision: 3,
      }),
    );
    saga = recover(
      recordAuthorityEvidence(saga, {
        authorityId: "gateway-1",
        evidenceDigest: "gateway-fence-2",
        kind: "independently_fenced",
        revision: 0,
      }),
    );
    saga = recover(
      recordCancellationExecutionEvidence(saga, {
        evidenceDigest: "unit-stopped-4",
        kind: "stopped",
      }),
    );
    saga = recover(closeCancellationBarrier(saga, ["launcher-1", "gateway-1"]));
    saga = recover(recordCancellationRelease(saga, "terminal-release-1"));
    expect(saga).toMatchObject({
      state: "release_committed",
      terminalReleaseReceiptId: "terminal-release-1",
    });
  });

  it.each([
    ["unreachable", 3],
    ["acknowledged", 2],
  ] as const)(
    "retains capacity while final authority evidence is %s at revision %s",
    (kind, revision) => {
      let saga = recordStartRevocation(
        createCancellationSaga("cancel-1", "run-1", "attempt-1"),
        3,
      );
      saga = recordAuthorityEvidence(saga, {
        authorityId: "launcher-1",
        evidenceDigest: `${kind}-${String(revision)}`,
        kind,
        revision,
      } as CancellationAuthorityEvidence);
      saga = recordCancellationExecutionEvidence(saga, {
        evidenceDigest: "absent",
        kind: "superseded",
      });
      expect(() => closeCancellationBarrier(saga, ["launcher-1"])).toThrow(
        "start_authority_barrier_open",
      );
      expect(() =>
        recordCancellationRelease(saga, "forbidden-release"),
      ).toThrow("release_before_quiescence");
    },
  );

  it("accepts authority acknowledgement, independent fencing, or authorization expiry", () => {
    for (const kind of [
      "acknowledged",
      "independently_fenced",
      "authorization_expired",
    ] as const) {
      let saga = recordStartRevocation(
        createCancellationSaga(`cancel-${kind}`, "run-1", "attempt-1"),
        4,
      );
      saga = recordAuthorityEvidence(saga, {
        authorityId: "launcher-1",
        evidenceDigest: kind,
        kind,
        revision: kind === "acknowledged" ? 4 : 0,
      });
      saga = recordCancellationExecutionEvidence(saga, {
        evidenceDigest: "not-submitted",
        kind: "not_submitted",
      });
      expect(closeCancellationBarrier(saga, ["launcher-1"]).state).toBe(
        "barrier_closed",
      );
    }
  });

  it("preserves unknown execution ambiguity despite complete authority revocation", () => {
    let saga = recordStartRevocation(
      createCancellationSaga("cancel-unknown", "run-1", "attempt-1"),
      1,
    );
    saga = recordAuthorityEvidence(saga, {
      authorityId: "launcher-1",
      evidenceDigest: "ack-1",
      kind: "acknowledged",
      revision: 1,
    });
    saga = recordCancellationExecutionEvidence(saga, {
      evidenceDigest: "still-unknown",
      kind: "unknown",
    });
    expect(() => closeCancellationBarrier(saga, ["launcher-1"])).toThrow(
      "execution_quiescence_barrier_open",
    );
  });

  it("rejects conflicting duplicate authority and execution evidence", () => {
    let saga = recordStartRevocation(
      createCancellationSaga("cancel-1", "run-1", "attempt-1"),
      1,
    );
    saga = recordAuthorityEvidence(saga, {
      authorityId: "launcher-1",
      evidenceDigest: "ack-1",
      kind: "acknowledged",
      revision: 1,
    });
    expect(() =>
      recordAuthorityEvidence(saga, {
        authorityId: "launcher-1",
        evidenceDigest: "different",
        kind: "acknowledged",
        revision: 1,
      }),
    ).toThrow("authority_evidence_conflict");
  });
});
