export const PRODUCTION_GATE_SCHEMA =
  "workload-funnel.production-readiness-gate.v1";
export const DISPOSABLE_HOST_ATTESTATION =
  "I_ATTEST_THIS_IS_A_DISPOSABLE_HOST_WITH_NO_USER_PROJECTS";
export const HYPERQUEUE_VERSION = "0.26.2";
export const HYPERQUEUE_X64_ARCHIVE_SHA256 =
  "e15dae9113e1a307a97a66bfe90f74f78c6016239436b5d9f1e4efec480e84b5";
export const GATE_SANDBOX_PARENT = "/var/data/workload-funnel/sandboxes";
export const REVIEW_MANIFEST_SCHEMA =
  "workload-funnel.production-gate.review-manifest.v1";
export const ARCHITECTURE_PLAN_SHA256 =
  "73dffc99721b929e1e2b109d62f38263f433adb9534bb5fa545978a8c851ccdf";
export const POSTGRES_FIXTURE_IMAGE =
  "postgres:18.4-alpine@sha256:9a8afca54e7861fd90fab5fdf4c42477a6b1cb7d293595148e674e0a3181de15";
export const OBJECT_FIXTURE_IMAGE =
  "quay.io/minio/minio:RELEASE.2025-09-07T16-13-09Z@sha256:a1a8bd4ac40ad7881a245bab97323e18f971e4d4cba2c2007ec1bedd21cbaba2";
export const AZURITE_FIXTURE_IMAGE =
  "mcr.microsoft.com/azure-storage/azurite:3.35.0@sha256:647c63a91102a9d8e8000aab803436e1fc85fbb285e7ce830a82ee5d6661cf37";
export const OWNED_NAME_PATTERN = /^wf-production-gate-[a-f0-9]{32}$/u;
export const OWNED_RESOURCE_PATTERN =
  /^wf-production-gate-[a-f0-9]{32}(?:-[a-z0-9-]{1,40})?$/u;

export const DECLARED_COMPONENTS = Object.freeze([
  "attestation",
  "preflight",
  "postgres_fixture",
  "postgres_production_adapter",
  "object_compatibility_fixture",
  "object_production_provider",
  "hyperqueue_0_26_2",
  "systemd_cgroup_v2",
  "pressure_admission_slo",
  "cleanup",
]);

export const HOST_COMMAND_LIMITS = Object.freeze({
  maxOutputBytes: 2 * 1024 * 1024,
  timeoutMs: 30_000,
});

export const MINIMAL_COMMAND_ENVIRONMENT = Object.freeze({
  HOME: "/nonexistent",
  LANG: "C.UTF-8",
  LC_ALL: "C.UTF-8",
  PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
  TZ: "UTC",
});
