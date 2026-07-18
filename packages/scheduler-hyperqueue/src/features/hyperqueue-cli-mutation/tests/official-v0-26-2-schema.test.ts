import { describe, expect, it, vi } from "vitest";

import {
  fingerprintMutationFence,
  type MutationFence,
} from "@workload-funnel/kernel";
import { parseHyperQueueObservation } from "@workload-funnel/scheduler-hyperqueue/dispatch-observation";
import {
  ExactVersionHyperQueueCliMutation,
  type CredentialedHyperQueueExecutor,
} from "@workload-funnel/scheduler-hyperqueue/hyperqueue-cli-mutation";
import type { AuthorizedHyperQueueMutation } from "@workload-funnel/scheduler-hyperqueue/mutation-gateway-authority";
import { canonicalHyperQueueOperationJobName } from "@workload-funnel/scheduler-hyperqueue/mutation-gateway-authority";
import { parseHyperQueueWorkerInventory } from "@workload-funnel/scheduler-hyperqueue/worker-inventory";

const fence: MutationFence = Object.freeze({
  allocationId: "allocation-1",
  attemptId: "attempt-1",
  clusterIncarnation: "cluster-1",
  clusterIncarnationVersion: 1,
  desiredEffect: "dispatch_submit",
  effectScopeKey: "scheduler-dispatch:dispatch-1",
  executionGeneration: "generation-1",
  expectedDesiredVersion: 1,
  issuedStartRevocationRevision: 0,
  namespaceId: "test://hq-official",
  namespaceWriterEpoch: 1,
  operationGateRevision: 1,
  ownerFence: 1,
  requiredGate: "dispatch_submit",
  schemaVersion: 1,
  startFence: "start-fence-1",
  supersessionKey: "dispatch:dispatch-1",
});

function authorization(payload: unknown): AuthorizedHyperQueueMutation {
  const requestFingerprint = "a".repeat(64);
  const identity = {
    mappingFingerprint:
      (payload as { readonly mappingFingerprint?: string })
        .mappingFingerprint ?? "mapping-fingerprint-1",
    mutationFenceFingerprint: fingerprintMutationFence(fence),
    operationId: "submit-operation-1",
    requestFingerprint,
    schedulerInstanceId: "scheduler-1",
  };
  return {
    canonicalJobName:
      (payload as { readonly kind?: unknown }).kind === "submit"
        ? canonicalHyperQueueOperationJobName(identity)
        : undefined,
    registrySequence: 1,
    requestFingerprint,
    request: {
      mutationFence: fence,
      mutationFenceFingerprint: fingerprintMutationFence(fence),
      operationId: identity.operationId,
      payload,
      scope: { schedulerInstanceId: identity.schedulerInstanceId },
    },
  } as unknown as AuthorizedHyperQueueMutation;
}

