import { createHash } from "node:crypto";

import type { MutationFence } from "@workload-funnel/kernel";
import type {
  LocalReceiptInventoryPage,
  LocalReceiptInventoryProvider,
} from "@workload-funnel/node-execution/local-receipt-recovery";
import type { FilesystemSealBoundary } from "@workload-funnel/result-sealer/filesystem-seal-boundary";
import type { SealAuthorityRegistry } from "@workload-funnel/result-sealer/seal-authority-registry";

export interface ResultSealerRecovery extends LocalReceiptInventoryProvider {
  recover(
    authorization: Parameters<FilesystemSealBoundary["seal"]>[0],
  ): ReturnType<FilesystemSealBoundary["seal"]>;
}

function fenceFor(
  request: Parameters<FilesystemSealBoundary["seal"]>[0],
): MutationFence {
  return request.claims.mutationFence;
}

export function createProvider(
  input: Readonly<{
    boundary: FilesystemSealBoundary;
    registry: SealAuthorityRegistry;
  }>,
): ResultSealerRecovery {
  return Object.freeze({
    inventory(
      cursor: number | undefined,
      limit: number,
    ): LocalReceiptInventoryPage {
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
        throw new Error("invalid_receipt_inventory_limit");
      const start = cursor ?? 0;
      if (!Number.isSafeInteger(start) || start < 0)
        throw new Error("invalid_receipt_inventory_cursor");
      const all = input.registry.receiptInventory();
      const selected = all
        .filter((item) => item.sequence > start)
        .slice(0, limit);
      const last = selected.at(-1);
      return Object.freeze({
        items: Object.freeze(
          selected.map(({ receipt, sequence }) => {
            const receiptPayload = JSON.stringify(receipt);
            return Object.freeze({
              operationId: receipt.operationId,
              receiptDigest: createHash("sha256")
                .update(receiptPayload)
                .digest("hex"),
              receiptPayload,
              sequence,
            });
          }),
        ),
        ...(last !== undefined &&
        all.some((item) => item.sequence > last.sequence)
          ? { nextCursor: last.sequence }
          : {}),
        protocolVersion: 1,
      });
    },
    recover(authorization: Parameters<FilesystemSealBoundary["seal"]>[0]) {
      if (fenceFor(authorization).desiredEffect !== "seal_output")
        throw new Error("invalid_recovery_effect");
      return input.boundary.seal(authorization);
    },
  });
}

export type SealAuthorityProvider = ResultSealerRecovery;
