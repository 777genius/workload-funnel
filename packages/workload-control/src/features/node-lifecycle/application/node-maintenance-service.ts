import type { NodeMaintenanceStore } from "./contracts/node-maintenance-store.js";
import type { NodeStore } from "./contracts/node-store.js";
import {
  advanceNodeMaintenance,
  createNodeMaintenanceOperation,
  NodeMaintenanceError,
  type NodeExecutionDrainObservation,
  type NodeExecutionIdentity,
  type NodeExecutionInventoryReceipt,
  type NodeMaintenanceClaim,
  type NodeMaintenanceKind,
  type NodeMaintenanceOperation,
} from "../domain/node-maintenance.js";
import {
  recordNodeRebootObservation,
  transitionNodeScheduling,
  type NodeObservation,
  type PressureHysteresisPolicy,
} from "../domain/node-snapshot.js";

export interface NodeMaintenanceEnvironment {
  inventory(nodeId: string): NodeExecutionInventoryReceipt;
  verifyInventoryReceipt(
    receipt: NodeExecutionInventoryReceipt,
    now: number,
  ): boolean;
  verifyDrainProof(
    observation: NodeExecutionDrainObservation,
    now: number,
  ): boolean;
  requestStop(
    input: Readonly<{
      operationId: string;
      nodeId: string;
      execution: NodeExecutionDrainObservation;
    }>,
  ): string;
  requestReboot(
    input: Readonly<{
      operationId: string;
      nodeId: string;
      expectedBootEpoch: string;
    }>,
  ): string;
}

export interface NodeMaintenanceService {
  begin(
    input: Readonly<{
      operationId: string;
      nodeId: string;
      kind: NodeMaintenanceKind;
      requestedBy: string;
      reason: string;
    }>,
  ): NodeMaintenanceOperation;
  claim(
    operationId: string,
    claimantId: string,
    expectedClaimFence: number,
    now: number,
    leaseUntil: number,
  ): NodeMaintenanceOperation;
  resume(
    operationId: string,
    claim: NodeMaintenanceClaim,
    now: number,
  ): NodeMaintenanceOperation;
  recordReboot(
    input: Readonly<{
      operationId: string;
      claim: NodeMaintenanceClaim;
      now: number;
      observation: NodeObservation;
      pressurePolicy: PressureHysteresisPolicy;
    }>,
  ): NodeMaintenanceOperation;
  discoverIncomplete(limit: number): readonly NodeMaintenanceOperation[];
}

function inventoryDigest(inventory: NodeExecutionInventoryReceipt): string {
  return `${inventory.receiptId}:${inventory.evidenceDigest}:${inventory.executions
    .map(
      (item) =>
        `${item.executionId}:${item.executionGeneration}:${item.nodeBootEpoch}:${item.state}:${String(item.observedSequence)}`,
    )
    .sort()
    .join("|")}`;
}

function executionIdentity(
  observation: NodeExecutionDrainObservation,
): NodeExecutionIdentity {
  return Object.freeze({
    allocationId: observation.allocationId,
    executionGeneration: observation.executionGeneration,
    executionId: observation.executionId,
    nodeBootEpoch: observation.nodeBootEpoch,
  });
}

function assertInventory(
  environment: NodeMaintenanceEnvironment,
  operation: NodeMaintenanceOperation,
  receipt: NodeExecutionInventoryReceipt,
  now: number,
): void {
  if (
    receipt.nodeId !== operation.nodeId ||
    receipt.nodeBootEpoch !== operation.originalBootEpoch ||
    !receipt.complete ||
    !receipt.durable ||
    !Number.isSafeInteger(receipt.inventoryRevision) ||
    receipt.inventoryRevision < 1 ||
    now < receipt.issuedAt ||
    now >= receipt.notAfter ||
    !/^[a-f0-9]{64}$/u.test(receipt.evidenceDigest) ||
    !environment.verifyInventoryReceipt(receipt, now)
  )
    throw new NodeMaintenanceError("node_inventory_receipt_invalid");
  const ids = new Set<string>();
  for (const item of receipt.executions) {
    if (
      item.nodeBootEpoch !== operation.originalBootEpoch ||
      ids.has(item.executionId)
    )
      throw new NodeMaintenanceError("node_inventory_identity_conflict");
    ids.add(item.executionId);
  }
}

function mergeRetainedExecutions(
  retained: readonly NodeExecutionIdentity[],
  inventory: readonly NodeExecutionDrainObservation[],
): readonly NodeExecutionIdentity[] {
  const byId = new Map(retained.map((item) => [item.executionId, item]));
  for (const observation of inventory) {
    const identity = executionIdentity(observation);
    const prior = byId.get(identity.executionId);
    if (
      prior !== undefined &&
      JSON.stringify(prior) !== JSON.stringify(identity)
    )
      throw new NodeMaintenanceError("node_inventory_identity_conflict");
    byId.set(identity.executionId, identity);
  }
  return Object.freeze(
    [...byId.values()].sort((left, right) =>
      left.executionId.localeCompare(right.executionId),
    ),
  );
}

