import { generateKeyPairSync } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createProvider as createRuntimeCapabilityProvider } from "@workload-funnel/bridge-subscription-runtime/runtime-capability-discovery";
import {
  DurableRuntimeDispatcher,
  FilesystemRuntimeOperationStore,
} from "@workload-funnel/bridge-subscription-runtime/runtime-operation-dispatch";
import { createProvider as createRuntimeResultTranslator } from "@workload-funnel/bridge-subscription-runtime/runtime-result-translation";
import { createCapacityObservationClient } from "@workload-funnel/client-sdk/capacity-observation";
import { createResultAccessClient } from "@workload-funnel/client-sdk/result-access";
import { createWorkloadObservationClient } from "@workload-funnel/client-sdk/workload-observation";
import { createWorkloadSubmissionClient } from "@workload-funnel/client-sdk/workload-submission";
import { openSqliteArtifactMutationAuthorityStore } from "@workload-funnel/artifact-store-object/stage-upload";
import { createProvider as createFilesystemStageWriter } from "@workload-funnel/artifact-store-filesystem/stage-write";
import { createProvider as createFilesystemVerifier } from "@workload-funnel/artifact-store-filesystem/verify-finalize";
import { compareMutationFence } from "@workload-funnel/kernel";
import {
  DurableObservationSpool,
  FilesystemObservationSpoolStorage,
} from "@workload-funnel/node-execution/observation-spooling";
import {
  applySealOutputReceipt,
  handleConditionalEffect,
  requestSealOutput,
  type EffectReceiptEvidence,
} from "@workload-funnel/workload-control/execution-reconciliation";
import {
  createProvider as createResultStagingReporter,
  type ArtifactStageCommand,
} from "@workload-funnel/node-execution/result-staging-reporting";
import {
  createSealOutputClaims,
  signSealOutputRequest,
} from "@workload-funnel/node-execution/result-sealing-coordination";
import {
  createLinuxDescriptorSealFilesystem,
  deterministicOutputName,
  FilesystemSealBoundary,
} from "@workload-funnel/result-sealer/filesystem-seal-boundary";
import {
  FilesystemSealerWalStorage,
  SealAuthorityRegistry,
  SealerWal,
} from "@workload-funnel/result-sealer/seal-authority-registry";
import {
  createArtifactProviderSet,
  createDurableArtifactMutationAuthority,
  verifyAndFinalizeStagedResult,
  type ResultManifest,
} from "@workload-funnel/workload-control/result-management";
import type { WorkloadSpec } from "@workload-funnel/workload-control/workload-lifecycle";

import { createProductHarness } from "./product-harness.js";
import {
  authoritySnapshot,
  compileNativeHelper,
  consumeEvent,
  digest,
  resultFence,
  runtimeEvent,
  runtimeIntent,
} from "./synthetic-lifecycle-fixtures.js";
import { signRuntimeAuthorityGrant } from "./runtime-authority-signing.js";
import { SyntheticRuntimeBroker } from "./synthetic-runtime-broker.js";
import { TrustedSyntheticLauncher } from "./trusted-synthetic-launcher.js";
import { exerciseTrustedLauncherFenceMatrix } from "./trusted-launcher-fence-matrix.js";

let helperRoot = "";
let artifactHelper = "";
let sealerHelper = "";

beforeAll(async () => {
  helperRoot = await mkdtemp(join(tmpdir(), "wf-full-lifecycle-helpers-"));
  artifactHelper = join(helperRoot, "artifact-boundary");
  sealerHelper = join(helperRoot, "sealer-boundary");
  const source = resolve(process.cwd(), "native/linux-descriptor-fs.c");
  compileNativeHelper(source, artifactHelper, "artifact");
  compileNativeHelper(source, sealerHelper, "sealer");
});

afterAll(async () => rm(helperRoot, { force: true, recursive: true }));

