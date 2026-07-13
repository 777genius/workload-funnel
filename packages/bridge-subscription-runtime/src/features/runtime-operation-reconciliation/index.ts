export type { RuntimeReconciliationClient } from "./application/contracts/reconciliation-client.js";
export type {
  RuntimeObservationPage,
  RuntimeReconciliationStore,
} from "./application/contracts/reconciliation-store.js";
export {
  FilesystemRuntimeReconciliationStore,
  type FilesystemRuntimeReconciliationStoreConfig,
} from "./filesystem-reconciliation-store.js";
export {
  DurableRuntimeReconciler,
  type RuntimeReconcilerDependencies,
} from "./application/runtime-reconciler.js";

import type { TargetReconciler } from "@workload-funnel/node-execution/process-lifecycle";

import {
  DurableRuntimeReconciler,
  type RuntimeReconcilerDependencies,
} from "./application/runtime-reconciler.js";

export function createProvider(
  dependencies: RuntimeReconcilerDependencies,
): TargetReconciler {
  return Object.freeze(new DurableRuntimeReconciler(dependencies));
}