describe("official HyperQueue v0.26.2 CLI schemas", () => {
  it("translates numeric submit IDs and empty cancel objects without invented CLI fields", async () => {
    const executeMutation = vi.fn((args: readonly string[]) =>
      Promise.resolve(
        args[0] === "submit"
          ? { stderr: "", stdout: '{"id":12}' }
          : { stderr: "", stdout: "{}" },
      ),
    );
    const verifyRelease = vi.fn(() => Promise.resolve());
    const executor: CredentialedHyperQueueExecutor = {
      executeMutation,
      verifyRelease,
    };
    const cli = new ExactVersionHyperQueueCliMutation({
      exactVersion: "0.26.2",
      executor,
      expectedBinarySha256:
        "e15dae9113e1a307a97a66bfe90f74f78c6016239436b5d9f1e4efec480e84b5",
      limits: { maxOutputBytes: 128 * 1024, timeoutMs: 5_000 },
      shimExecutable: "/opt/workload-funnel/bin/wf-hq-shim",
    });
    await cli.verifyExactRelease();
    expect(verifyRelease).toHaveBeenCalledWith(
      "hyperqueue v0.26.2",
      "e15dae9113e1a307a97a66bfe90f74f78c6016239436b5d9f1e4efec480e84b5",
      { maxOutputBytes: 128 * 1024, timeoutMs: 5_000 },
    );
    await expect(
      cli.mutate(
        authorization({
          dispatchId: "dispatch-1",
          kind: "submit",
          mappingFingerprint: "mapping-fingerprint-1",
          requestedCpuCount: 1,
          requiredCustomResources: {},
          restartPolicy: "never",
          shimInvocationBase64: Buffer.from("{}", "utf8").toString("base64url"),
        }),
      ),
    ).resolves.toMatchObject({
      externalReference: "hq://12",
      jobId: "12",
      taskId: "0",
    });
    await expect(
      cli.mutate(
        authorization({
          dispatchId: "dispatch-1",
          jobId: "12",
          kind: "cancel",
          mappingFingerprint: "mapping-fingerprint-1",
          taskId: "0",
        }),
      ),
    ).resolves.toMatchObject({
      jobId: "12",
      state: "cancel_acknowledged",
    });
    const cancelArguments = executeMutation.mock.calls[1]?.[0];
    expect(cancelArguments).toEqual([
      "job",
      "cancel",
      "12",
      "--output-mode",
      "json",
    ]);
    expect(cancelArguments).not.toEqual(
      expect.arrayContaining(["--task", "--mapping-fingerprint"]),
    );
  });

  it("parses the real nested job-info identity and top-level worker identity", () => {
    expect(
      parseHyperQueueObservation(
        '[{"info":{"id":12},"tasks":[{"id":0,"state":"RUNNING","exit_code":null,"worker_id":7}]}]',
        { jobId: "12", mappingFingerprint: "mapping-1", taskId: "0" },
        { sourceEpoch: 1, sourceSequence: 1 },
      ),
    ).toMatchObject({ schedulerState: "running", workerId: "7" });
    expect(
      parseHyperQueueWorkerInventory(
        '[{"id":7,"state":"IDLE","resources":{"gpu":1}}]',
        { sourceEpoch: 1, sourceSequence: 1 },
      ).workers,
    ).toEqual([{ customResources: { gpu: 1 }, state: "idle", workerId: "7" }]);
  });

  it("normalizes only safe canonical integer or decimal-string job-info identities", () => {
    expect(
      parseHyperQueueObservation(
        '[{"info":{"id":"12"},"tasks":[{"id":"0","state":"WAITING"}]}]',
        { jobId: "12", mappingFingerprint: "mapping-1", taskId: "0" },
        { sourceEpoch: 1, sourceSequence: 1 },
      ),
    ).toMatchObject({ schedulerState: "waiting" });

    for (const output of [
      "[]",
      '[{"info":{"id":12},"tasks":[]},{"info":{"id":12},"tasks":[]}]',
      '[{"tasks":[]}]',
      '[{"id":12,"info":{"id":12},"tasks":[]}]',
      '[{"info":{"id":"01"},"tasks":[]}]',
      '[{"info":{"id":-1},"tasks":[]}]',
      '[{"info":{"id":1.5},"tasks":[]}]',
      '[{"info":{"id":9007199254740992},"tasks":[]}]',
      '[{"info":{"id":13},"tasks":[{"id":0,"state":"WAITING"}]}]',
    ])
      expect(() =>
        parseHyperQueueObservation(
          output,
          { jobId: "12", mappingFingerprint: "mapping-1", taskId: "0" },
          { sourceEpoch: 1, sourceSequence: 1 },
        ),
      ).toThrow("hyperqueue_observation_schema_invalid");
  });

  it("rejects the old synthetic object envelopes and noncanonical cancel IDs", () => {
    expect(() =>
      parseHyperQueueObservation(
        '{"job":{"id":"job-1"}}',
        {
          jobId: "1",
          mappingFingerprint: "mapping-1",
          taskId: "0",
        },
        { sourceEpoch: 1, sourceSequence: 1 },
      ),
    ).toThrow("hyperqueue_observation_schema_invalid");
    expect(() =>
      parseHyperQueueWorkerInventory('{"workers":[]}', {
        sourceEpoch: 1,
        sourceSequence: 1,
      }),
    ).toThrow("hyperqueue_worker_schema_invalid");
  });
});
