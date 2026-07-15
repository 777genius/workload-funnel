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

function compatibilityProbe({
  overwriteAllowed = true,
  overwriteVisible = true,
} = {}) {
  let partitioned = false;
  let overwritten = false;
  const restart = vi.fn(() => Promise.resolve(restartEvidence));
  const partition = vi.fn(() => {
    partitioned = true;
  });
  const run = vi.fn(async (_executable, args, options) => {
    const operation = args[1];
    const role = options.environment.ROLE;
    if (operation === "put-object" && args.includes("--if-none-match"))
      return {
        code: 0,
        stderr: "",
        stdout: JSON.stringify({ ChecksumSHA256: encoded(original) }),
      };
    if (operation === "put-object") {
      overwritten = overwriteAllowed;
      return overwriteAllowed
        ? { code: 0, stderr: "", stdout: "{}" }
        : { code: 1, stderr: "AccessDenied", stdout: "" };
    }
    if (operation === "head-object")
      return partitioned || role !== "verify"
        ? { code: 1, stderr: "AccessDenied", stdout: "" }
        : {
            code: 0,
            stderr: "",
            stdout: JSON.stringify({
              ChecksumSHA256: encoded(
                overwritten && overwriteVisible ? overwrite : original,
              ),
            }),
          };
    if (operation === "delete-object" && role === "delete")
      return { code: 0, stderr: "", stdout: "{}" };
    return { code: 1, stderr: "AccessDenied", stdout: "" };
  });
  const probe = () =>
    runObjectCompatibilityProbe({
      awsExecutable: "/usr/bin/aws",
      bodyPath: "/gate/original",
      bucket: `${runId}-artifacts`,
      checksum: original,
      deleteEnvironment: {
        AWS_ACCESS_KEY_ID: "wfdelete0123456789ab",
        ROLE: "delete",
      },
      endpoint: "http://127.0.0.1:19000",
      heal: () => {
        partitioned = false;
      },
      key: `${runId}/uploads/artifact.bin`,
      overwriteBodyPath: "/gate/overwrite",
      overwriteChecksum: overwrite,
      partition,
      prefix: `${runId}/uploads/`,
      provider: {
        compatibilityOnly: true,
        productionProviderApproved: false,
        providerId: "synthetic-minio",
      },
      restart,
      runId,
      runner: { run },
      sizeBytes: 1,
      uploadEnvironment: {
        AWS_ACCESS_KEY_ID: "wfupload0123456789ab",
        ROLE: "upload",
      },
      verifyEnvironment: {
        AWS_ACCESS_KEY_ID: "wfverify0123456789ab",
        ROLE: "verify",
      },
    });
  return { partition, probe, restart, run };
}

describe("production gate object overwrite truthfulness", () => {
  it("proves the same credential can unconditionally overwrite the exact key", async () => {
    const fixture = compatibilityProbe();
    const evidence = await fixture.probe();
    expect(evidence).toMatchObject({
      adapterConditionalCreate: true,
      credentialEnforcedImmutability: false,
      exactProviderIdentity: {
        compatibilityOnly: true,
        productionProviderApproved: false,
      },
      networkPartitionReconciled: true,
      overwriteChangedServerChecksum: true,
      overwriteUsedOriginalCredential: true,
      restartReconciled: true,
      scopeComplete: true,
      serverChecksum: encoded(overwrite),
      serverProcessRestart: restartEvidence,
      uploadCredentialCanOverwrite: true,
      verificationIdentityDistinct: true,
    });
    const puts = fixture.run.mock.calls.filter(
      ([, args]) => args[1] === "put-object",
    );
    expect(puts).toHaveLength(2);
    expect(puts[0][1]).toEqual(
      expect.arrayContaining(["--if-none-match", "*"]),
    );
    expect(puts[1][1]).not.toContain("--if-none-match");
    expect(puts[1][1]).toEqual(
      expect.arrayContaining([
        "--body",
        "/gate/overwrite",
        "--checksum-sha256",
        encoded(overwrite),
      ]),
    );
    expect(puts[0][2].environment).toBe(puts[1][2].environment);
  });

  it("fails closed if the unconditional overwrite does not succeed", async () => {
    const fixture = compatibilityProbe({ overwriteAllowed: false });
    await expect(fixture.probe()).rejects.toThrow(
      "object_gate_unconditional_overwrite_failed",
    );
    expect(fixture.restart).not.toHaveBeenCalled();
    expect(fixture.partition).not.toHaveBeenCalled();
  });

  it("fails closed if the overwrite checksum is not visible from verification", async () => {
    const fixture = compatibilityProbe({ overwriteVisible: false });
    await expect(fixture.probe()).rejects.toThrow(
      "object_gate_server_checksum_mismatch",
    );
    expect(fixture.restart).not.toHaveBeenCalled();
  });

  it("rejects reused upload, verification, or delete identities", async () => {
    await expect(
      runObjectCompatibilityProbe({
        awsExecutable: "/usr/bin/aws",
        bodyPath: "/gate/original",
        bucket: `${runId}-artifacts`,
        checksum: original,
        deleteEnvironment: { AWS_ACCESS_KEY_ID: "deleteidentity" },
        endpoint: "http://127.0.0.1:19000",
        heal: vi.fn(),
        key: `${runId}/uploads/artifact.bin`,
        overwriteBodyPath: "/gate/overwrite",
        overwriteChecksum: overwrite,
        partition: vi.fn(),
        prefix: `${runId}/uploads/`,
        provider: { providerId: "synthetic-minio" },
        restart: vi.fn(),
        runId,
        runner: { run: vi.fn() },
        sizeBytes: 1,
        uploadEnvironment: { AWS_ACCESS_KEY_ID: "sameidentity" },
        verifyEnvironment: { AWS_ACCESS_KEY_ID: "sameidentity" },
      }),
    ).rejects.toThrow("object_gate_credential_identity_collision");
  });
});
