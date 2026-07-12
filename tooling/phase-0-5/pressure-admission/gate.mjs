import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { setImmediate } from "node:timers";

import { evidence, unsupported } from "../shared.mjs";

export function decidePressureAdmission(sample, limits) {
  if (sample.status !== "fresh") {
    return { reason: `sensor_${sample.status}`, status: "closed" };
  }
  for (const dimension of ["cpu", "memory", "io", "disk", "inodes"]) {
    const value = sample[dimension];
    const limit = limits[dimension];
    if (
      typeof limit !== "number" ||
      !Number.isFinite(limit) ||
      limit <= 0 ||
      limit > 1
    ) {
      return { reason: `policy_invalid_${dimension}`, status: "closed" };
    }
    if (typeof value !== "number" || !Number.isFinite(value)) {
      return { reason: `sensor_invalid_${dimension}`, status: "closed" };
    }
    if (value >= limit) {
      return { reason: `${dimension}_pressure`, status: "closed" };
    }
  }
  return { status: "open" };
}

export async function runBoundedSyntheticPressure() {
  const started = performance.now();
  const directory = await mkdtemp(join(tmpdir(), "wf-feasibility-pressure-"));
  const bytes = new Uint8Array(64 * 1024);
  let checksum = 0;
  try {
    for (let index = 0; index < bytes.length; index += 1) {
      bytes[index] = index % 251;
      checksum ^= bytes[index];
    }
    await writeFile(join(directory, "bounded-io.bin"), bytes);
    await Promise.all(
      Array.from({ length: 16 }, (_, index) =>
        writeFile(join(directory, `inode-${index}`), ""),
      ),
    );
    await new Promise((resolve) => setImmediate(resolve));
    return {
      checksum,
      dimensions: ["cpu", "memory", "io", "disk", "inodes"],
      responseMilliseconds: performance.now() - started,
    };
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
}

export async function runPressureAdmissionGate() {
  const limits = { cpu: 0.9, disk: 0.9, inodes: 0.9, io: 0.9, memory: 0.9 };
  const dimensions = ["cpu", "memory", "io", "disk", "inodes"];
  const closures = dimensions.map((dimension) =>
    decidePressureAdmission(
      {
        cpu: 0.1,
        disk: 0.1,
        inodes: 0.1,
        io: 0.1,
        memory: 0.1,
        [dimension]: 0.95,
        status: "fresh",
      },
      limits,
    ),
  );
  const boundedLoad = await runBoundedSyntheticPressure();
  const allClosed = closures.every((decision) => decision.status === "closed");
  const staleClosed =
    decidePressureAdmission({ status: "stale" }, limits).status === "closed";
  const responsive = boundedLoad.responseMilliseconds < 1_000;
  const allDimensionsExercised = boundedLoad.dimensions.length === 5;
  return unsupported({
    capability: "pressure_fail_closed_admission",
    evidence: [
      evidence(
        "pressure.all-dimensions-close",
        allClosed,
        JSON.stringify(closures),
      ),
      evidence(
        "pressure.stale-sensor-closes",
        staleClosed,
        String(staleClosed),
      ),
      evidence(
        "pressure.synthetic-load-dimensions",
        allDimensionsExercised,
        boundedLoad.dimensions.join(","),
      ),
      evidence(
        "pressure.control-responsive",
        responsive,
        responsive ? "under_1000ms" : "at_or_over_1000ms",
      ),
    ],
    gateId: "pressure_admission_fail_closed",
    invariantIds: ["WF-INV-013", "WF-INV-015", "WF-INV-019", "WF-INV-023"],
    reasonCode: "host_saturation_isolation_unverified",
    requiredHostEvidence: [
      "Saturate CPU, memory, IO, disk, and inodes independently on a disposable host while protected control services run in their production cgroups.",
      "Capture PSI, cgroup and admission observations proving each gate closes before exhaustion.",
      "Prove protected control services remain responsive and recovery reopens admission only after fresh healthy observations.",
    ],
  });
}
