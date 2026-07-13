#!/usr/bin/env node
import { createFetchSdkTransport } from "@workload-funnel/client-sdk/workload-submission";

import { createOperatorCli, runOperatorCli } from "./index.js";

const baseUrl = process.env["WORKLOAD_FUNNEL_API_URL"];
const tenantId = process.env["WORKLOAD_FUNNEL_TENANT"];
const bearerToken = process.env["WORKLOAD_FUNNEL_API_TOKEN"];

if (
  baseUrl === undefined ||
  baseUrl.length > 2048 ||
  tenantId === undefined ||
  tenantId.length > 256 ||
  bearerToken === undefined ||
  bearerToken.length > 16_384
) {
  process.stderr.write(
    `${JSON.stringify({ error: "invalid_cli_environment" })}\n`,
  );
  process.exitCode = 2;
} else {
  const cli = createOperatorCli({
    io: Object.freeze({
      stderr: (value: string) => process.stderr.write(value),
      stdout: (value: string) => process.stdout.write(value),
    }),
    tenantId,
    transport: createFetchSdkTransport({
      baseUrl,
      bearerToken: () => bearerToken,
    }),
  });
  process.exitCode = await runOperatorCli(cli, process.argv.slice(2));
}
