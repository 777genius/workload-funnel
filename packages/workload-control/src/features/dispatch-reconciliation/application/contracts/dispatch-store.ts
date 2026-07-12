import type { Dispatch, DispatchMapping } from "../../domain/dispatch.js";

export interface DispatchStore {
  create(dispatch: Dispatch, mapping: DispatchMapping): Dispatch;
  getByAllocation(allocationId: string): Dispatch | undefined;
  save(dispatch: Dispatch): void;
  mapping(dispatchId: string): DispatchMapping | undefined;
}
