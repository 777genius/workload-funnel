import { Buffer } from "node:buffer";

import { OWNED_RESOURCE_PATTERN } from "./constants.mjs";
import { assertMinioRestartEvidence } from "./minio-process-restart.mjs";

function safeObjectKey(key, prefix) {
  return (
    key.startsWith(prefix) &&
    !key.startsWith("/") &&
    !key.includes("\\") &&
    !key.includes("\u0000") &&
    key
      .split("/")
      .every((segment) => segment !== "" && segment !== "." && segment !== "..")
  );
}

function parseJson(output, code) {
  try {
    return JSON.parse(output);
  } catch {
    throw new Error(code);
  }
}

export function createAwsCliScopedObjectClient(config) {
  if (
    !OWNED_RESOURCE_PATTERN.test(config.bucket) ||
    !config.scope.prefix.startsWith(`${config.runId}/`) ||
    !Array.isArray(config.scope.permissions) ||
    config.scope.permissions.join() !== "put" ||
    config.scope.canList !== false ||
    config.scope.canRead !== false ||
    config.scope.canOverwrite !== false ||
    config.scope.canDelete !== false
  )
    throw new Error("object_gate_upload_scope_invalid");
  return Object.freeze({
    capabilities: Object.freeze({
      conditionalCreate: true,
      credentialEnforcedImmutability: true,
      finalMutationFencing: true,
      scopedCredentials: true,
      serverChecksum: true,
    }),
    async putIfAbsent(input) {
      if (!safeObjectKey(input.key, config.scope.prefix))
        throw new Error("object_gate_scope_escape");
      if (!/^sha256:[a-f0-9]{64}$/u.test(input.checksum))
        throw new Error("object_gate_checksum_invalid");
      if (
        !input.bodyPath.startsWith("/") ||
        input.bodyPath.includes("\u0000") ||
        !Number.isSafeInteger(input.sizeBytes) ||
        input.sizeBytes < 0
      )
        throw new Error("object_gate_body_invalid");
      const checksumBase64 = Buffer.from(
        input.checksum.slice(7),
        "hex",
      ).toString("base64");
      const result = await config.runner.run(
        config.awsExecutable,
        [
          "s3api",
          "put-object",
          "--endpoint-url",
          config.endpoint,
          "--bucket",
          config.bucket,
          "--key",
          input.key,
          "--body",
          input.bodyPath,
          "--if-none-match",
          "*",
          "--checksum-algorithm",
          "SHA256",
          "--checksum-sha256",
          checksumBase64,
          "--no-cli-pager",
          "--output",
          "json",
        ],
        {
          environment: config.credentialEnvironment,
          timeoutMs: 15_000,
        },
      );
      if (result.code !== 0) {
        if (/PreconditionFailed|412/u.test(result.stderr))
          return Object.freeze({
            checksum: input.checksum,
            created: false,
            key: input.key,
            sizeBytes: input.sizeBytes,
          });
        throw new Error("object_gate_put_unknown");
      }
      const response = parseJson(
        result.stdout,
        "object_gate_put_response_malformed",
      );
      if (response.ChecksumSHA256 !== checksumBase64)
        throw new Error("object_gate_server_checksum_mismatch");
      return Object.freeze({
        checksum: input.checksum,
        created: true,
        key: input.key,
        sizeBytes: input.sizeBytes,
      });
    },
    scope: config.scope,
  });
}

export function objectPolicyDocuments({ bucket, key, prefix }) {
  if (
    !OWNED_RESOURCE_PATTERN.test(bucket) ||
    !prefix.startsWith("wf-production-gate-") ||
    !safeObjectKey(key, prefix)
  )
    throw new Error("unsafe_object_policy_scope");
  const prefixResource = `arn:aws:s3:::${bucket}/${prefix}*`;
  const uploadResource = `arn:aws:s3:::${bucket}/${key}`;
  return Object.freeze({
    delete: Object.freeze({
      Statement: Object.freeze([
        Object.freeze({
          Action: ["s3:DeleteObject"],
          Effect: "Allow",
          Resource: [prefixResource],
        }),
      ]),
      Version: "2012-10-17",
    }),
    upload: Object.freeze({
      Statement: Object.freeze([
        Object.freeze({
          Action: ["s3:PutObject"],
          Condition: Object.freeze({
            StringEquals: Object.freeze({
              "s3:if-none-match": "*",
            }),
          }),
          Effect: "Allow",
          Resource: [uploadResource],
        }),
      ]),
      Version: "2012-10-17",
    }),
    verify: Object.freeze({
      Statement: Object.freeze([
        Object.freeze({
          Action: ["s3:GetObject"],
          Effect: "Allow",
          Resource: [prefixResource],
        }),
      ]),
      Version: "2012-10-17",
    }),
  });
}

