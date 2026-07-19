import { readFileSync } from "node:fs";

import { describe, expect, it, vi } from "vitest";

import {
  canonicalHyperQueueOperationJobName,
  ExactVersionHyperQueueOperationLookup,
  parseHyperQueueOperationLookup,
} from "@workload-funnel/scheduler-hyperqueue/operation-lookup";

const identity = Object.freeze({
  mappingFingerprint: "mapping-fingerprint-1",
  mutationFenceFingerprint: `fence-v1-${"b".repeat(64)}`,
  operationId: "persisted-operation-1",
  requestFingerprint: "a".repeat(64),
  schedulerInstanceId: "scheduler-instance-1",
});

const officialRetainedJobs = readFileSync(
  new URL("./fixtures/hq-v0.26.2-job-list.json", import.meta.url),
  "utf8",
);

function row(id: number, name: string, state = "waiting") {
  return {
    cancel_reason: state === "canceled" ? "canceled by fixture" : null,
    id,
    is_open: false,
    name,
    task_count: 1,
    task_stats: {
      aborted: state === "aborted" ? 1 : 0,
      canceled: state === "canceled" ? 1 : 0,
      failed: state === "failed" ? 1 : 0,
      finished: state === "finished" ? 1 : 0,
      running: state === "running" ? 1 : 0,
      waiting: state === "waiting" ? 1 : 0,
    },
  };
}

