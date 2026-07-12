export type ReservationResources = Readonly<Record<string, number>>;

export interface CapacityLedgerSnapshot {
  readonly namespaceId: string;
  readonly poolId: string;
  readonly nodeId: string;
  readonly reservationLedgerRevision: number;
  readonly nodeObservationRevision: number;
  readonly capacity: ReservationResources;
  readonly reserved: ReservationResources;
  readonly available: ReservationResources;
  readonly allocationCount: number;
}

export interface ResourceReservation {
  readonly allocationId: string;
  readonly attemptId: string;
  readonly tenantId: string;
  readonly workloadClass: string;
  readonly resources: ReservationResources;
  readonly reservationLedgerRevision: number;
  readonly nodeObservationRevision: number;
}

export interface ReserveResourcesCommand {
  readonly allocationId: string;
  readonly attemptId: string;
  readonly tenantId: string;
  readonly workloadClass: string;
  readonly resources: ReservationResources;
  readonly expectedReservationLedgerRevision: number;
  readonly expectedNodeObservationRevision: number;
}

export class StaleCapacityDecisionError extends Error {
  public constructor(
    code: "reservation_revision" | "node_observation_revision",
  ) {
    super(`stale_${code}`);
    this.name = "StaleCapacityDecisionError";
  }
}

export class HardResourceOvercommitError extends Error {
  public constructor() {
    super("hard_resource_capacity_exceeded");
    this.name = "HardResourceOvercommitError";
  }
}

function normalized(resources: ReservationResources): ReservationResources {
  const result: Record<string, number> = {};
  for (const [dimension, amount] of Object.entries(resources).sort(([a], [b]) =>
    a.localeCompare(b),
  )) {
    if (!dimension || !Number.isSafeInteger(amount) || amount < 0) {
      throw new Error("invalid_reservation_resource");
    }
    result[dimension] = amount;
  }
  return Object.freeze(result);
}

function sameResources(
  first: ReservationResources,
  second: ReservationResources,
): boolean {
  const keys = new Set([...Object.keys(first), ...Object.keys(second)]);
  return [...keys].every((key) => (first[key] ?? 0) === (second[key] ?? 0));
}

export class SerializedCapacityReservationLedger {
  readonly #namespaceId: string;
  readonly #poolId: string;
  readonly #nodeId: string;
  #capacity: ReservationResources;
  #reserved: Record<string, number>;
  #reservationLedgerRevision = 0;
  #nodeObservationRevision: number;
  readonly #reservations = new Map<string, ResourceReservation>();
  readonly #attempts = new Map<string, string>();
  readonly #released = new Set<string>();

  public constructor(
    input: Readonly<{
      namespaceId: string;
      poolId: string;
      nodeId: string;
      capacity: ReservationResources;
      nodeObservationRevision: number;
    }>,
  ) {
    this.#namespaceId = input.namespaceId;
    this.#poolId = input.poolId;
    this.#nodeId = input.nodeId;
    this.#capacity = normalized(input.capacity);
    this.#reserved = Object.fromEntries(
      Object.keys(this.#capacity).map((dimension) => [dimension, 0]),
    );
    this.#nodeObservationRevision = input.nodeObservationRevision;
  }

  public snapshot(): CapacityLedgerSnapshot {
    const available = Object.fromEntries(
      Object.entries(this.#capacity).map(([dimension, amount]) => [
        dimension,
        amount - (this.#reserved[dimension] ?? 0),
      ]),
    );
    return Object.freeze({
      allocationCount: this.#reservations.size,
      available: Object.freeze(available),
      capacity: this.#capacity,
      namespaceId: this.#namespaceId,
      nodeId: this.#nodeId,
      nodeObservationRevision: this.#nodeObservationRevision,
      poolId: this.#poolId,
      reservationLedgerRevision: this.#reservationLedgerRevision,
      reserved: Object.freeze({ ...this.#reserved }),
    });
  }

  public replaceCapacity(
    expectedNodeObservationRevision: number,
    nextNodeObservationRevision: number,
    capacity: ReservationResources,
  ): CapacityLedgerSnapshot {
    if (this.#nodeObservationRevision !== expectedNodeObservationRevision) {
      throw new StaleCapacityDecisionError("node_observation_revision");
    }
    if (nextNodeObservationRevision <= expectedNodeObservationRevision) {
      throw new Error("non_monotonic_node_observation_revision");
    }
    const next = normalized(capacity);
    for (const [dimension, amount] of Object.entries(this.#reserved)) {
      if (amount > (next[dimension] ?? 0))
        throw new HardResourceOvercommitError();
    }
    this.#capacity = next;
    this.#nodeObservationRevision = nextNodeObservationRevision;
    this.#reservationLedgerRevision += 1;
    return this.snapshot();
  }

  public reserve(command: ReserveResourcesCommand): ResourceReservation {
    const attemptAllocation = this.#attempts.get(command.attemptId);
    if (attemptAllocation !== undefined) {
      const existing = this.#reservations.get(attemptAllocation);
      if (existing?.allocationId !== command.allocationId) {
        throw new Error("attempt_reservation_conflict");
      }
      if (
        !sameResources(existing.resources, command.resources) ||
        existing.tenantId !== command.tenantId ||
        existing.workloadClass !== command.workloadClass
      ) {
        throw new Error("attempt_reservation_conflict");
      }
      return existing;
    }
    if (
      command.expectedReservationLedgerRevision !==
      this.#reservationLedgerRevision
    ) {
      throw new StaleCapacityDecisionError("reservation_revision");
    }
    if (
      command.expectedNodeObservationRevision !== this.#nodeObservationRevision
    ) {
      throw new StaleCapacityDecisionError("node_observation_revision");
    }
    if (this.#reservations.has(command.allocationId)) {
      throw new Error("allocation_id_conflict");
    }
    const resources = normalized(command.resources);
    for (const [dimension, amount] of Object.entries(resources)) {
      if (
        (this.#reserved[dimension] ?? 0) + amount >
        (this.#capacity[dimension] ?? 0)
      ) {
        throw new HardResourceOvercommitError();
      }
    }
    for (const [dimension, amount] of Object.entries(resources)) {
      this.#reserved[dimension] = (this.#reserved[dimension] ?? 0) + amount;
    }
    this.#reservationLedgerRevision += 1;
    const reservation = Object.freeze({
      allocationId: command.allocationId,
      attemptId: command.attemptId,
      nodeObservationRevision: this.#nodeObservationRevision,
      reservationLedgerRevision: this.#reservationLedgerRevision,
      resources,
      tenantId: command.tenantId,
      workloadClass: command.workloadClass,
    });
    this.#reservations.set(command.allocationId, reservation);
    this.#attempts.set(command.attemptId, command.allocationId);
    return reservation;
  }

  public release(
    allocationId: string,
    expectedReservationLedgerRevision: number,
  ): CapacityLedgerSnapshot {
    if (this.#released.has(allocationId)) return this.snapshot();
    if (expectedReservationLedgerRevision !== this.#reservationLedgerRevision) {
      throw new StaleCapacityDecisionError("reservation_revision");
    }
    const reservation = this.#reservations.get(allocationId);
    if (reservation === undefined) return this.snapshot();
    for (const [dimension, amount] of Object.entries(reservation.resources)) {
      this.#reserved[dimension] = (this.#reserved[dimension] ?? 0) - amount;
    }
    this.#reservations.delete(allocationId);
    this.#released.add(allocationId);
    this.#reservationLedgerRevision += 1;
    return this.snapshot();
  }
}
