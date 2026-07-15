import { Buffer } from "node:buffer";
import { createHash, randomUUID } from "node:crypto";
import { lstat, open, readFile, rename, rm } from "node:fs/promises";
import { dirname } from "node:path";

import { OWNED_NAME_PATTERN } from "./constants.mjs";

const LEDGER_SCHEMA = "workload-funnel.production-gate.cleanup-ledger.v1";
const states = new Set(["active", "prepared", "removed", "uncertain"]);

function checksum(payload) {
  return createHash("sha256")
    .update(JSON.stringify(payload), "utf8")
    .digest("hex");
}

function owned(runId, name) {
  return (
    name.startsWith(`${runId}-`) || name === runId || name === `${runId}.slice`
  );
}

function validateRecord(record, runId) {
  if (
    record === null ||
    typeof record !== "object" ||
    Array.isArray(record) ||
    !/^[a-f0-9-]{36}$/u.test(record.recordId ?? "") ||
    typeof record.kind !== "string" ||
    !/^[a-z][a-z0-9-]{0,63}$/u.test(record.kind) ||
    typeof record.name !== "string" ||
    !owned(runId, record.name) ||
    !Number.isSafeInteger(record.order) ||
    record.order < 1 ||
    !states.has(record.state) ||
    record.expected === null ||
    typeof record.expected !== "object" ||
    Array.isArray(record.expected) ||
    record.observed === null ||
    typeof record.observed !== "object" ||
    Array.isArray(record.observed) ||
    (record.errorCode !== null &&
      (typeof record.errorCode !== "string" ||
        !/^[a-z0-9_]{1,128}$/u.test(record.errorCode)))
  )
    throw new Error("cleanup_ledger_corrupt");
}

function decodeEnvelope(text, runId) {
  let envelope;
  try {
    envelope = JSON.parse(text);
  } catch {
    throw new Error("cleanup_ledger_corrupt");
  }
  if (
    envelope === null ||
    typeof envelope !== "object" ||
    Array.isArray(envelope) ||
    typeof envelope.checksum !== "string" ||
    envelope.payload === null ||
    typeof envelope.payload !== "object" ||
    Array.isArray(envelope.payload) ||
    checksum(envelope.payload) !== envelope.checksum ||
    envelope.payload.schemaVersion !== LEDGER_SCHEMA ||
    envelope.payload.runId !== runId ||
    !Array.isArray(envelope.payload.records) ||
    envelope.payload.records.length > 1024
  )
    throw new Error("cleanup_ledger_corrupt");
  const ids = new Set();
  const identities = new Set();
  for (const record of envelope.payload.records) {
    validateRecord(record, runId);
    const identity = `${record.kind}\0${record.name}`;
    if (ids.has(record.recordId) || identities.has(identity))
      throw new Error("cleanup_ledger_corrupt");
    ids.add(record.recordId);
    identities.add(identity);
  }
  return envelope.payload;
}

async function syncDirectory(path) {
  const directory = await open(dirname(path), "r");
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}

export class OwnedResourceLedger {
  #cleanup = new Map();
  #mutationTail = Promise.resolve();
  #path;
  #records;
  #recoveryCleaners;
  #runId;

  static async open({ path, recoveryCleaners = {}, runId }) {
    const ledger = new OwnedResourceLedger({ path, recoveryCleaners, runId });
    await ledger.#loadOrCreate();
    return ledger;
  }

  constructor({ path, recoveryCleaners = {}, runId }) {
    if (
      typeof path !== "string" ||
      !path.startsWith("/") ||
      typeof runId !== "string" ||
      !OWNED_NAME_PATTERN.test(runId)
    )
      throw new Error("cleanup_ledger_configuration_invalid");
    this.#path = path;
    this.#records = [];
    this.#recoveryCleaners = Object.freeze({ ...recoveryCleaners });
    this.#runId = runId;
  }