export function providerIdentity({ endpoint, fixtureImage, region }) {
  if (!fixtureImage.includes("@sha256:"))
    throw new Error("object_fixture_not_pinned");
  return Object.freeze({
    compatibilityOnly: true,
    endpoint,
    fixtureImage,
    providerId: `s3-compatible:minio:${fixtureImage.slice(fixtureImage.indexOf("@sha256:") + 8)}`,
    productionProviderApproved: false,
    region,
  });
}

function requestArguments(config, operationArguments) {
  const endpoint = config.endpoint.match(
    /^http:\/\/((?:0|[1-9]\d{0,2})(?:\.(?:0|[1-9]\d{0,2})){3}):(\d{1,5})$/u,
  );
  const octets = endpoint?.[1].split(".").map(Number) ?? [];
  const port = Number(endpoint?.[2]);
  if (
    endpoint === null ||
    octets.length !== 4 ||
    octets.some((octet) => octet > 255) ||
    !Number.isSafeInteger(port) ||
    port < 1 ||
    port > 65_535
  )
    throw new Error("object_fixture_endpoint_not_direct_ipv4");
  return Object.freeze([
    "s3api",
    ...operationArguments,
    "--endpoint-url",
    config.endpoint,
    "--no-cli-pager",
    "--output",
    "json",
  ]);
}

async function awsRequest(
  config,
  operationArguments,
  environment,
  timeoutMs = 15_000,
) {
  return config.runner.run(
    config.awsExecutable,
    requestArguments(config, operationArguments),
    { environment, timeoutMs },
  );
}

async function denied(config, operationArguments, environment) {
  const result = await awsRequest(config, operationArguments, environment);
  if (result.code === 0) return false;
  if (/AccessDenied|Forbidden|\b403\b/u.test(result.stderr)) return true;
  throw new Error("object_gate_scope_denial_ambiguous");
}

function parseHeadChecksum(output) {
  const head = parseJson(output, "object_gate_head_response_malformed");
  if (
    typeof head.ChecksumSHA256 !== "string" ||
    head.ChecksumSHA256.length === 0
  )
    throw new Error("object_gate_head_checksum_missing");
  return head.ChecksumSHA256;
}