describe("full synthetic WorkloadFunnel product lifecycle E2E", () => {
  it("crosses public admission, runtime/launcher, result boundaries, restarts, fences, and public terminal reads", async () => {
    const root = await mkdtemp(join(tmpdir(), "wf-full-lifecycle-e2e-"));
    try {
      const harness = createProductHarness();
      const submission = createWorkloadSubmissionClient(
        harness.transport,
        "synthetic-tenant",
      );
      const observation = createWorkloadObservationClient(
        harness.transport,
        "synthetic-tenant",
      );
      const results = createResultAccessClient(
        harness.transport,
        "synthetic-tenant",
      );
      const capacity = createCapacityObservationClient(
        harness.transport,
        "synthetic-tenant",
      );
      const spec: WorkloadSpec = Object.freeze({
        command: Object.freeze(["synthetic", "full-lifecycle"]),
        processProfile: "trusted-synthetic-v1",
        resources: Object.freeze({ cpuMillis: 250, memoryMiB: 128 }),
        resultFiles: Object.freeze([
          Object.freeze({ content: "lifecycle-result", path: "result.txt" }),
        ]),
        schemaVersion: 1,
        syntheticOutcome: "succeeded",
      });
      const mutation = Object.freeze({
        correlationId: "full-lifecycle-correlation",
        idempotencyKey: "full-lifecycle-submit",
        requestId: "full-lifecycle-request",
      });
      const accepted = await submission.submit(spec, mutation);
      harness.restart();
      const duplicate = await submission.submit(spec, mutation);
      expect(duplicate).toEqual(accepted);
      expect(harness.database.state.workloadById.size).toBe(1);
      expect(harness.database.state.runById.size).toBe(1);
      expect(
        (await observation.workload(accepted.runId)).attempt.attemptId,
      ).toBe(accepted.attemptId);
      expect((await observation.explanation(accepted.runId)).reason).toBe(
        "admissible",
      );
      for (let steps = 0; steps < 10; steps += 1) {
        if (
          harness.service.status(accepted.runId)?.attempt.state === "admitted"
        )
          break;
        expect(harness.service.step()).toBe(true);
      }
      expect(harness.service.status(accepted.runId)?.attempt.state).toBe(
        "admitted",
      );
      expect(harness.service.step()).toBe(true);
      let status = harness.service.status(accepted.runId);
      if (status === undefined) throw new Error("accepted_run_missing");
      expect(status.attempt.state).toBe("dispatching");
      expect(harness.database.state.localDispatchEffects.size).toBe(1);
      const runtimeContext = harness.service.runtimeContext(accepted.runId);
      const { allocation, processFence } = runtimeContext;
      const dispatchId = runtimeContext.attempt.dispatchId;
      if (dispatchId === undefined)
        throw new Error("canonical_dispatch_missing");
      const launcher = new TrustedSyntheticLauncher(join(root, "launcher-wal"));
      const runtimeAuthorityKeys = generateKeyPairSync("ed25519");
      const brokerInput = {
        directory: join(root, "runtime-broker"),
        launcher,
        trustedAuthorityKeys: new Map([
          ["full-lifecycle-runtime-authority", runtimeAuthorityKeys.publicKey],
        ]),
      } as const;
      let broker = new SyntheticRuntimeBroker(brokerInput);
      const capability = await createRuntimeCapabilityProvider(broker).discover(
        "synthetic-runtime-target",
        "start",
        "runtime",
      );
      expect(capability.status).toBe("capable");
      let dispatcher = new DurableRuntimeDispatcher({
        client: broker,
        store: new FilesystemRuntimeOperationStore({
          capacity: 20,
          directory: join(root, "runtime-operations"),
        }),
      });
      const closed = await dispatcher.closeAuthority({
        changeId: "runtime-authority-install",
        effectScopeKey: processFence.effectScopeKey,
        targetId: "synthetic-runtime-target",
      });
      const grant = signRuntimeAuthorityGrant(
        processFence,
        closed.changeId,
        "synthetic-runtime-target",
        runtimeAuthorityKeys.privateKey,
      );
      const installed = await dispatcher.installAuthority({
        closeAcknowledgement: closed,
        grant,
      });
      await dispatcher.reopenAuthority(installed);
      const intent = runtimeIntent(processFence, accepted.attemptId);
      const runtimeReceipt = await dispatcher.dispatch(intent);
      if (runtimeReceipt.state === "unknown") {
        throw new Error("runtime_start_unknown");
      }
      expect(runtimeReceipt).toMatchObject({
        operationId: `runtime-start-${accepted.attemptId}`,
        runtimeOperationId: `runtime-runtime-start-${accepted.attemptId}`,
        state: "running",
      });
      expect(await dispatcher.dispatch(intent)).toEqual(runtimeReceipt);
      expect(broker.finalMutationAttempts).toBe(1);
      expect(broker.externalStartCount).toBe(1);
      broker = new SyntheticRuntimeBroker(brokerInput);
      dispatcher = new DurableRuntimeDispatcher({
        client: broker,
        store: new FilesystemRuntimeOperationStore({
          capacity: 20,
          directory: join(root, "runtime-operations"),
        }),
      });
      expect(await dispatcher.dispatch(intent)).toEqual(runtimeReceipt);
      expect(broker.finalMutationAttempts).toBe(1);
      const launcherReplay = launcher.start(processFence);
      launcher.restart();
      expect(launcher.start(processFence)).toEqual(launcherReplay);
      expect(broker.externalStartCount).toBe(1);
      const staleReceipt = await dispatcher.dispatch(
        runtimeIntent(
          Object.freeze({ ...processFence, expectedDesiredVersion: 0 }),
          "stale-desired",
        ),
      );
      const mismatchReceipt = await dispatcher.dispatch(
        runtimeIntent(
          Object.freeze({
            ...processFence,
            clusterIncarnation: "equal-version-different-cluster",
          }),
          "equal-mismatch",
        ),
      );
      expect(staleReceipt).toMatchObject({
        operationId: "runtime-start-stale-desired",
        rejectionCode: "authority_rejected",
        state: "rejected",
      });
      expect(mismatchReceipt).toMatchObject({
        operationId: "runtime-start-equal-mismatch",
        rejectionCode: "authority_rejected",
        state: "rejected",
      });
      expect(broker.finalMutationAttempts).toBe(3);
      expect(broker.externalStartCount).toBe(1);
      const launcherFenceMatrix = exerciseTrustedLauncherFenceMatrix(
        join(root, "negative-launcher-wal"),
        processFence,
      );
      for (const rejected of [
        launcherFenceMatrix.stale,
        launcherFenceMatrix.lower,
        launcherFenceMatrix.missing,
        launcherFenceMatrix.mismatch,
      ]) {
        expect(rejected).toMatchObject({ ok: false });
      }
      expect(launcherFenceMatrix.externalStartCount()).toBe(0);
      expect(harness.service.step()).toBe(true);
      status = harness.service.status(accepted.runId);
      if (status === undefined) throw new Error("running_status_missing");
      expect(status.attempt.state).toBe("running");
      expect(status.attempt.executionId).toBe(
        `execution-${accepted.attemptId.slice(8)}`,
      );
      const execution = harness.service.runtimeContext(
        accepted.runId,
      ).execution;
      if (execution === undefined)
        throw new Error("canonical_execution_missing");
      const unknown = await consumeEvent(
        runtimeEvent(runtimeReceipt, "unknown"),
      );
      const contradiction = await consumeEvent(
        runtimeEvent(runtimeReceipt, "exited", {
          completedAtMs: 2_000,
          exitCode: 2,
          outcome: "succeeded",
          resultDigest: digest("contradictory-result"),
        }),
      );
      expect(unknown).toMatchObject({ state: "unknown" });
      expect(contradiction).toMatchObject({
        quarantineReason: "runtime_terminal_success_contradiction_quarantined",
        state: "quarantined",
      });
      if (unknown.state !== "unknown" || contradiction.state !== "quarantined")
        throw new Error("runtime_terminal_classification_missing");
      if (runtimeReceipt.runtimeOperationId === undefined) {
        throw new Error("runtime_receipt_identity_missing");
      }
      const terminalBinding = Object.freeze({
        expectedOperationId: intent.ticket.operationId,
        observationRuntimeOperationId: runtimeReceipt.runtimeOperationId,
        receiptMutationFenceFingerprint:
          runtimeReceipt.mutationFenceFingerprint,
        receiptOperationId: runtimeReceipt.operationId,
        receiptRuntimeOperationId: runtimeReceipt.runtimeOperationId,
        runId: accepted.runId,
      });
      expect(
        harness.service.reconcileRuntimeTerminal({
          ...terminalBinding,
          classification: unknown.state,
          observationOperationId: unknown.operationId,
        }),
      ).toMatchObject({
        disposition: "nonterminal",
        execution: { state: "running" },
      });
      expect(
        harness.service.reconcileRuntimeTerminal({
          ...terminalBinding,
          classification: contradiction.state,
          observationOperationId: contradiction.operationId,
        }),
      ).toMatchObject({
        disposition: "quarantined",
        execution: { state: "running" },
      });
      expect(harness.service.status(accepted.runId)?.attempt.state).toBe(
        "running",
      );
      expect(
        harness.service.runtimeContext(accepted.runId).execution?.state,
      ).toBe("running");
      harness.restart();
      const completed = await consumeEvent(
        runtimeEvent(runtimeReceipt, "exited", {
          completedAtMs: 2_100,
          exitCode: 0,
          outcome: "succeeded",
          resultDigest: digest("trusted-runtime-result"),
        }),
      );
      if (completed.terminal === undefined)
        throw new Error("trusted_runtime_terminal_missing");
      const translated = createRuntimeResultTranslator().translateTerminal(
        completed.terminal,
      );
      expect(completed).toMatchObject({
        operationId: runtimeReceipt.operationId,
        runtimeOperationId: runtimeReceipt.runtimeOperationId,
        state: "exited",
      });
      expect(translated.classification).toBe("succeeded");
      if (translated.classification !== "succeeded")
        throw new Error("trusted_runtime_success_missing");
      const terminalEvidence = Object.freeze({
        ...terminalBinding,
        classification: translated.classification,
        observationOperationId: completed.operationId,
      });
      const terminalDecision =
        harness.service.reconcileRuntimeTerminal(terminalEvidence);
      expect(terminalDecision).toMatchObject({
        disposition: "terminalized",
        execution: {
          allocationId: allocation.allocationId,
          attemptId: accepted.attemptId,
          executionGeneration: accepted.executionGeneration,
          state: "exited",
          terminalOutcome: "succeeded",
        },
      });
      status = harness.service.status(accepted.runId);
      if (status === undefined) throw new Error("terminal_status_missing");
      expect(status.attempt.state).toBe("publishing_results");
      const publishingVersion = status.attempt.version;
      harness.restart();
      expect(
        harness.service.reconcileRuntimeTerminal(terminalEvidence),
      ).toEqual(terminalDecision);
      status = harness.service.status(accepted.runId);
      if (status === undefined)
        throw new Error("replayed_terminal_status_missing");
      expect(status.attempt.state).toBe("publishing_results");
      expect(status.attempt.version).toBe(publishingVersion);
      const outputRoot = join(root, "workload-output");
      const sealedRoot = join(root, "sealed-output");
      await mkdir(outputRoot, { mode: 0o700 });
      await mkdir(sealedRoot, { mode: 0o700 });
      const sealFence = resultFence(
        status.attempt,
        allocation,
        "seal_output",
        `seal-output:${execution.executionId}`,
      );
      const sealerKeys = generateKeyPairSync("ed25519");
      const sealClaims = createSealOutputClaims({
        allocationId: allocation.allocationId,
        attemptId: status.attempt.attemptId,
        audience: "workload-funnel-result-sealer",
        executionGeneration: status.attempt.executionGeneration,
        executionId: execution.executionId,
        expiresAtMs: 10_000,
        issuedAtMs: 1_000,
        issuer: "full-lifecycle-control",
        issuerKeyId: "full-lifecycle-sealer-key",
        mutationFence: sealFence,
        nodeBootEpoch: 1,
        nodeId: allocation.nodeId,
        operationId: `seal-${execution.executionId}`,
        outputContractDigest: digest("result.txt:text/plain"),
        quiescenceReceiptDigest: digest("runtime-exited"),
        sealProfileDigest: digest("trusted-seal-profile"),
        unitInvocationDigest: digest(launcherReplay.result.unitName),
      });
      const sourceName = deterministicOutputName(sealClaims);
      await mkdir(join(outputRoot, sourceName), { mode: 0o700 });
      await writeFile(
        join(outputRoot, sourceName, "result.txt"),
        "lifecycle-result",
        {
          flag: "wx",
          mode: 0o600,
        },
      );
      const descriptorFilesystem = createLinuxDescriptorSealFilesystem({
        expectedWorkloadUid: process.getuid?.() ?? 0,
        helperPath: sealerHelper,
        limits: {
          maxDepth: 8,
          maxEntries: 32,
          maxFileBytes: 1_024,
          maxTotalBytes: 4_096,
        },
        outputRoot,
        stagingRoot: sealedRoot,
      });
      const sealerWalDirectory = join(root, "sealer-wal");
      let sealRegistry = new SealAuthorityRegistry(
        new SealerWal(
          new FilesystemSealerWalStorage({
            capacity: 40,
            directory: sealerWalDirectory,
          }),
        ),
        new Map([["full-lifecycle-sealer-key", sealerKeys.publicKey]]),
        () => 1_500,
      );
      let sealBoundary = new FilesystemSealBoundary({
        expectedOutputParent: descriptorFilesystem.outputParent,
        expectedStagingParent: descriptorFilesystem.stagingParent,
        expectedWorkloadUid: process.getuid?.() ?? 0,
        filesystem: descriptorFilesystem,
        limits: {
          maxDepth: 8,
          maxEntries: 32,
          maxFileBytes: 1_024,
          maxTotalBytes: 4_096,
        },
        registry: sealRegistry,
      });
      const sealAuthorization = signSealOutputRequest(
        sealClaims,
        sealerKeys.privateKey,
      );
      sealRegistry.install("install-full-lifecycle-seal", sealAuthorization);
      const terminalExecution = harness.service.runtimeContext(
        accepted.runId,
      ).execution;
      if (terminalExecution === undefined)
        throw new Error("terminal_execution_missing");
      let executionWithSeal = requestSealOutput(terminalExecution, {
        mutationFence: sealFence,
        operationId: sealClaims.operationId,
        quiescenceReceiptDigest: sealClaims.quiescenceReceiptDigest,
      });
      const effectReceipts = new Map<string, EffectReceiptEvidence>();
      let sealReceipt: ReturnType<FilesystemSealBoundary["seal"]> | undefined;
      const sealEffect = handleConditionalEffect(
        { fence: sealFence, operationId: sealClaims.operationId },
        {
          id: "trusted-result-sealer",
          registrySequence: 1,
          snapshot: authoritySnapshot(sealFence),
        },
        1_500,
        {
          get: (operationId) => effectReceipts.get(operationId),
          save(receipt) {
            effectReceipts.set(receipt.operationId, receipt);
            return receipt;
          },
        },
        {
          apply() {
            const applied = sealBoundary.seal(sealAuthorization);
            sealReceipt = applied;
            return applied.outcome === "sealed" && applied.sealId !== undefined
              ? {
                  externalMappingOrInvocationId: applied.sealId,
                  outcome: "applied" as const,
                }
              : { outcome: "unknown" as const };
          },
        },
      );
      const sealedReceipt = sealReceipt;
      if (
        sealedReceipt?.outcome !== "sealed" ||
        sealedReceipt.sealId === undefined ||
        sealedReceipt.treeDigest === undefined
      )
        throw new Error("result_seal_missing");
      executionWithSeal = applySealOutputReceipt(executionWithSeal, {
        receipt: sealEffect,
        sealId: sealedReceipt.sealId,
        treeDigest: sealedReceipt.treeDigest,
      });
      expect(executionWithSeal.sealOutput?.sealId).toBe(sealedReceipt.sealId);
      expect(
        handleConditionalEffect(
          { fence: sealFence, operationId: sealClaims.operationId },
          {
            id: "trusted-result-sealer",
            registrySequence: 1,
            snapshot: authoritySnapshot(sealFence),
          },
          1_500,
          {
            get: (operationId) => effectReceipts.get(operationId),
            save: (receipt) => receipt,
          },
          { apply: () => ({ outcome: "unknown" }) },
        ),
      ).toEqual(sealEffect);
      sealRegistry = new SealAuthorityRegistry(
        new SealerWal(
          new FilesystemSealerWalStorage({
            capacity: 40,
            directory: sealerWalDirectory,
          }),
        ),
        new Map([["full-lifecycle-sealer-key", sealerKeys.publicKey]]),
        () => 1_500,
      );
      sealBoundary = new FilesystemSealBoundary({
        expectedOutputParent: descriptorFilesystem.outputParent,
        expectedStagingParent: descriptorFilesystem.stagingParent,
        expectedWorkloadUid: process.getuid?.() ?? 0,
        filesystem: descriptorFilesystem,
        limits: {
          maxDepth: 8,
          maxEntries: 32,
          maxFileBytes: 1_024,
          maxTotalBytes: 4_096,
        },
        registry: sealRegistry,
      });
      expect(sealBoundary.seal(sealAuthorization)).toEqual(sealedReceipt);
      expect(await readdir(sealedRoot)).toHaveLength(1);
      const destination = sealRegistry.state(sealClaims.operationId)?.evidence
        .destinationName;
      if (destination === undefined)
        throw new Error("sealed_destination_missing");
      const stageFence = resultFence(
        status.attempt,
        allocation,
        "artifact_stage",
        `artifact-stage:${execution.executionId}`,
      );
      const authorityPath = join(root, "artifact-authority.sqlite");
      let authorityStore =
        openSqliteArtifactMutationAuthorityStore(authorityPath);
      createDurableArtifactMutationAuthority(authorityStore.store).install({
        mutationFence: stageFence,
        now: 1_500,
        operationId: "install-full-lifecycle-stage",
        writerIdentity: "full-lifecycle-control",
      });
      authorityStore.close();
      authorityStore = openSqliteArtifactMutationAuthorityStore(authorityPath);
      const artifactRoot = join(root, "artifact-stage");
      const stageWriter = createFilesystemStageWriter({
        authority: createDurableArtifactMutationAuthority(authorityStore.store),
        nativeHelperPath: artifactHelper,
        nowMs: () => 1_500,
        root: artifactRoot,
        sealedReader: {
          read: (_sealId, path) =>
            readFile(join(sealedRoot, destination, path)),
        },
      });
      const spoolDirectory = join(root, "observation-spool");
      let spool = new DurableObservationSpool(
        new FilesystemObservationSpoolStorage({
          capacity: 20,
          directory: spoolDirectory,
        }),
      );
      const reporter = createResultStagingReporter({
        artifactStageWriter: stageWriter,
        nodeBootEpoch: 1,
        nodeId: allocation.nodeId,
        nowMs: () => 2_200,
        observationSpool: spool,
      });
      const stageCommand: ArtifactStageCommand = Object.freeze({
        allocationId: allocation.allocationId,
        attemptId: status.attempt.attemptId,
        entries: sealedReceipt.entries ?? Object.freeze([]),
        executionGeneration: status.attempt.executionGeneration,
        executionId: execution.executionId,
        manifestDigest: digest(
          JSON.stringify([sealedReceipt.treeDigest, sealedReceipt.entries]),
        ),
        mutationFence: stageFence,
        operationId: `stage-${execution.executionId}`,
        sealId: sealedReceipt.sealId,
        treeDigest: sealedReceipt.treeDigest,
        uploadIdentity: Object.freeze({
          allocationId: allocation.allocationId,
          canDelete: false,
          canList: false,
          canOverwrite: false,
          canRead: false,
          permissions: Object.freeze(["create"] as const),
          prefix: `${allocation.allocationId}/${status.attempt.executionGeneration}/`,
        }),
      });
      const staged = await reporter.stageAndReport(stageCommand);
      expect(await reporter.stageAndReport(stageCommand)).toEqual(staged);
      spool = new DurableObservationSpool(
        new FilesystemObservationSpoolStorage({
          capacity: 20,
          directory: spoolDirectory,
        }),
      );
      expect(spool.pending).toHaveLength(1);
      expect(spool.pending[0]?.eventId).toBe(staged.eventId);
      expect(await readdir(artifactRoot)).toHaveLength(1);

      const manifestId = `manifest-${accepted.attemptId.slice(8)}`;
      const stagingEvidence = Object.freeze({
        artifactProviderId: staged.providerId,
        attemptId: staged.attemptId,
        entries: staged.entries,
        executionId: staged.executionId,
        immutableStagingIdentity: staged.immutableStagingIdentity,
        manifestDigest: staged.manifestDigest,
        mutationFence: staged.mutationFence,
        mutationFenceFingerprint: staged.mutationFenceFingerprint,
        resultManifestId: manifestId,
        retentionClass: "standard",
        retentionExpiresAt: 20_000,
        stagingOperationId: staged.operationId,
        stagingReceiptBindingDigest: staged.bindingDigest,
      });
      const stagedManifest = harness.service.stageResult(
        accepted.runId,
        stagingEvidence,
      );
      harness.restart();
      expect(
        harness.service.stageResult(accepted.runId, stagingEvidence),
      ).toEqual(stagedManifest);
      const finalizeFence = resultFence(
        status.attempt,
        allocation,
        "artifact_finalize",
        `result-finalize:${manifestId}`,
      );
      const finalized = await verifyAndFinalizeStagedResult(
        createArtifactProviderSet({
          providers: [
            createFilesystemVerifier({
              nativeHelperPath: artifactHelper,
              nowMs: () => 2_300,
              root: artifactRoot,
            }),
          ],
        }),
        {
          manifest: stagedManifest,
          mutationFence: finalizeFence,
          operationId: `verify-${manifestId}`,
        },
      );
      const canonicalFinalized = harness.service.applyResultVerification(
        accepted.runId,
        manifestId,
        finalized.verification,
      );
      expect(canonicalFinalized).toEqual(finalized.manifest);
      harness.restart();
      expect(
        harness.service.applyResultVerification(
          accepted.runId,
          manifestId,
          finalized.verification,
        ),
      ).toEqual(canonicalFinalized);
      authorityStore.close();

      status = harness.service.status(accepted.runId);
      if (status === undefined) throw new Error("publishing_status_missing");
      expect(status.attempt.resultManifestId).toBe(manifestId);
      const terminalProgress = Object.freeze({
        creatingOperationId: `terminal-${accepted.attemptId}`,
        disposition: translated.classification,
        evidenceDigest: digest(JSON.stringify(completed)),
        evidenceKind: "subscription-runtime-terminal-and-result",
        runId: accepted.runId,
      });
      expect(harness.service.progressTerminal(terminalProgress)).toMatchObject({
        phase: "intent_recorded",
        status: {
          attempt: {
            terminalizationIntent: {
              creatingOperationId: terminalProgress.creatingOperationId,
              evidenceDigest: terminalProgress.evidenceDigest,
            },
          },
        },
      });
      harness.restart();
      const released = harness.service.progressTerminal(terminalProgress);
      expect(released).toMatchObject({
        phase: "released",
        release: {
          allocationId: allocation.allocationId,
          attemptId: accepted.attemptId,
          disposition: "succeeded",
          executionGeneration: accepted.executionGeneration,
          kind: "terminal_release",
          stagingDisposition: "transferred",
        },
      });
      if (released.release === undefined)
        throw new Error("terminal_release_missing");
      const release = released.release;
      harness.restart();
      expect(harness.service.progressTerminal(terminalProgress)).toMatchObject({
        phase: "completed",
        release: { proofId: release.proofId },
        status: {
          attempt: { state: "succeeded" },
          run: { state: "succeeded" },
        },
      });
      harness.restart();
      expect(harness.service.progressTerminal(terminalProgress)).toMatchObject({
        phase: "completed",
        release: { proofId: release.proofId },
      });
      const terminal = await observation.workload(accepted.runId);
      expect(terminal).toMatchObject({
        attempt: {
          attemptId: accepted.attemptId,
          executionId: execution.executionId,
          resultManifestId: canonicalFinalized.resultManifestId,
          state: "succeeded",
          terminalReleaseReceiptId: release.proofId,
        },
        run: { runId: accepted.runId, state: "succeeded" },
        workload: { workloadId: accepted.workloadId },
      });
      const publicResult = await results.result(
        canonicalFinalized.resultManifestId,
      );
      expect(publicResult.manifest).toMatchObject({
        complete: true,
        publicationState: "complete",
        resultManifestId: canonicalFinalized.resultManifestId,
        verificationReceiptId: `verify-${manifestId}`,
      } satisfies Partial<ResultManifest>);
      expect(publicResult.manifest.entries).toEqual(staged.entries);
      expect((await capacity.observe()).snapshots[0]?.effective).toEqual({
        cpuMillis: 8_000,
        memoryMiB: 16_384,
      });
      expect(harness.database.state.terminalReleases.size).toBe(1);
      expect(harness.database.state.executions.size).toBe(1);
      expect(harness.database.state.manifests.size).toBe(1);
      expect(
        compareMutationFence(
          processFence,
          authoritySnapshot(processFence),
          1_500,
        ),
      ).toBe("current");
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });
});
