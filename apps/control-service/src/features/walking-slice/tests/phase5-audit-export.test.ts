import { describe, expect, it } from "vitest";

import {
  exportAuditRecords,
  verifyAuditChain,
} from "@workload-funnel/observability/audit-export";
import { createSqliteAuditLedgerStore } from "@workload-funnel/store-sqlite/audit-ledger-persistence";

describe("Phase 5 tamper-evident audit export", () => {
  it("cryptographically verifies record contents and chain linkage before export", () => {
    const store = createSqliteAuditLedgerStore([]);
    const affectedResources = ["tenant-1", "workload-1"];
    const details = {
      affectedResources,
      correlationId: "correlation-1",
      nextState: "accepted",
      occurredAt: 1,
      policyVersion: 7,
      previousState: "absent",
      reason: "operator request",
    } as const;
    store.append(
      "event-1",
      "operator-1",
      "workload.accepted",
      "workload-1",
      details,
    );
    affectedResources.push("later-caller-mutation");
    const records = store.records();
    const first = records[0];
    if (first === undefined) throw new Error("audit_record_missing");
    const verifyRecord = (record: (typeof records)[number]) =>
      store.verify(record);
    expect(() => {
      verifyAuditChain(records, verifyRecord);
    }).not.toThrow();
    expect(
      exportAuditRecords(
        store,
        Object.freeze({ export: () => undefined }),
        0,
        10,
      )?.chainHead,
    ).toBe(first.hash);

    const tampered = Object.freeze([
      Object.freeze({ ...first, reason: "rewritten reason" }),
    ]);
    expect(() => {
      verifyAuditChain(tampered, verifyRecord);
    }).toThrow("audit_chain_invalid");
    expect(() =>
      store.append("event-1", "operator-1", "workload.accepted", "workload-1", {
        ...details,
        reason: "conflicting replay",
      }),
    ).toThrow("audit_event_id_conflict");
  });
});