  #serializeMutation(operation) {
    const result = this.#mutationTail.then(operation);
    this.#mutationTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  async #loadOrCreate() {
    const temporary = `${this.#path}.next`;
    try {
      const identity = await lstat(this.#path);
      if (
        !identity.isFile() ||
        identity.isSymbolicLink() ||
        identity.uid !== process.getuid?.() ||
        (identity.mode & 0o077) !== 0 ||
        identity.size < 1 ||
        identity.size > 4 * 1024 * 1024
      )
        throw new Error("cleanup_ledger_identity_untrusted");
      const payload = decodeEnvelope(
        await readFile(this.#path, "utf8"),
        this.#runId,
      );
      this.#records = payload.records.map((record) => ({ ...record }));
    } catch (error) {
      if (error?.code !== "ENOENT") {
        throw error;
      }
      try {
        const identity = await lstat(temporary);
        if (
          !identity.isFile() ||
          identity.isSymbolicLink() ||
          identity.uid !== process.getuid?.() ||
          (identity.mode & 0o077) !== 0
        )
          throw new Error("cleanup_ledger_identity_untrusted");
        decodeEnvelope(await readFile(temporary, "utf8"), this.#runId);
        await rename(temporary, this.#path);
        await syncDirectory(this.#path);
        await this.#loadOrCreate();
        return;
      } catch (temporaryError) {
        if (temporaryError?.code !== "ENOENT") throw temporaryError;
      }
      await this.#persist();
      return;
    }
    await rm(temporary, { force: true });
    await syncDirectory(this.#path);
  }

  async #persist() {
    const payload = {
      records: this.#records,
      runId: this.#runId,
      schemaVersion: LEDGER_SCHEMA,
    };
    const temporary = `${this.#path}.next`;
    const descriptor = await open(temporary, "wx", 0o600);
    try {
      await descriptor.writeFile(
        `${JSON.stringify({ checksum: checksum(payload), payload })}\n`,
        "utf8",
      );
      await descriptor.sync();
    } finally {
      await descriptor.close();
    }
    await rename(temporary, this.#path);
    await syncDirectory(this.#path);
    const identity = await lstat(this.#path);
    if (
      !identity.isFile() ||
      identity.isSymbolicLink() ||
      identity.uid !== process.getuid?.() ||
      (identity.mode & 0o077) !== 0
    )
      throw new Error("cleanup_ledger_identity_untrusted");
    const persisted = decodeEnvelope(
      await readFile(this.#path, "utf8"),
      this.#runId,
    );
    if (JSON.stringify(persisted) !== JSON.stringify(payload))
      throw new Error("cleanup_ledger_reopen_mismatch");
  }

  async prepare(kind, name, expected = {}) {
    return this.#serializeMutation(async () => {
      if (!/^[a-z][a-z0-9-]{0,63}$/u.test(kind) || !owned(this.#runId, name))
        throw new Error("resource_not_owned_by_gate_run");
      if (
        expected === null ||
        typeof expected !== "object" ||
        Array.isArray(expected) ||
        Buffer.byteLength(JSON.stringify(expected)) > 16 * 1024
      )
        throw new Error("cleanup_ledger_expected_identity_invalid");
      if (
        this.#records.some(
          (record) => record.kind === kind && record.name === name,
        )
      )
        throw new Error("duplicate_owned_resource");
      if (this.#records.length >= 1024) throw new Error("cleanup_ledger_full");
      const record = {
        errorCode: null,
        expected: { ...expected },
        kind,
        name,
        observed: {},
        order: this.#records.length + 1,
        recordId: randomUUID(),
        state: "prepared",
      };
      this.#records.push(record);
      await this.#persist();
      return record.recordId;
    });
  }

  async finalize(recordId, observed, cleanup) {
    return this.#serializeMutation(async () => {
      const record = this.#records.find((item) => item.recordId === recordId);
      if (record === undefined || record.state !== "prepared")
        throw new Error("cleanup_ledger_prepare_missing");
      if (
        observed === null ||
        typeof observed !== "object" ||
        Array.isArray(observed) ||
        Buffer.byteLength(JSON.stringify(observed)) > 16 * 1024 ||
        typeof cleanup !== "function"
      )
        throw new Error("cleanup_ledger_observed_identity_invalid");
      record.observed = { ...observed };
      record.state = "active";
      await this.#persist();
      this.#cleanup.set(recordId, cleanup);
    });
  }

  snapshot() {
    return Object.freeze(
      this.#records
        .filter((record) => record.state !== "removed")
        .map((record) =>
          Object.freeze({
            errorCode: record.errorCode,
            expected: Object.freeze({ ...record.expected }),
            kind: record.kind,
            name: record.name,
            observed: Object.freeze({ ...record.observed }),
            recordId: record.recordId,
            state: record.state,
          }),
        ),
    );
  }

  async cleanup() {
    return this.#serializeMutation(async () => {
      const outcomes = [];
      const pending = this.#records
        .filter((record) => record.state !== "removed")
        .sort((left, right) => right.order - left.order);
      for (const record of pending) {
        try {
          const cleanup =
            this.#cleanup.get(record.recordId) ??
            this.#recoveryCleaners[record.kind];
          if (typeof cleanup !== "function")
            throw new Error("cleanup_recovery_handler_missing");
          await cleanup(Object.freeze({ ...record }));
          record.errorCode = null;
          record.state = "removed";
          await this.#persist();
          outcomes.push({
            kind: record.kind,
            name: record.name,
            status: "removed",
          });
        } catch (error) {
          const code =
            error instanceof Error && /^[a-z0-9_]{1,128}$/u.test(error.message)
              ? error.message
              : "cleanup_failed";
          record.errorCode = code;
          record.state = "uncertain";
          await this.#persist();
          outcomes.push({
            errorCode: code,
            kind: record.kind,
            name: record.name,
            status: "uncertain",
          });
        }
      }
      return Object.freeze({
        certain: outcomes.every((outcome) => outcome.status === "removed"),
        outcomes: Object.freeze(outcomes),
        pending: this.snapshot(),
      });
    });
  }

  recover() {
    return this.cleanup();
  }
}
