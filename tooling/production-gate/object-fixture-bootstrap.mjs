import { chown, writeFile } from "node:fs/promises";

import { objectPolicyDocuments } from "./object-contract.mjs";

function baseMounts(config) {
  return [
    {
      destination: "/gate/mc/config.json",
      source: config.adminConfigFile,
    },
    {
      destination: "/gate/bootstrap.sh",
      source: config.bootstrapScript,
    },
  ];
}

function bootstrap(config, operation, arguments_ = [], mounts = []) {
  return config.docker.runClient({
    arguments_: ["/gate/bootstrap.sh", operation, ...arguments_],
    entrypoint: "/bin/sh",
    image: config.clientImage,
    mounts: [...baseMounts(config), ...mounts],
  });
}

async function installIdentity(config, { credentialFile, policy, user }) {
  await bootstrap(
    config,
    "add-user",
    ["/run/secrets/identity"],
    [{ destination: "/run/secrets/identity", source: credentialFile }],
  );
  await bootstrap(config, "attach-policy", [policy, user]);
}

export async function bootstrapObjectFixture(config) {
  const documents = objectPolicyDocuments({
    bucket: config.bucket,
    prefix: config.prefix,
  });
  await bootstrap(config, "ready");
  await bootstrap(config, "make-bucket", [config.bucket]);
  for (const [kind, document] of Object.entries(documents)) {
    const policy = `${config.runId}-${kind}`;
    const path = `${config.sandboxRoot}/${policy}.json`;
    await writeFile(path, `${JSON.stringify(document)}\n`, {
      flag: "wx",
      mode: 0o600,
    });
    await chown(path, 1000, 1000);
    await bootstrap(
      config,
      "create-policy",
      [policy],
      [{ destination: "/gate/policy.json", source: path }],
    );
    await installIdentity(config, {
      credentialFile: config.identityFiles[kind].credentialFile,
      policy,
      user: config.identityFiles[kind].user,
    });
  }
}
