import { createHash, generateKeyPairSync } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Worker } from "node:worker_threads";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { MutationFence } from "@workload-funnel/kernel";
import {
  createSealOutputClaims,
  signSealOutputRequest,
} from "@workload-funnel/node-execution/result-sealing-coordination";
import {
  SealAuthorityRegistry,
  SealerWal,
  type SealerWalStorage,
} from "../../seal-authority-registry/index.js";
import {
  FilesystemSealBoundary,
  createLinuxDescriptorSealFilesystem,
  deterministicOutputName,
} from "../index.js";

class MemoryWalStorage implements SealerWalStorage {
  public readonly capacity = 100;
  public recoveryState: "new" | "existing" = "new";
  public commit: string | undefined;
  readonly lines: string[] = [];
  public appendAndSync(value: string, commit: string): void {
    this.lines.push(value);
    this.commit = commit;
    this.recoveryState = "existing";
  }
  public readAll(): readonly string[] {
    return this.lines;
  }
  public readCommit(): string | undefined {
    return this.commit;
  }
}

const roots: string[] = [];
let helperPath = "";
const keys = generateKeyPairSync("ed25519");

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function fence(): MutationFence {
  return Object.freeze({
    allocationId: "allocation-native-1",
    attemptId: "attempt-native-1",
    clusterIncarnation: "cluster-1",
    clusterIncarnationVersion: 1,
    desiredEffect: "seal_output",
    effectScopeKey: "seal-output:execution-native-1",
    executionGeneration: "generation-native-1",
    expectedDesiredVersion: 1,
    namespaceId: "namespace-1",
    namespaceWriterEpoch: 1,
    nodeBootEpoch: 7,
    nodeId: "node-native-1",
    operationGateRevision: 3,
    ownerFence: 9,
    requiredGate: "result_finalize",
    schemaVersion: 1,
    supersessionKey: "seal-output:execution-native-1",
  });
}

function nativeFixture() {
  const root = mkdtempSync(join(tmpdir(), "wf-native-sealer-"));
  roots.push(root);
  const outputRoot = join(root, "output");
  const stagingRoot = join(root, "staging");
  mkdirSync(outputRoot, { mode: 0o700 });
  mkdirSync(stagingRoot, { mode: 0o700 });
  const mutationFence = fence();
  const claims = createSealOutputClaims({
    allocationId: mutationFence.allocationId ?? "",
    attemptId: mutationFence.attemptId,
    audience: "workload-funnel-result-sealer",
    executionGeneration: mutationFence.executionGeneration,
    executionId: "execution-native-1",
    expiresAtMs: 200,
    issuedAtMs: 50,
    issuer: "control-service",
    issuerKeyId: "sealer-key-1",
    mutationFence,
    nodeBootEpoch: mutationFence.nodeBootEpoch ?? 0,
    nodeId: mutationFence.nodeId ?? "",
    operationId: "seal-native-1",
    outputContractDigest: digest("output-contract"),
    quiescenceReceiptDigest: digest("quiesced"),
    sealProfileDigest: digest("profile"),
    unitInvocationDigest: digest("invocation"),
  });
  const sourceName = deterministicOutputName(claims);
  const source = join(outputRoot, sourceName);
  mkdirSync(source, { mode: 0o700 });
  const authorization = signSealOutputRequest(claims, keys.privateKey);
  const registry = new SealAuthorityRegistry(
    new SealerWal(new MemoryWalStorage()),
    new Map([["sealer-key-1", keys.publicKey]]),
    () => 100,
  );
  registry.install("install-native-1", authorization);
  const limits = {
    maxDepth: 8,
    maxEntries: 32,
    maxFileBytes: 32 * 1024 * 1024,
    maxTotalBytes: 64 * 1024 * 1024,
  };
  const filesystem = createLinuxDescriptorSealFilesystem({
    expectedWorkloadUid: process.getuid?.() ?? 0,
    helperPath,
    limits,
    outputRoot,
    stagingRoot,
  });
  const boundary = new FilesystemSealBoundary({
    expectedOutputParent: filesystem.outputParent,
    expectedStagingParent: filesystem.stagingParent,
    expectedWorkloadUid: process.getuid?.() ?? 0,
    filesystem,
    limits,
    registry,
  });
  return {
    authorization,
    boundary,
    outputRoot,
    source,
    sourceName,
    stagingRoot,
  };
}

