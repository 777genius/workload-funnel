export {
  RUNTIME_BROKER_CONTRACT_VERSION,
  type RuntimeAuthorityCloseAckV1,
  type RuntimeAuthorityCloseRequestV1,
  type RuntimeAuthorityInstallAckV1,
  type RuntimeAuthorityInstallRequestV1,
  type RuntimeBrokerCapabilitiesV1,
  type RuntimeBrokerClientV1,
  type RuntimeFinalMutatorSetV1,
  type RuntimeFinalMutatorV1,
  type RuntimeMutationRequestV1,
  type RuntimeOperationReceiptV1,
} from "./application/contracts/runtime-broker-client.js";
export type {
  DurableRuntimeOperation,
  RuntimeOperationStore,
} from "./application/contracts/runtime-operation-store.js";
export {
  DurableRuntimeDispatcher,
  type RuntimeDispatcherDependencies,
} from "./application/durable-runtime-dispatcher.js";
export {
  FilesystemRuntimeOperationStore,
  type FilesystemRuntimeOperationStoreConfig,
} from "./filesystem-runtime-operation-store.js";

import type { TargetOperationDispatcher } from "@workload-funnel/node-execution/process-lifecycle";

import {
  DurableRuntimeDispatcher,
  type RuntimeDispatcherDependencies,
} from "./application/durable-runtime-dispatcher.js";

export function createProvider(
  dependencies: RuntimeDispatcherDependencies,
): TargetOperationDispatcher {
  return Object.freeze(new DurableRuntimeDispatcher(dependencies));
}
