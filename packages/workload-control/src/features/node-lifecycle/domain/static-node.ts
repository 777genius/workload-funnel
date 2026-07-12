export interface StaticNode {
  readonly nodeId: "synthetic-node-1";
  readonly bootEpoch: "synthetic-boot-1";
  readonly profile: "trusted-synthetic-v1";
  readonly state: "schedulable";
  readonly capacity: {
    readonly cpuMillis: 4000;
    readonly memoryMiB: 4096;
  };
  readonly observationRevision: 1;
}

export function createStaticSyntheticNode(): StaticNode {
  return Object.freeze({
    bootEpoch: "synthetic-boot-1",
    capacity: Object.freeze({ cpuMillis: 4000, memoryMiB: 4096 }),
    nodeId: "synthetic-node-1",
    observationRevision: 1,
    profile: "trusted-synthetic-v1",
    state: "schedulable",
  });
}
