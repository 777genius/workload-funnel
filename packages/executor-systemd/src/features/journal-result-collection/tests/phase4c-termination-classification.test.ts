import { describe, expect, it } from "vitest";

import {
  classifyExecutionTermination,
  type ExecutionTerminationEvidence,
  type ExecutionTerminationClassification,
} from "../index.js";

const baseline: ExecutionTerminationEvidence = Object.freeze({
  cancellationStopObserved: false,
  cgroupOomKillCountAfter: 0,
  cgroupOomKillCountBefore: 0,
  execMainCode: "exited",
  execMainStatus: 0,
  managedOomEviction: false,
  nodeReachable: true,
  observationComplete: true,
  operatorCancellationRequested: false,
  systemdResult: "success",
});

describe("Phase 4C OOM and pressure classification", () => {
  it.each<
    readonly [
      ExecutionTerminationClassification,
      Partial<ExecutionTerminationEvidence>,
    ]
  >([
    ["exit_success", {}],
    ["child_exit_failure", { execMainStatus: 2, systemdResult: "exit-code" }],
    ["systemd_timeout", { systemdResult: "timeout" }],
    [
      "operator_cancellation",
      {
        cancellationStopObserved: true,
        operatorCancellationRequested: true,
        systemdResult: "signal",
      },
    ],
    [
      "memory_limit_oom",
      { cgroupOomKillCountAfter: 1, systemdResult: "signal" },
    ],
    [
      "host_pressure_eviction",
      { managedOomEviction: true, systemdResult: "resources" },
    ],
    ["node_loss", { nodeReachable: false }],
    ["unknown_observation_loss", { observationComplete: false }],
  ])("classifies %s from explicit evidence", (classification, overrides) => {
    expect(
      classifyExecutionTermination({ ...baseline, ...overrides })
        .classification,
    ).toBe(classification);
  });

  it("does not mislabel an OOM as cancellation when evidence races", () => {
    expect(
      classifyExecutionTermination({
        ...baseline,
        cgroupOomKillCountAfter: 1,
        operatorCancellationRequested: true,
        systemdResult: "signal",
      }),
    ).toEqual({
      classification: "memory_limit_oom",
      retryEvidence: "capacity_pressure",
    });
  });

  it("keeps generic resources and an unobserved cancellation stop ambiguous", () => {
    expect(
      classifyExecutionTermination({
        ...baseline,
        systemdResult: "resources",
      }),
    ).toEqual({
      classification: "unknown_observation_loss",
      retryEvidence: "ambiguous",
    });
    expect(
      classifyExecutionTermination({
        ...baseline,
        execMainCode: "killed",
        execMainStatus: 15,
        operatorCancellationRequested: true,
        systemdResult: "signal",
      }),
    ).toEqual({
      classification: "unknown_observation_loss",
      retryEvidence: "ambiguous",
    });
  });

  it("lets a successful exit win a cancellation request race", () => {
    expect(
      classifyExecutionTermination({
        ...baseline,
        operatorCancellationRequested: true,
      }),
    ).toEqual({
      classification: "exit_success",
      retryEvidence: "definite_success",
    });
  });

  it("rejects reset or malformed cgroup event counters", () => {
    expect(() =>
      classifyExecutionTermination({
        ...baseline,
        cgroupOomKillCountAfter: 2,
        cgroupOomKillCountBefore: 3,
      }),
    ).toThrow("non_monotonic_oom_event_counter");
  });
});