describe("HyperQueue v0.26.2 deterministic operation lookup contract", () => {
  it("binds the bounded opaque digest name to every persisted submit identity field", () => {
    const name = canonicalHyperQueueOperationJobName(identity);
    expect(name).toMatch(/^wf-hq-v1-[A-Za-z0-9_-]{86}$/u);
    expect(name).toHaveLength(95);
    for (const value of Object.values(identity))
      expect(name).not.toContain(value);
    expect(canonicalHyperQueueOperationJobName(identity)).toBe(name);
    for (const changed of [
      { mappingFingerprint: "mapping-fingerprint-2" },
      { mutationFenceFingerprint: `fence-v1-${"c".repeat(64)}` },
      { operationId: "persisted-operation-2" },
      { requestFingerprint: "d".repeat(64) },
      { schedulerInstanceId: "scheduler-instance-2" },
    ])
      expect(
        canonicalHyperQueueOperationJobName({ ...identity, ...changed }),
      ).not.toBe(name);
  });

  it("parses an exact real upstream v0.26.2 retained job-list fixture", () => {
    const name = canonicalHyperQueueOperationJobName(identity);
    const upstream = JSON.parse(officialRetainedJobs) as unknown[];
    const rebound = upstream.map((job, index) =>
      index === 1 ? { ...(job as object), name } : job,
    );
    expect(
      parseHyperQueueOperationLookup(JSON.stringify(rebound), name),
    ).toEqual({
      disposition: "one",
      matches: [{ jobId: "11", jobName: name, taskId: "0" }],
      retainedJobCount: 4,
    });
  });

  it("accepts only the exact upstream dd15afd job-list row and task-stat keys", () => {
    const name = canonicalHyperQueueOperationJobName(identity);
    expect(
      parseHyperQueueOperationLookup(
        JSON.stringify([
          {
            cancel_reason: null,
            id: 7,
            is_open: false,
            name,
            task_count: 1,
            task_stats: {
              aborted: 0,
              canceled: 0,
              failed: 0,
              finished: 0,
              running: 0,
              waiting: 1,
            },
          },
        ]),
        name,
      ),
    ).toMatchObject({ disposition: "one", retainedJobCount: 1 });
  });

  it.each(["waiting", "running", "finished", "canceled", "aborted"])(
    "finds exactly one exact retained %s job without treating state as absence",
    (state) => {
      const name = canonicalHyperQueueOperationJobName(identity);
      expect(
        parseHyperQueueOperationLookup(
          JSON.stringify([row(10, "unrelated"), row(11, name, state)]),
          name,
        ),
      ).toMatchObject({ disposition: "one", retainedJobCount: 2 });
    },
  );

  it("distinguishes zero and duplicate exact matches without proving absence", () => {
    const name = canonicalHyperQueueOperationJobName(identity);
    expect(
      parseHyperQueueOperationLookup(JSON.stringify([row(1, "other")]), name),
    ).toMatchObject({ disposition: "zero", matches: [] });
    expect(
      parseHyperQueueOperationLookup(
        JSON.stringify([row(1, name), row(2, name)]),
        name,
      ),
    ).toMatchObject({ disposition: "multiple" });
  });

  it.each([
    ["malformed", "{"],
    ["non-array", "{}"],
    ["missing field", JSON.stringify([{ id: 1, name: "job" }])],
    ["extra field", JSON.stringify([{ ...row(1, "job"), state: "WAITING" }])],
    ["string id drift", JSON.stringify([{ ...row(1, "job"), id: "1" }])],
    ["negative id", JSON.stringify([{ ...row(1, "job"), id: -1 }])],
    [
      "unsafe task count",
      JSON.stringify([
        { ...row(1, "job"), task_count: Number.MAX_SAFE_INTEGER + 1 },
      ]),
    ],
    ["nullable name drift", JSON.stringify([{ ...row(1, "job"), name: null }])],
    ["empty name", JSON.stringify([{ ...row(1, "job"), name: "" }])],
    [
      "oversized name",
      JSON.stringify([{ ...row(1, "job"), name: "é".repeat(128) }]),
    ],
    [
      "decomposed name",
      JSON.stringify([{ ...row(1, "job"), name: "e\u0301" }]),
    ],
    [
      "cancel reason type drift",
      JSON.stringify([{ ...row(1, "job"), cancel_reason: 1 }]),
    ],
    [
      "decomposed cancel reason",
      JSON.stringify([{ ...row(1, "job"), cancel_reason: "e\u0301" }]),
    ],
    [
      "oversized cancel reason",
      JSON.stringify([{ ...row(1, "job"), cancel_reason: "x".repeat(1_025) }]),
    ],
    [
      "legacy counters key",
      JSON.stringify([
        {
          ...row(1, "job"),
          counters: row(1, "job").task_stats,
          task_stats: undefined,
        },
      ]),
    ],
    [
      "missing aborted stat",
      JSON.stringify([
        {
          ...row(1, "job"),
          task_stats: {
            canceled: 0,
            failed: 0,
            finished: 0,
            running: 0,
            waiting: 1,
          },
        },
      ]),
    ],
    [
      "task stat type drift",
      JSON.stringify([
        {
          ...row(1, "job"),
          task_stats: { ...row(1, "job").task_stats, waiting: "1" },
        },
      ]),
    ],
    [
      "task stat total drift",
      JSON.stringify([{ ...row(1, "job"), task_count: 2 }]),
    ],
    [
      "negative task stat",
      JSON.stringify([
        {
          ...row(1, "job"),
          task_stats: { ...row(1, "job").task_stats, aborted: -1, waiting: 2 },
        },
      ]),
    ],
    [
      "exact-name task cardinality drift",
      JSON.stringify([
        {
          ...row(1, canonicalHyperQueueOperationJobName(identity)),
          task_stats: { ...row(1, "job").task_stats, waiting: 2 },
          task_count: 2,
        },
      ]),
    ],
    [
      "exact-name open job",
      JSON.stringify([
        {
          ...row(1, canonicalHyperQueueOperationJobName(identity)),
          is_open: true,
        },
      ]),
    ],
    ["duplicate id", JSON.stringify([row(1, "first"), row(1, "second")])],
  ])("rejects %s output", (_name, output) => {
    expect(() =>
      parseHyperQueueOperationLookup(
        output,
        canonicalHyperQueueOperationJobName(identity),
      ),
    ).toThrow(
      /hyperqueue_operation_lookup_(?:incomplete|malformed|schema_invalid)/u,
    );
  });

  it("pins v0.26.2, uses the fixed structured command, and enforces both ceilings", async () => {
    const executeLookup = vi.fn(() =>
      Promise.resolve({ stderr: "", stdout: JSON.stringify([row(1, "job")]) }),
    );
    const lookup = new ExactVersionHyperQueueOperationLookup(
      { executeLookup },
      {
        exactVersion: "0.26.2",
        limits: {
          maxOutputBytes: 1_024,
          maxRetainedJobs: 1,
          timeoutMs: 1_000,
        },
      },
    );
    await expect(lookup.assertSubmitCapacity(identity)).rejects.toThrow(
      "hyperqueue_retained_history_ceiling_reached",
    );
    expect(executeLookup).toHaveBeenCalledWith(
      ["job", "list", "--all", "--output-mode", "json"],
      { maxOutputBytes: 1_024, maxRetainedJobs: 1, timeoutMs: 1_000 },
    );
    expect(
      () =>
        new ExactVersionHyperQueueOperationLookup(
          { executeLookup },
          {
            exactVersion: "0.26.3",
            limits: {
              maxOutputBytes: 1_024,
              maxRetainedJobs: 1,
              timeoutMs: 1_000,
            },
          },
        ),
    ).toThrow("hyperqueue_operation_lookup_configuration_invalid");
  });

  it("rejects combined stdout/stderr beyond the output ceiling", async () => {
    const lookup = new ExactVersionHyperQueueOperationLookup(
      {
        executeLookup: () =>
          Promise.resolve({ stderr: "x".repeat(1_023), stdout: "[]" }),
      },
      {
        exactVersion: "0.26.2",
        limits: {
          maxOutputBytes: 1_024,
          maxRetainedJobs: 100,
          timeoutMs: 1_000,
        },
      },
    );
    await expect(lookup.lookup(identity)).rejects.toThrow(
      "hyperqueue_operation_lookup_output_limit_exceeded",
    );
  });

  it("fails pre-submit closed when retained HQ history already contains the digest name", async () => {
    const name = canonicalHyperQueueOperationJobName(identity);
    const lookup = new ExactVersionHyperQueueOperationLookup(
      {
        executeLookup: () =>
          Promise.resolve({
            stderr: "",
            stdout: JSON.stringify([row(1, name)]),
          }),
      },
      {
        exactVersion: "0.26.2",
        limits: {
          maxOutputBytes: 1_024,
          maxRetainedJobs: 2,
          timeoutMs: 1_000,
        },
      },
    );
    await expect(lookup.assertSubmitCapacity(identity)).rejects.toThrow(
      "hyperqueue_operation_job_name_collision",
    );
  });
});
