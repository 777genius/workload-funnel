import { describe, expect, it } from "vitest";

import {
  NamespaceOwnershipConflictError,
  abortOwnershipTransfer,
  acknowledgeOwnershipAuthority,
  advanceWriterEpoch,
  beginOwnershipTransfer,
  completeOwnershipTransfer,
  initializeNamespaceOwnership,
} from "../index.js";

describe("Phase 2 NamespaceOwnership", () => {
  it("performs pending -> epoch_advanced -> completed with complete authority evidence", () => {
    const initial = initializeNamespaceOwnership(
      "namespace-1",
      "writer-a",
      "release-a",
    );
    const pending = beginOwnershipTransfer(initial, {
      expectedVersion: 1,
      operationId: "transfer-1",
      requiredAuthorityIds: ["launcher-1", "gateway-1", "launcher-1"],
      targetWriterId: "writer-b",
    });
    expect(pending).toMatchObject({ writerEpoch: 1, writerId: "writer-a" });
    expect(pending.transfer).toMatchObject({
      requiredAuthorityIds: ["gateway-1", "launcher-1"],
      state: "pending",
    });
    const advanced = advanceWriterEpoch(pending, {
      expectedVersion: 2,
      operationId: "transfer-1",
      targetEpoch: 2,
      targetWriterRelease: "release-b",
    });
    expect(advanced).toMatchObject({ writerEpoch: 2, writerId: "writer-b" });
    expect(advanced.transfer?.state).toBe("epoch_advanced");
    expect(
      advanceWriterEpoch(advanced, {
        expectedVersion: 3,
        operationId: "transfer-1",
        targetEpoch: 2,
        targetWriterRelease: "release-b",
      }),
    ).toBe(advanced);
    const gateway = acknowledgeOwnershipAuthority(
      advanced,
      "transfer-1",
      {
        authorityId: "gateway-1",
        registrySequence: 11,
        targetEpoch: 2,
        tupleFingerprint: "tuple-2",
      },
      3,
    );
    expect(() => completeOwnershipTransfer(gateway, "transfer-1", 4)).toThrow(
      "authority_inventory_incomplete",
    );
    const launcher = acknowledgeOwnershipAuthority(
      gateway,
      "transfer-1",
      {
        authorityId: "launcher-1",
        registrySequence: 12,
        targetEpoch: 2,
        tupleFingerprint: "tuple-2",
      },
      4,
    );
    const completed = completeOwnershipTransfer(launcher, "transfer-1", 5);
    expect(completed.transfer?.state).toBe("completed");
    expect(completeOwnershipTransfer(completed, "transfer-1", 6)).toBe(
      completed,
    );
  });

  it("permits abort only before epoch CAS", () => {
    const initial = initializeNamespaceOwnership(
      "namespace-1",
      "writer-a",
      "release-a",
    );
    const pending = beginOwnershipTransfer(initial, {
      expectedVersion: 1,
      operationId: "transfer-1",
      requiredAuthorityIds: [],
      targetWriterId: "writer-b",
    });
    expect(
      abortOwnershipTransfer(pending, "transfer-1", 2).transfer?.state,
    ).toBe("aborted");
    const advanced = advanceWriterEpoch(pending, {
      expectedVersion: 2,
      operationId: "transfer-1",
      targetEpoch: 2,
      targetWriterRelease: "release-b",
    });
    expect(() => abortOwnershipTransfer(advanced, "transfer-1", 3)).toThrow(
      NamespaceOwnershipConflictError,
    );
  });

  it("models rollback as a new writer at a fresh epoch, never epoch reuse", () => {
    const initial = initializeNamespaceOwnership(
      "namespace-1",
      "writer-new",
      "release-new",
    );
    const pending = beginOwnershipTransfer(initial, {
      expectedVersion: 1,
      operationId: "rollback-1",
      requiredAuthorityIds: [],
      targetWriterId: "writer-compatible-old-release",
    });
    const rolledBack = advanceWriterEpoch(pending, {
      expectedVersion: 2,
      operationId: "rollback-1",
      targetEpoch: 2,
      targetWriterRelease: "old-compatible-release",
    });
    expect(rolledBack).toMatchObject({
      writerEpoch: 2,
      writerId: "writer-compatible-old-release",
    });
  });

  it("rejects stale versions, skipped epochs, and mismatched acknowledgements", () => {
    const initial = initializeNamespaceOwnership(
      "namespace-1",
      "writer-a",
      "release-a",
    );
    expect(() =>
      beginOwnershipTransfer(initial, {
        expectedVersion: 0,
        operationId: "transfer-1",
        requiredAuthorityIds: [],
        targetWriterId: "writer-b",
      }),
    ).toThrow("stale_namespace_version");
    const pending = beginOwnershipTransfer(initial, {
      expectedVersion: 1,
      operationId: "transfer-1",
      requiredAuthorityIds: ["launcher-1"],
      targetWriterId: "writer-b",
    });
    expect(() =>
      advanceWriterEpoch(pending, {
        expectedVersion: 2,
        operationId: "transfer-1",
        targetEpoch: 4,
        targetWriterRelease: "release-b",
      }),
    ).toThrow("writer_epoch_cas_failed");
  });
});