function resolvedExecutions(
  environment: NodeMaintenanceEnvironment,
  retained: readonly NodeExecutionIdentity[],
  previouslyResolved: readonly string[],
  inventory: readonly NodeExecutionDrainObservation[],
  now: number,
): readonly string[] {
  const observations = new Map(
    inventory.map((item) => [item.executionId, item]),
  );
  const resolved = new Set(previouslyResolved);
  for (const identity of retained) {
    const observation = observations.get(identity.executionId);
    if (observation === undefined) continue;
    if (
      JSON.stringify(executionIdentity(observation)) !==
      JSON.stringify(identity)
    )
      throw new NodeMaintenanceError("node_inventory_identity_conflict");
    if (
      resolved.has(identity.executionId) &&
      !["terminal", "proven_absent"].includes(observation.state)
    )
      throw new NodeMaintenanceError("node_execution_reappeared_after_proof");
    if (["terminal", "proven_absent"].includes(observation.state)) {
      if (
        observation.proof?.executionId !== identity.executionId ||
        observation.proof.executionGeneration !==
          identity.executionGeneration ||
        observation.proof.allocationId !== identity.allocationId ||
        observation.proof.nodeBootEpoch !== identity.nodeBootEpoch ||
        observation.proof.durableSequence < 1 ||
        now < observation.proof.issuedAt ||
        now >= observation.proof.notAfter ||
        !/^[a-f0-9]{64}$/u.test(observation.proof.evidenceDigest) ||
        !environment.verifyDrainProof(observation, now)
      )
        throw new NodeMaintenanceError("node_execution_proof_invalid");
      resolved.add(identity.executionId);
    }
  }
  return Object.freeze([...resolved].sort());
}

