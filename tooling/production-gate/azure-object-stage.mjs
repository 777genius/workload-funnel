import { randomBytes } from "node:crypto";

import { restartAzuriteServerProcessWithDocker } from "./azurite-process-restart.mjs";
import {
  azureBlobFixtureReady,
  runAzureObjectAdapterProbe,
} from "./azure-object-adapter-probe.mjs";
import {
  AZURITE_COMMAND,
  AZURITE_ENTRYPOINT,
  AZURITE_ENTRYPOINT_DESTINATION,
  azuriteContainerArguments,
} from "./docker-plan.mjs";
import { writeSecretFile } from "./secret-files.mjs";

const ACCOUNT_NAME = "wfaccount";

export async function runAzureObjectProductionStage({
  config,
  docker,
  entrypointFile,
  ledger,
  secrets,
  waitFor,
}) {
  const accountKey = randomBytes(32).toString("base64");
  secrets.push(accountKey);
  const accountKeyFile = await writeSecretFile({
    contents: `${accountKey}\n`,
    ledger,
    owner: { gid: 1000, uid: 1000 },
    path: `${config.sandboxRoot}/azurite-account-key`,
    runId: config.runId,
    sandboxRoot: config.sandboxRoot,
  });
  const name = `${config.runId}-azure`;
  const identity = await docker.startContainer(
    name,
    azuriteContainerArguments({
      accountKeyFile,
      entrypointFile,
      image: config.azuriteImage,
      ioDevice: config.ioDevice,
      name,
      network: docker.network,
    }),
  );
  const secretMounts = [
    {
      destination: "/run/secrets/azurite-account-key",
      source: accountKeyFile,
    },
  ];
  const process = {
    command: AZURITE_COMMAND,
    entrypoint: AZURITE_ENTRYPOINT,
    forbiddenEnvironmentPrefixes: ["AZURITE_ACCOUNTS="],
    readOnlyMounts: [
      {
        destination: AZURITE_ENTRYPOINT_DESTINATION,
        source: entrypointFile,
      },
    ],
    requiredEnvironment: [],
  };
  const confinement = await docker.inspectContainerConfinement(
    name,
    "1000:1000",
    [accountKey],
    identity,
    { destination: "/data", kind: "tmpfs" },
    10000,
    config.azuriteImage,
    secretMounts,
    process,
  );
  const endpoint = `http://${confinement.internalNetworkEndpoint.ipv4Address}:10000/${ACCOUNT_NAME}`;
  const ready = () => azureBlobFixtureReady({ accountKey, endpoint });
  await waitFor(ready, "azurite_fixture_start_timeout");

  const evidence = await runAzureObjectAdapterProbe({
    accountKey,
    endpoint,
    fixtureImage: config.azuriteImage,
    restart: async () => {
      const crash = await restartAzuriteServerProcessWithDocker({
        identity,
        name,
        runtime: docker,
      });
      await waitFor(ready, "azurite_fixture_restart_timeout");
      const resumed = await docker.inspectContainerConfinement(
        name,
        "1000:1000",
        [accountKey],
        identity,
        { destination: "/data", kind: "tmpfs" },
        10000,
        config.azuriteImage,
        secretMounts,
        process,
      );
      if (
        resumed.internalNetworkEndpoint.ipv4Address !==
        confinement.internalNetworkEndpoint.ipv4Address
      )
        throw new Error("azurite_internal_endpoint_identity_changed");
      return Object.freeze({
        ...crash,
        containerIdentityStable: resumed.exactIdentity === identity,
        dataTmpfsPreservedAcrossProcessBoundary: true,
      });
    },
    runId: config.runId,
  });
  return Object.freeze({
    ...evidence,
    dockerConfinement: confinement,
  });
}
