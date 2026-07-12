import { createHash } from "node:crypto";

import type { ObservationSpoolStorage } from "./contracts/observation-spool-storage.js";
import {
  ObservationSpoolError,
  type ObservationPublicationAcknowledgement,
  type ObservationSpoolCordonReason,
  type SpooledObservation,
} from "../domain/spooled-observation.js";

type SpoolRecord =
  | { readonly kind: "event"; readonly observation: SpooledObservation }
  | {
      readonly eventId: string;
      readonly kind: "acknowledgement";
      readonly publicationId: string;
    };

interface SpoolEnvelope {
  readonly checksum: string;
  readonly previousChecksum: string;
  readonly record: SpoolRecord;
  readonly sequence: number;
}

function checksumFor(
  sequence: number,
  previousChecksum: string,
  record: SpoolRecord,
): string {
  return createHash("sha256")
    .update(JSON.stringify({ previousChecksum, record, sequence }), "utf8")
    .digest("hex");
}

function validateObservation(observation: SpooledObservation): void {
  if (
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(observation.eventId) ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(observation.nodeId) ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(observation.executionId) ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(
      observation.executionGeneration,
    ) ||
    !/^[a-f0-9]{64}$/u.test(observation.payloadDigest) ||
    !Number.isSafeInteger(observation.bootEpoch) ||
    observation.bootEpoch < 0 ||
    !Number.isSafeInteger(observation.observedAtMs) ||
    observation.observedAtMs < 0 ||
    !Number.isSafeInteger(observation.sourceSequence) ||
    observation.sourceSequence < 1
  ) {
    throw new ObservationSpoolError("observation_spool_corrupt");
  }
}

export class DurableObservationSpool {
  readonly #acknowledgements = new Map<string, string>();
  readonly #events = new Map<string, SpooledObservation>();
  #cordonReason: ObservationSpoolCordonReason | undefined;
  #lastChecksum = "0".repeat(64);
  #recordCount = 0;

  public constructor(private readonly storage: ObservationSpoolStorage) {
    this.recover();
  }

  public get cordonReason(): ObservationSpoolCordonReason | undefined {
    return this.#cordonReason;
  }

  public get pending(): readonly SpooledObservation[] {
    return [...this.#events.values()]
      .filter((event) => !this.#acknowledgements.has(event.eventId))
      .sort((left, right) => left.sourceSequence - right.sourceSequence);
  }

  public append(observation: SpooledObservation): void {
    this.assertHealthy();
    validateObservation(observation);
    const prior = this.#events.get(observation.eventId);
    if (prior !== undefined) {
      if (JSON.stringify(prior) !== JSON.stringify(observation)) {
        this.cordon("observation_spool_corrupt");
      }
      return;
    }
    if (this.#recordCount + 2 > this.storage.capacity) {
      this.cordon("observation_spool_full");
    }
    this.appendRecord({ kind: "event", observation });
    this.#events.set(observation.eventId, Object.freeze({ ...observation }));
  }

  public acknowledge(
    acknowledgement: ObservationPublicationAcknowledgement,
  ): void {
    this.assertHealthy();
    if (!this.#events.has(acknowledgement.eventId)) {
      this.cordon("observation_spool_corrupt");
    }
    const prior = this.#acknowledgements.get(acknowledgement.eventId);
    if (prior !== undefined) {
      if (prior !== acknowledgement.publicationId) {
        this.cordon("observation_spool_corrupt");
      }
      return;
    }
    this.appendRecord({
      eventId: acknowledgement.eventId,
      kind: "acknowledgement",
      publicationId: acknowledgement.publicationId,
    });
    this.#acknowledgements.set(
      acknowledgement.eventId,
      acknowledgement.publicationId,
    );
  }

  public publishPending(
    publish: (observation: SpooledObservation) => string,
  ): number {
    let published = 0;
    for (const observation of this.pending) {
      const publicationId = publish(observation);
      this.acknowledge({ eventId: observation.eventId, publicationId });
      published += 1;
    }
    return published;
  }

  private appendRecord(record: SpoolRecord): void {
    if (this.#recordCount >= this.storage.capacity) {
      this.cordon("observation_spool_full");
    }
    const sequence = this.#recordCount + 1;
    const checksum = checksumFor(sequence, this.#lastChecksum, record);
    try {
      this.storage.appendAndSync(
        JSON.stringify({
          checksum,
          previousChecksum: this.#lastChecksum,
          record,
          sequence,
        }),
      );
    } catch {
      this.cordon("observation_spool_corrupt");
    }
    this.#lastChecksum = checksum;
    this.#recordCount = sequence;
  }

  private recover(): void {
    try {
      const lines = this.storage.readAll();
      if (lines.length > this.storage.capacity)
        throw new Error("over capacity");
      for (const [index, line] of lines.entries()) {
        const envelope = JSON.parse(line) as Partial<SpoolEnvelope>;
        const sequence = index + 1;
        if (
          envelope.sequence !== sequence ||
          envelope.previousChecksum !== this.#lastChecksum ||
          envelope.record === undefined ||
          envelope.checksum !==
            checksumFor(sequence, this.#lastChecksum, envelope.record)
        ) {
          throw new Error("spool checksum mismatch");
        }
        const record = envelope.record;
        if (record.kind === "event") {
          validateObservation(record.observation);
          const prior = this.#events.get(record.observation.eventId);
          if (
            prior !== undefined &&
            JSON.stringify(prior) !== JSON.stringify(record.observation)
          )
            throw new Error("event identity collision");
          this.#events.set(record.observation.eventId, record.observation);
        } else {
          if (!this.#events.has(record.eventId)) throw new Error("orphan ack");
          const prior = this.#acknowledgements.get(record.eventId);
          if (prior !== undefined && prior !== record.publicationId) {
            throw new Error("ack identity collision");
          }
          this.#acknowledgements.set(record.eventId, record.publicationId);
        }
        this.#lastChecksum = envelope.checksum;
        this.#recordCount = sequence;
      }
    } catch {
      this.#events.clear();
      this.#acknowledgements.clear();
      this.#cordonReason = "observation_spool_corrupt";
    }
  }

  private assertHealthy(): void {
    if (this.#cordonReason !== undefined) {
      throw new ObservationSpoolError(this.#cordonReason);
    }
  }

  private cordon(reason: ObservationSpoolCordonReason): never {
    this.#cordonReason = reason;
    throw new ObservationSpoolError(reason);
  }
}
