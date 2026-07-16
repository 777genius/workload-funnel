import { describe, expect, it } from "vitest";

import { validatePostgresLifecycleConfig } from "../postgres-config.js";
import { PostgresLifecycleError } from "../postgres-errors.js";

function common() {
  return {
    applicationName: "workload-funnel-config-test",
    connectionTimeoutMs: 500,
    database: "wf_adapter_test",
    host: "postgres.internal.test",
    idleTimeoutMs: 1_000,
    lockTimeoutMs: 500,
    maxConnections: 4,
    password: String(0).repeat(32),
    port: 5432,
    queryTimeoutMs: 2_000,
    schema: "wf_adapter_schema",
    schemaOwner: "wf_adapter",
    shutdownTimeoutMs: 1_000,
    statementTimeoutMs: 1_000,
    user: "wf_adapter",
  } as const;
}

describe("pg lifecycle profile validation", () => {
  it("accepts an explicitly disposable database without TLS", () => {
    expect(
      validatePostgresLifecycleConfig({
        ...common(),
        profile: "disposable-test",
        tls: false,
      }),
    ).toMatchObject({ profile: "disposable-test", tls: false });
  });

  it("requires verified TLS with an exact server name in production", () => {
    expect(
      validatePostgresLifecycleConfig({
        ...common(),
        profile: "production",
        tls: {
          certificateAuthority:
            "-----BEGIN CERTIFICATE-----\nsynthetic-ca\n-----END CERTIFICATE-----",
          serverName: "postgres.internal.test",
        },
      }),
    ).toMatchObject({ profile: "production" });
    expect(() =>
      validatePostgresLifecycleConfig({
        ...common(),
        profile: "production",
        tls: {
          certificateAuthority:
            "-----BEGIN CERTIFICATE-----\nsynthetic-ca\n-----END CERTIFICATE-----",
          serverName: "different.internal.test",
        },
      }),
    ).toThrow("postgres_production_tls_invalid");
    expect(() =>
      validatePostgresLifecycleConfig({
        ...common(),
        profile: "production",
        tls: false,
      }),
    ).toThrow("postgres_production_tls_invalid");
  });

  it("rejects unbounded pools and inverted timeouts", () => {
    expect(() =>
      validatePostgresLifecycleConfig({
        ...common(),
        maxConnections: 33,
        profile: "disposable-test",
        tls: false,
      }),
    ).toThrow("postgres_lifecycle_profile_invalid");
    expect(() =>
      validatePostgresLifecycleConfig({
        ...common(),
        lockTimeoutMs: 1_500,
        profile: "disposable-test",
        tls: false,
      }),
    ).toThrow("postgres_lifecycle_profile_invalid");
  });

  it("rejects undeclared profile fields and non-disposable identities", () => {
    expect(() =>
      validatePostgresLifecycleConfig({
        ...common(),
        profile: "disposable-test",
        tls: false,
        unsafeCompatibilityMode: true,
      }),
    ).toThrow("postgres_lifecycle_profile_invalid");
    expect(() =>
      validatePostgresLifecycleConfig({
        ...common(),
        database: "production_database",
        profile: "disposable-test",
        tls: false,
      }),
    ).toThrow("postgres_disposable_profile_invalid");
    expect(() =>
      validatePostgresLifecycleConfig({
        ...common(),
        profile: "disposable-test",
        schemaOwner: "different_owner",
        tls: false,
      }),
    ).toThrow("postgres_lifecycle_profile_invalid");
  });

  it("redacts credentials from typed error surfaces", () => {
    const secret = ["credential", "must", "never", "render"].join("-");
    let error: unknown;
    try {
      validatePostgresLifecycleConfig({
        ...common(),
        password: `${secret}\0`,
        profile: "disposable-test",
        tls: false,
      });
    } catch (failure) {
      error = failure;
    }
    const adapterError = new PostgresLifecycleError(
      "postgres_lifecycle_unavailable",
    );
    const rendered = [
      String(error),
      JSON.stringify(error),
      String(adapterError),
      JSON.stringify(adapterError),
      adapterError.stack ?? "",
    ].join("\n");
    expect(rendered).not.toContain(secret);
  });
});
