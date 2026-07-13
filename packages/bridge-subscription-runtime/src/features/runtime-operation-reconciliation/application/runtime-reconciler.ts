import type {
  TargetOperationObservation,
  TargetReconciler,
  TargetReconciliationResult,
} from "@workload-funnel/node-execution/process-lifecycle";

import type { RuntimeReconciliationClient } from "./contracts/reconciliation-client.js";
import type { RuntimeReconciliationStore } from "./contracts/reconciliation-store.js";

export interface RuntimeReconcilerDependencies {
  readonly client: RuntimeReconciliationClient;
  readonly eventPageSize?: number;
  readonly maxPages?: number;
  readonly store: RuntimeReconciliationStore;
}

const terminalStates = new Set(["exited", "stopped"]);

function observationKey(observation: TargetOperationObservation): string {
  return `${observation.targetId}\u0000${observation.projectId}\u0000${observation.runtimeOperationId}`;
}

function assertPageProgress(
  seen: Set<string>,
  token: string | undefined,
  location: string,
): void {
  if (token !== undefined) {
    if (seen.has(token)) throw new Error(`${location}_cursor_cycle`);
    seen.add(token);
  }
}

export class DurableRuntimeReconciler implements TargetReconciler {
  readonly #client: RuntimeReconciliationClient;
  readonly #eventPageSize: number;
  readonly #maxPages: number;
  readonly #store: RuntimeReconciliationStore;

  public constructor(dependencies: RuntimeReconcilerDependencies) {
    this.#client = dependencies.client;
    this.#store = dependencies.store;
    this.#eventPageSize = dependencies.eventPageSize ?? 200;
    this.#maxPages = dependencies.maxPages ?? 100;
    if (
      !Number.isSafeInteger(this.#eventPageSize) ||
      this.#eventPageSize < 1 ||
      this.#eventPageSize > 1_000
    ) {
      throw new Error("runtime_reconciliation_page_size_invalid");
    }
    if (
      !Number.isSafeInteger(this.#maxPages) ||
      this.#maxPages < 1 ||
      this.#maxPages > 1_000
    ) {
      throw new Error("runtime_reconciliation_max_pages_invalid");
    }
  }

  public async reconcile(): Promise<TargetReconciliationResult> {
    let cursor = await this.#store.checkpoint();
    const eventTokens = new Set<string>();
    let eventsComplete = false;
    for (let pageIndex = 0; pageIndex < this.#maxPages; pageIndex += 1) {
      const page = await this.#client.readEvents(cursor, this.#eventPageSize);
      const ordered = [...page.events].sort(
        (left, right) => left.sourceRevision - right.sourceRevision,
      );
      await this.#store.applyEventBatch(ordered, page.nextCursor ?? cursor);
      if (page.nextCursor === undefined || page.nextCursor === cursor) {
        eventsComplete = true;
        break;
      }
      assertPageProgress(eventTokens, page.nextCursor, "runtime_event");
      cursor = page.nextCursor;
    }
    if (!eventsComplete) throw new Error("runtime_event_page_limit_exceeded");

    const known = new Map<string, TargetOperationObservation>();
    const storedTokens = new Set<string>();
    let storedCursor: string | undefined;
    let storedComplete = false;
    for (let pageIndex = 0; pageIndex < this.#maxPages; pageIndex += 1) {
      const page = await this.#store.list(storedCursor, this.#eventPageSize);
      for (const entry of page.entries) known.set(observationKey(entry), entry);
      if (page.nextCursor === undefined) {
        storedComplete = true;
        break;
      }
      assertPageProgress(storedTokens, page.nextCursor, "runtime_store");
      storedCursor = page.nextCursor;
    }
    if (!storedComplete) throw new Error("runtime_store_page_limit_exceeded");
    const snapshotKeys = new Set<string>();
    const conflicts = new Set<string>();
    const snapshotTokens = new Set<string>();
    let pageToken: string | undefined;
    let snapshotComplete = false;
    for (let pageIndex = 0; pageIndex < this.#maxPages; pageIndex += 1) {
      const page = await this.#client.readSnapshot(
        pageToken,
        this.#eventPageSize,
      );
      for (const snapshot of page.entries) {
        const key = observationKey(snapshot);
        snapshotKeys.add(key);
        const prior = known.get(key);
        if (snapshot.state === "quarantined") {
          conflicts.add(snapshot.operationId);
        }
        if (
          prior !== undefined &&
          (snapshot.sourceRevision < prior.sourceRevision ||
            (snapshot.sourceRevision === prior.sourceRevision &&
              snapshot.state !== prior.state) ||
            (terminalStates.has(prior.state) &&
              !terminalStates.has(snapshot.state)))
        ) {
          conflicts.add(snapshot.operationId);
          continue;
        }
        if (
          prior === undefined ||
          snapshot.sourceRevision > prior.sourceRevision
        ) {
          await this.#store.saveSnapshotObservation(snapshot);
          known.set(key, snapshot);
        }
      }
      if (page.nextPageToken === undefined) {
        snapshotComplete = true;
        break;
      }
      assertPageProgress(
        snapshotTokens,
        page.nextPageToken,
        "runtime_snapshot",
      );
      pageToken = page.nextPageToken;
    }
    if (!snapshotComplete) {
      throw new Error("runtime_snapshot_page_limit_exceeded");
    }

    for (const [key, observation] of known) {
      if (observation.state === "quarantined") {
        conflicts.add(observation.operationId);
      }
      if (!snapshotKeys.has(key) && !terminalStates.has(observation.state)) {
        conflicts.add(observation.operationId);
      }
    }
    return Object.freeze({
      ...(cursor === undefined ? {} : { checkpoint: cursor }),
      conflicts: Object.freeze([...conflicts].sort()),
      observations: Object.freeze(
        [...known.values()].sort((left, right) =>
          left.operationId.localeCompare(right.operationId),
        ),
      ),
    });
  }
}