beforeAll(() => {
  const buildRoot = mkdtempSync(join(tmpdir(), "wf-native-helper-"));
  roots.push(buildRoot);
  helperPath = join(buildRoot, "linux-descriptor-fs");
  const compilation = spawnSync(
    "/usr/bin/cc",
    [
      "-std=c17",
      "-DWF_RESULT_SEALER_ONLY",
      "-O2",
      "-Wall",
      "-Wextra",
      "-Werror",
      resolve(process.cwd(), "native/linux-descriptor-fs.c"),
      "-o",
      helperPath,
    ],
    {
      encoding: "utf8",
      env: { ...process.env, PATH: "/usr/bin:/bin" },
    },
  );
  if (compilation.status !== 0)
    throw new Error(compilation.stderr || "native_test_helper_build_failed");
});

afterAll(() => {
  for (const root of roots.splice(0))
    rmSync(root, { force: true, recursive: true });
});

describe("Linux descriptor-pinned result sealing", () => {
  it("uses openat2/renameat2 and makes the sealed tree non-writable", () => {
    const current = nativeFixture();
    writeFileSync(join(current.source, "result.txt"), "hello", { mode: 0o600 });
    expect(current.boundary.seal(current.authorization)).toMatchObject({
      entries: [{ digest: digest("hello"), path: "result.txt", sizeBytes: 5 }],
      outcome: "sealed",
      totalBytes: 5,
    });
    const stagedName = readdirSync(current.stagingRoot)[0];
    if (stagedName === undefined) throw new Error("missing_staged_tree");
    expect(
      statSync(join(current.stagingRoot, stagedName, "result.txt")).mode &
        0o222,
    ).toBe(0);
  });

  it.each(["symlink", "hardlink", "fifo"] as const)(
    "refuses a real %s without publication",
    (kind) => {
      const current = nativeFixture();
      const target = join(current.source, "result.txt");
      if (kind === "symlink") symlinkSync("/etc/passwd", target);
      if (kind === "hardlink") {
        const outside = join(current.outputRoot, "outside");
        writeFileSync(outside, "hello", { mode: 0o400 });
        linkSync(outside, target);
      }
      if (kind === "fifo") {
        const made = spawnSync("/usr/bin/mkfifo", [target]);
        if (made.status !== 0) throw new Error("mkfifo_failed");
      }
      chmodSync(current.source, 0o500);
      expect(() => current.boundary.seal(current.authorization)).toThrow();
    },
  );

  it("refuses a source-directory symlink swap", () => {
    const current = nativeFixture();
    rmSync(current.source, { recursive: true });
    symlinkSync("/etc", current.source);
    expect(() => current.boundary.seal(current.authorization)).toThrow();
  });

  it("detects a real content mutation race before publication", async () => {
    const current = nativeFixture();
    const target = join(current.source, "result.txt");
    writeFileSync(target, Buffer.alloc(16 * 1024 * 1024, 1), { mode: 0o600 });
    const writer = new Worker(
      "const {parentPort,workerData}=require('node:worker_threads');const fs=require('node:fs');const wait=new Int32Array(new SharedArrayBuffer(4));const fd=fs.openSync(workerData,'r+');parentPort.postMessage('ready');for(let i=0;i<200;i++){fs.writeSync(fd,Buffer.alloc(4096,i),0,4096,(i*4096)%(16*1024*1024));Atomics.wait(wait,0,0,1)}fs.closeSync(fd)",
      { eval: true, workerData: target },
    );
    const exited = new Promise<void>((resolvePromise) => {
      writer.once("exit", () => {
        resolvePromise();
      });
    });
    await new Promise<void>((resolvePromise) => {
      writer.once("message", () => {
        resolvePromise();
      });
    });
    expect(() => current.boundary.seal(current.authorization)).toThrow(
      /mutation_race|unsafe_metadata|native_descriptor_boundary_refused/u,
    );
    await exited;
    expect(readdirSync(current.stagingRoot)).toEqual([]);
  });
});
