import { postgresContainerArguments } from "./docker-plan.mjs";
import { createOwnedDirectory } from "./owned-directory.mjs";
import { psqlArguments, runPostgresFixtureProbe } from "./postgres-probe.mjs";
import { gateSecret, writeSecretFile } from "./secret-files.mjs";

async function psql(runner, config, sql, timeoutMs = 5_000) {
  return runner.run(config.psqlExecutable, psqlArguments({ ...config, sql }), {
    environment: { PGPASSWORD: config.password },
    timeoutMs,
  });
}

export async function runPostgresCompatibilityStage({
  config,
  docker,
  ledger,
  runner,
  secrets,
  wait,
  waitFor,
}) {
  const dockerEngine = await docker.assertLocalEngine();
  await docker.createNetwork();
  const suffix = config.runId.slice("wf-production-gate-".length);
  const password = gateSecret();
  secrets.push(password);
  const database = `wf_production_gate_${suffix}`;
  const passwordFile = await writeSecretFile({
    contents: `${password}\n`,
    ledger,
    owner: { gid: 70, uid: 70 },
    path: `${config.sandboxRoot}/postgres-password`,
    runId: config.runId,
    sandboxRoot: config.sandboxRoot,
  });
  const name = `${config.runId}-postgres`;
  const postgresData = await createOwnedDirectory({
    gid: 70,
    ledger,
    mode: 0o700,
    name: "postgres-data",
    path: `${config.sandboxRoot}/postgres-data`,
    runId: config.runId,
    sandboxRoot: config.sandboxRoot,
    uid: 70,
  });
  const postgresIdentity = await docker.startContainer(
    name,
    postgresContainerArguments({
      database,
      dataDirectory: postgresData.path,
      image: config.postgresImage,
      ioDevice: config.ioDevice,
      name,
      network: docker.network,
      passwordFile,
      user: "wf_gate",
    }),
  );
  const dockerConfinement = await docker.inspectContainerConfinement(
    name,
    "70:70",
    [password],
    postgresIdentity,
    {
      destination: "/var/lib/postgresql/data",
      kind: "bind",
      source: postgresData.path,
    },
  );
  const port = await docker.loopbackPort(name, 5432);
  const connection = Object.freeze({
    database,
    host: "127.0.0.1",
    password,
    port,
    psqlExecutable: config.psqlExecutable,
    schema: database,
    user: "wf_gate",
  });
  const ready = async () =>
    (await psql(runner, connection, "SELECT 1;", 2_000)).code === 0;
  await waitFor(ready, "postgres_fixture_start_timeout");
  const evidence = await runPostgresFixtureProbe({
    ...connection,
    crashServer: async (client) => {
      let clientResult;
      const crash = await docker.crashAndRestart(
        name,
        postgresIdentity,
        async () => {
          clientResult = await client.completion;
          if (
            !Number.isSafeInteger(clientResult.code) ||
            clientResult.code === 0 ||
            clientResult.signal !== null
          )
            throw new Error(
              "postgres_crash_client_did_not_observe_server_failure",
            );
        },
      );
      await waitFor(ready, "postgres_fixture_restart_timeout");
      return Object.freeze({
        ...crash,
        clientConnectionTerminated: true,
        clientExitCode: clientResult.code,
        clientSignal: clientResult.signal,
      });
    },
    runner,
    wait,
  });
  return Object.freeze({
    connection,
    evidence: Object.freeze({
      ...evidence,
      dockerConfinement,
      dockerEngine,
      fixtureImage: config.postgresImage,
      postgresData,
    }),
  });
}
