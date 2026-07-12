import {
  assertGateOpen,
  type OperationGateSet,
} from "@workload-funnel/workload-control/operation-gating";
import type { SyntheticResultFile } from "@workload-funnel/workload-control/workload-lifecycle";

import type { ResultStore } from "./contracts/result-store.js";
import type { ResultEntry, ResultManifest } from "../domain/result-manifest.js";

function checksum(content: string): string {
  let hash = 0;
  for (const character of content)
    hash = (Math.imul(hash, 31) + character.charCodeAt(0)) | 0;
  return `synthetic-${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

export interface ResultManagementService {
  finalize(
    attemptId: string,
    executionId: string | undefined,
    files: readonly (SyntheticResultFile & { readonly location?: string })[],
  ): ResultManifest;
  get(attemptId: string): ResultManifest | undefined;
}

export function createResultManagementService(
  store: ResultStore,
  gates: () => OperationGateSet,
): ResultManagementService {
  const service: ResultManagementService = {
    finalize(attemptId, executionId, files) {
      const prior = store.getByAttempt(attemptId);
      if (prior !== undefined) return prior;
      assertGateOpen(gates(), "result_finalize");
      const entries: readonly ResultEntry[] = Object.freeze(
        [...files]
          .sort((left, right) => left.path.localeCompare(right.path))
          .map((file) =>
            Object.freeze({
              checksum: checksum(file.content),
              location:
                file.location ??
                `file://synthetic-results/${attemptId}/${file.path}`,
              path: file.path,
              sizeBytes: Buffer.byteLength(file.content),
            }),
          ),
      );
      return store.create(
        Object.freeze({
          attemptId,
          complete: true,
          entries,
          ...(executionId === undefined ? {} : { executionId }),
          resultManifestId: `manifest-${attemptId.slice("attempt-".length)}`,
          retentionClass: "synthetic-ephemeral",
          retentionState: "active",
          version: 1,
        }),
      );
    },
    get: (attemptId) => store.getByAttempt(attemptId),
  };
  return Object.freeze(service);
}