export function createNodeMaintenanceService(
  nodes: NodeStore,
  operations: NodeMaintenanceStore,
  environment: NodeMaintenanceEnvironment,
): NodeMaintenanceService {
  function getOperation(operationId: string): NodeMaintenanceOperation {
    const operation = operations.get(operationId);
    if (operation === undefined)
      throw new NodeMaintenanceError("node_maintenance_not_found");
    return operation;
  }
  function assertClaim(
    operation: NodeMaintenanceOperation,
    claim: NodeMaintenanceClaim,
    now: number,
  ): void {
    if (
      operation.claim?.claimFence !== claim.claimFence ||
      operation.claim.claimantId !== claim.claimantId ||
      operation.claim.leaseUntil !== claim.leaseUntil ||
      claim.leaseUntil <= now
    )
      throw new NodeMaintenanceError("stale_node_maintenance_claim");
  }
  function save(
    before: NodeMaintenanceOperation,
    after: NodeMaintenanceOperation,
    claim: NodeMaintenanceClaim,
    now: number,
  ): NodeMaintenanceOperation {
    return operations.compareAndSet(before.version, after, claim, now);
  }
  const service: NodeMaintenanceService = {
    begin(input) {
      const node = nodes.get(input.nodeId);
      if (node === undefined) throw new NodeMaintenanceError("node_not_found");
      const prior = operations.get(input.operationId);
      if (prior !== undefined) {
        if (
          prior.nodeId !== input.nodeId ||
          prior.kind !== input.kind ||
          prior.requestedBy !== input.requestedBy ||
          prior.reason !== input.reason
        )
          throw new NodeMaintenanceError("node_maintenance_operation_conflict");
        return prior;
      }
      return operations.create(
        createNodeMaintenanceOperation({
          kind: input.kind,
          nodeId: input.nodeId,
          operationId: input.operationId,
          originalBootEpoch: node.bootEpoch,
          reason: input.reason,
          requestedBy: input.requestedBy,
        }),
      );
    },
    claim: (operationId, claimantId, expectedClaimFence, now, leaseUntil) =>
      operations.claim(
        operationId,
        claimantId,
        expectedClaimFence,
        now,
        leaseUntil,
      ),
    resume(operationId, claim, now) {
      const before = getOperation(operationId);
      assertClaim(before, claim, now);
      const node = nodes.get(before.nodeId);
      if (node === undefined) throw new NodeMaintenanceError("node_not_found");
      switch (before.step) {
        case "requested": {
          const cordoned =
            node.state === "cordoned" || node.state === "draining"
              ? node
              : transitionNodeScheduling(node, node.version, "cordoned");
          if (cordoned !== node)
            nodes.compareAndSet(node.nodeId, node.version, cordoned);
          return save(
            before,
            advanceNodeMaintenance(before, "cordoned", {
              evidenceDigest: `node-version:${String(cordoned.version)}`,
            }),
            claim,
            now,
          );
        }
        case "cordoned": {
          const draining =
            node.state === "draining"
              ? node
              : transitionNodeScheduling(node, node.version, "draining");
          if (draining !== node)
            nodes.compareAndSet(node.nodeId, node.version, draining);
          const inventory = environment.inventory(node.nodeId);
          assertInventory(environment, before, inventory, now);
          for (const execution of inventory.executions) {
            if (["active", "stop_requested"].includes(execution.state))
              environment.requestStop({
                execution,
                nodeId: node.nodeId,
                operationId: before.operationId,
              });
          }
          const retained = mergeRetainedExecutions([], inventory.executions);
          const resolved = resolvedExecutions(
            environment,
            retained,
            [],
            inventory.executions,
            now,
          );
          const pending = retained
            .filter((item) => !resolved.includes(item.executionId))
            .map((item) => item.executionId);
          return save(
            before,
            advanceNodeMaintenance(before, "drain_requested", {
              evidenceDigest: inventoryDigest(inventory),
              inventoryRevisions: [inventory.inventoryRevision],
              pendingExecutionIds: pending,
              retainedExecutions: retained,
              resolvedExecutionIds: resolved,
            }),
            claim,
            now,
          );
        }
        case "drain_requested":
        case "waiting_for_quiescence": {
          const inventory = environment.inventory(node.nodeId);
          assertInventory(environment, before, inventory, now);
          const retained = mergeRetainedExecutions(
            before.retainedExecutions,
            inventory.executions,
          );
          const resolved = resolvedExecutions(
            environment,
            retained,
            before.resolvedExecutionIds,
            inventory.executions,
            now,
          );
          const pending = retained.filter(
            (item) => !resolved.includes(item.executionId),
          );
          for (const execution of inventory.executions) {
            if (execution.state === "active")
              environment.requestStop({
                execution,
                nodeId: node.nodeId,
                operationId: before.operationId,
              });
          }
          const inventoryRevisions = [
            ...new Set([
              ...before.inventoryRevisions,
              inventory.inventoryRevision,
            ]),
          ];
          const stableEmpty =
            retained.length > 0 || inventoryRevisions.length >= 2;
          const next =
            pending.length === 0 && stableEmpty
              ? "drained"
              : "waiting_for_quiescence";
          return save(
            before,
            advanceNodeMaintenance(before, next, {
              evidenceDigest: inventoryDigest(inventory),
              inventoryRevisions,
              pendingExecutionIds: pending.map((item) => item.executionId),
              retainedExecutions: retained,
              resolvedExecutionIds: resolved,
            }),
            claim,
            now,
          );
        }
        case "drained": {
          if (before.kind === "drain")
            return save(
              before,
              advanceNodeMaintenance(before, "completed", {
                evidenceDigest: "drain-complete",
              }),
              claim,
              now,
            );
          const rebootEvidence = environment.requestReboot({
            expectedBootEpoch: before.originalBootEpoch,
            nodeId: before.nodeId,
            operationId: before.operationId,
          });
          return save(
            before,
            advanceNodeMaintenance(before, "reboot_requested", {
              evidenceDigest: rebootEvidence,
            }),
            claim,
            now,
          );
        }
        case "reboot_observed":
        case "reconciliation_required": {
          const inventory = environment.inventory(node.nodeId);
          assertInventory(environment, before, inventory, now);
          const unresolved = inventory.executions.filter(
            (item) =>
              item.nodeBootEpoch === before.originalBootEpoch &&
              (!["terminal", "proven_absent"].includes(item.state) ||
                item.proof === undefined ||
                !environment.verifyDrainProof(item, now)),
          );
          return save(
            before,
            advanceNodeMaintenance(
              before,
              unresolved.length === 0 ? "completed" : "reconciliation_required",
              {
                evidenceDigest: inventoryDigest(inventory),
                reconciliationExecutionIds: unresolved.map(
                  (item) => item.executionId,
                ),
              },
            ),
            claim,
            now,
          );
        }
        case "reboot_requested":
          throw new NodeMaintenanceError("reboot_observation_required");
        case "completed":
          return before;
      }
    },
    recordReboot(input) {
      const before = getOperation(input.operationId);
      assertClaim(before, input.claim, input.now);
      if (
        before.kind === "reboot" &&
        ["reboot_observed", "reconciliation_required", "completed"].includes(
          before.step,
        ) &&
        before.observedBootEpoch === input.observation.bootEpoch
      )
        return before;
      if (before.kind !== "reboot" || before.step !== "reboot_requested")
        throw new NodeMaintenanceError("reboot_not_requested");
      const node = nodes.get(before.nodeId);
      if (node === undefined) throw new NodeMaintenanceError("node_not_found");
      let rebooted = node;
      if (node.bootEpoch === before.originalBootEpoch) {
        rebooted = recordNodeRebootObservation(
          node,
          node.version,
          input.observation,
          input.pressurePolicy,
        );
        nodes.compareAndSet(node.nodeId, node.version, rebooted);
      } else if (node.bootEpoch !== input.observation.bootEpoch) {
        throw new NodeMaintenanceError("reboot_prior_epoch_mismatch");
      }
      return save(
        before,
        advanceNodeMaintenance(before, "reboot_observed", {
          evidenceDigest: `boot-epoch:${rebooted.bootEpoch}`,
          observedBootEpoch: rebooted.bootEpoch,
        }),
        input.claim,
        input.now,
      );
    },
    discoverIncomplete: (limit) => operations.discoverIncomplete(limit),
  };
  return Object.freeze(service);
}
