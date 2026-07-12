export type { Execution, ExecutorObservation } from "./domain/execution.js";
export {
  InvalidExecutionTransitionError,
  mapTerminalExecutionToAttempt,
  supersedeExecution,
  transitionExecution,
  type ExecutionTerminalPolicy,
} from "./domain/execution-machine.js";
export type { ExecutionStore } from "./application/contracts/execution-store.js";
export {
  compareMutationFence,
  fingerprintMutationFence,
  serializeMutationFence,
  type DesiredEffect,
  type FenceAuthoritySnapshot,
  type FenceComparisonResult,
  type MutationFence,
} from "./domain/mutation-fence.js";
export {
  comparisonFieldsForFence,
  createEffectReceipt,
  isFinalZeroMutationSupersession,
  type EffectOutcome,
  type EffectReceiptEvidence,
} from "./domain/effect-receipt.js";
export {
  handleConditionalEffect,
  type ConditionalEffectAdapter,
  type ConditionalEffectCommand,
  type EffectReceiptStore,
} from "./application/conditional-effect-handler.js";
export {
  createDeterministicExecutor,
  type DeterministicExecutor,
} from "./application/deterministic-executor.js";
