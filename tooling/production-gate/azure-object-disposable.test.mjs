import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chown, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath, URL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";

import { expect, it } from "vitest";

import { restartAzuriteServerProcessWithDocker } from "./azurite-process-restart.mjs";
import {
  azureBlobFixtureReady,
  runAzureObjectAdapterProbe,
} from "./azure-object-adapter-probe.mjs";
import { AZURITE_FIXTURE_IMAGE } from "./constants.mjs";

const execute = promisify(execFile);
const enabled = process.env.WF_AZURITE_DISPOSABLE_TEST === "1";
const entrypointFile = fileURLToPath(
  new URL("./fixtures/azurite-entrypoint.sh", import.meta.url),
);
const wait = (milliseconds) => delay(milliseconds);

async function docker(args, timeout = 30_000) {
  const result = await execute("/usr/bin/docker", args, {
    encoding: "utf8",
    maxBuffer: 2 * 1024 * 1024,
    timeout,
  });
  return result.stdout.trim();
}

async function waitFor(check, code) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await wait(100);
  }
  throw new Error(code);
}

it.runIf(enabled)(
  "proves Azure blob-SAS create-only enforcement in an isolated Azurite fixture",
  async () => {
    if (process.getuid?.() !== 0)
      throw new Error("azurite_disposable_test_requires_root");
    const suffix = randomBytes(8).toString("hex");
    const runId = `wf-production-gate-${suffix.padEnd(32, "0")}`;
    const name = `${runId}-azure`;
    const network = `${runId}-network`;
    const directory = await mkdtemp(`${tmpdir()}/workload-funnel-azurite-`);
    const keyPath = `${directory}/account-key`;
    const accountKey = randomBytes(32).toString("base64");
    let containerCreated = false;
    let networkCreated = false;
    try {
      await writeFile(keyPath, `${accountKey}\n`, {
        flag: "wx",
        mode: 0o400,
      });
      await chown(keyPath, 1000, 1000);
      await docker([
        "network",
        "create",
        "--driver",
        "bridge",
        "--internal",
        "--label",
        `workload-funnel.production-gate.run=${runId}`,
        network,
      ]);
      networkCreated = true;
      await docker([
        "create",
        "--pull=never",
        "--platform=linux/amd64",
        "--name",
        name,
        "--network",
        network,
        "--cpus",
        "1",
        "--memory",
        "536870912",
        "--memory-swap",
        "536870912",
        "--pids-limit",
        "128",
        "--cap-drop",
        "ALL",
        "--security-opt",
        "no-new-privileges=true",
        "--read-only",
        "--init",
        "--ipc=private",
        "--user",
        "1000:1000",
        "--restart",
        "no",
        "--tmpfs",
        "/data:rw,nosuid,nodev,noexec,size=134217728,uid=1000,gid=1000,mode=0700",
        "--tmpfs",
        "/tmp:rw,nosuid,nodev,noexec,size=33554432,uid=1000,gid=1000,mode=0700",
        "--mount",
        `type=bind,src=${keyPath},dst=/run/secrets/azurite-account-key,readonly`,
        "--mount",
        `type=bind,src=${entrypointFile},dst=/gate/azurite-entrypoint.sh,readonly`,
        "--label",
        `workload-funnel.production-gate.resource=${name}`,
        "--entrypoint",
        "/bin/sh",
        AZURITE_FIXTURE_IMAGE,
        "/gate/azurite-entrypoint.sh",
      ]);
      containerCreated = true;
      await docker(["start", name]);
      const inspectedText = await docker(["container", "inspect", name]);
      if (inspectedText.includes(accountKey))
        throw new Error("azurite_account_key_present_in_docker_config");
      const inspected = JSON.parse(inspectedText)[0];
      expect(inspected.HostConfig.PortBindings).toEqual({});
      expect(inspected.HostConfig.ReadonlyRootfs).toBe(true);
      expect(inspected.Config.User).toBe("1000:1000");
      const endpoint = `http://${inspected.NetworkSettings.Networks[network].IPAddress}:10000/wfaccount`;
      await waitFor(
        () => azureBlobFixtureReady({ accountKey, endpoint }),
        "azurite_disposable_fixture_start_timeout",
      );

      let evidence;
      try {
        evidence = await runAzureObjectAdapterProbe({
          accountKey,
          endpoint,
          fixtureImage: AZURITE_FIXTURE_IMAGE,
          restart: async () => {
            const result = await restartAzuriteServerProcessWithDocker({
              identity: inspected.Id,
              name,
              runtime: { command: docker },
            });
            await waitFor(
              () => azureBlobFixtureReady({ accountKey, endpoint }),
              "azurite_disposable_fixture_restart_timeout",
            );
            return result;
          },
          runId,
        });
      } catch (error) {
        const status = Number.isInteger(error?.statusCode)
          ? String(error.statusCode)
          : "none";
        const code = /^[a-z0-9_]+$/u.test(error?.message ?? "")
          ? error.message
          : /^[A-Za-z0-9]+$/u.test(error?.details?.errorCode ?? "")
            ? error.details.errorCode
            : "unknown";
        throw new Error(`azurite_disposable_probe_failed_${status}_${code}`);
      }
      expect(evidence).toMatchObject({
        adapterConditionalCreate: true,
        createCredentialCannotDelete: true,
        createCredentialCannotList: true,
        createCredentialCannotRead: true,
        createCredentialCannotSetMetadata: true,
        crossResourceCreateDenied: true,
        exactStatePreserved: true,
        forgedMetadataCannotFakeIdempotency: true,
        idempotentRetry: true,
        putBlockBypassDenied: true,
        restartReconciled: true,
        retentionDeleteIdempotent: true,
        retentionVerifiedAbsent: true,
        unconditionalOverwriteDenied: true,
      });
      if (JSON.stringify(evidence).includes(accountKey))
        throw new Error("azurite_account_key_present_in_evidence");
    } finally {
      if (containerCreated)
        await docker(["container", "rm", "--force", "--volumes", name]).catch(
          () => undefined,
        );
      if (networkCreated)
        await docker(["network", "rm", network]).catch(() => undefined);
      await rm(directory, { force: true, recursive: true });
    }
  },
  120_000,
);
