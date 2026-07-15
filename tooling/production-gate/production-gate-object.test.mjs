import { Buffer } from "node:buffer";

import { describe, expect, it, vi } from "vitest";

import { runObjectCompatibilityProbe } from "./object-contract.mjs";

const runId = "wf-production-gate-0123456789abcdef0123456789abcdef";
const original = `sha256:${"a".repeat(64)}`;
const overwrite = `sha256:${"b".repeat(64)}`;
const encoded = (checksum) =>
  Buffer.from(checksum.slice(7), "hex").toString("base64");
const restartEvidence = Object.freeze({
  configurationSha256: "c".repeat(64),
  containerBoundaryPid: 101,
  containerBoundaryStable: true,
  containerConfinementStable: true,
  containerIdentity: "d".repeat(64),
  containerIdentityStable: true,
  currentServerGeneration: 2,
  currentServerPid: 202,
  previousServerGeneration: 1,
  previousServerPid: 201,
  readinessAfterRestart: true,
  schemaVersion: "workload-funnel.minio-server-process-restart.v1",
  serverProcessGenerationChanged: true,
  serverProcessPidChanged: true,
  supervisorBoundaryStable: true,
  supervisorPid: 7,
});

async function compatibilityProbe({ overwriteAllowed }) {
  let conditionalPuts = 0;
  let overwritten = false;
  let partitioned = false;
  const run = vi.fn(async (_executable, args, options) => {
    const operation = args[1];
    const role = options.environment.ROLE;
    if (operation === "put-object" && args.includes("--if-none-match")) {
      conditionalPuts += 1;
      return conditionalPuts === 1
        ? {
            code: 0,
            stderr: "",
            stdout: JSON.stringify({ ChecksumSHA256: encoded(original) }),
          }
        : { code: 1, stderr: "PreconditionFailed 412", stdout: "" };
    }
    if (operation === "put-object") {
      overwritten = overwriteAllowed;
      return overwriteAllowed
        ? { code: 0, stderr: "", stdout: "{}" }
        : { code: 1, stderr: "AccessDenied 403", stdout: "" };
    }
    if (operation === "head-object")
      return partitioned || role !== "verify"
        ? { code: 1, stderr: "AccessDenied", stdout: "" }
        : {
            code: 0,
            stderr: "",
            stdout: JSON.stringify({
              ChecksumSHA256: encoded(overwritten ? overwrite : original),
            }),
          };
    if (operation === "delete-object" && role === "delete")
      return { code: 0, stderr: "", stdout: "{}" };
    return { code: 1, stderr: "AccessDenied", stdout: "" };
  });
  const evidence = await runObjectCompatibilityProbe({
    awsExecutable: "/usr/bin/aws",
    bodyPath: "/gate/original",
    bucket: `${runId}-artifacts`,
    checksum: original,
    deleteEnvironment: { ROLE: "delete" },
    endpoint: "http://127.0.0.1:19000",
    heal: () => {
      partitioned = false;
    },
    key: `${runId}/uploads/artifact.bin`,
    overwriteBodyPath: "/gate/overwrite",
    overwriteChecksum: overwrite,
    partition: () => {
      partitioned = true;
    },
    prefix: `${runId}/uploads/`,
    provider: { providerId: "synthetic-minio" },
    restart: vi.fn(() => Promise.resolve(restartEvidence)),
    runId,
    runner: { run },
    sizeBytes: 1,
    uploadEnvironment: { ROLE: "upload" },
    verifyEnvironment: { ROLE: "verify" },
  });
  return { evidence, run };
}

describe("production gate object overwrite truthfulness", () => {
  it("proves the upload credential rejects a direct same-key overwrite", async () => {
    const { evidence, run } = await compatibilityProbe({
      overwriteAllowed: false,
    });
    expect(evidence).toMatchObject({
      credentialEnforcedImmutability: true,
      overwriteChangedServerChecksum: false,
      scopeComplete: true,
      serverChecksum: encoded(original),
      serverProcessRestart: restartEvidence,
      uploadCredentialCanOverwrite: false,
    });
    const overwriteCall = run.mock.calls.find(
      ([, args]) =>
        args[1] === "put-object" && !args.includes("--if-none-match"),
    );
    expect(overwriteCall?.[1]).toEqual(
      expect.arrayContaining([
        "--body",
        "/gate/overwrite",
        "--checksum-sha256",
        encoded(overwrite),
      ]),
    );
  });

  it("cannot claim credential immutability when a permissive policy regresses", async () => {
    const { evidence } = await compatibilityProbe({ overwriteAllowed: true });
    expect(evidence).toMatchObject({
      credentialEnforcedImmutability: false,
      overwriteChangedServerChecksum: true,
      serverChecksum: encoded(overwrite),
      uploadCredentialCanOverwrite: true,
    });
  });
});
