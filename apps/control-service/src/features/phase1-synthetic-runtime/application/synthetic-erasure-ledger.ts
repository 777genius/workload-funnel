import { createHash } from "node:crypto";

import type { Phase1SyntheticService } from "./synthetic-relational-profile.js";
import type { SyntheticDatabase } from "./synthetic-state.js";

export interface SyntheticErasureLedgerRecordV1 {
  readonly contractVersion: "workload-funnel.erasure-ledger/v1";
  readonly sequence: number;
  readonly operationId: string;
  readonly tenantId: string;
  readonly subjectDigest: string;
  readonly pseudonym: string;
  readonly dataClasses: readonly string[];
  readonly state: "completed" | "pending_legal_hold";
  readonly reasonDigest: string;
  readonly requestedAt: number;
  readonly previousHash: string;
  readonly hash: string;
}

export interface SyntheticErasureLedger {
  append(
    input: Omit<
      SyntheticErasureLedgerRecordV1,
      "contractVersion" | "sequence" | "previousHash" | "hash"
    >,
  ): SyntheticErasureLedgerRecordV1;
  records(): readonly SyntheticErasureLedgerRecordV1[];
  verify(record: SyntheticErasureLedgerRecordV1): boolean;
}

function hash(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function material(
  record: Omit<SyntheticErasureLedgerRecordV1, "hash">,
): string {
  return JSON.stringify({
    contractVersion: record.contractVersion,
    dataClasses: record.dataClasses,
    operationId: record.operationId,
    previousHash: record.previousHash,
    pseudonym: record.pseudonym,
    reasonDigest: record.reasonDigest,
    requestedAt: record.requestedAt,
    sequence: record.sequence,
    state: record.state,
    subjectDigest: record.subjectDigest,
    tenantId: record.tenantId,
  });
}

export function syntheticErasureSubjectDigest(
  tenantId: string,
  subjectReference: string,
): string {
  return hash(`${tenantId}\0${subjectReference}`);
}

export function createSyntheticErasureLedger(
  initial: readonly SyntheticErasureLedgerRecordV1[] = [],
): SyntheticErasureLedger {
  const records = initial.map((record) =>
    Object.freeze({
      ...record,
      dataClasses: Object.freeze([...record.dataClasses]),
    }),
  );
  const boundedText = (value: string): boolean =>
    value.length > 0 && value.length <= 256 && !/\p{Cc}/u.test(value);
  const validInput = (
    input: Omit<
      SyntheticErasureLedgerRecordV1,
      "contractVersion" | "sequence" | "previousHash" | "hash"
    >,
  ): boolean =>
    boundedText(input.operationId) &&
    boundedText(input.tenantId) &&
    boundedText(input.pseudonym) &&
    /^[a-f0-9]{64}$/u.test(input.subjectDigest) &&
    /^[a-f0-9]{64}$/u.test(input.reasonDigest) &&
    Number.isSafeInteger(input.requestedAt) &&
    input.requestedAt >= 0 &&
    input.dataClasses.length > 0 &&
    input.dataClasses.length <= 10 &&
    new Set(input.dataClasses).size === input.dataClasses.length &&
    input.dataClasses.every(boundedText);
  const ledger: SyntheticErasureLedger = {
    append(input) {
      if (!validInput(input)) throw new Error("invalid_erasure_ledger_record");
      const prior = records.find(
        (record) => record.operationId === input.operationId,
      );
      if (prior !== undefined) {
        if (
          prior.tenantId !== input.tenantId ||
          prior.subjectDigest !== input.subjectDigest ||
          prior.pseudonym !== input.pseudonym ||
          prior.state !== input.state ||
          prior.reasonDigest !== input.reasonDigest ||
          JSON.stringify(prior.dataClasses) !==
            JSON.stringify([...input.dataClasses].sort())
        )
          throw new Error("erasure_ledger_operation_conflict");
        return prior;
      }
      const base = Object.freeze({
        ...input,
        contractVersion: "workload-funnel.erasure-ledger/v1" as const,
        dataClasses: Object.freeze([...input.dataClasses].sort()),
        previousHash: records.at(-1)?.hash ?? "genesis",
        sequence: records.length + 1,
      });
      const record = Object.freeze({ ...base, hash: hash(material(base)) });
      records.push(record);
      return record;
    },
    records() {
      let previousHash = "genesis";
      for (const [index, record] of records.entries()) {
        const runtimeRecord = record as unknown as Readonly<
          Record<string, unknown>
        >;
        if (
          record.sequence !== index + 1 ||
          runtimeRecord["contractVersion"] !==
            "workload-funnel.erasure-ledger/v1" ||
          record.previousHash !== previousHash ||
          !validInput(record) ||
          !/^(?:genesis|[a-f0-9]{64})$/u.test(record.previousHash) ||
          !/^[a-f0-9]{64}$/u.test(record.hash) ||
          !ledger.verify(record)
        )
          throw new Error("erasure_ledger_invalid");
        previousHash = record.hash;
      }
      return Object.freeze([...records]);
    },
    verify: (record) => hash(material(record)) === record.hash,
  };
  ledger.records();
  return Object.freeze(ledger);
}

export function replaySyntheticErasureLedger(
  service: Phase1SyntheticService,
  database: SyntheticDatabase,
): void {
  const { state } = database;
  for (const record of database.erasureLedger.records()) {
    state.erasureLedgerSequence = Math.max(
      state.erasureLedgerSequence,
      record.sequence,
    );
    if (record.state !== "completed") continue;
    const candidates = new Set<string>();
    for (const workload of state.workloadById.values())
      if (workload.tenantId === record.tenantId)
        candidates.add(workload.principalId);
    for (const audit of state.audit) {
      candidates.add(audit.actorId);
      for (const affected of audit.affectedResources ?? [])
        candidates.add(affected);
    }
    for (const candidate of candidates) {
      if (
        syntheticErasureSubjectDigest(record.tenantId, candidate) !==
        record.subjectDigest
      )
        continue;
      service.erasePrincipalReferences({
        operationId: record.operationId,
        pseudonym: record.pseudonym,
        subjectPrincipalId: candidate,
      });
      state.erasedSubjectPseudonyms.set(candidate, record.pseudonym);
    }
  }
}
