import { createCapacityObservationClient } from "@workload-funnel/client-sdk/capacity-observation";
import { createEventSubscriptionClient } from "@workload-funnel/client-sdk/event-subscription";
import { createResultAccessClient } from "@workload-funnel/client-sdk/result-access";
import type { ErasureDataClass } from "@workload-funnel/client-sdk/result-access";
import { createWorkloadCancellationClient } from "@workload-funnel/client-sdk/workload-cancellation";
import { createWorkloadObservationClient } from "@workload-funnel/client-sdk/workload-observation";
import {
  createWorkloadSubmissionClient,
  type SdkHttpTransport,
} from "@workload-funnel/client-sdk/workload-submission";

export interface OperatorCliIo {
  stdout(value: string): void;
  stderr(value: string): void;
}

export interface OperatorCli {
  run(argv: readonly string[]): Promise<number>;
}

export function runOperatorCli(
  cli: OperatorCli,
  argv: readonly string[],
): Promise<number> {
  return cli.run(argv);
}

function parseJson(value: string): unknown {
  if (value.length > 262_144) throw new Error("argument_too_large");
  try {
    return JSON.parse(value);
  } catch {
    throw new Error("invalid_json_argument");
  }
}

function required(
  argv: readonly string[],
  index: number,
  name: string,
): string {
  const value = argv[index];
  if (value === undefined || value.length === 0)
    throw new Error(`missing_${name}`);
  return value;
}

function options(idempotencyKey: string): Readonly<{
  idempotencyKey: string;
  correlationId: string;
}> {
  return Object.freeze({
    correlationId: `operator-${crypto.randomUUID()}`,
    idempotencyKey,
  });
}

export function createOperatorCli(
  input: Readonly<{
    transport: SdkHttpTransport;
    tenantId: string;
    io: OperatorCliIo;
    maximumOutputBytes?: number;
  }>,
): OperatorCli {
  const submission = createWorkloadSubmissionClient(
    input.transport,
    input.tenantId,
  );
  const observation = createWorkloadObservationClient(
    input.transport,
    input.tenantId,
  );
  const cancellation = createWorkloadCancellationClient(
    input.transport,
    input.tenantId,
  );
  const events = createEventSubscriptionClient<unknown>(
    input.transport,
    input.tenantId,
  );
  const capacity = createCapacityObservationClient(
    input.transport,
    input.tenantId,
  );
  const results = createResultAccessClient(input.transport, input.tenantId);
  const maximumOutputBytes = input.maximumOutputBytes ?? 1_048_576;

  function write(value: unknown): void {
    const serialized = `${JSON.stringify(value)}\n`;
    if (Buffer.byteLength(serialized, "utf8") > maximumOutputBytes)
      throw new Error("output_limit_exceeded");
    input.io.stdout(serialized);
  }

  const cli: OperatorCli = {
    async run(argv) {
      try {
        if (
          argv.length < 1 ||
          argv.length > 12 ||
          argv.some((item) => item.length > 262_144)
        )
          throw new Error("invalid_arguments");
        const command = argv[0];
        switch (command) {
          case "submit": {
            const spec = parseJson(required(argv, 1, "workload_spec"));
            const idempotencyKey = required(argv, 2, "idempotency_key");
            write(
              await submission.submit(
                spec as Parameters<typeof submission.submit>[0],
                options(idempotencyKey),
              ),
            );
            return 0;
          }
          case "observe":
            write(await observation.workload(required(argv, 1, "run_id")));
            return 0;
          case "operation":
            write(
              await observation.operation(required(argv, 1, "operation_id")),
            );
            return 0;
          case "explain":
            write(await observation.explanation(required(argv, 1, "run_id")));
            return 0;
          case "cancel":
            write(
              await cancellation.cancel(
                required(argv, 1, "run_id"),
                required(argv, 2, "reason"),
                options(required(argv, 3, "idempotency_key")),
              ),
            );
            return 0;
          case "capacity":
            write(await capacity.observe());
            return 0;
          case "result":
            write(
              await results.result(required(argv, 1, "result_manifest_id")),
            );
            return 0;
          case "retention":
            if (!["archive", "delete"].includes(required(argv, 2, "action")))
              throw new Error("invalid_retention_action");
            write(
              await results.requestRetention(
                required(argv, 1, "result_manifest_id"),
                required(argv, 2, "action") as "archive" | "delete",
                required(argv, 3, "reason"),
                options(required(argv, 4, "idempotency_key")),
              ),
            );
            return 0;
          case "erasure":
            write(
              await results.requestErasure(
                required(argv, 1, "subject_reference"),
                required(argv, 2, "data_classes").split(
                  ",",
                ) as ErasureDataClass[],
                required(argv, 3, "reason"),
                options(required(argv, 4, "idempotency_key")),
              ),
            );
            return 0;
          case "events-snapshot":
            write(await events.snapshot());
            return 0;
          case "events-next":
            write(
              await events.events(
                required(argv, 1, "cursor"),
                Number(required(argv, 2, "snapshot_watermark")),
              ),
            );
            return 0;
          case "audit":
            write(
              await input.transport.request({
                method: "GET",
                path: "/v1/audit",
                query: Object.freeze({ tenant: input.tenantId }),
              }),
            );
            return 0;
          default:
            throw new Error("unknown_command");
        }
      } catch (error) {
        const code =
          error instanceof Error && /^[a-z0-9_]+$/u.test(error.message)
            ? error.message
            : "operation_failed";
        input.io.stderr(`${JSON.stringify({ error: code })}\n`);
        return code === "unknown_command" || code.startsWith("missing_")
          ? 2
          : 1;
      }
    },
  };
  return Object.freeze(cli);
}
