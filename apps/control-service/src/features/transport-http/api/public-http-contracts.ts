import type {
  AuthorizationService,
  AuthorizedRequestContext,
} from "@workload-funnel/control-service/authorization";
import type {
  TransportAuthenticator,
  TransportCredential,
} from "@workload-funnel/control-service/authentication";
import type { CapacityController } from "@workload-funnel/control-service/node-controller";
import type { ReconciliationController } from "@workload-funnel/control-service/reconciliation-controller";
import type { ResultOperationsController } from "@workload-funnel/control-service/result-controller";
import type {
  PublicMutationContext,
  PublicWorkloadController,
} from "@workload-funnel/control-service/workload-controller";

import type { SignedCursorCodec } from "./signed-cursor.js";

export interface PublicHttpRequest {
  readonly method: "GET" | "POST";
  readonly path: string;
  readonly query?: Readonly<Record<string, string | undefined>>;
  readonly credential?: TransportCredential;
  readonly body?: unknown;
}

export interface PublicHttpResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: unknown;
}

export interface PublicEventTransportPort {
  snapshot(
    context: AuthorizedRequestContext,
    partition: string,
    now: number,
  ): Readonly<{
    contractVersion: "workload-funnel.snapshot/v1";
    partition: string;
    snapshotWatermark: number;
    generatedAt: number;
    items: readonly unknown[];
  }>;
  page(
    context: AuthorizedRequestContext,
    input: Readonly<{
      partition: string;
      streamClass?: "observation" | "cancellation" | "general";
      after: Readonly<{ streamPosition: number; eventId: string }>;
      snapshotWatermark: number;
      limit: number;
    }>,
  ): Readonly<{
    events: readonly unknown[];
    after: Readonly<{ streamPosition: number; eventId: string }>;
    hasMore: boolean;
    headPosition: number;
  }>;
  registerConsumer(
    context: AuthorizedRequestContext,
    mutation: PublicMutationContext,
    input: Readonly<Record<string, unknown>>,
    after: Readonly<{ streamPosition: number; eventId: string }>,
    now: number,
  ): unknown;
  consume(
    context: AuthorizedRequestContext,
    consumerId: string,
    now: number,
  ): unknown;
  acknowledge(
    context: AuthorizedRequestContext,
    mutation: PublicMutationContext,
    consumerId: string,
    through: Readonly<{ streamPosition: number; eventId: string }>,
    now: number,
  ): unknown;
}

export interface HealthStatusV1 {
  readonly contractVersion: "workload-funnel.health/v1";
  readonly liveness: "live" | "failed";
  readonly readiness: "ready" | "not_ready";
  readonly serviceMode: "full" | "degraded_observe_cancel_only" | "unavailable";
  readonly reasons: readonly string[];
  readonly nodeSchedulability: Readonly<
    Record<string, "schedulable" | "cordoned" | "draining" | "unknown">
  >;
}

export interface ServiceOperationsPort {
  health(): HealthStatusV1;
  metrics(context: AuthorizedRequestContext): unknown;
  recordHttp(
    input: Readonly<{
      method: string;
      route: string;
      status: number;
      durationMs: number;
      principalId?: string;
      effectiveTenantId?: string;
      correlationId?: string;
    }>,
  ): void;
}

export interface PublicHttpApi {
  handle(request: PublicHttpRequest): PublicHttpResponse;
}

export interface PublicHttpApiDependencies {
  readonly authenticator: TransportAuthenticator;
  readonly authorization: AuthorizationService;
  readonly workloads: PublicWorkloadController;
  readonly capacity: CapacityController;
  readonly results: ResultOperationsController;
  readonly reconciliation: ReconciliationController;
  readonly events: PublicEventTransportPort;
  readonly serviceOperations: ServiceOperationsPort;
  readonly cursorCodec: SignedCursorCodec;
  readonly clock: () => number;
}
