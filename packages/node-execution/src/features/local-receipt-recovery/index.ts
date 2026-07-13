export const LOCAL_RECEIPT_PROTOCOL = 1 as const;

export interface LocalReceiptInventoryItem {
  readonly operationId: string;
  readonly receiptDigest: string;
  readonly receiptPayload: string;
  readonly sequence: number;
}

export interface LocalReceiptInventoryPage {
  readonly items: readonly LocalReceiptInventoryItem[];
  readonly nextCursor?: number;
  readonly protocolVersion: typeof LOCAL_RECEIPT_PROTOCOL;
}

export interface LocalReceiptInventoryProvider {
  inventory(
    cursor: number | undefined,
    limit: number,
  ): LocalReceiptInventoryPage;
}

export interface UnixReceiptPeerIdentity {
  readonly transport: "unix";
  readonly uid: number;
  readonly gid: number;
  readonly pid: number;
}

export interface FeatureApi {
  readonly protocolVersion: typeof LOCAL_RECEIPT_PROTOCOL;
}

export function createProvider(): FeatureApi {
  return Object.freeze({ protocolVersion: LOCAL_RECEIPT_PROTOCOL });
}