export async function runObjectCompatibilityProbe(config) {
  if (
    !safeObjectKey(config.key, config.prefix) ||
    !/^sha256:[a-f0-9]{64}$/u.test(config.checksum) ||
    !/^sha256:[a-f0-9]{64}$/u.test(config.overwriteChecksum) ||
    config.overwriteChecksum === config.checksum ||
    typeof config.overwriteBodyPath !== "string" ||
    !config.overwriteBodyPath.startsWith("/")
  )
    throw new Error("object_gate_probe_input_invalid");
  const client = createAwsCliScopedObjectClient({
    awsExecutable: config.awsExecutable,
    bucket: config.bucket,
    credentialEnvironment: config.uploadEnvironment,
    endpoint: config.endpoint,
    runId: config.runId,
    runner: config.runner,
    scope: Object.freeze({
      canDelete: false,
      canList: false,
      canOverwrite: false,
      canRead: false,
      permissions: Object.freeze(["put"]),
      prefix: config.prefix,
    }),
  });
  const input = Object.freeze({
    bodyPath: config.bodyPath,
    checksum: config.checksum,
    key: config.key,
    sizeBytes: config.sizeBytes,
  });
  const created = await client.putIfAbsent(input);
  const duplicate = await client.putIfAbsent(input);
  if (!created.created || duplicate.created)
    throw new Error("object_gate_create_only_not_proven");
  const common = ["--bucket", config.bucket, "--key", config.key];
  const scopeDenials = Object.freeze({
    deleteCannotList: await denied(
      config,
      ["list-objects-v2", "--bucket", config.bucket],
      config.deleteEnvironment,
    ),
    deleteCannotRead: await denied(
      config,
      ["head-object", ...common],
      config.deleteEnvironment,
    ),
    uploadCannotDelete: await denied(
      config,
      ["delete-object", ...common],
      config.uploadEnvironment,
    ),
    uploadCannotList: await denied(
      config,
      ["list-objects-v2", "--bucket", config.bucket],
      config.uploadEnvironment,
    ),
    uploadCannotRead: await denied(
      config,
      ["head-object", ...common],
      config.uploadEnvironment,
    ),
  });
  const overwriteBypass = await awsRequest(
    config,
    [
      "put-object",
      ...common,
      "--body",
      config.overwriteBodyPath,
      "--checksum-algorithm",
      "SHA256",
      "--checksum-sha256",
      Buffer.from(config.overwriteChecksum.slice(7), "hex").toString("base64"),
    ],
    config.uploadEnvironment,
  );

  const beforeRestart = await awsRequest(
    config,
    ["head-object", ...common, "--checksum-mode", "ENABLED"],
    config.verifyEnvironment,
  );
  if (beforeRestart.code !== 0) throw new Error("object_gate_verify_failed");
  const checksum = parseHeadChecksum(beforeRestart.stdout);
  const uploadCredentialCanOverwrite = overwriteBypass.code === 0;
  if (
    overwriteBypass.code !== 0 &&
    !/AccessDenied|Forbidden|\b403\b/u.test(overwriteBypass.stderr)
  )
    throw new Error("object_gate_overwrite_probe_unknown");
  const originalChecksum = Buffer.from(
    config.checksum.slice(7),
    "hex",
  ).toString("base64");
  const overwrittenChecksum = Buffer.from(
    config.overwriteChecksum.slice(7),
    "hex",
  ).toString("base64");
  const expectedChecksum = uploadCredentialCanOverwrite
    ? overwrittenChecksum
    : originalChecksum;
  if (checksum !== expectedChecksum)
    throw new Error("object_gate_server_checksum_mismatch");
  const processRestart = assertMinioRestartEvidence(await config.restart());
  const afterRestart = await awsRequest(
    config,
    ["head-object", ...common, "--checksum-mode", "ENABLED"],
    config.verifyEnvironment,
  );
  if (
    afterRestart.code !== 0 ||
    parseHeadChecksum(afterRestart.stdout) !== checksum
  )
    throw new Error("object_gate_restart_reconciliation_failed");

  await config.partition();
  let partitioned;
  try {
    partitioned = await awsRequest(
      config,
      ["head-object", ...common],
      config.verifyEnvironment,
      2_000,
    );
    if (partitioned.code === 0)
      throw new Error("object_gate_partition_not_effective");
  } finally {
    await config.heal();
  }
  const reconciled = await awsRequest(
    config,
    ["head-object", ...common, "--checksum-mode", "ENABLED"],
    config.verifyEnvironment,
  );
  if (
    reconciled.code !== 0 ||
    parseHeadChecksum(reconciled.stdout) !== checksum
  )
    throw new Error("object_gate_partition_reconciliation_failed");
  const removed = await awsRequest(
    config,
    ["delete-object", ...common],
    config.deleteEnvironment,
  );
  if (removed.code !== 0) throw new Error("object_gate_prefix_delete_failed");
  return Object.freeze({
    adapterConditionalCreate: true,
    credentialEnforcedImmutability:
      !uploadCredentialCanOverwrite && checksum === originalChecksum,
    deleteIdentityDistinct: true,
    exactProviderIdentity: config.provider,
    networkPartitionReconciled: true,
    restartReconciled: true,
    serverProcessRestart: processRestart,
    serverChecksum: checksum,
    scopeComplete: Object.values(scopeDenials).every(Boolean),
    scopeDenials,
    uploadCredentialCanOverwrite,
    overwriteChangedServerChecksum:
      uploadCredentialCanOverwrite && checksum === overwrittenChecksum,
  });
}
