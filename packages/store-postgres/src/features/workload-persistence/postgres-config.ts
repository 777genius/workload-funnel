const identifier = /^[a-z][a-z0-9_]{0,62}$/u;
const hostName = /^[A-Za-z0-9][A-Za-z0-9.:-]{0,252}$/u;
const applicationName = /^workload-funnel-[a-z0-9-]{1,48}$/u;
const configKeys = Object.freeze(
  [
    "applicationName",
    "connectionTimeoutMs",
    "database",
    "host",
    "idleTimeoutMs",
    "lockTimeoutMs",
    "maxConnections",
    "password",
    "port",
    "profile",
    "queryTimeoutMs",
    "schema",
    "schemaOwner",
    "shutdownTimeoutMs",
    "statementTimeoutMs",
    "tls",
    "user",
  ].sort(),
);

interface PostgresLifecycleCommonConfig {
  readonly applicationName: string;
  readonly connectionTimeoutMs: number;
  readonly database: string;
  readonly host: string;
  readonly idleTimeoutMs: number;
  readonly lockTimeoutMs: number;
  readonly maxConnections: number;
  readonly password: string;
  readonly port: number;
  readonly queryTimeoutMs: number;
  readonly schema: string;
  readonly schemaOwner: string;
  readonly shutdownTimeoutMs: number;
  readonly statementTimeoutMs: number;
  readonly user: string;
}

export interface PostgresLifecycleProductionConfig extends PostgresLifecycleCommonConfig {
  readonly profile: "production";
  readonly tls: Readonly<{
    readonly certificateAuthority: string;
    readonly serverName: string;
  }>;
}

export interface PostgresLifecycleDisposableConfig extends PostgresLifecycleCommonConfig {
  readonly profile: "disposable-test";
  readonly tls: false;
}

export type PostgresLifecycleDatabaseConfig =
  | PostgresLifecycleDisposableConfig
  | PostgresLifecycleProductionConfig;

export class PostgresLifecycleConfigurationError extends Error {
  public constructor(public readonly code: string) {
    super(code);
    this.name = "PostgresLifecycleConfigurationError";
  }
}

function validInteger(
  value: unknown,
  minimum: number,
  maximum: number,
): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= minimum &&
    value <= maximum
  );
}

export function validatePostgresLifecycleConfig(
  value: unknown,
): PostgresLifecycleDatabaseConfig {
  if (typeof value !== "object" || value === null) {
    throw new PostgresLifecycleConfigurationError(
      "postgres_lifecycle_profile_invalid",
    );
  }
  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).sort().join() !== configKeys.join() ||
    (record["profile"] !== "production" &&
      record["profile"] !== "disposable-test")
  ) {
    throw new PostgresLifecycleConfigurationError(
      "postgres_lifecycle_profile_invalid",
    );
  }
  const profile = record["profile"];
  const password = record["password"];
  if (
    typeof record["database"] !== "string" ||
    !identifier.test(record["database"]) ||
    typeof record["host"] !== "string" ||
    !hostName.test(record["host"]) ||
    typeof record["user"] !== "string" ||
    !identifier.test(record["user"]) ||
    typeof record["schema"] !== "string" ||
    !identifier.test(record["schema"]) ||
    typeof record["schemaOwner"] !== "string" ||
    !identifier.test(record["schemaOwner"]) ||
    record["schemaOwner"] !== record["user"] ||
    typeof record["applicationName"] !== "string" ||
    !applicationName.test(record["applicationName"]) ||
    typeof password !== "string" ||
    password.length === 0 ||
    password.length > 8192 ||
    password.includes("\0") ||
    !validInteger(record["port"], 1, 65_535) ||
    !validInteger(record["maxConnections"], 1, 32) ||
    !validInteger(record["connectionTimeoutMs"], 50, 60_000) ||
    !validInteger(record["idleTimeoutMs"], 50, 300_000) ||
    !validInteger(record["lockTimeoutMs"], 50, 60_000) ||
    !validInteger(record["queryTimeoutMs"], 50, 300_000) ||
    !validInteger(record["shutdownTimeoutMs"], 50, 60_000) ||
    !validInteger(record["statementTimeoutMs"], 50, 300_000)
  ) {
    throw new PostgresLifecycleConfigurationError(
      "postgres_lifecycle_profile_invalid",
    );
  }
  const config = Object.freeze({
    applicationName: record["applicationName"],
    connectionTimeoutMs: record["connectionTimeoutMs"],
    database: record["database"],
    host: record["host"],
    idleTimeoutMs: record["idleTimeoutMs"],
    lockTimeoutMs: record["lockTimeoutMs"],
    maxConnections: record["maxConnections"],
    password,
    port: record["port"],
    queryTimeoutMs: record["queryTimeoutMs"],
    schema: record["schema"],
    schemaOwner: record["schemaOwner"],
    shutdownTimeoutMs: record["shutdownTimeoutMs"],
    statementTimeoutMs: record["statementTimeoutMs"],
    user: record["user"],
  });
  if (
    config.lockTimeoutMs > config.statementTimeoutMs ||
    config.statementTimeoutMs > config.queryTimeoutMs
  ) {
    throw new PostgresLifecycleConfigurationError(
      "postgres_lifecycle_profile_invalid",
    );
  }
  if (profile === "disposable-test") {
    if (
      record["tls"] !== false ||
      !config.database.startsWith("wf_") ||
      !config.schema.startsWith("wf_")
    ) {
      throw new PostgresLifecycleConfigurationError(
        "postgres_disposable_profile_invalid",
      );
    }
    return Object.freeze({ ...config, profile, tls: false });
  }
  const tls = record["tls"];
  if (
    typeof tls !== "object" ||
    tls === null ||
    Object.keys(tls).sort().join() !== "certificateAuthority,serverName" ||
    !("certificateAuthority" in tls) ||
    typeof tls.certificateAuthority !== "string" ||
    tls.certificateAuthority.length < 32 ||
    tls.certificateAuthority.length > 1_048_576 ||
    tls.certificateAuthority.includes("\0") ||
    !("serverName" in tls) ||
    typeof tls.serverName !== "string" ||
    !hostName.test(tls.serverName) ||
    tls.serverName !== config.host
  ) {
    throw new PostgresLifecycleConfigurationError(
      "postgres_production_tls_invalid",
    );
  }
  return Object.freeze({
    ...config,
    profile: "production",
    tls: Object.freeze({
      certificateAuthority: tls.certificateAuthority,
      serverName: tls.serverName,
    }),
  });
}
