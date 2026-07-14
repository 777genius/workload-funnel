import type { NodeSnapshot } from "../../domain/node-snapshot.js";

export interface NodeStore {
  get(nodeId: string): NodeSnapshot | undefined;
  create(node: NodeSnapshot): NodeSnapshot;
  compareAndSet(
    nodeId: string,
    expectedVersion: number,
    next: NodeSnapshot,
  ): NodeSnapshot;
}
